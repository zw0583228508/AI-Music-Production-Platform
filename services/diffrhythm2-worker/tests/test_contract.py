import json,subprocess,sys,tempfile,unittest
from unittest import mock
from pathlib import Path
import numpy as np
import soundfile as sf
from smoke import (
 COPY_LIKE_CORRELATION_THRESHOLD,
 COPY_LIKE_DIFFERENCE_THRESHOLD,
 DECODED_SAMPLE_BYTES,
 FULL_CHROMA_CI_DURATION_SECONDS,
 FULL_CHROMA_CI_MAX_RSS_BYTES,
 FULL_CHROMA_CI_MAX_RUNTIME_SECONDS,
 MAX_CHANNEL_PROJECTIONS,
 MAX_COMPARISON_WORKING_BYTES,
 MAX_DECODED_AUDIO_BYTES,
 MAX_DECODED_CHANNELS,
 MAX_INPUT_SAMPLE_RATE,
 MIN_COMPARISON_MEMORY_HEADROOM_BYTES,
 _comparison_working_bytes,
 signal_comparison,
)
ROOT=Path(__file__).parents[1]
from scipy.signal import istft, stft
from app import Generate
from contract import MAX_DURATION_SECONDS
from comparison_resources import (
 COMPARISON_CONTAINER_MEMORY_MIB,
 COMPARISON_CONTAINER_RESERVE_MIB,
 COMPARISON_MAX_CONCURRENT_INPUTS,
 COMPARISON_MEASURED_PEAK_MIB,
 COMPARISON_PER_INPUT_BUDGET_MIB,
)
from codec_threshold_corpus import run_corpus
from release import validate_codec_evidence

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
 def test_smoke_script_initializes_helpers_before_entrypoint(self):
  completed=subprocess.run(
   [sys.executable,str(ROOT/"smoke.py")],
   cwd=ROOT,
   env={
    **dict(__import__("os").environ),
    "DIFFRHYTHM2_SMOKE_ENTRYPOINT_CHECK":"1",
   },
   check=True,capture_output=True,text=True,timeout=30,
  )
  self.assertEqual(completed.stdout.strip(),"DiffRhythm2 smoke entrypoint ready")

 def test_comparison_deployment_concurrency_fits_measured_memory_budget(self):
  modal_compare=(ROOT/"modal_compare.py").read_text()
  self.assertEqual(
   COMPARISON_MEASURED_PEAK_MIB*1024*1024,
   MAX_COMPARISON_WORKING_BYTES-MIN_COMPARISON_MEMORY_HEADROOM_BYTES,
  )
  self.assertEqual(
   COMPARISON_PER_INPUT_BUDGET_MIB*1024*1024,
   MAX_COMPARISON_WORKING_BYTES,
  )
  self.assertEqual(
   COMPARISON_MAX_CONCURRENT_INPUTS,
   (COMPARISON_CONTAINER_MEMORY_MIB-COMPARISON_CONTAINER_RESERVE_MIB)
   // COMPARISON_PER_INPUT_BUDGET_MIB,
  )
  self.assertGreaterEqual(
   COMPARISON_CONTAINER_MEMORY_MIB-COMPARISON_CONTAINER_RESERVE_MIB,
   COMPARISON_MAX_CONCURRENT_INPUTS*COMPARISON_PER_INPUT_BUDGET_MIB,
  )
  self.assertLess(
   COMPARISON_CONTAINER_MEMORY_MIB-COMPARISON_CONTAINER_RESERVE_MIB,
   (COMPARISON_MAX_CONCURRENT_INPUTS+1)*COMPARISON_PER_INPUT_BUDGET_MIB,
  )
  self.assertIn("memory=COMPARISON_CONTAINER_MEMORY_MIB",modal_compare)
  self.assertIn("max_containers=1",modal_compare)
  self.assertIn(
   "@modal.concurrent(max_inputs=COMPARISON_MAX_CONCURRENT_INPUTS)",modal_compare,
  )
  self.assertIn('from None',modal_compare)
  self.assertNotIn('raise RuntimeError(f"retained {label} comparison failed")',modal_compare)

 def test_api_and_provisioning_share_the_public_duration_ceiling(self):
  self.assertEqual(
   Generate.model_json_schema()["properties"]["duration"]["maximum"],
   MAX_DURATION_SECONDS,
  )
  smoke=(ROOT/"smoke.py").read_text()
  self.assertIn("duration <= MAX_DURATION_SECONDS",smoke)
  self.assertNotIn("MAX_SUPPORTED_SMOKE_DURATION_SECONDS",smoke)
  modal_app=(ROOT/"modal_app.py").read_text()
  modal_compare=(ROOT/"modal_compare.py").read_text()
  modal_config=(ROOT/"modal_config.py").read_text()
  for source in (modal_app,modal_compare):
   self.assertIn("modal.Image.from_dockerfile(",source)
   self.assertIn("context_dir=REPOSITORY_ROOT",source)
  self.assertIn("COPY services/diffrhythm2-worker /app",(ROOT/"Dockerfile").read_text())
  self.assertIn('"contract.py"',modal_config)

 def test_provisioning_script_defines_all_comparison_helpers_before_running(self):
  smoke=(ROOT/"smoke.py").read_text()
  entrypoint=smoke.index('if __name__=="__main__"')
  self.assertGreater(entrypoint,smoke.index("def _chroma"))
  self.assertGreater(entrypoint,smoke.index("def _strongest_chroma_match"))
  provision=(ROOT/"modal_provision.py").read_text()
  self.assertIn('["/opt/diffrhythm2-venv/bin/python", "smoke.py"]',provision)

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

  def test_image_pins_memory_benchmarked_audio_array_libraries(self):
   docker=(ROOT/"Dockerfile").read_text()
   self.assertIn("numpy==1.26.4 scipy==1.17.1",docker)
   self.assertIn(
    "Any upgrade must pass the mono/stereo/surround peak-RSS contract",docker,
   )

 def test_modal_python_detection_uses_the_exact_venv_interpreter(self):
  docker=(ROOT/"Dockerfile").read_text()
  modal_app=(ROOT/"modal_app.py").read_text()
  target="/opt/diffrhythm2-venv/bin/python"
  for command in ("python","python3","python3.11"):
   self.assertIn(f"ln -s {target} /usr/local/bin/{command}",docker)
  self.assertIn("assert sys.version_info[:2] == (3, 11)",docker)
  self.assertIn(f'CMD ["{target}","-m","uvicorn"',docker)
  self.assertIn("nvidia/cuda@sha256:",docker)
  self.assertIn("modal.Image.from_dockerfile(",modal_app)
  self.assertIn("context_dir=REPOSITORY_ROOT",modal_app)
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
  self.assertIn('"bounded-tempo-pitch-source-similarity-v3"',audit)
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

 def test_operator_canary_verifies_license_authenticated_artifact_and_audio(self):
  release=(ROOT/"release.py").read_text()
  self.assertIn("def verify_research_generation(",release)
  self.assertIn('"licenseStatus") != "RESEARCH_ONLY"',release)
  self.assertIn('"commercialUsePermitted") is not False',release)
  self.assertIn("CC-BY-NC-4.0 MuQ-MuLan and MuQ weights",release)
  self.assertIn('"Authorization": f"Bearer {token}"',release)
  self.assertIn("observed_sha != result.get(\"artifactSha256\")",release)
  self.assertIn("etag != observed_sha",release)
  self.assertIn("rms <= 1e-5",release)
  self.assertIn('"live-research-generation-proof.json"',release)
  self.assertNotIn('"artifactUrl": artifact_url',release)

 def test_source_copy_detection_handles_transforms_and_offsets(self):
  sample_rate=16000
  time=np.arange(sample_rate*3,dtype=np.float64)/sample_rate
  source=(
   .45*np.sin(2*np.pi*(180*time+35*time*time))
   +.2*np.sin(2*np.pi*613*time)
   +.08*np.sin(2*np.pi*997*time)
  )
  unrelated=(
    .35*np.sin(2*np.pi*(277*time+8*time*time))
    +.24*np.sin(2*np.pi*415*time)
    +.12*np.sin(2*np.pi*733*time)
   )*(.55+.45*np.sin(2*np.pi*1.7*time)**2)
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
    "small-tempo.wav":time_stretch(source,1.05),
    "moderate-tempo.wav":time_stretch(source,1.10),
    "small-pitch.wav":(
     .45*np.sin(2*np.pi*((180*2**(1/12))*time+(35*2**(1/12))*time*time))
     +.2*np.sin(2*np.pi*(613*2**(1/12))*time)+.08*np.sin(2*np.pi*(997*2**(1/12))*time)
    ),
    "moderate-pitch.wav":(
     .45*np.sin(2*np.pi*((180*2**(4/12))*time+(35*2**(4/12))*time*time))
     +.2*np.sin(2*np.pi*(613*2**(4/12))*time)+.08*np.sin(2*np.pi*(997*2**(4/12))*time)
    ),
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
   self.assertTrue(
    results[name]["absoluteWaveformCorrelation"] >= .95
    or results[name]["strongestTransform"]["similarity"] >= .90,name
   )
  self.assertFalse(results["reencoded.mp3"]["passesNotSourceCopy"])
  self.assertTrue(results["unrelated.wav"]["passesNotSourceCopy"])
  self.assertEqual(results["moderate-pitch.wav"]["strongestTransform"]["pitchSemitones"],4)
  self.assertAlmostEqual(results["moderate-tempo.wav"]["strongestTransform"]["tempoRatio"],1.10)
  self.assertLess(results["leading-silence.wav"]["strongestOffsetSeconds"],1.01)
  self.assertGreater(results["leading-silence.wav"]["strongestOffsetSeconds"],.99)

 def test_source_copy_detection_stays_bounded_at_maximum_smoke_duration(self):
  with tempfile.TemporaryDirectory() as directory:
   directory=Path(directory)
   benchmark = """
import json, resource, sys, tempfile, time
from pathlib import Path
import numpy as np
import scipy
import soundfile as sf
from contract import MAX_DURATION_SECONDS
from smoke import signal_comparison
channels=int(sys.argv[1])
sample_rate=16000
duration=int(MAX_DURATION_SECONDS)
time_values=np.arange(sample_rate*duration,dtype=np.float64)/sample_rate
mono=(.38*np.sin(2*np.pi*(173*time_values+2.5*time_values*time_values))
      +.17*np.sin(2*np.pi*521*time_values)+.09*np.sin(2*np.pi*887*time_values))
source=mono if channels == 1 else np.column_stack(
    [mono*(1-.035*channel) for channel in range(channels)]
)
shifted=np.concatenate((np.zeros(sample_rate*2),mono[:-sample_rate*2]))*.61
output=shifted if channels == 1 else np.column_stack(
    [shifted*(1-.025*channel) for channel in range(channels)]
)
directory=Path(sys.argv[2])
source_path=directory/f"maximum-duration-{channels}ch-source.wav"
output_path=directory/f"maximum-duration-{channels}ch-output.wav"
sf.write(source_path,source,sample_rate,subtype="PCM_16")
sf.write(output_path,output,sample_rate,subtype="PCM_16")
# Drop fixture-construction arrays so RSS growth during comparison is measured
# against a realistic fresh worker process rather than double-counting them.
del time_values, mono, source, shifted, output
started=time.perf_counter()
result=signal_comparison(source_path,output_path)
elapsed=time.perf_counter()-started
peak_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
print(json.dumps({
 "channels":channels,"elapsedSeconds":elapsed,"peakResidentBytes":peak_kib*1024,
 "numpyVersion":np.__version__,"scipyVersion":scipy.__version__,"result":result,
}))
"""
   measurements=[]
   for channels in (1,2,6):
    completed=subprocess.run(
     [sys.executable,"-c",benchmark,str(channels),str(directory)],
     cwd=ROOT,capture_output=True,text=True,timeout=90,
    )
    self.assertEqual(
     completed.returncode,0,
     f"{channels}-channel memory benchmark failed:\n{completed.stderr}",
    )
    measurements.append(json.loads(completed.stdout))
   permitted_peak=(
    MAX_COMPARISON_WORKING_BYTES-MIN_COMPARISON_MEMORY_HEADROOM_BYTES
   )
   for measurement in measurements:
    label=(
     f"{measurement['channels']}-channel maximum-duration comparison "
     f"(NumPy {measurement['numpyVersion']}, SciPy {measurement['scipyVersion']})"
    )
    self.assertFalse(measurement["result"]["passesNotSourceCopy"],label)
    self.assertEqual(measurement["result"]["searchedTransformCount"],0,label)
    self.assertAlmostEqual(
     measurement["result"]["strongestOffsetSeconds"],2.0,delta=.02,msg=label,
    )
    self.assertLess(
     measurement["elapsedSeconds"],45.0,
     f"{label} took {measurement['elapsedSeconds']:.2f}s",
    )
    observed=measurement["peakResidentBytes"]
    self.assertLessEqual(
     observed,permitted_peak,
     f"{label} peaked at {observed/(1024*1024):.1f} MiB RSS; comparison "
     f"boundary is {MAX_COMPARISON_WORKING_BYTES/(1024*1024):.0f} MiB and "
     f"requires {MIN_COMPARISON_MEMORY_HEADROOM_BYTES/(1024*1024):.0f} MiB "
     f"headroom. Review NumPy/SciPy dependency changes or raise the declared "
     f"boundary with measured evidence.",
    )
    policy=measurement["result"]["workingMemoryPolicy"]
    self.assertEqual(
     policy["maximumMiB"],MAX_COMPARISON_WORKING_BYTES//(1024*1024),label,
    )
    self.assertLessEqual(policy["estimatedPeakMiB"],policy["maximumMiB"],label)

 def test_unrelated_comparison_full_chroma_path_stays_ci_bounded(self):
   benchmark = """
import json, resource, sys, tempfile, time
from pathlib import Path
import numpy as np
import scipy
import soundfile as sf
from smoke import (
 FULL_CHROMA_CI_DURATION_SECONDS,
 signal_comparison,
)
sample_rate=16000
duration=FULL_CHROMA_CI_DURATION_SECONDS
time_values=np.arange(sample_rate*duration,dtype=np.float64)/sample_rate
source_envelope=.55+.45*np.sin(2*np.pi*.73*time_values)**2
output_envelope=.50+.50*np.sin(2*np.pi*1.17*time_values+.4)**2
source=source_envelope*(
 .36*np.sin(2*np.pi*(173*time_values+1.7*time_values*time_values))
 +.18*np.sin(2*np.pi*521*time_values)
 +.08*np.sin(2*np.pi*887*time_values)
)
output=output_envelope*(
 .33*np.sin(2*np.pi*(269*time_values+3.1*time_values*time_values))
 +.21*np.sin(2*np.pi*401*time_values)
 +.10*np.sin(2*np.pi*743*time_values)
)
with tempfile.TemporaryDirectory() as directory:
 directory=Path(directory)
 source_path=directory/"full-chroma-source.wav"
 output_path=directory/"full-chroma-unrelated.wav"
 sf.write(source_path,source,sample_rate,subtype="PCM_16")
 sf.write(output_path,output,sample_rate,subtype="PCM_16")
 del time_values, source_envelope, output_envelope, source, output
 started=time.perf_counter()
 result=signal_comparison(source_path,output_path)
 elapsed=time.perf_counter()-started
 peak_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
 print(json.dumps({
  "durationSeconds":duration,
  "elapsedSeconds":elapsed,
  "peakResidentBytes":peak_kib*1024,
  "numpyVersion":np.__version__,
  "scipyVersion":scipy.__version__,
  "result":result,
 }))
"""
   completed=subprocess.run(
    [sys.executable,"-c",benchmark],
    cwd=ROOT,capture_output=True,text=True,timeout=90,
   )
   self.assertEqual(
    completed.returncode,0,
    "full-chroma unrelated benchmark failed "
    f"(NumPy {np.__version__}):\\n{completed.stdout}\\n{completed.stderr}",
   )
   measurement=json.loads(completed.stdout)
   label=(
    f"{measurement['durationSeconds']}-second full-chroma unrelated comparison "
    f"(NumPy {measurement['numpyVersion']}, SciPy {measurement['scipyVersion']}; "
    f"{measurement['elapsedSeconds']:.2f}s, "
    f"{measurement['peakResidentBytes']/(1024*1024):.1f} MiB RSS)"
   )
   result=measurement["result"]
   self.assertTrue(result["passesNotSourceCopy"],label)
   self.assertEqual(
    result["searchedTransformCount"],len(result["searchedTempoRatios"])
    *len(result["searchedPitchSemitones"]),label,
   )
   self.assertGreater(result["searchedTransformAlignmentCount"],0,label)
   self.assertLess(
    measurement["elapsedSeconds"],FULL_CHROMA_CI_MAX_RUNTIME_SECONDS,label,
   )
   self.assertLessEqual(
    measurement["peakResidentBytes"],FULL_CHROMA_CI_MAX_RSS_BYTES,
    f"{label}; full-chroma CI boundary is "
    f"{FULL_CHROMA_CI_MAX_RSS_BYTES/(1024*1024):.0f} MiB. Review NumPy/SciPy "
    "dependency changes or raise this separate boundary with measured evidence.",
   )

 def test_source_copy_thresholds_have_margin_across_real_codecs(self):
  evidence=run_corpus()
  self.assertTrue(evidence["passed"])
  self.assertFalse(evidence["audioRetained"])
  self.assertEqual(len(evidence["cases"]),12)
  self.assertTrue(evidence["ffmpegVersion"].startswith("ffmpeg version "))

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

 def test_source_copy_detection_rejects_lossy_stereo_channel_remixes_with_margin(self):
  sample_rate=24000
  source_audio=music_fixture("melodic",sample_rate,2)
  unrelated_audio=music_fixture("percussive",sample_rate,2)
  cases={
   "channel-swap":source_audio[:,::-1],
   "left-only":source_audio[:,0],
   "channel-rebalance":source_audio*np.array([.18,1.0]),
  }
  correlation_margin=.02
  difference_margin=.07
  with tempfile.TemporaryDirectory() as directory:
   directory=Path(directory)
   source=directory/"source.wav"
   unrelated=directory/"unrelated.wav"
   sf.write(source,source_audio,sample_rate,subtype="PCM_16")
   sf.write(unrelated,unrelated_audio,sample_rate,subtype="PCM_16")
   for label,transformed in cases.items():
    remix=directory/f"{label}.wav"
    encoded=directory/f"{label}.ogg"
    decoded=directory/f"{label}-decoded.wav"
    sf.write(remix,transformed,sample_rate,subtype="PCM_16")
    encode_with_ffmpeg(remix,encoded,"libopus",("-b:a","64k"))
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
   unrelated_result=signal_comparison(source,unrelated)
   self.assertTrue(unrelated_result["passesNotSourceCopy"])

 def test_source_copy_detection_bounds_surround_and_malformed_channel_layouts(self):
  sample_rate=8000
  time=np.arange(sample_rate*2,dtype=np.float64)/sample_rate
  copied=.44*np.sin(2*np.pi*(211*time+13*time*time))+.17*np.sin(2*np.pi*619*time)
  unrelated=.37*np.sin(2*np.pi*(307*time+5*time*time))+.13*np.sin(2*np.pi*881*time)
  cases=(("surround",6,8),("maximum-supported",24,MAX_DECODED_CHANNELS))
  with tempfile.TemporaryDirectory() as directory:
   directory=Path(directory)
   for label,source_channels,output_channels in cases:
    source_audio=np.zeros((len(time),source_channels))
    output_audio=np.zeros((len(time),output_channels))
    source_audio[:,source_channels-1]=copied
    output_audio[:,output_channels-1]=copied*.43
    source_audio[:,:-1]=unrelated[:,None]*.01
    output_audio[:,:-1]=unrelated[:,None]*.01
    source=directory/f"{label}-source.wav"
    output=directory/f"{label}-output.wav"
    sf.write(source,source_audio,sample_rate,subtype="PCM_16")
    sf.write(output,output_audio,sample_rate,subtype="PCM_16")
    result=signal_comparison(source,output)
    self.assertFalse(result["passesNotSourceCopy"],label)
    self.assertLessEqual(
     result["comparedProjectionPairs"],MAX_CHANNEL_PROJECTIONS**2,label,
    )
    policy=result["channelProjectionPolicy"]
    self.assertEqual(policy["maximumPerAudio"],MAX_CHANNEL_PROJECTIONS)
    self.assertIn(f"channel-{source_channels-1}",policy["sourceProjections"],label)
    self.assertIn(f"channel-{output_channels-1}",policy["outputProjections"],label)

 def test_source_copy_detection_rejects_extreme_channels_before_decode(self):
  sample_rate=8000
  extreme_channels=MAX_DECODED_CHANNELS+1
  with tempfile.TemporaryDirectory() as directory:
   directory=Path(directory)
   extreme=directory/"extreme.wav"
   normal=directory/"normal.wav"
   sf.write(
    extreme,np.zeros((32,extreme_channels)),sample_rate,subtype="PCM_16",
   )
   sf.write(normal,np.zeros(32),sample_rate,subtype="PCM_16")
   with mock.patch("smoke.sf.read",wraps=sf.read) as decode:
    with self.assertRaisesRegex(
     RuntimeError,
     rf"audio channel count {extreme_channels} exceeds supported maximum "
     rf"of {MAX_DECODED_CHANNELS}",
    ):
     signal_comparison(extreme,normal)
  decode.assert_not_called()

 def test_source_copy_detection_rejects_malformed_oversized_audio_before_decode(self):
  sample_rate=8000
  claimed_frames=int(sample_rate*MAX_DURATION_SECONDS)+1
  with tempfile.TemporaryDirectory() as directory:
   directory=Path(directory)
   oversized=directory/"truncated-oversized.wav"
   normal=directory/"normal.wav"
   oversized.write_bytes(b"malformed oversized audio fixture")
   sf.write(normal,np.zeros(32),sample_rate,subtype="PCM_16")
   oversized_metadata=mock.Mock(
    channels=1,samplerate=sample_rate,frames=claimed_frames,
   )
   with mock.patch("smoke.sf.info",return_value=oversized_metadata), \
        mock.patch("smoke.sf.read",wraps=sf.read) as decode:
    with self.assertRaisesRegex(
     RuntimeError,
     rf"audio duration exceeds supported maximum of "
      rf"{MAX_DURATION_SECONDS:g} seconds",
    ):
     signal_comparison(oversized,normal)
   decode.assert_not_called()

 def test_source_copy_detection_rejects_unsafe_combined_dimensions_before_decode(self):
  sample_rate=48000
  channel_count=MAX_DECODED_CHANNELS
  claimed_frames=MAX_DECODED_AUDIO_BYTES//(channel_count*DECODED_SAMPLE_BYTES)+1
  self.assertLessEqual(
   claimed_frames,
    int(sample_rate*MAX_DURATION_SECONDS),
  )
  with tempfile.TemporaryDirectory() as directory:
   directory=Path(directory)
   unsafe=directory/"private-user-upload.wav"
   normal=directory/"normal.wav"
   unsafe.write_bytes(b"metadata-only combined-dimension fixture")
   sf.write(normal,np.zeros(32),sample_rate,subtype="PCM_16")
   unsafe_metadata=mock.Mock(
    channels=channel_count,samplerate=sample_rate,frames=claimed_frames,
   )
   with mock.patch("smoke.sf.info",return_value=unsafe_metadata), \
        mock.patch("smoke.sf.read",wraps=sf.read) as decode:
    with self.assertRaisesRegex(
     RuntimeError,
     rf"^audio decoded size exceeds supported maximum of "
     rf"{MAX_DECODED_AUDIO_BYTES//(1024*1024)} MiB$",
    ) as raised:
     signal_comparison(unsafe,normal)
   decode.assert_not_called()
  self.assertNotIn(unsafe.name,str(raised.exception))

 def test_source_copy_detection_rejects_unsafe_derived_working_set_before_decode(self):
  sample_rate=48000
  frames=int(sample_rate*MAX_DURATION_SECONDS)
  metadata=mock.Mock(channels=3,samplerate=sample_rate,frames=frames)
  self.assertLessEqual(
   frames*metadata.channels*DECODED_SAMPLE_BYTES,MAX_DECODED_AUDIO_BYTES,
  )
  self.assertGreater(
   _comparison_working_bytes(metadata,metadata),MAX_COMPARISON_WORKING_BYTES,
  )
  with tempfile.TemporaryDirectory() as directory:
   path=Path(directory)/"metadata-only.wav"
   path.write_bytes(b"metadata-only working-set fixture")
   with mock.patch("smoke.sf.info",return_value=metadata), \
        mock.patch("smoke.sf.read") as decode:
    with self.assertRaisesRegex(
     RuntimeError,
     rf"^audio comparison working set exceeds supported maximum of "
     rf"{MAX_COMPARISON_WORKING_BYTES//(1024*1024)} MiB$",
    ):
     signal_comparison(path,path)
   decode.assert_not_called()

 def test_comparison_working_policy_supports_normal_layouts_at_maximum_duration(self):
  sample_rate=16000
  frames=int(sample_rate*MAX_DURATION_SECONDS)
  for channels in (1,2,6):
   metadata=mock.Mock(
    channels=channels,samplerate=sample_rate,frames=frames,
   )
   self.assertLessEqual(
    _comparison_working_bytes(metadata,metadata),
    MAX_COMPARISON_WORKING_BYTES,
    f"{channels}-channel maximum-duration comparison must remain supported",
   )

 def test_source_copy_detection_keeps_stereo_projection_behavior(self):
  sample_rate=8000
  source_audio=music_fixture("melodic",sample_rate,2)
  with tempfile.TemporaryDirectory() as directory:
   directory=Path(directory)
   source=directory/"source.wav"
   swapped=directory/"swapped.wav"
   sf.write(source,source_audio,sample_rate,subtype="PCM_16")
   sf.write(swapped,source_audio[:,::-1],sample_rate,subtype="PCM_16")
   result=signal_comparison(source,swapped)
  self.assertFalse(result["passesNotSourceCopy"])
  self.assertEqual(result["comparedProjectionPairs"],4)
  self.assertEqual(
   result["channelProjectionPolicy"]["sourceProjections"],
   ["channel-0","channel-1"],
  )

 def test_source_copy_detection_rejects_extreme_sample_rates_before_decode(self):
  extreme_sample_rate=MAX_INPUT_SAMPLE_RATE+1
  with tempfile.TemporaryDirectory() as directory:
   directory=Path(directory)
   extreme=directory/"extreme.wav"
   normal=directory/"normal.wav"
   sf.write(extreme,np.zeros(32),extreme_sample_rate,subtype="PCM_16")
   sf.write(normal,np.zeros(32),8000,subtype="PCM_16")
   with mock.patch("smoke.sf.read",wraps=sf.read) as decode:
    with self.assertRaisesRegex(
     RuntimeError,
     rf"audio sample rate {extreme_sample_rate} Hz exceeds supported maximum "
     rf"of {MAX_INPUT_SAMPLE_RATE} Hz",
    ):
     signal_comparison(extreme,normal)
   decode.assert_not_called()

 def test_source_copy_detection_supports_192_khz_input(self):
  with tempfile.TemporaryDirectory() as directory:
   directory=Path(directory)
   source=directory/"source.wav"
   output=directory/"output.wav"
   source_time=np.arange(MAX_INPUT_SAMPLE_RATE*2)/MAX_INPUT_SAMPLE_RATE
   output_time=np.arange(8000*2)/8000
   sf.write(source,.3*np.sin(2*np.pi*440*source_time),MAX_INPUT_SAMPLE_RATE,subtype="PCM_16")
   sf.write(output,.3*np.sin(2*np.pi*440*output_time),8000,subtype="PCM_16")
   result=signal_comparison(source,output)
  self.assertIn("passesNotSourceCopy",result)

 def test_promotion_requires_digest_bound_codec_evidence(self):
  app=(ROOT/"app.py").read_text()
  release=(ROOT/"release.py").read_text()
  self.assertIn('CODEC_EVIDENCE=ROOT/"codec-threshold-evidence.json"',app)
  self.assertIn('"codecThresholdEvidence"',app)
  self.assertIn('"codec-threshold-evidence.json"',release)
  self.assertIn('codec_evidence.get("sourceImageDigest") != health["sourceImageDigest"]',release)
  self.assertIn('codec_evidence.get("modalImageId") != health["modalImageId"]',release)
  self.assertIn('codec_evidence.get("audioRetained") is not False',release)

 def test_codec_evidence_validator_rejects_image_identity_drift(self):
  evidence={
   "passed":True,
   "audioRetained":False,
   "ffmpegVersion":"ffmpeg version 4.4.2",
   "sourceImageDigest":"sha256:source",
   "modalImageId":"im-built",
  }
  health={
   "sourceImageDigest":"sha256:source",
   "modalImageId":"im-built",
   "codecThresholdEvidence":evidence,
  }
  self.assertIs(validate_codec_evidence(health),evidence)
  for field,value in (
   ("sourceImageDigest","sha256:other"),
   ("modalImageId","im-other"),
   ("audioRetained",True),
   ("passed",False),
  ):
   changed={**evidence,field:value}
   with self.assertRaisesRegex(ValueError,"codec threshold evidence"):
    validate_codec_evidence({**health,"codecThresholdEvidence":changed})

def time_stretch(audio,rate):
 _,_,spectrum=stft(audio,nperseg=1024,noverlap=768)
 steps=np.arange(0,spectrum.shape[1]-1,rate)
 result=np.empty((spectrum.shape[0],len(steps)),dtype=np.complex128)
 phase=np.angle(spectrum[:,0])
 advance=2*np.pi*256*np.arange(spectrum.shape[0])/1024
 for column,step in enumerate(steps):
  frame=int(step); fraction=step-frame
  magnitude=(1-fraction)*abs(spectrum[:,frame])+fraction*abs(spectrum[:,frame+1])
  delta=np.angle(spectrum[:,frame+1])-np.angle(spectrum[:,frame])-advance
  delta-=2*np.pi*np.round(delta/(2*np.pi))
  result[:,column]=magnitude*np.exp(1j*phase)
  phase+=advance+delta
 _,stretched=istft(result,nperseg=1024,noverlap=768)
 return stretched
