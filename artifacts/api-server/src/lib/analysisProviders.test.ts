import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import {
  canonicalGpuPromotionJson,
  expectedGpuPromotionRecord,
  type GpuPromotionRecord,
} from "./gpuProviderAttestation";
import { committedBeatThisPromotionBundle } from "./beatThisPromotion.generated";
import { attestAnalysisProviderHealth } from "./analysisProviderManifest";
import {
  parseHarmony,
  fuseHarmonyEvidence,
  fuseCanonicalNotes,
  parseSeparation,
  runAnalysisProviders,
  analyzeVerifiedBassStem,
  type TranscriptionAnalysisResult,
} from "./analysisProviders";

const VALID_MADMOM_HEALTH = {
  provider: "MADMOM",
  status: "ready",
  ready: true,
  modelVersion: "madmom-infer-0.2.0-downbeats-blstm-2016",
  checksum: "321f2953f6c102b6485f191dc8e1c7dec7867b6a5b92c27078528b9529c8fcb9",
  identityChecksum: "321f2953f6c102b6485f191dc8e1c7dec7867b6a5b92c27078528b9529c8fcb9",
  sourceRepository: "https://github.com/openmirlab/madmom-infer",
  sourceRevision: "cb7a1d3f43e0c7ca1ea9c10316c710b32e18e7a",
  packageName: "madmom-infer",
  packageVersion: "0.2.0",
  packageArtifactSha256: "f4013a7ac2135f2f198d97f9e7840db4fbd993e2922f70b28862394c8f8d28f1",
  packageTreeSha256: "65b186bcc2b8700e318720f2067860ee402c3be041c18b2ab082111f628be9cd",
  pythonVersion: "3.11.11",
  runtimePackages: {
    fastapi: "0.141.1",
    librosa: "0.11.0",
    numpy: "1.26.4",
    pydantic: "2.13.5",
    resampy: "0.4.3",
    scipy: "1.13.1",
    soundfile: "0.13.1",
    torch: "2.14.0",
    torchaudio: "2.11.0",
    uvicorn: "0.52.4",
  },
  requirementsLockSha256: "210354042a315551890099c011b375f2ad7df7b5261f9527a16b5176cf2ec2ff",
  license: "BSD-2-Clause",
  licenseClassification: "RESEARCH_ONLY",
  licenseSha256: "4eac23726289b6a20602be93e570016dd06e4353bc59a4a00207cf8da4ff2839",
  noticeSha256: "6b8d927d1e7a807c9884e3781888a40de31d3b12c2131afb5c6f9f7c0b9417e3",
  commercialUse: false,
  modelRepository: "https://github.com/CPJKU/madmom",
  modelRevision: "sha256:2cbc981348700f7d75f3c0d9551f1b8381b2a0edd2b1b5da3674f7cec1575807",
  modelArtifactsSha256: "422855d74225017086720b926298de8363f089883cd238062418f5dbeacd1155",
  workerSourceTreeSha256: "a148ba1e1732a065e5e2343306273d77e28403ae39bd213900861978d038a7aa",
  promotionRequired: false,
  packageReady: true,
  assetReady: true,
  assetsVerified: true,
  featureExecutionReady: true,
  runtimeReady: true,
  checkpointReady: true,
  smokeTested: true,
  smokeProofVerified: true,
  identityReady: true,
  smokeEvidenceSha256: "12cca65e4ee4aa2dfe33afd93e7b970f823e451456d20e1911e66b519559e9cd",
  fixtureSha256: "9c5c2715978ccbe3cc8b90738d9d110346ff26f1f2797ab32dba51a8f666dd52",
  resultSha256: "fbacb146b61336f539204b3000255c5c690118272d62e8351b15871110ee1f8e",
  reason: null,
} as const;

test("pins Basic Pitch health to exact source, package, runtime, and checkpoint identity", () => {
  const health = {
    provider: "BASIC_PITCH",
    status: "ready",
    packageReady: true,
    checkpointReady: true,
    runtimeReady: true,
    smokeTested: true,
    modelVersion: "0.4.0",
    checksum: "b74344cd0c58261dae0cd52050d85ab6f901a5e219f27046ab4640673bba1046",
    sourceRepository: "https://github.com/spotify/basic-pitch",
    sourceRevision: "9991303bba609a3b93089d13ec80d1d495083596",
    license: "Apache-2.0",
    licenseSha256: "929c910bae2152fa87199a5d0660e09263419b7eee6d4b301d05ee2aaf211c37",
    noticeSha256: "b810e55c0e3b520fabb45fc2ccc74880187bf84e309971968541cc812dcde905",
    packageArtifactSha256: "738adb503aae7fdfc7d1e1511aa0ce35052315f260a19531ef4c356708425db0",
    packageTreeSha256: "89cfb8516927e3bc536da99139ddb4ad7ce79dc833e29df33e5bca27ccef116c",
    inferenceBackend: "tensorflow-saved-model",
    runtimePackages: {
      tensorflow: "2.14.0",
      numpy: "1.26.4",
      librosa: "0.11.0",
      resampy: "0.4.2",
      "pretty-midi": "0.2.11.post0",
    },
  };
  assert.equal(attestAnalysisProviderHealth("BASIC_PITCH", health).version, "0.4.0");
  assert.throws(
    () => attestAnalysisProviderHealth("BASIC_PITCH", {
      ...health,
      packageTreeSha256: "0".repeat(64),
    }),
    /verified BASIC_PITCH/,
  );
});

test("pins MIR health to exact source, package, model, worker, and smoke evidence", () => {
  assert.deepEqual(attestAnalysisProviderHealth("MADMOM", VALID_MADMOM_HEALTH), {
    provider: "MADMOM",
    version: "0.2.0",
    checksum: VALID_MADMOM_HEALTH.checksum,
  });
  for (const drift of [
    { sourceRevision: "main" },
    { packageTreeSha256: "0".repeat(64) },
    { modelRevision: `sha256:${"0".repeat(64)}` },
    { workerSourceTreeSha256: "0".repeat(64) },
    { smokeEvidenceSha256: "0".repeat(64) },
    { requirementsLockSha256: "0".repeat(64) },
    { runtimePackages: { ...VALID_MADMOM_HEALTH.runtimePackages, numpy: "2.5.2" } },
  ]) {
    assert.throws(
      () => attestAnalysisProviderHealth("MADMOM", {
        ...VALID_MADMOM_HEALTH,
        ...drift,
      }),
      /exact source, package, runtime, model, worker, and smoke identity/,
    );
  }
});

test("pins SheetSage health to its exact source and signed smoke identity", () => {
  const health = {
    provider: "SHEETSAGE",
    version: "0.2.1",
    sourceRevision: "openmirlab/sheetsage-infer@ee7c2aeeb8084840a4f938ae6913f566afdaebdc",
    status: "ready",
    assetsVerified: true,
    runtimeReady: true,
    checkpointReady: true,
    smokeTested: true,
    smokeProofVerified: true,
    checksum: "a".repeat(64),
  };
  assert.equal(
    attestAnalysisProviderHealth("SHEETSAGE", health).version,
    "0.2.1",
  );
  assert.throws(
    () => attestAnalysisProviderHealth("SHEETSAGE", {
      ...health,
      sourceRevision: "openmirlab/sheetsage-infer@main",
    }),
    /verified SheetSage/,
  );
  assert.throws(
    () => attestAnalysisProviderHealth("SHEETSAGE", {
      ...health,
      smokeProofVerified: false,
    }),
    /verified SheetSage/,
  );
});

