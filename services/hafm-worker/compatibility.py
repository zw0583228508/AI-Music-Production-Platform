"""Fail-closed HAFM source, asset, and licensed-fixture compatibility proof."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import wave

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
AUTHORIZATION = json.loads((ROOT / SPEC["fixture_authorization"]).read_text())
ASSET_ROOT = Path(os.getenv("HAFM_ASSET_ROOT", SPEC["asset_root"]))
SMOKE_ROOT = Path(os.getenv("HAFM_SMOKE_ROOT", "/var/lib/hafm/smoke"))
SOURCE_ROOT = Path("/opt/hafm")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_contract() -> dict[str, object]:
    revision = subprocess.run(
        ["git", "-C", str(SOURCE_ROOT), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    observed_hashes = {
        name: sha256(SOURCE_ROOT / name)
        for name in SPEC["source"]["observedFiles"]
        if (SOURCE_ROOT / name).is_file()
    }
    missing = [
        name
        for name in SPEC["source"]["requiredRuntimeFiles"]
        if not (SOURCE_ROOT / name).is_file()
    ]
    hashes_match = observed_hashes == SPEC["source"]["observedFiles"]
    return {
        "repository": SPEC["source"]["repository"],
        "expectedRevision": SPEC["source"]["revision"],
        "observedRevision": revision,
        "revisionMatches": revision == SPEC["source"]["revision"],
        "observedFiles": observed_hashes,
        "observedFileHashesMatch": hashes_match,
        "documentedEntrypoint": SPEC["source"]["documentedEntrypoint"],
        "publishedEntrypoint": SPEC["source"]["publishedEntrypoint"],
        "missingRuntimeFiles": missing,
        "runtimeContractComplete": not missing,
    }


def model_contract() -> dict[str, object]:
    manifest_path = ASSET_ROOT / SPEC["asset_manifest"]
    manifest = json.loads(manifest_path.read_text())
    indexed = {
        entry["path"]: entry
        for entry in manifest.get("files", [])
        if isinstance(entry, dict) and isinstance(entry.get("path"), str)
    }
    mismatches = []
    for relative, expected_hash in SPEC["model"]["requiredAssets"].items():
        path = ASSET_ROOT / manifest.get("path", "snapshot") / relative
        entry = indexed.get(relative)
        if (
            not path.is_file()
            or not entry
            or entry.get("sha256") != expected_hash
            or sha256(path) != expected_hash
        ):
            mismatches.append(relative)
    identity_matches = (
        manifest.get("model") == {
            "repository": SPEC["model"]["repository"],
            "revision": SPEC["model"]["revision"],
        }
        and manifest.get("source") == {
            "repository": SPEC["source"]["repository"],
            "revision": SPEC["source"]["revision"],
        }
        and manifest.get("treeSha256") == SPEC["model"]["treeSha256"]
    )
    return {
        "manifestSha256": sha256(manifest_path),
        "treeSha256": manifest.get("treeSha256"),
        "identityMatches": identity_matches,
        "requiredAssetCount": len(SPEC["model"]["requiredAssets"]),
        "requiredAssetMismatches": mismatches,
        "assetsReady": identity_matches and not mismatches,
    }


def fixture_contract() -> dict[str, object]:
    fixture = SMOKE_ROOT / SPEC["smoke_fixture"]
    expected = AUTHORIZATION["derivedFixture"]
    with wave.open(str(fixture), "rb") as audio:
        channels = audio.getnchannels()
        sample_rate = audio.getframerate()
        sample_width_bits = audio.getsampwidth() * 8
        frames = audio.getnframes()
    observed = {
        "path": str(fixture),
        "bytes": fixture.stat().st_size,
        "sha256": sha256(fixture),
        "durationSeconds": frames / sample_rate,
        "sampleRate": sample_rate,
        "channels": channels,
        "sampleWidthBits": sample_width_bits,
    }
    expected_subset = {
        key: expected[key]
        for key in observed
        if key != "path"
    }
    return {
        "authorizationEvidenceSha256": sha256(
            ROOT / SPEC["fixture_authorization"]
        ),
        "authorizationConfirmed": (
            AUTHORIZATION.get("authorization", {}).get("confirmed") is True
        ),
        "audioCommittedToGit": AUTHORIZATION.get("audioCommittedToGit"),
        "observed": observed,
        "identityMatches": {
            key: observed[key] for key in expected_subset
        } == expected_subset,
        "finite": expected.get("finite") is True,
        "nonSilent": expected.get("nonSilent") is True,
    }


def build_evidence(*, source_only: bool = False) -> dict[str, object]:
    pip_check = subprocess.run(
        ["/opt/hafm-venv/bin/python", "-m", "pip", "check"],
        check=True,
        capture_output=True,
        text=True,
    )
    source = source_contract()
    evidence: dict[str, object] = {
        "schemaVersion": 1,
        "provider": "HAFM",
        "classification": "BLOCKED_UPSTREAM",
        "imageEvidence": os.getenv("HAFM_SOURCE_IMAGE_DIGEST"),
        "source": source,
        "runtime": SPEC["runtime"],
        "pipCheck": {
            "passed": True,
            "output": pip_check.stdout.strip(),
        },
        "inferenceDependenciesPublished": (
            SPEC["runtime"]["inferenceDependencyStatus"]
            != "UNPUBLISHED_UPSTREAM"
        ),
        "sourceOnly": source_only,
    }
    if source_only:
        compatible = (
            source["revisionMatches"]
            and source["observedFileHashesMatch"]
            and source["runtimeContractComplete"]
            and evidence["inferenceDependenciesPublished"]
        )
    else:
        model = model_contract()
        fixture = fixture_contract()
        evidence["model"] = model
        evidence["fixture"] = fixture
        compatible = (
            source["revisionMatches"]
            and source["observedFileHashesMatch"]
            and source["runtimeContractComplete"]
            and evidence["inferenceDependenciesPublished"]
            and model["assetsReady"]
            and fixture["authorizationConfirmed"]
            and fixture["audioCommittedToGit"] is False
            and fixture["identityMatches"]
            and fixture["finite"]
            and fixture["nonSilent"]
        )
    evidence["compatible"] = compatible
    evidence["inferenceAttempted"] = False
    evidence["downstream"] = {
        "smokeAttempted": False,
        "promotionCreated": False,
        "endpointDeployed": False,
        "healthReady": False,
        "apiConnected": False,
    }
    return evidence


def write_evidence(evidence: dict[str, object]) -> Path:
    SMOKE_ROOT.mkdir(parents=True, exist_ok=True)
    destination = SMOKE_ROOT / SPEC["compatibility_evidence"]
    serialized = json.dumps(evidence, indent=2, sort_keys=True) + "\n"
    temporary = destination.with_name(f"{destination.name}.{os.getpid()}.tmp")
    temporary.write_text(serialized)
    os.replace(temporary, destination)
    print(json.dumps({
        "compatibilityEvidence": str(destination),
        "sha256": hashlib.sha256(serialized.encode()).hexdigest(),
        "evidence": evidence,
    }, sort_keys=True))
    return destination


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-only", action="store_true")
    args = parser.parse_args()
    evidence = build_evidence(source_only=args.source_only)
    if not args.source_only:
        write_evidence(evidence)
    else:
        print(json.dumps(evidence, sort_keys=True))
    if evidence["compatible"] is not True:
        missing = evidence["source"]["missingRuntimeFiles"]
        raise RuntimeError(
            "HAFM upstream runtime contract is incomplete; missing: "
            + ", ".join(missing)
        )


if __name__ == "__main__":
    main()