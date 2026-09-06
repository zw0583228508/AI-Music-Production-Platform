import base64, hashlib, importlib.util, json, os, sys, tempfile, types, unittest
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
            output = inference.run(base64.b64encode(b"real audio").decode(),
                                   Path(self.tmp.name), 1)
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
                self.app.analyze(self.app.AnalyzeRequest(audioBase64="eA=="), request)
        self.assertEqual(raised.exception.status_code, 503)
        run_model.assert_not_called()

if __name__ == "__main__": unittest.main()