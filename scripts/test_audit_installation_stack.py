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