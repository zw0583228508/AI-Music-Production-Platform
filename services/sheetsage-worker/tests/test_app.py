import asyncio, fcntl, hashlib, importlib.util, json, os, subprocess, sys, tempfile, traceback, types, unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))

class SheetSageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ.update({"SHEETSAGE_ASSET_ROOT": self.tmp.name, "SHEETSAGE_ACCEPT_NONCOMMERCIAL_WEIGHTS": "CC-BY-NC-SA-3.0+4.0", "SHEETSAGE_API_TOKEN": "test"})
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ.update({"SHEETSAGE_ASSET_ROOT": self.tmp.name, "SHEETSAGE_PRIVATE_TEMP_ROOT": str(Path(self.tmp.name) / "private-audio"), "SHEETSAGE_ACCEPT_NONCOMMERCIAL_WEIGHTS": "CC-BY-NC-SA-3.0+4.0", "SHEETSAGE_API_TOKEN": "test"})
        spec = importlib.util.spec_from_file_location("sheetsage_app", ROOT / "app.py")
        self.app = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.app)
        asset = Path(self.tmp.name) / "model.bin"; asset.write_bytes(b"real-asset")
        digest = hashlib.sha256(b"real-asset").hexdigest()
        self.app.SPEC["required_asset_sha256"] = {"model.bin": digest}
        inventory = {"package": self.app.SPEC["package"], "assets": [{"path": "model.bin", "bytes": 10, "sha256": digest}]}
        (Path(self.tmp.name) / "assets.manifest.json").write_text(json.dumps(inventory))

    def tearDown(self): self.tmp.cleanup()

    def _request(self, chunks, *, authorization=b"Bearer test"):
        from starlette.requests import Request
        messages = iter(chunks)
        async def receive():
            message = next(messages)
            if isinstance(message, BaseException):
                raise message
            return {
                "type": "http.request",
                "body": message,
                "more_body": message != b"",
            }
        return Request({
            "type": "http",
            "method": "POST",
            "headers": [(b"authorization", authorization)],
        }, receive)

    def _tracked_temporary_files(self):
        created = []
        original = tempfile.NamedTemporaryFile
        def tracked(*args, **kwargs):
            kwargs["dir"] = self.tmp.name
            target = original(*args, **kwargs)
            created.append(Path(target.name))
            return target
        return created, tracked

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

    def test_interrupted_chunked_upload_removes_partial_audio(self):
        request = self._request((b"first-", b"second-", RuntimeError("upload interrupted")))
        created, tracked = self._tracked_temporary_files()
        with patch.object(self.app, "asset_state", return_value=(True, "ready", {})), \
             patch.object(self.app, "smoke_state", return_value=(True, "ready")), \
             patch.object(self.app.tempfile, "NamedTemporaryFile", side_effect=tracked), \
             patch.object(self.app, "run") as run_model:
            with self.assertRaisesRegex(RuntimeError, "upload interrupted"):
                asyncio.run(self.app.analyze(request))
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())
        run_model.assert_not_called()

    def test_request_cancellation_removes_partial_audio(self):
        request = self._request((b"first-", b"second-", asyncio.CancelledError()))
        created, tracked = self._tracked_temporary_files()
        with patch.object(self.app, "asset_state", return_value=(True, "ready", {})), \
             patch.object(self.app, "smoke_state", return_value=(True, "ready")), \
             patch.object(self.app.tempfile, "NamedTemporaryFile", side_effect=tracked), \
             patch.object(self.app, "run") as run_model:
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(self.app.analyze(request))
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())
        run_model.assert_not_called()

    def test_inference_failure_removes_completed_upload(self):
        request = self._request((b"first-", b"second-", b""))
        created, tracked = self._tracked_temporary_files()
        async def fake_run_in_threadpool(function, path, *_args):
            return function(path, *_args)
        with patch.object(self.app, "asset_state", return_value=(True, "ready", {})), \
             patch.object(self.app, "smoke_state", return_value=(True, "ready")), \
             patch.object(self.app.tempfile, "NamedTemporaryFile", side_effect=tracked), \
             patch.object(self.app, "run", side_effect=self.app.InferenceError("bad audio")), \
             patch.object(self.app, "run_in_threadpool", side_effect=fake_run_in_threadpool):
            with self.assertRaises(self.app.HTTPException) as raised:
                asyncio.run(self.app.analyze(request))
        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())

    def test_streamed_size_limit_removes_partial_audio(self):
        request = self._request((b"first", b"second"))
        created, tracked = self._tracked_temporary_files()
        with patch.object(self.app, "MAX_AUDIO_BYTES", 8), \
             patch.object(self.app, "asset_state", return_value=(True, "ready", {})), \
             patch.object(self.app, "smoke_state", return_value=(True, "ready")), \
             patch.object(self.app.tempfile, "NamedTemporaryFile", side_effect=tracked), \
             patch.object(self.app, "run") as run_model:
            with self.assertRaises(self.app.HTTPException) as raised:
                asyncio.run(self.app.analyze(request))
        self.assertEqual(raised.exception.status_code, 413)
        self.assertEqual(raised.exception.detail, "audio payload exceeds 512 MiB")
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())
        run_model.assert_not_called()

    def test_authentication_rejection_does_not_create_partial_audio(self):
        request = self._request((b"private-audio",), authorization=b"Bearer wrong")
        created, tracked = self._tracked_temporary_files()
        with patch.object(self.app.tempfile, "NamedTemporaryFile", side_effect=tracked), \
             patch.object(self.app, "run") as run_model:
            with self.assertRaises(self.app.HTTPException) as raised:
                asyncio.run(self.app.analyze(request))
        self.assertEqual(raised.exception.status_code, 401)
        self.assertEqual(created, [])
        run_model.assert_not_called()

    def test_analyze_rejects_busy_capacity_before_reading_and_is_retryable(self):
        from starlette.requests import Request
        received = False
        async def receive():
            nonlocal received
            received = True
            return {"type": "http.request", "body": b"audio", "more_body": False}
        request = Request({
            "type": "http", "method": "POST",
            "headers": [(b"authorization", b"Bearer test")],
        }, receive)
        held = self.app.SPOOL_RESERVATIONS.acquire()
        self.assertIsNotNone(held)
        rejections_before = self.app.SPOOL_RESERVATIONS.state()[
            "capacityAdmissionRejections"
        ]
        try:
            with patch.object(self.app, "asset_state", return_value=(True, "ready", {})), \
                 patch.object(self.app, "smoke_state", return_value=(True, "ready")):
                with self.assertRaises(self.app.HTTPException) as raised:
                    asyncio.run(self.app.analyze(request))
        finally:
            self.app.SPOOL_RESERVATIONS.release(held)
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.headers["Retry-After"], "30")
        self.assertEqual(
            raised.exception.headers["X-SheetSage-Rejection"],
            "capacity-admission",
        )
        self.assertFalse(received)
        state = self.app.SPOOL_RESERVATIONS.state()
        self.assertEqual(
            state["capacityAdmissionRejections"],
            rejections_before + 1,
        )
        self.assertIsInstance(state["lastCapacityAdmissionRejectionAt"], int)

    def test_reservation_rejects_when_free_disk_cannot_cover_upload_and_headroom(self):
        disk = types.SimpleNamespace(
            total=self.app.MAX_AUDIO_BYTES * 2,
            used=self.app.MAX_AUDIO_BYTES,
            free=self.app.MAX_AUDIO_BYTES + self.app.TEMP_DISK_HEADROOM_BYTES - 1,
        )
        with patch.object(self.app.shutil, "disk_usage", return_value=disk):
            self.assertIsNone(self.app.SPOOL_RESERVATIONS.acquire())
            state = self.app.SPOOL_RESERVATIONS.state()
        self.assertEqual(state["activeSpooledAnalyses"], 0)
        self.assertEqual(state["temporaryDiskReservableBytes"], self.app.MAX_AUDIO_BYTES - 1)

    def test_failed_upload_releases_reservation_and_health_reports_capacity(self):
        from starlette.requests import Request
        async def receive():
            raise asyncio.CancelledError()
        request = Request({
            "type": "http", "method": "POST",
            "headers": [(b"authorization", b"Bearer test")],
        }, receive)
        with patch.object(self.app, "asset_state", return_value=(True, "ready", {})), \
             patch.object(self.app, "smoke_state", return_value=(True, "ready")):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(self.app.analyze(request))
        state = self.app.SPOOL_RESERVATIONS.state()
        self.assertEqual(state["activeSpooledAnalyses"], 0)
        self.assertEqual(state["reservedUploadBytes"], 0)
        self.assertIn("temporaryDiskFreeBytes", state)
        self.assertIn("temporaryDiskReservableBytes", state)

    def test_startup_cleans_stale_uploads_but_preserves_live_worker_files(self):
        root = self.app.PRIVATE_TEMP_ROOT
        stale = root / "worker-99999999-abandoned"
        stale.mkdir(parents=True)
        (stale / "upload-private.wav").write_bytes(b"private")
        live = root / "worker-live"
        live.mkdir()
        live_lock = (live / ".active.lock").open("a+b")
        fcntl.flock(live_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = live / "upload-current.wav"
        current.write_bytes(b"current")

        try:
            process_dir = self.app.initialize_private_temp_storage()
        finally:
            live_lock.close()

        self.assertFalse(stale.exists())
        self.assertEqual(current.read_bytes(), b"current")
        self.assertTrue(process_dir.is_dir())
        self.assertEqual(process_dir.stat().st_mode & 0o777, 0o700)

    def test_startup_cleanup_failure_is_explicit_and_does_not_expose_path(self):
        private_name = "private-customer-recording.wav"
        with patch.object(self.app.Path, "mkdir", side_effect=PermissionError(private_name)), \
             self.assertLogs("sheetsage-worker", level="ERROR") as captured:
            with self.assertRaises(RuntimeError) as raised:
                self.app.initialize_private_temp_storage()
        rendered = "".join(traceback.format_exception(raised.exception))
        combined = " ".join(captured.output) + rendered
        self.assertNotIn(private_name, combined)
        self.assertIn("private temporary storage", str(raised.exception))
        self.assertIsNone(raised.exception.__cause__)

    def test_concurrent_worker_startup_preserves_live_private_upload(self):
        root = Path(self.tmp.name) / "shared-private-audio"
        script = """
import importlib.util, os, sys
from pathlib import Path
root = Path(sys.argv[1])
module_path = Path(sys.argv[2])
os.environ["SHEETSAGE_PRIVATE_TEMP_ROOT"] = str(root)
sys.path.insert(0, str(module_path.parent))
spec = importlib.util.spec_from_file_location("concurrent_sheetsage_app", module_path)
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)
process_dir = app.initialize_private_temp_storage()
if sys.argv[3] == "hold":
    (process_dir / "current.audio").write_bytes(b"private")
    print(process_dir, flush=True)
    sys.stdin.read()
else:
    live_uploads = list(root.glob("worker-*/current.audio"))
    print(len(live_uploads), flush=True)
"""
        environment = os.environ.copy()
        first = subprocess.Popen(
            [sys.executable, "-c", script, str(root), str(ROOT / "app.py"), "hold"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=environment,
        )
        try:
            self.assertTrue(first.stdout.readline().strip())
            second = subprocess.run(
                [sys.executable, "-c", script, str(root), str(ROOT / "app.py"), "check"],
                capture_output=True,
                text=True,
                timeout=10,
                env=environment,
                check=True,
            )
            self.assertEqual(second.stdout.strip(), "1")
        finally:
            first.terminate()
            first.communicate(timeout=10)

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

    def test_interrupted_chunked_upload_removes_partial_audio(self):
        request = self._request((b"first-", b"second-", RuntimeError("upload interrupted")))
        created, tracked = self._tracked_temporary_files()
        with patch.object(self.app, "asset_state", return_value=(True, "ready", {})), \
             patch.object(self.app, "smoke_state", return_value=(True, "ready")), \
             patch.object(self.app.tempfile, "NamedTemporaryFile", side_effect=tracked), \
             patch.object(self.app, "run") as run_model:
            with self.assertRaisesRegex(RuntimeError, "upload interrupted"):
                asyncio.run(self.app.analyze(request))
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())
        run_model.assert_not_called()

    def test_request_cancellation_removes_partial_audio(self):
        request = self._request((b"first-", b"second-", asyncio.CancelledError()))
        created, tracked = self._tracked_temporary_files()
        with patch.object(self.app, "asset_state", return_value=(True, "ready", {})), \
             patch.object(self.app, "smoke_state", return_value=(True, "ready")), \
             patch.object(self.app.tempfile, "NamedTemporaryFile", side_effect=tracked), \
             patch.object(self.app, "run") as run_model:
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(self.app.analyze(request))
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())
        run_model.assert_not_called()

    def test_inference_failure_removes_completed_upload(self):
        request = self._request((b"first-", b"second-", b""))
        created, tracked = self._tracked_temporary_files()
        async def fake_run_in_threadpool(function, path, *_args):
            return function(path, *_args)
        with patch.object(self.app, "asset_state", return_value=(True, "ready", {})), \
             patch.object(self.app, "smoke_state", return_value=(True, "ready")), \
             patch.object(self.app.tempfile, "NamedTemporaryFile", side_effect=tracked), \
             patch.object(self.app, "run", side_effect=self.app.InferenceError("bad audio")), \
             patch.object(self.app, "run_in_threadpool", side_effect=fake_run_in_threadpool):
            with self.assertRaises(self.app.HTTPException) as raised:
                asyncio.run(self.app.analyze(request))
        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())

    def test_streamed_size_limit_removes_partial_audio(self):
        request = self._request((b"first", b"second"))
        created, tracked = self._tracked_temporary_files()
        with patch.object(self.app, "MAX_AUDIO_BYTES", 8), \
             patch.object(self.app, "asset_state", return_value=(True, "ready", {})), \
             patch.object(self.app, "smoke_state", return_value=(True, "ready")), \
             patch.object(self.app.tempfile, "NamedTemporaryFile", side_effect=tracked), \
             patch.object(self.app, "run") as run_model:
            with self.assertRaises(self.app.HTTPException) as raised:
                asyncio.run(self.app.analyze(request))
        self.assertEqual(raised.exception.status_code, 413)
        self.assertEqual(raised.exception.detail, "audio payload exceeds 512 MiB")
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())
        run_model.assert_not_called()

    def test_authentication_rejection_does_not_create_partial_audio(self):
        request = self._request((b"private-audio",), authorization=b"Bearer wrong")
        created, tracked = self._tracked_temporary_files()
        with patch.object(self.app.tempfile, "NamedTemporaryFile", side_effect=tracked), \
             patch.object(self.app, "run") as run_model:
            with self.assertRaises(self.app.HTTPException) as raised:
                asyncio.run(self.app.analyze(request))
        self.assertEqual(raised.exception.status_code, 401)
        self.assertEqual(created, [])
        run_model.assert_not_called()

    def test_analyze_rejects_busy_capacity_before_reading_and_is_retryable(self):
        from starlette.requests import Request
        received = False
        async def receive():
            nonlocal received
            received = True
            return {"type": "http.request", "body": b"audio", "more_body": False}
        request = Request({
            "type": "http", "method": "POST",
            "headers": [(b"authorization", b"Bearer test")],
        }, receive)
        held = self.app.SPOOL_RESERVATIONS.acquire()
        self.assertIsNotNone(held)
        rejections_before = self.app.SPOOL_RESERVATIONS.state()[
            "capacityAdmissionRejections"
        ]
        try:
            with patch.object(self.app, "asset_state", return_value=(True, "ready", {})), \
                 patch.object(self.app, "smoke_state", return_value=(True, "ready")):
                with self.assertRaises(self.app.HTTPException) as raised:
                    asyncio.run(self.app.analyze(request))
        finally:
            self.app.SPOOL_RESERVATIONS.release(held)
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.headers["Retry-After"], "30")
        self.assertEqual(
            raised.exception.headers["X-SheetSage-Rejection"],
            "capacity-admission",
        )
        self.assertFalse(received)
        state = self.app.SPOOL_RESERVATIONS.state()
        self.assertEqual(
            state["capacityAdmissionRejections"],
            rejections_before + 1,
        )
        self.assertIsInstance(state["lastCapacityAdmissionRejectionAt"], int)

    def test_reservation_rejects_when_free_disk_cannot_cover_upload_and_headroom(self):
        disk = types.SimpleNamespace(
            total=self.app.MAX_AUDIO_BYTES * 2,
            used=self.app.MAX_AUDIO_BYTES,
            free=self.app.MAX_AUDIO_BYTES + self.app.TEMP_DISK_HEADROOM_BYTES - 1,
        )
        with patch.object(self.app.shutil, "disk_usage", return_value=disk):
            self.assertIsNone(self.app.SPOOL_RESERVATIONS.acquire())
            state = self.app.SPOOL_RESERVATIONS.state()
        self.assertEqual(state["activeSpooledAnalyses"], 0)
        self.assertEqual(state["temporaryDiskReservableBytes"], self.app.MAX_AUDIO_BYTES - 1)

    def test_failed_upload_releases_reservation_and_health_reports_capacity(self):
        from starlette.requests import Request
        async def receive():
            raise asyncio.CancelledError()
        request = Request({
            "type": "http", "method": "POST",
            "headers": [(b"authorization", b"Bearer test")],
        }, receive)
        with patch.object(self.app, "asset_state", return_value=(True, "ready", {})), \
             patch.object(self.app, "smoke_state", return_value=(True, "ready")):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(self.app.analyze(request))
        state = self.app.SPOOL_RESERVATIONS.state()
        self.assertEqual(state["activeSpooledAnalyses"], 0)
        self.assertEqual(state["reservedUploadBytes"], 0)
        self.assertIn("temporaryDiskFreeBytes", state)
        self.assertIn("temporaryDiskReservableBytes", state)

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

    def test_interrupted_chunked_upload_removes_partial_audio(self):
        request = self._request((b"first-", b"second-", RuntimeError("upload interrupted")))
        created, tracked = self._tracked_temporary_files()
        with patch.object(self.app, "asset_state", return_value=(True, "ready", {})), \
             patch.object(self.app, "smoke_state", return_value=(True, "ready")), \
             patch.object(self.app.tempfile, "NamedTemporaryFile", side_effect=tracked), \
             patch.object(self.app, "run") as run_model:
            with self.assertRaisesRegex(RuntimeError, "upload interrupted"):
                asyncio.run(self.app.analyze(request))
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())
        run_model.assert_not_called()

    def test_request_cancellation_removes_partial_audio(self):
        request = self._request((b"first-", b"second-", asyncio.CancelledError()))
        created, tracked = self._tracked_temporary_files()
        with patch.object(self.app, "asset_state", return_value=(True, "ready", {})), \
             patch.object(self.app, "smoke_state", return_value=(True, "ready")), \
             patch.object(self.app.tempfile, "NamedTemporaryFile", side_effect=tracked), \
             patch.object(self.app, "run") as run_model:
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(self.app.analyze(request))
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())
        run_model.assert_not_called()

    def test_inference_failure_removes_completed_upload(self):
        request = self._request((b"first-", b"second-", b""))
        created, tracked = self._tracked_temporary_files()
        async def fake_run_in_threadpool(function, path, *_args):
            return function(path, *_args)
        with patch.object(self.app, "asset_state", return_value=(True, "ready", {})), \
             patch.object(self.app, "smoke_state", return_value=(True, "ready")), \
             patch.object(self.app.tempfile, "NamedTemporaryFile", side_effect=tracked), \
             patch.object(self.app, "run", side_effect=self.app.InferenceError("bad audio")), \
             patch.object(self.app, "run_in_threadpool", side_effect=fake_run_in_threadpool):
            with self.assertRaises(self.app.HTTPException) as raised:
                asyncio.run(self.app.analyze(request))
        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())

    def test_streamed_size_limit_removes_partial_audio(self):
        request = self._request((b"first", b"second"))
        created, tracked = self._tracked_temporary_files()
        with patch.object(self.app, "MAX_AUDIO_BYTES", 8), \
             patch.object(self.app, "asset_state", return_value=(True, "ready", {})), \
             patch.object(self.app, "smoke_state", return_value=(True, "ready")), \
             patch.object(self.app.tempfile, "NamedTemporaryFile", side_effect=tracked), \
             patch.object(self.app, "run") as run_model:
            with self.assertRaises(self.app.HTTPException) as raised:
                asyncio.run(self.app.analyze(request))
        self.assertEqual(raised.exception.status_code, 413)
        self.assertEqual(raised.exception.detail, "audio payload exceeds 512 MiB")
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())
        run_model.assert_not_called()

    def test_authentication_rejection_does_not_create_partial_audio(self):
        request = self._request((b"private-audio",), authorization=b"Bearer wrong")
        created, tracked = self._tracked_temporary_files()
        with patch.object(self.app.tempfile, "NamedTemporaryFile", side_effect=tracked), \
             patch.object(self.app, "run") as run_model:
            with self.assertRaises(self.app.HTTPException) as raised:
                asyncio.run(self.app.analyze(request))
        self.assertEqual(raised.exception.status_code, 401)
        self.assertEqual(created, [])
        run_model.assert_not_called()

if __name__ == "__main__": unittest.main()
