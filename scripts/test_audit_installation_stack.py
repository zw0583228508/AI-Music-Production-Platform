import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("audit", Path(__file__).with_name("audit-installation-stack.py"))
audit = importlib.util.module_from_spec(spec); spec.loader.exec_module(audit)

class AuditFixtures(unittest.TestCase):
    def row(self):
        return {k: (True if k in audit.BOOLS else [] if k in {"blockers","notes"} else "x")
                for k in audit.REQUIRED} | {"provider":"ACE_STEP","finalStatus":"READY",
                "licenseStatus":"COMMERCIAL","codeRevision":"abc123","modelRevision":"def456",
                "blockers":[],"notes":["proof"]}
    def matrix(self, row):
        return {"providers":[row] + [{"provider":p,"finalStatus":"BLOCKED_UPSTREAM",
          "blockers":["blocked"]} for p in audit.EXPECTED-{"ACE_STEP"}],
          "defaults":{k:(False if k in audit.BOOLS else [] if k in {"blockers","notes"}
                         else "UNVERIFIED" if k == "licenseStatus" else "x")
                      for k in audit.REQUIRED}}
    def test_ready_complete_passes(self):
        self.assertEqual(audit.audit(self.matrix(self.row())), [])
    def test_research_ready_accepts_research_license_and_symbolic_output(self):
        r=self.row()
        r.update({
            "category": "analysis",
            "finalStatus": "RESEARCH_READY",
            "licenseStatus": "RESEARCH_ONLY",
            "nonSilentOutputVerified": False,
            "promotionRequired": False,
            "promotionSigned": False,
        })
        self.assertEqual(audit.audit(self.matrix(r)), [])
    def test_commercial_ready_rejects_research_only_license(self):
        r=self.row(); r["licenseStatus"]="RESEARCH_ONLY"
        self.assertTrue(any("commercial license" in x for x in audit.audit(self.matrix(r))))
    def test_ready_without_smoke_fails(self):
        r=self.row(); r["realSmokePassed"]=False
        self.assertTrue(any("READY contradiction" in x for x in audit.audit(self.matrix(r))))
    def test_gpu_promotion_contradiction_fails(self):
        r=self.row(); r["promotionRequired"]=True; r["promotionSigned"]=False
        self.assertTrue(any("promotionSigned" in x for x in audit.audit(self.matrix(r))))
    def test_mutable_revision_fails(self):
        r=self.row(); r["modelRevision"]="main"
        self.assertTrue(any("immutable revisions" in x for x in audit.audit(self.matrix(r))))
    def test_local_conflict_cannot_be_overridden_by_notes(self):
        m=self.matrix(self.row())
        local={"ACE_STEP":[("services/ace/installation-status.json","BLOCKED_UPSTREAM")]}
        self.assertTrue(any("conflicts with matrix" in x for x in audit.audit(m, local)))
        m["providers"][0]["notes"]=["ROOT_OVERRIDE: local record lacks full-chain evidence"]
        self.assertTrue(any("conflicts with matrix" in x for x in audit.audit(m, local)))
    def test_report_status_mismatch_fails(self):
        m=self.matrix(self.row())
        report="| ACE_STEP | x | x | x | x | x | x | x | x | x | BLOCKED_UPSTREAM | x |"
        self.assertTrue(any("report finalStatus" in x for x in audit.audit(m, report_text=report)))
    def test_musicgen_pinned_unprovisioned_contradiction_fails(self):
        m=self.matrix(self.row())
        r=next(x for x in m["providers"] if x["provider"]=="MUSICGEN_LARGE")
        r.update({"sourcePinned":True,"finalStatus":"BLOCKED_UPSTREAM","assetsDownloaded":True})
        self.assertTrue(any("pinned" in x for x in audit.audit(m)))

    def test_moss_blocked_requires_retained_native_failure_evidence(self):
        m = self.matrix(self.row())
        models = {
            "MOSS_MUSIC_INSTRUCT": (
                "MOSS-Music-8B-Instruct",
                "fce7f8304e96cc2d3398b8106456cbb2ecec3139",
            ),
            "MOSS_MUSIC_THINKING": (
                "MOSS-Music-8B-Thinking",
                "2ce899988b94b8ecc5dd0dacbc5ce1874d3500e3",
            ),
        }
        for name, (repository, revision) in models.items():
            row = next(item for item in m["providers"] if item["provider"] == name)
            row.update({
                "codeRevision": "ad107c7ddaa06de168a0dfbc18d3e1e6a40c0e5e",
                "modelRepository": f"https://huggingface.co/OpenMOSS-Team/{repository}",
                "modelRevision": revision,
            })
        errors = audit.audit(m, root=Path("/definitely/missing"))
        self.assertTrue(any("MOSS_MUSIC" in error for error in errors))

    def test_hafm_blocked_requires_retained_licensed_fixture_probe(self):
        m = self.matrix(self.row())
        row = next(
            item for item in m["providers"]
            if item["provider"] == "HAFM"
        )
        row.update({
            "category": "generation",
            "codeRepository": "https://github.com/HackerHyper/HAFM",
            "codeRevision": (
                "d9aa19a5820a4c1563ab405d437933480f71d5b9"
            ),
            "modelRepository": "https://huggingface.co/zhuqijian/HAFM",
            "modelRevision": (
                "1653c3c7bffdc9b4b2d57d8b6e4f5bb3002a64fe"
            ),
            "sourcePinned": True,
            "assetsDownloaded": True,
            "assetsChecksummed": True,
            "assetManifestCreated": True,
            "volumeProvisioned": True,
            "licenseStatus": "COMMERCIAL",
            "promotionRequired": True,
            "finalStatus": "BLOCKED_UPSTREAM",
        })
        errors = audit.audit(m, root=Path("/definitely/missing"))
        self.assertTrue(any("HAFM" in error for error in errors))

    def test_hafm_retained_probe_extension_is_not_git_ignored(self):
        probe = Path(
            "services/hafm-worker/release-evidence/modal-probe.txt"
        )
        self.assertTrue(probe.is_file())
        self.assertNotEqual(probe.suffix, ".log")

    def test_demucs_ready_requires_retained_release_attestation(self):
        m=self.matrix(self.row())
        r=next(x for x in m["providers"] if x["provider"]=="DEMUCS")
        r.update({"finalStatus":"READY","licenseStatus":"COMMERCIAL",
                  "codeRepository":"https://github.com/facebookresearch/demucs",
                  "codeRevision":"ef66d254cd6d558e207eeff2c4b8d053db2e77dd",
                  "modelRevision":"sha256:"+"8"*64,"blockers":[]})
        errors=audit.audit(m, root=Path("/definitely/missing"))
        self.assertTrue(any("DEMUCS: READY lacks" in x for x in errors))

    def test_basic_pitch_ready_requires_retained_real_note_attestation(self):
        m=self.matrix(self.row())
        r=next(x for x in m["providers"] if x["provider"]=="BASIC_PITCH")
        r.update({"finalStatus":"READY","licenseStatus":"COMMERCIAL",
                  "codeRepository":"https://github.com/spotify/basic-pitch",
                  "codeRevision":"9991303bba609a3b93089d13ec80d1d495083596",
                  "modelRevision":"sha256:"+"b"*64,"blockers":[]})
        errors=audit.audit(m, root=Path("/definitely/missing"))
        self.assertTrue(any("BASIC_PITCH: READY lacks" in x for x in errors))