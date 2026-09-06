import argparse
import base64
import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))

import activate_promotion
import promote_modal
import release_modal
import resume_activation_pr


def release_evidence():
    manifest = promote_modal.MANIFEST
    return {
        "schemaVersion": 1,
        "provider": "BEAT_THIS",
        "modalAppId": "ap-Test",
        "modalDeploymentId": "v7",
        "modalFunctionId": "fu-Test",
        "modalImageId": "im-Test",
        "endpointOrigin": "https://beat-this.example.test",
        "sourceRevision": "b" * 40,
        "sourceImageDigest": "sha256:" + "c" * 64,
        "smokeEvidence": {
            "provider": "BEAT_THIS",
            "featureExecutionSucceeded": True,
            "checkpoint": {
                "name": "final0",
                "sha256": manifest["checkpointSha256"],
            },
            "fixture": {
                "sourceSha256": "d" * 64,
                "sha256": "e" * 64,
                "sampleRate": 44100,
                "channels": 2,
                "frames": 1000,
                "durationSeconds": 1.0,
            },
            "result": {
                "beatCount": 4,
                "downbeatCount": 1,
                "firstBeats": [0.0, 0.5, 1.0, 1.5],
                "firstDownbeats": [0.0],
                "confidence": 0.9,
            },
        },
    }


def promotion_record(evidence):
    return promote_modal.record(argparse.Namespace(
        modal_app_id=evidence["modalAppId"],
        modal_deployment_id=evidence["modalDeploymentId"],
        modal_function_id=evidence["modalFunctionId"],
        modal_image_id=evidence["modalImageId"],
        endpoint_origin=evidence["endpointOrigin"],
        source_revision=evidence["sourceRevision"],
        source_image_digest=evidence["sourceImageDigest"],
        release_evidence_sha256=promote_modal.release_evidence_sha256(evidence),
    ))


def matching_health(record):
    runtime = record["runtime"]
    return {
        "provider": "BEAT_THIS",
        "status": "ready",
        "ready": True,
        "healthy": True,
        "retryable": False,
        "retryAfterSeconds": None,
        "checksum": record["checkpointSha256"],
        "modalAppId": record["modalAppId"],
        "modalDeploymentId": record["modalDeploymentId"],
        "modalFunctionId": record["modalFunctionId"],
        "modalImageId": record["modalImageId"],
        "modelVersion": record["modelVersion"],
        "checkpointSha256": record["checkpointSha256"],
        "revision": record["checkpointRevision"],
        "sourceRevision": record["sourceRevision"],
        "sourceImageDigest": record["sourceImageDigest"],
        "runtime": {"pythonVersion": runtime["python"]},
        "framework": {
            "python": runtime["python"],
            "cuda_image": runtime["cudaImage"],
            "cuda": runtime["cuda"],
            "pytorch": runtime["pytorch"],
            "torchvision": runtime["torchvision"],
            "torchaudio": runtime["torchaudio"],
            "torch_index_url": runtime["torchIndexUrl"],
            "transformers": runtime["transformers"],
            "accelerate": runtime["accelerate"],
        },
        "packageName": "beat-this",
        "packageVersion": record["modelVersion"],
        "packageReady": True,
        "assetReady": True,
        "featureExecutionReady": True,
        "runtimeReady": True,
        "checkpointReady": True,
        "smokeTested": True,
        "gpuReady": True,
        "identityReady": True,
        "reason": None,
    }


def container_refresh(evidence):
    return {
        "schemaVersion": 1,
        "provider": "BEAT_THIS",
        "modalAppId": evidence["modalAppId"],
        "modalDeploymentId": evidence["modalDeploymentId"],
        "stoppedContainerIds": ["ta-Old"],
        "staleContainerIds": [],
    }