test("pins both MOSS semantic providers to exact runtime and retained evidence", () => {
  const imageEvidence = `sha256:${"d".repeat(64)}`;
  const baseHealth = {
    status: "ready",
    healthy: true,
    version: "ad107c7ddaa06de168a0dfbc18d3e1e6a40c0e5e",
    modelVersion: "ad107c7ddaa06de168a0dfbc18d3e1e6a40c0e5e",
    sourceRevision: "OpenMOSS/MOSS-Music@ad107c7ddaa06de168a0dfbc18d3e1e6a40c0e5e",
    sglangRevision: "c28a945853c7fee357f55d976b8abce51874bd94",
    runtimePackages: {
      python: "3.12.3",
      cuda: "12.8",
      torch: "2.9.1+cu128",
      torchaudio: "2.9.1+cu128",
      torchcodec: "0.8.0",
      transformers: "4.57.1",
      accelerate: "1.12.0",
      huggingfaceHub: "0.36.2",
      gradio: "5.44.1",
      pydantic: "2.11.10",
      fastapi: "0.115.12",
      cudnn: "9.10.2.21",
      ffmpeg: "7.1.1",
    },
    modelIdentities: {
      MOSS_MUSIC_INSTRUCT: {
        repository: "OpenMOSS-Team/MOSS-Music-8B-Instruct",
        revision: "fce7f8304e96cc2d3398b8106456cbb2ecec3139",
        role: "DIRECT_MUSICAL_SEMANTIC_REASONING",
      },
      MOSS_MUSIC_THINKING: {
        repository: "OpenMOSS-Team/MOSS-Music-8B-Thinking",
        revision: "2ce899988b94b8ecc5dd0dacbc5ce1874d3500e3",
        role: "DELIBERATE_MUSICAL_SEMANTIC_REASONING",
      },
    },
    fixture: {
      repository: "OpenMOSS/MOSS-Music",
      revision: "ad107c7ddaa06de168a0dfbc18d3e1e6a40c0e5e",
      path: "test/tonghua.mp3",
      git_blob_oid: "cb886c933968ed9dde9d8d74bc7bbcb845dd76a6",
      bytes: 4_027_752,
      sha256: "460f18e2333b27d6aff92cf2dc8181232a34ef5d08212ae74240f1ca93561540",
    },
    runtimeReady: true,
    packageReady: true,
    compatibilityReady: true,
    pipCheckPassed: true,
    mediaPreflightPassed: true,
    checkpointReady: true,
    smokeTested: true,
    semanticOnly: true,
    canonicalTruth: false,
    compatibilityEvidenceSha256: "a".repeat(64),
    assetManifestSha256: "b".repeat(64),
    smokeEvidenceSha256: "c".repeat(64),
    imageEvidence,
    checksum: "d".repeat(64),
  };
  for (const provider of ["MOSS_MUSIC_INSTRUCT", "MOSS_MUSIC_THINKING"]) {
    const health = { ...baseHealth, provider };
    assert.equal(
      attestAnalysisProviderHealth(provider, health).version,
      baseHealth.version,
    );
    for (const drift of [
      { sglangRevision: "main" },
      {
        runtimePackages: {
          ...baseHealth.runtimePackages,
          torchcodec: "0.9.1+cu128",
        },
      },
      { compatibilityReady: false },
      { pipCheckPassed: false },
      { semanticOnly: false },
      { canonicalTruth: true },
      { imageEvidence: `sha256:${"e".repeat(64)}` },
    ]) {
      assert.throws(
        () => attestAnalysisProviderHealth(provider, { ...health, ...drift }),
        /verified MOSS-Music/,
      );
    }
  }
});

test("verified bass phase fails closed when either real pitch provider is unavailable", async () => {
  const previousTorch = process.env.TORCHCREPE_API_URL;
  const previousBasic = process.env.BASIC_PITCH_API_URL;
  const previousTorchCanonical = process.env.MUSIC_PROVIDER_TORCHCREPE_URL;
  const previousBasicCanonical = process.env.MUSIC_PROVIDER_BASIC_PITCH_URL;
  const previousMir = process.env.MUSIC_MIR_API_URL;
  delete process.env.TORCHCREPE_API_URL;
  delete process.env.BASIC_PITCH_API_URL;
  delete process.env.MUSIC_PROVIDER_TORCHCREPE_URL;
  delete process.env.MUSIC_PROVIDER_BASIC_PITCH_URL;
  delete process.env.MUSIC_MIR_API_URL;
  try {
    const result = await analyzeVerifiedBassStem({
      sourceUrl: "https://storage.example/bass",
      durationSeconds: 4,
      idempotencyKey: "attempt",
      sourceStem: "/objects/analysis/project/attempt/bass.wav",
      sourceStemProvider: "BS_ROFORMER",
    });
    assert.deepEqual(result.bassEvidence, []);
    assert.equal(result.provenance[0].status, "unavailable");
    assert.equal(result.provenance[0].errorCode, "required-provider-unavailable");
  } finally {
    if (previousTorch === undefined) delete process.env.TORCHCREPE_API_URL;
    else process.env.TORCHCREPE_API_URL = previousTorch;
    if (previousBasic === undefined) delete process.env.BASIC_PITCH_API_URL;
    else process.env.BASIC_PITCH_API_URL = previousBasic;
    if (previousTorchCanonical === undefined) delete process.env.MUSIC_PROVIDER_TORCHCREPE_URL;
    else process.env.MUSIC_PROVIDER_TORCHCREPE_URL = previousTorchCanonical;
    if (previousBasicCanonical === undefined) delete process.env.MUSIC_PROVIDER_BASIC_PITCH_URL;
    else process.env.MUSIC_PROVIDER_BASIC_PITCH_URL = previousBasicCanonical;
    if (previousMir === undefined) delete process.env.MUSIC_MIR_API_URL;
    else process.env.MUSIC_MIR_API_URL = previousMir;
  }
});

test("parses valid harmony evidence and rejects out-of-range chords", () => {
  const result = parseHarmony("SHEETSAGE", {
    version: "1.2.0",
    confidence: 0.91,
    chords: [
      { start: 0, end: 2, symbol: "Cmaj7", roman: "Imaj7", confidence: 0.9 },
      { start: 2, end: 4, symbol: "Am7", roman: "vi7", confidence: 0.88 },
    ],
  }, 4);
  assert.equal(result.providerId, "SHEETSAGE");
  assert.equal(result.candidates.length, 2);
  assert.throws(() => parseHarmony("SHEETSAGE", {
    version: "1.2.0",
    confidence: 0.91,
    chords: [
      { start: 3, end: 5.1, symbol: "C", roman: "I", confidence: 0.9 },
    ],
  }, 4), /invalid/);
});

test("fusion rebuilds timing when adjacent provider segments merge", () => {
  const first = parseHarmony("SHEETSAGE", {
    version: "1",
    confidence: .9,
    chords: [{ start: 0, end: 1, symbol: "C", roman: "I", confidence: .9, timing: { startSeconds: 0, endSeconds: 1 } }],
  }, 2);
  const second = parseHarmony("CHROMA", {
    version: "1",
    confidence: .9,
    chords: [{ start: 1, end: 2, symbol: "C", roman: "I", confidence: .9, timing: { startSeconds: 1, endSeconds: 2 } }],
  }, 2);
  const fused = fuseHarmonyEvidence([first, second]);
  assert.equal(fused.chords.length, 1);
  assert.deepEqual(fused.chords[0].timing, { startSeconds: 0, endSeconds: 2 });
});

test("harmony fusion favors two independent providers over one confident provider", () => {
  const highConfidence = parseHarmony("SHEETSAGE", {
    version: "1", confidence: .99,
    chords: [{ start: 0, end: 2, symbol: "G", roman: "V", confidence: .99 }],
  }, 2);
  const firstAgreement = parseHarmony("CHROMA", {
    version: "1", confidence: .8,
    chords: [{ start: 0, end: 2, symbol: "C", roman: "I", confidence: .9 }],
  }, 2);
  const secondAgreement = parseHarmony("BASS", {
    version: "1", confidence: .8,
    chords: [{ start: 0, end: 2, symbol: "C", roman: "I", confidence: .9 }],
  }, 2);
  const fused = fuseHarmonyEvidence([highConfidence, firstAgreement, secondAgreement]);
  assert.equal(fused.chords[0]?.symbol, "C");
  assert.deepEqual(fused.providersUsed, ["BASS", "CHROMA"]);
});

test("harmony fusion abstains deterministically for close equally-supported symbols", () => {
  const c = parseHarmony("SHEETSAGE", {
    version: "1", confidence: .9,
    chords: [{ start: 0, end: 2, symbol: "C", roman: "I", confidence: .9 }],
  }, 2);
  const g = parseHarmony("CHROMA", {
    version: "1", confidence: .9,
    chords: [{ start: 0, end: 2, symbol: "G", roman: "V", confidence: .9 }],
  }, 2);
  const forward = fuseHarmonyEvidence([c, g]);
  const reverse = fuseHarmonyEvidence([g, c]);
  assert.deepEqual(forward, { chords: [], confidence: 0, providersUsed: [] });
  assert.deepEqual(reverse, forward);
});

