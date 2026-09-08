import importlib.util
import array
import base64
import copy
import hashlib
import json
import math
import tempfile
import subprocess
import unittest
import wave
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location("audit", Path(__file__).with_name("audit-installation-stack.py"))
audit = importlib.util.module_from_spec(spec); spec.loader.exec_module(audit)

class AuditFixtures(unittest.TestCase):
    def row(self):
        return {k: (True if k in audit.BOOLS else [] if k in {"blockers","notes"} else "x")
                for k in audit.REQUIRED} | {"provider":"ACE_STEP","finalStatus":"READY",
                "licenseStatus":"COMMERCIAL","codeRevision":"abc123","modelRevision":"def456",
                "blockers":[],"notes":["proof"]}
    def matrix(self, row):
        retained = {
            item["provider"]: copy.deepcopy(item)
            for item in json.loads(
                Path("installation-matrix-v2.json").read_text()
            )["providers"]
            if item["provider"] in {"MIDI_SAG", "MUSE_CONTROL_LITE"}
        }
        providers = [row]
        providers.extend(
            retained[p] if p in retained else {
                "provider": p,
                "finalStatus": "BLOCKED_UPSTREAM",
                "blockers": ["blocked"],
            }
            for p in audit.EXPECTED - {"ACE_STEP"}
        )
        return {"providers":providers,
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
        r.update({"sourcePinned":True,"finalStatus":"BLOCKED_NO_WEIGHTS","assetsDownloaded":True})
        self.assertTrue(any("pinned" in x for x in audit.audit(m)))

    def test_musicgen_retained_evidence_tampering_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            worker=root/"services/musicgen-worker"
            evidence=worker/"release-evidence"
            evidence.mkdir(parents=True)
            def wav(path, samples):
                with wave.open(str(path),"wb") as handle:
                    handle.setnchannels(1); handle.setsampwidth(2); handle.setframerate(32000)
                    handle.writeframes(array.array("h",samples).tobytes())
            wav(evidence/"text-smoke.wav",[int(8000*math.sin(i/5)) for i in range(256)])
            wav(evidence/"melody-smoke.wav",[int(7000*math.sin(i/3)) for i in range(256)])
            wav(evidence/"melody-source.wav",[int(6000*math.cos(i/7)) for i in range(256)])
            sha=lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
            revision="a"*40
            inventory={"models":{"text":{"repository":"facebook/musicgen-large",
              "requestedRevision":"15ccdc9","resolvedRevision":revision,"path":"text",
              "files":[{"path":"checkpoint.bin","bytes":8,"sha256":"b"*64}]}},
              "dependencies":{}}
            (evidence/"model_manifest.json").write_text(json.dumps(inventory))
            inventory_sha=sha(evidence/"model_manifest.json")
            proof={"provider":"MUSICGEN","realInference":True,"assetManifestSha256":inventory_sha,
              "text":{"artifactSha256":sha(evidence/"text-smoke.wav"),"nonSilent":True},
              "melody":{"artifactSha256":sha(evidence/"melody-smoke.wav"),
                "sourceSha256":sha(evidence/"melody-source.wav"),"nonSilent":True,
                "notSourceCopy":True}}
            (evidence/"smoke-proof.json").write_text(json.dumps(proof))
            smoke_sha=sha(evidence/"smoke-proof.json")
            health={"status":"ready","healthy":True,"checkpointReady":True,"runtimeReady":True,
              "gpuReady":True,"smokeTested":True,"checkpointSha256":inventory_sha,
              "source":{"revision":"c"*40},"imageEvidence":"sha256:"+"d"*64}
            (evidence/"live-health.json").write_text(json.dumps(health))
            api={"id":"MUSICGEN","status":"ready","lastHealth":{"status":"healthy"}}
            (evidence/"api-catalog.json").write_text(json.dumps(api))
            (worker/"model_manifest.json").write_text(json.dumps({"source":{"revision":"c"*40}}))
            status={"providers":{"MUSICGEN_LARGE":{"evidence":{"assetManifestSha256":inventory_sha,
              "realSmokeArtifactSha256":proof["text"]["artifactSha256"],
              "liveHealthStatus":"ready","apiProviderStatus":"ready"}}}}
            (worker/"installation-status.json").write_text(json.dumps(status))
            att={"source":{"revision":"c"*40},"license":{"classification":"RESEARCH_ONLY",
              "explicitAcceptanceConfigured":True},"persistentInventory":{"sha256":inventory_sha},
              "models":{"text":{"revision":revision,"fileCount":1,"bytes":8,
                "inventorySha256":inventory_sha}},"realGpuSmoke":{"realInference":True,
                "proofSha256":smoke_sha,"text":{"nonSilent":True}},
              "liveHealth":health,"canonicalApiPath":{"providerId":"MUSICGEN","status":"ready",
                "lastHealthStatus":"healthy"},"deployment":{"sourceImageDigest":health["imageEvidence"]},
              "retainedEvidence":{"modelInventorySha256":inventory_sha,
                "smokeProofSha256":smoke_sha,
                "textOutputSha256":sha(evidence/"text-smoke.wav"),
                "melodyOutputSha256":sha(evidence/"melody-smoke.wav"),
                "melodySourceSha256":sha(evidence/"melody-source.wav"),
                "liveHealthSha256":sha(evidence/"live-health.json"),
                "apiCatalogSha256":sha(evidence/"api-catalog.json")},
              "promotion":{"required":False}}
            (worker/"release-attestation.json").write_text(json.dumps(att))
            record={"schemaVersion":1,"provider":"MUSICGEN","sourceRevision":"c"*40,
              "textModelRevision":revision,"melodyModelRevision":None,
              "endpointOrigin":None,"evidence":{name:sha(evidence/name) for name in (
                "model_manifest.json","smoke-proof.json","text-smoke.wav",
                "melody-smoke.wav","melody-source.wav","live-health.json","api-catalog.json")}}
            att["models"]["melody"]={"revision":None}
            att["deployment"]["endpointOrigin"]=None
            (worker/"release-attestation.json").write_text(json.dumps(att))
            private=evidence/"private.pem"
            public=evidence/"release-public-key.pem"
            message=evidence/"record.json"
            subprocess.run(["openssl","genpkey","-algorithm","Ed25519","-out",str(private)],check=True)
            subprocess.run(["openssl","pkey","-in",str(private),"-pubout","-out",str(public)],check=True)
            message.write_text(json.dumps(record,sort_keys=True,separators=(",",":"),ensure_ascii=False))
            signed=subprocess.run(["openssl","pkeyutl","-sign","-rawin","-inkey",str(private),
              "-in",str(message)],check=True,capture_output=True).stdout
            (evidence/"release-bundle.json").write_text(json.dumps(
              {"record":record,"signature":base64.b64encode(signed).decode()}))
            private.unlink(); message.unlink()
            row={"provider":"MUSICGEN_LARGE","finalStatus":"RESEARCH_READY","sourcePinned":True,
              "modelRevision":revision,"codeRevision":"c"*40,
              "modelRepository":"https://huggingface.co/facebook/musicgen-large"}
            with mock.patch.object(audit,"MUSICGEN_EVIDENCE_PUBLIC_KEY_SHA256",sha(public)):
                self.assertEqual(audit.evidence_errors([row],root),[])
                proof["text"]["artifactSha256"]="0"*64
                (evidence/"smoke-proof.json").write_text(json.dumps(proof))
                self.assertTrue(any("MUSICGEN" in error
                                    for error in audit.evidence_errors([row],root)))

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

    def test_lada_blocked_requires_retained_license_review(self):
        m = self.matrix(self.row())
        row = next(
            item for item in m["providers"]
            if item["provider"] == "LADA_BAND"
        )
        row.update({
            "category": "generation",
            "codeRepository": "https://github.com/Duoluoluos/TME-LaDA-Band",
            "codeRevision": "e4ff7918454d96912b366ef8e12e792b0066c1c6",
            "modelRepository": "https://huggingface.co/sDuoluoluos/LaDA-Band",
            "modelRevision": "6d444caee85385677b0652ecb0b2b8220436dd37",
            "sourcePinned": True,
            "licenseStatus": "UNVERIFIED",
            "promotionRequired": True,
            "finalStatus": "BLOCKED_LICENSE",
        })
        errors = audit.audit(m, root=Path("/definitely/missing"))
        self.assertTrue(any("LADA_BAND" in error for error in errors))

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

    def test_anyaccomp_ready_retained_evidence_passes(self):
        matrix = json.loads(Path("installation-matrix-v2.json").read_text())
        errors = audit.evidence_errors(audit.effective(matrix), Path("."))
        self.assertFalse(any(error.startswith("ANYACCOMP:") for error in errors))

    def test_anyaccomp_ready_rejects_source_identity_drift(self):
        matrix = json.loads(Path("installation-matrix-v2.json").read_text())
        drifted = copy.deepcopy(matrix)
        row = next(
            item for item in drifted["providers"]
            if item["provider"] == "ANYACCOMP"
        )
        row["codeRevision"] = "0" * 40
        errors = audit.evidence_errors(audit.effective(drifted), Path("."))
        self.assertTrue(any(error.startswith("ANYACCOMP:") for error in errors))

    def test_midi_sag_blocked_evidence_passes(self):
        matrix = json.loads(Path("installation-matrix-v2.json").read_text())
        errors = audit.evidence_errors(audit.effective(matrix), Path("."))
        self.assertFalse(
            any(error.startswith("MIDI_SAG/MUSE_CONTROL_LITE:") for error in errors)
        )

    def test_midi_sag_rejects_terminal_status_drift(self):
        matrix = json.loads(Path("installation-matrix-v2.json").read_text())
        drifted = copy.deepcopy(matrix)
        row = next(
            item for item in drifted["providers"]
            if item["provider"] == "MIDI_SAG"
        )
        row["finalStatus"] = "BLOCKED_MISSING_LICENSED_ASSET"
        errors = audit.evidence_errors(audit.effective(drifted), Path("."))
        self.assertTrue(
            any(error.startswith("MIDI_SAG/MUSE_CONTROL_LITE:") for error in errors)
        )

    def test_midi_sag_rejects_both_source_revisions_drifting(self):
        matrix = json.loads(Path("installation-matrix-v2.json").read_text())
        drifted = copy.deepcopy(matrix)
        for provider in ("MIDI_SAG", "MUSE_CONTROL_LITE"):
            row = next(
                item for item in drifted["providers"]
                if item["provider"] == provider
            )
            row["codeRevision"] = "0" * 40
        errors = audit.evidence_errors(audit.effective(drifted), Path("."))
        self.assertTrue(
            any(error.startswith("MIDI_SAG/MUSE_CONTROL_LITE:") for error in errors)
        )

    def test_midi_sag_rejects_coordinated_identity_and_status_drift(self):
        matrix = json.loads(Path("installation-matrix-v2.json").read_text())
        drifted = copy.deepcopy(matrix)
        for provider in ("MIDI_SAG", "MUSE_CONTROL_LITE"):
            row = next(
                item for item in drifted["providers"]
                if item["provider"] == provider
            )
            row["codeRepository"] = "https://example.invalid/replaced"
            row["codeRevision"] = "0" * 40
            row["finalStatus"] = "BLOCKED_LICENSE"
        errors = audit.evidence_errors(audit.effective(drifted), Path("."))
        self.assertTrue(
            any(error.startswith("MIDI_SAG/MUSE_CONTROL_LITE:") for error in errors)
        )
