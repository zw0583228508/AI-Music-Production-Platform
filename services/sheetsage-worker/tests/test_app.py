import asyncio, hashlib, importlib.util, json, os, sys, tempfile, types, unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))

class SheetSageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ.update({"SHEETSAGE_ASSET_ROOT": self.tmp.name, "SHEETSAGE_ACCEPT_NONCOMMERCIAL_WEIGHTS": "CC-BY-NC-SA-3.0+4.0", "SHEETSAGE_API_TOKEN": "test"})
        spec = importlib.util.spec_from_file_location("sheetsage_app", ROOT / "app.py")
        self.app = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.app)
        asset = Path(self.tmp.name) / "model.bin"; asset.write_bytes(b"real-asset")
        digest = hashlib.sha256(b"real-asset").hexdigest()
        self.app.SPEC["required_asset_sha256"] = {"model.bin": digest}
        inventory = {"package": self.app.SPEC["package"], "assets": [{"path": "model.bin", "bytes": 10, "sha256": digest}]}
        (Path(self.tmp.name) / "assets.manifest.json").write_text(json.dumps(inventory))
    def tearDown(self): self.tmp.cleanup()
    def test_assets_alone_do_not_report_ready(self):
        self.assertTrue(self.app.asset_state()[0]); self.assertFalse(self.app.smoke_state()[0])

    def test_health_exposes_explicit_signed_smoke_gate(self):
        from starlette.requests import Request
        request = Request({"type": "http", "headers": [(b"authorization", b"Bearer test")]})
        with patch.object(self.app, "asset_state", return_value=(True, "ok", {})), \
             patch.object(self.app, "smoke_state", return_value=(True, "ok")), \
             patch.object(self.app, "_digest", return_value="a" * 64):
            health = self.app.health(request)
        self.assertTrue(health["smokeProofVerified"])
    def test_smoke_proof_requires_runtime_binding_and_signature(self):
        with patch.object(self.app, "runtime_identity", return_value="d" * 64):
            proof = {
                "realInference": True,
                "package": self.app.SPEC["package"],
                "assetManifestSha256": self.app._digest(self.app.ASSET_MANIFEST),
                "runtimeSha256": self.app.runtime_identity(),
                "fixtureSha256": "a" * 64,
                "outputSha256": "b" * 64,
                "evidence": {"melodyEvents": 1, "chordEvents": 1, "timingEvents": 1},
            }
            proof["signature"] = self.app.sign_smoke_proof(proof)
            (Path(self.tmp.name) / "smoke-proof.json").write_text(json.dumps(proof))
            self.assertTrue(self.app.smoke_state()[0])
            proof["runtimeSha256"] = "c" * 64
            (Path(self.tmp.name) / "smoke-proof.json").write_text(json.dumps(proof))
            self.assertFalse(self.app.smoke_state()[0])
    def test_runtime_identity_changes_when_same_version_package_content_changes(self):
        with patch.object(self.app, "version", return_value="same-version"), \
             patch.object(self.app, "distribution_digest", return_value="a" * 64):
            first = self.app.runtime_identity()
        with patch.object(self.app, "version", return_value="same-version"), \
             patch.object(self.app, "distribution_digest", return_value="b" * 64):
            second = self.app.runtime_identity()
        self.assertNotEqual(first, second)
    def test_output_requires_actual_melody_chords_and_timing(self):
        with self.assertRaises(self.app.InferenceError):
            self.app.validate_evidence({"melody": [], "chords": [], "timing": [], "confidence": .5})
        output = self.app.validate_evidence({"melody":[{"start":0,"end":1,"pitch":60,"confidence":.9}],"chords":[{"start":0,"end":1,"symbol":"Cmaj7","confidence":.8}],"timing":[{"start":0,"end":1}],"confidence":.8})
        self.assertEqual(output["chords"][0]["symbol"], "Cmaj7")
    def test_direct_public_api_contract_returns_model_evidence(self):
        import inference
        called = {}
        class Note:
            def as_midi_pitch(self): return 60
        class Root:
            def as_human_pitch_name(self, enharmonics="b"): return "C"
        lead_sheet = [None, None, None, [(0, (Root(), (4, 3)))],
                      [(0, 4, Note())], 4]
        logits = [[[0.0, 4.0]], [[0.0, 3.0]]]
        fake_result = (lead_sheet, [0, 1], [0.0, 0.5], [object()],
                       [logits[0]], [logits[1]])
        sheetsage = types.ModuleType("sheetsage")
        sheetsage_assets = types.ModuleType("sheetsage.assets")
        sheetsage_beat = types.ModuleType("sheetsage.beat_track")
        sheetsage_infer = types.ModuleType("sheetsage.infer")
        sheetsage_align = types.ModuleType("sheetsage.align")
        madmom = types.ModuleType("madmom_infer")
        madmom_models = types.ModuleType("madmom_infer.models")
        sheetsage.assets = sheetsage_assets
        sheetsage.beat_track = sheetsage_beat
        madmom.models = madmom_models
        def official_api(audio, **kwargs):
            called.update({"audio": audio, **kwargs}); return fake_result
        sheetsage_infer.sheetsage = official_api
        sheetsage_align.create_beat_to_time_fn = lambda beats, times: lambda beat: beat * .5
        modules = {"sheetsage": sheetsage, "sheetsage.assets": sheetsage_assets,
                   "sheetsage.beat_track": sheetsage_beat, "sheetsage.infer": sheetsage_infer,
                   "sheetsage.align": sheetsage_align, "madmom_infer": madmom,
                   "madmom_infer.models": madmom_models}
        with patch.dict(sys.modules, modules), patch.object(
            inference, "version", side_effect=lambda name: {
                "sheetsage-infer": "0.2.1", "jukebox-infer": "0.1.2",
                "madmom-infer": "0.2.0"}[name]
        ):
            audio_path = Path(self.tmp.name) / "source.audio"
            audio_path.write_bytes(b"real audio")
            output = inference.run(audio_path, Path(self.tmp.name), 1)
        self.assertEqual(called["use_jukebox"], False)
        self.assertEqual(called["return_intermediaries"], True)
        self.assertEqual(output["chords"][0]["symbol"], "C")
        self.assertGreater(output["melody"][0]["confidence"], .9)

    def test_analyze_endpoint_fails_closed_before_inference(self):
        from starlette.requests import Request
        request = Request({"type": "http", "headers": [(b"authorization", b"Bearer test")]})
        with patch.object(self.app, "asset_state", return_value=(False, "blocked", None)), \
             patch.object(self.app, "run") as run_model:
            with self.assertRaises(self.app.HTTPException) as raised:
                asyncio.run(self.app.analyze(request))
        self.assertEqual(raised.exception.status_code, 503)
        run_model.assert_not_called()

    def test_analyze_streams_audio_to_a_temporary_file(self):
        from starlette.requests import Request
        chunks = iter((b"long-", b"recording"))
        async def receive():
            try:
                return {"type": "http.request", "body": next(chunks), "more_body": True}
            except StopIteration:
                return {"type": "http.request", "body": b"", "more_body": False}
        request = Request({
            "type": "http",
            "method": "POST",
            "headers": [(b"authorization", b"Bearer test")],
        }, receive)
        evidence = {"melody":[{"start":0,"end":1,"pitch":60,"confidence":.9}],
                    "chords":[{"start":0,"end":1,"symbol":"C","confidence":.8}],
                    "timing":[{"start":0,"end":1}],"confidence":.8}
        observed = {}
        async def fake_run_in_threadpool(function, path, *_args):
            observed["path"] = path
            observed["audio"] = path.read_bytes()
            return function(path, *_args)
        with patch.object(self.app, "asset_state", return_value=(True, "ready", {})), \
             patch.object(self.app, "smoke_state", return_value=(True, "ready")), \
             patch.object(self.app, "run", return_value=evidence), \
             patch.object(self.app, "run_in_threadpool", side_effect=fake_run_in_threadpool):
            output = asyncio.run(self.app.analyze(request))
        self.assertEqual(observed["audio"], b"long-recording")
        self.assertFalse(observed["path"].exists())
        self.assertEqual(output["melody"][0]["pitch"], 60)

    def test_analyze_rejects_declared_oversize_before_reading(self):
        from starlette.requests import Request
        request = Request({
            "type": "http",
            "method": "POST",
            "headers": [
                (b"authorization", b"Bearer test"),
                (b"content-length", str(self.app.MAX_AUDIO_BYTES + 1).encode()),
            ],
        })
        with patch.object(self.app, "asset_state", return_value=(True, "ready", {})), \
             patch.object(self.app, "smoke_state", return_value=(True, "ready")), \
             patch.object(self.app, "run") as run_model:
            with self.assertRaises(self.app.HTTPException) as raised:
                asyncio.run(self.app.analyze(request))
        self.assertEqual(raised.exception.status_code, 413)
        run_model.assert_not_called()

if __name__ == "__main__": unittest.main()
