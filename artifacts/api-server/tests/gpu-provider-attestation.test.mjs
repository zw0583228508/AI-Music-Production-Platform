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
  selectMusicProvider,
  verifyProviderRegistry,
} = await import(pathToFileURL(harnessPath).href);

after(async () => {
  delete process.env.MUSIC_PROVIDER_ACE_STEP_URL;
  delete process.env.MUSIC_PROVIDER_ACE_STEP_CHECKPOINT_SHA256;
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
  try {
    await run();
  } finally {
    delete process.env.MUSIC_PROVIDER_ACE_STEP_URL;
    delete process.env.MUSIC_PROVIDER_ACE_STEP_CHECKPOINT_SHA256;
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
};

test("GPU providers require exact checksum, model, GPU, and smoke attestation", async () => {
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