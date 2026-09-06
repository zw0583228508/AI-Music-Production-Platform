#!/usr/bin/env python3
"""Validate the authoritative installation matrix without treating code as proof."""
import hashlib
import base64
import json
import math
import re
import subprocess
import sys
import tempfile
from pathlib import Path

STATUSES = {"READY", "RESEARCH_READY", "BLOCKED_LICENSE", "BLOCKED_NO_WEIGHTS",
            "BLOCKED_UPSTREAM", "BLOCKED_MISSING_LICENSED_ASSET"}
LICENSES = {"COMMERCIAL", "RESEARCH_ONLY", "UNVERIFIED", "NOT_APPLICABLE"}
REQUIRED = ("provider", "category", "codeRepository", "codeRevision", "modelRepository",
            "modelRevision", "runtimeBuilt", "sourcePinned", "assetsDownloaded",
            "assetsChecksummed", "assetManifestCreated", "volumeProvisioned",
            "licenseStatus", "secretsConfigured", "realSmokePassed",
            "nonSilentOutputVerified", "endpointDeployed", "endpointConfigured",
            "healthReady", "promotionRequired", "promotionSigned", "apiConnected",
            "finalStatus", "blockers", "notes")
BOOLS = {x for x in REQUIRED if x not in {"provider", "category", "codeRepository",
    "codeRevision", "modelRepository", "modelRevision", "licenseStatus",
    "finalStatus", "blockers", "notes"}}
EXPECTED = {"ACE_STEP","BS_ROFORMER","DEMUCS","ALL_IN_ONE","BEAT_THIS","SONGFORMER",
 "SHEETSAGE","MADMOM","ESSENTIA","CHROMA","TORCHCREPE","BASIC_PITCH","PYLOUDNORM",
 "MT3","MR_MT3","YOUR_MT3","MOSS_MUSIC_INSTRUCT","MOSS_MUSIC_THINKING","LADA_BAND",
 "HAFM","ANYACCOMP","MIDI_SAG","MUSE_CONTROL_LITE","MUSICGEN_LARGE",
 "MUSICGEN_MELODY_LARGE","JASCO_CHORDS_DRUMS_MELODY","STABLE_AUDIO_3_SMALL_MUSIC",
 "STABLE_AUDIO_3_MEDIUM","DIFFRHYTHM_2","LEVO2_RESEARCH","SAM_AUDIO",
 "MAGENTA_RT2_SMALL","MAGENTA_RT2_BASE","REMI_Z","MUSIC2MUSIC","METEOR",
 "SYMPHONYGEN","MUQ","MUQ_MULAN","MUQ_EVAL","SONG_AESTHETICS","SONG_EVAL","CLAMP3",
 "PEDALBOARD","SFIZZ_VSCO2_CE","VST3_HOST","VST3_INSTRUMENT"}
MUTABLE = {"", "main", "master", "latest", "null"}

