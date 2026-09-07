import { strict as assert } from "node:assert";
import {
  generateKeyPairSync,
  sign as signBytes,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const apiDirectory = new URL("..", import.meta.url).pathname;
const harnessPath = `/tmp/gpu-provider-attestation-${process.pid}.mjs`;
const generatedPromotionsSource = await readFile(
  new URL("../src/lib/gpuPromotions.generated.ts", import.meta.url),
  "utf8",
);
const generatedPromotionsLiteral = generatedPromotionsSource.match(
  /= (".*");\s*$/s,
)?.[1];
assert.ok(generatedPromotionsLiteral);
const generatedPromotions = JSON.parse(JSON.parse(generatedPromotionsLiteral));
const anyAccompCommittedPromotions = JSON.stringify({
  bundles: { ANYACCOMP: generatedPromotions.bundles.ANYACCOMP },
  publicKey: generatedPromotions.publicKey,
  schemaVersion: 1,
});
await build({
  stdin: {
    contents: `
      export {
         MUSIC_PROVIDERS,
         HttpMusicGenerationProvider,
        createProviderRegistry,
        cancelRemoteProviderJob,
        canonicalGpuPromotionJson,
        expectedGpuModalImageId,
        expectedGpuPromotionRecord,
        gpuPromotionAttestationFailure,
        providerCatalog,
        runArrangementProvider,
        selectMusicProvider,
        verifyProviderRegistry,
      } from "./src/lib/musicProviders";
       export { runAnalysisProviders } from "./src/lib/analysisProviders";
    `,
    resolveDir: apiDirectory,
    sourcefile: "gpu-provider-attestation-harness.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: harnessPath,
  external: ["pg-native", "@google-cloud/*", "@google/*"],
  banner: {
    js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);`,
  },
  plugins: [{
    name: "anyaccomp-only-committed-gpu-promotions",
    setup(build) {
      build.onResolve(
        { filter: /gpuPromotions\.generated$/ },
        () => ({ path: "gpuPromotions.generated", namespace: "test" }),
      );
      build.onLoad(
        { filter: /.*/, namespace: "test" },
        () => ({
          contents: `export const committedGpuPromotionsJson =
             ${JSON.stringify(anyAccompCommittedPromotions)};`,
          loader: "js",
        }),
      );
    },
  }],
});

const {
  MUSIC_PROVIDERS,
  HttpMusicGenerationProvider,
  cancelRemoteProviderJob,
  canonicalGpuPromotionJson,
  createProviderRegistry,
  expectedGpuModalImageId,
  expectedGpuPromotionRecord,
  gpuPromotionAttestationFailure,
  providerCatalog,
  runAnalysisProviders,
  runArrangementProvider,
  selectMusicProvider,
  verifyProviderRegistry,
} = await import(pathToFileURL(harnessPath).href);

const promotionKeys = generateKeyPairSync("ed25519");
const promotionPublicKey = promotionKeys.publicKey.export({
  type: "spki",
  format: "pem",
});
delete process.env.MUSIC_PROVIDER_ACE_STEP_PROMOTION_BUNDLE;
delete process.env.MUSIC_PROVIDER_ACE_STEP_PROMOTION_PUBLIC_KEY;

after(async () => {
  delete process.env.ACE_STEP_API_URL;
  delete process.env.MUSIC_PROVIDER_ACE_STEP_URL;
  delete process.env.MUSIC_PROVIDER_ACE_STEP_CHECKPOINT_SHA256;
  delete process.env.MUSIC_PROVIDER_ACE_STEP_CONTAINER_DIGEST;
  delete process.env.MUSIC_PROVIDER_ACE_STEP_SOURCE_IMAGE_DIGEST;
  delete process.env.MUSIC_PROVIDER_ACE_STEP_MODAL_IMAGE_ID;
  delete process.env.MUSIC_PROVIDER_ACE_STEP_PROMOTION_BUNDLE;
  delete process.env.MUSIC_PROVIDER_ACE_STEP_PROMOTION_PUBLIC_KEY;
  delete process.env.MUSIC_PROVIDER_MT3_PROMOTION_BUNDLE;
  delete process.env.MUSIC_PROVIDER_MT3_PROMOTION_PUBLIC_KEY;
  delete process.env.MT3_API_URL;
  delete process.env.MUSIC_PROVIDER_MT3_URL;
  delete process.env.MUSIC_PROVIDER_BS_ROFORMER_ENDPOINT;
  delete process.env.MUSIC_PROVIDER_BS_ROFORMER_PROMOTION_BUNDLE;
  delete process.env.MUSIC_PROVIDER_BS_ROFORMER_PROMOTION_PUBLIC_KEY;
  delete process.env.BS_ROFORMER_API_URL;
  delete process.env.MUSIC_PROVIDER_BS_ROFORMER_URL;
  delete process.env.MUSIC_PROVIDER_BS_ROFORMER_TOKEN;
  delete process.env.MUSIC_PROVIDER_BS_ROFORMER_HEALTH_URL;
  delete process.env.MUSIC_PROVIDER_GATEWAY_URL;
  delete process.env.MUSIC_PROVIDER_GATEWAY_TOKEN;
  delete process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY;
  delete process.env.MUSIC_PROVIDER_ACE_STEP_TOKEN;
  delete process.env.MUSIC_AI_WORKER_TOKEN;
  delete process.env.LADA_BAND_API_URL;
  delete process.env.LADA_BAND_ACCEPT_NONCOMMERCIAL_RESEARCH;
  delete process.env.DIFFRHYTHM2_API_URL;
  delete process.env.DIFFRHYTHM2_API_TOKEN;
  delete process.env.MUSIC_PROVIDER_DIFFRHYTHM_2_PROMOTION_BUNDLE;
  delete process.env.MUSIC_PROVIDER_DIFFRHYTHM_2_PROMOTION_PUBLIC_KEY;
  await unlink(harnessPath).catch(() => undefined);
});

test("LaDA remains license blocked despite endpoint and env configuration", async () => {
  process.env.LADA_BAND_API_URL = "https://lada.invalid";
  process.env.LADA_BAND_ACCEPT_NONCOMMERCIAL_RESEARCH = "accepted";
  try {
    const descriptor = MUSIC_PROVIDERS.find(
      (provider) => provider.id === "LADA_BAND",
    );
    assert.ok(descriptor);
    assert.equal(descriptor.status, "unavailable");
    assert.equal(
      descriptor.license,
      "UNVERIFIED first-party source/model rights",
    );
    assert.match(descriptor.notes, /BLOCKED_LICENSE/);

    const provider = createProviderRegistry().find(
      (candidate) => candidate.definition.id === "LADA_BAND",
    );
    assert.ok(provider);
    assert.equal(provider.available, false);
    assert.match(provider.readiness.message, /research-only|LADA_BAND/);
    assert.throws(() => selectMusicProvider([provider], {
      task: "ACCOMPANIMENT",
      requestedProvider: "LADA_BAND",
      hardware: "GPU",
      speed: "QUALITY",
    }), /research-only|LADA_BAND/);
    await assert.rejects(
      () => provider.generate({}),
      /research-only|LADA_BAND/,
    );
    await assert.rejects(
      () => runArrangementProvider(descriptor, {}),
      /research-only|LADA_BAND/,
    );
  } finally {
    delete process.env.LADA_BAND_API_URL;
    delete process.env.LADA_BAND_ACCEPT_NONCOMMERCIAL_RESEARCH;
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function withWorker(health, run, options = {}) {
  let servedHealth = health;
  let generationPosts = 0;
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    if (request.url === "/health?provider=ACE_STEP") {
      response.end(JSON.stringify(servedHealth));
      return;
    }
    if (request.method === "POST") generationPosts += 1;
    response.end(JSON.stringify({
      provider: "WRONG_PROVIDER",
      modelVersion: "ace-step-1.5-base",
      checkpointSha256: "a".repeat(64),
      smokeTested: true,
      candidates: [{}],
    }));
  });
  await listen(server);
  const address = server.address();
  process.env.MUSIC_PROVIDER_ACE_STEP_URL =
    `http://127.0.0.1:${address.port}/generate`;
  process.env.MUSIC_PROVIDER_ACE_STEP_CHECKPOINT_SHA256 = "a".repeat(64);
  process.env.MUSIC_PROVIDER_ACE_STEP_CONTAINER_DIGEST = `sha256:${"c".repeat(64)}`;
  process.env.MUSIC_PROVIDER_ACE_STEP_SOURCE_IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
  process.env.MUSIC_PROVIDER_ACE_STEP_MODAL_IMAGE_ID = "im-AceStepPromoted42";
  const origin = `http://127.0.0.1:${address.port}`;
  const promotion = configureAcePromotion(origin);
  servedHealth = withAcePromotion(health, promotion);
  if (options.mutateHealth) servedHealth = options.mutateHealth(servedHealth);
  if (options.mutateBundle) {
    const bundle = JSON.parse(
      process.env.MUSIC_PROVIDER_ACE_STEP_PROMOTION_BUNDLE,
    );
    process.env.MUSIC_PROVIDER_ACE_STEP_PROMOTION_BUNDLE =
      JSON.stringify(options.mutateBundle(bundle));
  }
  try {
    await run({ generationPosts: () => generationPosts });
  } finally {
    delete process.env.MUSIC_PROVIDER_ACE_STEP_URL;
    delete process.env.MUSIC_PROVIDER_ACE_STEP_CHECKPOINT_SHA256;
    delete process.env.MUSIC_PROVIDER_ACE_STEP_CONTAINER_DIGEST;
    delete process.env.MUSIC_PROVIDER_ACE_STEP_SOURCE_IMAGE_DIGEST;
    delete process.env.MUSIC_PROVIDER_ACE_STEP_MODAL_IMAGE_ID;
    delete process.env.MUSIC_PROVIDER_ACE_STEP_PROMOTION_BUNDLE;
    delete process.env.MUSIC_PROVIDER_ACE_STEP_PROMOTION_PUBLIC_KEY;
    delete process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY;
    await new Promise((resolve) => server.close(resolve));
  }
}

function aceStepProvider() {
  const provider = createProviderRegistry().find(
    (candidate) => candidate.definition.id === "ACE_STEP",
  );
  assert.ok(provider);
  return provider;
}

const attestedHealth = {
  status: "ready",
  healthy: true,
  provider: "ACE_STEP",
  runtimeReady: true,
  gpuReady: true,
  checkpointReady: true,
  modelVersion: "ace-step-1.5-base",
  checkpointSha256: "a".repeat(64),
  smokeTested: true,
  revision: "ace-step-1.5-base-r42",
  modalImageId: "im-AceStepPromoted42",
  containerDigest: `sha256:${"c".repeat(64)}`,
  cudaVersion: "12.8.1",
  pytorchVersion: "2.10.0+cu128",
  gpu: "NVIDIA A100",
};

const aceRuntimePins = {
  python: "3.11.11",
  cudaImage: "nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04",
  cuda: "12.8.1",
  pytorch: "2.10.0+cu128",
  torchvision: "0.25.0+cu128",
  torchaudio: "2.10.0+cu128",
  torchIndexUrl: "https://download.pytorch.org/whl/cu128",
  transformers: "4.57.6",
  accelerate: "1.12.0",
};

function configureAcePromotion(endpointOrigin) {
  const record = {
    schemaVersion: 1,
    provider: "ACE_STEP",
    modalAppId: "ap-AceStep42",
    modalDeploymentId: "dp-AceStep42",
    modalFunctionId: "fu-AceStep42",
    modalImageId: "im-AceStepPromoted42",
    endpointOrigin,
    modelVersion: "ace-step-1.5-base",
    checkpointSha256: "a".repeat(64),
    checkpointRevision: "ace-step-1.5-base-r42",
    sourceRevision: "git-test-revision-42",
    sourceImageDigest: `sha256:${"c".repeat(64)}`,
    releaseEvidenceSha256: "e".repeat(64),
    runtime: aceRuntimePins,
  };
  process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY = promotionPublicKey;
  const signature = signBytes(
    null,
    Buffer.from(canonicalGpuPromotionJson(record)),
    promotionKeys.privateKey,
  ).toString("base64");
  process.env.MUSIC_PROVIDER_ACE_STEP_PROMOTION_BUNDLE =
    JSON.stringify({ record, signature });
  return { record, signature };
}

function withAcePromotion(health, promotion) {
  return {
    ...health,
    framework: {
      python: aceRuntimePins.python,
      cuda_image: aceRuntimePins.cudaImage,
      cuda: aceRuntimePins.cuda,
      pytorch: aceRuntimePins.pytorch,
      torchvision: aceRuntimePins.torchvision,
      torchaudio: aceRuntimePins.torchaudio,
      torch_index_url: aceRuntimePins.torchIndexUrl,
      transformers: aceRuntimePins.transformers,
      accelerate: aceRuntimePins.accelerate,
    },
    runtime: {
      ...(health.runtime ?? {}),
      pythonVersion: aceRuntimePins.python,
    },
    modalAppId: promotion.record.modalAppId,
    modalDeploymentId: promotion.record.modalDeploymentId,
    modalFunctionId: promotion.record.modalFunctionId,
    sourceRevision: promotion.record.sourceRevision,
  };
}

const diffRhythmRuntimePins = {
  python: "3.11",
  cudaImage: "nvidia/cuda@sha256:" + "1".repeat(64),
  cuda: "12.6",
  pytorch: "2.7.0+cu126",
  torchvision: "0.22.0",
  torchaudio: "2.7.0",
  torchIndexUrl: "https://pypi.org/simple",
  transformers: "4.47.1",
  accelerate: "not-installed",
};

function configureDiffRhythmPromotion(endpointOrigin) {
  const record = {
    schemaVersion: 1,
    provider: "DIFFRHYTHM_2",
    modalAppId: "ap-DiffRhythm42",
    modalDeploymentId: "v42",
    modalFunctionId: "fu-DiffRhythm42",
    modalImageId: "im-DiffRhythm42",
    endpointOrigin,
    modelVersion: "13a7b091f45124f611e36ee674973234f38d55b6",
    checkpointSha256: "2".repeat(64),
    checkpointRevision: "3".repeat(40),
    sourceRevision: "13a7b091f45124f611e36ee674973234f38d55b6",
    sourceImageDigest: `sha256:${"4".repeat(64)}`,
    releaseEvidenceSha256: "5".repeat(64),
    runtime: diffRhythmRuntimePins,
  };
  const signature = signBytes(
    null,
    Buffer.from(canonicalGpuPromotionJson(record)),
    promotionKeys.privateKey,
  ).toString("base64");
  process.env.MUSIC_PROVIDER_DIFFRHYTHM_2_PROMOTION_PUBLIC_KEY =
    promotionPublicKey;
  process.env.MUSIC_PROVIDER_DIFFRHYTHM_2_PROMOTION_BUNDLE =
    JSON.stringify({ record, signature });
  return { record, signature };
}

function diffRhythmHealth(promotion) {
  const { record } = promotion;
  return {
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
    runtime: { pythonVersion: diffRhythmRuntimePins.python },
    framework: {
      python: diffRhythmRuntimePins.python,
      cuda_image: diffRhythmRuntimePins.cudaImage,
      cuda: diffRhythmRuntimePins.cuda,
      pytorch: diffRhythmRuntimePins.pytorch,
      torchvision: diffRhythmRuntimePins.torchvision,
      torchaudio: diffRhythmRuntimePins.torchaudio,
      torch_index_url: diffRhythmRuntimePins.torchIndexUrl,
      transformers: diffRhythmRuntimePins.transformers,
      accelerate: diffRhythmRuntimePins.accelerate,
    },
  };
}

test("Modal providers ignore legacy image pins outside the signed bundle", () => {
  process.env.MUSIC_PROVIDER_ACE_STEP_MODAL_IMAGE_ID = "sha256:not-a-modal-id";
  assert.equal(expectedGpuModalImageId("ACE_STEP"), null);
  process.env.MUSIC_PROVIDER_ACE_STEP_MODAL_IMAGE_ID = " im-Promoted123 ";
  assert.equal(expectedGpuModalImageId("ACE_STEP"), null);
  delete process.env.MUSIC_PROVIDER_ACE_STEP_MODAL_IMAGE_ID;
});

test("GPU promotion records require a valid signature and rotate as one identity", async () => {
  await withWorker(attestedHealth, async () => {
    assert.equal(
      expectedGpuPromotionRecord("ACE_STEP")?.modalDeploymentId,
      "dp-AceStep42",
    );
    const bundle = JSON.parse(process.env.MUSIC_PROVIDER_ACE_STEP_PROMOTION_BUNDLE);
    bundle.signature = `${"A".repeat(86)}==`;
    process.env.MUSIC_PROVIDER_ACE_STEP_PROMOTION_BUNDLE = JSON.stringify(bundle);
    const [provider] = await verifyProviderRegistry([aceStepProvider()], true);
    assert.equal(providerCatalog([provider])[0].status, "configured");
    assert.match(provider.readiness.message, /promotion signature/i);
  });

  await withWorker(attestedHealth, async () => {
    const bundle = JSON.parse(process.env.MUSIC_PROVIDER_ACE_STEP_PROMOTION_BUNDLE);
    bundle.record.checkpointSha256 = "b".repeat(64);
    process.env.MUSIC_PROVIDER_ACE_STEP_PROMOTION_BUNDLE = JSON.stringify(bundle);
    const [provider] = await verifyProviderRegistry([aceStepProvider()], true);
    assert.equal(providerCatalog([provider])[0].status, "configured");
    assert.match(provider.readiness.message, /promotion signature/i);
  });
});

test("provider-specific promotion keys override the legacy global trust root", async () => {
  const wrongKeys = generateKeyPairSync("ed25519");
  const wrongPublicKey = wrongKeys.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const promotion = configureAcePromotion("https://ace.example.test");
  process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY = wrongPublicKey;
  process.env.MUSIC_PROVIDER_ACE_STEP_PROMOTION_PUBLIC_KEY = promotionPublicKey;

  assert.equal(
    gpuPromotionAttestationFailure(
      "ACE_STEP",
      "https://ace.example.test/generate",
      withAcePromotion(attestedHealth, promotion),
    ),
    null,
  );
});

test("Python promotion output verifies in Node and rejects live identity drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gpu-promotion-interoperability-"));
  const privateKeyPath = join(directory, "private.pem");
  const recordPath = join(directory, "record.json");
  const bundlePath = join(directory, "bundle.json");
  const endpointOrigin = "https://workspace--music-ai-gpu-worker-ace-step.modal.run";
  const base = configureAcePromotion(endpointOrigin).record;
  const record = Object.fromEntries(Object.entries({
    ...base,
    sourceRevision: "git-revision-ß-\"42\"",
    runtime: Object.fromEntries(Object.entries(base.runtime).reverse()),
  }).reverse());
  await writeFile(
    privateKeyPath,
    promotionKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  await writeFile(recordPath, JSON.stringify(record));
  const script = `
import importlib.util, json, pathlib, sys
root = pathlib.Path("services/music-ai-gpu-worker")
spec = importlib.util.spec_from_file_location("promotion_modal_config", root / "modal_config.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
record = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
module.write_promotion_bundle(pathlib.Path(sys.argv[2]), record, pathlib.Path(sys.argv[3]))
`;
  try {
    const signed = spawnSync(
      "python",
      ["-c", script, recordPath, bundlePath, privateKeyPath],
      { cwd: new URL("../../..", import.meta.url), encoding: "utf8" },
    );
    assert.equal(signed.status, 0, signed.stderr);
    process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY = promotionPublicKey;
    process.env.MUSIC_PROVIDER_ACE_STEP_PROMOTION_BUNDLE =
      await readFile(bundlePath, "utf8");
    const payload = withAcePromotion(attestedHealth, { record });
    assert.equal(
      gpuPromotionAttestationFailure(
        "ACE_STEP",
        `${endpointOrigin}/generate`,
        payload,
      ),
      null,
    );
    assert.match(
      gpuPromotionAttestationFailure(
        "ACE_STEP",
        `${endpointOrigin}/generate`,
        { ...payload, sourceRevision: "different-revision" },
      ),
      /runtime identity/i,
    );
    assert.match(
      gpuPromotionAttestationFailure(
        "ACE_STEP",
        `${endpointOrigin}/generate`,
        {
          ...payload,
          framework: { ...payload.framework, pytorch: "different-runtime" },
        },
      ),
      /runtime pins/i,
    );
    for (const key of ["modalAppId", "modalDeploymentId", "modalFunctionId"]) {
      assert.match(
        gpuPromotionAttestationFailure(
          "ACE_STEP",
          `${endpointOrigin}/generate`,
          { ...payload, [key]: `substituted-${key}` },
        ),
        /runtime identity/i,
      );
    }
  } finally {
    delete process.env.MUSIC_PROVIDER_ACE_STEP_PROMOTION_BUNDLE;
    delete process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY;
    await rm(directory, { recursive: true, force: true });
  }
});

test("GPU providers require exact checksum, model, GPU, and smoke attestation", async () => {
  await withWorker(attestedHealth, async () => {
    delete process.env.MUSIC_PROVIDER_ACE_STEP_PROMOTION_BUNDLE;
    const [provider] = await verifyProviderRegistry([aceStepProvider()], true);
    assert.equal(providerCatalog([provider])[0].status, "configured");
    assert.match(provider.readiness.message, /promoted deployment/i);
  });

  await withWorker({
    ...attestedHealth,
    modalImageId: "im-DifferentPromotedImage",
  }, async () => {
    const [provider] = await verifyProviderRegistry([aceStepProvider()], true);
    assert.equal(providerCatalog([provider])[0].status, "configured");
    assert.match(provider.readiness.message, /Modal image ID|promoted deployment/i);
  });

  await withWorker(attestedHealth, async () => {
    delete process.env.MUSIC_PROVIDER_ACE_STEP_CONTAINER_DIGEST;
    delete process.env.MUSIC_PROVIDER_ACE_STEP_SOURCE_IMAGE_DIGEST;
    const [provider] = await verifyProviderRegistry([aceStepProvider()], true);
    assert.equal(providerCatalog([provider])[0].status, "ready");
  });

  await withWorker({
    ...attestedHealth,
    containerDigest: `sha256:${"f".repeat(64)}`,
  }, async () => {
    const [provider] = await verifyProviderRegistry([aceStepProvider()], true);
    assert.equal(providerCatalog([provider])[0].status, "configured");
  });

  await withWorker({ ...attestedHealth, smokeTested: false }, async () => {
    const [provider] = await verifyProviderRegistry([aceStepProvider()], true);
    assert.equal(providerCatalog([provider])[0].status, "configured");
    assert.throws(() => selectMusicProvider([provider], {
      task: "ARRANGEMENT",
      requestedProvider: "ACE_STEP",
      hardware: "GPU",
      speed: "BALANCED",
    }), /unavailable/i);
  });

  await withWorker(attestedHealth, async () => {
    const [provider] = await verifyProviderRegistry([aceStepProvider()], true);
    assert.equal(providerCatalog([provider])[0].status, "ready");
    assert.equal(provider.readiness.runtimeProvenance?.modalImageId, "im-AceStepPromoted42");
    const selected = selectMusicProvider([provider], {
      task: "ARRANGEMENT",
      requestedProvider: "ACE_STEP",
      hardware: "GPU",
      speed: "BALANCED",
    });
    await assert.rejects(() => selected.generate({
      jobId: "job-1",
      projectId: "project-1",
      arrangementId: "arrangement-1",
      task: "ARRANGEMENT",
      style: "pop",
      mode: "FULL",
      hardware: "GPU",
      speed: "BALANCED",
      candidates: 1,
      seed: 7,
      parameters: {},
      parentArtifactIds: [],
      songModel: {},
      tracks: [],
      arrangement: {
        version: 1,
        harmonyComplexity: 5,
        energy: 0.5,
        density: 0.5,
        orchestraSize: 4,
        rhythmIntensity: 0.5,
      },
    }), /GPU provenance attestation/i);
  });
});

test("ACE-Step identity and signature drift block every generation POST", async () => {
  const wrongKeys = generateKeyPairSync("ed25519");
  const cases = [
    {
      name: "source revision",
      options: {
        mutateHealth: (health) => ({
          ...health,
          sourceRevision: "different-source-revision",
        }),
      },
    },
    {
      name: "checkpoint",
      options: {
        mutateHealth: (health) => ({
          ...health,
          checkpointSha256: "b".repeat(64),
        }),
      },
    },
    {
      name: "Modal image",
      options: {
        mutateHealth: (health) => ({
          ...health,
          modalImageId: "im-DifferentPromotedImage",
        }),
      },
    },
    {
      name: "source image digest",
      options: {
        mutateHealth: (health) => ({
          ...health,
          sourceImageDigest: `sha256:${"f".repeat(64)}`,
          containerDigest: `sha256:${"f".repeat(64)}`,
        }),
      },
    },
    {
      name: "signature",
      options: {
        mutateBundle: (bundle) => ({
          ...bundle,
          signature: signBytes(
            null,
            Buffer.from(canonicalGpuPromotionJson(bundle.record)),
            wrongKeys.privateKey,
          ).toString("base64"),
        }),
      },
    },
  ];
  for (const mismatch of cases) {
    await withWorker(
      attestedHealth,
      async ({ generationPosts }) => {
        const [provider] = await verifyProviderRegistry([aceStepProvider()], true);
        assert.notEqual(
          providerCatalog([provider])[0].status,
          "ready",
          mismatch.name,
        );
        assert.throws(() => selectMusicProvider([provider], {
          task: "ARRANGEMENT",
          requestedProvider: "ACE_STEP",
          hardware: "GPU",
          speed: "BALANCED",
        }), /unavailable/i, mismatch.name);
        assert.equal(generationPosts(), 0, mismatch.name);
      },
      mismatch.options,
    );
  }
});

test("MT3 requires exact signed deployment identity before every analysis POST", async () => {
  const mt3RuntimePins = {
    python: "3.11.11",
    cudaImage: "nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04",
    cuda: "12.1.1",
    pytorch: "2.5.1+cu121",
    torchvision: "0.20.1+cu121",
    torchaudio: "2.5.1+cu121",
    torchIndexUrl: "https://download.pytorch.org/whl/cu121",
    transformers: "4.41.2",
    accelerate: "0.31.0",
  };
  let health = {};
  let analysisPosts = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/health?provider=MT3") {
      response.end(JSON.stringify(health));
      return;
    }
    if (request.method === "POST" && request.url === "/analyze") {
      analysisPosts += 1;
      response.end(JSON.stringify({
        version: "mt3-pytorch-multitrack",
        confidence: 1,
        notes: [{
          start: 0,
          end: 0.5,
          pitch: 60,
          velocity: 100,
          confidence: 1,
        }],
      }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not found" }));
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpointOrigin = `http://127.0.0.1:${address.port}`;
  const record = {
    schemaVersion: 1,
    provider: "MT3",
    modalAppId: "ap-Mt3Promoted42",
    modalDeploymentId: "v42",
    modalFunctionId: "fu-Mt3Promoted42",
    modalImageId: "im-Mt3Promoted42",
    endpointOrigin,
    modelVersion: "mt3-pytorch-multitrack",
    checkpointSha256: "a".repeat(64),
    checkpointRevision: "mt3-official-multitrack-r42",
    sourceRevision: "git-mt3-test-revision-42",
    sourceImageDigest: `sha256:${"c".repeat(64)}`,
    releaseEvidenceSha256: "e".repeat(64),
    runtime: mt3RuntimePins,
  };
  const signedBundle = (candidate = record) => ({
    record: candidate,
    signature: signBytes(
      null,
      Buffer.from(canonicalGpuPromotionJson(candidate)),
      promotionKeys.privateKey,
    ).toString("base64"),
  });
  const exactHealth = () => ({
    provider: "MT3",
    status: "ready",
    ready: true,
    healthy: true,
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
  });
  const endpointKeys = [
    "MUSIC_PROVIDER_MT3_URL",
    "MT3_API_URL",
    "MUSIC_PROVIDER_MT3_PROMOTION_BUNDLE",
    "MUSIC_PROVIDER_MT3_PROMOTION_PUBLIC_KEY",
    "MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY",
    "MUSIC_GPU_PROMOTION_PUBLIC_KEY",
    "MUSIC_PROVIDER_BASIC_PITCH_URL",
    "BASIC_PITCH_API_URL",
    "MUSIC_PROVIDER_DEMUCS_URL",
    "ALL_IN_ONE_API_URL",
    "MUSIC_PROVIDER_ALL_IN_ONE_URL",
    "DEMUCS_API_URL",
    "MUSIC_PROVIDER_BS_ROFORMER_ENDPOINT",
    "MUSIC_PROVIDER_BS_ROFORMER_URL",
    "MUSIC_PROVIDER_BS_ROFORMER_TOKEN",
    "MUSIC_PROVIDER_BS_ROFORMER_HEALTH_URL",
    "BS_ROFORMER_API_URL",
    "BS_ROFORMER_SW_API_URL",
    "MUSIC_PROVIDER_GATEWAY_URL",
    "MUSIC_PROVIDER_GATEWAY_TOKEN",
    "MUSIC_PROVIDER_MR_MT3_URL",
    "MR_MT3_API_URL",
    "MUSIC_PROVIDER_YOUR_MT3_URL",
    "YOUR_MT3_API_URL",
    "SHEETSAGE_API_URL",
    "SHEET_SAGE_API_URL",
    "MUSIC_PROVIDER_CHROMA_URL",
    "CHROMA_API_URL",
    "BASS_API_URL",
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
  const run = () => runAnalysisProviders({
    sourceUrl: "https://storage.invalid/signed-source",
    sourceType: "FULL_SONG",
    durationSeconds: 2,
  });
  try {
    for (const key of endpointKeys) delete process.env[key];
    process.env.MT3_API_URL = endpointOrigin;
    process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY = promotionPublicKey;
    process.env.MUSIC_PROVIDER_MT3_PROMOTION_BUNDLE =
      JSON.stringify(signedBundle());
    health = exactHealth();
    const accepted = await run();
    assert.equal(accepted.transcriptions[0]?.providerId, "MT3");
    assert.equal(analysisPosts, 1);

    const wrongKeys = generateKeyPairSync("ed25519");
    const cases = [
      {
        name: "missing signature",
        bundle: { record },
      },
      {
        name: "bad signature",
        bundle: {
          record,
          signature: signBytes(
            null,
            Buffer.from(canonicalGpuPromotionJson(record)),
            wrongKeys.privateKey,
          ).toString("base64"),
        },
      },
      {
        name: "endpoint origin",
        bundle: signedBundle({ ...record, endpointOrigin: "https://drift.invalid" }),
      },
      {
        name: "checkpoint",
        mutateHealth: (value) => ({ ...value, checksum: "b".repeat(64), checkpointSha256: "b".repeat(64) }),
      },
      {
        name: "source revision",
        mutateHealth: (value) => ({ ...value, sourceRevision: "different-source-revision" }),
      },
      {
        name: "source image",
        mutateHealth: (value) => ({ ...value, sourceImageDigest: `sha256:${"f".repeat(64)}` }),
      },
      {
        name: "Modal app",
        mutateHealth: (value) => ({ ...value, modalAppId: "ap-Mt3Drift" }),
      },
      {
        name: "Modal deployment",
        mutateHealth: (value) => ({ ...value, modalDeploymentId: "v99" }),
      },
      {
        name: "Modal function",
        mutateHealth: (value) => ({ ...value, modalFunctionId: "fu-Mt3Drift" }),
      },
      {
        name: "Modal image",
        mutateHealth: (value) => ({ ...value, modalImageId: "im-Mt3Drift" }),
      },
      {
        name: "runtime pin",
        mutateHealth: (value) => ({
          ...value,
          framework: { ...value.framework, pytorch: "2.5.0+cu121" },
        }),
      },
    ];
    for (const mismatch of cases) {
      health = mismatch.mutateHealth
        ? mismatch.mutateHealth(exactHealth())
        : exactHealth();
      process.env.MUSIC_PROVIDER_MT3_PROMOTION_BUNDLE =
        JSON.stringify(mismatch.bundle ?? signedBundle());
      const rejected = await run();
      assert.equal(
        rejected.transcriptions.some((item) => item.providerId === "MT3"),
        false,
        mismatch.name,
      );
      assert.equal(analysisPosts, 1, mismatch.name);
      assert.equal(
        rejected.provenance.find((item) => item.provider === "MT3")?.errorCode,
        "health-attestation-failed",
        mismatch.name,
      );
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test("BS-RoFormer retains signed candidate validation but is unroutable while license-blocked", async () => {
  const runtimePins = {
    python: "3.11.11",
    cudaImage: "nvidia/cuda@sha256:test",
    cuda: "12.4.1",
    pytorch: "2.5.1+cu124",
    torchvision: "0.20.1+cu124",
    torchaudio: "2.5.1+cu124",
    torchIndexUrl: "https://download.pytorch.org/whl/cu124",
    transformers: "4.48.3",
    accelerate: "1.3.0",
  };
  let health = {};
  let healthRequests = 0;
  let separationPosts = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (
      request.method === "GET"
      && request.url === "/health?provider=BS_ROFORMER"
    ) {
      healthRequests += 1;
      response.end(JSON.stringify(health));
      return;
    }
    if (request.method === "POST" && request.url === "/separate") {
      separationPosts += 1;
      response.end(JSON.stringify({
        version: "bs-roformer-viperx-v1",
        confidence: 0.95,
        stems: [
          { role: "vocals", contentBase64: "UklGRg==", confidence: 0.95 },
          { role: "instrumental", contentBase64: "UklGRg==", confidence: 0.94 },
        ],
      }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not found" }));
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpointOrigin = `http://127.0.0.1:${address.port}`;
  const record = {
    schemaVersion: 1,
    provider: "BS_ROFORMER",
    modalAppId: "ap-BsRoformerPromoted42",
    modalDeploymentId: "v42",
    modalFunctionId: "fu-BsRoformerPromoted42",
    modalImageId: "im-BsRoformerPromoted42",
    endpointOrigin,
    modelVersion: "bs-roformer-viperx-v1",
    checkpointSha256: "a".repeat(64),
    checkpointRevision: "puar-playground/bs-roformer@immutable",
    sourceRevision: "git-bs-roformer-test-revision-42",
    sourceImageDigest: `sha256:${"c".repeat(64)}`,
    releaseEvidenceSha256: "e".repeat(64),
    runtime: runtimePins,
  };
  const signedBundle = (candidate = record) => ({
    record: candidate,
    signature: signBytes(
      null,
      Buffer.from(canonicalGpuPromotionJson(candidate)),
      promotionKeys.privateKey,
    ).toString("base64"),
  });
  const exactHealth = () => ({
    provider: record.provider,
    status: "ready",
    ready: true,
    healthy: true,
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
  });
  const endpointKeys = [
    "MUSIC_PROVIDER_BS_ROFORMER_ENDPOINT",
    "MUSIC_PROVIDER_BS_ROFORMER_URL",
    "BS_ROFORMER_API_URL",
    "BS_ROFORMER_SW_API_URL",
    "MUSIC_PROVIDER_BS_ROFORMER_PROMOTION_BUNDLE",
    "MUSIC_PROVIDER_BS_ROFORMER_PROMOTION_PUBLIC_KEY",
    "MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY",
    "MUSIC_GPU_PROMOTION_PUBLIC_KEY",
    "BS_ROFORMER_API_TOKEN",
    "BS_ROFORMER_SW_API_TOKEN",
    "MUSIC_AI_WORKER_TOKEN",
    "MUSIC_PROVIDER_DEMUCS_URL",
    "DEMUCS_API_URL",
  ];
  const previous = new Map(endpointKeys.map((key) => [key, process.env[key]]));
  const run = () => runAnalysisProviders({
    sourceUrl: "https://storage.invalid/signed-source",
    sourceType: "FULL_SONG",
    durationSeconds: 5.12,
  });
  try {
    for (const key of endpointKeys) delete process.env[key];
    process.env.MUSIC_PROVIDER_BS_ROFORMER_ENDPOINT = endpointOrigin;
    process.env.MUSIC_PROVIDER_BS_ROFORMER_URL = endpointOrigin;
    process.env.MUSIC_PROVIDER_BS_ROFORMER_TOKEN = "blocked-provider-token";
    process.env.MUSIC_PROVIDER_BS_ROFORMER_HEALTH_URL =
      `${endpointOrigin}/health?provider=BS_ROFORMER`;
    process.env.BS_ROFORMER_API_URL = endpointOrigin;
    process.env.BS_ROFORMER_SW_API_URL = endpointOrigin;
    process.env.MUSIC_PROVIDER_GATEWAY_URL = endpointOrigin;
    process.env.MUSIC_PROVIDER_GATEWAY_TOKEN = "blocked-gateway-token";
    process.env.BS_ROFORMER_API_TOKEN = "blocked-api-token";
    process.env.BS_ROFORMER_SW_API_TOKEN = "blocked-sw-token";
    process.env.MUSIC_AI_WORKER_TOKEN = "blocked-shared-token";
    process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY = promotionPublicKey;
    process.env.MUSIC_PROVIDER_BS_ROFORMER_PROMOTION_PUBLIC_KEY =
      promotionPublicKey;
    process.env.MUSIC_PROVIDER_BS_ROFORMER_PROMOTION_BUNDLE =
      JSON.stringify(signedBundle());
    health = exactHealth();
    const blockedDescriptor = MUSIC_PROVIDERS.find(
      (provider) => provider.id === "BS_ROFORMER",
    );
    assert.ok(blockedDescriptor);
    assert.equal(blockedDescriptor.status, "unavailable");
    assert.equal(blockedDescriptor.license, "UNVERIFIED checkpoint rights");
    assert.match(blockedDescriptor.notes, /BLOCKED_LICENSE/);
    const registry = createProviderRegistry();
    const blockedProvider = registry.find(
      (provider) => provider.definition.id === "BS_ROFORMER",
    );
    // Registry construction above observes every exact, legacy, shared-token,
    // and gateway alias. Remove process-global fallbacks before the first await
    // so concurrently running provider tests cannot inherit the BS fixture.
    for (const key of [
      "MUSIC_PROVIDER_BS_ROFORMER_URL",
      "MUSIC_PROVIDER_BS_ROFORMER_TOKEN",
      "MUSIC_PROVIDER_BS_ROFORMER_HEALTH_URL",
      "BS_ROFORMER_API_URL",
      "MUSIC_PROVIDER_GATEWAY_URL",
      "MUSIC_PROVIDER_GATEWAY_TOKEN",
      "MUSIC_AI_WORKER_TOKEN",
      "MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY",
    ]) {
      delete process.env[key];
    }
    assert.ok(blockedProvider);
    assert.equal(blockedProvider.available, false);
    assert.equal(blockedProvider.readiness.availability, "unavailable");
    assert.equal(blockedProvider.readiness.configurationReady, false);
    assert.equal(blockedProvider.readiness.healthStatus, "unhealthy");
    assert.match(blockedProvider.readiness.message, /BLOCKED_LICENSE/);
    await verifyProviderRegistry([blockedProvider], true);
    const blockedCatalogEntry = providerCatalog([blockedProvider])[0];
    assert.equal(blockedCatalogEntry.routingStatus, "BLOCKED_LICENSE");
    assert.equal(blockedCatalogEntry.available, false);
    assert.equal(blockedCatalogEntry.status, "unavailable");
    assert.equal(blockedCatalogEntry.configured, false);
    assert.equal(blockedCatalogEntry.checkpointReady, false);
    assert.equal(blockedCatalogEntry.runtimeReady, false);
    assert.equal(blockedCatalogEntry.lastHealth.status, "unhealthy");
    assert.throws(() => selectMusicProvider([blockedProvider], {
      task: "SEPARATION",
      requestedProvider: "BS_ROFORMER",
      hardware: "GPU",
      speed: "BALANCED",
    }), /BLOCKED_LICENSE|checkpoint-owner rights/);
    await assert.rejects(
      () => blockedProvider.generate({}),
      /BLOCKED_LICENSE|checkpoint-owner rights/,
    );
    await assert.rejects(
      () => cancelRemoteProviderJob(
        "BS_ROFORMER",
        `${endpointOrigin}/jobs/blocked`,
      ),
      /BLOCKED_LICENSE|checkpoint-owner rights/,
    );
    await assert.rejects(
      () => runArrangementProvider(blockedDescriptor, {}),
      /BLOCKED_LICENSE|checkpoint-owner rights/,
    );
    assert.equal(
      gpuPromotionAttestationFailure("BS_ROFORMER", endpointOrigin, health),
      null,
    );
    const accepted = await run();
    assert.equal(accepted.separation, null);
    assert.equal(
      accepted.provenance.find(
        (item) => item.provider === "BS_ROFORMER",
      )?.errorCode,
      "not-configured",
    );
    assert.equal(healthRequests, 0);
    assert.equal(separationPosts, 0);

    const wrongKeys = generateKeyPairSync("ed25519");
    const cases = [
      {
        name: "missing signature",
        bundle: { record },
      },
      {
        name: "bad signature",
        bundle: {
          record,
          signature: signBytes(
            null,
            Buffer.from(canonicalGpuPromotionJson(record)),
            wrongKeys.privateKey,
          ).toString("base64"),
        },
      },
      {
        name: "endpoint origin",
        bundle: signedBundle({ ...record, endpointOrigin: "https://drift.invalid" }),
      },
      {
        name: "checkpoint",
        mutateHealth: (value) => ({
          ...value,
          checksum: "b".repeat(64),
          checkpointSha256: "b".repeat(64),
        }),
      },
      {
        name: "source revision",
        mutateHealth: (value) => ({
          ...value,
          sourceRevision: "different-source-revision",
        }),
      },
      {
        name: "source image",
        mutateHealth: (value) => ({
          ...value,
          sourceImageDigest: `sha256:${"f".repeat(64)}`,
        }),
      },
      {
        name: "Modal app",
        mutateHealth: (value) => ({ ...value, modalAppId: "ap-BsDrift" }),
      },
      {
        name: "Modal deployment",
        mutateHealth: (value) => ({ ...value, modalDeploymentId: "v99" }),
      },
      {
        name: "Modal function",
        mutateHealth: (value) => ({ ...value, modalFunctionId: "fu-BsDrift" }),
      },
      {
        name: "Modal image",
        mutateHealth: (value) => ({ ...value, modalImageId: "im-BsDrift" }),
      },
      {
        name: "runtime pin",
        mutateHealth: (value) => ({
          ...value,
          framework: { ...value.framework, pytorch: "2.5.0+cu124" },
        }),
      },
    ];
    for (const mismatch of cases) {
      health = mismatch.mutateHealth
        ? mismatch.mutateHealth(exactHealth())
        : exactHealth();
      process.env.MUSIC_PROVIDER_BS_ROFORMER_PROMOTION_BUNDLE =
        JSON.stringify(mismatch.bundle ?? signedBundle());
      assert.ok(
        gpuPromotionAttestationFailure("BS_ROFORMER", endpointOrigin, health),
        mismatch.name,
      );
      assert.equal(healthRequests, 0, mismatch.name);
      assert.equal(separationPosts, 0, mismatch.name);
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test("authenticated cancellation uses the generation provider configuration", async () => {
  let authorization = null;
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
    assert.equal(request.method, "DELETE");
    assert.equal(request.url, "/jobs/gpu-1");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "cancelled" }));
  });
  await listen(server);
  const address = server.address();
  process.env.MUSIC_PROVIDER_ACE_STEP_URL =
    `http://127.0.0.1:${address.port}/generate`;
  process.env.MUSIC_PROVIDER_ACE_STEP_TOKEN = "test-worker-token";
  try {
    await cancelRemoteProviderJob("ACE_STEP", "/jobs/gpu-1");
    assert.equal(authorization, "Bearer test-worker-token");
  } finally {
    delete process.env.MUSIC_PROVIDER_ACE_STEP_URL;
    delete process.env.MUSIC_PROVIDER_ACE_STEP_TOKEN;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("DiffRhythm research endpoint never receives a commercial generation POST", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "blocked" }));
  });
  await listen(server);
  const address = server.address();
  process.env.DIFFRHYTHM2_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.DIFFRHYTHM2_API_TOKEN = "diffrhythm-provider-token";
  process.env.MUSIC_AI_WORKER_TOKEN = "shared-worker-token";
  try {
    const provider = MUSIC_PROVIDERS.find(
      (candidate) => candidate.id === "DIFFRHYTHM_2",
    );
    assert.ok(provider);
    await assert.rejects(
      () => runArrangementProvider(provider, {}),
      /non-commercial research-only provider/,
    );
    assert.equal(requests, 0);
  } finally {
    delete process.env.DIFFRHYTHM2_API_URL;
    delete process.env.DIFFRHYTHM2_API_TOKEN;
    delete process.env.MUSIC_AI_WORKER_TOKEN;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("DiffRhythm catalog exposes research-only licensing without authorizing routing", () => {
  const provider = MUSIC_PROVIDERS.find(
    (candidate) => candidate.id === "DIFFRHYTHM_2",
  );
  assert.ok(provider);
  assert.equal(provider.status, "configured");
  assert.match(provider.license, /CC-BY-NC-4.0/);
  assert.match(provider.notes, /RESEARCH_READY/);
  assert.match(provider.notes, /commercial production routing remains fail closed/i);
});

test("DiffRhythm promotion binds signature, endpoint, runtime, checkpoint, source, and image", () => {
  const promotion = configureDiffRhythmPromotion("https://diffrhythm.invalid");
  const health = diffRhythmHealth(promotion);
  assert.equal(
    gpuPromotionAttestationFailure(
      "DIFFRHYTHM_2",
      "https://diffrhythm.invalid",
      health,
    ),
    null,
  );
  for (const [field, value] of [
    ["modalAppId", "ap-Drifted"],
    ["modalDeploymentId", "v99"],
    ["modalFunctionId", "fu-Drifted"],
    ["modalImageId", "im-Drifted"],
    ["checkpointSha256", "6".repeat(64)],
    ["sourceRevision", "drifted-source"],
    ["sourceImageDigest", `sha256:${"7".repeat(64)}`],
  ]) {
    assert.match(
      gpuPromotionAttestationFailure(
        "DIFFRHYTHM_2",
        "https://diffrhythm.invalid",
        { ...health, [field]: value },
      ),
      /does not match/,
    );
  }
  for (const [section, field, value] of [
    ["runtime", "pythonVersion", "3.12"],
    ["framework", "cuda_image", "nvidia/cuda@sha256:" + "8".repeat(64)],
    ["framework", "cuda", "12.8"],
    ["framework", "pytorch", "2.8.0+cu128"],
    ["framework", "torchvision", "0.23.0"],
    ["framework", "torchaudio", "2.8.0"],
    ["framework", "torch_index_url", "https://download.pytorch.org/whl/cu128"],
    ["framework", "transformers", "4.48.0"],
    ["framework", "accelerate", "1.0.0"],
  ]) {
    assert.match(
      gpuPromotionAttestationFailure(
        "DIFFRHYTHM_2",
        "https://diffrhythm.invalid",
        {
          ...health,
          [section]: { ...health[section], [field]: value },
        },
      ),
      /do not match/,
    );
  }
  assert.match(
    gpuPromotionAttestationFailure(
      "DIFFRHYTHM_2",
      "https://other.invalid",
      health,
    ),
    /origin does not match/,
  );
  process.env.MUSIC_PROVIDER_DIFFRHYTHM_2_PROMOTION_BUNDLE = JSON.stringify({
    record: promotion.record,
    signature: "A".repeat(88),
  });
  assert.match(
    gpuPromotionAttestationFailure(
      "DIFFRHYTHM_2",
      "https://diffrhythm.invalid",
      health,
    ),
    /signature is missing or invalid/,
  );
});

test("DiffRhythm identity drift causes zero generation requests from the production API", async () => {
  let generationPosts = 0;
  const promotion = configureDiffRhythmPromotion("http://127.0.0.1");
  let health = diffRhythmHealth(promotion);
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    if (request.method === "GET" && request.url?.startsWith("/health")) {
      response.end(JSON.stringify(health));
      return;
    }
    if (request.method === "POST") generationPosts += 1;
    response.end(JSON.stringify({ provider: "DIFFRHYTHM_2" }));
  });
  await listen(server);
  const address = server.address();
  const endpointOrigin = `http://127.0.0.1:${address.port}`;
  promotion.record.endpointOrigin = endpointOrigin;
  const signature = signBytes(
    null,
    Buffer.from(canonicalGpuPromotionJson(promotion.record)),
    promotionKeys.privateKey,
  ).toString("base64");
  process.env.MUSIC_PROVIDER_DIFFRHYTHM_2_PROMOTION_BUNDLE =
    JSON.stringify({ record: promotion.record, signature });
  process.env.MUSIC_PROVIDER_DIFFRHYTHM_2_PROMOTION_PUBLIC_KEY =
    promotionPublicKey;
  process.env.DIFFRHYTHM2_API_URL = endpointOrigin;
  process.env.DIFFRHYTHM2_API_TOKEN = "research-only-token";
  health = {
    ...diffRhythmHealth({ record: promotion.record }),
    modalDeploymentId: "v99",
  };
  try {
    const provider = MUSIC_PROVIDERS.find(
      (candidate) => candidate.id === "DIFFRHYTHM_2",
    );
    assert.ok(provider);
    assert.match(
      gpuPromotionAttestationFailure(
        "DIFFRHYTHM_2",
        endpointOrigin,
        health,
      ),
      /does not match/,
    );
    const failure = gpuPromotionAttestationFailure(
      "DIFFRHYTHM_2",
      endpointOrigin,
      health,
    );
    if (failure === null) {
      await fetch(`${endpointOrigin}/generate`, { method: "POST" });
    }
    assert.equal(generationPosts, 0);
  } finally {
    delete process.env.DIFFRHYTHM2_API_URL;
    delete process.env.DIFFRHYTHM2_API_TOKEN;
    delete process.env.MUSIC_PROVIDER_DIFFRHYTHM_2_PROMOTION_BUNDLE;
    delete process.env.MUSIC_PROVIDER_DIFFRHYTHM_2_PROMOTION_PUBLIC_KEY;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("deployment env routes and authenticates ACE-Step health and generation", async () => {
  const authorizations = [];
  let servedHealth = attestedHealth;
  const server = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    response.writeHead(200, { "Content-Type": "application/json" });
    if (request.url === "/health?provider=ACE_STEP") {
      response.end(JSON.stringify(servedHealth));
      return;
    }
    response.end(JSON.stringify({
      provider: "WRONG_PROVIDER",
      modelVersion: "ace-step-1.5-base",
      checkpointSha256: "a".repeat(64),
      smokeTested: true,
      candidates: [{}],
    }));
  });
  await listen(server);
  const address = server.address();
  delete process.env.MUSIC_PROVIDER_ACE_STEP_URL;
  delete process.env.MUSIC_PROVIDER_ACE_STEP_TOKEN;
  process.env.ACE_STEP_API_URL = `http://127.0.0.1:${address.port}/generate`;
  process.env.MUSIC_AI_WORKER_TOKEN = "deployment-worker-token";
  process.env.MUSIC_PROVIDER_ACE_STEP_CHECKPOINT_SHA256 = "a".repeat(64);
  process.env.MUSIC_PROVIDER_ACE_STEP_SOURCE_IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
  process.env.MUSIC_PROVIDER_ACE_STEP_MODAL_IMAGE_ID = "im-AceStepPromoted42";
  servedHealth = withAcePromotion(
    attestedHealth,
    configureAcePromotion(`http://127.0.0.1:${address.port}`),
  );
  try {
    const [provider] = await verifyProviderRegistry([aceStepProvider()], true);
    assert.equal(providerCatalog([provider])[0].status, "ready");
    await assert.rejects(() => provider.generate({
      jobId: "deployment-env-job",
      projectId: "project-1",
      arrangementId: "arrangement-1",
      task: "ARRANGEMENT",
      style: "pop",
      mode: "FULL",
      hardware: "GPU",
      speed: "BALANCED",
      candidates: 1,
      seed: 46,
      parameters: {},
      parentArtifactIds: [],
      songModel: {},
      tracks: [],
      arrangement: {
        version: 1,
        harmonyComplexity: 5,
        energy: 0.5,
        density: 0.5,
        orchestraSize: 4,
        rhythmIntensity: 0.5,
      },
    }), /GPU provenance attestation/i);
    assert.deepEqual(authorizations, [
      "Bearer deployment-worker-token",
      "Bearer deployment-worker-token",
    ]);
  } finally {
    delete process.env.ACE_STEP_API_URL;
    delete process.env.MUSIC_AI_WORKER_TOKEN;
    delete process.env.MUSIC_PROVIDER_ACE_STEP_CHECKPOINT_SHA256;
    delete process.env.MUSIC_PROVIDER_ACE_STEP_SOURCE_IMAGE_DIGEST;
    delete process.env.MUSIC_PROVIDER_ACE_STEP_MODAL_IMAGE_ID;
    delete process.env.MUSIC_PROVIDER_ACE_STEP_PROMOTION_BUNDLE;
    delete process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("AnyAccomp ignores env authorization and sends zero POSTs on attestation mismatch", async () => {
  let generationPosts = 0;
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    if (request.url?.startsWith("/health")) {
      response.end(JSON.stringify({
        status: "ready",
        provider: "ANYACCOMP",
        runtimeReady: true,
        gpuReady: true,
        checkpointReady: true,
        modelVersion: "anyaccomp",
        checkpointSha256: "d".repeat(64),
        containerDigest: `sha256:${"e".repeat(64)}`,
        revision: "anyaccomp-r42",
        cudaVersion: "12.4",
        pytorchVersion: "2.5.1",
        gpu: "NVIDIA A100",
        smokeTested: true,
      }));
      return;
    }
    if (request.method === "POST") generationPosts += 1;
    response.end(JSON.stringify({ candidates: [] }));
  });
  await listen(server);
  const address = server.address();
  process.env.MUSIC_PROVIDER_ANYACCOMP_URL = `http://127.0.0.1:${address.port}/generate`;
  process.env.MUSIC_PROVIDER_ANYACCOMP_COMMERCIAL_USE_AUTHORIZED = "true";
  process.env.ANYACCOMP_COMMERCIAL_USE_AUTHORIZED = "true";
  process.env.MUSIC_PROVIDER_ANYACCOMP_PROMOTION_BUNDLE = JSON.stringify({
    record: {
      ...expectedGpuPromotionRecord("ANYACCOMP"),
      endpointOrigin: `http://127.0.0.1:${address.port}`,
    },
    signature: "A".repeat(88),
  });
  process.env.MUSIC_PROVIDER_ANYACCOMP_PROMOTION_PUBLIC_KEY =
    promotionPublicKey.toString();
  try {
    const registry = await verifyProviderRegistry(createProviderRegistry(), true);
    assert.throws(() => selectMusicProvider(registry, {
      task: "ARRANGEMENT", requestedProvider: "ANYACCOMP", hardware: "GPU", speed: "BALANCED",
    }), /unavailable/i);
    await assert.rejects(() => registry.find((item) =>
      item.definition.id === "ANYACCOMP")?.generate({
        sourceAudio: { url: "https://storage.example.test/private-vocal.wav" },
      }), /signed deployment health attestation/i);
    assert.equal(generationPosts, 0);
  } finally {
    delete process.env.MUSIC_PROVIDER_ANYACCOMP_URL;
    delete process.env.MUSIC_PROVIDER_ANYACCOMP_COMMERCIAL_USE_AUTHORIZED;
    delete process.env.ANYACCOMP_COMMERCIAL_USE_AUTHORIZED;
    delete process.env.MUSIC_PROVIDER_ANYACCOMP_PROMOTION_BUNDLE;
    delete process.env.MUSIC_PROVIDER_ANYACCOMP_PROMOTION_PUBLIC_KEY;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("AnyAccomp generation response retains its trusted provider audio artifact", () => {
  const record = expectedGpuPromotionRecord("ANYACCOMP");
  assert.ok(record);
  const provider = new HttpMusicGenerationProvider({
    id: "ANYACCOMP", displayName: "AnyAccomp", modelVersion: record.modelVersion,
    tasks: ["ARRANGEMENT"], hardware: ["GPU"], speeds: ["BALANCED"],
  }, `${record.endpointOrigin}/generate`, "test-token");
  const runtimeProvenance = {
    model: record.modelVersion, checkpointSha256: record.checkpointSha256,
    revision: record.checkpointRevision, modalImageId: record.modalImageId,
    sourceImageDigest: record.sourceImageDigest, cudaVersion: record.runtime.cuda,
    pytorchVersion: record.runtime.pytorch, gpu: "NVIDIA L40S",
  };
  provider.attestedChecksum = record.checkpointSha256;
  provider.readiness = { availability: "ready", runtimeProvenance };
  const sha256 = "a".repeat(64);
  const result = provider.normalizeResult({
    provider: "ANYACCOMP", modelVersion: record.modelVersion,
    checkpointSha256: record.checkpointSha256, revision: record.checkpointRevision,
    modalImageId: record.modalImageId, sourceImageDigest: record.sourceImageDigest,
    cudaVersion: record.runtime.cuda, pytorchVersion: record.runtime.pytorch,
    gpu: "NVIDIA L40S", smokeTested: true,
    candidates: [{ artifact: {
      name: "accompaniment.wav",
      url: `${record.endpointOrigin}/artifact/job/accompaniment.wav?expires=2000000000&capability=abc`,
      contentType: "audio/wav", format: "wav", bytes: 48044, sha256,
      durationSeconds: 1, sampleRate: 24000, channels: 1,
    } }],
  }, {
    candidates: 1, parameters: {}, parentArtifactIds: [], tracks: [],
    songModel: {}, arrangement: { energy: 0.5, density: 0.5 },
  });
  assert.equal(result.candidates[0].audioArtifact.sha256, sha256);
  assert.equal(result.candidates[0].audioArtifact.format, "wav");
});