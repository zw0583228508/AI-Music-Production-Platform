import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const apiDirectory = new URL("..", import.meta.url).pathname;
const harnessPath = `/tmp/music-provider-readiness-${process.pid}.mjs`;
await build({
  stdin: {
    contents: `
      export {
        createProviderRegistry,
        providerCatalog,
        selectMusicProvider,
        verifyProviderRegistry,
        verifiedProviderDescriptorCatalog,
      } from "./src/lib/musicProviders";
    `,
    resolveDir: apiDirectory,
    sourcefile: "music-provider-readiness-harness.ts",
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
  createProviderRegistry,
  providerCatalog,
  selectMusicProvider,
  verifyProviderRegistry,
  verifiedProviderDescriptorCatalog,
} = await import(pathToFileURL(harnessPath).href);

after(async () => {
  delete process.env.MUSIC_PROVIDER_METEOR_URL;
  delete process.env.MUSIC_PROVIDER_METEOR_HEALTH_URL;
  delete process.env.MUSIC_PROVIDER_HEALTH_TIMEOUT_MS;
  delete process.env.DEMUCS_API_URL;
  await unlink(harnessPath).catch(() => undefined);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function withHealthServer(handler, run) {
  const server = createServer(handler);
  await listen(server);
  const address = server.address();
  process.env.MUSIC_PROVIDER_METEOR_URL =
    `http://127.0.0.1:${address.port}/generate`;
  try {
    await run();
  } finally {
    delete process.env.MUSIC_PROVIDER_METEOR_URL;
    await new Promise((resolve) => server.close(resolve));
  }
}

function meteorProvider() {
  const provider = createProviderRegistry().find(
    (candidate) => candidate.definition.id === "METEOR",
  );
  assert.ok(provider);
  return provider;
}

test("routes only to a worker with a verified checkpoint and runtime", async () => {
  await withHealthServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      status: "ready",
      checkpoint: { ready: true, version: "meteor-checkpoint-9" },
      runtime: { ready: true },
    }));
  }, async () => {
    const registry = await verifyProviderRegistry([meteorProvider()], true);
    const [catalogEntry] = providerCatalog(registry);
    assert.equal(catalogEntry.status, "ready");
    assert.equal(catalogEntry.checkpointReady, true);
    assert.equal(catalogEntry.runtimeReady, true);
    assert.equal(catalogEntry.reportedVersion, "meteor-checkpoint-9");
    assert.equal(catalogEntry.lastHealth.status, "healthy");
    assert.equal(
      selectMusicProvider(registry, {
        task: "ARRANGEMENT",
        requestedProvider: "METEOR",
        hardware: "AUTO",
        speed: "BALANCED",
      }).definition.id,
      "METEOR",
    );
    const legacyEntry = (await verifiedProviderDescriptorCatalog()).find(
      (provider) => provider.id === "METEOR",
    );
    assert.ok(legacyEntry);
    assert.equal(legacyEntry.status, catalogEntry.status);
    assert.equal(legacyEntry.checkpointReady, catalogEntry.checkpointReady);
    assert.equal(legacyEntry.runtimeReady, catalogEntry.runtimeReady);
    assert.equal(legacyEntry.reportedVersion, catalogEntry.reportedVersion);
  });
});

test("keeps a configured worker unavailable when its checkpoint is missing", async () => {
  await withHealthServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      status: "ready",
      checkpointReady: false,
      runtimeReady: true,
      modelVersion: "meteor-checkpoint-9",
      message: "checkpoint file was not found",
    }));
  }, async () => {
    const registry = await verifyProviderRegistry([meteorProvider()], true);
    const [catalogEntry] = providerCatalog(registry);
    assert.equal(catalogEntry.status, "configured");
    assert.equal(catalogEntry.available, false);
    assert.equal(catalogEntry.lastHealth.status, "unhealthy");
    assert.match(catalogEntry.lastHealth.message, /checkpoint file/i);
    assert.throws(() => selectMusicProvider(registry, {
      task: "ARRANGEMENT",
      requestedProvider: "METEOR",
      hardware: "AUTO",
      speed: "BALANCED",
    }), /unavailable/i);
  });
});

test("records health timeouts as explicit configured-but-unhealthy state", async () => {
  process.env.MUSIC_PROVIDER_HEALTH_TIMEOUT_MS = "50";
  await withHealthServer(() => undefined, async () => {
    const registry = await verifyProviderRegistry([meteorProvider()], true);
    const [catalogEntry] = providerCatalog(registry);
    assert.equal(catalogEntry.status, "configured");
    assert.equal(catalogEntry.checkpointReady, false);
    assert.equal(catalogEntry.runtimeReady, false);
    assert.equal(catalogEntry.lastHealth.status, "unhealthy");
    assert.ok(catalogEntry.lastHealth.checkedAt);
    assert.match(catalogEntry.lastHealth.message, /health check failed/i);
  });
  delete process.env.MUSIC_PROVIDER_HEALTH_TIMEOUT_MS;
});

test("reports an unconfigured provider as unavailable without probing", async () => {
  delete process.env.MUSIC_PROVIDER_METEOR_URL;
  const registry = await verifyProviderRegistry([meteorProvider()], true);
  const [catalogEntry] = providerCatalog(registry);
  assert.equal(catalogEntry.status, "unavailable");
  assert.equal(catalogEntry.configured, false);
  assert.equal(catalogEntry.lastHealth.status, "unknown");
  assert.equal(catalogEntry.lastHealth.checkedAt, null);
});

test("does not claim DEMUCS readiness without every verified health signal", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/health?provider=DEMUCS");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      provider: "DEMUCS",
      status: "healthy",
      checkpointReady: true,
      runtimeReady: true,
      modelVersion: "4.0.1",
      checksum: "8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4",
      smokeTested: true,
    }));
  });
  await listen(server);
  const address = server.address();
  process.env.DEMUCS_API_URL = `http://127.0.0.1:${address.port}/separate`;
  try {
    const ready = (await verifiedProviderDescriptorCatalog()).find(
      (provider) => provider.id === "DEMUCS",
    );
    assert.equal(ready?.status, "ready");
    assert.equal(ready?.lastHealth.status, "healthy");

    server.removeAllListeners("request");
    server.on("request", (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        provider: "DEMUCS",
        status: "healthy",
        checkpointReady: true,
        runtimeReady: true,
        modelVersion: "demucs-v4",
        smokeTested: true,
      }));
    });
    const incomplete = (await verifiedProviderDescriptorCatalog()).find(
      (provider) => provider.id === "DEMUCS",
    );
    assert.equal(incomplete?.status, "configured");
    assert.equal(incomplete?.lastHealth.status, "unhealthy");
  } finally {
    delete process.env.DEMUCS_API_URL;
    await new Promise((resolve) => server.close(resolve));
  }
});