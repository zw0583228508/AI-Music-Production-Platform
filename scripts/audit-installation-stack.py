#!/usr/bin/env python3
"""Validate the authoritative installation matrix without treating code as proof."""
import hashlib
import json
import re
import sys
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

def effective(data):
    defaults = data.get("defaults", {})
    return [{**defaults, **row} for row in data.get("providers", [])]

ENDPOINT_KEYS = {
    "ACE_STEP": "ACE_STEP_API_URL", "ALL_IN_ONE": "ALL_IN_ONE_API_URL",
    "BEAT_THIS": "MUSIC_PROVIDER_BEAT_THIS_URL", "MT3": "MT3_API_URL",
    "MR_MT3": "MR_MT3_API_URL", "SHEETSAGE": "SHEETSAGE_API_URL",
    "DEMUCS": "DEMUCS_API_URL", "BASIC_PITCH": "BASIC_PITCH_API_URL",
    "MADMOM": "MADMOM_API_URL", "ESSENTIA": "ESSENTIA_API_URL",
    "CHROMA": "CHROMA_API_URL", "TORCHCREPE": "TORCHCREPE_API_URL",
    "PYLOUDNORM": "PYLOUDNORM_API_URL",
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