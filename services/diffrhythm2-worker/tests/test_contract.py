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
import json,sys,tempfile,unittest

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

 def test_operator_canary_verifies_license_authenticated_artifact_and_audio(self):
  release=(ROOT/"release.py").read_text()
  self.assertIn("def verify_research_generation(metadata: dict)",release)
  self.assertIn('"licenseStatus") != "RESEARCH_ONLY"',release)
  self.assertIn('"commercialUsePermitted") is not False',release)
  self.assertIn("CC-BY-NC-4.0 MuQ-MuLan and MuQ weights",release)
  self.assertIn('"Authorization": f"Bearer {token}"',release)
  self.assertIn("observed_sha != result.get(\"artifactSha256\")",release)
  self.assertIn("etag != observed_sha",release)
  self.assertIn("rms <= 1e-5",release)
  self.assertIn('"live-research-generation-proof.json"',release)
  self.assertNotIn('"artifactUrl": artifact_url',release)
   }
   results={}
   for name,audio in cases.items():
    path=directory/name
    sf.write(path,audio,sample_rate,subtype="PCM_16")
    results[name]=signal_comparison(source_path,path)
   mp3_path=directory/"reencoded.mp3"
   sf.write(mp3_path,source,sample_rate,format="MP3")
   results["reencoded.mp3"]=signal_comparison(source_path,mp3_path)

  shared=source.index('os.getenv("MUSIC_AI_WORKER_TOKEN")',provider)

  self.assertLess(provider,shared)

  docker=(ROOT/"Dockerfile").read_text()

  install=next(line for line in docker.splitlines() if "apt-get install" in line)

  self.assertIn('"commercialUsePermitted":False',app)

  modal_app=(ROOT/"modal_app.py").read_text()

  target="/opt/diffrhythm2-venv/bin/python"

  for command in ("python","python3","python3.11"):
   self.assertIn(f"ln -s {target} /usr/local/bin/{command}",docker)

  source=(
   .45*np.sin(2*np.pi*(180*time+35*time*time))
   +.2*np.sin(2*np.pi*613*time)
   +.08*np.sin(2*np.pi*997*time)

  app=(ROOT/"app.py").read_text(); smoke=(ROOT/"smoke.py").read_text()

  provision=(ROOT/"modal_provision.py").read_text()

  audit=(ROOT.parents[1]/"scripts/audit-installation-stack.py").read_text()

  self.assertNotIn('"license":"Apache-2.0"}',app)

 def test_source_copy_detection_handles_transforms_and_offsets(self):

  runner=(ROOT/"upstream_runner.py").read_text()

  sample_rate=16000

  time=np.arange(sample_rate*3,dtype=np.float64)/sample_rate

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