def canonical_sha256(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(encoded).hexdigest()

def mt3_note_evidence_valid(output):
    if not isinstance(output, dict):
        return False
    events = output.get("noteEvents")
    if (
        not isinstance(events, list)
        or not 1 <= len(events) <= 4096
        or output.get("notes") != len(events)
        or output.get("terminatedNotes") != len(events)
        or output.get("allNotesTerminated") is not True
        or output.get("noteEventsSha256") != canonical_sha256(events)
    ):
        return False
    previous = None
    for event in events:
        if not isinstance(event, dict):
            return False
        start, end = event.get("start"), event.get("end")
        pitch, velocity = event.get("pitch"), event.get("velocity")
        confidence = event.get("confidence")
        if (
            isinstance(start, bool) or not isinstance(start, (int, float))
            or isinstance(end, bool) or not isinstance(end, (int, float))
            or not math.isfinite(start) or not math.isfinite(end)
            or start < 0 or end <= start
            or isinstance(pitch, bool) or not isinstance(pitch, int)
            or not 0 <= pitch <= 127
            or isinstance(velocity, bool) or not isinstance(velocity, int)
            or not 1 <= velocity <= 127
            or isinstance(confidence, bool)
            or not isinstance(confidence, (int, float))
            or not math.isfinite(confidence) or not 0 <= confidence <= 1
        ):
            return False
        ordering = (start, end, pitch)
        if previous is not None and ordering < previous:
            return False
        previous = ordering
    return True

def ed25519_signature_valid(record, signature, public_key):
    try:
        decoded = base64.b64decode(signature, validate=True)
    except (ValueError, TypeError):
        return False
    if len(decoded) != 64:
        return False
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        message = root / "record.json"
        key = root / "public.pem"
        sig = root / "signature.bin"
        message.write_text(json.dumps(
            record, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        ))
        key.write_text(public_key)
        sig.write_bytes(decoded)
        result = subprocess.run(
            ["openssl", "pkeyutl", "-verify", "-rawin", "-pubin",
             "-inkey", str(key), "-in", str(message), "-sigfile", str(sig)],
            capture_output=True,
            check=False,
        )
    return result.returncode == 0

def effective(data):
    defaults = data.get("defaults", {})
    return [{**defaults, **row} for row in data.get("providers", [])]

ENDPOINT_KEYS = {
    "ACE_STEP": "ACE_STEP_API_URL", "ALL_IN_ONE": "ALL_IN_ONE_API_URL",
    "BS_ROFORMER": "MUSIC_PROVIDER_BS_ROFORMER_ENDPOINT",
    "BEAT_THIS": "MUSIC_PROVIDER_BEAT_THIS_URL", "MT3": "MT3_API_URL",
    "MR_MT3": "MR_MT3_API_URL", "YOUR_MT3": "YOUR_MT3_API_URL",
    "SHEETSAGE": "SHEETSAGE_API_URL",
    "DEMUCS": "DEMUCS_API_URL", "BASIC_PITCH": "BASIC_PITCH_API_URL",
    "MADMOM": "MADMOM_API_URL", "ESSENTIA": "ESSENTIA_API_URL",
    "CHROMA": "CHROMA_API_URL", "TORCHCREPE": "TORCHCREPE_API_URL",
    "PYLOUDNORM": "PYLOUDNORM_API_URL", "SONGFORMER": "SONGFORMER_API_URL",
}

def report_errors(rows, report_text):
    errors = []
    rows_by_name = {}
    for line in report_text.splitlines():
        if line.startswith("| ") and not line.startswith("| Provider") and not line.startswith("|---"):
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if len(cells) == 12:
                rows_by_name.setdefault(cells[0], []).append(cells[10])
    for row in rows:
        found = rows_by_name.get(row["provider"], [])
        if len(found) != 1:
            errors.append(f"{row['provider']}: report must contain exactly one row")
        elif found[0] != row["finalStatus"]:
            errors.append(f"{row['provider']}: report finalStatus {found[0]} differs from matrix {row['finalStatus']}")
    extra = set(rows_by_name) - {row["provider"] for row in rows}
    if extra:
        errors.append("report has unknown providers: " + ",".join(sorted(extra)))
    return errors

def evidence_errors(rows, root):
    by_name = {row["provider"]: row for row in rows}
    errors = []
    def read_json(relative):
        try:
            return json.loads((root / relative).read_text())
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"evidence missing or invalid: {relative}: {exc}")
            return {}
    ace = by_name.get("ACE_STEP", {})
    if (
        ace.get("finalStatus") == "READY"
        and ace.get("codeRevision") == "ca1e85fe9430179831e6bc6be790c332190a3866"
    ):
        base = Path("services/music-ai-gpu-worker/release-evidence/ace-step")
        status = read_json("services/music-ai-gpu-worker/installation-status.json")
        local = status.get("providers", {}).get("ACE_STEP", {}).get("evidence", {})
        manifest = read_json("services/music-ai-gpu-worker/model_manifest.json").get(
            "providers", {}
        ).get("ACE_STEP", {})
        release = read_json(base / "release-evidence.json")
        health = read_json(base / "live-health.json")
        observed = read_json(base / "observed-deployment.json")
        worker = read_json(base / "worker-identity.json")
        refresh = read_json(base / "identity-refresh.json")
        bundle = read_json(base / "promotion-bundle.json")
        license_evidence = read_json(base / "license-evidence.json")
        public_key_path = root / base / "promotion-public-key.pem"
        try:
            public_key = public_key_path.read_text()
            canonical_text = (
                root / "artifacts/api-server/src/lib/gpuPromotions.generated.ts"
            ).read_text()
            match = re.fullmatch(
                r"/\* Generated by the fail-closed generic Modal release workflow\. \*/\n"
                r"export const committedGpuPromotionsJson = (.+);\n",
                canonical_text,
            )
            canonical = json.loads(json.loads(match.group(1))) if match else {}
        except (OSError, json.JSONDecodeError):
            public_key, canonical = "", {}
        record = bundle.get("record", {})
        smoke = release.get("smokeEvidence", {})
        artifact = smoke.get("output", {}).get("artifact", {})
        retained_smoke = root / base / str(artifact.get("retainedEvidenceFile", ""))
        source_license = license_evidence.get("source", {})
        models = license_evidence.get("models", [])
        identity_fields = (
            "modalAppId", "modalDeploymentId", "modalFunctionId",
            "modalImageId", "sourceRevision", "sourceImageDigest",
            "checkpointSha256",
        )
        required = [
            manifest.get("checkpoint_sha256") == release.get("checkpointSha256"),
            manifest.get("source_license") == "MIT",
            manifest.get("model_license") == "MIT",
            manifest.get("commercial_use_permitted") is True,
            source_license.get("spdx") == "MIT",
            source_license.get("revision") == ace.get("codeRevision"),
            len(models) == 2 and all(
                model.get("spdx") == "MIT"
                and model.get("commercialUsePermitted") is True
                and re.fullmatch(r"[a-f0-9]{64}", model.get("evidenceSha256", ""))
                and (root / base / model.get("evidenceFile", "")).is_file()
                for model in models
            ),
            health.get("status") == "ready" and health.get("healthy") is True,
            health.get("smokeTested") is True,
            smoke.get("smokeTested") is True,
            artifact.get("format") == "wav",
            artifact.get("durationSeconds", 0) > 0,
            artifact.get("sampleRate", 0) > 0,
            artifact.get("channels", 0) > 0,
            artifact.get("bytes", 0) > 44,
            re.fullmatch(r"[a-f0-9]{64}", artifact.get("sha256", "")),
            artifact.get("peakAmplitude", 0) >= 1e-5,
            artifact.get("rmsAmplitude", 0) >= 1e-7,
            retained_smoke.is_file(),
            retained_smoke.stat().st_size == artifact.get("bytes")
            if retained_smoke.is_file() else False,
            hashlib.sha256(retained_smoke.read_bytes()).hexdigest() == artifact.get("sha256")
            if retained_smoke.is_file() else False,
            "@sha256:17e2934e1fa96152b14f78078bfbafd0f00f391df995dc6c641a720fce1202bb"
            in (root / "services/music-ai-gpu-worker/Dockerfile.ace-step").read_text(),
            "@sha256:90daa0b4d74ea55c7b8e06d25d3826b1eac66e7994387248e6173dd2b66668e2"
            in (root / "services/music-ai-gpu-worker/Dockerfile.ace-step").read_text(),
            all(release.get(field) == health.get(field) == record.get(field)
                for field in identity_fields),
            all(observed.get(field) == record.get(field)
                for field in ("modalAppId", "modalDeploymentId", "modalFunctionId")),
            worker.get("MUSIC_GPU_MODAL_APP_ID") == record.get("modalAppId"),
            worker.get("MUSIC_GPU_MODAL_DEPLOYMENT_ID") == record.get("modalDeploymentId"),
            worker.get("MUSIC_GPU_MODAL_FUNCTION_ID") == record.get("modalFunctionId"),
            refresh.get("staleContainerIds") == [],
            record.get("releaseEvidenceSha256") == canonical_sha256(release),
            ed25519_signature_valid(record, bundle.get("signature"), public_key),
            canonical.get("bundles", {}).get("ACE_STEP") == bundle,
            canonical.get("publicKey", "").strip() == public_key.strip(),
            local.get("promotionSignatureValidated") is True,
            local.get("apiAttestationValidated") is True,
            local.get("apiZeroPostMismatchRegression") is True,
            local.get("endpointOrigin") == record.get("endpointOrigin"),
        ]
        if not all(required):
            errors.append(
                "ACE_STEP: READY lacks exact license/checkpoint/live WAV/"
                "identity/signature/canonical API evidence"
            )
    bs_roformer = by_name.get("BS_ROFORMER", {})
    if bs_roformer.get("finalStatus") in {"READY", "BLOCKED_LICENSE"}:
        base = Path("services/music-ai-gpu-worker/release-evidence/bs-roformer")
        status = read_json("services/music-ai-gpu-worker/installation-status.json")
        local_provider = status.get("providers", {}).get("BS_ROFORMER", {})
        local = local_provider.get("evidence", {})
        manifest = read_json("services/music-ai-gpu-worker/model_manifest.json").get(
            "providers", {}
        ).get("BS_ROFORMER", {})
        release = read_json(base / "bs-roformer-release-evidence-v1.json")
        health = read_json(base / "bs-roformer-live-health-v1.json")
        observed = read_json(base / "observed-deployment.json")
        worker = read_json(base / "promotion-worker-identity-v1.json")
        refresh = read_json(base / "worker-refresh.json")
        bundle = read_json(base / "bs-roformer-promotion-v1.json")
        source_license = read_json(base / "source-license-evidence-v1.json")
        deployment_stop = read_json(base / "deployment-stopped-v1.json")
        try:
            public_key = (root / base / "promotion-public-key.pem").read_text()
            canonical_text = (
                root / "artifacts/api-server/src/lib/gpuPromotions.generated.ts"
            ).read_text()
            match = re.fullmatch(
                r"/\* Generated by the fail-closed generic Modal release workflow\. \*/\n"
                r"export const committedGpuPromotionsJson = (.+);\n",
                canonical_text,
            )
            canonical = json.loads(json.loads(match.group(1))) if match else {}
        except (OSError, json.JSONDecodeError):
            public_key, canonical = "", {}
        record = bundle.get("record", {})
        smoke = release.get("smokeEvidence", {})
        output = smoke.get("output", {})
        input_evidence = output.get("input", {})
        stems = output.get("stems", [])
        if not isinstance(stems, list):
            stems = []
        stems_by_role = {
            stem.get("stem"): stem for stem in stems if isinstance(stem, dict)
        }
        backend = source_license.get("backend", {})
        model = source_license.get("model", {})
        smoke_input = source_license.get("smokeInput", {})
        backend_license = root / base / str(backend.get("licenseFile", ""))
        model_license = root / base / str(model.get("licenseFile", ""))
        retained_input = root / str(smoke_input.get("repositoryPath", ""))
        try:
            dockerfile = (
                root / "services/music-ai-gpu-worker/Dockerfile.bs-roformer"
            ).read_text()
            requirements = (
                root
                / "services/music-ai-gpu-worker/runners/requirements-bs-roformer.txt"
            ).read_text()
            modal_app_source = (
                root / "services/music-ai-gpu-worker/modal_app.py"
            ).read_text()
            worker_app_source = (
                root / "services/music-ai-gpu-worker/app.py"
            ).read_text()
            bootstrap_source = (
                root / "services/music-ai-gpu-worker/checkpoint_bootstrap.py"
            ).read_text()
            catalog_source = (
                root / "artifacts/api-server/src/lib/musicProviders.ts"
            ).read_text()
            catalog_test_source = (
                root / "artifacts/api-server/tests/gpu-provider-attestation.test.mjs"
            ).read_text()
            dot_replit = (root / ".replit").read_text()
        except OSError:
            dockerfile = requirements = modal_app_source = worker_app_source = ""
            bootstrap_source = catalog_source = dot_replit = ""
            catalog_test_source = ""
        identity_fields = (
            "modalAppId", "modalDeploymentId", "modalFunctionId",
            "modalImageId", "sourceRevision", "sourceImageDigest",
            "checkpointSha256",
        )
        runtime_fields = {
            "python": ("runtime", "pythonVersion"),
            "cudaImage": ("framework", "cuda_image"),
            "cuda": ("framework", "cuda"),
            "pytorch": ("framework", "pytorch"),
            "torchvision": ("framework", "torchvision"),
            "torchaudio": ("framework", "torchaudio"),
            "torchIndexUrl": ("framework", "torch_index_url"),
            "transformers": ("framework", "transformers"),
            "accelerate": ("framework", "accelerate"),
        }
        expected_roles = {"vocals", "instrumental"}
        stem_hashes = {stem.get("sha256") for stem in stems}
        required = [
            manifest.get("model_version") == record.get("modelVersion"),
            manifest.get("checkpoint_sha256") == release.get("checkpointSha256"),
            manifest.get("config_sha256") == smoke.get("configSha256"),
            manifest.get("backend_revision") == backend.get("revision"),
            manifest.get("backend_package_artifact_sha256")
            == backend.get("wheelSha256")
            == smoke.get("backendPackageArtifactSha256"),
            manifest.get("backend_license") == "MIT",
            backend.get("gitTree") == "b0c7a8c6bfdd685afe6ef461fb0ebcded209d4b3",
            backend.get("licenseGitBlobOid")
            == "d21918f6309fadd4c1d1b43bae604fd313aa6630",
            backend.get("observedInstalledTreeSha256")
            == smoke.get("backendPackageTreeSha256"),
            model.get("revision") == "b1361b816daca507f079d85e935c291bcb0a5351",
            model.get("checkpointSha256") == manifest.get("checkpoint_sha256"),
            model.get("configSha256") == manifest.get("config_sha256"),
            backend.get("license") == "MIT",
            model.get("wrapperModelCardDeclaredLicense") == "MIT",
            model.get("readmeGitOid")
            == "c6a2867781b519834774c9769fa0ae46d04fcc9a",
            model.get("checkpointOrigin", {}).get("assetRepository")
            == "https://github.com/TRvlvr/model_repo",
            model.get("checkpointOrigin", {}).get("assetReleaseTag")
            == "all_public_uvr_models",
            model.get("checkpointOrigin", {}).get("assetFilename")
            == "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
            backend_license.is_file(),
            hashlib.sha256(backend_license.read_bytes()).hexdigest()
            == backend.get("licenseFileSha256")
            if backend_license.is_file() else False,
            model_license.is_file(),
            hashlib.sha256(model_license.read_bytes()).hexdigest()
            == model.get("licenseFileSha256")
            if model_license.is_file() else False,
            retained_input.is_file(),
            retained_input.stat().st_size == smoke_input.get("bytes")
            if retained_input.is_file() else False,
            hashlib.sha256(retained_input.read_bytes()).hexdigest()
            == smoke_input.get("sha256")
            if retained_input.is_file() else False,
            smoke_input.get("sha256")
            == manifest.get("smoke_input_sha256")
            == input_evidence.get("sha256"),
            smoke.get("device") == "cuda",
            smoke.get("gpu") == "NVIDIA L4",
            smoke.get("smokeTested") is True,
            health.get("status") == "ready" and health.get("healthy") is True,
            health.get("smokeTested") is True,
            output.get("stemCount") == 2,
            len(stems) == 2,
            set(stems_by_role) == expected_roles,
            output.get("allStemsNonSilent") is True,
            output.get("distinctStemSha256") is True,
            len(stem_hashes) == 2,
            input_evidence.get("sha256") not in stem_hashes,
            all(
                stem.get("format") == "wav"
                and stem.get("bytes", 0) > 44
                and stem.get("durationSeconds") == input_evidence.get("durationSeconds")
                and stem.get("channels") == input_evidence.get("channels")
                and stem.get("sampleRate") == input_evidence.get("sampleRate")
                and stem.get("peakAmplitude", 0) >= 1e-5
                and stem.get("rmsAmplitude", 0) >= 1e-7
                and re.fullmatch(r"[a-f0-9]{64}", stem.get("sha256", ""))
                for stem in stems
            ),
            manifest.get("runtime", {}).get("cuda_image", "").startswith(
                "nvidia/cuda@sha256:"
            ),
            "nvidia/cuda@sha256:2fcc4280646484290cc50dce5e65f388dd04352b07cbe89a635703bd1f9aedb6"
            in dockerfile,
            "46f3d5eb4b666a54adcb67524258c3cb6f96e185db97a3e1e1ef7efaea4e1848"
            in requirements,
            all(release.get(field) == health.get(field) == record.get(field)
                for field in identity_fields),
            all(
                record.get("runtime", {}).get(field)
                == health.get(section, {}).get(key)
                for field, (section, key) in runtime_fields.items()
            ),
            observed.get("endpointOrigin") == record.get("endpointOrigin")
            == "https://windot100--bs-roformer-isolated.modal.run",
            all(observed.get(field) == record.get(field)
                for field in ("modalAppId", "modalDeploymentId", "modalFunctionId")),
            worker.get("MUSIC_GPU_MODAL_APP_ID") == record.get("modalAppId"),
            worker.get("MUSIC_GPU_MODAL_DEPLOYMENT_ID")
            == record.get("modalDeploymentId"),
            worker.get("MUSIC_GPU_MODAL_FUNCTION_ID") == record.get("modalFunctionId"),
            refresh.get("provider") == "BS_ROFORMER",
            refresh.get("staleContainerIds") == [],
            record.get("releaseEvidenceSha256") == canonical_sha256(release),
            ed25519_signature_valid(record, bundle.get("signature"), public_key),
            canonical.get("publicKey", "").strip() == public_key.strip(),
            local.get("promotionSignatureValidated") is True,
            local.get("apiAttestationValidated") is True,
            local.get("apiZeroPostMismatchRegression") is True,
            local.get("allStemsNonSilent") is True,
            local.get("allStemsDistinctFromInputAndEachOther") is True,
            local.get("realGpuSmokeVocalsSha256")
            == stems_by_role.get("vocals", {}).get("sha256"),
            local.get("realGpuSmokeInstrumentalSha256")
            == stems_by_role.get("instrumental", {}).get("sha256"),
            local.get("endpointOrigin") == record.get("endpointOrigin"),
        ]
        if bs_roformer.get("finalStatus") == "BLOCKED_LICENSE":
            required.extend([
                local_provider.get("classification") == "BLOCKED_LICENSE",
                manifest.get("routing_status") == "BLOCKED_LICENSE",
                manifest.get("license") == "UNVERIFIED",
                manifest.get("license_status") == "UNVERIFIED",
                manifest.get("checkpoint_license") == "UNVERIFIED",
                manifest.get("wrapper_license") == "MIT",
                manifest.get("commercial_use_permitted") is False,
                model.get("checkpointLicenseStatus") == "UNVERIFIED",
                model.get("checkpointLicenseSpdx") is None,
                model.get("commercialUsePermitted") is False,
                model.get("checkpointOrigin", {}).get(
                    "explicitCheckpointLicenseGrantRetained"
                ) is False,
                local.get("checkpointLicenseStatus") == "UNVERIFIED",
                local.get("upstreamCheckpointOriginGrantRetained") is False,
                local.get("commercialUsePermitted") is False,
                local.get("checkpointBootstrapBlocked") is True,
                local.get("modalDeploymentBlocked") is True,
                local.get("workerLicenseGateEnforced") is True,
                local.get("apiRegistryLicenseGateEnforced") is True,
                local.get("endpointDeployed") is False,
                local.get("endpointConfigured") is False,
                local.get("apiConnected") is False,
                local.get("promotionActiveForRouting") is False,
                local.get("liveHealthStatus") == "stopped",
                local.get("deploymentStoppedAt") == deployment_stop.get("stoppedAt"),
                bs_roformer.get("endpointDeployed") is False,
                bs_roformer.get("endpointConfigured") is False,
                bs_roformer.get("healthReady") is False,
                bs_roformer.get("apiConnected") is False,
                deployment_stop.get("modalAppId") == record.get("modalAppId"),
                deployment_stop.get("modalAppState") == "stopped",
                deployment_stop.get("stoppedAt") == "2026-09-06T18:49:44Z",
                deployment_stop.get("historicalEndpointOrigin")
                == record.get("endpointOrigin"),
                deployment_stop.get("postStopEndpointHttpStatus") == 404,
                deployment_stop.get("postStopResponseBytes") == 34,
                deployment_stop.get("postStopResponseSha256")
                == "140b2f05397afc9e90c6c7e1143a13a78ab60ca5a035022e2fade1edacccc8a0",
                '"ACE_STEP,MT3,ALL_IN_ONE"' in modal_app_source,
                'LICENSE_BLOCKED_PROVIDERS = {"BS_ROFORMER"}'
                in modal_app_source,
                "release_providers & LICENSE_BLOCKED_PROVIDERS"
                in modal_app_source,
                '"BS_ROFORMER": (' in bootstrap_source,
                "_assert_provider_license_allows_execution(request.provider)"
                in worker_app_source,
                bool(re.search(
                    r'id: "BS_ROFORMER".*?status: "unavailable".*?'
                    r'license: "UNVERIFIED checkpoint rights"',
                    catalog_source,
                    re.DOTALL,
                )),
                'LICENSE_BLOCKED_PROVIDER_IDS = new Set<string>(["BS_ROFORMER"])'
                in catalog_source,
                "if (!providerRoutingAuthorized(providerId)) return undefined;"
                in catalog_source,
                'routingStatus: "BLOCKED_LICENSE"' in catalog_source,
                "providerRoutingAuthorized(provider.definition.id)"
                in catalog_source,
                "assertProviderCommercialUseAuthorized(request.requestedProvider)"
                in catalog_source,
                '"MUSIC_PROVIDER_GATEWAY_URL"' in catalog_test_source,
                '"MUSIC_PROVIDER_GATEWAY_TOKEN"' in catalog_test_source,
                "blockedProvider.generate({})" in catalog_test_source,
                "MUSIC_PROVIDER_BS_ROFORMER_" not in dot_replit,
                "MUSIC_GPU_PUBLIC_ORIGIN_BS_ROFORMER" not in dot_replit,
                "BS_ROFORMER" not in canonical.get("bundles", {}),
                bool(bs_roformer.get("blockers")),
            ])
        else:
            required.extend([
                local_provider.get("classification") == "READY",
                model.get("checkpointLicenseStatus") == "VERIFIED",
                isinstance(model.get("checkpointLicenseSpdx"), str),
                bool(model.get("checkpointLicenseSpdx")),
                model.get("commercialUsePermitted") is True,
                model.get("checkpointOrigin", {}).get(
                    "explicitCheckpointLicenseGrantRetained"
                ) is True,
                local.get("checkpointLicenseStatus") == "VERIFIED",
                local.get("upstreamCheckpointOriginGrantRetained") is True,
                local.get("commercialUsePermitted") is True,
                local.get("endpointConfigured") is True,
                local.get("apiConnected") is True,
                local.get("promotionActiveForRouting") is True,
                bs_roformer.get("endpointConfigured") is True,
                bs_roformer.get("apiConnected") is True,
                canonical.get("bundles", {}).get("BS_ROFORMER") == bundle,
            ])
        if not all(required):
            errors.append(
                "BS_ROFORMER: status lacks exact checkpoint-license state and "
                "source/checkpoint/config/real-stem/identity/signature/API evidence"
            )
    all_in_one = by_name.get("ALL_IN_ONE", {})
    if all_in_one.get("finalStatus") == "RESEARCH_READY":
        base = Path("services/music-ai-gpu-worker/release-evidence/all-in-one")
        status = read_json("services/music-ai-gpu-worker/installation-status.json")
        local = status.get("providers", {}).get("ALL_IN_ONE", {}).get("evidence", {})
        manifest = read_json("services/music-ai-gpu-worker/model_manifest.json").get(
            "providers", {}
        ).get("ALL_IN_ONE", {})
        release = read_json(base / "release-evidence.json")
        health = read_json(base / "live-health.json")
        observed = read_json(base / "observed-deployment.json")
        worker = read_json(base / "worker-identity.json")
        refresh = read_json(base / "identity-refresh.json")
        bundle = read_json(base / "promotion-bundle.json")
        inventory = read_json(base / "asset-inventory.json")
        license_evidence = read_json(base / "license-evidence.json")
        public_key_path = root / base / "promotion-public-key.pem"
        try:
            public_key = public_key_path.read_text()
            canonical_text = (
                root / "artifacts/api-server/src/lib/gpuPromotions.generated.ts"
            ).read_text()
            match = re.fullmatch(
                r"/\* Generated by the fail-closed generic Modal release workflow\. \*/\n"
                r"export const committedGpuPromotionsJson = (.+);\n",
                canonical_text,
            )
            canonical = json.loads(json.loads(match.group(1))) if match else {}
        except (OSError, json.JSONDecodeError):
            public_key, canonical = "", {}
        record = bundle.get("record", {})
        smoke = release.get("smokeEvidence", {})
        output = smoke.get("output", {})
        provenance = smoke.get("provenance", {})
        manifest_assets = [
            {key: asset.get(key) for key in (
                "kind", "path", "size", "sha256", "license", "repository", "revision"
            )}
            for asset in manifest.get("assets", [])
        ]
        source_evidence = license_evidence.get("sourceEvidence", {})
        identity_fields = (
            "modalAppId", "modalDeploymentId", "modalFunctionId",
            "modalImageId", "sourceRevision", "sourceImageDigest",
            "checkpointSha256",
        )
        evidence_files_valid = True
        for name, evidence in source_evidence.items():
            path = root / base / name
            evidence_files_valid = evidence_files_valid and path.is_file()
            if path.is_file():
                evidence_files_valid = (
                    evidence_files_valid
                    and hashlib.sha256(path.read_bytes()).hexdigest()
                    == evidence.get("sha256")
                )
        required = [
            manifest.get("checkpoint_sha256") == release.get("checkpointSha256"),
            len(manifest_assets) == 9,
            sum(asset.get("license") == "CC-BY-NC-SA-4.0"
                for asset in manifest_assets) == 8,
            sum(asset.get("license") == "MIT"
                for asset in manifest_assets) == 1,
            inventory.get("assetCount") == 9,
            inventory.get("assets") == manifest_assets,
            inventory.get("aggregateCheckpointSha256")
            == manifest.get("checkpoint_sha256"),
            license_evidence.get("licenseStatus") == "RESEARCH_ONLY",
            license_evidence.get("commercialUsePermitted") is False,
            license_evidence.get("harmonixFoldCount") == 8,
            license_evidence.get("harmonixFoldLicense") == "CC-BY-NC-SA-4.0",
            license_evidence.get("demucsAssetCount") == 1,
            license_evidence.get("demucsLicense") == "MIT",
            license_evidence.get("assetInventorySha256")
            == hashlib.sha256(
                (root / base / "asset-inventory.json").read_bytes()
            ).hexdigest(),
            evidence_files_valid,
            "@sha256:2fcc4280646484290cc50dce5e65f388dd04352b07cbe89a635703bd1f9aedb6"
            in (root / "services/music-ai-gpu-worker/Dockerfile.all-in-one").read_text(),
            "@sha256:90daa0b4d74ea55c7b8e06d25d3826b1eac66e7994387248e6173dd2b66668e2"
            in (root / "services/music-ai-gpu-worker/Dockerfile.all-in-one").read_text(),
            health.get("status") == "ready" and health.get("healthy") is True,
            health.get("smokeTested") is True,
            smoke.get("smokeTested") is True,
            output.get("bpm", 0) > 0,
            output.get("beats", 0) > 0,
            output.get("bars", 0) > 0,
            output.get("sections", 0) > 0,
            provenance.get("backend") == "all-in-one-infer",
            provenance.get("sourceRevision")
            == "openmirlab/all-in-one-infer@3c93b4ae389328544dd5955af7497030cb1bca3a",
            provenance.get("upstreamSourceRevision")
            == "mir-aidj/all-in-one@18e78903c0365147a2c5d4e5e57ebf88cb7d800e",
            all(release.get(field) == health.get(field) == record.get(field)
                for field in identity_fields),
            all(observed.get(field) == record.get(field)
                for field in ("modalAppId", "modalDeploymentId", "modalFunctionId")),
            worker.get("MUSIC_GPU_MODAL_APP_ID") == record.get("modalAppId"),
            worker.get("MUSIC_GPU_MODAL_DEPLOYMENT_ID") == record.get("modalDeploymentId"),
            worker.get("MUSIC_GPU_MODAL_FUNCTION_ID") == record.get("modalFunctionId"),
            refresh.get("staleContainerIds") == [],
            record.get("releaseEvidenceSha256") == canonical_sha256(release),
            ed25519_signature_valid(record, bundle.get("signature"), public_key),
            canonical.get("bundles", {}).get("ALL_IN_ONE") == bundle,
            canonical.get("publicKey", "").strip() == public_key.strip(),
            local.get("promotionSignatureValidated") is True,
            local.get("apiAttestationValidated") is True,
            local.get("apiZeroPostMismatchRegression") is True,
            local.get("commercialUsePermitted") is False,
            local.get("endpointOrigin") == record.get("endpointOrigin"),
        ]
        if not all(required):
            errors.append(
                "ALL_IN_ONE: RESEARCH_READY lacks exact nine-asset/license/live "
                "structure/identity/signature/canonical API evidence"
            )
    mt3 = by_name.get("MT3", {})
    if mt3.get("finalStatus") == "READY":
        base = Path("services/music-ai-gpu-worker/release-evidence/mt3")
        status = read_json("services/music-ai-gpu-worker/installation-status.json")
        local = status.get("providers", {}).get("MT3", {}).get("evidence", {})
        manifest = read_json("services/music-ai-gpu-worker/model_manifest.json").get(
            "providers", {}
        ).get("MT3", {})
        release = read_json(base / "release-evidence.json")
        health = read_json(base / "live-health.json")
        observed = read_json(base / "observed-deployment.json")
        worker = read_json(base / "worker-identity.json")
        refresh = read_json(base / "identity-refresh.json")
        bundle = read_json(base / "promotion-bundle.json")
        license_evidence = read_json(base / "license-evidence.json")
        checkpoint = read_json(base / "checkpoint-provenance.json")
        try:
            public_key = (root / base / "promotion-public-key.pem").read_text()
            canonical_text = (
                root / "artifacts/api-server/src/lib/gpuPromotions.generated.ts"
            ).read_text()
            match = re.fullmatch(
                r"/\* Generated by the fail-closed generic Modal release workflow\. \*/\n"
                r"export const committedGpuPromotionsJson = (.+);\n",
                canonical_text,
            )
            canonical = json.loads(json.loads(match.group(1))) if match else {}
        except (OSError, json.JSONDecodeError):
            public_key, canonical = "", {}
        record = bundle.get("record", {})
        smoke = release.get("smokeEvidence", {})
        output = smoke.get("output", {})
        provenance = smoke.get("provenance", {})
        conversion = checkpoint.get("conversion", {})
        negative = checkpoint.get("negativeControl", {})
        aggregate = checkpoint.get("aggregateCheckpoint", {})
        aggregate_files = aggregate.get("files", [])
        if not isinstance(aggregate_files, list):
            aggregate_files = []
        aggregate_by_path = {
            item.get("path"): item
            for item in aggregate_files
            if isinstance(item, dict)
        }
        identity_fields = (
            "modalAppId", "modalDeploymentId", "modalFunctionId",
            "modalImageId", "sourceRevision", "sourceImageDigest",
            "checkpointSha256",
        )
        required = [
            manifest.get("model_version") == "mt3-pytorch-multitrack",
            manifest.get("checkpoint_sha256") == release.get("checkpointSha256"),
            manifest.get("checkpoint_sha256") == aggregate.get("sha256"),
            manifest.get("checkpoint_asset_sha256")
            == aggregate_by_path.get("mt3.pth", {}).get("sha256"),
            manifest.get("checkpoint_config_sha256")
            == aggregate_by_path.get("config.json", {}).get("sha256"),
            manifest.get("checkpoint_license") == "Apache-2.0",
            manifest.get("upstream_license") == "Apache-2.0",
            conversion.get("mappedAssignmentCount") == 191,
            conversion.get("exactMappedAssignmentCount") == 191,
            conversion.get("allMappedAssignmentsExact") is True,
            conversion.get("maxAbsDelta") == 0,
            negative.get("mappedAssignmentCount") == 191,
            negative.get("exactMappedAssignmentCount") == 0,
            negative.get("allMappedAssignmentsExact") is False,
            license_evidence.get("classification") == "READY",
            license_evidence.get("commercialUsePermitted") is True,
            license_evidence.get("adapter", {}).get("licenseFile", {}).get("spdx")
            == "MIT",
            health.get("status") == "ready" and health.get("healthy") is True,
            health.get("smokeTested") is True,
            smoke.get("smokeTested") is True,
            smoke.get("device") == "cuda",
            output.get("notes", 0) > 0,
            mt3_note_evidence_valid(output),
            smoke.get("checkpointLicense") == "Apache-2.0",
            provenance.get("provider") == "MT3",
            provenance.get("modelVersion") == "mt3-pytorch-multitrack",
            provenance.get("checkpointSha256") == manifest.get("checkpoint_sha256"),
            all(release.get(field) == health.get(field) == record.get(field)
                for field in identity_fields),
            all(observed.get(field) == record.get(field)
                for field in ("modalAppId", "modalDeploymentId", "modalFunctionId")),
            observed.get("endpointOrigin") == record.get("endpointOrigin"),
            worker.get("MUSIC_GPU_MODAL_APP_ID") == record.get("modalAppId"),
            worker.get("MUSIC_GPU_MODAL_DEPLOYMENT_ID") == record.get("modalDeploymentId"),
            worker.get("MUSIC_GPU_MODAL_FUNCTION_ID") == record.get("modalFunctionId"),
            refresh.get("staleContainerIds") == [],
            refresh.get("provider") == "MT3",
            record.get("releaseEvidenceSha256") == canonical_sha256(release),
            ed25519_signature_valid(record, bundle.get("signature"), public_key),
            canonical.get("bundles", {}).get("MT3") == bundle,
            canonical.get("publicKey", "").strip() == public_key.strip(),
            local.get("promotionSignatureValidated") is True,
            local.get("apiAttestationValidated") is True,
            local.get("apiZeroPostMismatchRegression") is True,
            local.get("realGpuSmokeNoteCount") == output.get("notes"),
            local.get("retainedNoteEventsCount") == len(output.get("noteEvents", [])),
            local.get("retainedNoteEventsSha256") == output.get("noteEventsSha256"),
            local.get("allRetainedNotesTerminated")
            == output.get("allNotesTerminated"),
            local.get("endpointOrigin") == record.get("endpointOrigin"),
        ]
        if not all(required):
            errors.append(
                "MT3: READY lacks exact official-checkpoint conversion/license/live "
                "notes/identity/signature/canonical API evidence"
            )
    sheet = by_name.get("SHEETSAGE", {})
    if sheet.get("finalStatus") == "RESEARCH_READY":
        att = read_json("services/sheetsage-worker/release-attestation.json")
        smoke, health = att.get("signedPersistentSmokeProof", {}), att.get("liveHealth", {})
        required = [att.get("authorization", {}).get("explicitUserApproval") is True,
                    att.get("source", {}).get("repository") == "openmirlab/sheetsage-infer",
                    att.get("source", {}).get("revision") == sheet.get("modelRevision"),
                    bool(smoke.get("signature")), smoke.get("realInference") is True,
                    bool(att.get("smokeProofPersistence", {}).get("persistentLocation")),
                    health.get("healthy") is True, health.get("status") == "ready",
                    health.get("sourceRevision", "").endswith(sheet.get("modelRevision", "")),
                    smoke.get("assetManifestSha256") == health.get("checksum"),
                    att.get("realNodeAnalysisPath", {}).get("statuses") == ["ready"] * 3]
        if not all(required):
            errors.append("SHEETSAGE: RESEARCH_READY lacks attested approval/source/signed persistent smoke/live endpoint/API evidence")
    mr = by_name.get("MR_MT3", {})
    if mr.get("finalStatus") == "READY":
        status = read_json("services/music-ai-gpu-worker/installation-status.json")
        evidence = status.get("providers", {}).get("MR_MT3", {}).get("evidence", {})
        if not (mr.get("modelRevision") == "539c08b0fe551076db6108a5f5b2a57d774881ed"
                and evidence.get("observedCheckpointSha256") == "b8a3807ed265059abd25ad7f68142c06c35e8f6144dcaa45bd55946a3745398f"
                and evidence.get("realCudaSmokeNoteCount") == 63
                and evidence.get("signedPromotionRecordPresent") is True
                and evidence.get("promotionSignatureValidated") is True
                and evidence.get("endpointConfigured") is True
                and evidence.get("liveHealthStatus") == "ready"):
            errors.append("MR_MT3: READY lacks exact revision/SHA/63-note CUDA smoke/promotion/endpoint-health evidence")
    your = by_name.get("YOUR_MT3", {})
    if your.get("finalStatus") == "READY":
        base = Path("services/music-ai-gpu-worker/release-evidence/your-mt3")
        status = read_json("services/music-ai-gpu-worker/installation-status.json")
        local = status.get("providers", {}).get("YOUR_MT3", {}).get("evidence", {})
        manifest = read_json("services/music-ai-gpu-worker/model_manifest.json").get(
            "providers", {}
        ).get("YOUR_MT3", {})
        release = read_json(base / "release-evidence.json")
        health = read_json(base / "live-health.json")
        observed = read_json(base / "observed-deployment.json")
        worker = read_json(base / "worker-identity.json")
        refresh = read_json(base / "identity-refresh.json")
        bundle = read_json(base / "promotion-bundle.json")
        license_evidence = read_json(base / "license-evidence.json")
        checkpoint = read_json(base / "checkpoint-provenance.json")
        try:
            public_key = (root / base / "promotion-public-key.pem").read_text()
            canonical_text = (
                root / "artifacts/api-server/src/lib/gpuPromotions.generated.ts"
            ).read_text()
            match = re.fullmatch(
                r"/\* Generated by the fail-closed generic Modal release workflow\. \*/\n"
                r"export const committedGpuPromotionsJson = (.+);\n",
                canonical_text,
            )
            canonical = json.loads(json.loads(match.group(1))) if match else {}
        except (OSError, json.JSONDecodeError):
            public_key, canonical = "", {}
        record = bundle.get("record", {})
        smoke = release.get("smokeEvidence", {})
        output = smoke.get("output", {})
        provenance = smoke.get("provenance", {})
        checkpoint_asset = checkpoint.get("checkpoint", {})
        space_reference = checkpoint.get("spaceReference", {})
        identity_fields = (
            "modalAppId", "modalDeploymentId", "modalFunctionId",
            "modalImageId", "sourceRevision", "sourceImageDigest",
            "checkpointSha256",
        )
        required = [
            manifest.get("model_version") == "your-mt3",
            manifest.get("checkpoint_sha256") == release.get("checkpointSha256"),
            manifest.get("revision") == record.get("checkpointRevision"),
            manifest.get("adapter_revision")
            == "openmirlab/mt3-infer@280a95817a67da0ae46987ddbb18c946963afffe",
            manifest.get("adapter_patch_sha256")
            == provenance.get("compatibilityPatchSha256"),
            manifest.get("smoke_input_sha256")
            == "d32d6565800021f93f7904cf576c696c0f5d0f45bb8dc7b1badd0dc53cab69b7",
            checkpoint_asset.get("repository") == "mimbres/YourMT3",
            checkpoint_asset.get("revision")
            == "e45ebd70398682d54b7bb1901a5216e18f3b1824",
            checkpoint_asset.get("sizeBytes") == 561544628,
            checkpoint_asset.get("sha256") == manifest.get("checkpoint_sha256"),
            checkpoint_asset.get("lfsOidSha256") == manifest.get("checkpoint_sha256"),
            space_reference.get("revision")
            == "5e66c1ea173a8186e0d20432b841d3180cc015b5",
            space_reference.get("lfsOidSha256") == manifest.get("checkpoint_sha256"),
            checkpoint.get("verification", {}).get(
                "immutableModelAndSpaceReferencesAgree"
            ) is True,
            license_evidence.get("classification") == "READY",
            license_evidence.get("commercialUsePermitted") is True,
            license_evidence.get("checkpoint", {}).get(
                "licenseFile", {}
            ).get("spdx") == "Apache-2.0",
            license_evidence.get("adapter", {}).get(
                "licenseFile", {}
            ).get("spdx") == "MIT",
            health.get("status") == "ready" and health.get("healthy") is True,
            health.get("smokeTested") is True,
            smoke.get("smokeTested") is True,
            smoke.get("device") == "cuda",
            smoke.get("checkpointLicense") == "Apache-2.0",
            output.get("notes") == 25,
            mt3_note_evidence_valid(output),
            provenance.get("provider") == "YOUR_MT3",
            provenance.get("modelVersion") == "your-mt3",
            provenance.get("checkpointSha256") == manifest.get("checkpoint_sha256"),
            provenance.get("revision") == manifest.get("revision"),
            provenance.get("sourceRevision") == manifest.get("adapter_revision"),
            provenance.get("upstreamSourceRevision")
            == "huggingface.co/spaces/mimbres/YourMT3@5e66c1ea173a8186e0d20432b841d3180cc015b5",
            provenance.get("conversionSourceRevision")
            == "not-applicable-native-yourmt3-checkpoint",
            provenance.get("sourcePatch", "").startswith(
                "no-behavioral-patch;transformers==4.45.1;"
            ),
            all(release.get(field) == health.get(field) == record.get(field)
                for field in identity_fields),
            all(observed.get(field) == record.get(field)
                for field in ("modalAppId", "modalDeploymentId", "modalFunctionId")),
            observed.get("endpointOrigin") == record.get("endpointOrigin"),
            worker.get("MUSIC_GPU_MODAL_APP_ID") == record.get("modalAppId"),
            worker.get("MUSIC_GPU_MODAL_DEPLOYMENT_ID")
            == record.get("modalDeploymentId"),
            worker.get("MUSIC_GPU_MODAL_FUNCTION_ID")
            == record.get("modalFunctionId"),
            refresh.get("provider") == "YOUR_MT3",
            refresh.get("staleContainerIds") == [],
            record.get("releaseEvidenceSha256") == canonical_sha256(release),
            ed25519_signature_valid(record, bundle.get("signature"), public_key),
            canonical.get("bundles", {}).get("YOUR_MT3") == bundle,
            canonical.get("publicKey", "").strip() == public_key.strip(),
            local.get("promotionSignatureValidated") is True,
            local.get("apiAttestationValidated") is True,
            local.get("apiZeroPostMismatchRegression") is True,
            local.get("realGpuSmokeNoteCount") == output.get("notes"),
            local.get("retainedNoteEventsCount") == len(output.get("noteEvents", [])),
            local.get("retainedNoteEventsSha256") == output.get("noteEventsSha256"),
            local.get("allRetainedNotesTerminated")
            == output.get("allNotesTerminated"),
            local.get("endpointOrigin") == record.get("endpointOrigin"),
        ]
        if not all(required):
            errors.append(
                "YOUR_MT3: READY lacks exact immutable checkpoint/license/live "
                "25-note identity/signature/canonical API evidence"
            )
    beat = by_name.get("BEAT_THIS", {})
    if beat.get("finalStatus") == "READY":
        status = read_json("services/beat-this-worker/installation-status.json")
        evidence = status.get("providers", {}).get("BEAT_THIS", {}).get("evidence", {})
        smoke = evidence.get("realSmoke", {})
        required = [
            evidence.get("codeRevision") == beat.get("codeRevision"),
            evidence.get("modelRevision") == beat.get("modelRevision"),
            evidence.get("checkpointSha256") == "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331",
            evidence.get("liveHealthStatus") == "ready",
            evidence.get("signedPromotionRecordPresent") is True,
            evidence.get("promotionSignatureValidated") is True,
            evidence.get("apiAttestationValidated") is True,
            evidence.get("endpointConfigured") is True,
            smoke.get("beatCount", 0) > 1,
            smoke.get("downbeatCount", 0) > 0,
            bool(smoke.get("firstBeats")),
            bool(smoke.get("firstDownbeats")),
        ]
        if not all(required):
            errors.append("BEAT_THIS: READY lacks exact live identity, signed promotion, API attestation, or non-empty beat/downbeat smoke evidence")
    demucs = by_name.get("DEMUCS", {})
    if demucs.get("finalStatus") == "READY":
        att = read_json("services/music-ai-worker/demucs-release-attestation.json")
        manifest = read_json("services/music-ai-worker/model_manifest.json").get("demucs", {})
        source = att.get("source", {})
        license_evidence = att.get("license", {})
        model = att.get("model", {})
        smoke = att.get("realAudioSmoke", {})
        outputs = smoke.get("outputs", {})
        health = att.get("liveHealth", {})
        api_path = att.get("apiPath", {})
        required = [
            source.get("repository") == demucs.get("codeRepository"),
            source.get("revision") == demucs.get("codeRevision"),
            source.get("packageArtifactSha256") == manifest.get("package_artifact_sha256"),
            source.get("installedPackageTreeSha256") == manifest.get("package_tree_sha256"),
            source.get("sourceBinding", {}).get("comparedFileCount") == 37,
            source.get("sourceBinding", {}).get("differentFileCount") == 0,
            manifest.get("source_repository") == demucs.get("codeRepository"),
            manifest.get("source_revision") == demucs.get("codeRevision"),
            license_evidence.get("spdx") == "MIT",
            license_evidence.get("sha256") == manifest.get("license_sha256"),
            model.get("checkpointSha256") == demucs.get("modelRevision", "").removeprefix("sha256:"),
            model.get("checkpointSha256") == manifest.get("checkpoint_sha256"),
            smoke.get("realInference") is True,
            smoke.get("fixtureRetained") is False,
            smoke.get("stemsDistinct") is True,
            smoke.get("durationPlausible") is True,
            outputs.get("vocals", {}).get("nonSilent") is True,
            outputs.get("instrumental", {}).get("nonSilent") is True,
            outputs.get("vocals", {}).get("finite") is True,
            outputs.get("instrumental", {}).get("finite") is True,
            health.get("authenticated") is True,
            health.get("healthy") is True,
            health.get("checkpointSha256") == model.get("checkpointSha256"),
            health.get("packageArtifactSha256") == manifest.get("package_artifact_sha256"),
            health.get("packageTreeSha256") == manifest.get("package_tree_sha256"),
            api_path.get("endpointConfigured") is True,
            api_path.get("healthAttestationRequiredBeforeSourceTransfer") is True,
            api_path.get("sourceRevisionAndLicenseAttested") is True,
            api_path.get("separationResponseValidated") is True,
        ]
        if not all(required):
            errors.append("DEMUCS: READY lacks exact source/license/checkpoint, real-song separation, live health, or API-path evidence")
    basic_pitch = by_name.get("BASIC_PITCH", {})
    if basic_pitch.get("finalStatus") == "READY":
        att = read_json("services/music-ai-worker/basic-pitch-release-attestation.json")
        manifest = read_json("services/music-ai-worker/model_manifest.json").get("basic_pitch", {})
        source = att.get("source", {})
        license_evidence = att.get("license", {})
        model = att.get("model", {})
        runtime = att.get("runtime", {})
        smoke = att.get("realAudioSmoke", {})
        health = att.get("liveHealth", {})
        api_path = att.get("apiPath", {})
        required = [
            source.get("repository") == basic_pitch.get("codeRepository"),
            source.get("revision") == basic_pitch.get("codeRevision"),
            source.get("packageArtifactSha256") == manifest.get("package_artifact_sha256"),
            source.get("installedPackageTreeSha256") == manifest.get("package_tree_sha256"),
            source.get("sourceBinding", {}).get("comparedFileCount") == 36,
            source.get("sourceBinding", {}).get("differentFileCount") == 0,
            manifest.get("source_repository") == basic_pitch.get("codeRepository"),
            manifest.get("source_revision") == basic_pitch.get("codeRevision"),
            license_evidence.get("spdx") == "Apache-2.0",
            license_evidence.get("sha256") == manifest.get("license_sha256"),
            license_evidence.get("noticeSha256") == manifest.get("notice_sha256"),
            license_evidence.get("commercialUsePermitted") is True,
            model.get("checkpointKind") == manifest.get("checkpoint_kind"),
            model.get("checkpointTreeSha256") == manifest.get("checkpoint_tree_sha256"),
            model.get("checkpointTreeSha256") == basic_pitch.get("modelRevision", "").removeprefix("sha256:"),
            model.get("requestTimeDownloads") is False,
            runtime.get("inferenceBackend") == manifest.get("inference_backend"),
            runtime.get("packages") == manifest.get("runtime_packages"),
            smoke.get("realInference") is True,
            smoke.get("fixtureDerivativeRetained") is False,
            smoke.get("midiRetained") is False,
            smoke.get("finiteModelOutputs") is True,
            smoke.get("midiNoteCount", 0) > 0,
            smoke.get("eventCount") == smoke.get("midiNoteCount"),
            smoke.get("allNotesTerminated") is True,
            smoke.get("distinctPitchCount", 0) > 1,
            bool(smoke.get("normalizedNotesSha256")),
            bool(smoke.get("midiSha256")),
            health.get("authenticated") is True,
            health.get("healthy") is True,
            health.get("packageReady") is True,
            health.get("checkpointReady") is True,
            health.get("checkpointTreeSha256") == model.get("checkpointTreeSha256"),
            health.get("packageArtifactSha256") == manifest.get("package_artifact_sha256"),
            health.get("packageTreeSha256") == manifest.get("package_tree_sha256"),
            health.get("sourceRevision") == manifest.get("source_revision"),
            health.get("licenseSha256") == manifest.get("license_sha256"),
            health.get("inferenceBackend") == manifest.get("inference_backend"),
            api_path.get("endpointConfigured") is True,
            api_path.get("healthAttestationRequiredBeforeSourceTransfer") is True,
            api_path.get("sourceLicensePackageRuntimeAndCheckpointAttested") is True,
            api_path.get("terminatedNoteResponseValidated") is True,
            api_path.get("identityDriftBlocksSourceTransfer") is True,
        ]
        if not all(required):
            errors.append("BASIC_PITCH: READY lacks exact source/license/package/runtime/checkpoint, real-note, live-health, or API-path evidence")
    mir_names = ("MADMOM", "ESSENTIA", "CHROMA", "TORCHCREPE", "PYLOUDNORM")
    if any(by_name.get(name, {}).get("finalStatus") in {"READY", "RESEARCH_READY"} for name in mir_names):
        att = read_json("services/music-mir-worker/release-attestation.json")
        status = read_json("services/music-mir-worker/installation-status.json")
        manifest = read_json("services/music-mir-worker/assets_manifest.json")
        attestation_path = root / "services/music-mir-worker/release-attestation.json"
        api_manifest_path = root / "artifacts/api-server/src/lib/analysisProviderManifest.ts"
        try:
            attestation_sha256 = hashlib.sha256(attestation_path.read_bytes()).hexdigest()
        except OSError:
            attestation_sha256 = ""
        try:
            api_manifest_text = api_manifest_path.read_text(encoding="utf-8")
        except OSError:
            api_manifest_text = ""
        release = att.get("release", {})
        fixtures = att.get("fixtures", {})
        endpoint_security = att.get("endpointSecurity", {})
        api_path = att.get("apiPath", {})
        release_runtimes = release.get("runtimes", {})
        py311_release = release_runtimes.get("python311", {})
        py314_release = release_runtimes.get("python314", {})
        common_required = [
            manifest.get("schemaVersion") == 2,
            release.get("deploymentVersion") == "v5",
            release.get("modalAppId") == "ap-gRyb2A2JLpBCcqnOci0vH5",
            release.get("workerSourceTreeSha256") == "a148ba1e1732a065e5e2343306273d77e28403ae39bd213900861978d038a7aa",
            '"a148ba1e1732a065e5e2343306273d77e28403ae39bd213900861978d038a7aa"' in api_manifest_text,
            '"210354042a315551890099c011b375f2ad7df7b5261f9527a16b5176cf2ec2ff"' in api_manifest_text,
            '"e209910f7ef96fa768ebd08e2a7101baaf122c9b7b833707d49604721b3d3d1f"' in api_manifest_text,
            py311_release.get("imageId") == "im-W2IC7LC7g7dAgXCxihVcDK",
            py311_release.get("baseImageId") == "im-PzM32shzFGelHvRygKPzz7",
            py311_release.get("baseImageDigest") == "sha256:081075da77b2b55c23c088251026fb69a7b2bf92471e491ff5fd75c192fd38e5",
            py311_release.get("uvImageDigest") == "sha256:5713fa8217f92b80223bc83aac7db36ec80a84437dbc0d04bbc659cae030d8c9",
            py311_release.get("requirementsLockSha256") == "210354042a315551890099c011b375f2ad7df7b5261f9527a16b5176cf2ec2ff",
            py314_release.get("imageId") == "im-QPBrqDiJhVewL4ITvJ6TGQ",
            py314_release.get("baseImageId") == "im-8ySCtlMjRWG33rr1YFEgqW",
            py314_release.get("baseImageDigest") == "sha256:d13fa0424035d290decef3d575cea23d1b7d5952cdf429df8f5542c71e961576",
            py314_release.get("uvImageDigest") == "sha256:5713fa8217f92b80223bc83aac7db36ec80a84437dbc0d04bbc659cae030d8c9",
            py314_release.get("requirementsLockSha256") == "e209910f7ef96fa768ebd08e2a7101baaf122c9b7b833707d49604721b3d3d1f",
            fixtures.get("source", {}).get("retained") is True,
            fixtures.get("source", {}).get("sha256") == "c4ca79a144bbfd2dcc868710d92de28e0129c8f1a1b8a957b9f8a59e5098e0b0",
            fixtures.get("evaluationDerivative", {}).get("retained") is False,
            fixtures.get("evaluationDerivative", {}).get("sha256") == "9c5c2715978ccbe3cc8b90738d9d110346ff26f1f2797ab32dba51a8f666dd52",
            endpoint_security.get("unauthenticatedHealthStatus") == {"python311": 401, "python314": 401},
            api_path.get("exactHealthAttestationRequiredBeforeSourceTransfer") is True,
            api_path.get("successfulMirHealthCachingPermitted") is False,
            api_path.get("mirHealthReattestedBeforeEverySourceBearingPost") is True,
            api_path.get("sourcePackageRuntimeModelWorkerAndSmokeDriftRejected") is True,
            api_path.get("zeroSourceOrAnalyzeTransferOnAttestationFailure") is True,
            att.get("policy", {}).get("promotionRequired") is False,
            att.get("policy", {}).get("manualReadinessOverridePermitted") is False,
            status.get("releaseAttestation", {}).get("sha256") == attestation_sha256,
        ]
        if not all(common_required):
            errors.append("MIR stack: release lacks exact deployment, fixture, endpoint-security, API-path, policy, or retained-attestation integrity evidence")
        for name in mir_names:
            row = by_name.get(name, {})
            if row.get("finalStatus") not in {"READY", "RESEARCH_READY"}:
                continue
            provider_att = att.get("providers", {}).get(name, {})
            provider_status = status.get("providers", {}).get(name, {})
            provider_status_evidence = provider_status.get("evidence", {})
            provider_manifest = manifest.get("providers", {}).get(name, {})
            wheels = [
                {"filename": item.get("filename"), "sha256": item.get("sha256")}
                for item in provider_manifest.get("packageArtifacts", [])
                if item.get("kind") == "wheel"
            ]
            expected_package_sha = (
                wheels[0].get("sha256") if len(wheels) == 1 else canonical_sha256(wheels)
            )
            trees = provider_manifest.get("installedPackageTrees", {})
            expected_tree_sha = (
                next(iter(trees.values())).get("sha256")
                if len(trees) == 1 else canonical_sha256(trees)
            )
            model_artifacts = provider_manifest.get("model", {}).get("artifacts", [])
            model_revision = provider_manifest.get("model", {}).get("revision", "")
            expected_model_sha = (
                model_revision.removeprefix("sha256:")
                if not model_artifacts and model_revision.startswith("sha256:")
                else canonical_sha256(model_artifacts)
            )
            source = provider_att.get("source", {})
            license_evidence = provider_att.get("license", {})
            model = provider_att.get("model", {})
            runtime = provider_att.get("runtime", {})
            smoke = provider_att.get("realAudioSmoke", {})
            health = provider_att.get("liveHealth", {})
            expected_runtime_lock = provider_manifest.get("runtime", {}).get("requirementsLockSha256")
            api_block_match = re.search(
                rf"^\s{{2}}{re.escape(name)}: \{{(?P<body>.*?)^\s{{2}}\}},",
                api_manifest_text,
                flags=re.MULTILINE | re.DOTALL,
            )
            api_block = api_block_match.group("body") if api_block_match else ""
            runtime_lock_symbol = (
                "MIR_REQUIREMENTS_LOCK_PY311"
                if provider_manifest.get("runtime", {}).get("python") == "3.11.11"
                else "MIR_REQUIREMENTS_LOCK_PY314"
            )
            api_identity_required = [
                f'checksum: "{health.get("identityChecksum", "")}"',
                f'sourceRepository: "{source.get("repository", "")}"',
                f'sourceRevision: "{source.get("revision", "")}"',
                f'packageArtifactSha256: "{expected_package_sha}"',
                f'packageTreeSha256: "{expected_tree_sha}"',
                f'pythonVersion: "{runtime.get("python", "")}"',
                f"requirementsLockSha256: {runtime_lock_symbol}",
                f'modelRepository: "{model.get("repository", "")}"',
                f'modelRevision: "{model.get("revision", "")}"',
                f'modelArtifactsSha256: "{expected_model_sha}"',
                f'smokeEvidenceSha256: "{smoke.get("smokeEvidenceSha256", "")}"',
                f'resultSha256: "{smoke.get("resultSha256", "")}"',
            ]
            required = [
                provider_att.get("classification") == row.get("finalStatus"),
                provider_status.get("classification") == row.get("finalStatus"),
                provider_status_evidence.get("deploymentVersion") == release.get("deploymentVersion"),
                provider_manifest.get("sourceRepository") == row.get("codeRepository"),
                provider_manifest.get("sourceRevision") == row.get("codeRevision"),
                provider_manifest.get("model", {}).get("repository") == row.get("modelRepository"),
                model_revision == row.get("modelRevision"),
                source.get("repository") == provider_manifest.get("sourceRepository"),
                source.get("revision") == provider_manifest.get("sourceRevision"),
                source.get("packageArtifactSha256") == expected_package_sha,
                source.get("installedPackageTreeSha256") == expected_tree_sha,
                runtime.get("python") == provider_manifest.get("runtime", {}).get("python"),
                runtime.get("packages") == provider_manifest.get("runtime", {}).get("packages"),
                runtime.get("requirementsLockSha256") == expected_runtime_lock,
                provider_status_evidence.get("requirementsLockSha256") == expected_runtime_lock,
                license_evidence.get("classification") == provider_manifest.get("license", {}).get("classification"),
                license_evidence.get("sha256") == provider_manifest.get("license", {}).get("codeLicenseSha256"),
                license_evidence.get("commercialUse") == provider_manifest.get("license", {}).get("commercialUse"),
                model.get("repository") == provider_manifest.get("model", {}).get("repository"),
                model.get("revision") == model_revision,
                model.get("artifactsSha256") == expected_model_sha,
                provider_manifest.get("workerSourceTreeSha256") == release.get("workerSourceTreeSha256"),
                provider_manifest.get("promotionRequired") is False,
                smoke.get("realInference") is True,
                smoke.get("featureExecutionSucceeded") is True,
                bool(re.fullmatch(r"[a-f0-9]{64}", smoke.get("smokeEvidenceSha256", ""))),
                bool(re.fullmatch(r"[a-f0-9]{64}", smoke.get("resultSha256", ""))),
                provider_status_evidence.get("smokeEvidenceSha256") == smoke.get("smokeEvidenceSha256"),
                health.get("authenticated") is True,
                health.get("status") == "ready",
                health.get("ready") is True,
                health.get("allReadinessFieldsTrue") is True,
                health.get("workerSourceTreeSha256") == release.get("workerSourceTreeSha256"),
                health.get("requirementsLockSha256") == expected_runtime_lock,
                health.get("smokeEvidenceSha256") == smoke.get("smokeEvidenceSha256"),
                health.get("resultSha256") == smoke.get("resultSha256"),
                provider_status_evidence.get("identityChecksum") == health.get("identityChecksum"),
                bool(re.fullmatch(r"[a-f0-9]{64}", health.get("identityChecksum", ""))),
                all(item in api_block for item in api_identity_required),
            ]
            if not all(required):
                errors.append(f"{name}: ready classification lacks exact manifest/source/license/package/runtime/model/smoke/live-health evidence")
    songformer = by_name.get("SONGFORMER", {})
    if (
        songformer
        and songformer.get("codeRevision")
        == "139b2aa3b14bd1c6d961d0994e9fc975f1ef7fd5"
    ):
        manifest = read_json("services/songformer-worker/model_manifest.json")
        license_manifest = read_json("services/songformer-worker/license_manifest.json")
        local_status = read_json("services/songformer-worker/installation-status.json")
        review = read_json(
            "services/songformer-worker/release-evidence/license-review-v1.json"
        )
        stop_observation = read_json(
            "services/songformer-worker/release-evidence/modal-app-stopped-v1.json"
        )
        try:
            bootstrap_source = (
                root / "services/songformer-worker/bootstrap_assets.py"
            ).read_text()
            modal_source = (
                root / "services/songformer-worker/modal_app.py"
            ).read_text()
            worker_source = (
                root / "services/songformer-worker/app.py"
            ).read_text()
            replit_source = (root / ".replit").read_text()
        except OSError as exc:
            errors.append(f"SONGFORMER: blocked boundary source missing: {exc}")
            bootstrap_source = modal_source = worker_source = replit_source = ""
        assets = manifest.get("assets", [])
        local = local_status.get("providers", {}).get("SONGFORMER", {})
        evidence = local.get("evidence", {})
        components = license_manifest.get("components", {})
        gate = manifest.get("licenseGate", {})
        deployment = review.get("deployment", {})
        expected_assets = {
            (
                "SONGFORMER", "ASLP-lab/SongFormer",
                "a75880ed1b7375ac71860ec6c4fc9c899cf99515",
                "SongFormer.safetensors", 104468437,
                "87f17bfbed37014c6af4314abd9eb6971a94e3a95e9fc70f9e5ee33bdacb487b",
                "5a24800e12ab357744f8b47e523ba3e6", False,
            ),
            (
                "SONGFORMER", "ASLP-lab/SongFormer",
                "a75880ed1b7375ac71860ec6c4fc9c899cf99515",
                "SongFormer.pt", 104493286,
                "25d749cc9a51dc0a999ea61c5c7ff42df7ed8ba95295a0530a82430f9483c14c",
                "2c66c0bb91364e318e90dbc2d9a79ee2", False,
            ),
            (
                "MUSICFM", "minzwon/MusicFM",
                "4513b38bc25ad1d227b1980819b9691ba97f4d87",
                "pretrained_msd.pt", 1316802088,
                "218b483a0256ddef736267425fabb166fd97008983696bb9270def464b47bded",
                "df930aceac8209818556c4a656a0714c", False,
            ),
            (
                "MUSICFM", "minzwon/MusicFM",
                "4513b38bc25ad1d227b1980819b9691ba97f4d87",
                "msd_stats.json", 2277,
                "c36c61ab10ca4d2e7fdfefc3fcc15205316bec276a06a47baa3641a62c546f22",
                "75ab2e47b093e07378f7f703bdb82c14", False,
            ),
            (
                "MUQ", "OpenMuQ/MuQ-large-msd-iter",
                "0562a57814f6f8bbd9fdea0a25921a2fce1a841a",
                "model.safetensors", 1333825096,
                "273febab2be02872c37d2c37e48a9d6c52c1c9392f3eeeabd498efa281ccb7a6",
                None, False,
            ),
            (
                "MUQ", "OpenMuQ/MuQ-large-msd-iter",
                "0562a57814f6f8bbd9fdea0a25921a2fce1a841a",
                "config.json", 3133,
                "237335ee27d8fb951ce778701a12a79e06c51ae636dd786f97e45f51ce532543",
                None, False,
            ),
        }
        actual_assets = {
            (
                item.get("component"), item.get("repository"),
                item.get("revision"), item.get("path"),
                item.get("remoteBytes"), item.get("remoteSha256"),
                item.get("upstreamMd5"), item.get("locallyVerified"),
            )
            for item in assets
        }
        songformer_license = components.get("songformer", {})
        musicfm_license = components.get("musicfm", {})
        muq_license = components.get("muq", {})
        stop_record = stop_observation.get("record", {})
        required = [
            songformer.get("finalStatus") == "BLOCKED_LICENSE",
            songformer.get("licenseStatus") == "UNVERIFIED",
            songformer.get("codeRepository")
            == "https://github.com/ASLP-lab/SongFormer.git",
            songformer.get("codeRevision")
            == "139b2aa3b14bd1c6d961d0994e9fc975f1ef7fd5",
            songformer.get("modelRepository")
            == "composite:ASLP-lab/SongFormer+minzwon/MusicFM+OpenMuQ/MuQ-large-msd-iter",
            songformer.get("modelRevision")
            == "a75880ed1b7375ac71860ec6c4fc9c899cf99515+4513b38bc25ad1d227b1980819b9691ba97f4d87+0562a57814f6f8bbd9fdea0a25921a2fce1a841a",
            songformer.get("assetsDownloaded") is False,
            songformer.get("endpointDeployed") is False,
            songformer.get("endpointConfigured") is False,
            songformer.get("healthReady") is False,
            songformer.get("promotionSigned") is False,
            songformer.get("apiConnected") is False,
            manifest.get("status") == "BLOCKED_LICENSE",
            gate.get("status") == "BLOCKED_LICENSE",
            gate.get("provisioningAllowed") is False,
            gate.get("deploymentAllowed") is False,
            gate.get("researchDeploymentAllowed") is False,
            manifest.get("source", {}).get("commit")
            == "139b2aa3b14bd1c6d961d0994e9fc975f1ef7fd5",
            manifest.get("modelSources", {}).get("songformer", {}).get("revision")
            == "a75880ed1b7375ac71860ec6c4fc9c899cf99515",
            manifest.get("modelSources", {}).get("musicfm", {}).get("revision")
            == "4513b38bc25ad1d227b1980819b9691ba97f4d87",
            manifest.get("modelSources", {}).get("muq", {}).get("revision")
            == "0562a57814f6f8bbd9fdea0a25921a2fce1a841a",
            actual_assets == expected_assets,
            license_manifest.get("classification") == "BLOCKED_LICENSE",
            songformer_license.get("sourceCommit")
            == manifest.get("source", {}).get("commit"),
            songformer_license.get("modelRevision")
            == manifest.get("modelSources", {}).get("songformer", {}).get("revision"),
            songformer_license.get("sourceLicenseSha256")
            == "1a0e476350ac340a5f96af1aef1a3a46e3f28e8be595dff9501dad084148b29e",
            songformer_license.get("modelCardSha256")
            == "91a9bae1abefaceff0696248128675b3bceab45d714702c001f4008804351e47",
            musicfm_license.get("modelRevision")
            == manifest.get("modelSources", {}).get("musicfm", {}).get("revision"),
            musicfm_license.get("checkpointLicense") == "UNVERIFIED",
            musicfm_license.get("modelRepositoryLicenseFilePresent") is False,
            musicfm_license.get("sourceLicenseSha256")
            == "5684e11c103b652a5fc59a2cc930c4bb63b5d4aa497e8519aaeb147bc4d34877",
            musicfm_license.get("modelCardSha256")
            == "3e0e15fa0c5cc81675bd69af8eb469d128a725c1a7bfc71f03b7877b7b650567",
            muq_license.get("modelRevision")
            == manifest.get("modelSources", {}).get("muq", {}).get("revision"),
            muq_license.get("checkpointLicense") == "CC-BY-NC-4.0",
            muq_license.get("sourceLicenseSha256")
            == "8f4b76ec1ca72efcde8b595df518f3a861d83c04c275dea72eb4e3ba5d00a503",
            muq_license.get("modelCardSha256")
            == "8d7322961d39f52f83953bef164503d6fb84757b00326a0107c0e1d84b880465",
            license_manifest.get("overall", {}).get("provisioningAllowed") is False,
            license_manifest.get("overall", {}).get("researchDeploymentAllowed")
            is False,
            local.get("classification") == "BLOCKED_LICENSE",
            evidence.get("assetsDownloaded") is False,
            evidence.get("bootstrapBlockedBeforeNetwork") is True,
            evidence.get("modalDeploymentFunctionsPresent") is False,
            evidence.get("endpointConfigured") is False,
            evidence.get("apiConnected") is False,
            review.get("conclusion") == "BLOCKED_LICENSE",
            review.get("provisioningAttempted") is False,
            review.get("inferenceAttempted") is False,
            deployment.get("modalAppId") == "ap-pba79GQ5ZnixHhtMx9lEmF",
            deployment.get("state") == "stopped",
            deployment.get("stoppedAt") == "2026-09-06T19:14:07Z",
            deployment.get("observationSha256")
            == evidence.get("modalStopObservationSha256"),
            stop_observation.get("recordSha256")
            == "a4f1070637935c24d2cb099e727d4a427aaf083a81fe8cdd201dcb41a708f3a4",
            canonical_sha256(stop_record) == stop_observation.get("recordSha256"),
            stop_record.get("app_id") == deployment.get("modalAppId"),
            stop_record.get("state") == "stopped",
            stop_record.get("stopped_at") == "2026-09-06 19:14:07+00:00",
            review.get("songformer", {}).get("sourceCommit")
            == manifest.get("source", {}).get("commit"),
            review.get("songformer", {}).get("modelRevision")
            == manifest.get("modelSources", {}).get("songformer", {}).get("revision"),
            review.get("musicfm", {}).get("modelRevision")
            == manifest.get("modelSources", {}).get("musicfm", {}).get("revision"),
            review.get("muq", {}).get("modelRevision")
            == manifest.get("modelSources", {}).get("muq", {}).get("revision"),
            review.get("musicfm", {}).get("checkpoint", {}).get("remoteSha256")
            == "218b483a0256ddef736267425fabb166fd97008983696bb9270def464b47bded",
            "assert_license_cleared()" in bootstrap_source,
            "snapshot_download" not in bootstrap_source,
            "import subprocess" not in bootstrap_source,
            "@modal.asgi_app" not in modal_source,
            "@app.function" not in modal_source,
            "Volume.from_name" not in modal_source,
            "Image.from_dockerfile" not in modal_source,
            '"status": "blocked_license"' in worker_source,
            "SONGFORMER_API_URL =" not in replit_source,
            "MUSIC_PROVIDER_SONGFORMER_URL =" not in replit_source,
            "MUSIC_PROVIDER_SONGFORMER_ENDPOINT =" not in replit_source,
        ]
        if not all(required):
            errors.append(
                "SONGFORMER: license-blocked classification lacks exact remote "
                "asset/license/teardown/bootstrap/Modal/worker/API evidence"
            )
    moss_names = ("MOSS_MUSIC_INSTRUCT", "MOSS_MUSIC_THINKING")
    moss_rows = {name: by_name.get(name, {}) for name in moss_names}
    moss_revision = "ad107c7ddaa06de168a0dfbc18d3e1e6a40c0e5e"
    if any(row.get("codeRevision") == moss_revision for row in moss_rows.values()):
        base = Path("services/moss-music-worker")
        status = read_json(base / "installation-status.json")
        manifest = read_json(base / "model_manifest.json")
        license_manifest = read_json(base / "license_manifest.json")
        failure = read_json(
            base / "release-evidence/modal-compatibility-failure.json"
        )
        try:
            transcript = (
                root / base / "release-evidence/modal-compatibility-failure.txt"
            ).read_bytes()
            docker = (root / base / "Dockerfile").read_text()
            api_manifest = (
                root / "artifacts/api-server/src/lib/analysisProviderManifest.ts"
            ).read_text()
            status_text = (root / base / "installation-status.json").read_text()
            image_digest = hashlib.sha256()
            for evidence_name in (
                "Dockerfile", "requirements.txt", "model_manifest.json",
                "license_manifest.json", "app.py", "bootstrap_assets.py",
                "compatibility.py", "modal_app.py", "modal_compatibility.py",
                "modal_config.py", "modal_provision.py", "preflight.py", "smoke.py",
            ):
                image_digest.update(
                    evidence_name.encode()
                    + b"\0"
                    + (root / base / evidence_name).read_bytes()
                    + b"\0"
                )
            current_image_evidence = "sha256:" + image_digest.hexdigest()
        except OSError:
            transcript = b""
            docker = api_manifest = status_text = ""
            current_image_evidence = ""
        expected_models = {
            "MOSS_MUSIC_INSTRUCT": (
                "OpenMOSS-Team/MOSS-Music-8B-Instruct",
                "fce7f8304e96cc2d3398b8106456cbb2ecec3139",
            ),
            "MOSS_MUSIC_THINKING": (
                "OpenMOSS-Team/MOSS-Music-8B-Thinking",
                "2ce899988b94b8ecc5dd0dacbc5ce1874d3500e3",
            ),
        }
        expected_runtime = {
            "python": "3.12.3",
            "cuda": "12.8",
            "torch": "2.9.1+cu128",
            "torchaudio": "2.9.1+cu128",
            "torchcodec": "0.8.0",
            "ffmpeg": "7.1.1",
            "transformers": "4.57.1",
            "huggingfaceHub": "0.36.2",
            "gradio": "5.44.1",
            "pydantic": "2.11.10",
            "fastapi": "0.115.12",
        }
        expected_transcript_sha = (
            "ee392504688ce175bf67143d73b785993929632ccf62cea0c4c48984016b9828"
        )
        blocked_flags = (
            "runtimeBuilt", "assetsDownloaded", "assetsChecksummed",
            "assetManifestCreated", "volumeProvisioned", "secretsConfigured",
            "realSmokePassed", "nonSilentOutputVerified", "endpointDeployed",
            "endpointConfigured", "healthReady", "promotionSigned", "apiConnected",
        )
        runtime = status.get("runtime", {})
        compatibility = status.get("compatibility", {})
        local_providers = status.get("providers", {})
        failed_preflight = failure.get("mediaPreflight", {})
        rows_valid = all(
            row.get("finalStatus") == "BLOCKED_UPSTREAM"
            and row.get("category") == "analysis"
            and row.get("codeRevision") == moss_revision
            and row.get("modelRepository")
            == f"https://huggingface.co/{expected_models[name][0]}"
            and row.get("modelRevision") == expected_models[name][1]
            and row.get("sourcePinned") is True
            and row.get("licenseStatus") == "COMMERCIAL"
            and row.get("promotionRequired") is True
            and all(row.get(flag) is False for flag in blocked_flags)
            and any(
                "libtorchcodec_custom_ops7.so" in blocker
                for blocker in row.get("blockers", [])
            )
            for name, row in moss_rows.items()
        )
        local_valid = all(
            local_providers.get(name, {}).get("classification")
            == "BLOCKED_UPSTREAM"
            and local_providers.get(name, {}).get("model", {}).get("repository")
            == expected_models[name][0]
            and local_providers.get(name, {}).get("model", {}).get("revision")
            == expected_models[name][1]
            and local_providers.get(name, {}).get("evidence", {}).get(
                "mediaPreflightPassed"
            ) is False
            and local_providers.get(name, {}).get("evidence", {}).get(
                "assetsDownloaded"
            ) is False
            and local_providers.get(name, {}).get("evidence", {}).get(
                "realSongSmokeAttempted"
            ) is False
            and local_providers.get(name, {}).get("evidence", {}).get(
                "endpointDeployed"
            ) is False
            and local_providers.get(name, {}).get("evidence", {}).get(
                "promotionSigned"
            ) is False
            and local_providers.get(name, {}).get("evidence", {}).get(
                "apiConnected"
            ) is False
            for name in moss_names
        )
        required = [
            status.get("schemaVersion") == 2,
            status.get("providerFamily") == "MOSS_MUSIC",
            status.get("classification") == "BLOCKED_UPSTREAM",
            status.get("source", {}).get("repository") == "OpenMOSS/MOSS-Music",
            status.get("source", {}).get("revision") == moss_revision,
            status.get("source", {}).get("install")
            == "base-package-without-torch-runtime-extra",
            status.get("sglang", {}).get("revision")
            == "c28a945853c7fee357f55d976b8abce51874bd94",
            status.get("sglang", {}).get("install") == "python[all]",
            all(runtime.get(key) == value for key, value in expected_runtime.items()),
            runtime.get("torchcodecWheel", {}).get("variant") == "cpu",
            runtime.get("torchcodecWheel", {}).get("sha256")
            == "2ec2e874dfb6fbf9bbeb792bea56317529636e78db175f56aad1e4efd6e12502",
            compatibility.get("dependencyResolutionPassed") is True,
            compatibility.get("pipCheckPassed") is True,
            compatibility.get("pipCheckOutput")
            == "No broken requirements found.",
            compatibility.get("imageEvidence")
            == "sha256:a355c0ede904d1db09260d8cdae09ebaece4c5aba3c06260d2bb43b179786f90",
            compatibility.get("imageEvidence") == current_image_evidence,
            compatibility.get("modalRunAppId") == "ap-OEaWRl8BSv1Iv2oZMh4ioT",
            compatibility.get("modalImageBuildId") == "im-nCfXWQXmJZ1TjaDNlXeXw9",
            compatibility.get("modalFunctionImageId") == "im-Sw0sTGMuqBXeVlaz5jGbL1",
            compatibility.get("imageBuilt") is True,
            compatibility.get("verifyFunctionCreated") is True,
            compatibility.get("verifyFunctionExecuted") is True,
            compatibility.get("nativePreflightLocation")
            == "remote-verify-function",
            compatibility.get("mediaPreflightPassed") is False,
            compatibility.get("failingLibrary") == "libtorchcodec_custom_ops7.so",
            compatibility.get("transcriptSha256") == expected_transcript_sha,
            compatibility.get("fullModalRunLogSha256")
            == "86a595e68f576110b9d0272acb12983a45d9a70cd7b0d89b616680b598baa097",
            hashlib.sha256(transcript).hexdigest() == expected_transcript_sha,
            failure.get("classification") == "BLOCKED_UPSTREAM",
            failure.get("modal", {}).get("expectedImageEvidence")
            == compatibility.get("imageEvidence"),
            failure.get("modal", {}).get("runAppId")
            == compatibility.get("modalRunAppId"),
            failure.get("modal", {}).get("imageBuildId")
            == compatibility.get("modalImageBuildId"),
            failure.get("modal", {}).get("functionImageId")
            == compatibility.get("modalFunctionImageId"),
            failure.get("transcript", {}).get("fullModalRunLogSha256")
            == compatibility.get("fullModalRunLogSha256"),
            failure.get("execution", {}).get("imageBuilt") is True,
            failure.get("execution", {}).get("verifyFunctionCreated") is True,
            failure.get("execution", {}).get("verifyFunctionExecuted") is True,
            failure.get("execution", {}).get("nativePreflightDuringImageBuild")
            is False,
            failure.get("resolver", {}).get("pipCheckPassed") is True,
            failed_preflight.get("passed") is False,
            failed_preflight.get("failingLibrary")
            == "libtorchcodec_custom_ops7.so",
            all(value is False for value in failure.get("downstream", {}).values()),
            manifest.get("source", {}).get("revision") == moss_revision,
            manifest.get("runtime", {}).get("installation_profile")
            == "moss-base+sglang-python-all",
            manifest.get("runtime", {}).get("moss_torch_runtime_extra_installed")
            is False,
            manifest.get("runtime", {}).get("torchcodec_wheel", {}).get("sha256")
            == runtime.get("torchcodecWheel", {}).get("sha256"),
            license_manifest.get("commercial_status")
            == "PERMITTED_BY_APACHE_2_0",
            "moss-music[torch-runtime]" not in docker,
            "moss-sglang/python[all]" in docker,
            "--no-deps" not in docker and "--force" not in docker,
            "/app/preflight.py" not in docker,
            "COPY services/moss-music-worker/ /app/" not in docker,
            (runtime.get("torchcodecWheel", {}).get("sha256") or "") in docker,
            all(model[0] in api_manifest for model in expected_models.values()),
            "TorchCodec 0.9 line" not in status_text,
            rows_valid,
            local_valid,
        ]
        if not all(required):
            errors.append(
                "MOSS_MUSIC: BLOCKED_UPSTREAM lacks exact clean-resolver/native-"
                "failure/source/model/license/no-downstream evidence"
            )
    hafm_row = by_name.get("HAFM", {})
    hafm_revision = "d9aa19a5820a4c1563ab405d437933480f71d5b9"
    if hafm_row.get("codeRevision") == hafm_revision:
        base = Path("services/hafm-worker")
        status = read_json(base / "installation-status.json")
        manifest = read_json(base / "model_manifest.json")
        license_manifest = read_json(base / "license_manifest.json")
        authorization = read_json(base / "fixture-authorization.json")
        failure = read_json(
            base / "release-evidence/compatibility-failure.json"
        )
        retained_compatibility = read_json(
            base / "release-evidence/compatibility-evidence.json"
        )
        retained_assets = read_json(
            base / "release-evidence/model-assets.json"
        )
        try:
            transcript = (
                root / base / "release-evidence/compatibility-failure.txt"
            ).read_bytes()
            compatibility_source = (
                root / base / "compatibility.py"
            ).read_text()
            smoke_source = (root / base / "smoke.py").read_text()
            app_source = (root / base / "app.py").read_text()
            docker = (root / base / "Dockerfile").read_text()
            compatibility_preimage = (
                root / base / "release-evidence/compatibility-evidence.json"
            ).read_bytes()
            assets_preimage = (
                root / base / "release-evidence/model-assets.json"
            ).read_bytes()
            probe_excerpt = (
                root / base / "release-evidence/modal-probe.txt"
            ).read_bytes()
            image_digest = hashlib.sha256()
            for evidence_name in (
                "Dockerfile",
                "requirements.txt",
                "model_manifest.json",
                "license_manifest.json",
                "fixture-authorization.json",
                "app.py",
                "bootstrap_assets.py",
                "compatibility.py",
                "inference.py",
                "modal_app.py",
                "modal_compatibility.py",
                "modal_config.py",
                "modal_provision.py",
                "smoke.py",
            ):
                image_digest.update(
                    evidence_name.encode()
                    + b"\0"
                    + (root / base / evidence_name).read_bytes()
                    + b"\0"
                )
            current_image_evidence = "sha256:" + image_digest.hexdigest()
            private_audio_in_git = any(
                path.is_file()
                for pattern in ("*.wav", "*.mp3", "*.flac", "*.m4a")
                for path in (root / base).rglob(pattern)
            )
        except OSError:
            transcript = b""
            compatibility_source = smoke_source = app_source = docker = ""
            current_image_evidence = ""
            compatibility_preimage = assets_preimage = probe_excerpt = b""
            private_audio_in_git = True
        evidence = status.get("evidence", {})
        compatibility = status.get("compatibility", {})
        fixture = status.get("fixture", {})
        model = status.get("model", {})
        local = status.get("providers", {}).get("HAFM", {})
        blocked_flags = (
            "runtimeBuilt",
            "secretsConfigured",
            "realSmokePassed",
            "nonSilentOutputVerified",
            "endpointDeployed",
            "endpointConfigured",
            "healthReady",
            "promotionSigned",
            "apiConnected",
        )
        required = [
            hafm_row.get("finalStatus") == "BLOCKED_UPSTREAM",
            hafm_row.get("category") == "generation",
            hafm_row.get("codeRepository")
            == "https://github.com/HackerHyper/HAFM",
            hafm_row.get("modelRepository")
            == "https://huggingface.co/zhuqijian/HAFM",
            hafm_row.get("modelRevision")
            == "1653c3c7bffdc9b4b2d57d8b6e4f5bb3002a64fe",
            hafm_row.get("sourcePinned") is True,
            hafm_row.get("assetsDownloaded") is True,
            hafm_row.get("assetsChecksummed") is True,
            hafm_row.get("assetManifestCreated") is True,
            hafm_row.get("volumeProvisioned") is True,
            hafm_row.get("licenseStatus") == "COMMERCIAL",
            hafm_row.get("promotionRequired") is True,
            all(hafm_row.get(flag) is False for flag in blocked_flags),
            any(
                "configs/ar.yaml" in blocker
                for blocker in hafm_row.get("blockers", [])
            ),
            status.get("schemaVersion") == 2,
            status.get("provider") == "HAFM",
            status.get("classification") == "BLOCKED_UPSTREAM",
            status.get("source", {}).get("revision") == hafm_revision,
            status.get("source", {}).get("revisionMatched") is True,
            status.get("source", {}).get("publishedFileHashesMatched") is True,
            status.get("source", {}).get("runtimeContractComplete") is False,
            status.get("source", {}).get("missingRuntimeFiles")
            == [
                "configs/ar.yaml",
                "models/ar_singsong.py",
                "data/retokenize.py",
                "utils/audio_utils.py",
            ],
            model.get("revision")
            == "1653c3c7bffdc9b4b2d57d8b6e4f5bb3002a64fe",
            model.get("treeSha256")
            == "79d4812169b7e71196f0d03babcffcf956a628b9cbde02eb75ec9bfc2074b6c8",
            model.get("assetManifestSha256")
            == "999b7dd6990ec71cb24764c95279dc2d3efef7fa86aad6c584f75d93e873e8d5",
            model.get("requiredAssetCount") == 7,
            model.get("assetsReady") is True,
            fixture.get("authorizationConfirmed") is True,
            fixture.get("authorizationEvidenceSha256")
            == "385d975b945886f1ad2e6661a0588213b3ecf84165f40fda6932a995ce6ae197",
            fixture.get("sourceUploadSha256")
            == "f2d5520e2a608fbc73f51077c9714de69f01cccf0c780056e460ec15e04b16ef",
            fixture.get("fixtureSha256")
            == "3358e43121bf2c22ebd9dc0c424f2a4e071df932ed90d405f9095cac68232265",
            fixture.get("durationSeconds") == 15.0,
            fixture.get("sampleRate") == 16000,
            fixture.get("channels") == 1,
            fixture.get("sampleWidthBits") == 16,
            fixture.get("bytes") == 480078,
            fixture.get("finite") is True,
            fixture.get("nonSilent") is True,
            fixture.get("identityMatched") is True,
            fixture.get("audioCommittedToGit") is False,
            authorization.get("authorization", {}).get("confirmed") is True,
            authorization.get("authorization", {}).get(
                "confirmedDuringSessionLocalDate"
            ) == "2026-09-07",
            authorization.get("authorization", {}).get("sessionTimezone")
            == "Asia/Jerusalem",
            authorization.get("authorization", {}).get(
                "utcCalendarDateAtRetention"
            ) == "2026-09-06",
            authorization.get("derivedFixture", {}).get("sha256")
            == fixture.get("fixtureSha256"),
            authorization.get("audioCommittedToGit") is False,
            not private_audio_in_git,
            compatibility.get("imageEvidence")
            == "sha256:bb3ea7679fab888113d42c252fe9497960961214dd176bde4848efb3fa34e23e",
            compatibility.get("imageEvidence") == current_image_evidence,
            compatibility.get("modalRunAppId")
            == "ap-UTS20Z77lonwYTc1Lfm2m4",
            compatibility.get("modalImageBuildId")
            == "im-v4jr4FcbxxsmVoKCoIUGyn",
            compatibility.get("modalFunctionImageId")
            == "im-Nzb0k10OAWvlHqEqCysx6x",
            compatibility.get("imageBuilt") is True,
            compatibility.get("verifyFunctionCreated") is True,
            compatibility.get("verifyFunctionExecuted") is True,
            compatibility.get("pipCheckPassed") is True,
            compatibility.get("pipCheckOutput")
            == "No broken requirements found.",
            compatibility.get("passed") is False,
            compatibility.get("compatibilityEvidenceSha256")
            == "219eaf085989b6241b4e63eed65271f4cc88074c8484382835175b1e968c33f1",
            compatibility.get("modelAssetsSha256")
            == "999b7dd6990ec71cb24764c95279dc2d3efef7fa86aad6c584f75d93e873e8d5",
            compatibility.get("normalizedProbeSha256")
            == "240b96052368f3adad57f04ac458c074fe6d6512f3349d708c6b8204e7167e8d",
            compatibility.get("transcriptSha256")
            == "3c098e18ac2d9d03edc16c879019fa19aeb3d5c1bd77bcebad03209e29972f75",
            compatibility.get("fullModalRunLogSha256")
            == "f8f43d2478fe3ea6a4d5192e374c5fc44a9dfed02465e1a34e4ef37715d8ff39",
            hashlib.sha256(transcript).hexdigest()
            == compatibility.get("transcriptSha256"),
            hashlib.sha256(compatibility_preimage).hexdigest()
            == compatibility.get("compatibilityEvidenceSha256"),
            hashlib.sha256(assets_preimage).hexdigest()
            == compatibility.get("modelAssetsSha256"),
            hashlib.sha256(probe_excerpt).hexdigest()
            == compatibility.get("normalizedProbeSha256"),
            retained_compatibility.get("classification")
            == "BLOCKED_UPSTREAM",
            retained_compatibility.get("compatible") is False,
            retained_compatibility.get("imageEvidence")
            == compatibility.get("imageEvidence"),
            retained_compatibility.get("inferenceAttempted") is False,
            retained_compatibility.get("model", {}).get("assetsReady") is True,
            retained_compatibility.get("fixture", {}).get("identityMatches")
            is True,
            retained_assets.get("model", {}).get("revision")
            == model.get("revision"),
            retained_assets.get("treeSha256") == model.get("treeSha256"),
            len(retained_assets.get("files", [])) == 22,
            failure.get("classification") == "BLOCKED_UPSTREAM",
            failure.get("modal", {}).get("expectedImageEvidence")
            == compatibility.get("imageEvidence"),
            failure.get("modal", {}).get("runAppId")
            == compatibility.get("modalRunAppId"),
            failure.get("modal", {}).get("imageBuildId")
            == compatibility.get("modalImageBuildId"),
            failure.get("modal", {}).get("functionImageId")
            == compatibility.get("modalFunctionImageId"),
            failure.get("execution", {}).get("imageBuilt") is True,
            failure.get("execution", {}).get("verifyFunctionCreated") is True,
            failure.get("execution", {}).get("verifyFunctionExecuted") is True,
            failure.get("execution", {}).get("pipCheckPassed") is True,
            failure.get("execution", {}).get("compatibilityPassed") is False,
            failure.get("execution", {}).get("inferenceAttempted") is False,
            failure.get("source", {}).get("missingRuntimeFiles")
            == status.get("source", {}).get("missingRuntimeFiles"),
            failure.get("model", {}).get("assetsReady") is True,
            failure.get("fixture", {}).get("identityMatched") is True,
            all(
                value is False
                for value in failure.get("downstream", {}).values()
            ),
            manifest.get("source", {}).get("revision") == hafm_revision,
            manifest.get("source", {}).get("documentedEntrypoint")
            == "infer_simple.py",
            manifest.get("source", {}).get("publishedEntrypoint")
            == "infer.py",
            len(manifest.get("model", {}).get("requiredAssets", {})) == 7,
            manifest.get("runtime", {}).get("inferenceDependencyStatus")
            == "UNPUBLISHED_UPSTREAM",
            license_manifest.get("license") == "Apache-2.0",
            license_manifest.get("fixtureAudioCommittedToGit") is False,
            evidence.get("licensedFixtureVerified") is True,
            evidence.get("compatibilityImageBuilt") is True,
            evidence.get("runtimeBuilt") is False,
            evidence.get("modelInferenceAttempted") is False,
            evidence.get("realSmokePassed") is False,
            evidence.get("promotionSigned") is False,
            evidence.get("endpointDeployed") is False,
            evidence.get("healthReady") is False,
            evidence.get("apiConnected") is False,
            local.get("classification") == "BLOCKED_UPSTREAM",
            local.get("evidence", {}).get("licensedFixtureVerified") is True,
            local.get("evidence", {}).get("modelInferenceAttempted") is False,
            "inferenceAttempted" in compatibility_source,
            'compatibility.get("compatible") is not True' in smoke_source,
            "if not assets_ok or not compatible or not smoke_ok" in app_source,
            "COPY services/hafm-worker/ /app/" not in docker,
            "/app/compatibility.py" not in docker,
        ]
        if not all(required):
            errors.append(
                "HAFM: BLOCKED_UPSTREAM lacks exact licensed-fixture/model/"
                "source-gap/remote-probe/no-downstream evidence"
            )
    for name in ("MUSICGEN_LARGE", "MUSICGEN_MELODY_LARGE"):
        row = by_name.get(name, {})
        if row.get("sourcePinned") and row.get("finalStatus") != "BLOCKED_NO_WEIGHTS":
            errors.append(f"{name}: pinned but unprovisioned model must be BLOCKED_NO_WEIGHTS")
        if row.get("sourcePinned") and any(row.get(k) for k in ("assetsDownloaded", "assetManifestCreated", "realSmokePassed", "endpointDeployed", "healthReady", "promotionSigned", "apiConnected")):
            errors.append(f"{name}: pinned-but-unprovisioned contradiction")
    return errors

