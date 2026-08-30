import asyncio
import concurrent.futures
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).parents[1]
RUNTIME = tempfile.TemporaryDirectory()
os.environ["MUSIC_GPU_CHECKPOINT_ROOT"] = RUNTIME.name
os.environ["MUSIC_GPU_JOB_DB"] = str(Path(RUNTIME.name) / "jobs.sqlite3")
spec = importlib.util.spec_from_file_location("music_ai_gpu_worker", ROOT / "app.py")
worker = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(worker)


class GpuWorkerContractTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        RUNTIME.cleanup()

    def setUp(self):
        connection = worker._db()
        connection.execute("DELETE FROM jobs")
        connection.close()
        worker.TASKS.clear()
        worker.PROCESSES.clear()
        worker.SMOKE_ATTESTATIONS.clear()

    def test_missing_gpu_and_checkpoint_never_report_ready(self):
        with mock.patch.object(worker, "ENABLED", {"ACE_STEP"}), mock.patch.object(
            worker, "_gpu_runtime", return_value=(False, "CUDA GPU is not available")
        ):
            result = worker._provider_health("ACE_STEP")
        self.assertNotEqual(result["status"], "ready")
        self.assertFalse(result["checkpointReady"])
        self.assertFalse(result["smokeTested"])
        self.assertIn("CUDA GPU is not available", result["message"])

    def test_provider_qualified_health_returns_the_direct_contract(self):
        os.environ["MUSIC_AI_WORKER_TOKEN"] = "health-test-token"

        async def request_health():
            sent = []
            requests = iter([
                {"type": "http.request", "body": b"", "more_body": False},
                {"type": "http.disconnect"},
            ])

            async def receive():
                return next(requests)

            async def send(message):
                sent.append(message)

            await worker.app(
                {
                    "type": "http",
                    "asgi": {"version": "3.0"},
                    "http_version": "1.1",
                    "method": "GET",
                    "scheme": "http",
                    "path": "/health",
                    "raw_path": b"/health",
                    "query_string": b"provider=ACE_STEP",
                    "headers": [
                        (b"authorization", b"Bearer health-test-token"),
                    ],
                    "client": ("127.0.0.1", 1),
                    "server": ("worker", 80),
                    "root_path": "",
                },
                receive,
                send,
            )
            return sent

        try:
            sent = asyncio.run(request_health())
            start = next(item for item in sent if item["type"] == "http.response.start")
            body = b"".join(
                item.get("body", b"")
                for item in sent
                if item["type"] == "http.response.body"
            )
            payload = worker.json.loads(body)
            self.assertEqual(start["status"], 200)
            self.assertEqual(payload["provider"], "ACE_STEP")
            self.assertIn("checkpointSha256", payload)
        finally:
            del os.environ["MUSIC_AI_WORKER_TOKEN"]

    def test_idempotency_key_reuses_only_the_same_request(self):
        request = worker.JobRequest(provider="MT3")
        first = worker._queue(request, "analysis-1:MT3")
        second = worker._queue(request, "analysis-1:MT3")
        self.assertEqual(first["id"], second["id"])
        with self.assertRaises(worker.HTTPException) as conflict:
            worker._queue(worker.JobRequest(provider="ACE_STEP"), "analysis-1:MT3")
        self.assertEqual(conflict.exception.status_code, 409)

    def test_concurrent_submissions_return_one_job(self):
        def submit():
            return worker._queue(
                worker.JobRequest(provider="MT3"), "concurrent-key"
            )["id"]

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            ids = list(pool.map(lambda _: submit(), range(2)))
        self.assertEqual(len(set(ids)), 1)

    def test_queued_job_cancellation_is_terminal(self):
        job = worker._queue(worker.JobRequest(provider="MT3"), "cancel-queued")
        cancelled = worker.cancel(job["id"])
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(cancelled["progress"], 100)

    def test_restart_requeues_running_but_not_cancel_requested_jobs(self):
        first = worker._queue(worker.JobRequest(provider="MT3"), "recover-running")
        second = worker._queue(worker.JobRequest(provider="MT3"), "recover-cancel")
        connection = worker._db()
        connection.execute("UPDATE jobs SET status='running' WHERE id=?", (first["id"],))
        connection.execute(
            "UPDATE jobs SET status='cancel_requested' WHERE id=?", (second["id"],)
        )
        connection.close()

        async def exercise():
            async def hold(_):
                await asyncio.Event().wait()

            with mock.patch.object(worker, "_execute", side_effect=hold):
                async with worker.lifespan(worker.app):
                    connection = worker._db()
                    running = connection.execute(
                        "SELECT status FROM jobs WHERE id=?", (first["id"],)
                    ).fetchone()["status"]
                    cancelled = connection.execute(
                        "SELECT status FROM jobs WHERE id=?", (second["id"],)
                    ).fetchone()["status"]
                    connection.close()
                    self.assertEqual(running, "queued")
                    self.assertEqual(cancelled, "cancelled")

        asyncio.run(exercise())

    def test_only_one_contender_claims_a_queued_job(self):
        job = worker._queue(worker.JobRequest(provider="MT3"), "single-claim")
        unavailable = worker.HTTPException(503, "not ready")

        async def contend():
            await asyncio.gather(
                worker._execute(job["id"]),
                worker._execute(job["id"]),
            )

        with mock.patch.object(
            worker, "_validate_provider", side_effect=unavailable
        ) as validate:
            asyncio.run(contend())
        self.assertEqual(validate.call_count, 1)

    def test_cancellation_after_claim_stops_before_runner_launch(self):
        job = worker._queue(worker.JobRequest(provider="MT3"), "cancel-race")

        def cancel_during_attestation(_):
            connection = worker._db()
            connection.execute(
                "UPDATE jobs SET status='cancel_requested' WHERE id=?", (job["id"],)
            )
            connection.close()
            return {
                "modelVersion": "mt3-ismir2021",
                "checkpointSha256": "a" * 64,
            }

        with mock.patch.object(
            worker, "_validate_provider", side_effect=cancel_during_attestation
        ), mock.patch.object(worker.asyncio, "create_subprocess_exec") as launch:
            asyncio.run(worker._execute(job["id"]))
        launch.assert_not_called()
        self.assertEqual(worker.job_status(job["id"])["status"], "cancelled")