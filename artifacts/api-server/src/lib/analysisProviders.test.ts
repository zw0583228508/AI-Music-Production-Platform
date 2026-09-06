import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { canonicalGpuPromotionJson, type GpuPromotionRecord } from "./gpuProviderAttestation";
import { attestAnalysisProviderHealth } from "./analysisProviderManifest";
import {
  parseHarmony,
  fuseHarmonyEvidence,
  parseSeparation,
  runAnalysisProviders,
  analyzeVerifiedBassStem,
} from "./analysisProviders";

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
  const previousEndpoint = process.env.BS_ROFORMER_API_URL;
  process.env.BS_ROFORMER_API_URL = "https://provider.invalid";
  try {
    const result = parseSeparation("BS_ROFORMER", {
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
    assert.throws(() => parseSeparation("BS_ROFORMER", {
      version: "2026.08",
      confidence: 0.9,
      stems: [
        { role: "vocals", contentBase64: "UklGRg==", confidence: 0.9 },
        { role: "vocals", contentBase64: "UklGRg==", confidence: 0.9 },
      ],
    }), /duplicate/);
  } finally {
    if (previousEndpoint === undefined) delete process.env.BS_ROFORMER_API_URL;
    else process.env.BS_ROFORMER_API_URL = previousEndpoint;
  }
});

