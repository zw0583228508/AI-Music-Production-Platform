"""Repository-level guard for phase 4-6 provider disposition records."""

import json
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
STATUS_DIR = ROOT / "docs" / "provider-installation-status"
PHASE_4_6 = {
    "SAM_AUDIO",
    "MAGENTA_RT2_SMALL",
    "MAGENTA_RT2_BASE",
    "REMI_Z",
    "MUSIC2MUSIC",
    "METEOR",
    "SYMPHONYGEN",
    "MUQ",
    "MUQ_MULAN",
    "MUQ_EVAL",
    "SONG_AESTHETICS",
    "SONG_EVAL",
    "CLAMP3",
}
ALLOWED = {
    "READY",
    "RESEARCH_READY",
    "BLOCKED_LICENSE",
    "BLOCKED_NO_WEIGHTS",
    "BLOCKED_UPSTREAM",
    "BLOCKED_MISSING_LICENSED_ASSET",
}


def _records():
    return [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(STATUS_DIR.glob("*.json"))
        if path.name != "schema.json"
    ]


def test_every_phase_4_6_provider_has_exactly_one_status_record():
    providers = [record["provider"] for record in _records()]
    for provider in PHASE_4_6:
        assert providers.count(provider) == 1, provider


def test_status_records_use_the_documented_terminal_status_schema():
    for record in _records():
        assert record["schemaVersion"] == 1
        assert record["provider"].strip()
        assert record["finalStatus"] in ALLOWED
        assert date.fromisoformat(record["checkedAt"])
        evidence = record.get("evidence")
        blockers = record.get("blockers")
        assert evidence is not None or blockers is not None
        if evidence is not None:
            assert isinstance(evidence, list)
            assert evidence and all(isinstance(item, str) and item.strip() for item in evidence)
        if blockers is not None:
            assert isinstance(blockers, list)
            assert blockers and all(isinstance(item, str) and item.strip() for item in blockers)