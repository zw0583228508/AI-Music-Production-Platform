import hashlib
import importlib.util
import json
import os
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
            captured = release.capture(self.metadata)
            canary.assert_called_once_with(self.metadata, self.health)
            burst.assert_called_once_with(self.metadata)
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

    def test_comparison_burst_submits_above_cap_and_retains_only_safe_fields(self):
        class FakeCall:
            def __init__(self, comparison):
                self.comparison = comparison

            def get(self):
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
            def get(self):
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

            def get(self):
                stalled.wait()
                raise RuntimeError(private_details)

            def cancel(self):
                cancelled_indices.append(self.index)
                cancellation_attempted.set()
                stalled.wait()
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

            def get(self):
                if self.index:
                    stalled.wait()
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


if __name__ == "__main__":
    unittest.main()
