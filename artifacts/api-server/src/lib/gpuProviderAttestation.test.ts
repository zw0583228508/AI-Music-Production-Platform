import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  anyAccompCommercialUseAuthorized,
  canonicalGpuPromotionJson,
  expectedGpuPromotionRecord,
  gpuPromotionAttestationFailure,
  isAttestedGpuProviderStartup,
  type GpuPromotionRecord,
} from "./gpuProviderAttestation";
import { committedBeatThisPromotionBundle } from "./beatThisPromotion.generated";

test("generic promotion environment compatibility remains fail closed for uncommitted providers", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const record: GpuPromotionRecord = {
    schemaVersion: 1,
    provider: "TEST_GPU",
    modalAppId: "ap-Test",
    modalDeploymentId: "v20",
    modalFunctionId: "fu-Test",
    modalImageId: "im-Test",
    endpointOrigin: "https://test-gpu.example.test",
    modelVersion: "test-gpu",
    checkpointSha256: "5b84f37e8d444c8cb30c79d77f613a41c05868ff9c9ac6c7049c00aefae115aa",
    checkpointRevision: "your-mt3/checkpoint@immutable",
    sourceRevision: "4fb6a9ce92fe5689154c1a1af244a099f3d7af93",
    sourceImageDigest: `sha256:${"5".repeat(64)}`,
    releaseEvidenceSha256: "6".repeat(64),
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
  const previousBundle = process.env.MUSIC_PROVIDER_TEST_GPU_PROMOTION_BUNDLE;
  const previousPublicKey = process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY;
  const previousProviderPublicKey =
    process.env.MUSIC_PROVIDER_TEST_GPU_PROMOTION_PUBLIC_KEY;
  process.env.MUSIC_PROVIDER_TEST_GPU_PROMOTION_BUNDLE = JSON.stringify({
    record,
    signature,
  });
  const testPublicKey = publicKey.export({
    type: "spki",
    format: "pem",
  }).toString();
  process.env.MUSIC_PROVIDER_TEST_GPU_PROMOTION_PUBLIC_KEY = testPublicKey;
  process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY = testPublicKey;
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
        "TEST_GPU",
        `${record.endpointOrigin}/health`,
        health,
      ),
      null,
    );
    assert.match(
      gpuPromotionAttestationFailure(
        "TEST_GPU",
        `${record.endpointOrigin}/health`,
        { ...health, modalImageId: "im-Other" },
      ) ?? "",
      /runtime identity/,
    );
    assert.match(
      gpuPromotionAttestationFailure(
        "TEST_GPU",
        `${record.endpointOrigin}/health`,
        { ...health, checkpointSha256: "0".repeat(64) },
      ) ?? "",
      /runtime identity/,
    );
  } finally {
    if (previousBundle === undefined) {
      delete process.env.MUSIC_PROVIDER_TEST_GPU_PROMOTION_BUNDLE;
    } else {
      process.env.MUSIC_PROVIDER_TEST_GPU_PROMOTION_BUNDLE = previousBundle;
    }
    if (previousPublicKey === undefined) {
      delete process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY;
    } else {
      process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY = previousPublicKey;
    }
    if (previousProviderPublicKey === undefined) {
      delete process.env.MUSIC_PROVIDER_TEST_GPU_PROMOTION_PUBLIC_KEY;
    } else {
      process.env.MUSIC_PROVIDER_TEST_GPU_PROMOTION_PUBLIC_KEY =
        previousProviderPublicKey;
    }
  }
});

test("the committed MT3 promotion attests its exact captured runtime identity", () => {
  const record = expectedGpuPromotionRecord("MT3");
  assert.ok(record);
  assert.equal(record.modelVersion, "mt3-pytorch-multitrack");
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
  assert.equal(
    gpuPromotionAttestationFailure(
      "MT3",
      `${record.endpointOrigin}/health`,
      health,
    ),
    null,
  );
});

test("the committed YOUR_MT3 promotion attests its exact captured runtime identity", () => {
  const record = expectedGpuPromotionRecord("YOUR_MT3");
  assert.ok(record);
  assert.equal(record.modelVersion, "your-mt3");
  assert.equal(record.runtime.transformers, "4.45.1");
  assert.equal(
    record.checkpointSha256,
    "ae38e415c79efd5592dcb9b658cdb99ddb11d4c4e1eaa364cab04a052473fc25",
  );
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
  assert.equal(
    gpuPromotionAttestationFailure(
      "YOUR_MT3",
      `${record.endpointOrigin}/health`,
      health,
    ),
    null,
  );
  for (const drift of [
    { modalImageId: "im-Other" },
    { checkpointSha256: "0".repeat(64) },
    { sourceImageDigest: `sha256:${"0".repeat(64)}` },
  ]) {
    assert.match(
      gpuPromotionAttestationFailure(
        "YOUR_MT3",
        `${record.endpointOrigin}/health`,
        { ...health, ...drift },
      ) ?? "",
      /runtime identity/,
    );
  }
});

