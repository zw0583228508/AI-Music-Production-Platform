import json,subprocess,tempfile,unittest
from pathlib import Path
import numpy as np
import soundfile as sf
from smoke import (
 COPY_LIKE_CORRELATION_THRESHOLD,
 COPY_LIKE_DIFFERENCE_THRESHOLD,
 signal_comparison,
)
ROOT=Path(__file__).parents[1]

def music_fixture(kind,sample_rate,channels):
 time=np.arange(sample_rate*4,dtype=np.float64)/sample_rate
 if kind=="melodic":
  envelope=.35+.65*np.sin(np.pi*np.minimum(time%1.0,.999))**2
  mono=envelope*(.38*np.sin(2*np.pi*(196*time+7*time*time))+
                 .19*np.sin(2*np.pi*293.66*time)+
                 .11*np.sin(2*np.pi*440*time))
 else:
  rng=np.random.default_rng(174)
  phase=time%0.5
  kick=np.sin(2*np.pi*(95*phase-55*phase*phase))*np.exp(-phase*15)
  hats=rng.normal(0,1,len(time))*np.exp(-(time%0.25)*45)
  mono=.52*kick+.055*hats
 if channels==1:
  return mono
 delayed=np.concatenate((np.zeros(max(1,sample_rate//400)),mono))[:len(mono)]
 return np.column_stack((mono,.82*delayed))

def encode_with_ffmpeg(source,target,encoder,quality):
 command=["ffmpeg","-hide_banner","-loglevel","error","-y","-i",str(source),
          "-c:a",encoder,*quality,str(target)]
 subprocess.run(command,check=True,capture_output=True,text=True)

def decode_with_ffmpeg(source,target):
 subprocess.run(
  ["ffmpeg","-hide_banner","-loglevel","error","-y","-i",str(source),str(target)],
  check=True,capture_output=True,text=True,
 )

class DiffRhythmContract(unittest.TestCase):
 def test_immutable_manifest_and_license(self):
  m=json.loads((ROOT/"model_manifest.json").read_text())
  self.assertEqual(m["provider"],"DIFFRHYTHM_2")
  self.assertEqual(m["license"]["status"],"RESEARCH_ONLY")
  self.assertFalse(m["license"]["commercial_use_permitted"])
  self.assertEqual(
   next(x for x in m["models"] if x["repository"]=="OpenMuQ/MuQ-MuLan-large")["license"],
   "CC-BY-NC-4.0",
  )
  self.assertEqual(len(m["source"]["revision"]),40); self.assertNotIn("main",json.dumps(m))
 def test_private_provisioning_only_contract(self):
  source=(ROOT/"modal_provision.py").read_text(); config=(ROOT/"modal_config.py").read_text()
  self.assertIn("private",config); self.assertIn("bootstrap_assets.py",source)
  self.assertIn('RUNTIME_SECRET_NAME="music-ai-worker-runtime"',config)
  self.assertNotIn("diffrhythm2-runtime-v1",config)
  self.assertIn("HF_HUB_OFFLINE=1", (ROOT/"Dockerfile").read_text())
 def test_image_verifies_checkout_and_prints_requirements_before_install(self):
  docker=(ROOT/"Dockerfile").read_text()
  revision="13a7b091f45124f611e36ee674973234f38d55b6"
  self.assertIn('actual_revision="$(git -C /opt/diffrhythm2 rev-parse HEAD)"',docker)
  self.assertNotIn("$$(git -C /opt/diffrhythm2 rev-parse HEAD)",docker)
  self.assertIn(f'test "${{actual_revision}}" = "{revision}"',docker)
  inspection=docker.index("cat /opt/diffrhythm2/requirements.txt")
  installation=docker.index("pip install --no-cache-dir -r /opt/diffrhythm2/requirements.txt")
  self.assertLess(inspection,installation)
 def test_image_has_native_build_toolchain_for_pinned_pyopenjtalk(self):
  docker=(ROOT/"Dockerfile").read_text()
  install=next(line for line in docker.splitlines() if "apt-get install" in line)
  self.assertIn("build-essential",install)
  self.assertIn("cmake",install)
  self.assertIn("python3.11-dev",install)
  self.assertIn("inflect==7.5.0",(ROOT/"Dockerfile").read_text())
 def test_modal_python_detection_uses_the_exact_venv_interpreter(self):
  docker=(ROOT/"Dockerfile").read_text()
  modal_app=(ROOT/"modal_app.py").read_text()
  target="/opt/diffrhythm2-venv/bin/python"
  for command in ("python","python3","python3.11"):
   self.assertIn(f"ln -s {target} /usr/local/bin/{command}",docker)
  self.assertIn("assert sys.version_info[:2] == (3, 11)",docker)
  self.assertIn(f'CMD ["{target}","-m","uvicorn"',docker)
  self.assertIn("nvidia/cuda@sha256:",docker)
  self.assertIn("modal.Image.from_id(DEPLOYMENT_BASE_IMAGE_ID)",modal_app)
  self.assertIn("modal_app.py",(ROOT/"modal_config.py").read_text())
  self.assertIn("modal_config.py",(ROOT/"modal_config.py").read_text())
  self.assertIn('"PYTHONPATH": "/opt/diffrhythm2-venv/lib/python3.11/site-packages"',modal_app)
 def test_bearer_token_prefers_provider_specific_then_shared_runtime(self):
  source=(ROOT/"app.py").read_text()
  provider=source.index('os.getenv("DIFFRHYTHM2_API_TOKEN")')
  shared=source.index('os.getenv("MUSIC_AI_WORKER_TOKEN")',provider)
  self.assertLess(provider,shared)
  self.assertIn('(os.getenv("DIFFRHYTHM2_API_TOKEN") or "").strip() or (os.getenv("MUSIC_AI_WORKER_TOKEN") or "").strip()',source)
 def test_real_smoke_and_offline_serving_gates_remain_enforced(self):
  app=(ROOT/"app.py").read_text(); smoke=(ROOT/"smoke.py").read_text()
  provision=(ROOT/"modal_provision.py").read_text()
  audit=(ROOT.parents[1]/"scripts/audit-installation-stack.py").read_text()
  self.assertIn('proof["realInference"] is True',app)
  self.assertIn('proof["nonSilent"] is True',app)
  self.assertIn('proof["notSourceCopy"] is True',app)
  self.assertIn('"lyricsConditioned":True',smoke)
  self.assertIn('"rhythmConditioned":True',smoke)
  self.assertIn('"signalComparison":comparison',smoke)
  self.assertIn('absolute_correlation < COPY_LIKE_CORRELATION_THRESHOLD',smoke)
  self.assertIn('"bounded-offset-normalized-cross-correlation-v2"',audit)
  self.assertNotIn('comparison.get("passesNotSourceCopy")',audit)
  self.assertIn("def smoke_real_audio():",provision)
  self.assertIn("smoke_image = image.add_local_file(",provision)
  self.assertIn("image=smoke_image",provision)
  self.assertIn('"DIFFRHYTHM2_SMOKE_AUDIO": fixture',provision)
  self.assertIn("completed.stdout + \" \" + completed.stderr",provision)
  runner=(ROOT/"upstream_runner.py").read_text()
  self.assertIn("weights_only=True",runner)
  self.assertIn('mulan_config["audio_model"]["name"] = str(muq_root)',runner)
  self.assertIn("upstream.lrc_tokenizer = tokenizer",runner)
  self.assertIn("fake_stereo=False",runner)
  self.assertNotIn('"--fake-stereo", "False"',(ROOT/"inference.py").read_text())
  self.assertIn('"licenseStatus":"RESEARCH_ONLY"',app)
  self.assertIn('"commercialUsePermitted":False',app)
  self.assertNotIn('"license":"Apache-2.0"}',app)

 def test_source_copy_detection_handles_transforms_and_offsets(self):
  sample_rate=16000
  time=np.arange(sample_rate*3,dtype=np.float64)/sample_rate
  source=(
   .45*np.sin(2*np.pi*(180*time+35*time*time))
   +.2*np.sin(2*np.pi*613*time)
   +.08*np.sin(2*np.pi*997*time)
  )
  rng=np.random.default_rng(169)
  unrelated=rng.normal(0,.25,len(source))
  with tempfile.TemporaryDirectory() as directory:
   directory=Path(directory)
   source_path=directory/"source.wav"
   sf.write(source_path,source,sample_rate,subtype="PCM_16")
   cases={
    "direct-copy.wav":source,
    "gain-change.wav":source*.35,
    "polarity-inversion.wav":-source,
    "leading-silence.wav":np.concatenate((np.zeros(sample_rate),source)),
    "time-shift.wav":np.concatenate((source[sample_rate//2:],np.zeros(sample_rate//2))),
    "unrelated.wav":unrelated,
   }
   results={}
   for name,audio in cases.items():
    path=directory/name
    sf.write(path,audio,sample_rate,subtype="PCM_16")
    results[name]=signal_comparison(source_path,path)
   mp3_path=directory/"reencoded.mp3"
   sf.write(mp3_path,source,sample_rate,format="MP3")
   results["reencoded.mp3"]=signal_comparison(source_path,mp3_path)
  for name in cases.keys()-{"unrelated.wav"}:
   self.assertFalse(results[name]["passesNotSourceCopy"],name)
   self.assertGreaterEqual(results[name]["absoluteWaveformCorrelation"],.95,name)
  self.assertFalse(results["reencoded.mp3"]["passesNotSourceCopy"])
  self.assertTrue(results["unrelated.wav"]["passesNotSourceCopy"])
  self.assertLess(results["leading-silence.wav"]["strongestOffsetSeconds"],1.01)
  self.assertGreater(results["leading-silence.wav"]["strongestOffsetSeconds"],.99)

 def test_source_copy_thresholds_have_margin_across_real_codecs(self):
  # These settings intentionally span the sample rates, layouts, and lossy
  # quality modes shipped by the worker's apt-installed FFmpeg.
  codec_cases=(
   ("mp3-64k.mp3",16000,1,"libmp3lame",("-b:a","64k")),
   ("mp3-v2.mp3",44100,2,"libmp3lame",("-q:a","2")),
   ("aac-64k.aac",22050,1,"aac",("-b:a","64k")),
   ("aac-160k.aac",44100,2,"aac",("-b:a","160k")),
   ("opus-48k.ogg",24000,1,"libopus",("-b:a","48k")),
   ("opus-128k.ogg",48000,2,"libopus",("-b:a","128k")),
  )
  copy_correlation_floor=.97
  copy_difference_ceiling=.18
  unrelated_correlation_ceiling=.35
  unrelated_difference_floor=.80
  self.assertGreater(
   copy_correlation_floor-COPY_LIKE_CORRELATION_THRESHOLD,.019,
   "copy corpus must retain at least 0.02 correlation margin",
  )
  self.assertGreater(
   COPY_LIKE_DIFFERENCE_THRESHOLD-copy_difference_ceiling,.069,
   "copy corpus must retain at least 0.07 difference margin",
  )
  with tempfile.TemporaryDirectory() as directory:
   directory=Path(directory)
   for fixture_kind in ("melodic","percussive"):
    for filename,sample_rate,channels,encoder,quality in codec_cases:
     label=f"{fixture_kind}-{filename}"
     source=directory/f"{label}-source.wav"
     encoded=directory/label
     decoded=directory/f"{label}-decoded.wav"
     unrelated=directory/f"{label}-unrelated.wav"
     source_audio=music_fixture(fixture_kind,sample_rate,channels)
     other_kind="percussive" if fixture_kind=="melodic" else "melodic"
     unrelated_audio=music_fixture(other_kind,sample_rate,channels)
     sf.write(source,source_audio,sample_rate,subtype="PCM_16")
     sf.write(unrelated,unrelated_audio,sample_rate,subtype="PCM_16")
     encode_with_ffmpeg(source,encoded,encoder,quality)
     decode_with_ffmpeg(encoded,decoded)
     copy_result=signal_comparison(source,decoded)
     unrelated_result=signal_comparison(source,unrelated)
     self.assertFalse(copy_result["passesNotSourceCopy"],label)
     self.assertGreaterEqual(
      copy_result["absoluteWaveformCorrelation"],copy_correlation_floor,label,
     )
     self.assertLessEqual(
      copy_result["polarityInvariantNormalizedDifference"],
      copy_difference_ceiling,label,
     )
     self.assertTrue(unrelated_result["passesNotSourceCopy"],label)
     self.assertLessEqual(
      unrelated_result["absoluteWaveformCorrelation"],
      unrelated_correlation_ceiling,label,
     )
     self.assertGreaterEqual(
      unrelated_result["polarityInvariantNormalizedDifference"],
      unrelated_difference_floor,label,
     )

 def test_source_copy_detection_rejects_reencoded_shifted_transforms_with_margin(self):
  sample_rate=24000
  source_audio=music_fixture("melodic",sample_rate,1)
  cases=(
   ("mp3-gain-leading.mp3","libmp3lame",("-b:a","64k"),.42,False,.375),
   ("aac-polarity-advanced.aac","aac",("-b:a","64k"),1.0,True,-.625),
   ("opus-gain-polarity-leading.ogg","libopus",("-b:a","48k"),.58,True,.25),
  )
  correlation_margin=.02
  difference_margin=.07
  with tempfile.TemporaryDirectory() as directory:
   directory=Path(directory)
   source=directory/"source.wav"
   sf.write(source,source_audio,sample_rate,subtype="PCM_16")
   for filename,encoder,quality,gain,invert,offset_seconds in cases:
    label=filename.rsplit(".",1)[0]
    offset_samples=round(abs(offset_seconds)*sample_rate)
    transformed=(-1 if invert else 1)*gain*source_audio
    if offset_seconds >= 0:
     transformed=np.concatenate((np.zeros(offset_samples),transformed))
    else:
     transformed=np.concatenate((transformed[offset_samples:],np.zeros(offset_samples)))
    input_path=directory/f"{label}-input.wav"
    encoded=directory/filename
    decoded=directory/f"{label}-decoded.wav"
    sf.write(input_path,transformed,sample_rate,subtype="PCM_16")
    encode_with_ffmpeg(input_path,encoded,encoder,quality)
    decode_with_ffmpeg(encoded,decoded)
    result=signal_comparison(source,decoded)
    self.assertFalse(result["passesNotSourceCopy"],label)
    self.assertGreaterEqual(
     result["absoluteWaveformCorrelation"],
     COPY_LIKE_CORRELATION_THRESHOLD+correlation_margin,
     f"{label} must retain explicit correlation threshold margin",
    )
    self.assertLessEqual(
     result["polarityInvariantNormalizedDifference"],
     COPY_LIKE_DIFFERENCE_THRESHOLD-difference_margin,
     f"{label} must retain explicit difference threshold margin",
    )
    self.assertAlmostEqual(
     result["strongestOffsetSeconds"],offset_seconds,delta=.08,
     msg=f"{label} offset must include only bounded codec priming delay",
    )
    self.assertLessEqual(
     abs(result["strongestOffsetSeconds"]),result["maxOffsetSeconds"],label,
    )