def audit(data, local_statuses=None, report_text=None, replit_text=None, root=Path(".")):
    errors, seen = [], set()
    for row in effective(data):
        name = row.get("provider", "<missing>")
        missing = [k for k in REQUIRED if k not in row]
        if missing: errors.append(f"{name}: missing fields {','.join(missing)}"); continue
        if name in seen: errors.append(f"{name}: duplicate provider")
        seen.add(name)
        if row["finalStatus"] not in STATUSES: errors.append(f"{name}: invalid finalStatus")
        if row["licenseStatus"] not in LICENSES: errors.append(f"{name}: invalid licenseStatus")
        if not isinstance(row["blockers"], list) or not isinstance(row["notes"], list):
            errors.append(f"{name}: blockers and notes must be arrays")
        for key in BOOLS:
            if not isinstance(row[key], bool): errors.append(f"{name}: {key} must be boolean")
        ready = row["finalStatus"] in {"READY", "RESEARCH_READY"}
        if not ready and not row["blockers"]: errors.append(f"{name}: blocked status needs blocker")
        if ready:
            required = BOOLS - {
                "promotionRequired",
                "promotionSigned",
                "nonSilentOutputVerified",
            }
            bad = [k for k in required if not row[k]]
            if row["promotionRequired"] and not row["promotionSigned"]: bad.append("promotionSigned")
            if row["finalStatus"] == "READY" and row["licenseStatus"] in {"RESEARCH_ONLY", "UNVERIFIED"}:
                bad.append("commercial license")
            if row["finalStatus"] == "RESEARCH_READY" and row["licenseStatus"] != "RESEARCH_ONLY":
                bad.append("research-only license")
            if row["category"] in {"generation", "renderer"} and not row["nonSilentOutputVerified"]:
                bad.append("nonSilentOutputVerified")
            if any(str(row[k]).strip().lower() in MUTABLE for k in ("codeRevision","modelRevision")):
                bad.append("immutable revisions")
            if bad: errors.append(f"{name}: READY contradiction: {','.join(sorted(set(bad)))}")
        elif row["finalStatus"] not in STATUSES - {"READY", "RESEARCH_READY"}:
            errors.append(f"{name}: undefined final state")
        for local_path, local_status in (local_statuses or {}).get(name, []):
            if local_status != row["finalStatus"]:
                errors.append(f"{name}: {local_path} finalStatus {local_status} conflicts with matrix")
        if row["endpointConfigured"]:
            key = ENDPOINT_KEYS.get(name)
            if not key:
                errors.append(f"{name}: configured endpoint has no approved .replit key")
            elif replit_text is not None and not re.search(rf"(?m)^\s*{re.escape(key)}\s*=", replit_text):
                errors.append(f"{name}: approved endpoint key {key} is absent from .replit")
    missing = EXPECTED - seen
    if missing: errors.append("coverage missing: " + ",".join(sorted(missing)))
    if report_text is not None:
        errors.extend(report_errors(effective(data), report_text))
    errors.extend(evidence_errors(effective(data), root))
    return errors

def main():
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "installation-matrix-v2.json")
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"FAIL: cannot read matrix: {exc}"); return 1
    local_statuses = {}
    status_paths = list(Path("services").glob("*/installation-status.json"))
    status_paths += list(Path("docs/provider-installation-status").glob("*.json"))
    for status_path in status_paths:
        if status_path.name == "schema.json":
            continue
        try:
            status = json.loads(status_path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if "providers" in status:
            for provider, record in status["providers"].items():
                local_statuses.setdefault(provider, []).append((str(status_path), record.get("classification")))
        elif status.get("provider"):
            local_statuses.setdefault(status["provider"], []).append((str(status_path), status.get("finalStatus")))
    try:
        report_text = Path("docs/installation-completion-report.md").read_text()
        replit_text = Path(".replit").read_text()
    except OSError as exc:
        print(f"FAIL: cannot read audit evidence: {exc}"); return 1
    errors = audit(data, local_statuses, report_text, replit_text)
    if errors:
        print("FAIL")
        print("\n".join(f"- {x}" for x in errors)); return 1
    print("PASS")
    return 0
if __name__ == "__main__":
    raise SystemExit(main())