test("the committed AnyAccomp promotion is signed, exact, and cannot be replaced by env", () => {
  const record = expectedGpuPromotionRecord("ANYACCOMP");
  assert.ok(record);
  const previousBundle = process.env.MUSIC_PROVIDER_ANYACCOMP_PROMOTION_BUNDLE;
  const previousPublicKey =
    process.env.MUSIC_PROVIDER_ANYACCOMP_PROMOTION_PUBLIC_KEY;
  const previousCommercial =
    process.env.MUSIC_PROVIDER_ANYACCOMP_COMMERCIAL_USE_AUTHORIZED;
  process.env.MUSIC_PROVIDER_ANYACCOMP_PROMOTION_BUNDLE = JSON.stringify({
    record: { ...record, modalImageId: "im-EnvironmentOverride" },
    signature: "A".repeat(88),
  });
  process.env.MUSIC_PROVIDER_ANYACCOMP_PROMOTION_PUBLIC_KEY =
    "not-a-public-key";
  process.env.MUSIC_PROVIDER_ANYACCOMP_COMMERCIAL_USE_AUTHORIZED = "false";
  try {
    assert.equal(anyAccompCommercialUseAuthorized(), true);
    assert.deepEqual(expectedGpuPromotionRecord("ANYACCOMP"), record);
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
      publicArtifactOrigin: record.endpointOrigin,
      artifactOriginReady: true,
    };
    assert.equal(
      gpuPromotionAttestationFailure(
        "ANYACCOMP",
        `${record.endpointOrigin}/health`,
        health,
      ),
      null,
    );
    for (const [endpoint, drift] of [
      ["https://other.example.test/health", {}],
      [`${record.endpointOrigin}/health`, { modalAppId: "ap-Other" }],
      [`${record.endpointOrigin}/health`, { modalDeploymentId: "v999" }],
      [`${record.endpointOrigin}/health`, { modalFunctionId: "fu-Other" }],
      [`${record.endpointOrigin}/health`, { modalImageId: "im-Other" }],
      [`${record.endpointOrigin}/health`, { modelVersion: "other-model" }],
      [`${record.endpointOrigin}/health`, { checkpointSha256: "0".repeat(64) }],
      [`${record.endpointOrigin}/health`, { revision: "other-revision" }],
      [`${record.endpointOrigin}/health`, { sourceRevision: "0".repeat(40) }],
      [`${record.endpointOrigin}/health`, {
        sourceImageDigest: `sha256:${"0".repeat(64)}`,
      }],
      [`${record.endpointOrigin}/health`, {
        runtime: { pythonVersion: "3.11.0" },
      }],
      [`${record.endpointOrigin}/health`, {
        publicArtifactOrigin: "https://stale.example.test",
      }],
      [`${record.endpointOrigin}/health`, { artifactOriginReady: false }],
    ] as const) {
      assert.ok(
        gpuPromotionAttestationFailure(
          "ANYACCOMP",
          endpoint,
          { ...health, ...drift },
        ),
      );
    }
  } finally {
    if (previousBundle === undefined) {
      delete process.env.MUSIC_PROVIDER_ANYACCOMP_PROMOTION_BUNDLE;
    } else {
      process.env.MUSIC_PROVIDER_ANYACCOMP_PROMOTION_BUNDLE = previousBundle;
    }
    if (previousPublicKey === undefined) {
      delete process.env.MUSIC_PROVIDER_ANYACCOMP_PROMOTION_PUBLIC_KEY;
    } else {
      process.env.MUSIC_PROVIDER_ANYACCOMP_PROMOTION_PUBLIC_KEY =
        previousPublicKey;
    }
    if (previousCommercial === undefined) {
      delete process.env.MUSIC_PROVIDER_ANYACCOMP_COMMERCIAL_USE_AUTHORIZED;
    } else {
      process.env.MUSIC_PROVIDER_ANYACCOMP_COMMERCIAL_USE_AUTHORIZED =
        previousCommercial;
    }
  }
});

test("production AnyAccomp configuration, retained health, and rename download proof agree", () => {
  const workspace = resolve(process.cwd(), "../..");
  const record = expectedGpuPromotionRecord("ANYACCOMP");
  assert.ok(record);
  const replit = readFileSync(resolve(workspace, ".replit"), "utf8");
  const configured = replit.match(
    /^\s*ANYACCOMP_API_URL\s*=\s*"([^"]+)"\s*$/m,
  )?.[1];
  assert.equal(configured, record.endpointOrigin);

  const evidenceRoot = resolve(
    workspace,
    "services/anyaccomp-worker/release-evidence",
  );
  const release = JSON.parse(
    readFileSync(resolve(evidenceRoot, "release-evidence.json"), "utf8"),
  );
  const drill = JSON.parse(
    readFileSync(resolve(evidenceRoot, "endpoint-rename-drill.json"), "utf8"),
  );
  assert.equal(
    gpuPromotionAttestationFailure(
      "ANYACCOMP",
      `${configured}/health`,
      release.liveHealth,
    ),
    null,
  );
  assert.deepEqual(drill.observedDeployment, {
    provider: "ANYACCOMP",
    modalAppId: record.modalAppId,
    modalDeploymentId: record.modalDeploymentId,
    modalFunctionId: record.modalFunctionId,
    endpointOrigin: record.endpointOrigin,
  });
  assert.equal(drill.generation.artifactOrigin, configured);
  assert.equal(drill.generation.capabilityRetrieved, true);
  assert.equal(drill.generation.artifactHashVerified, true);
});

test("Beat This startup requires the exact promoted health schema", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const fallbackRecord: GpuPromotionRecord = {
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
    releaseEvidenceSha256: "6".repeat(64),
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
  const record = committedBeatThisPromotionBundle.trim()
    ? (JSON.parse(committedBeatThisPromotionBundle) as {
        record: GpuPromotionRecord;
      }).record
    : fallbackRecord;
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