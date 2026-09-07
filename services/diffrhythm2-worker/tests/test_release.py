import hashlib
import importlib.util
import json
import multiprocessing
import os
import signal
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location("diffrhythm2_release", ROOT / "release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


def hung_cancel_worker(call_id, sender, worker_args):
    attempts, release_worker = worker_args
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    sender.send("started")
    with attempts.get_lock():
        attempts[int(call_id.removeprefix("fc-Test"))] += 1
    release_worker.wait()
    sender.send(True)


def slow_start_cancel_worker(_call_id, sender, worker_args):
    time.sleep(worker_args[0])
    sender.send("started")
    sender.send(True)


def acknowledgement_fixture_worker(call_id, sender, worker_args):
    deadline, = worker_args
    sender.send("started")
    if call_id == "fc-Missing":
        time.sleep(3600)
        sender.send(False)
    elif call_id == "fc-Late":
        time.sleep(3)
        sender.send(time.monotonic() <= deadline)
    else:
        sender.send(call_id == "fc-OnTime")


class FakeResponse:
    def __init__(self, url, body, headers=None):
        self.status = 200
        self._url = url
        self._body = body
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def geturl(self):
        return self._url

    def read(self, _limit):
        return self._body


class FakeOpener:
    def __init__(self, generation_url, artifact_url, result, audio):
        self.generation_url = generation_url
        self.artifact_url = artifact_url
        self.result = result
        self.audio = audio
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        if request.full_url == self.generation_url:
            return FakeResponse(request.full_url, json.dumps(self.result).encode())
        if request.full_url == self.artifact_url:
            return FakeResponse(
                request.full_url,
                self.audio,
                {"ETag": self.result["artifactSha256"]},
            )
        raise AssertionError(request.full_url)


class DiffRhythmReleaseTests(unittest.TestCase):
    def setUp(self):
        def cancel_synchronously(calls, _timeout, absolute_deadline=None):
            outcomes = []
            for call in calls:
                try:
                    call.cancel()
                    outcomes.append(True)
                except Exception:
                    outcomes.append(False)
            return outcomes

        cancellation_patcher = patch.object(
            release,
            "cancel_calls_within_bound",
            side_effect=cancel_synchronously,
        )
        cancellation_patcher.start()
        self.addCleanup(cancellation_patcher.stop)
        self.metadata = {
            "provider": "DIFFRHYTHM_2",
            "modalAppId": "ap-Test",
            "modalDeploymentId": "v7",
            "modalFunctionId": "fu-Test",
            "endpointOrigin": "https://worker.example.test",
        }
        self.health = {
            **self.metadata,
            "modalImageId": "im-Test",
            "ready": True,
            "healthy": True,
            "modelVersion": "source-revision",
            "revision": "checkpoint-revision",
            "checkpointSha256": "b" * 64,
            "sourceRevision": "source-revision",
            "sourceImageDigest": "sha256:" + "c" * 64,
            "codecThresholdEvidence": {
                "passed": True,
                "audioRetained": False,
                "ffmpegVersion": "ffmpeg version 4.4.2",
                "sourceImageDigest": "sha256:" + "c" * 64,
                "modalImageId": "im-Test",
            },
            "runtime": {"pythonVersion": "3.11"},
            "framework": {
                "cuda_image": "image", "cuda": "12.6", "pytorch": "2.7",
                "torchvision": "0.22", "torchaudio": "2.7",
                "torch_index_url": "index", "transformers": "4.47",
                "accelerate": "not-installed",
            },
        }

    def test_canary_authenticates_generation_and_artifact_and_retains_redacted_proof(self):
        audio = b"decoded mp3 bytes"
        digest = hashlib.sha256(audio).hexdigest()
        result = {
            "provider": "DIFFRHYTHM_2",
            "artifactUrl": "/artifacts/" + "a" * 32,
            "artifactSha256": digest,
            "licenseStatus": "RESEARCH_ONLY",
            "commercialUsePermitted": False,
            "license": release.RESEARCH_LICENSE,
        }
        opener = FakeOpener(
            self.metadata["endpointOrigin"] + "/generate",
            self.metadata["endpointOrigin"] + result["artifactUrl"],
            result,
            audio,
        )
        with tempfile.TemporaryDirectory() as directory, patch.object(
            release, "EVIDENCE", Path(directory)
        ), patch.object(
            release.urllib.request, "build_opener", return_value=opener
        ), patch.object(
            release, "describe_audio",
            return_value={"durationSeconds": 8.04, "rmsAmplitude": 0.17},
        ), patch.dict(os.environ, {"MUSIC_AI_WORKER_TOKEN": "secret-token"}):
            proof = release.verify_research_generation(self.metadata, self.health)
            retained = json.loads(
                (Path(directory) / "live-research-generation-proof.json").read_text()
            )
        self.assertEqual(proof, retained)
        self.assertEqual(len(opener.requests), 2)
        self.assertTrue(all(
            request.headers["Authorization"] == "Bearer secret-token"
            for request in opener.requests
        ))
        self.assertNotIn("artifactUrl", proof)
        self.assertNotIn("token", json.dumps(proof).lower())

    def test_capture_requires_live_generation_and_binds_its_digest(self):
        proof = {
            "schemaVersion": 1, "provider": "DIFFRHYTHM_2",
            "modalDeploymentId": "v7", "modalImageId": "im-Test",
            "licenseStatus": "RESEARCH_ONLY", "commercialUsePermitted": False,
            "license": release.RESEARCH_LICENSE,
            "outputSha256": "a" * 64, "bytes": 123,
            "durationSeconds": 8.0, "rmsAmplitude": 0.1,
            "artifactHashVerified": True,
            "authenticatedArtifactRetrieved": True,
            "artifactOrigin": self.metadata["endpointOrigin"],
        }
        with tempfile.TemporaryDirectory() as directory, patch.object(
            release, "EVIDENCE", Path(directory)
        ), patch.object(
            release, "fetch_health", return_value=self.health
        ), patch.object(
            release, "verify_research_generation", return_value=proof
        ) as canary, patch.object(
            release, "verify_comparison_burst",
            return_value=self.burst_proof(),
        ) as burst, patch.object(
            release, "verify_cancelled_comparison_drills",
            return_value=(
                self.cancellation_proof(),
                self.execution_cancellation_proof(),
                self.batch_execution_cancellation_proof(),
                self.cancellation_timing_proof(),
            ),
        ) as cancellation_drills, patch.object(
            release, "observe", return_value=self.metadata
        ):
            evidence = Path(directory)
            for name in (
                "model-assets.json", "known-good-short-smoke-proof.json",
                "known-good-short-output.mp3", "known-good-short-diagnostic.json",
                "full-fixture-smoke-proof.json", "full-fixture-output.mp3",
                "full-fixture-diagnostic.json",
            ):
                (evidence / name).write_bytes(name.encode())
            release.atomic_json(
                evidence / "live-research-generation-proof.json", proof
            )
            release.atomic_json(
                evidence / "live-comparison-burst-proof.json", self.burst_proof()
            )
            release.atomic_json(
                evidence / "live-comparison-cancellation-proof.json",
                self.cancellation_proof(),
            )
            release.atomic_json(
                evidence / "live-comparison-execution-cancellation-proof.json",
                self.execution_cancellation_proof(),
            )
            release.atomic_json(
                evidence
                / "live-comparison-batch-execution-cancellation-proof.json",
                self.batch_execution_cancellation_proof(),
            )
            release.atomic_json(
                evidence / "live-comparison-cancellation-timing-proof.json",
                self.cancellation_timing_proof(),
            )
            captured = release.capture(self.metadata)
            canary.assert_called_once_with(self.metadata, self.health)
            burst.assert_called_once_with(self.metadata)
            cancellation_drills.assert_called_once_with(self.metadata)
            self.assertEqual(captured["liveResearchGeneration"], proof)
            self.assertEqual(
                captured["retainedEvidence"]["live-research-generation-proof.json"]["sha256"],
                release.sha256(evidence / "live-research-generation-proof.json"),
            )
            stale = json.loads(json.dumps(captured))
            stale["liveResearchGeneration"]["modalDeploymentId"] = "v8"
            with self.assertRaisesRegex(ValueError, "stale or invalid"):
                release.validate_release(stale)

    def burst_proof(self):
        return {
            "schemaVersion": 1,
            "provider": "DIFFRHYTHM_2",
            "workerModalDeploymentId": self.metadata["modalDeploymentId"],
            "comparisonModalAppId": "ap-Compare",
            "comparisonModalDeploymentId": "v3",
            "comparisonModalFunctionId": "fu-Compare",
            "comparisonModalImageId": "im-Compare",
            "requestCount": release.COMPARISON_BURST_REQUESTS,
            "concurrencyLimit": release.COMPARISON_MAX_CONCURRENT_INPUTS,
            "timeoutSeconds": release.COMPARISON_BURST_TIMEOUT_SECONDS,
            "wallDurationSeconds": 1.2,
            "queueObserved": True,
            "outcomes": [
                {
                    "requestIndex": index,
                    "outcome": "completed",
                    "startedAfterSeconds": 0.5 if index == 2 else 0.0,
                    "durationSeconds": 0.5,
                }
                for index in range(release.COMPARISON_BURST_REQUESTS)
            ],
        }

    def cancellation_proof(self):
        return {
            "schemaVersion": 1,
            "provider": "DIFFRHYTHM_2",
            "workerModalDeploymentId": self.metadata["modalDeploymentId"],
            "comparisonModalAppId": "ap-Compare",
            "comparisonModalDeploymentId": "v3",
            "comparisonModalFunctionId": "fu-Compare",
            "comparisonModalImageId": "im-Compare",
            "occupiedCapacity": release.COMPARISON_MAX_CONCURRENT_INPUTS,
            "startedCapacity": release.COMPARISON_MAX_CONCURRENT_INPUTS,
            "stallStartBoundSeconds": release.COMPARISON_STALL_START_BOUND_SECONDS,
            "cancelAckBoundSeconds": release.COMPARISON_CANCEL_ACK_BOUND_SECONDS,
            "cancellationsAcknowledged": release.COMPARISON_MAX_CONCURRENT_INPUTS,
            "recoveryBoundSeconds": release.COMPARISON_RECOVERY_BOUND_SECONDS,
            "recoveredAfterSeconds": 0.4,
            "cancellationRequested": True,
            "capacityReleased": True,
        }

    def execution_cancellation_proof(self):
        return {
            "schemaVersion": 1,
            "provider": "DIFFRHYTHM_2",
            "workerModalDeploymentId": self.metadata["modalDeploymentId"],
            "comparisonModalAppId": "ap-Compare",
            "comparisonModalDeploymentId": "v3",
            "comparisonModalFunctionId": "fu-Compare",
            "comparisonModalImageId": "im-Compare",
            "workSeconds": release.COMPARISON_CANCELLATION_WORK_SECONDS,
            "observationBoundSeconds":
                release.COMPARISON_EXECUTION_STOP_BOUND_SECONDS,
            "preWorkMarkerObserved": True,
            "cancellationAcknowledged": True,
            "postWorkMarkerObserved": False,
            "executionStopped": True,
        }

    def batch_execution_cancellation_proof(self):
        return {
            "schemaVersion": 1,
            "provider": "DIFFRHYTHM_2",
            "workerModalDeploymentId": self.metadata["modalDeploymentId"],
            "comparisonModalAppId": "ap-Compare",
            "comparisonModalDeploymentId": "v3",
            "comparisonModalFunctionId": "fu-Compare",
            "comparisonModalImageId": "im-Compare",
            "occupiedCapacity": release.COMPARISON_MAX_CONCURRENT_INPUTS,
            "preWorkMarkersObserved": release.COMPARISON_MAX_CONCURRENT_INPUTS,
            "cancellationsAcknowledged":
                release.COMPARISON_MAX_CONCURRENT_INPUTS,
            "workSeconds": release.COMPARISON_CANCELLATION_WORK_SECONDS,
            "observationBoundSeconds":
                release.COMPARISON_EXECUTION_STOP_BOUND_SECONDS,
            "postWorkMarkersObserved": 0,
            "allExecutionsStopped": True,
        }

    def cancellation_timing_proof(self):
        return {
            "schemaVersion": 1,
            "provider": "DIFFRHYTHM_2",
            "workerModalDeploymentId": self.metadata["modalDeploymentId"],
            "controlledBatchCount": 1,
            "proofCount": 3,
            "wallDurationSeconds": 1.2,
            "wallDurationBoundSeconds":
                release.COMPARISON_CANCELLATION_SUITE_BOUND_SECONDS,
        }

    def test_shared_cancellation_deadline_handles_acknowledgement_outcomes(self):
        class Call:
            def __init__(self, outcome):
                self.object_id = f"fc-{outcome}"

        calls = [
            Call("Missing"), Call("OnTime"), Call("Late"), Call("FailedAck")
        ]
        run_acknowledgements = release._run_acknowledgement_workers_within_bound

        def observe(call_ids, deadline):
            return run_acknowledgements(
                call_ids,
                deadline,
                acknowledgement_fixture_worker,
            )

        with patch.object(
            release, "cancel_calls_within_bound",
            return_value=[True] * len(calls),
        ), patch.object(
            release, "_run_acknowledgement_workers_within_bound",
            side_effect=observe,
        ):
            requested, acknowledged = release.cancel_calls_before_deadline(
                calls, 2
            )
        self.assertEqual((requested, acknowledged), (4, 1))
        with patch.object(
            release, "cancel_calls_within_bound",
            return_value=[True, False],
        ):
            requested, acknowledged = release.cancel_calls_before_deadline(
                [Call("on_time"), Call("failed_request")], 0.05
            )
        self.assertEqual((requested, acknowledged), (1, 0))

    def test_repeated_acknowledgement_timeouts_leave_no_waiters(self):
        class Call:
            object_id = "fc-Missing"

            def __init__(self):
                self.resolved = False

        run_acknowledgements = release._run_acknowledgement_workers_within_bound

        def observe(call_ids, deadline):
            return run_acknowledgements(
                call_ids,
                deadline,
                acknowledgement_fixture_worker,
            )

        remote_calls = []
        baseline_processes = {
            worker.pid for worker in multiprocessing.active_children()
        }
        baseline_threads = {thread.ident for thread in threading.enumerate()}
        started = time.monotonic()
        with patch.object(
            release, "cancel_calls_within_bound", return_value=[True]
        ), patch.object(
            release, "_run_acknowledgement_workers_within_bound",
            side_effect=observe,
        ):
            for _ in range(3):
                remote_call = Call()
                remote_calls.append(remote_call)
                self.assertEqual(
                    release.cancel_calls_before_deadline([remote_call], 1),
                    (1, 0),
                )
        elapsed = time.monotonic() - started
        self.assertTrue(all(not call.resolved for call in remote_calls))
        self.assertLess(elapsed, 3 * (1 + 0.15))
        self.assertEqual(
            {worker.pid for worker in multiprocessing.active_children()},
            baseline_processes,
        )
        self.assertFalse(
            {thread.ident for thread in threading.enumerate()} - baseline_threads
        )
        self.assertNotIn(
            "private provider detail",
            str(release.cancel_calls_before_deadline),
            )

    def test_consolidated_cancellation_drills_share_one_batch_and_probe(self):
        class Lifecycle:
            def __init__(self):
                self.markers = []

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def get(self, timeout=None):
                if self.markers:
                    return self.markers.pop(0)
                raise release.queue.Empty

        class Call:
            def __init__(self, control):
                self.control = control
                self.cancelled = False

            def cancel(self):
                self.cancelled = True

            def get(self, timeout=None):
                if self.control == "probe":
                    now = time.time()
                    return {
                        "outcome": "completed",
                        "startedUnixSeconds": now,
                        "finishedUnixSeconds": now,
                        "modalImageId": "im-Compare",
                    }
                if self.cancelled:
                    raise release.RemoteError("cancelled")
                raise AssertionError("execution was not cancelled")

        class Comparison:
            def __init__(self):
                self.calls = []

            def spawn(self, control, lifecycle=None):
                call = Call(control)
                self.calls.append(call)
                if control == "cancel_execution":
                    lifecycle.markers.append({
                        "outcome": "pre_work",
                        "startedUnixSeconds": time.time(),
                        "modalImageId": "im-Compare",
                    })
                return call

        comparison = Comparison()
        identity = {
            "modalAppId": "ap-Compare",
            "modalDeploymentId": "v3",
            "modalFunctionId": "fu-Compare",
        }
        with tempfile.TemporaryDirectory() as directory, patch.object(
            release, "EVIDENCE", Path(directory)
        ), patch.object(
            release.modal.Queue, "ephemeral", return_value=Lifecycle()
        ), patch.object(
            release.modal.Function, "from_name", return_value=comparison
        ), patch.object(
            release, "observe_comparison", return_value=identity
        ):
            capacity, execution, batch, timing = (
                release.verify_cancelled_comparison_drills(self.metadata)
            )
        self.assertEqual(
            [call.control for call in comparison.calls],
            ["cancel_execution"] * release.COMPARISON_MAX_CONCURRENT_INPUTS
            + ["probe"],
        )
        self.assertTrue(all(
            call.cancelled
            for call in comparison.calls
            if call.control == "cancel_execution"
        ))
        expected_capacity = self.cancellation_proof()
        expected_capacity["recoveredAfterSeconds"] = capacity["recoveredAfterSeconds"]
        self.assertEqual(capacity, expected_capacity)
        self.assertEqual(execution, self.execution_cancellation_proof())
        self.assertEqual(batch, self.batch_execution_cancellation_proof())
        self.assertEqual(timing["controlledBatchCount"], 1)
        self.assertEqual(timing["proofCount"], 3)
        self.assertLessEqual(
            timing["wallDurationSeconds"], timing["wallDurationBoundSeconds"]
        )
        self.assertLess(len(json.dumps(timing)), 1024)

    def test_consolidated_drills_bound_a_hung_cancellation_without_retrying(self):
        blocked = threading.Event()
        cancel_started = threading.Event()

        class Lifecycle:
            def __init__(self):
                self.markers = []

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def get(self, timeout=None):
                if self.markers:
                    return self.markers.pop(0)
                raise release.queue.Empty

        class Call:
            def __init__(self):
                self.cancel_attempts = 0

            def cancel(self):
                self.cancel_attempts += 1
                cancel_started.set()
                raise RuntimeError("private provider detail")

        class Comparison:
            def __init__(self):
                self.calls = []

            def spawn(self, control, lifecycle=None):
                call = Call()
                self.calls.append(call)
                lifecycle.markers.append({
                    "outcome": "pre_work",
                    "startedUnixSeconds": time.time(),
                    "modalImageId": "im-Compare",
                })
                return call

        comparison = Comparison()
        identity = {
            "modalAppId": "ap-Compare",
            "modalDeploymentId": "v3",
            "modalFunctionId": "fu-Compare",
        }
        try:
            with tempfile.TemporaryDirectory() as directory, patch.object(
                release, "EVIDENCE", Path(directory)
            ), patch.object(
                release, "COMPARISON_CANCEL_ACK_BOUND_SECONDS", 0.05
            ), patch.object(
                release, "COMPARISON_CANCELLATION_SUITE_BOUND_SECONDS", 1
            ), patch.object(
                release.modal.Queue, "ephemeral", return_value=Lifecycle()
            ), patch.object(
                release.modal.Function, "from_name", return_value=comparison
            ), patch.object(
                release, "observe_comparison", return_value=identity
            ):
                started = time.monotonic()
                with self.assertRaisesRegex(
                    RuntimeError,
                    "^consolidated comparison cancellation drills failed "
                    "within a safe bound$",
                ):
                    release.verify_cancelled_comparison_drills(self.metadata)
                elapsed = time.monotonic() - started
            self.assertTrue(cancel_started.is_set())
            self.assertLess(elapsed, 0.5)
            self.assertTrue(all(call.cancel_attempts == 1 for call in comparison.calls))
        finally:
            blocked.set()

    def test_repeated_consolidated_hangs_leave_no_cancellation_workers(self):
        context = multiprocessing.get_context("spawn")
        release_hung_cancel = context.Event()
        attempts = context.Array(
            "i", release.COMPARISON_MAX_CONCURRENT_INPUTS
        )

        class Lifecycle:
            def __init__(self):
                self.markers = []

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def get(self, timeout=None):
                if self.markers:
                    return self.markers.pop(0)
                raise release.queue.Empty

        class Call:
            def __init__(self, index):
                self.object_id = f"fc-Test{index}"

        class Comparison:
            def __init__(self):
                self.spawned = 0

            def spawn(self, control, lifecycle=None):
                index = self.spawned % release.COMPARISON_MAX_CONCURRENT_INPUTS
                self.spawned += 1
                lifecycle.markers.append({
                    "outcome": "pre_work",
                    "startedUnixSeconds": time.time(),
                    "modalImageId": "im-Compare",
                })
                return Call(index)

        def isolate(calls, timeout, absolute_deadline=None):
            return release._run_cancel_workers_within_bound(
                [call.object_id for call in calls],
                min(timeout, 0.5),
                hung_cancel_worker,
                (attempts, release_hung_cancel),
                absolute_deadline,
            )

        identity = {
            "modalAppId": "ap-Compare",
            "modalDeploymentId": "v3",
            "modalFunctionId": "fu-Compare",
        }
        baseline_processes = {
            worker.pid for worker in multiprocessing.active_children()
        }
        baseline_threads = {thread.ident for thread in threading.enumerate()}
        started = time.monotonic()
        with tempfile.TemporaryDirectory() as directory, patch.object(
            release, "EVIDENCE", Path(directory)
        ), patch.object(
            release, "COMPARISON_CANCEL_ACK_BOUND_SECONDS", 1.0
        ), patch.object(
            release.modal.Queue, "ephemeral", side_effect=Lifecycle
        ), patch.object(
            release.modal.Function, "from_name", return_value=Comparison()
        ), patch.object(
            release, "observe_comparison", return_value=identity
        ), patch.object(
            release, "cancel_calls_within_bound", side_effect=isolate
        ):
            for _ in range(3):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "^consolidated comparison cancellation drills failed "
                    "within a safe bound$",
                ):
                    release.verify_cancelled_comparison_drills(self.metadata)
        elapsed = time.monotonic() - started

        self.assertEqual(list(attempts), [3] * len(attempts))
        self.assertLess(
            elapsed,
            3 * (1.0 + 0.3),
        )
        self.assertEqual(
            {worker.pid for worker in multiprocessing.active_children()},
            baseline_processes,
        )
        self.assertFalse(
            {thread.ident for thread in threading.enumerate()} - baseline_threads
        )

    def test_consolidated_drills_cancel_every_call_after_partial_markers(self):
        all_cancelled = threading.Event()

        class Lifecycle:
            def __init__(self):
                self.reads = 0

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def get(self, timeout=None):
                self.reads += 1
                if self.reads == 1:
                    return {
                        "outcome": "pre_work",
                        "startedUnixSeconds": time.time(),
                        "modalImageId": "im-Compare",
                    }
                return {"outcome": "malformed"}

        class Call:
            def __init__(self, comparison):
                self.comparison = comparison
                self.cancel_attempts = 0

            def cancel(self):
                self.cancel_attempts += 1
                with self.comparison.lock:
                    self.comparison.cancelled += 1
                    if (
                        self.comparison.cancelled
                        == release.COMPARISON_MAX_CONCURRENT_INPUTS
                    ):
                        all_cancelled.set()

        class Comparison:
            def __init__(self):
                self.calls = []
                self.cancelled = 0
                self.lock = threading.Lock()

            def spawn(self, control, lifecycle=None):
                call = Call(self)
                self.calls.append(call)
                return call

        comparison = Comparison()
        identity = {
            "modalAppId": "ap-Compare",
            "modalDeploymentId": "v3",
            "modalFunctionId": "fu-Compare",
        }
        with tempfile.TemporaryDirectory() as directory, patch.object(
            release, "EVIDENCE", Path(directory)
        ), patch.object(
            release.modal.Queue, "ephemeral", return_value=Lifecycle()
        ), patch.object(
            release.modal.Function, "from_name", return_value=comparison
        ), patch.object(
            release, "observe_comparison", return_value=identity
        ):
            started = time.monotonic()
            with self.assertRaisesRegex(
                RuntimeError,
                "^consolidated comparison cancellation drills failed "
                "within a safe bound$",
            ):
                release.verify_cancelled_comparison_drills(self.metadata)
            elapsed = time.monotonic() - started
        self.assertTrue(all_cancelled.wait(0.2))
        self.assertLess(elapsed, 0.5)
        self.assertEqual(
            len(comparison.calls), release.COMPARISON_MAX_CONCURRENT_INPUTS
        )
        self.assertTrue(all(call.cancel_attempts == 1 for call in comparison.calls))

    def test_cli_entrypoint_is_after_every_capture_validator(self):
        source = (ROOT / "release.py").read_text()
        self.assertLess(
            source.index("def validate_cancelled_comparison_timing"),
            source.index('if __name__ == "__main__":'),
        )

    def test_cancelled_comparison_batch_never_reaches_post_work_marker(self):
        class FakeQueue:
            def __init__(self):
                self.markers = []

            def get(self, timeout=None):
                if self.markers:
                    return self.markers.pop(0)
                raise release.queue.Empty

        class FakeEphemeral:
            def __init__(self, lifecycle):
                self.lifecycle = lifecycle

            def __enter__(self):
                return self.lifecycle

            def __exit__(self, *_):
                return False

        class FakeCall:
            def __init__(self, comparison):
                self.comparison = comparison
                self.cancelled = False

            def cancel(self):
                self.cancelled = True

            def get(self, timeout=None):
                if self.cancelled:
                    raise release.RemoteError("private provider detail")
                raise AssertionError("execution was not cancelled")

        class FakeComparison:
            def __init__(self):
                self.calls = []
                self.lock = threading.Lock()
                self.active_cancellations = 0
                self.peak_cancellations = 0
                self.all_cancelling = threading.Event()

            def spawn(self, control, lifecycle):
                self.control = control
                lifecycle.markers.append({
                    "outcome": "pre_work",
                    "startedUnixSeconds": time.time(),
                    "modalImageId": "im-Compare",
                })
                call = FakeCall(self)
                self.calls.append(call)
                return call

        lifecycle = FakeQueue()
        comparison = FakeComparison()
        identity = {
            "modalAppId": "ap-Compare",
            "modalDeploymentId": "v3",
            "modalFunctionId": "fu-Compare",
        }
        with tempfile.TemporaryDirectory() as directory, patch.object(
            release, "EVIDENCE", Path(directory)
        ), patch.object(
            release.modal.Queue, "ephemeral",
            return_value=FakeEphemeral(lifecycle),
        ), patch.object(
            release.modal.Function, "from_name", return_value=comparison
        ), patch.object(
            release, "observe_comparison", return_value=identity
        ):
            proof = release.verify_cancelled_comparison_batch_execution(
                self.metadata
            )
            retained = json.loads(
                (
                    Path(directory)
                    / "live-comparison-batch-execution-cancellation-proof.json"
                ).read_text()
            )
        self.assertEqual(proof, retained)
        self.assertEqual(comparison.control, "cancel_execution")
        self.assertEqual(
            len(comparison.calls), release.COMPARISON_MAX_CONCURRENT_INPUTS
        )
        self.assertTrue(all(call.cancelled for call in comparison.calls))
        self.assertEqual(proof, self.batch_execution_cancellation_proof())
        release.validate_cancelled_comparison_batch_execution(
            proof, self.metadata
        )
        self.assertLess(len(json.dumps(proof)), 2048)
        self.assertNotRegex(
            json.dumps(proof).lower(),
            r"(path|sha|audio|fixture|artifact|error|message|input)",
        )

    def test_cancelled_comparison_batch_hung_cancel_stays_within_shared_bound(self):
        private_detail = "/private/provider/input.wav " + "a" * 64
        release_hung_cancel = threading.Event()

        class Lifecycle:
            def __init__(self):
                self.markers = []

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def get(self, timeout=None):
                if self.markers:
                    return self.markers.pop(0)
                raise release.queue.Empty

        class Call:
            def __init__(self, index, attempts):
                self.index = index
                self.attempts = attempts

            def cancel(self):
                self.attempts.append(self.index)
                if self.index == 0:
                    raise RuntimeError(private_detail)

            def get(self, timeout=None):
                raise release.RemoteError(private_detail)

        class Comparison:
            def __init__(self):
                self.attempts = []
                self.spawned = 0

            def spawn(self, control, lifecycle):
                index = self.spawned
                self.spawned += 1
                lifecycle.markers.append({
                    "outcome": "pre_work",
                    "startedUnixSeconds": time.time(),
                    "modalImageId": "im-Compare",
                })
                return Call(index, self.attempts)

        comparison = Comparison()
        identity = {
            "modalAppId": "ap-Compare",
            "modalDeploymentId": "v3",
            "modalFunctionId": "fu-Compare",
        }
        acknowledgement_bound = 0.05
        try:
            with tempfile.TemporaryDirectory() as directory, patch.object(
                release, "EVIDENCE", Path(directory)
            ), patch.object(
                release, "COMPARISON_CANCEL_ACK_BOUND_SECONDS",
                acknowledgement_bound,
            ), patch.object(
                release.modal.Queue, "ephemeral", return_value=Lifecycle()
            ), patch.object(
                release.modal.Function, "from_name", return_value=comparison
            ), patch.object(
                release, "observe_comparison", return_value=identity
            ):
                started = time.monotonic()
                with self.assertRaisesRegex(
                    RuntimeError,
                    "^cancelled comparison batch did not stop within the safe bound$",
                ) as raised:
                    release.verify_cancelled_comparison_batch_execution(
                        self.metadata
                    )
                elapsed = time.monotonic() - started
                retained = (
                    Path(directory)
                    / "live-comparison-batch-execution-cancellation-proof.json"
                ).read_text()
        finally:
            release_hung_cancel.set()

        self.assertLess(elapsed, acknowledgement_bound + 0.2)
        self.assertEqual(
            set(comparison.attempts),
            set(range(release.COMPARISON_MAX_CONCURRENT_INPUTS)),
        )
        surfaced = str(raised.exception) + retained
        self.assertNotIn(private_detail, surfaced)
        self.assertLess(len(retained), 2048)
        proof = json.loads(retained)
        self.assertEqual(proof["cancellationsAcknowledged"], 0)
        self.assertFalse(proof["allExecutionsStopped"])

    def test_cancelled_comparison_batch_acknowledgements_share_one_deadline(self):
        missing_ack = threading.Event()

        class Lifecycle:
            def __init__(self):
                self.markers = []

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def get(self, timeout=None):
                return self.markers.pop(0) if self.markers else None

        class Call:
            def __init__(self, index):
                self.index = index

            def cancel(self):
                pass

            def get(self, timeout=None):
                if self.index == 0:
                    missing_ack.wait()
                    raise RuntimeError("private provider detail")
                time.sleep(0.02 * self.index)
                raise release.RemoteError("private provider detail")

        class Comparison:
            def __init__(self):
                self.spawned = 0

            def spawn(self, control, lifecycle):
                call = Call(self.spawned)
                self.spawned += 1
                lifecycle.markers.append({
                    "outcome": "pre_work",
                    "startedUnixSeconds": time.time(),
                    "modalImageId": "im-Compare",
                })
                return call

        identity = {
            "modalAppId": "ap-Compare",
            "modalDeploymentId": "v3",
            "modalFunctionId": "fu-Compare",
        }
        acknowledgement_bound = 0.08
        try:
            with tempfile.TemporaryDirectory() as directory, patch.object(
                release, "EVIDENCE", Path(directory)
            ), patch.object(
                release, "COMPARISON_CANCEL_ACK_BOUND_SECONDS",
                acknowledgement_bound,
            ), patch.object(
                release.modal.Queue, "ephemeral", return_value=Lifecycle()
            ), patch.object(
                release.modal.Function, "from_name", return_value=Comparison()
            ), patch.object(
                release, "observe_comparison", return_value=identity
            ):
                started = time.monotonic()
                with self.assertRaisesRegex(
                    RuntimeError,
                    "^cancelled comparison batch did not stop within the safe bound$",
                ):
                    release.verify_cancelled_comparison_batch_execution(
                        self.metadata
                    )
                elapsed = time.monotonic() - started
                retained = (
                    Path(directory)
                    / "live-comparison-batch-execution-cancellation-proof.json"
                ).read_text()
        finally:
            missing_ack.set()

        self.assertLess(elapsed, acknowledgement_bound + 0.2)
        proof = json.loads(retained)
        self.assertEqual(
            proof["cancellationsAcknowledged"],
            release.COMPARISON_MAX_CONCURRENT_INPUTS - 1,
        )
        self.assertFalse(proof["allExecutionsStopped"])
        self.assertNotIn("private provider detail", retained)
        self.assertLess(len(retained), 2048)

    def test_cancelled_comparison_batch_rejects_one_post_work_marker(self):
        class Lifecycle:
            def __init__(self):
                self.markers = []

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def get(self, timeout=None):
                return self.markers.pop(0) if self.markers else None

        class Call:
            def __init__(self):
                self.cancelled = False

            def cancel(self):
                self.cancelled = True

            def get(self, timeout=None):
                raise release.RemoteError("cancelled")

        class Comparison:
            def __init__(self):
                self.spawned = 0

            def spawn(self, control, lifecycle):
                self.spawned += 1
                lifecycle.markers.append({
                    "outcome": "pre_work",
                    "startedUnixSeconds": time.time(),
                    "modalImageId": "im-Compare",
                })
                if self.spawned == release.COMPARISON_MAX_CONCURRENT_INPUTS:
                    lifecycle.markers.append({
                        "outcome": "post_work",
                        "finishedUnixSeconds": time.time(),
                        "modalImageId": "im-Compare",
                    })
                return Call()

        identity = {
            "modalAppId": "ap-Compare",
            "modalDeploymentId": "v3",
            "modalFunctionId": "fu-Compare",
        }
        with tempfile.TemporaryDirectory() as directory, patch.object(
            release, "EVIDENCE", Path(directory)
        ), patch.object(
            release.modal.Queue, "ephemeral", return_value=Lifecycle()
        ), patch.object(
            release.modal.Function, "from_name", return_value=Comparison()
        ), patch.object(
            release, "observe_comparison", return_value=identity
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "^cancelled comparison batch did not stop within the safe bound$",
            ):
                release.verify_cancelled_comparison_batch_execution(
                    self.metadata
                )
            retained = json.loads(
                (
                    Path(directory)
                    / "live-comparison-batch-execution-cancellation-proof.json"
                ).read_text()
            )
        self.assertEqual(retained["postWorkMarkersObserved"], 1)
        self.assertFalse(retained["allExecutionsStopped"])
        self.assertLess(len(json.dumps(retained)), 2048)

    def test_cancelled_comparison_never_reaches_post_work_marker(self):
        class FakeQueue:
            def __init__(self):
                self.markers = []
                self.timeouts = []

            def get(self, timeout=None):
                self.timeouts.append(timeout)
                return self.markers.pop(0) if self.markers else None

        class FakeEphemeral:
            def __init__(self, queue):
                self.queue = queue

            def __enter__(self):
                return self.queue

            def __exit__(self, *_):
                return False

        class FakeCall:
            def __init__(self):
                self.cancelled = False

            def cancel(self):
                self.cancelled = True

            def get(self, timeout=None):
                if self.cancelled:
                    raise release.RemoteError("private provider detail")
                raise AssertionError("execution was not cancelled")

        class FakeComparison:
            def __init__(self):
                self.call = FakeCall()
                self.control = None

            def spawn(self, control, lifecycle):
                self.control = control
                lifecycle.markers.append({
                    "outcome": "pre_work",
                    "startedUnixSeconds": time.time(),
                    "modalImageId": "im-Compare",
                })
                return self.call

        lifecycle = FakeQueue()
        comparison = FakeComparison()
        identity = {
            "modalAppId": "ap-Compare",
            "modalDeploymentId": "v3",
            "modalFunctionId": "fu-Compare",
        }
        with tempfile.TemporaryDirectory() as directory, patch.object(
            release, "EVIDENCE", Path(directory)
        ), patch.object(
            release.modal.Queue, "ephemeral",
            return_value=FakeEphemeral(lifecycle),
        ), patch.object(
            release.modal.Function, "from_name", return_value=comparison
        ), patch.object(
            release, "observe_comparison", return_value=identity
        ):
            proof = release.verify_cancelled_comparison_execution(self.metadata)
            retained = json.loads(
                (
                    Path(directory)
                    / "live-comparison-execution-cancellation-proof.json"
                ).read_text()
            )
        self.assertEqual(proof, retained)
        self.assertEqual(comparison.control, "cancel_execution")
        self.assertTrue(comparison.call.cancelled)
        self.assertEqual(
            lifecycle.timeouts,
            [
                release.COMPARISON_STALL_START_BOUND_SECONDS,
                release.COMPARISON_EXECUTION_STOP_BOUND_SECONDS,
            ],
        )
        self.assertTrue(proof["preWorkMarkerObserved"])
        self.assertFalse(proof["postWorkMarkerObserved"])
        self.assertTrue(proof["executionStopped"])
        self.assertNotRegex(
            json.dumps(proof).lower(),
            r"(path|sha|audio|fixture|artifact|error|message|input)",
        )

    def test_execution_cancellation_channel_failure_is_redacted(self):
        private_detail = "/private/fixture.wav " + "a" * 64

        class BrokenQueue:
            def __init__(self):
                self.reads = 0

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def get(self, timeout=None):
                self.reads += 1
                if self.reads == 1:
                    return {
                        "outcome": "pre_work",
                        "startedUnixSeconds": time.time(),
                        "modalImageId": "im-Compare",
                    }
                raise RuntimeError(private_detail)

        class Call:
            def cancel(self):
                pass

            def get(self, timeout=None):
                raise release.RemoteError("cancelled")

        class Comparison:
            def spawn(self, control, lifecycle):
                return Call()

        with tempfile.TemporaryDirectory() as directory, patch.object(
            release, "EVIDENCE", Path(directory)
        ), patch.object(
            release.modal.Queue, "ephemeral", return_value=BrokenQueue()
        ), patch.object(
            release.modal.Function, "from_name", return_value=Comparison()
        ), patch.object(
            release, "observe_comparison",
            return_value={
                "modalAppId": "ap-Compare",
                "modalDeploymentId": "v3",
                "modalFunctionId": "fu-Compare",
            },
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "^cancelled comparison execution did not stop within the safe bound$",
            ) as raised:
                release.verify_cancelled_comparison_execution(self.metadata)
            retained = (
                Path(directory)
                / "live-comparison-execution-cancellation-proof.json"
            ).read_text()
        surfaced = str(raised.exception) + retained
        self.assertNotIn(private_detail, surfaced)
        self.assertLess(len(retained), 2048)
        self.assertFalse(json.loads(retained)["executionStopped"])

    def test_single_execution_hung_cancel_stays_bounded_and_reaped(self):
        context = multiprocessing.get_context("spawn")
        release_hung_cancel = context.Event()
        attempts = context.Array("i", 1)

        class Lifecycle:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def get(self, timeout=None):
                return {
                    "outcome": "pre_work",
                    "startedUnixSeconds": time.time(),
                    "modalImageId": "im-Compare",
                }

        class Call:
            object_id = "fc-Test0"

        class Comparison:
            def spawn(self, control, lifecycle):
                return Call()

        def isolate(calls, timeout, absolute_deadline=None):
            return release._run_cancel_workers_within_bound(
                [call.object_id for call in calls],
                timeout,
                hung_cancel_worker,
                (attempts, release_hung_cancel),
                absolute_deadline,
            )

        identity = {
            "modalAppId": "ap-Compare",
            "modalDeploymentId": "v3",
            "modalFunctionId": "fu-Compare",
        }
        baseline_processes = {
            worker.pid for worker in multiprocessing.active_children()
        }
        baseline_threads = {thread.ident for thread in threading.enumerate()}
        bound = 1.0
        with tempfile.TemporaryDirectory() as directory, patch.object(
            release, "EVIDENCE", Path(directory)
        ), patch.object(
            release, "COMPARISON_CANCEL_ACK_BOUND_SECONDS", bound
        ), patch.object(
            release.modal.Queue, "ephemeral", return_value=Lifecycle()
        ), patch.object(
            release.modal.Function, "from_name", return_value=Comparison()
        ), patch.object(
            release, "observe_comparison", return_value=identity
        ), patch.object(
            release, "cancel_calls_within_bound", side_effect=isolate
        ):
            started = time.monotonic()
            with self.assertRaisesRegex(
                RuntimeError,
                "^cancelled comparison execution did not stop within the safe bound$",
            ):
                release.verify_cancelled_comparison_execution(self.metadata)
            elapsed = time.monotonic() - started
            retained = (
                Path(directory)
                / "live-comparison-execution-cancellation-proof.json"
            ).read_text()

        self.assertLess(elapsed, bound + 0.3)
        self.assertEqual(list(attempts), [1])
        self.assertEqual(
            {worker.pid for worker in multiprocessing.active_children()},
            baseline_processes,
        )
        self.assertFalse(
            {thread.ident for thread in threading.enumerate()} - baseline_threads
        )
        self.assertFalse(json.loads(retained)["executionStopped"])

    def test_cancelled_comparisons_release_every_slot_before_probe_bound(self):
        class FakeQueue:
            def __init__(self):
                self.markers = []

            def get(self, timeout=None):
                return self.markers.pop(0) if self.markers else None

        class FakeEphemeral:
            def __init__(self, queue):
                self.queue = queue

            def __enter__(self):
                return self.queue

            def __exit__(self, *_):
                return False

        class FakeCall:
            def __init__(self, comparison, control):
                self.comparison = comparison
                self.control = control
                self.cancelled = False

            def cancel(self):
                self.comparison.cancelled += 1
                self.cancelled = True

            def get(self, timeout=None):
                if self.control == "stall":
                    self.comparison.cancel_timeouts.append(timeout)
                    if self.cancelled:
                        raise release.RemoteError(
                            "Function call was cancelled by user or a failure."
                        )
                    raise AssertionError("uncancelled stall was awaited")
                self.comparison.probe_timeout = timeout
                now = time.time()
                return {
                    "outcome": "completed",
                    "startedUnixSeconds": now,
                    "finishedUnixSeconds": now,
                    "modalImageId": "im-Compare",
                }

        class FakeComparison:
            def __init__(self):
                self.controls = []
                self.cancelled = 0
                self.cancel_timeouts = []
                self.probe_timeout = None

            def spawn(self, control, readiness=None):
                self.controls.append(control)
                if control == "stall":
                    readiness.markers.append({
                        "outcome": "started",
                        "startedUnixSeconds": time.time(),
                        "modalImageId": "im-Compare",
                    })
                return FakeCall(self, control)

        comparison = FakeComparison()
        identity = {
            "modalAppId": "ap-Compare",
            "modalDeploymentId": "v3",
            "modalFunctionId": "fu-Compare",
        }
        readiness = FakeQueue()
        with tempfile.TemporaryDirectory() as directory, patch.object(
            release, "EVIDENCE", Path(directory)
        ), patch.object(
            release.modal.Queue, "ephemeral",
            return_value=FakeEphemeral(readiness),
        ), patch.object(
            release.modal.Function, "from_name", return_value=comparison
        ), patch.object(
            release, "observe_comparison", return_value=identity
        ):
            proof = release.verify_cancelled_comparison_capacity(self.metadata)
            retained = json.loads(
                (
                    Path(directory) / "live-comparison-cancellation-proof.json"
                ).read_text()
            )
        self.assertEqual(proof, retained)
        self.assertEqual(
            comparison.controls,
            ["stall"] * release.COMPARISON_MAX_CONCURRENT_INPUTS + ["probe"],
        )
        self.assertEqual(
            comparison.cancelled, release.COMPARISON_MAX_CONCURRENT_INPUTS
        )
        self.assertEqual(
            comparison.probe_timeout, release.COMPARISON_RECOVERY_BOUND_SECONDS
        )
        self.assertEqual(
            proof["startedCapacity"], release.COMPARISON_MAX_CONCURRENT_INPUTS
        )
        self.assertEqual(
            proof["cancellationsAcknowledged"],
            release.COMPARISON_MAX_CONCURRENT_INPUTS,
        )
        self.assertTrue(proof["capacityReleased"])
        self.assertNotRegex(
            json.dumps(proof).lower(),
            r"(path|sha|audio|fixture|artifact|error|message|input)",
        )

    def test_cancellation_drill_rejects_unstarted_capacity(self):
        class EmptyQueue:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def get(self, timeout=None):
                return None

        class Call:
            def cancel(self):
                pass

        class Comparison:
            def spawn(self, control, readiness=None):
                return Call()

        with tempfile.TemporaryDirectory() as directory, patch.object(
            release, "EVIDENCE", Path(directory)
        ), patch.object(
            release.modal.Queue, "ephemeral", return_value=EmptyQueue()
        ), patch.object(
            release.modal.Function, "from_name", return_value=Comparison()
        ), patch.object(
            release, "observe_comparison",
            return_value={
                "modalAppId": "ap-Compare",
                "modalDeploymentId": "v3",
                "modalFunctionId": "fu-Compare",
            },
        ):
            with self.assertRaisesRegex(RuntimeError, "capacity was not released"):
                release.verify_cancelled_comparison_capacity(self.metadata)
            retained = json.loads(
                (
                    Path(directory) / "live-comparison-cancellation-proof.json"
                ).read_text()
            )
        self.assertEqual(retained["startedCapacity"], 0)
        self.assertFalse(retained["capacityReleased"])

    def test_cancellation_drill_rejects_failed_cancellation(self):
        class ReadyQueue:
            def __init__(self):
                self.remaining = release.COMPARISON_MAX_CONCURRENT_INPUTS

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def get(self, timeout=None):
                self.remaining -= 1
                return {
                    "outcome": "started",
                    "startedUnixSeconds": time.time(),
                    "modalImageId": "im-Compare",
                }

        class Call:
            def cancel(self):
                raise RuntimeError("provider detail")

        class Comparison:
            def spawn(self, control, readiness=None):
                return Call()

        with tempfile.TemporaryDirectory() as directory, patch.object(
            release, "EVIDENCE", Path(directory)
        ), patch.object(
            release.modal.Queue, "ephemeral", return_value=ReadyQueue()
        ), patch.object(
            release.modal.Function, "from_name", return_value=Comparison()
        ), patch.object(
            release, "observe_comparison",
            return_value={
                "modalAppId": "ap-Compare",
                "modalDeploymentId": "v3",
                "modalFunctionId": "fu-Compare",
            },
        ):
            with self.assertRaisesRegex(RuntimeError, "capacity was not released"):
                release.verify_cancelled_comparison_capacity(self.metadata)
            retained = (
                Path(directory) / "live-comparison-cancellation-proof.json"
            ).read_text()
        self.assertNotIn("provider detail", retained)
        self.assertFalse(json.loads(retained)["capacityReleased"])

    def test_capacity_drill_hung_cancel_stays_within_shared_bound(self):
        private_detail = "/private/provider/input.wav " + "a" * 64
        release_hung_cancel = threading.Event()

        class Readiness:
            def __init__(self):
                self.markers = []

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def get(self, timeout=None):
                return self.markers.pop(0)

        class Call:
            def __init__(self, index, attempts):
                self.index = index
                self.attempts = attempts

            def cancel(self):
                self.attempts.append(self.index)
                if self.index == 0:
                    raise RuntimeError(private_detail)

            def get(self, timeout=None):
                raise release.RemoteError(private_detail)

        class Comparison:
            def __init__(self):
                self.attempts = []
                self.spawned = 0

            def spawn(self, control, readiness=None):
                if control != "stall":
                    raise AssertionError("recovery probe must not start")
                index = self.spawned
                self.spawned += 1
                readiness.markers.append({
                    "outcome": "started",
                    "startedUnixSeconds": time.time(),
                    "modalImageId": "im-Compare",
                })
                return Call(index, self.attempts)

        comparison = Comparison()
        identity = {
            "modalAppId": "ap-Compare",
            "modalDeploymentId": "v3",
            "modalFunctionId": "fu-Compare",
        }
        cancellation_bound = 0.05
        try:
            with tempfile.TemporaryDirectory() as directory, patch.object(
                release, "EVIDENCE", Path(directory)
            ), patch.object(
                release, "COMPARISON_CANCEL_ACK_BOUND_SECONDS",
                cancellation_bound,
            ), patch.object(
                release.modal.Queue, "ephemeral", return_value=Readiness()
            ), patch.object(
                release.modal.Function, "from_name", return_value=comparison
            ), patch.object(
                release, "observe_comparison", return_value=identity
            ):
                started = time.monotonic()
                with self.assertRaisesRegex(
                    RuntimeError,
                    "^cancelled comparison capacity was not released within the safe bound$",
                ) as raised:
                    release.verify_cancelled_comparison_capacity(self.metadata)
                elapsed = time.monotonic() - started
                retained = (
                    Path(directory) / "live-comparison-cancellation-proof.json"
                ).read_text()
        finally:
            release_hung_cancel.set()

        self.assertLess(elapsed, cancellation_bound + 0.2)
        self.assertEqual(
            set(comparison.attempts),
            set(range(release.COMPARISON_MAX_CONCURRENT_INPUTS)),
        )
        surfaced = str(raised.exception) + retained
        self.assertNotIn(private_detail, surfaced)
        self.assertLess(len(retained), 2048)
        proof = json.loads(retained)
        self.assertEqual(proof["cancellationsAcknowledged"], 0)
        self.assertFalse(proof["capacityReleased"])

    def test_capacity_drill_slow_acknowledgements_share_one_deadline(self):
        private_detail = "/private/provider/input.wav " + "a" * 64
        release_missing_ack = threading.Event()

        class Readiness:
            def __init__(self):
                self.markers = []

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def get(self, timeout=None):
                return self.markers.pop(0)

        class Call:
            def __init__(self, index):
                self.index = index
                self.cancelled = False

            def cancel(self):
                self.cancelled = True

            def get(self, timeout=None):
                if self.index == 0:
                    release_missing_ack.wait()
                    raise RuntimeError(private_detail)
                time.sleep(0.02 * self.index)
                raise release.RemoteError(private_detail)

        class Comparison:
            def __init__(self):
                self.spawned = 0

            def spawn(self, control, readiness=None):
                if control != "stall":
                    raise AssertionError("recovery probe must not start")
                call = Call(self.spawned)
                self.spawned += 1
                readiness.markers.append({
                    "outcome": "started",
                    "startedUnixSeconds": time.time(),
                    "modalImageId": "im-Compare",
                })
                return call

        identity = {
            "modalAppId": "ap-Compare",
            "modalDeploymentId": "v3",
            "modalFunctionId": "fu-Compare",
        }
        acknowledgement_bound = 0.08
        try:
            with tempfile.TemporaryDirectory() as directory, patch.object(
                release, "EVIDENCE", Path(directory)
            ), patch.object(
                release, "COMPARISON_CANCEL_ACK_BOUND_SECONDS",
                acknowledgement_bound,
            ), patch.object(
                release.modal.Queue, "ephemeral", return_value=Readiness()
            ), patch.object(
                release.modal.Function, "from_name", return_value=Comparison()
            ), patch.object(
                release, "observe_comparison", return_value=identity
            ):
                started = time.monotonic()
                with self.assertRaisesRegex(
                    RuntimeError,
                    "^cancelled comparison capacity was not released within the safe bound$",
                ) as raised:
                    release.verify_cancelled_comparison_capacity(self.metadata)
                elapsed = time.monotonic() - started
                retained = (
                    Path(directory) / "live-comparison-cancellation-proof.json"
                ).read_text()
        finally:
            release_missing_ack.set()

        self.assertLess(elapsed, acknowledgement_bound + 0.2)
        proof = json.loads(retained)
        self.assertEqual(
            proof["cancellationsAcknowledged"],
            release.COMPARISON_MAX_CONCURRENT_INPUTS - 1,
        )
        self.assertFalse(proof["capacityReleased"])
        surfaced = str(raised.exception) + retained
        self.assertNotIn(private_detail, surfaced)
        self.assertLess(len(retained), 2048)

    def test_comparison_burst_submits_above_cap_and_retains_only_safe_fields(self):
        class FakeCall:
            def __init__(self, comparison):
                self.comparison = comparison

            def get(self, timeout=None):
                return self.comparison.remote()

            def cancel(self):
                raise AssertionError("completed calls must not be cancelled")

        class FakeComparison:
            def __init__(self):
                self.active = 0
                self.peak = 0
                self.lock = threading.Lock()

            def remote(self):
                with self.lock:
                    self.active += 1
                    self.peak = max(self.peak, self.active)
                started = time.time()
                time.sleep(0.02)
                with self.lock:
                    self.active -= 1
                return {
                    "outcome": "completed",
                    "startedUnixSeconds": started,
                    "finishedUnixSeconds": time.time(),
                    "modalImageId": "im-Compare",
                }

            def spawn(self):
                return FakeCall(self)

        comparison = FakeComparison()
        with tempfile.TemporaryDirectory() as directory, patch.object(
            release, "EVIDENCE", Path(directory)
        ), patch.object(
            release.modal.Function, "from_name", return_value=comparison
        ), patch.object(
            release, "observe_comparison",
            return_value={
                "modalAppId": "ap-Compare",
                "modalDeploymentId": "v3",
                "modalFunctionId": "fu-Compare",
            },
        ):
            original_remote = comparison.remote
            gate = threading.Semaphore(release.COMPARISON_MAX_CONCURRENT_INPUTS)
            def capped_remote():
                with gate:
                    return original_remote()
            comparison.remote = capped_remote
            proof = release.verify_comparison_burst(self.metadata)
            retained = json.loads(
                (Path(directory) / "live-comparison-burst-proof.json").read_text()
            )
        self.assertEqual(proof, retained)
        self.assertGreater(proof["requestCount"], proof["concurrencyLimit"])
        self.assertEqual(comparison.peak, release.COMPARISON_MAX_CONCURRENT_INPUTS)
        self.assertTrue(proof["queueObserved"])
        release.validate_comparison_burst(proof, self.metadata)
        self.assertNotRegex(
            json.dumps(proof).lower(), r"(path|sha|audio|fixture|artifact|error|message)"
        )

    def test_comparison_burst_failure_is_sanitized_after_safe_evidence_is_written(self):
        class FailedCall:
            def get(self, timeout=None):
                raise RuntimeError("/private/audio.wav " + "a" * 64)

            def cancel(self):
                raise AssertionError("finished failed calls must not be cancelled")

        class FailedComparison:
            def spawn(self):
                return FailedCall()

        with tempfile.TemporaryDirectory() as directory, patch.object(
            release, "EVIDENCE", Path(directory)
        ), patch.object(
            release.modal.Function, "from_name", return_value=FailedComparison()
        ), patch.object(
            release, "observe_comparison",
            return_value={
                "modalAppId": "ap-Compare",
                "modalDeploymentId": "v3",
                "modalFunctionId": "fu-Compare",
            },
        ):
            with self.assertRaisesRegex(
                RuntimeError, "^live comparison burst did not queue safely "
            ) as raised:
                release.verify_comparison_burst(self.metadata)
            retained = (
                Path(directory) / "live-comparison-burst-proof.json"
            ).read_text()
        self.assertNotIn("/private", str(raised.exception))
        self.assertNotIn("/private", retained)
        self.assertNotIn("a" * 64, retained)

    def test_comparison_burst_stall_times_out_without_waiting_for_call_threads(self):
        private_details = "/private/stalled/audio.wav " + "a" * 64
        stalled = threading.Event()
        cancellation_attempted = threading.Event()
        cancelled_indices = []

        class StalledCall:
            def __init__(self, index):
                self.index = index

            def get(self, timeout=None):
                if not stalled.wait(timeout):
                    raise TimeoutError
                raise RuntimeError(private_details)

            def cancel(self):
                cancelled_indices.append(self.index)
                cancellation_attempted.set()
                raise RuntimeError(private_details)

        class StalledComparison:
            def __init__(self):
                self.spawned = 0

            def spawn(self):
                call = StalledCall(self.spawned)
                self.spawned += 1
                return call

        try:
            with tempfile.TemporaryDirectory() as directory, patch.object(
                release, "EVIDENCE", Path(directory)
            ), patch.object(
                release, "COMPARISON_BURST_TIMEOUT_SECONDS", 0.05
            ), patch.object(
                release.modal.Function, "from_name", return_value=StalledComparison()
            ), patch.object(
                release, "observe_comparison",
                return_value={
                    "modalAppId": "ap-Compare",
                    "modalDeploymentId": "v3",
                    "modalFunctionId": "fu-Compare",
                },
            ):
                started = time.monotonic()
                with self.assertRaisesRegex(
                    RuntimeError,
                    "^live comparison burst did not queue safely within "
                    "the worker resource limit$",
                ) as raised:
                    release.verify_comparison_burst(self.metadata)
                elapsed = time.monotonic() - started
                self.assertTrue(cancellation_attempted.wait(0.2))
                retained = json.loads(
                    (
                        Path(directory) / "live-comparison-burst-proof.json"
                    ).read_text()
                )
        finally:
            stalled.set()

        self.assertLess(elapsed, 0.5)
        self.assertCountEqual(
            cancelled_indices, range(release.COMPARISON_BURST_REQUESTS)
        )
        self.assertEqual(
            retained["outcomes"],
            [
                {
                    "requestIndex": index,
                    "outcome": "cancellation_failed",
                    "startedAfterSeconds": 0,
                    "durationSeconds": 0.05,
                }
                for index in range(release.COMPARISON_BURST_REQUESTS)
            ],
        )
        self.assertTrue(all(
            set(outcome) == {
                "requestIndex", "outcome", "startedAfterSeconds", "durationSeconds",
            }
            for outcome in retained["outcomes"]
        ))
        surfaced = str(raised.exception) + json.dumps(retained)
        self.assertNotIn(private_details, surfaced)
        self.assertNotRegex(
            surfaced.lower(), r"(private|sha256|audio|fixture|artifact|metadata)"
        )

    def test_comparison_burst_cancels_only_calls_unfinished_at_deadline(self):
        stalled = threading.Event()
        cancelled_indices = []
        cancellations_completed = []

        class FakeCall:
            def __init__(self, index):
                self.index = index

            def get(self, timeout=None):
                if self.index:
                    if not stalled.wait(timeout):
                        raise TimeoutError
                now = time.time()
                return {
                    "outcome": "completed",
                    "startedUnixSeconds": now,
                    "finishedUnixSeconds": now,
                    "modalImageId": "im-Compare",
                }

            def cancel(self):
                time.sleep(0.02)
                cancelled_indices.append(self.index)
                cancellations_completed.append(self.index)

        class FakeComparison:
            def __init__(self):
                self.spawned = 0

            def spawn(self):
                call = FakeCall(self.spawned)
                self.spawned += 1
                return call

        try:
            with tempfile.TemporaryDirectory() as directory, patch.object(
                release, "EVIDENCE", Path(directory)
            ), patch.object(
                release, "COMPARISON_BURST_TIMEOUT_SECONDS", 0.05
            ), patch.object(
                release.modal.Function, "from_name", return_value=FakeComparison()
            ), patch.object(
                release, "observe_comparison",
                return_value={
                    "modalAppId": "ap-Compare",
                    "modalDeploymentId": "v3",
                    "modalFunctionId": "fu-Compare",
                },
            ):
                with self.assertRaises(RuntimeError):
                    release.verify_comparison_burst(self.metadata)
                self.assertCountEqual(
                    cancellations_completed,
                    range(1, release.COMPARISON_BURST_REQUESTS),
                )
                retained = json.loads(
                    (
                        Path(directory) / "live-comparison-burst-proof.json"
                    ).read_text()
                )
        finally:
            stalled.set()

        self.assertCountEqual(
            cancelled_indices, range(1, release.COMPARISON_BURST_REQUESTS)
        )
        self.assertEqual(retained["outcomes"][0]["outcome"], "completed")
        self.assertTrue(all(
            outcome["outcome"] == "timeout"
            for outcome in retained["outcomes"][1:]
        ))

    def test_comparison_burst_cleanup_bounds_late_missing_and_failed_responses(self):
        stalled = threading.Event()

        class StalledCall:
            def __init__(self, index):
                self.index = index

            def get(self, timeout=None):
                if not stalled.wait(timeout):
                    raise TimeoutError

        class StalledComparison:
            def __init__(self):
                self.spawned = 0

            def spawn(self):
                call = StalledCall(self.spawned)
                self.spawned += 1
                return call

        response_cases = {
            "late": lambda deadline: (
                time.sleep(max(0, deadline - time.monotonic()) + 0.01)
                or [False] * release.COMPARISON_BURST_REQUESTS
            ),
            "missing": lambda _deadline: [],
            "failed": lambda _deadline: [False] * release.COMPARISON_BURST_REQUESTS,
        }
        try:
            for name, responses in response_cases.items():
                with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                    cleanup_deadlines = []

                    def cancel(calls, timeout, absolute_deadline=None):
                        self.assertEqual(
                            len(calls), release.COMPARISON_BURST_REQUESTS
                        )
                        self.assertIsNotNone(absolute_deadline)
                        self.assertGreaterEqual(timeout, 0)
                        self.assertLessEqual(
                            timeout, release.COMPARISON_CANCEL_TIMEOUT_SECONDS
                        )
                        cleanup_deadlines.append(absolute_deadline)
                        return responses(absolute_deadline)

                    with patch.object(
                        release, "EVIDENCE", Path(directory)
                    ), patch.object(
                        release, "COMPARISON_BURST_TIMEOUT_SECONDS", 0.01
                    ), patch.object(
                        release, "COMPARISON_CANCEL_TIMEOUT_SECONDS", 0.02
                    ), patch.object(
                        release.modal.Function,
                        "from_name",
                        return_value=StalledComparison(),
                    ), patch.object(
                        release,
                        "observe_comparison",
                        return_value={
                            "modalAppId": "ap-Compare",
                            "modalDeploymentId": "v3",
                            "modalFunctionId": "fu-Compare",
                        },
                    ), patch.object(
                        release,
                        "cancel_calls_within_bound",
                        side_effect=cancel,
                    ):
                        with self.assertRaisesRegex(
                            RuntimeError,
                            "^live comparison burst did not queue safely ",
                        ):
                            release.verify_comparison_burst(self.metadata)
                        retained = json.loads(
                            (
                                Path(directory)
                                / "live-comparison-burst-proof.json"
                            ).read_text()
                        )

                    self.assertEqual(len(cleanup_deadlines), 1)
                    self.assertTrue(all(
                        outcome["outcome"] == "cancellation_failed"
                        for outcome in retained["outcomes"]
                    ))
        finally:
            stalled.set()

    def test_repeated_comparison_burst_timeouts_reap_workers_and_bound_evidence(self):
        context = multiprocessing.get_context("spawn")
        release_hung_cancel = context.Event()
        attempts = context.Array(
            "i", release.COMPARISON_BURST_REQUESTS
        )
        stalled = threading.Event()
        private_details = "/private/stalled/audio.wav " + "a" * 64

        class StalledCall:
            def __init__(self, index):
                self.object_id = f"fc-Test{index}"

            def get(self, timeout=None):
                if not stalled.wait(timeout):
                    raise TimeoutError
                raise RuntimeError(private_details)

        class StalledComparison:
            def __init__(self):
                self.spawned = 0

            def spawn(self):
                index = self.spawned % release.COMPARISON_BURST_REQUESTS
                self.spawned += 1
                return StalledCall(index)

        def isolate(calls, timeout, absolute_deadline=None):
            return release._run_cancel_workers_within_bound(
                [call.object_id for call in calls],
                timeout,
                hung_cancel_worker,
                (attempts, release_hung_cancel),
                absolute_deadline,
            )

        identity = {
            "modalAppId": "ap-Compare",
            "modalDeploymentId": "v3",
            "modalFunctionId": "fu-Compare",
        }
        baseline = {worker.pid for worker in multiprocessing.active_children()}
        baseline_waiters = {
            thread.ident
            for thread in threading.enumerate()
            if thread.name.startswith("diffrhythm2-comparison-result-")
        }
        timeout = 0.05
        cleanup_bound = 1.0
        try:
            with tempfile.TemporaryDirectory() as directory, patch.object(
                release, "EVIDENCE", Path(directory)
            ), patch.object(
                release, "COMPARISON_BURST_TIMEOUT_SECONDS", timeout
            ), patch.object(
                release, "COMPARISON_CANCEL_TIMEOUT_SECONDS", cleanup_bound
            ), patch.object(
                release.modal.Function,
                "from_name",
                return_value=StalledComparison(),
            ), patch.object(
                release, "observe_comparison", return_value=identity
            ), patch.object(
                release, "cancel_calls_within_bound", side_effect=isolate
            ):
                for _ in range(3):
                    started = time.monotonic()
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "^live comparison burst did not queue safely within "
                        "the worker resource limit$",
                    ) as raised:
                        release.verify_comparison_burst(self.metadata)
                    elapsed = time.monotonic() - started
                    retained = (
                        Path(directory) / "live-comparison-burst-proof.json"
                    ).read_text()

                    self.assertLess(elapsed, timeout + cleanup_bound + 0.3)
                    self.assertEqual(
                        {worker.pid for worker in multiprocessing.active_children()},
                        baseline,
                    )
                    self.assertEqual(
                        {
                            thread.ident
                            for thread in threading.enumerate()
                            if thread.name.startswith(
                                "diffrhythm2-comparison-result-"
                            )
                        },
                        baseline_waiters,
                    )
                    self.assertLess(len(retained), 4096)
                    surfaced = str(raised.exception) + retained
                    self.assertNotIn(private_details, surfaced)
                    self.assertNotRegex(
                        surfaced.lower(),
                        r"(private|sha256|audio|fixture|artifact|metadata)",
                    )
                    proof = json.loads(retained)
                    self.assertEqual(
                        proof["outcomes"],
                        [
                            {
                                "requestIndex": index,
                                "outcome": "cancellation_failed",
                                "startedAfterSeconds": 0,
                                "durationSeconds": timeout,
                            }
                            for index in range(release.COMPARISON_BURST_REQUESTS)
                        ],
                    )
        finally:
            stalled.set()

        self.assertEqual(list(attempts), [3] * len(attempts))

    def test_repeated_hung_cancellations_leave_no_live_workers(self):
        context = multiprocessing.get_context("spawn")
        release_hung_cancel = context.Event()
        attempts = context.Array(
            "i", release.COMPARISON_MAX_CONCURRENT_INPUTS
        )
        call_ids = [
            f"fc-Test{index}"
            for index in range(release.COMPARISON_MAX_CONCURRENT_INPUTS)
        ]
        baseline = {worker.pid for worker in multiprocessing.active_children()}
        started = time.monotonic()
        for _ in range(3):
            self.assertEqual(
                release._run_cancel_workers_within_bound(
                    call_ids,
                    1.0,
                    hung_cancel_worker,
                    (attempts, release_hung_cancel),
                ),
                [False] * len(call_ids),
            )
        elapsed = time.monotonic() - started

        self.assertEqual(list(attempts), [3] * len(call_ids))
        self.assertLess(
            elapsed,
            3 * (1.0 + 0.3),
        )
        self.assertEqual(
            {worker.pid for worker in multiprocessing.active_children()},
            baseline,
        )

    def test_slow_worker_startup_stays_inside_absolute_deadline(self):
        baseline = {worker.pid for worker in multiprocessing.active_children()}
        timeout = 0.1
        started = time.monotonic()
        results = release._run_cancel_workers_within_bound(
            ["fc-SlowStart"],
            timeout,
            slow_start_cancel_worker,
            (1.0,),
        )
        elapsed = time.monotonic() - started

        self.assertEqual(results, [False])
        self.assertLess(elapsed, timeout + 0.2)
        self.assertEqual(
            {worker.pid for worker in multiprocessing.active_children()},
            baseline,
        )

    def test_isolated_cancellation_reconstructs_exact_modal_call(self):
        class Call:
            def __init__(self):
                self.cancelled = False

            def cancel(self):
                self.cancelled = True

        call = Call()
        receiver, sender = multiprocessing.Pipe(duplex=False)
        with patch.object(
            release.modal.FunctionCall,
            "from_id",
            return_value=call,
        ) as from_id:
            release._cancel_modal_call("fc-ExactCall", sender, ())

        self.assertTrue(receiver.recv())
        receiver.close()
        from_id.assert_called_once_with("fc-ExactCall")
        self.assertTrue(call.cancelled)


if __name__ == "__main__":
    unittest.main()
