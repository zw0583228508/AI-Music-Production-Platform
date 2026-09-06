import asyncio
import concurrent.futures
import hashlib
import hmac
import importlib.util
import json
import os
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).parents[1]
RUNTIME = tempfile.TemporaryDirectory()
os.environ["MUSIC_GPU_CHECKPOINT_ROOT"] = RUNTIME.name
os.environ["MUSIC_GPU_JOB_DB"] = str(Path(RUNTIME.name) / "jobs.sqlite3")
os.environ["MUSIC_GPU_JOB_OUTPUT_ROOT"] = str(Path(RUNTIME.name) / "outputs")
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

    def _artifact(self, name: str, job_id: str = "job-1"):
        secret = "artifact-test-secret"
        os.environ["MUSIC_GPU_ARTIFACT_CAPABILITY_SECRET"] = secret
        directory = worker.OUTPUT_ROOT / "bs_roformer" / job_id
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / name
        content = b"bounded-audio-test-content-" + name.encode()
        path.write_bytes(content)
        digest = hashlib.sha256(content).hexdigest()
        metadata = {
            "name": name,
            "bytes": len(content),
            "sha256": digest,
            "contentType": "audio/flac",
        }
        result_path = directory / "result.json"
        existing = json.loads(result_path.read_text()) if result_path.exists() else {"stems": []}
        existing["stems"].append(metadata)
        result_path.write_text(json.dumps(existing))
        expires = int(time.time()) + 600
        capability = hmac.new(
            secret.encode(),
            f"BS_ROFORMER/{job_id}/{name}/{digest}/{expires}".encode(),
            hashlib.sha256,
        ).hexdigest()
        return path, expires, capability

    def test_missing_gpu_and_checkpoint_never_report_ready(self):
        with mock.patch.object(worker, "ENABLED", {"ACE_STEP"}), mock.patch.object(
            worker, "_gpu_runtime", return_value=(False, "CUDA GPU is not available")
        ):
            result = worker._provider_health("ACE_STEP")
        self.assertNotEqual(result["status"], "ready")
        self.assertFalse(result["checkpointReady"])
        self.assertFalse(result["smokeTested"])
        self.assertIn("CUDA GPU is not available", result["message"])
        self.assertEqual(result["status"], "not_ready")
        self.assertFalse(result["retryable"])

    def test_cuda_initialization_has_exact_retryable_startup_contract(self):
        checkpoint = worker.CHECKPOINT_ROOT / "startup-ace-step.ckpt"
        checkpoint.write_bytes(b"checkpoint")
        checkpoint_hash = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
        details = {
            **worker.PROVIDERS["ACE_STEP"],
            "checkpoint_path": checkpoint.name,
            "checkpoint_sha256": checkpoint_hash,
            "config_path": "",
            "config_sha256": "",
        }
        with mock.patch.dict(
            worker.PROVIDERS, {"ACE_STEP": details}
        ), mock.patch.object(
            worker, "ENABLED", {"ACE_STEP"}
        ), mock.patch.object(
            worker, "_gpu_runtime", side_effect=worker.RuntimeInitializing()
        ), mock.patch.dict(
            os.environ,
            {
                details["runner_env"]: "python -m runners.ace_step",
                "MUSIC_PROVIDER_ACE_STEP_CHECKPOINT_SHA256": checkpoint_hash,
                "MUSIC_GPU_CONTAINER_DIGEST": "sha256:" + "a" * 64,
                "MODAL_IMAGE_ID": "im-TestImage123",
                "MUSIC_GPU_MODAL_APP_ID": "ap-Test",
                "MUSIC_GPU_MODAL_DEPLOYMENT_ID": "v1",
                "MUSIC_GPU_MODAL_FUNCTION_ID": "fu-Test",
                "MUSIC_GPU_SOURCE_REVISION": "b" * 40,
            },
        ):
            result = worker._provider_health("ACE_STEP", run_smoke=False)
        self.assertEqual(result["status"], "starting")
        self.assertFalse(result["ready"])
        self.assertFalse(result["healthy"])
        self.assertTrue(result["retryable"])
        self.assertEqual(result["retryAfterSeconds"], 5)

    def test_identity_gap_remains_non_retryable_during_cuda_initialization(self):
        with mock.patch.object(worker, "ENABLED", {"ALL_IN_ONE"}), mock.patch.object(
            worker, "_gpu_runtime", side_effect=worker.RuntimeInitializing()
        ):
            result = worker._provider_health("ALL_IN_ONE", run_smoke=False)
        self.assertEqual(result["status"], "not_ready")
        self.assertFalse(result["retryable"])

    def test_unexpected_runtime_probe_failure_is_sanitized_and_not_retryable(self):
        with mock.patch.object(worker, "ENABLED", {"MT3"}), mock.patch.object(
            worker, "_gpu_runtime", side_effect=RuntimeError("private runtime detail")
        ):
            result = worker._provider_health("MT3")
        self.assertEqual(result["status"], "not_ready")
        self.assertFalse(result["retryable"])
        self.assertNotIn("private runtime detail", result["message"])

    def test_yourmt3_health_rejects_incomplete_terminated_note_evidence(self):
        checkpoint = worker.CHECKPOINT_ROOT / "test-your-mt3.ckpt"
        checkpoint.write_bytes(b"your-mt3-checkpoint")
        checkpoint_hash = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
        details = {
            **worker.PROVIDERS["YOUR_MT3"],
            "checkpoint_path": checkpoint.name,
            "checkpoint_sha256": checkpoint_hash,
        }
        container_digest = "sha256:" + "a" * 64
        modal_image_id = "im-TestImage123"
        fake_torch = types.SimpleNamespace(
            __version__="2.5.1+cu124",
            version=types.SimpleNamespace(cuda="12.4"),
            cuda=types.SimpleNamespace(
                is_available=lambda: True,
                get_device_name=lambda _index: "NVIDIA L4",
            ),
        )
        base_event = {
            "start": 0.0,
            "end": 0.5,
            "pitch": 60,
            "velocity": 96,
            "confidence": 96 / 127,
        }
        valid_hash = hashlib.sha256(json.dumps(
            [base_event], sort_keys=True, separators=(",", ":"), allow_nan=False,
        ).encode()).hexdigest()
        invalid_outputs = {
            "zero notes": {
                "notes": 0,
                "terminatedNotes": 0,
                "allNotesTerminated": True,
                "noteEvents": [],
                "noteEventsSha256": hashlib.sha256(b"[]").hexdigest(),
            },
            "unterminated notes": {
                "notes": 1,
                "terminatedNotes": 0,
                "allNotesTerminated": False,
                "noteEvents": [base_event],
                "noteEventsSha256": valid_hash,
            },
            "event hash drift": {
                "notes": 1,
                "terminatedNotes": 1,
                "allNotesTerminated": True,
                "noteEvents": [base_event],
                "noteEventsSha256": "0" * 64,
            },
        }
        for label, output in invalid_outputs.items():
            with self.subTest(label=label):
                proof = {
                    "provider": "YOUR_MT3",
                    "modelVersion": details["model_version"],
                    "checkpointSha256": checkpoint_hash,
                    "smokeTested": True,
                    "output": output,
                    "provenance": {
                        "modelVersion": details["model_version"],
                        "checkpointSha256": checkpoint_hash,
                        "revision": details["revision"],
                        "sourceImageDigest": container_digest,
                        "modalImageId": modal_image_id,
                        "cudaVersion": "12.4",
                        "pytorchVersion": "2.5.1+cu124",
                        "gpu": "NVIDIA L4",
                    },
                }
                worker.SMOKE_ATTESTATIONS.clear()
                worker.SMOKE_EVIDENCE.clear()
                with mock.patch.dict(
                    worker.PROVIDERS, {"YOUR_MT3": details}
                ), mock.patch.object(
                    worker, "ENABLED", {"YOUR_MT3"}
                ), mock.patch.object(
                    worker, "_gpu_runtime", return_value=(True, "ready")
                ), mock.patch.object(
                    worker, "_run_command",
                    return_value=(0, json.dumps(proof), ""),
                ), mock.patch.dict(
                    sys.modules, {"torch": fake_torch}
                ), mock.patch.dict(
                    os.environ,
                    {
                        details["runner_env"]: "python -m runners.your_mt3",
                        "MUSIC_PROVIDER_YOUR_MT3_CHECKPOINT_SHA256": checkpoint_hash,
                        "MUSIC_GPU_CONTAINER_DIGEST": container_digest,
                        "MODAL_IMAGE_ID": modal_image_id,
                        "MUSIC_GPU_MODAL_APP_ID": "ap-Test",
                        "MUSIC_GPU_MODAL_DEPLOYMENT_ID": "v3",
                        "MUSIC_GPU_MODAL_FUNCTION_ID": "fu-Test",
                        "MUSIC_GPU_SOURCE_REVISION": "b" * 40,
                    },
                    clear=False,
                ):
                    result = worker._provider_health(
                        "YOUR_MT3", run_smoke=True, force_smoke=True,
                    )
                self.assertFalse(result["ready"])
                self.assertFalse(result["smokeTested"])
                self.assertIsNone(result["smokeEvidence"])
                self.assertNotIn("YOUR_MT3", worker.SMOKE_ATTESTATIONS)

    def test_only_recognized_cuda_initialization_errors_are_retryable(self):
        with self.assertRaises(worker.RuntimeInitializing):
            worker._cuda_probe_failure(
                RuntimeError("CUDA error: initialization error")
            )
        ready, message = worker._cuda_probe_failure(
            RuntimeError("CUDA out of memory at /private/model/path")
        )
        self.assertFalse(ready)
        self.assertEqual(message, "CUDA readiness probe failed")
        self.assertNotIn("private", message)
        for error in (
            "provider failed after CUDA error: initialization error",
            "CUDA error: initialization error while loading an unverified kernel",
        ):
            with self.subTest(error=error):
                ready, message = worker._cuda_probe_failure(RuntimeError(error))
                self.assertFalse(ready)
                self.assertEqual(message, "CUDA readiness probe failed")

    def test_bs_roformer_config_change_invalidates_checkpoint_and_smoke(self):
        checkpoint = worker.CHECKPOINT_ROOT / "test-bs-roformer.ckpt"
        config = worker.CHECKPOINT_ROOT / "test-bs-roformer.yaml"
        checkpoint.write_bytes(b"checkpoint")
        config.write_bytes(b"config-v1")
        checkpoint_hash = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
        config_hash = hashlib.sha256(config.read_bytes()).hexdigest()
        details = {
            **worker.PROVIDERS["BS_ROFORMER"],
            "checkpoint_path": checkpoint.name,
            "checkpoint_sha256": checkpoint_hash,
            "config_path": config.name,
            "config_sha256": config_hash,
            "routing_status": "READY",
            "license_status": "VERIFIED",
            "commercial_use_permitted": True,
        }
        smoke_identity = f"{checkpoint_hash}:{config_hash}"
        worker.SMOKE_ATTESTATIONS["BS_ROFORMER"] = smoke_identity
        with mock.patch.dict(
            worker.PROVIDERS, {"BS_ROFORMER": details}
        ), mock.patch.object(
            worker, "ENABLED", {"BS_ROFORMER"}
        ), mock.patch.object(
            worker, "_gpu_runtime", return_value=(True, "ready")
        ):
            first = worker._provider_health("BS_ROFORMER", run_smoke=False)
            self.assertTrue(first["checkpointReady"])
            self.assertTrue(first["smokeTested"])
            config.write_bytes(b"config-v2")
            second = worker._provider_health("BS_ROFORMER", run_smoke=False)
        self.assertFalse(second["checkpointReady"])
        self.assertFalse(second["smokeTested"])
        self.assertNotEqual(second["configSha256"], config_hash)

    def test_bs_roformer_license_block_short_circuits_health_and_worker_route(self):
        os.environ["MUSIC_AI_WORKER_TOKEN"] = "license-block-test-token"
        os.environ["MUSIC_GPU_PUBLIC_ORIGIN"] = (
            "https://workspace--music-ai-gpu-worker-bs-roformer.modal.run"
        )

        async def request(method, path, query_string=b"", body=b""):
            sent = []
            requests = iter([
                {"type": "http.request", "body": body, "more_body": False},
                {"type": "http.disconnect"},
            ])

            async def receive():
                return next(requests)

            async def send(message):
                sent.append(message)

            headers = [
                (b"authorization", b"Bearer license-block-test-token"),
            ]
            if body:
                headers.extend([
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ])
            await worker.app(
                {
                    "type": "http",
                    "asgi": {"version": "3.0"},
                    "http_version": "1.1",
                    "method": method,
                    "scheme": "https",
                    "path": path,
                    "raw_path": path.encode(),
                    "query_string": query_string,
                    "headers": headers,
                    "client": ("127.0.0.1", 1),
                    "server": (
                        "workspace--music-ai-gpu-worker-bs-roformer.modal.run",
                        443,
                    ),
                    "root_path": "",
                },
                receive,
                send,
            )
            status = next(
                item["status"]
                for item in sent
                if item["type"] == "http.response.start"
            )
            response_body = b"".join(
                item.get("body", b"")
                for item in sent
                if item["type"] == "http.response.body"
            )
            return status, worker.json.loads(response_body)

        try:
            with mock.patch.object(
                worker, "ENABLED", {"BS_ROFORMER"}
            ), mock.patch.object(
                worker, "_checkpoint_digest"
            ) as checkpoint_digest, mock.patch.object(
                worker, "_gpu_runtime"
            ) as gpu_runtime, mock.patch.object(
                worker, "_run_command"
            ) as run_command, mock.patch.object(
                worker, "_queue"
            ) as queue_job, mock.patch.object(
                worker.asyncio, "create_subprocess_exec"
            ) as create_subprocess:
                health = worker._provider_health("BS_ROFORMER")
                self.assertEqual(health["status"], "blocked")
                self.assertEqual(health["licenseStatus"], "UNVERIFIED")
                self.assertFalse(health["commercialUsePermitted"])
                self.assertFalse(health["checkpointReady"])
                self.assertFalse(health["smokeTested"])

                status, payload = asyncio.run(request(
                    "GET", "/health", b"provider=BS_ROFORMER"
                ))
                self.assertEqual(status, 200)
                self.assertEqual(payload["status"], "blocked")
                status, payload = asyncio.run(request(
                    "POST",
                    "/separate",
                    body=b'{"provider":"BS_ROFORMER"}',
                ))
                self.assertEqual(status, 503)
                self.assertIn("checkpoint-owner", payload["detail"])

                checkpoint_digest.assert_not_called()
                gpu_runtime.assert_not_called()
                run_command.assert_not_called()
                queue_job.assert_not_called()
                create_subprocess.assert_not_called()
                self.assertEqual(worker.TASKS, {})
        finally:
            del os.environ["MUSIC_AI_WORKER_TOKEN"]
            del os.environ["MUSIC_GPU_PUBLIC_ORIGIN"]

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
                    "scheme": "https",
                    "path": "/health",
                    "raw_path": b"/health",
                    "query_string": b"provider=ACE_STEP",
                    "headers": [
                        (b"authorization", b"Bearer health-test-token"),
                    ],
                    "client": ("127.0.0.1", 1),
                    "server": ("workspace--music-ai-gpu-worker-ace-step.modal.run", 443),
                    "root_path": "",
                },
                receive,
                send,
            )
            return sent

        try:
            with mock.patch.object(worker, "ENABLED", {"ACE_STEP"}), mock.patch.dict(
                os.environ,
                {
                    "MUSIC_GPU_PUBLIC_ORIGIN":
                        "https://workspace--music-ai-gpu-worker-ace-step.modal.run",
                    "MODAL_IMAGE_ID": "im-TestImage123",
                },
            ):
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
                "modelVersion": "mt3-pytorch-multitrack",
                "checkpointSha256": "a" * 64,
            }

        with mock.patch.object(
            worker, "_validate_provider", side_effect=cancel_during_attestation
        ), mock.patch.object(worker.asyncio, "create_subprocess_exec") as launch:
            asyncio.run(worker._execute(job["id"]))
        launch.assert_not_called()
        self.assertEqual(worker.job_status(job["id"])["status"], "cancelled")

    def test_runner_payload_fences_requeued_work_to_persisted_job_id(self):
        job = worker._queue(worker.JobRequest(provider="MT3"), "stable-runner-id")
        first = worker._runner_payload({"requestId": "caller-id"}, job["id"])
        second = worker._runner_payload({"requestId": "different-caller-id"}, job["id"])
        self.assertEqual(first["jobId"], job["id"])
        self.assertEqual(first["requestId"], job["id"])
        self.assertEqual(second["requestId"], job["id"])
        self.assertEqual(
            worker.OUTPUT_ROOT / "mt3" / first["requestId"],
            worker.OUTPUT_ROOT / "mt3" / second["requestId"],
        )

    def test_runner_result_requires_exact_nested_runtime_provenance(self):
        health = {
            "modelVersion": "mt3-pytorch-multitrack",
            "checkpointSha256": "a" * 64,
            "revision": "repo@revision",
            "containerDigest": "sha256:" + "b" * 64,
            "sourceImageDigest": "sha256:" + "b" * 64,
            "modalImageId": "im-TestImage123",
            "cudaVersion": "12.4",
            "pytorchVersion": "2.5.1+cu124",
            "gpu": "NVIDIA L4",
        }
        provenance = {
            "modelVersion": health["modelVersion"],
            "checkpointSha256": health["checkpointSha256"],
            "revision": health["revision"],
            "containerDigest": health["containerDigest"],
            "sourceImageDigest": health["sourceImageDigest"],
            "modalImageId": health["modalImageId"],
            "cudaVersion": health["cudaVersion"],
            "pytorchVersion": health["pytorchVersion"],
            "gpu": health["gpu"],
        }
        result = worker._result_from_runner("MT3", health, json.dumps({"provenance": provenance}))
        self.assertEqual(result["containerDigest"], health["containerDigest"])
        provenance["gpu"] = "different GPU"
        with self.assertRaisesRegex(RuntimeError, "provenance"):
            worker._result_from_runner("MT3", health, json.dumps({"provenance": provenance}))

    def test_artifact_base_accepts_only_matching_modal_provider_host(self):
        host = "workspace--music-ai-gpu-worker-bs-roformer.modal.run"
        request = worker.Request({
            "type": "http", "scheme": "https", "server": (host, 443),
            "path": "/", "query_string": b"", "headers": [(b"host", host.encode())],
        })
        with mock.patch.object(worker, "ENABLED", {"BS_ROFORMER"}), mock.patch.dict(
            os.environ, {"MUSIC_GPU_PUBLIC_ORIGIN": f"https://{host}"}
        ):
            self.assertEqual(worker._trusted_artifact_base(request), f"https://{host}")
            attacker = worker.Request({
                "type": "http", "scheme": "https", "server": ("attacker.example", 443),
                "path": "/", "query_string": b"",
                "headers": [(b"host", b"attacker.example")],
            })
            with self.assertRaises(worker.HTTPException) as rejected:
                worker._trusted_artifact_base(attacker)
            self.assertEqual(rejected.exception.status_code, 400)

    def test_smoke_subprocess_can_receive_derived_artifact_environment(self):
        code, output, _ = worker._run_command(
            "python3",
            [
                "-c",
                "import os; print(os.environ['MUSIC_GPU_ARTIFACT_BASE_URL'])",
            ],
            None,
            10,
            {"MUSIC_GPU_ARTIFACT_BASE_URL": "https://trusted.modal.run/artifacts"},
        )
        self.assertEqual(code, 0)
        self.assertEqual(output.strip(), "https://trusted.modal.run/artifacts")

    def test_health_failure_messages_are_bounded_and_strip_control_characters(self):
        message = worker._bounded_health_message(
            ["/private/path\x00\n" + ("internal traceback " * 200)]
        )
        self.assertLessEqual(len(message), 768)
        self.assertNotIn("\x00", message)
        self.assertNotIn("\n", message)

    def test_artifact_rejects_invalid_capability_and_traversal(self):
        path, expires, _ = self._artifact("vocals.flac")
        with self.assertRaises(worker.HTTPException) as invalid:
            worker._consume_artifact(
                "bs_roformer", "job-1", "vocals.flac", expires, "0" * 64
            )
        self.assertEqual(invalid.exception.status_code, 401)
        self.assertTrue(path.exists())
        with self.assertRaises(worker.HTTPException) as traversal:
            worker._consume_artifact(
                "bs_roformer", "job-1", "../vocals.flac", expires, "0" * 64
            )
        self.assertEqual(traversal.exception.status_code, 404)

    def test_artifact_capability_is_one_time(self):
        _, expires, capability = self._artifact("one-time.flac", "job-once")
        response = worker._consume_artifact(
            "bs_roformer", "job-once", "one-time.flac", expires, capability
        )
        with self.assertRaises(worker.HTTPException) as second:
            worker._consume_artifact(
                "bs_roformer", "job-once", "one-time.flac", expires, capability
            )
        self.assertEqual(second.exception.status_code, 404)
        asyncio.run(response.background())

    def test_two_stems_can_be_downloaded_sequentially(self):
        _, expires_a, capability_a = self._artifact("vocals.flac", "job-stems")
        _, expires_b, capability_b = self._artifact("instrumental.flac", "job-stems")
        vocals = worker._consume_artifact(
            "bs_roformer", "job-stems", "vocals.flac", expires_a, capability_a
        )
        instrumental = worker._consume_artifact(
            "bs_roformer", "job-stems", "instrumental.flac", expires_b, capability_b
        )
        asyncio.run(vocals.background())
        asyncio.run(instrumental.background())