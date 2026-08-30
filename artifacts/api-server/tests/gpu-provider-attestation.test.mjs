import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const apiDirectory = new URL("..", import.meta.url).pathname;
const harnessPath = `/tmp/gpu-provider-attestation-${process.pid}.mjs`;
await build({
  stdin: {
    contents: `
      export {
        createProviderRegistry,
        cancelRemoteProviderJob,
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
  cancelRemoteProviderJob,
  createProviderRegistry,
  providerCatalog,
  runArrangementProvider,
  selectMusicProvider,
  verifyProviderRegistry,
} = await import(pathToFileURL(harnessPath).href);

after(async () => {
  delete process.env.MUSIC_PROVIDER_ACE_STEP_URL;
  delete process.env.MUSIC_PROVIDER_ACE_STEP_CHECKPOINT_SHA256;
  delete process.env.MUSIC_PROVIDER_ACE_STEP_CONTAINER_DIGEST;
  delete process.env.MUSIC_PROVIDER_ACE_STEP_TOKEN;
  await unlink(harnessPath).catch(() => undefined);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function withWorker(health, run) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    if (request.url === "/health?provider=ACE_STEP") {
      response.end(JSON.stringify(health));
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
  try {
    await run();
  } finally {
    delete process.env.MUSIC_PROVIDER_ACE_STEP_URL;
    delete process.env.MUSIC_PROVIDER_ACE_STEP_CHECKPOINT_SHA256;
    delete process.env.MUSIC_PROVIDER_ACE_STEP_CONTAINER_DIGEST;
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
  containerDigest: `sha256:${"c".repeat(64)}`,
  cudaVersion: "12.4",
  pytorchVersion: "2.5.1",
  gpu: "NVIDIA A100",
};

test("GPU providers require exact checksum, model, GPU, and smoke attestation", async () => {
  await withWorker(attestedHealth, async () => {
    delete process.env.MUSIC_PROVIDER_ACE_STEP_CONTAINER_DIGEST;
    const [provider] = await verifyProviderRegistry([aceStepProvider()], true);
    assert.equal(providerCatalog([provider])[0].status, "configured");
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