test("harmony fusion preserves unanimous canonical chords and merged timing", () => {
  const first = parseHarmony("SHEETSAGE", {
    version: "1", confidence: .9,
    chords: [{ start: 0, end: 1, symbol: "C", roman: "I", confidence: .9, timing: { startSeconds: 0, endSeconds: 1 } }],
  }, 2);
  const second = parseHarmony("CHROMA", {
    version: "1", confidence: .9,
    chords: [{ start: 0, end: 2, symbol: "C", roman: "I", confidence: .9, timing: { startSeconds: 0, endSeconds: 2 } }],
  }, 2);
  const fused = fuseHarmonyEvidence([first, second]);
  assert.equal(fused.chords.length, 1);
  assert.equal(fused.chords[0]?.symbol, "C");
  assert.deepEqual(fused.chords[0]?.timing, { startSeconds: 0, endSeconds: 2 });
});

const transcription = (
  providerId: TranscriptionAnalysisResult["providerId"],
  notes: TranscriptionAnalysisResult["notes"],
  confidence = .9,
): TranscriptionAnalysisResult => ({ providerId, version: "test", notes, confidence });

test("canonical melody fusion is order-invariant and merges unanimous timing/pitch evidence", () => {
  const basic = transcription("BASIC_PITCH", [{
    start: 1, end: 1.5, pitch: 64, velocity: 91, confidence: .9, source: "BASIC_PITCH",
  }]);
  const mt3 = transcription("MT3", [{
    start: 1.02, end: 1.53, pitch: 64, velocity: 85, confidence: .9, source: "MT3",
  }]);
  const forward = fuseCanonicalNotes([basic, mt3]);
  assert.equal(forward.length, 1);
  assert.equal(forward[0]?.pitch, 64);
  assert.deepEqual(fuseCanonicalNotes([mt3, basic]), forward);
});

test("canonical melody fusion favors two independent transcription providers over one", () => {
  const result = fuseCanonicalNotes([
    transcription("BASIC_PITCH", [{
      start: 0, end: 1, pitch: 60, velocity: 100, confidence: .99, source: "BASIC_PITCH",
    }], .99),
    transcription("MT3", [{
      start: 0, end: 1, pitch: 62, velocity: 90, confidence: .8, source: "MT3",
    }], .9),
    transcription("MR_MT3", [{
      start: 0, end: 1, pitch: 62, velocity: 90, confidence: .8, source: "MR_MT3",
    }], .9),
  ]);
  assert.deepEqual(result.map((note) => note.pitch), [62]);
});

test("canonical melody fusion abstains for close unsupported pitch conflicts", () => {
  const first = transcription("BASIC_PITCH", [{
    start: 0, end: 1, pitch: 60, velocity: 100, confidence: .9, source: "BASIC_PITCH",
  }]);
  const second = transcription("MT3", [{
    start: 0, end: 1, pitch: 61, velocity: 90, confidence: .9, source: "MT3",
  }]);
  assert.deepEqual(fuseCanonicalNotes([first, second]), []);
  assert.deepEqual(fuseCanonicalNotes([second, first]), []);
});

test("canonical melody fusion preserves only high-confidence isolated evidence from a sole provider", () => {
  const high = transcription("BASIC_PITCH", [{
    start: 0, end: 1, pitch: 60, velocity: 100, confidence: .95, source: "BASIC_PITCH",
  }], .95);
  const low = transcription("BASIC_PITCH", [{
    start: 1, end: 2, pitch: 62, velocity: 100, confidence: .5, source: "BASIC_PITCH",
  }], .9);
  assert.deepEqual(fuseCanonicalNotes([high]).map((note) => note.pitch), [60]);
  assert.deepEqual(fuseCanonicalNotes([low]), []);
  assert.deepEqual(fuseCanonicalNotes([high, transcription("MT3", [])]), []);
});

test("canonical melody fusion never creates notes without voiced transcription evidence", () => {
  assert.deepEqual(fuseCanonicalNotes([]), []);
  assert.deepEqual(fuseCanonicalNotes([
    transcription("BASIC_PITCH", []),
    transcription("MT3", []),
  ]), []);
});

test("bass and chroma support cannot override direct multi-provider disagreement", () => {
  const cFromSheetSage = parseHarmony("SHEETSAGE", {
    version: "1", confidence: .8,
    chords: [{ start: 0, end: 2, symbol: "C", roman: "I", confidence: .9 }],
  }, 2);
  const cFromChroma = parseHarmony("CHROMA", {
    version: "1", confidence: .8,
    chords: [{ start: 0, end: 2, symbol: "C", roman: "I", confidence: .9 }],
  }, 2);
  const gWithAuxiliarySupport = parseHarmony("BASS", {
    version: "1", confidence: .9,
    chords: [{ start: 0, end: 2, symbol: "G", roman: "V", confidence: .9 }],
    bass: [{ start: 0, end: 2, pitch: 43, confidence: 1 }],
    chroma: [{ start: 0, end: 2, values: [0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 1], confidence: 1 }],
  }, 2);
  assert.equal(
    fuseHarmonyEvidence([cFromSheetSage, cFromChroma, gWithAuxiliarySupport]).chords[0]?.symbol,
    "C",
  );
});

test("validates nested chord decision evidence from harmony providers", () => {
  const valid = parseHarmony("SHEETSAGE", {
    version: "1.2.0",
    confidence: 0.91,
    chords: [{
      start: 0,
      end: 2,
      symbol: "Cmaj7",
      roman: "Imaj7",
      confidence: 0.9,
      melodyConflictEvidence: [{
        noteId: "melody-1",
        pitch: 71,
        start: 0.5,
        end: 1,
        conflict: "avoid_note",
        severity: 0.25,
        explanation: "The melody briefly forms a minor ninth.",
      }],
      candidateProvenance: [{
        candidateId: "candidate-1",
        provider: "SHEETSAGE",
        modelVersion: "1.2.0",
        score: 0.93,
        selected: true,
        evidence: ["Strong melody and bass agreement."],
      }],
    }],
  }, 2);
  assert.equal(valid.candidates[0].melodyConflictEvidence?.[0].conflict, "avoid_note");
  assert.equal(valid.candidates[0].candidateProvenance?.[0].score, 0.93);

  for (const malformed of [
    { melodyConflictEvidence: [{}] },
    { melodyConflictEvidence: [{ conflict: 7 }] },
    { candidateProvenance: [{ candidateId: "candidate-1", provider: "SHEETSAGE", score: "high" }] },
    { candidateProvenance: "not-an-array" },
    { timing: { startBeat: -1, durationBeats: 4 } },
    { timing: { startBeat: 0 } },
    { timing: { startSeconds: 0, endSeconds: 3 } },
  ]) {
    assert.throws(() => parseHarmony("SHEETSAGE", {
      version: "1.2.0",
      confidence: 0.91,
      chords: [{
        start: 0,
        end: 2,
        symbol: "Cmaj7",
        roman: "Imaj7",
        confidence: 0.9,
        ...malformed,
      }],
    }, 2), /invalid|must be/);
  }
});

test("accepts unique provider stem data and rejects duplicate roles", () => {
  const previousEndpoint = process.env.DEMUCS_API_URL;
  process.env.DEMUCS_API_URL = "https://provider.invalid";
  try {
    const result = parseSeparation("DEMUCS", {
      version: "2026.08",
      confidence: 0.93,
      stems: [
        {
          role: "vocals",
          contentBase64: "UklGRg==",
          confidence: 0.94,
        },
        {
          role: "instrumental",
          contentBase64: "UklGRg==",
          confidence: 0.92,
        },
      ],
    });
    assert.equal(result.stems.length, 2);
    assert.throws(() => parseSeparation("DEMUCS", {
      version: "2026.08",
      confidence: 0.9,
      stems: [
        { role: "vocals", contentBase64: "UklGRg==", confidence: 0.9 },
        { role: "vocals", contentBase64: "UklGRg==", confidence: 0.9 },
      ],
    }), /duplicate/);
  } finally {
    if (previousEndpoint === undefined) delete process.env.DEMUCS_API_URL;
    else process.env.DEMUCS_API_URL = previousEndpoint;
  }
});

