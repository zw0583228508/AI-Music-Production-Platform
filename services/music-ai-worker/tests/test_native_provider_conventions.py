import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from importlib.metadata import version
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
HOST_ROOT = ROOT / "services" / "music-ai-worker" / "native_hosts"
STATUS_ROOT = ROOT / "docs" / "provider-installation-status"
ALLOWED = {
    "READY",
    "RESEARCH_READY",
    "BLOCKED_LICENSE",
    "BLOCKED_NO_WEIGHTS",
    "BLOCKED_UPSTREAM",
    "BLOCKED_MISSING_LICENSED_ASSET",
}


def load_common():
    spec = importlib.util.spec_from_file_location("native_host_common", HOST_ROOT / "common.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


class NativeProviderConventionTests(unittest.TestCase):
    def test_phase_seven_and_eight_statuses_use_final_vocabulary_and_evidence(self):
        records = {}
        for path in STATUS_ROOT.glob("*.json"):
            if path.name == "schema.json":
                continue
            value = json.loads(path.read_text())
            self.assertEqual(value["schemaVersion"], 1)
            self.assertIn(value["finalStatus"], ALLOWED)
            self.assertRegex(value["checkedAt"], r"^\d{4}-\d{2}-\d{2}$")
            self.assertTrue(value.get("evidence") or value.get("blockers"))
            records[value["provider"]] = value["finalStatus"]
        self.assertEqual(records["PEDALBOARD"], "BLOCKED_UPSTREAM")
        self.assertEqual(records["VST3_HOST"], "BLOCKED_UPSTREAM")
        self.assertEqual(records["VST3_INSTRUMENT"], "BLOCKED_MISSING_LICENSED_ASSET")
        self.assertIn(records["SFIZZ_VSCO2_CE"], ALLOWED)
        self.assertIn(records["LEVO2_RESEARCH"], ALLOWED)

    def test_pedalboard_retains_real_smoke_but_not_complete_pdf_evidence(self):
        pedalboard = json.loads((STATUS_ROOT / "pedalboard.json").read_text())
        manifest = json.loads((ROOT / "services/music-ai-worker/model_manifest.json").read_text())
        marker = ROOT / "services/music-ai-worker/.readiness" / f"{manifest['readiness_key']}.json"
        smoke = json.loads(marker.read_text())
        self.assertEqual(pedalboard["finalStatus"], "BLOCKED_UPSTREAM")
        self.assertFalse(pedalboard["readiness"]["completePdfEvidenceChain"])
        self.assertEqual(version("pedalboard"), manifest["pedalboard"]["version"])
        self.assertTrue(smoke["pedalboard"])
        self.assertGreater(smoke["pedalboardEvidence"]["peak"], 0)
        evidence = " ".join(pedalboard["evidence"])
        self.assertIn("0.9.24", evidence)
        self.assertIn(".readiness/", evidence)
        self.assertIn("health", evidence)
        self.assertIn("/process", evidence)

    def test_native_renderer_ready_is_rejected_without_built_approved_render_evidence(self):
        for filename in ("vst3-host.json", "sfizz-vsco2-ce.json"):
            record = json.loads((STATUS_ROOT / filename).read_text())
            readiness = record["readiness"]
            has_native_smoke = readiness.get("offlineNativeRenderEvidence") or readiness.get(
                "threeTrackModelSmokeRenders"
            )
            if not has_native_smoke:
                self.assertNotEqual(record["finalStatus"], "READY")
        vst = json.loads((STATUS_ROOT / "vst3-host.json").read_text())
        self.assertFalse(vst["readiness"]["exactBuiltHostBinaryApproved"])
        self.assertFalse(vst["readiness"]["deployedConfiguration"])

    def test_status_readiness_booleans_cannot_contradict_final_status(self):
        names = ("pedalboard.json", "vst3-host.json", "vst3-instrument.json", "sfizz-vsco2-ce.json", "levo2.json")
        for name in names:
            record = json.loads((STATUS_ROOT / name).read_text())
            flags = record["readiness"]
            if record["finalStatus"] == "READY":
                self.assertTrue(flags and all(flags.values()), name)
            else:
                self.assertTrue(flags and not all(flags.values()), name)

    def test_watchlist_has_only_research_records_without_fake_runtimes(self):
        values = json.loads((ROOT / "research-watchlist.json").read_text())
        self.assertEqual(
            {value["provider"] for value in values},
            {
                "S2Accompanist",
                "BeatEdit",
                "Live Music Diffusion Models",
                "Diff-A-Riff",
                "Break-the-Beat",
            },
        )
        for value in values:
            self.assertFalse(value["weightsAvailable"])
            self.assertEqual(value["status"], "BLOCKED_NO_WEIGHTS")
            self.assertRegex(value["lastReviewed"], r"^\d{4}-\d{2}-\d{2}$")
            self.assertFalse((ROOT / "services" / f"{value['provider'].lower()}-worker").exists())

    def test_host_midi_conversion_preserves_note_velocity_cc_and_articulation_mapping(self):
        common = load_common()
        track = {
            "notes": [{"start": 0.1, "duration": 0.4, "pitch": 61, "velocity": 99}],
            "cc": [{"time": 0.2, "controller": 11, "value": 72}],
            "articulations": [{"time": 0.05, "midiNote": 24, "intensity": 0.5}],
        }
        events = common.midi_events(track)
        self.assertIn((bytes((0x90, 61, 99)), 0.1), events)
        self.assertIn((bytes((0x80, 61, 0)), 0.5), events)
        self.assertIn((bytes((0xB0, 11, 72)), 0.2), events)
        self.assertIn((bytes((0x90, 24, 64)), 0.05), events)

    def test_host_tree_hash_matches_worker_file_hash_contract(self):
        common = load_common()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "host"
            path.write_bytes(b"native-host")
            self.assertEqual(common.sha256_tree(path), hashlib.sha256(b"native-host").hexdigest())

    def test_native_hosts_package_as_single_executable_approval_units(self):
        with tempfile.TemporaryDirectory() as temporary:
            for kind in ("vst3", "sfz"):
                output = Path(temporary) / f"{kind}-host"
                subprocess.run(
                    [sys.executable, str(HOST_ROOT / "build_host.py"), kind, str(output)],
                    check=True,
                )
                self.assertTrue(output.is_file())
                self.assertTrue(output.stat().st_mode & 0o100)
                subprocess.run([str(output), "--help"], check=True, capture_output=True)


if __name__ == "__main__":
    unittest.main()