test("prefers configured DEMUCS and rejects an unsigned GPU fallback", async () => {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url?.startsWith("/health?")) {
      const provider = new URL(request.url, "http://worker.invalid").searchParams.get("provider");
      response.end(JSON.stringify({
        provider,
        status: "healthy",
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
    assert.equal(fallbackProvenance?.status, "failed");
    assert.equal(fallbackProvenance?.errorCode, "health-attestation-failed");
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

test("routes BS-RoFormer separation only after signed deployment attestation", async () => {
  let health: Record<string, unknown> = {};
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url?.startsWith("/health?")) {
      response.end(JSON.stringify(health));
      return;
    }
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
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const record: GpuPromotionRecord = {
    schemaVersion: 1,
    provider: "BS_ROFORMER",
    modalAppId: "ap-Test",
    modalDeploymentId: "v20",
    modalFunctionId: "fu-Test",
    modalImageId: "im-Test",
    endpointOrigin: endpoint,
    modelVersion: "bs-roformer-viperx-v1",
    checkpointSha256: "a".repeat(64),
    checkpointRevision: "repo/checkpoint@immutable",
    sourceRevision: "a".repeat(40),
    sourceImageDigest: `sha256:${"b".repeat(64)}`,
    runtime: {
      python: "3.11.11",
      cudaImage: "cuda-image",
      cuda: "12.4",
      pytorch: "2.5.1",
      torchvision: "0.20.1",
      torchaudio: "2.5.1",
      torchIndexUrl: "https://download.pytorch.org/whl/cu124",
      transformers: "4.48.3",
      accelerate: "1.3.0",
    },
  };
  health = {
    status: "ready",
    healthy: true,
    provider: record.provider,
    checkpointReady: true,
    runtimeReady: true,
    gpuReady: true,
    smokeTested: true,
    modelVersion: record.modelVersion,
    checksum: record.checkpointSha256,
    checkpointSha256: record.checkpointSha256,
    revision: record.checkpointRevision,
    sourceRevision: record.sourceRevision,
    sourceImageDigest: record.sourceImageDigest,
    modalAppId: record.modalAppId,
    modalDeploymentId: record.modalDeploymentId,
    modalFunctionId: record.modalFunctionId,
    modalImageId: record.modalImageId,
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
  };
  const signature = sign(
    null,
    Buffer.from(canonicalGpuPromotionJson(record)),
    privateKey,
  ).toString("base64");
  const keys = [
    "MUSIC_PROVIDER_BS_ROFORMER_ENDPOINT",
    "MUSIC_PROVIDER_BS_ROFORMER_PROMOTION_BUNDLE",
    "MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY",
    "BS_ROFORMER_API_URL",
    "DEMUCS_API_URL",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.MUSIC_PROVIDER_BS_ROFORMER_ENDPOINT = endpoint;
  process.env.MUSIC_PROVIDER_BS_ROFORMER_PROMOTION_BUNDLE = JSON.stringify({
    record,
    signature,
  });
  process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY = publicKey.export({
    type: "spki",
    format: "pem",
  }).toString();
  delete process.env.BS_ROFORMER_API_URL;
  delete process.env.DEMUCS_API_URL;
  try {
    const result = await runAnalysisProviders({
      sourceUrl: "https://storage.invalid/signed-source",
      sourceType: "FULL_SONG",
      durationSeconds: 10,
    });
    assert.equal(result.separation?.providerId, "BS_ROFORMER");
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
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
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
  const record: GpuPromotionRecord = {
    schemaVersion: 1,
    provider: "BEAT_THIS",
    modalAppId: "ap-BeatThis",
    modalDeploymentId: "dp-BeatThis",
    modalFunctionId: "fu-BeatThis",
    modalImageId: "im-BeatThis",
    endpointOrigin: endpoint,
    modelVersion: "1.1.0",
    checkpointSha256: "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331",
    checkpointRevision: "final0@8c328b45",
    sourceRevision: "b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c",
    sourceImageDigest: `sha256:${"c".repeat(64)}`,
    runtime: {
      python: "3.11.11",
      cudaImage: "nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04",
      cuda: "12.4.1",
      pytorch: "2.5.1+cu124",
      torchvision: "0.20.1+cu124",
      torchaudio: "2.5.1+cu124",
      torchIndexUrl: "https://download.pytorch.org/whl/cu124",
      transformers: "4.48.3",
      accelerate: "1.3.0",
    },
  };
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
  process.env.MUSIC_PROVIDER_BEAT_THIS_URL = endpoint;
  process.env.MUSIC_PROVIDER_BEAT_THIS_PROMOTION_BUNDLE = JSON.stringify({
    record,
    signature: sign(
      null,
      Buffer.from(canonicalGpuPromotionJson(record)),
      privateKey,
    ).toString("base64"),
  });
  process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY = publicKey.export({
    type: "spki",
    format: "pem",
  }).toString();
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
  const checkpointSha256 =
    "4b8d00db3903c3b505cc5d2ec1a84787ccc2e1cc446f838118e03e9a356552e5";
  const checkpointRevision =
    "taejunkim/allinone@379e5fd010b3fdd0ee8381ff8cbcfa51d70b5c19;" +
    "facebookresearch/demucs@ef66d254cd6d558e207eeff2c4b8d053db2e77dd";
  const sourceRevision =
    "openmirlab/all-in-one-infer@3c93b4ae389328544dd5955af7497030cb1bca3a";
  const sourceImageDigest = `sha256:${"c".repeat(64)}`;
  const runtime = {
    python: "3.11.11",
    cudaImage: "nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04",
    cuda: "12.4.1",
    pytorch: "torch==2.5.1+cu124",
    torchvision: "torchvision==0.20.1+cu124",
    torchaudio: "torchaudio==2.5.1+cu124",
    torchIndexUrl: "https://download.pytorch.org/whl/cu124",
    transformers: "transformers==4.48.3",
    accelerate: "accelerate==1.3.0",
  };
  let expectedFunctionId = "fu-AllInOneFirst";
  let reportedImageId = "im-AllInOneDrift";
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
        modelVersion: "all-in-one-infer-3.1.0",
        checksum: checkpointSha256,
        checkpointSha256,
        revision: checkpointRevision,
        sourceRevision,
        sourceImageDigest,
        containerDigest: sourceImageDigest,
        modalAppId: "ap-AllInOne",
        modalDeploymentId: "dp-AllInOne",
        modalFunctionId: expectedFunctionId,
        modalImageId: reportedImageId,
        runtime: { pythonVersion: runtime.python },
        framework: {
          cuda_image: runtime.cudaImage,
          cuda: runtime.cuda,
          pytorch: runtime.pytorch,
          torchvision: runtime.torchvision,
          torchaudio: runtime.torchaudio,
          torch_index_url: runtime.torchIndexUrl,
          transformers: runtime.transformers,
          accelerate: runtime.accelerate,
        },
        cudaVersion: runtime.cuda,
        pytorchVersion: runtime.pytorch,
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
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const installBundle = (modalFunctionId: string) => {
    const record = {
      schemaVersion: 1,
      provider: "ALL_IN_ONE",
      modalAppId: "ap-AllInOne",
      modalDeploymentId: "dp-AllInOne",
      modalFunctionId,
      modalImageId: "im-AllInOneVerified",
      endpointOrigin,
      modelVersion: "all-in-one-infer-3.1.0",
      checkpointSha256,
      checkpointRevision,
      sourceRevision,
      sourceImageDigest,
      runtime,
    };
    process.env.MUSIC_PROVIDER_ALL_IN_ONE_PROMOTION_BUNDLE = JSON.stringify({
      record,
      signature: sign(
        null,
        Buffer.from(canonicalGpuPromotionJson(record)),
        privateKey,
      ).toString("base64"),
    });
  };
  try {
    for (const key of keys) delete process.env[key];
    process.env.ALL_IN_ONE_API_URL = endpointOrigin;
    process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY = publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();
    installBundle(expectedFunctionId);
    const rejected = await runAnalysisProviders({
      sourceUrl: "https://storage.invalid/signed-source",
      sourceType: "FULL_SONG",
      durationSeconds: 2,
    });
    assert.equal(rejected.structure, null);
    assert.equal(analysisRequests, 0);
    assert.match(
      rejected.provenance.find((item) => item.provider === "ALL_IN_ONE")?.errorMessage ?? "",
      /runtime identity does not match the promoted deployment record/,
    );

    expectedFunctionId = "fu-AllInOneSecond";
    reportedImageId = "im-AllInOneVerified";
    installBundle(expectedFunctionId);
    const accepted = await runAnalysisProviders({
      sourceUrl: "https://storage.invalid/signed-source",
      sourceType: "FULL_SONG",
      durationSeconds: 2,
    });
    assert.equal(accepted.structure?.providerId, "ALL_IN_ONE");
    assert.equal(analysisRequests, 1);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});