test("prefers configured DEMUCS and keeps license-blocked BS-RoFormer unavailable", async () => {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url?.startsWith("/health?")) {
      const provider = new URL(request.url, "http://worker.invalid").searchParams.get("provider");
      response.end(JSON.stringify({
        provider,
        status: "healthy",
        packageReady: provider === "DEMUCS",
        checkpointReady: true,
        runtimeReady: true,
        smokeTested: true,
        modelVersion: provider === "DEMUCS" ? "4.0.1" : "bs-roformer-viperx-v1",
        gpuReady: provider === "BS_ROFORMER",
         revision: provider === "BS_ROFORMER" ? "bs-roformer-r42" : "demucs-r42",
         containerDigest: "sha256:analysis-worker-r42",
         cudaVersion: "12.4",
         pytorchVersion: "2.5.1",
         gpu: "NVIDIA A100",
        checksum: provider === "DEMUCS"
          ? "8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4"
          : "a".repeat(64),
        ...(provider === "DEMUCS"
          ? {
              sourceRepository: "https://github.com/facebookresearch/demucs",
              sourceRevision: "ef66d254cd6d558e207eeff2c4b8d053db2e77dd",
              license: "MIT",
              licenseSha256: "cf9b17822d1fcd4ff32ccbe14183386fb3adf6f2ff92dc184130823f7fc28173",
              packageArtifactSha256: "e45a5a788bae79767c37bbf6e69aae03862ddcca05550fb79b926346a177d713",
              packageTreeSha256: "75d9c33232395acb77124da9d163084db4c10f08f0475160a36dece847fcc4cd",
            }
          : {}),
      }));
      return;
    }
    assert.equal(request.url, "/separate");
    response.end(JSON.stringify({
      version: "demucs-v4",
      confidence: 0.95,
      stems: [
        { role: "vocals", contentBase64: "UklGRg==", confidence: 0.95 },
        { role: "instrumental", contentBase64: "UklGRg==", confidence: 0.94 },
      ],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previousDemucs = process.env.DEMUCS_API_URL;
  const previousBsRoformer = process.env.BS_ROFORMER_API_URL;
  const previousPromotedBsRoformer =
    process.env.MUSIC_PROVIDER_BS_ROFORMER_ENDPOINT;
  process.env.DEMUCS_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.BS_ROFORMER_API_URL = "http://127.0.0.1:1";
  delete process.env.MUSIC_PROVIDER_BS_ROFORMER_ENDPOINT;
  try {
    const result = await runAnalysisProviders({
      sourceUrl: "https://storage.invalid/signed-source",
      sourceType: "FULL_SONG",
      durationSeconds: 10,
    });
    assert.equal(result.separation?.providerId, "DEMUCS");
    assert.equal(
      result.provenance.find((item) => item.capability === "separation")?.provider,
      "DEMUCS",
    );
    delete process.env.DEMUCS_API_URL;
    process.env.BS_ROFORMER_API_URL = `http://127.0.0.1:${address.port}`;
    const fallback = await runAnalysisProviders({
      sourceUrl: "https://storage.invalid/signed-source",
      sourceType: "FULL_SONG",
      durationSeconds: 10,
    });
    assert.equal(fallback.separation, null);
    const fallbackProvenance = fallback.provenance.find(
      (item) => item.provider === "BS_ROFORMER",
    );
    assert.equal(fallbackProvenance?.status, "unavailable");
    assert.equal(fallbackProvenance?.errorCode, "not-configured");
  } finally {
    if (previousDemucs === undefined) delete process.env.DEMUCS_API_URL;
    else process.env.DEMUCS_API_URL = previousDemucs;
    if (previousBsRoformer === undefined) delete process.env.BS_ROFORMER_API_URL;
    else process.env.BS_ROFORMER_API_URL = previousBsRoformer;
    if (previousPromotedBsRoformer === undefined) {
      delete process.env.MUSIC_PROVIDER_BS_ROFORMER_ENDPOINT;
    } else {
      process.env.MUSIC_PROVIDER_BS_ROFORMER_ENDPOINT =
        previousPromotedBsRoformer;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("ignores every BS-RoFormer endpoint and token alias while license-blocked", async () => {
  let healthRequests = 0;
  let separationPosts = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url?.startsWith("/health?")) {
      healthRequests += 1;
      response.end(JSON.stringify({ status: "ready", healthy: true }));
      return;
    }
    separationPosts += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/separate");
    response.end(JSON.stringify({
      version: "bs-roformer-viperx-v1",
      confidence: 0.95,
      stems: [
        { role: "vocals", contentBase64: "UklGRg==", confidence: 0.95 },
        { role: "instrumental", contentBase64: "UklGRg==", confidence: 0.94 },
      ],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const keys = [
    "MUSIC_PROVIDER_BS_ROFORMER_ENDPOINT",
    "MUSIC_PROVIDER_BS_ROFORMER_URL",
    "MUSIC_PROVIDER_BS_ROFORMER_PROMOTION_BUNDLE",
    "MUSIC_PROVIDER_BS_ROFORMER_PROMOTION_PUBLIC_KEY",
    "MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY",
    "MUSIC_GPU_PROMOTION_PUBLIC_KEY",
    "BS_ROFORMER_API_URL",
    "BS_ROFORMER_SW_API_URL",
    "BS_ROFORMER_API_TOKEN",
    "BS_ROFORMER_SW_API_TOKEN",
    "MUSIC_AI_WORKER_TOKEN",
    "MUSIC_PROVIDER_DEMUCS_URL",
    "DEMUCS_API_URL",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.MUSIC_PROVIDER_BS_ROFORMER_ENDPOINT = endpoint;
  process.env.MUSIC_PROVIDER_BS_ROFORMER_URL = endpoint;
  process.env.BS_ROFORMER_API_URL = endpoint;
  process.env.BS_ROFORMER_SW_API_URL = endpoint;
  process.env.BS_ROFORMER_API_TOKEN = "blocked-api-token";
  process.env.BS_ROFORMER_SW_API_TOKEN = "blocked-sw-token";
  process.env.MUSIC_AI_WORKER_TOKEN = "blocked-shared-token";
  try {
    const result = await runAnalysisProviders({
      sourceUrl: "https://storage.invalid/signed-source",
      sourceType: "FULL_SONG",
      durationSeconds: 10,
    });
    assert.equal(result.separation, null);
    assert.equal(healthRequests, 0);
    assert.equal(separationPosts, 0);
    assert.equal(
      result.provenance.find(
        (item) => item.provider === "BS_ROFORMER",
      )?.errorCode,
      "not-configured",
    );
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("retries exact Beat This startup before primary beat analysis", async () => {
  let analyzeRequests = 0;
  let healthRequests = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/health?provider=BEAT_THIS") {
      healthRequests += 1;
      response.end(JSON.stringify(healthRequests === 1 ? startupHealth : health));
      return;
    }
    if (request.method === "POST" && request.url === "/analyze") {
      analyzeRequests += 1;
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        assert.equal(JSON.parse(body).provider, "BEAT_THIS");
        response.end(JSON.stringify({
          provider: "BEAT_THIS",
          status: "ok",
          result: {
            version: "1.1.0",
            beats: [0, 0.5, 1, 1.5],
            downbeats: [0, 1],
            confidence: 0.98,
          },
        }));
      });
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const record = (
    JSON.parse(committedBeatThisPromotionBundle) as {
      record: GpuPromotionRecord;
    }
  ).record;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = ((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const requested = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (requested.origin === record.endpointOrigin) {
      return nativeFetch(`${endpoint}${requested.pathname}${requested.search}`, init);
    }
    return nativeFetch(input, init);
  }) as typeof fetch;
  const health = {
    provider: record.provider,
    status: "ready",
    ready: true,
    healthy: true,
    retryable: false,
    retryAfterSeconds: null,
    modelVersion: record.modelVersion,
    checksum: record.checkpointSha256,
    checkpointSha256: record.checkpointSha256,
    checkpointReady: true,
    runtimeReady: true,
    smokeTested: true,
    gpuReady: true,
    revision: record.checkpointRevision,
    sourceRevision: record.sourceRevision,
    sourceImageDigest: record.sourceImageDigest,
    modalAppId: record.modalAppId,
    modalDeploymentId: record.modalDeploymentId,
    modalFunctionId: record.modalFunctionId,
    modalImageId: record.modalImageId,
    runtime: { pythonVersion: record.runtime.python },
    framework: {
      python: record.runtime.python,
      cuda_image: record.runtime.cudaImage,
      cuda: record.runtime.cuda,
      pytorch: record.runtime.pytorch,
      torchvision: record.runtime.torchvision,
      torchaudio: record.runtime.torchaudio,
      torch_index_url: record.runtime.torchIndexUrl,
      transformers: record.runtime.transformers,
      accelerate: record.runtime.accelerate,
    },
    packageName: "beat-this",
    packageVersion: record.modelVersion,
    packageReady: true,
    assetReady: true,
    featureExecutionReady: true,
    identityReady: true,
    reason: null,
  };
  const startupHealth = {
    ...health,
    status: "starting",
    ready: false,
    healthy: false,
    retryable: true,
    retryAfterSeconds: 5,
    packageReady: false,
    assetReady: false,
    featureExecutionReady: false,
    runtimeReady: false,
    checkpointReady: false,
    smokeTested: false,
    gpuReady: false,
    reason: "runtime initialization is still in progress",
  };
  const keys = [
    "MUSIC_PROVIDER_BEAT_THIS_URL",
    "BEAT_THIS_API_URL",
    "MUSIC_PROVIDER_BEAT_THIS_PROMOTION_BUNDLE",
    "MUSIC_PROVIDER_BEAT_THIS_PROMOTION_PUBLIC_KEY",
    "MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY",
    "MUSIC_PROVIDER_DEMUCS_URL",
    "DEMUCS_API_URL",
    "MUSIC_PROVIDER_BS_ROFORMER_ENDPOINT",
    "MUSIC_PROVIDER_BS_ROFORMER_URL",
    "BS_ROFORMER_API_URL",
    "BS_ROFORMER_SW_API_URL",
    "MUSIC_PROVIDER_ALL_IN_ONE_URL",
    "ALL_IN_ONE_API_URL",
    "MUSIC_PROVIDER_MT3_URL",
    "MT3_API_URL",
    "MUSIC_PROVIDER_MR_MT3_URL",
    "MR_MT3_API_URL",
    "MUSIC_PROVIDER_YOUR_MT3_URL",
    "YOUR_MT3_API_URL",
    "SHEETSAGE_API_URL",
    "SHEET_SAGE_API_URL",
    "MUSIC_PROVIDER_CHROMA_URL",
    "CHROMA_API_URL",
    "MUSIC_PROVIDER_MADMOM_URL",
    "MADMOM_API_URL",
    "MUSIC_PROVIDER_ESSENTIA_URL",
    "ESSENTIA_API_URL",
    "MUSIC_PROVIDER_PYLOUDNORM_URL",
    "PYLOUDNORM_API_URL",
    "MUSIC_MIR_API_URL",
    "MUSIC_MIR_ESSENTIA_API_URL",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.MUSIC_PROVIDER_BEAT_THIS_URL = record.endpointOrigin;
  try {
    const result = await runAnalysisProviders({
      sourceUrl: "https://storage.invalid/signed-source",
      sourceType: "FULL_SONG",
      durationSeconds: 2,
    });
    assert.equal(healthRequests, 2);
    assert.equal(analyzeRequests, 1);
    assert.deepEqual(result.rhythmEvidence.find(
      (item) => item.provider === "BEAT_THIS",
    ), {
      provider: "BEAT_THIS",
      version: "1.1.0",
      beats: [0, 0.5, 1, 1.5],
      downbeats: [0, 1],
      tempoBpm: 120,
    });
    assert.equal(
      result.provenance.find((item) => item.provider === "BEAT_THIS")?.capability,
      "primary_beat_tracking",
    );
  } finally {
    globalThis.fetch = nativeFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("blocks YOUR_MT3 analyze POST when promoted runtime identity drifts", async () => {
  const record = expectedGpuPromotionRecord("YOUR_MT3");
  assert.ok(record);
  let healthRequests = 0;
  let analyzeRequests = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/health?provider=YOUR_MT3") {
      healthRequests += 1;
      response.end(JSON.stringify({
        provider: record.provider,
        status: "ready",
        ready: true,
        healthy: true,
        runtimeReady: true,
        gpuReady: true,
        checkpointReady: true,
        smokeTested: true,
        modalAppId: record.modalAppId,
        modalDeploymentId: record.modalDeploymentId,
        modalFunctionId: record.modalFunctionId,
        modalImageId: "im-Drifted",
        modelVersion: record.modelVersion,
        version: record.modelVersion,
        checkpointSha256: record.checkpointSha256,
        checksum: record.checkpointSha256,
        revision: record.checkpointRevision,
        sourceRevision: record.sourceRevision,
        sourceImageDigest: record.sourceImageDigest,
        runtime: { pythonVersion: record.runtime.python },
        framework: {
          cuda_image: record.runtime.cudaImage,
          cuda: record.runtime.cuda,
          pytorch: record.runtime.pytorch,
          torchvision: record.runtime.torchvision,
          torchaudio: record.runtime.torchaudio,
          torch_index_url: record.runtime.torchIndexUrl,
          transformers: record.runtime.transformers,
          accelerate: record.runtime.accelerate,
        },
      }));
      return;
    }
    if (request.method === "POST") {
      analyzeRequests += 1;
      response.end(JSON.stringify({ status: "completed", result: {} }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const localEndpoint = `http://127.0.0.1:${address.port}`;
  const endpointKeys = [
    "MUSIC_PROVIDER_BASIC_PITCH_URL",
    "BASIC_PITCH_API_URL",
    "MUSIC_PROVIDER_DEMUCS_URL",
    "DEMUCS_API_URL",
    "MUSIC_PROVIDER_BS_ROFORMER_ENDPOINT",
    "MUSIC_PROVIDER_BS_ROFORMER_URL",
    "BS_ROFORMER_API_URL",
    "BS_ROFORMER_SW_API_URL",
    "MUSIC_PROVIDER_ALL_IN_ONE_URL",
    "ALL_IN_ONE_API_URL",
    "MUSIC_PROVIDER_MT3_URL",
    "MT3_API_URL",
    "MUSIC_PROVIDER_MR_MT3_URL",
    "MR_MT3_API_URL",
    "MUSIC_PROVIDER_YOUR_MT3_URL",
    "YOUR_MT3_API_URL",
    "SHEETSAGE_API_URL",
    "SHEET_SAGE_API_URL",
    "MUSIC_PROVIDER_CHROMA_URL",
    "CHROMA_API_URL",
    "MUSIC_PROVIDER_MADMOM_URL",
    "MADMOM_API_URL",
    "MUSIC_PROVIDER_BEAT_THIS_URL",
    "BEAT_THIS_API_URL",
    "MUSIC_PROVIDER_TORCHCREPE_URL",
    "TORCHCREPE_API_URL",
    "MUSIC_PROVIDER_ESSENTIA_URL",
    "ESSENTIA_API_URL",
    "MUSIC_PROVIDER_PYLOUDNORM_URL",
    "PYLOUDNORM_API_URL",
    "MUSIC_MIR_API_URL",
    "MUSIC_MIR_ESSENTIA_API_URL",
  ];
  const previous = new Map(endpointKeys.map((key) => [key, process.env[key]]));
  for (const key of endpointKeys) delete process.env[key];
  process.env.YOUR_MT3_API_URL = record.endpointOrigin;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const requested = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (requested.origin === record.endpointOrigin) {
      return nativeFetch(
        `${localEndpoint}${requested.pathname}${requested.search}`,
        init,
      );
    }
    return nativeFetch(input, init);
  }) as typeof fetch;
  try {
    const result = await runAnalysisProviders({
      sourceUrl: "https://storage.invalid/signed-source",
      sourceType: "FULL_SONG",
      durationSeconds: 2,
    });
    assert.equal(healthRequests, 1);
    assert.equal(analyzeRequests, 0);
    const provenance = result.provenance.find(
      (item) => item.provider === "YOUR_MT3",
    );
    assert.equal(provenance?.status, "failed");
    assert.equal(provenance?.errorCode, "health-attestation-failed");
  } finally {
    globalThis.fetch = nativeFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("keeps absent providers explicit without fabricating analysis results", async () => {
  const keys = [
    "ALL_IN_ONE_API_URL",
    "MT3_API_URL",
    "BS_ROFORMER_API_URL",
    "BS_ROFORMER_SW_API_URL",
    "MUSIC_PROVIDER_BS_ROFORMER_ENDPOINT",
    "DEMUCS_API_URL",
    "SHEETSAGE_API_URL",
    "SHEET_SAGE_API_URL",
    "CHROMA_API_URL",
    "BASS_API_URL",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    const result = await runAnalysisProviders({
      sourceUrl: null,
      sourceType: "FULL_SONG",
      durationSeconds: 60,
    });
    assert.equal(result.structure, null);
    assert.deepEqual(result.transcriptions, []);
    assert.equal(result.separation, null);
    assert.deepEqual(result.harmony, []);
    assert.deepEqual(
      new Set(result.provenance.map((item) => item.provider)),
      new Set([
        "ALL_IN_ONE",
        "MT3",
        "MR_MT3",
        "YOUR_MT3",
        "BS_ROFORMER",
        "SHEETSAGE",
        "CHROMA",
        "MADMOM",
        "BEAT_THIS",
        "ESSENTIA",
        "PYLOUDNORM",
      ]),
    );
    assert.ok(result.provenance.every((item) => item.status === "unavailable"));
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("connects SheetSage melody, harmony, and timing provenance from real audio payloads", async () => {
  const previous = new Map([
    ["SHEETSAGE_API_URL", process.env.SHEETSAGE_API_URL],
    ["SHEETSAGE_LICENSE_AUTHORIZED", process.env.SHEETSAGE_LICENSE_AUTHORIZED],
    ["SHEETSAGE_API_TOKEN", process.env.SHEETSAGE_API_TOKEN],
  ]);
  let analyzePayload: Buffer | null = null;
  let analyzeContentType: string | undefined;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/source.wav") {
        response.setHeader("Content-Type", "audio/wav");
      response.end(Buffer.from("real-audio-fixture"));
      return;
    }
    if (request.method === "GET" && request.url === "/health?provider=SHEETSAGE") {
      response.end(JSON.stringify({
        provider: "SHEETSAGE",
        version: "0.2.1",
        sourceRevision: "openmirlab/sheetsage-infer@ee7c2aeeb8084840a4f938ae6913f566afdaebdc",
        status: "ready",
        assetsVerified: true,
        runtimeReady: true,
        checkpointReady: true,
        smokeTested: true,
        smokeProofVerified: true,
        checksum: "a".repeat(64),
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/analyze") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      request.on("end", () => {
        analyzePayload = Buffer.concat(chunks);
        analyzeContentType = request.headers["content-type"];
        response.end(JSON.stringify({
          provider: "SHEETSAGE",
          modelVersion: "0.2.1",
          confidence: 0.9,
          melody: [{ start: 0, end: 1, pitch: 60, confidence: 0.91 }],
          chords: [{
            start: 0,
            end: 2,
            symbol: "C",
            confidence: 0.89,
            timing: { startSeconds: 0, endSeconds: 2 },
          }],
          timing: [{ start: 0, end: 0.5, beat: 0 }],
        }));
      });
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  process.env.SHEETSAGE_API_URL = endpoint;
  process.env.SHEETSAGE_LICENSE_AUTHORIZED = "true";
  process.env.SHEETSAGE_API_TOKEN = "test-token";
  try {
    const result = await runAnalysisProviders({
      sourceUrl: `${endpoint}/source.wav`,
      sourceType: "FULL_SONG",
      durationSeconds: 2,
    });
    assert.equal((analyzePayload as Buffer | null)?.toString(), "real-audio-fixture");
    assert.equal(analyzeContentType, "audio/wav");
    assert.equal(result.transcriptions[0]?.providerId, "SHEETSAGE");
    assert.equal(result.transcriptions[0]?.notes[0]?.pitch, 60);
    assert.equal(result.harmony[0]?.providerId, "SHEETSAGE");
    assert.deepEqual(result.timingEvidence[0], {
      provider: "SHEETSAGE",
      version: "0.2.1",
      events: [{ start: 0, end: 0.5, beat: 0 }],
    });
    assert.deepEqual(
      new Set(result.provenance
        .filter((item) => item.provider === "SHEETSAGE" && item.status === "ready")
        .map((item) => item.capability)),
      new Set(["harmony", "melody", "timing"]),
    );
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("reports one logical SheetSage capacity rejection across provider retries", async () => {
  const keys = [
    "SHEETSAGE_API_URL",
    "SHEETSAGE_LICENSE_AUTHORIZED",
    "SHEETSAGE_API_TOKEN",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  let analyzeRequests = 0;
  const recordedAnalysisKeys: string[] = [];
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/source.wav") {
      response.setHeader("Content-Type", "audio/wav");
      response.end(Buffer.from("real-audio-fixture"));
      return;
    }
    if (request.method === "GET" && request.url === "/health?provider=SHEETSAGE") {
      response.end(JSON.stringify({
        provider: "SHEETSAGE",
        version: "0.2.1",
        sourceRevision: "openmirlab/sheetsage-infer@ee7c2aeeb8084840a4f938ae6913f566afdaebdc",
        status: "ready",
        assetsVerified: true,
        runtimeReady: true,
        checkpointReady: true,
        smokeTested: true,
        smokeProofVerified: true,
        checksum: "a".repeat(64),
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/analyze") {
      analyzeRequests += 1;
      request.resume();
      response.statusCode = 503;
      response.setHeader("X-SheetSage-Rejection", "capacity-admission");
      response.end(JSON.stringify({ detail: "capacity busy" }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.SHEETSAGE_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.SHEETSAGE_LICENSE_AUTHORIZED = "true";
  process.env.SHEETSAGE_API_TOKEN = "test-token";
  try {
    const result = await runAnalysisProviders({
      sourceUrl: `http://127.0.0.1:${address.port}/source.wav`,
      sourceType: "FULL_SONG",
      durationSeconds: 10,
      idempotencyKey: "analysis-one",
      onSheetSageCapacityRejection: async (analysisKey) => {
        recordedAnalysisKeys.push(analysisKey);
      },
    });
    assert.equal(analyzeRequests, 3);
    assert.deepEqual(recordedAnalysisKeys, ["analysis-one"]);
    assert.equal(
      result.provenance.find((item) => item.provider === "SHEETSAGE")?.errorCode,
      "http-503",
    );
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("rejects an oversized SheetSage source before sending it to the provider", async () => {
  const previous = new Map([
    ["SHEETSAGE_API_URL", process.env.SHEETSAGE_API_URL],
    ["SHEETSAGE_LICENSE_AUTHORIZED", process.env.SHEETSAGE_LICENSE_AUTHORIZED],
    ["SHEETSAGE_API_TOKEN", process.env.SHEETSAGE_API_TOKEN],
  ]);
  let analyzeRequests = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/source.wav") {
      response.setHeader("Content-Length", String(512 * 1024 * 1024 + 1));
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/health?provider=SHEETSAGE") {
      response.end(JSON.stringify({
        provider: "SHEETSAGE",
        version: "0.2.1",
        sourceRevision: "openmirlab/sheetsage-infer@ee7c2aeeb8084840a4f938ae6913f566afdaebdc",
        status: "ready",
        assetsVerified: true,
        runtimeReady: true,
        checkpointReady: true,
        smokeTested: true,
        smokeProofVerified: true,
        checksum: "a".repeat(64),
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/analyze") {
      analyzeRequests += 1;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  process.env.SHEETSAGE_API_URL = endpoint;
  process.env.SHEETSAGE_LICENSE_AUTHORIZED = "true";
  process.env.SHEETSAGE_API_TOKEN = "test-token";
  try {
    const result = await runAnalysisProviders({
      sourceUrl: `${endpoint}/source.wav`,
      sourceType: "FULL_SONG",
      durationSeconds: 2,
    });
    assert.equal(analyzeRequests, 0);
    const sheetSage = result.provenance
      .find((item) => item.provider === "SHEETSAGE");
    assert.equal(sheetSage?.status, "failed");
    assert.equal(sheetSage?.errorCode, "source-too-large");
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("polls an asynchronous provider job and returns its completed result", async () => {
  let polls = 0;
  let idempotencyKey: string | undefined;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/health?provider=BASIC_PITCH") {
      response.end(JSON.stringify({
        provider: "BASIC_PITCH",
        status: "ready",
        packageReady: true,
        checkpointReady: true,
        runtimeReady: true,
        smokeTested: true,
        modelVersion: "0.4.0",
        checksum: "b74344cd0c58261dae0cd52050d85ab6f901a5e219f27046ab4640673bba1046",
        sourceRepository: "https://github.com/spotify/basic-pitch",
        sourceRevision: "9991303bba609a3b93089d13ec80d1d495083596",
        license: "Apache-2.0",
        licenseSha256: "929c910bae2152fa87199a5d0660e09263419b7eee6d4b301d05ee2aaf211c37",
        noticeSha256: "b810e55c0e3b520fabb45fc2ccc74880187bf84e309971968541cc812dcde905",
        packageArtifactSha256: "738adb503aae7fdfc7d1e1511aa0ce35052315f260a19531ef4c356708425db0",
        packageTreeSha256: "89cfb8516927e3bc536da99139ddb4ad7ce79dc833e29df33e5bca27ccef116c",
        inferenceBackend: "tensorflow-saved-model",
        runtimePackages: {
          tensorflow: "2.14.0",
          numpy: "1.26.4",
          librosa: "0.11.0",
          resampy: "0.4.2",
          "pretty-midi": "0.2.11.post0",
        },
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/analyze") {
      const header = request.headers["idempotency-key"];
      idempotencyKey = Array.isArray(header) ? header[0] : header;
      response.writeHead(202);
      response.end(JSON.stringify({ jobId: "transcription-1", status: "queued" }));
      return;
    }
    if (request.method === "GET" && request.url === "/jobs/transcription-1") {
      polls += 1;
      response.writeHead(200);
      response.end(JSON.stringify({
        jobId: "transcription-1",
        status: "completed",
        result: {
          version: "async-1",
          confidence: 0.92,
          notes: [
            { start: 0, end: 0.5, pitch: 60, velocity: 96, confidence: 0.94 },
          ],
        },
      }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previousBasicPitch = process.env.BASIC_PITCH_API_URL;
  const previousSheetSage = process.env.SHEET_SAGE_API_URL;
  process.env.BASIC_PITCH_API_URL = `http://127.0.0.1:${address.port}`;
  delete process.env.SHEET_SAGE_API_URL;
  try {
    const result = await runAnalysisProviders({
      sourceUrl: "https://storage.invalid/signed-source",
      sourceType: "VOCAL_ONLY",
      durationSeconds: 10,
      idempotencyKey: "active-analysis-job-1",
    });
    assert.equal(result.transcriptions[0]?.providerId, "BASIC_PITCH");
    assert.equal(idempotencyKey, "active-analysis-job-1:BASIC_PITCH");
    assert.equal(result.transcriptions[0]?.notes[0]?.pitch, 60);
    assert.equal(polls, 1);
  } finally {
    if (previousBasicPitch === undefined) delete process.env.BASIC_PITCH_API_URL;
    else process.env.BASIC_PITCH_API_URL = previousBasicPitch;
    if (previousSheetSage === undefined) delete process.env.SHEET_SAGE_API_URL;
    else process.env.SHEET_SAGE_API_URL = previousSheetSage;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("does not transfer source after Basic Pitch package readiness drift", async () => {
  let analysisRequests = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET") {
      response.end(JSON.stringify({
        provider: "BASIC_PITCH",
        status: "ready",
        packageReady: false,
        checkpointReady: true,
        runtimeReady: true,
        smokeTested: true,
        modelVersion: "0.4.0",
        checksum: "b74344cd0c58261dae0cd52050d85ab6f901a5e219f27046ab4640673bba1046",
        sourceRepository: "https://github.com/spotify/basic-pitch",
        sourceRevision: "9991303bba609a3b93089d13ec80d1d495083596",
        license: "Apache-2.0",
        licenseSha256: "929c910bae2152fa87199a5d0660e09263419b7eee6d4b301d05ee2aaf211c37",
        noticeSha256: "b810e55c0e3b520fabb45fc2ccc74880187bf84e309971968541cc812dcde905",
        packageArtifactSha256: "738adb503aae7fdfc7d1e1511aa0ce35052315f260a19531ef4c356708425db0",
        packageTreeSha256: "89cfb8516927e3bc536da99139ddb4ad7ce79dc833e29df33e5bca27ccef116c",
        inferenceBackend: "tensorflow-saved-model",
        runtimePackages: {
          tensorflow: "2.14.0",
          numpy: "1.26.4",
          librosa: "0.11.0",
          resampy: "0.4.2",
          "pretty-midi": "0.2.11.post0",
        },
      }));
      return;
    }
    analysisRequests += 1;
    response.end(JSON.stringify({}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = process.env.BASIC_PITCH_API_URL;
  process.env.BASIC_PITCH_API_URL = `http://127.0.0.1:${address.port}`;
  try {
    const result = await runAnalysisProviders({
      sourceUrl: "https://storage.invalid/signed-source",
      sourceType: "VOCAL_ONLY",
      durationSeconds: 10,
    });
    assert.equal(analysisRequests, 0);
    assert.deepEqual(result.transcriptions, []);
    const provenance = result.provenance.find((item) => item.provider === "BASIC_PITCH");
    assert.equal(provenance?.status, "failed");
    assert.equal(provenance?.errorCode, "health-attestation-failed");
  } finally {
    if (previous === undefined) delete process.env.BASIC_PITCH_API_URL;
    else process.env.BASIC_PITCH_API_URL = previous;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("requires signed exact Modal provenance before sending audio to ALL_IN_ONE", async () => {
  const record = expectedGpuPromotionRecord("ALL_IN_ONE");
  assert.ok(record);
  let reportedImageId = record.modalImageId;
  let analysisRequests = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/health?provider=ALL_IN_ONE") {
      response.end(JSON.stringify({
        provider: "ALL_IN_ONE",
        status: "ready",
        checkpointReady: true,
        runtimeReady: true,
        smokeTested: true,
        gpuReady: true,
        modelVersion: record.modelVersion,
        checksum: record.checkpointSha256,
        checkpointSha256: record.checkpointSha256,
        revision: record.checkpointRevision,
        sourceRevision: record.sourceRevision,
        sourceImageDigest: record.sourceImageDigest,
        containerDigest: record.sourceImageDigest,
        modalAppId: record.modalAppId,
        modalDeploymentId: record.modalDeploymentId,
        modalFunctionId: record.modalFunctionId,
        modalImageId: reportedImageId,
        runtime: { pythonVersion: record.runtime.python },
        framework: {
          cuda_image: record.runtime.cudaImage,
          cuda: record.runtime.cuda,
          pytorch: record.runtime.pytorch,
          torchvision: record.runtime.torchvision,
          torchaudio: record.runtime.torchaudio,
          torch_index_url: record.runtime.torchIndexUrl,
          transformers: record.runtime.transformers,
          accelerate: record.runtime.accelerate,
        },
        cudaVersion: record.runtime.cuda,
        pytorchVersion: record.runtime.pytorch,
        gpu: "NVIDIA L4",
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/analyze") {
      analysisRequests += 1;
      response.end(JSON.stringify({
        version: "all-in-one-infer-3.1.0",
        confidence: 1,
        bpm: 120,
        meter: "4/4",
        tempoMap: [{ time: 0, bpm: 120, confidence: 1 }],
        meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
        beats: [
          { time: 0, bar: 1, beat: 1, confidence: 1 },
          { time: 0.5, bar: 1, beat: 2, confidence: 1 },
          { time: 1, bar: 1, beat: 3, confidence: 1 },
          { time: 1.5, bar: 1, beat: 4, confidence: 1 },
        ],
        downbeats: [{ time: 0 }],
        bars: [{ bar: 1, start: 0, end: 2, beats: 4, confidence: 1 }],
        sections: [{ name: "intro", startBar: 1, endBar: 1, energy: 1 }],
      }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpointOrigin = `http://127.0.0.1:${address.port}`;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = ((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const requested = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (requested.origin === record.endpointOrigin) {
      return nativeFetch(
        `${endpointOrigin}${requested.pathname}${requested.search}`,
        init,
      );
    }
    return nativeFetch(input, init);
  }) as typeof fetch;
  const keys = [
    "ALL_IN_ONE_API_URL",
    "MUSIC_PROVIDER_ALL_IN_ONE_PROMOTION_BUNDLE",
    "MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY",
    "MUSIC_GPU_PROMOTION_PUBLIC_KEY",
    "MT3_API_URL",
    "BS_ROFORMER_API_URL",
    "BS_ROFORMER_SW_API_URL",
    "SHEETSAGE_API_URL",
    "SHEET_SAGE_API_URL",
    "CHROMA_API_URL",
    "BASS_API_URL",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.ALL_IN_ONE_API_URL = record.endpointOrigin;
    const accepted = await runAnalysisProviders({
      sourceUrl: "https://storage.invalid/signed-source",
      sourceType: "FULL_SONG",
      durationSeconds: 2,
    });
    assert.equal(accepted.structure?.providerId, "ALL_IN_ONE");
    assert.equal(analysisRequests, 1);

    reportedImageId = "im-AllInOneDrift";
    const rejected = await runAnalysisProviders({
      sourceUrl: "https://storage.invalid/signed-source",
      sourceType: "FULL_SONG",
      durationSeconds: 2,
    });
    assert.equal(rejected.structure, null);
    assert.equal(analysisRequests, 1);
    assert.match(
      rejected.provenance.find((item) => item.provider === "ALL_IN_ONE")?.errorMessage ?? "",
      /runtime identity does not match the promoted deployment record/,
    );
  } finally {
    globalThis.fetch = nativeFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test("re-attests MIR health and blocks a second analyze after identity drift", async () => {
  let healthRequests = 0;
  let sourceRequests = 0;
  let analyzeRequests = 0;
  let healthDrifted = false;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/health?provider=MADMOM") {
      healthRequests += 1;
      response.end(JSON.stringify({
        ...VALID_MADMOM_HEALTH,
        ...(healthDrifted
          ? { smokeEvidenceSha256: "0".repeat(64) }
          : {}),
      }));
      return;
    }
    if (request.method === "GET" && request.url === "/source.wav") {
      sourceRequests += 1;
      response.end(Buffer.from("private-source-must-not-transfer"));
      return;
    }
    if (request.method === "POST") {
      analyzeRequests += 1;
      response.end(JSON.stringify({
        version: "0.2.0",
        beats: [0, 0.5, 1],
        downbeats: [0],
        tempoBpm: 120,
      }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const endpointKeys = [
    "MUSIC_PROVIDER_BASIC_PITCH_URL",
    "BASIC_PITCH_API_URL",
    "MUSIC_PROVIDER_DEMUCS_URL",
    "DEMUCS_API_URL",
    "MUSIC_PROVIDER_BS_ROFORMER_ENDPOINT",
    "MUSIC_PROVIDER_BS_ROFORMER_URL",
    "BS_ROFORMER_API_URL",
    "BS_ROFORMER_SW_API_URL",
    "MUSIC_PROVIDER_ALL_IN_ONE_URL",
    "ALL_IN_ONE_API_URL",
    "MUSIC_PROVIDER_MT3_URL",
    "MT3_API_URL",
    "MUSIC_PROVIDER_MR_MT3_URL",
    "MR_MT3_API_URL",
    "MUSIC_PROVIDER_YOUR_MT3_URL",
    "YOUR_MT3_API_URL",
    "SHEETSAGE_API_URL",
    "SHEET_SAGE_API_URL",
    "MUSIC_PROVIDER_CHROMA_URL",
    "CHROMA_API_URL",
    "MUSIC_PROVIDER_MADMOM_URL",
    "MADMOM_API_URL",
    "MUSIC_PROVIDER_BEAT_THIS_URL",
    "BEAT_THIS_API_URL",
    "MUSIC_PROVIDER_TORCHCREPE_URL",
    "TORCHCREPE_API_URL",
    "MUSIC_PROVIDER_ESSENTIA_URL",
    "ESSENTIA_API_URL",
    "MUSIC_PROVIDER_PYLOUDNORM_URL",
    "PYLOUDNORM_API_URL",
    "MUSIC_MIR_API_URL",
    "MUSIC_MIR_ESSENTIA_API_URL",
  ];
  const previous = new Map(endpointKeys.map((key) => [key, process.env[key]]));
  for (const key of endpointKeys) delete process.env[key];
  process.env.MADMOM_API_URL = endpoint;
  try {
    const first = await runAnalysisProviders({
      sourceUrl: `${endpoint}/source.wav`,
      sourceType: "FULL_SONG",
      durationSeconds: 2,
    });
    assert.ok(first.provenance.some((item) => item.provider === "MADMOM"));
    assert.equal(healthRequests, analyzeRequests);
    assert.equal(sourceRequests, 0);
    assert.ok(analyzeRequests > 0);
    const healthRequestsAfterFirst = healthRequests;
    const analyzeRequestsAfterFirst = analyzeRequests;
    healthDrifted = true;
    const second = await runAnalysisProviders({
      sourceUrl: `${endpoint}/source.wav`,
      sourceType: "FULL_SONG",
      durationSeconds: 2,
    });
    assert.ok(healthRequests > healthRequestsAfterFirst);
    assert.equal(sourceRequests, 0);
    assert.equal(analyzeRequests, analyzeRequestsAfterFirst);
    assert.equal(
      second.provenance.find((item) => item.provider === "MADMOM")?.status,
      "failed",
    );
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test("re-attests MIR health before a retry and blocks the second POST after drift", async () => {
  let healthRequests = 0;
  let analyzeRequests = 0;
  let healthDrifted = false;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/health?provider=MADMOM") {
      healthRequests += 1;
      response.end(JSON.stringify({
        ...VALID_MADMOM_HEALTH,
        ...(healthDrifted
          ? { smokeEvidenceSha256: "0".repeat(64) }
          : {}),
      }));
      return;
    }
    if (request.method === "POST") {
      analyzeRequests += 1;
      healthDrifted = true;
      response.writeHead(503);
      response.end(JSON.stringify({ error: "retryable failure" }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const endpointKeys = [
    "MUSIC_PROVIDER_BASIC_PITCH_URL",
    "BASIC_PITCH_API_URL",
    "MUSIC_PROVIDER_DEMUCS_URL",
    "DEMUCS_API_URL",
    "MUSIC_PROVIDER_BS_ROFORMER_ENDPOINT",
    "MUSIC_PROVIDER_BS_ROFORMER_URL",
    "BS_ROFORMER_API_URL",
    "BS_ROFORMER_SW_API_URL",
    "MUSIC_PROVIDER_ALL_IN_ONE_URL",
    "ALL_IN_ONE_API_URL",
    "MUSIC_PROVIDER_MT3_URL",
    "MT3_API_URL",
    "MUSIC_PROVIDER_MR_MT3_URL",
    "MR_MT3_API_URL",
    "MUSIC_PROVIDER_YOUR_MT3_URL",
    "YOUR_MT3_API_URL",
    "SHEETSAGE_API_URL",
    "SHEET_SAGE_API_URL",
    "MUSIC_PROVIDER_CHROMA_URL",
    "CHROMA_API_URL",
    "MUSIC_PROVIDER_MADMOM_URL",
    "MADMOM_API_URL",
    "MUSIC_PROVIDER_BEAT_THIS_URL",
    "BEAT_THIS_API_URL",
    "MUSIC_PROVIDER_TORCHCREPE_URL",
    "TORCHCREPE_API_URL",
    "MUSIC_PROVIDER_ESSENTIA_URL",
    "ESSENTIA_API_URL",
    "MUSIC_PROVIDER_PYLOUDNORM_URL",
    "PYLOUDNORM_API_URL",
    "MUSIC_MIR_API_URL",
    "MUSIC_MIR_ESSENTIA_API_URL",
  ];
  const previous = new Map(endpointKeys.map((key) => [key, process.env[key]]));
  for (const key of endpointKeys) delete process.env[key];
  process.env.MADMOM_API_URL = endpoint;
  try {
    const result = await runAnalysisProviders({
      sourceUrl: `${endpoint}/source.wav`,
      sourceType: "FULL_SONG",
      durationSeconds: 2,
    });
    assert.ok(healthRequests >= 2);
    assert.equal(analyzeRequests, 1);
    assert.equal(
      result.provenance.find((item) => item.provider === "MADMOM")?.status,
      "failed",
    );
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});