class BeatThisReleaseTests(unittest.TestCase):
    def test_health_request_budget_covers_a_real_gpu_cold_start(self):
        self.assertEqual(release_modal.HEALTH_REQUEST_TIMEOUT_SECONDS, 300)

    def test_release_activation_uses_a_reviewed_source_revision_branch(self):
        repository = Path(__file__).resolve().parents[3]
        workflow = (
            repository / ".github/workflows/release-beat-this.yml"
        ).read_text()

        self.assertIn("pull-requests: write", workflow)
        self.assertIn(
            'activation_branch="beat-this-activation/$SOURCE_REVISION"',
            workflow,
        )
        self.assertIn('--base "$RELEASE_BRANCH"', workflow)
        self.assertIn('--head "$activation_branch"', workflow)
        self.assertIn(
            'git push origin "HEAD:refs/heads/$activation_branch"',
            workflow,
        )
        self.assertNotIn('git push origin "HEAD:$RELEASE_BRANCH"', workflow)
        self.assertIn("Reopen or merge this same pull request", workflow)
        self.assertIn("deploy.py --candidate", workflow)
        self.assertIn("verify-candidate-refresh", workflow)
        self.assertIn("promotion/candidate-refresh-health.json", workflow)
        self.assertIn("--verify-existing", workflow)
        self.assertIn("--public-key promotion/public-key.pem", workflow)
        self.assertIn(
            '--expected-source-revision "$SOURCE_REVISION"', workflow
        )
        self.assertIn('--base "$BASE_BRANCH"', workflow)
        self.assertNotIn("--base main", workflow)
        self.assertIn("--release-branch", workflow)
        retained_step = workflow.split(
            "Authenticate retained evidence and verify the activation branch",
            1,
        )[1].split(
            "Reopen the protected-branch activation proposal",
            1,
        )[0]
        self.assertIn("GH_TOKEN: ${{ github.token }}", retained_step)
        self.assertIn('gh run view "$RELEASE_RUN_ID"', retained_step)
        self.assertIn("resume_activation_pr.py", workflow)
        candidate_deploy = workflow.index(
            "deploy.py --candidate"
        )
        production_deploy = workflow.index(
            "Deploy the exact production worker revision"
        )
        self.assertLess(candidate_deploy, production_deploy)
        self.assertIn(
            "--app-name beat-this-candidate", workflow
        )
        self.assertIn("--app-name beat-this-worker", workflow)
        self.assertNotIn(
            "modal secret create beat-this-deployment-identity-v1",
            workflow,
        )

    def test_modal_metadata_requires_one_deployed_app_and_latest_version(self):
        self.assertEqual(
            release_modal.deployed_app_id([
                {"app_id": "ap-Old", "description": "beat-this-worker",
                 "state": "stopped"},
                {"app_id": "ap-Live", "description": "beat-this-worker",
                 "state": "deployed"},
            ]),
            "ap-Live",
        )
        self.assertEqual(
            release_modal.deployed_version([{"version": "v12"}]),
            "v12",
        )
        with self.assertRaises(ValueError):
            release_modal.deployed_app_id([
                {"app_id": "ap-One", "description": "beat-this-worker",
                 "state": "deployed"},
                {"app_id": "ap-Two", "description": "beat-this-worker",
                 "state": "deployed"},
            ])
        metadata = {
            "modalAppId": "ap-Live",
            "modalDeploymentId": "v12",
            "modalFunctionId": "fu-Live",
            "endpointOrigin": "https://beat-this.example.test",
        }
        self.assertEqual(
            release_modal.identity(metadata),
            {
                "BEAT_THIS_MODAL_APP_ID": "ap-Live",
                "BEAT_THIS_MODAL_DEPLOYMENT_ID": "v12",
                "BEAT_THIS_MODAL_FUNCTION_ID": "fu-Live",
            },
        )

    def test_real_smoke_evidence_is_required(self):
        evidence = release_evidence()
        release_modal.validate_release_evidence(evidence)
        evidence["smokeEvidence"]["result"]["downbeatCount"] = 0
        with self.assertRaisesRegex(ValueError, "smoke evidence"):
            release_modal.validate_release_evidence(evidence)

    def test_release_health_retries_only_explicit_startup(self):
        evidence = release_evidence()
        ready = matching_health(promotion_record(evidence))
        starting = {
            **ready,
            **promote_modal.STARTUP_HEALTH_CONTRACT,
            "packageReady": False,
            "assetReady": False,
            "featureExecutionReady": False,
            "runtimeReady": False,
            "checkpointReady": False,
            "smokeTested": False,
            "gpuReady": False,
        }
        with patch.object(
            release_modal, "read_health", side_effect=[starting, ready]
        ) as fetch, patch.object(promote_modal.time, "sleep"):
            self.assertEqual(
                release_modal.verified_health(evidence, "token", attempts=2),
                ready,
            )
        self.assertEqual(fetch.call_count, 2)

        rejected = (
            {
                "provider": "BEAT_THIS",
                "status": "not_ready",
                "ready": False,
                "retryable": False,
            },
            {**ready, "modalFunctionId": "fu-Wrong"},
            {"provider": "BEAT_THIS", "status": "ready", "ready": True},
        )
        for payload in rejected:
            with self.subTest(payload=payload), patch.object(
                release_modal, "read_health", return_value=payload
            ) as fetch, self.assertRaises(ValueError):
                release_modal.verified_health(evidence, "token", attempts=3)
            fetch.assert_called_once()

        with patch.object(
            release_modal, "read_health", side_effect=OSError("network failed")
        ) as fetch, self.assertRaises(OSError):
            release_modal.verified_health(evidence, "token", attempts=3)
        fetch.assert_called_once()

    def test_container_refresh_waits_for_modal_stop_convergence(self):
        with patch.object(
            release_modal,
            "running_container_ids",
            side_effect=[["ta-Old"], ["ta-Old"], []],
        ) as containers, patch.object(release_modal.time, "sleep") as sleep:
            release_modal.wait_for_stopped_containers(
                "ap-Live", ["ta-Old"], attempts=3, delay_seconds=1
            )
        self.assertEqual(containers.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

        with patch.object(
            release_modal,
            "running_container_ids",
            return_value=["ta-Old"],
        ), patch.object(release_modal.time, "sleep"), self.assertRaisesRegex(
            RuntimeError, "old Beat This containers"
        ):
            release_modal.wait_for_stopped_containers(
                "ap-Live", ["ta-Old"], attempts=2, delay_seconds=0
            )

    def test_candidate_refresh_uses_trusted_derived_origin_and_evidence(self):
        evidence = release_evidence()
        evidence["endpointOrigin"] = (
            "https://workspace--beat-this-candidate.modal.run"
        )
        expected = release_modal.expected_health(evidence)
        report = {"provider": "BEAT_THIS", "finalStatus": "ready"}
        with patch.object(
            promote_modal,
            "trusted_candidate_origin",
            return_value="https://workspace--beat-this-candidate.modal.run",
        ) as derive, patch.object(
            promote_modal,
            "refresh_candidate_and_verify",
            return_value=report,
        ) as refresh:
            self.assertEqual(
                release_modal.verified_candidate_refresh(
                    evidence, "token", attempts=4
                ),
                report,
            )
        derive.assert_called_once_with(evidence["endpointOrigin"])
        refresh.assert_called_once_with(
            "https://workspace--beat-this-candidate.modal.run",
            "token",
            expected,
            attempts=4,
            delay_seconds=10,
        )

    def test_candidate_and_production_identity_flow_stays_isolated(self):
        candidate_metadata = {
            "modalAppId": "ap-Candidate",
            "modalDeploymentId": "v3",
            "modalFunctionId": "fu-Candidate",
            "endpointOrigin": (
                "https://workspace--beat-this-candidate.modal.run"
            ),
        }
        production_metadata = {
            "modalAppId": "ap-Production",
            "modalDeploymentId": "v8",
            "modalFunctionId": "fu-Production",
            "endpointOrigin": "https://workspace--beat-this.modal.run",
        }
        self.assertNotEqual(
            release_modal.identity(candidate_metadata),
            release_modal.identity(production_metadata),
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate_identity = root / "candidate-identity.json"
            candidate_refresh = root / "candidate-refresh.json"
            production_identity = root / "production-identity.json"
            production_refresh = root / "production-refresh.json"
            with patch.object(
                release_modal.subprocess, "run"
            ) as run, patch.object(
                release_modal, "running_container_ids", return_value=[]
            ), patch.object(release_modal, "wait_for_stopped_containers"):
                release_modal.install_identity(
                    candidate_metadata,
                    candidate_identity,
                    candidate_refresh,
                    release_modal.CANDIDATE_APP_NAME,
                )
                release_modal.install_identity(
                    production_metadata,
                    production_identity,
                    production_refresh,
                    release_modal.APP_NAME,
                )
            secret_names = [
                call.args[0][5]
                for call in run.call_args_list
                if call.args[0][3:5] == ["secret", "create"]
            ]
            self.assertEqual(
                secret_names,
                [
                    "beat-this-candidate-deployment-identity-v1",
                    "beat-this-deployment-identity-v1",
                ],
            )
            self.assertEqual(
                json.loads(candidate_identity.read_text())[
                    "BEAT_THIS_MODAL_APP_ID"
                ],
                "ap-Candidate",
            )
            self.assertEqual(
                json.loads(production_identity.read_text())[
                    "BEAT_THIS_MODAL_APP_ID"
                ],
                "ap-Production",
            )

            candidate_evidence = release_evidence()
            candidate_evidence.update(candidate_metadata)
            production_evidence = release_evidence()
            production_evidence.update(production_metadata)
            production_evidence["releaseBranch"] = "release/beat-this"
            with patch.object(
                promote_modal,
                "trusted_candidate_origin",
                return_value=candidate_evidence["endpointOrigin"],
            ), patch.object(
                promote_modal,
                "refresh_candidate_and_verify",
                return_value={
                    "provider": "BEAT_THIS",
                    "finalStatus": "ready",
                },
            ) as refresh_candidate:
                release_modal.verified_candidate_refresh(
                    candidate_evidence, "token", attempts=1
                )
            candidate_expected = refresh_candidate.call_args.args[2]
            self.assertEqual(
                candidate_expected["modalAppId"], "ap-Candidate"
            )
            self.assertEqual(
                candidate_expected["modalDeploymentId"], "v3"
            )

            production_record = promotion_record(production_evidence)
            private_key = root / "private.pem"
            subprocess.run(
                [
                    "openssl", "genpkey", "-algorithm", "Ed25519",
                    "-out", str(private_key),
                ],
                check=True,
            )
            production_bundle = {
                "record": production_record,
                "signature": promote_modal.sign(
                    production_record, private_key
                ),
            }
            api_output = root / "promotion.generated.ts"
            release_output = root / "release.json"
            activate_promotion.activate(
                production_bundle,
                promote_modal.public_key(private_key),
                production_evidence,
                json.loads(production_refresh.read_text()),
                matching_health(production_record),
                api_output,
                release_output,
            )
            activated = json.loads(release_output.read_text())
            self.assertEqual(
                activated["record"]["modalAppId"], "ap-Production"
            )
            self.assertNotIn(
                "ap-Candidate", api_output.read_text()
            )

    def test_resume_requires_the_original_one_commit_activation_branch(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            subprocess.run(["git", "init"], cwd=repository, check=True)
            subprocess.run(
                ["git", "config", "user.email", "test@example.invalid"],
                cwd=repository,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "Release Test"],
                cwd=repository,
                check=True,
            )
            for relative in activate_promotion.ACTIVATION_PATHS:
                path = repository / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("unpromoted\n")
            subprocess.run(
                ["git", "add", "."], cwd=repository, check=True
            )
            subprocess.run(
                ["git", "commit", "-m", "source"],
                cwd=repository,
                check=True,
                capture_output=True,
            )
            source = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=repository,
                text=True,
            ).strip()
            for relative in activate_promotion.ACTIVATION_PATHS:
                (repository / relative).write_text("activated\n")
            subprocess.run(
                ["git", "commit", "-am", "activation"],
                cwd=repository,
                check=True,
                capture_output=True,
            )
            activate_promotion.verify_activation_commit(
                repository, source
            )
            (repository / "unexpected.txt").write_text("tampered\n")
            subprocess.run(
                ["git", "add", "unexpected.txt"],
                cwd=repository,
                check=True,
            )
            subprocess.run(
                ["git", "commit", "-m", "append tamper"],
                cwd=repository,
                check=True,
                capture_output=True,
            )
            with self.assertRaisesRegex(ValueError, "original source child"):
                activate_promotion.verify_activation_commit(
                    repository, source
                )

    def test_resume_authenticates_new_and_legacy_release_branches(self):
        evidence = release_evidence()
        self.assertEqual(
            activate_promotion.authenticated_release_branch(
                evidence, "main"
            ),
            "main",
        )
        evidence["releaseBranch"] = "release/beat-this"
        self.assertEqual(
            activate_promotion.authenticated_release_branch(
                evidence, "release/beat-this"
            ),
            "release/beat-this",
        )
        with self.assertRaisesRegex(ValueError, "differs"):
            activate_promotion.authenticated_release_branch(
                evidence, "main"
            )

    def test_validation_precedes_canonical_record_replacement(self):
        evidence = release_evidence()
        record = promotion_record(evidence)
        health = matching_health(record)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private_key = root / "private.pem"
            public_key = root / "public.pem"
            api_output = root / "promotion.generated.ts"
            release_output = root / "release.json"
            subprocess.run(
                ["openssl", "genpkey", "-algorithm", "Ed25519",
                 "-out", str(private_key)],
                check=True,
            )
            public_key.write_text(promote_modal.public_key(private_key))
            bundle = {
                "record": record,
                "signature": promote_modal.sign(record, private_key),
            }
            activate_promotion.activate(
                bundle,
                public_key.read_text(),
                evidence,
                container_refresh(evidence),
                health,
                api_output,
                release_output,
            )
            bundle_literal = (
                api_output.read_text().splitlines()[1].split(" = ", 1)[1][:-1]
            )
            self.assertEqual(
                json.loads(bundle_literal),
                promote_modal.canonical(bundle),
            )
            retained = json.loads(release_output.read_text())
            self.assertEqual(
                retained["smokeEvidence"]["result"]["beatCount"],
                4,
            )
            self.assertEqual(
                retained["containerRefresh"]["staleContainerIds"],
                [],
            )
            original_api = api_output.read_text()
            original_release = release_output.read_text()
            broken_health = {**health, "modalImageId": "im-Other"}
            with self.assertRaisesRegex(ValueError, "live health"):
                activate_promotion.activate(
                    bundle,
                    public_key.read_text(),
                    evidence,
                    container_refresh(evidence),
                    broken_health,
                    api_output,
                    release_output,
                )
            self.assertEqual(api_output.read_text(), original_api)
            self.assertEqual(release_output.read_text(), original_release)

    def test_resume_authenticates_every_retained_release_input(self):
        evidence = release_evidence()
        record = promotion_record(evidence)
        health = matching_health(record)
        refresh = container_refresh(evidence)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private_key = root / "private.pem"
            other_private_key = root / "other-private.pem"
            api_output = root / "promotion.generated.ts"
            release_output = root / "release.json"
            for key in (private_key, other_private_key):
                subprocess.run(
                    [
                        "openssl", "genpkey", "-algorithm", "Ed25519",
                        "-out", str(key),
                    ],
                    check=True,
                )
            public_key = promote_modal.public_key(private_key)
            bundle = {
                "record": record,
                "signature": promote_modal.sign(record, private_key),
            }
            activate_promotion.activate(
                bundle,
                public_key,
                evidence,
                refresh,
                health,
                api_output,
                release_output,
            )

            def verify(**changes):
                activate_promotion.verify_retained_activation(
                    changes.get("bundle", bundle),
                    changes.get("public_key", public_key),
                    changes.get("evidence", evidence),
                    changes.get("refresh", refresh),
                    changes.get("health", health),
                    changes.get("api_output", api_output),
                    changes.get("release_output", release_output),
                    changes.get("source_revision", record["sourceRevision"]),
                )

            verify()

            calls = []

            def closed_pr_run(command, **kwargs):
                calls.append(command)
                if command[1:3] == ["pr", "list"]:
                    self.assertNotIn("--base", command)
                    return subprocess.CompletedProcess(
                        command,
                        0,
                        stdout=json.dumps([{
                            "number": 2,
                            "state": "CLOSED",
                            "headRefOid": "c" * 40,
                            "baseRefName": "main",
                            "url": "https://github.com/example/repo/pull/2",
                        }]),
                        stderr="",
                    )
                if command[1:3] == ["pr", "reopen"]:
                    return subprocess.CompletedProcess(
                        command, 0, stdout="", stderr=""
                    )
                raise AssertionError(command)

            body = root / "proposal.md"
            body.write_text("retained release")
            self.assertEqual(
                resume_activation_pr.recover_proposal(
                    repository="example/repo",
                    base_branch="main",
                    head_branch="beat-this-activation/" + "b" * 40,
                    expected_head_oid="c" * 40,
                    title="retained activation",
                    body_file=body,
                    run=closed_pr_run,
                ),
                "https://github.com/example/repo/pull/2",
            )
            self.assertEqual(calls[-1][1:3], ["pr", "reopen"])
            self.assertFalse(
                any(call[1:3] == ["pr", "create"] for call in calls)
            )

            mismatch_calls = []

            def mismatched_base_run(command, **kwargs):
                mismatch_calls.append(command)
                if command[1:3] != ["pr", "list"]:
                    raise AssertionError(command)
                return subprocess.CompletedProcess(
                    command,
                    0,
                    stdout=json.dumps([{
                        "number": 2,
                        "state": "CLOSED",
                        "headRefOid": "c" * 40,
                        "baseRefName": "release/other",
                        "url": "https://github.com/example/repo/pull/2",
                    }]),
                    stderr="",
                )

            with self.assertRaisesRegex(ValueError, "identity changed"):
                resume_activation_pr.recover_proposal(
                    repository="example/repo",
                    base_branch="main",
                    head_branch="beat-this-activation/" + "b" * 40,
                    expected_head_oid="c" * 40,
                    title="retained activation",
                    body_file=body,
                    run=mismatched_base_run,
                )
            self.assertEqual(len(mismatch_calls), 1)

            altered_signature = copy.deepcopy(bundle)
            first = altered_signature["signature"][0]
            altered_signature["signature"] = (
                ("B" if first == "A" else "A")
                + altered_signature["signature"][1:]
            )
            with self.assertRaisesRegex(ValueError, "signature"):
                verify(bundle=altered_signature)

            with self.assertRaisesRegex(ValueError, "signature"):
                verify(
                    public_key=promote_modal.public_key(other_private_key)
                )

            altered_evidence = copy.deepcopy(evidence)
            altered_evidence["smokeEvidence"]["fixture"]["sha256"] = "f" * 64
            with self.assertRaisesRegex(ValueError, "release evidence"):
                verify(evidence=altered_evidence)

            altered_refresh = copy.deepcopy(refresh)
            altered_refresh["staleContainerIds"] = ["ta-Stale"]
            with self.assertRaisesRegex(ValueError, "container refresh"):
                verify(refresh=altered_refresh)

            altered_health = copy.deepcopy(health)
            altered_health["modalFunctionId"] = "fu-Altered"
            with self.assertRaisesRegex(ValueError, "live health"):
                verify(health=altered_health)

            original_generated = api_output.read_text()
            api_output.write_text(
                original_generated.replace(
                    record["modalAppId"], "ap-Altered", 1
                )
            )
            with self.assertRaisesRegex(ValueError, "generated bundle"):
                verify()
            api_output.write_text(original_generated)

            other_public_key = promote_modal.public_key(other_private_key)
            api_output.write_text(
                original_generated.replace(
                    json.dumps(public_key),
                    json.dumps(other_public_key),
                    1,
                )
            )
            with self.assertRaisesRegex(ValueError, "public key"):
                verify()
            api_output.write_text(original_generated)

            release_output.write_text(
                release_output.read_text().replace(
                    '"beatCount":4', '"beatCount":5'
                )
            )
            with self.assertRaisesRegex(ValueError, "release attestation"):
                verify()
            activate_promotion.activate(
                bundle,
                public_key,
                evidence,
                refresh,
                health,
                api_output,
                release_output,
            )

            with self.assertRaisesRegex(ValueError, "source revision"):
                verify(source_revision="a" * 40)

    def test_legacy_key_material_produces_verifiable_ed25519_signature(self):
        normalized, key_format = promote_modal.private_key_bytes(
            base64.b64encode(b"legacy-provider-key-material").decode()
        )
        evidence = release_evidence()
        record = promotion_record(evidence)
        with tempfile.TemporaryDirectory() as directory:
            key_path = Path(directory) / "private.der"
            key_path.write_bytes(normalized)
            signature = promote_modal.sign(record, key_path, key_format)
            public_key = promote_modal.public_key(key_path, key_format)
            activate_promotion.verify_signature(record, signature, public_key)


if __name__ == "__main__":
    unittest.main()