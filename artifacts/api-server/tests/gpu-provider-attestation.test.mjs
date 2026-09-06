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
await build({
  stdin: {
    contents: `
      export {
         MUSIC_PROVIDERS,
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
});

const {
  MUSIC_PROVIDERS,
  cancelRemoteProviderJob,
  canonicalGpuPromotionJson,
  createProviderRegistry,
  expectedGpuModalImageId,
  expectedGpuPromotionRecord,
  gpuPromotionAttestationFailure,
  providerCatalog,
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
  delete process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY;
  delete process.env.MUSIC_PROVIDER_ACE_STEP_TOKEN;
  delete process.env.MUSIC_AI_WORKER_TOKEN;
  await unlink(harnessPath).catch(() => undefined);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function withWorker(health, run) {
  let servedHealth = health;
  const server = createServer((request, response) => {
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
  process.env.MUSIC_PROVIDER_ACE_STEP_URL =
    `http://127.0.0.1:${address.port}/generate`;
  process.env.MUSIC_PROVIDER_ACE_STEP_CHECKPOINT_SHA256 = "a".repeat(64);
  process.env.MUSIC_PROVIDER_ACE_STEP_CONTAINER_DIGEST = `sha256:${"c".repeat(64)}`;
  process.env.MUSIC_PROVIDER_ACE_STEP_SOURCE_IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
  process.env.MUSIC_PROVIDER_ACE_STEP_MODAL_IMAGE_ID = "im-AceStepPromoted42";
  const origin = `http://127.0.0.1:${address.port}`;
  const promotion = configureAcePromotion(origin);
  servedHealth = withAcePromotion(health, promotion);
  try {
    await run();
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

test("DiffRhythm outbound auth prefers its API token over the shared worker token", async () => {
  let authorization = null;
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
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
    await assert.rejects(() => runArrangementProvider(provider, {}));
    assert.equal(authorization, "Bearer diffrhythm-provider-token");
  } finally {
    delete process.env.DIFFRHYTHM2_API_URL;
    delete process.env.DIFFRHYTHM2_API_TOKEN;
    delete process.env.MUSIC_AI_WORKER_TOKEN;
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

test("AnyAccomp cannot be selected or invoked without commercial-use authorization", async () => {
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
    response.end(JSON.stringify({ candidates: [] }));
  });
  await listen(server);
  const address = server.address();
  process.env.MUSIC_PROVIDER_ANYACCOMP_URL = `http://127.0.0.1:${address.port}/generate`;
  process.env.MUSIC_PROVIDER_ANYACCOMP_CHECKPOINT_SHA256 = "d".repeat(64);
  process.env.MUSIC_PROVIDER_ANYACCOMP_CONTAINER_DIGEST = `sha256:${"e".repeat(64)}`;
  delete process.env.MUSIC_PROVIDER_ANYACCOMP_COMMERCIAL_USE_AUTHORIZED;
  delete process.env.ANYACCOMP_COMMERCIAL_USE_AUTHORIZED;
  try {
    const registry = await verifyProviderRegistry(createProviderRegistry(), true);
    assert.throws(() => selectMusicProvider(registry, {
      task: "ARRANGEMENT", requestedProvider: "ANYACCOMP", hardware: "GPU", speed: "BALANCED",
    }), /unavailable/i);
    await assert.rejects(() => registry.find((item) =>
      item.definition.id === "ANYACCOMP")?.generate({}), /commercial-use authorization/i);
    await assert.rejects(() => runArrangementProvider({
      id: "ANYACCOMP", name: "AnyAccomp", provider: "AnyAccomp", version: "anyaccomp",
      capabilities: ["arrangement"], inputTypes: ["VOCAL_ONLY"], execution: "remote",
      status: "configured", license: "CC-BY-NC-ND", priority: 1, notes: "",
    }, {}), /commercial-use authorization/i);
  } finally {
    delete process.env.MUSIC_PROVIDER_ANYACCOMP_URL;
    delete process.env.MUSIC_PROVIDER_ANYACCOMP_CHECKPOINT_SHA256;
    delete process.env.MUSIC_PROVIDER_ANYACCOMP_CONTAINER_DIGEST;
    await new Promise((resolve) => server.close(resolve));
  }
});