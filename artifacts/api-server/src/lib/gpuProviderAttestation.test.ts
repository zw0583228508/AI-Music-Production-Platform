import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  canonicalGpuPromotionJson,
  gpuPromotionAttestationFailure,
  isAttestedGpuProviderStartup,
  type GpuPromotionRecord,
} from "./gpuProviderAttestation";

test("promotion binds BS-RoFormer to the exact image and checkpoint pair", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const record: GpuPromotionRecord = {
    schemaVersion: 1,
    provider: "BS_ROFORMER",
    modalAppId: "ap-Test",
    modalDeploymentId: "v20",
    modalFunctionId: "fu-Test",
    modalImageId: "im-Test",
    endpointOrigin: "https://bs-roformer.example.test",
    modelVersion: "bs-roformer-viperx-v1",
    checkpointSha256: "5b84f37e8d444c8cb30c79d77f613a41c05868ff9c9ac6c7049c00aefae115aa",
    checkpointRevision: "puar-playground/bs-roformer@b1361b816daca507f079d85e935c291bcb0a5351",
    sourceRevision: "4fb6a9ce92fe5689154c1a1af244a099f3d7af93",
    sourceImageDigest: `sha256:${"5".repeat(64)}`,
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
  const signature = sign(
    null,
    Buffer.from(canonicalGpuPromotionJson(record)),
    privateKey,
  ).toString("base64");
  const previousBundle = process.env.MUSIC_PROVIDER_BS_ROFORMER_PROMOTION_BUNDLE;
  const previousPublicKey = process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY;
  process.env.MUSIC_PROVIDER_BS_ROFORMER_PROMOTION_BUNDLE = JSON.stringify({
    record,
    signature,
  });
  process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY = publicKey.export({
    type: "spki",
    format: "pem",
  }).toString();
  const health = {
    provider: record.provider,
    modalAppId: record.modalAppId,
    modalDeploymentId: record.modalDeploymentId,
    modalFunctionId: record.modalFunctionId,
    modalImageId: record.modalImageId,
    modelVersion: record.modelVersion,
    checkpointSha256: record.checkpointSha256,
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
  };
  try {
    assert.equal(
      gpuPromotionAttestationFailure(
        "BS_ROFORMER",
        `${record.endpointOrigin}/health`,
        health,
      ),
      null,
    );
    assert.match(
      gpuPromotionAttestationFailure(
        "BS_ROFORMER",
        `${record.endpointOrigin}/health`,
        { ...health, modalImageId: "im-Other" },
      ) ?? "",
      /runtime identity/,
    );
    const startup = {
      ...health,
      status: "starting",
      ready: false,
      healthy: false,
      retryable: true,
      retryAfterSeconds: 5,
    };
    assert.equal(
      isAttestedGpuProviderStartup(
        "BS_ROFORMER",
        `${record.endpointOrigin}/health`,
        startup,
      ),
      true,
    );
    assert.equal(
      isAttestedGpuProviderStartup(
        "BS_ROFORMER",
        `${record.endpointOrigin}/health`,
        { ...startup, modalImageId: "im-Other" },
      ),
      false,
    );
    assert.equal(
      isAttestedGpuProviderStartup(
        "BS_ROFORMER",
        `${record.endpointOrigin}/health`,
        { ...startup, retryAfterSeconds: 10 },
      ),
      false,
    );
    assert.match(
      gpuPromotionAttestationFailure(
        "BS_ROFORMER",
        `${record.endpointOrigin}/health`,
        { ...health, checkpointSha256: "0".repeat(64) },
      ) ?? "",
      /runtime identity/,
    );
  } finally {
    if (previousBundle === undefined) {
      delete process.env.MUSIC_PROVIDER_BS_ROFORMER_PROMOTION_BUNDLE;
    } else {
      process.env.MUSIC_PROVIDER_BS_ROFORMER_PROMOTION_BUNDLE = previousBundle;
    }
    if (previousPublicKey === undefined) {
      delete process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY;
    } else {
      process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY = previousPublicKey;
    }
  }
});

test("Beat This startup requires the exact promoted health schema", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const record: GpuPromotionRecord = {
    schemaVersion: 1,
    provider: "BEAT_THIS",
    modalAppId: "ap-BeatThis",
    modalDeploymentId: "v21",
    modalFunctionId: "fu-BeatThis",
    modalImageId: "im-BeatThis",
    endpointOrigin: "http://127.0.0.1",
    modelVersion: "1.1.0",
    checkpointSha256: "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331",
    checkpointRevision: "b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c",
    sourceRevision: "4fb6a9ce92fe5689154c1a1af244a099f3d7af93",
    sourceImageDigest: `sha256:${"5".repeat(64)}`,
    runtime: {
      python: "3.11.11",
      cudaImage: "nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04",
      cuda: "12.4.1",
      pytorch: "2.5.1+cu124",
      torchvision: "0.20.1+cu124",
      torchaudio: "2.5.1+cu124",
      torchIndexUrl: "https://download.pytorch.org/whl/cu124",
      transformers: "4.47.1",
      accelerate: "1.2.1",
    },
  };
  const signature = sign(
    null,
    Buffer.from(canonicalGpuPromotionJson(record)),
    privateKey,
  ).toString("base64");
  const bundleKey = "MUSIC_PROVIDER_BEAT_THIS_PROMOTION_BUNDLE";
  const publicKeyKey = "MUSIC_PROVIDER_BEAT_THIS_PROMOTION_PUBLIC_KEY";
  const previousBundle = process.env[bundleKey];
  const previousPublicKey = process.env[publicKeyKey];
  process.env[bundleKey] = JSON.stringify({ record, signature });
  process.env[publicKeyKey] = publicKey.export({
    type: "spki",
    format: "pem",
  }).toString();
  const startup = {
    provider: record.provider,
    status: "starting",
    ready: false,
    healthy: false,
    retryable: true,
    retryAfterSeconds: 5,
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
    packageReady: false,
    assetReady: false,
    featureExecutionReady: false,
    runtimeReady: false,
    checkpointReady: false,
    smokeTested: false,
    gpuReady: false,
    identityReady: true,
    reason: "runtime initialization is still in progress",
  };
  try {
    assert.equal(
      isAttestedGpuProviderStartup(
        "BEAT_THIS",
        `${record.endpointOrigin}/health`,
        startup,
      ),
      true,
    );
    for (const altered of [
      { ...startup, modalImageId: "im-Other" },
      { ...startup, exception: "private CUDA detail" },
      { ...startup, reason: "private CUDA detail" },
    ]) {
      assert.equal(
        isAttestedGpuProviderStartup(
          "BEAT_THIS",
          `${record.endpointOrigin}/health`,
          altered,
        ),
        false,
      );
    }
    const missingReason = { ...startup };
    delete (missingReason as Partial<typeof startup>).reason;
    assert.equal(
      isAttestedGpuProviderStartup(
        "BEAT_THIS",
        `${record.endpointOrigin}/health`,
        missingReason,
      ),
      false,
    );
  } finally {
    if (previousBundle === undefined) delete process.env[bundleKey];
    else process.env[bundleKey] = previousBundle;
    if (previousPublicKey === undefined) delete process.env[publicKeyKey];
    else process.env[publicKeyKey] = previousPublicKey;
  }
});