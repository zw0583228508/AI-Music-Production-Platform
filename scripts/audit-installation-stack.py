#!/usr/bin/env python3
"""Validate the authoritative installation matrix without treating code as proof."""
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

def effective(data):
    defaults = data.get("defaults", {})
    return [{**defaults, **row} for row in data.get("providers", [])]

ENDPOINT_KEYS = {
    "ACE_STEP": "ACE_STEP_API_URL", "ALL_IN_ONE": "ALL_IN_ONE_API_URL",
    "BEAT_THIS": "MUSIC_PROVIDER_BEAT_THIS_URL", "MT3": "MT3_API_URL",
    "MR_MT3": "MR_MT3_API_URL", "SHEETSAGE": "SHEETSAGE_API_URL",
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