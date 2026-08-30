import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import {
  parseHarmony,
  parseSeparation,
  runAnalysisProviders,
} from "./analysisProviders";
import { canonicalGpuPromotionJson } from "./gpuProviderAttestation";

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
  const previousBsRoformerChecksum = process.env.BS_ROFORMER_CHECKPOINT_SHA256;
  process.env.DEMUCS_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.BS_ROFORMER_API_URL = "http://127.0.0.1:1";
  process.env.BS_ROFORMER_CHECKPOINT_SHA256 = "a".repeat(64);
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
    if (previousBsRoformerChecksum === undefined) {
      delete process.env.BS_ROFORMER_CHECKPOINT_SHA256;
    } else {
      process.env.BS_ROFORMER_CHECKPOINT_SHA256 = previousBsRoformerChecksum;
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
      new Set(["ALL_IN_ONE", "MT3", "BS_ROFORMER", "SHEETSAGE", "CHROMA", "BASS"]),
    );
    assert.ok(result.provenance.every((item) => item.status === "unavailable"));
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
        checkpointReady: true,
        runtimeReady: true,
        smokeTested: true,
        modelVersion: "0.4.0",
        checksum: "2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec",
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

test("does not execute or record ready provenance after a failed local attestation", async () => {
  let analysisRequests = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET") {
      response.end(JSON.stringify({
        provider: "IMPOSTER",
        status: "healthy",
        checkpointReady: true,
        runtimeReady: true,
        smokeTested: true,
        modelVersion: "0.4.0",
        checksum: "wrong-checksum",
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