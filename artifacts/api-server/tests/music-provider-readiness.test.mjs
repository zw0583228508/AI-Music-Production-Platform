import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
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
       export { createSession, deleteSession } from "./src/lib/auth";
      export { ListGenerationProvidersResponse } from "@workspace/api-zod";
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
  createSession,
  deleteSession,
  providerCatalog,
  selectMusicProvider,
  verifyProviderRegistry,
  verifiedProviderDescriptorCatalog,
  ListGenerationProvidersResponse,
} = await import(pathToFileURL(harnessPath).href);

after(async () => {
  delete process.env.MUSIC_PROVIDER_METEOR_URL;
  delete process.env.MUSIC_PROVIDER_METEOR_CHECKPOINT_SHA256;
  delete process.env.MUSIC_PROVIDER_METEOR_CONTAINER_DIGEST;
  delete process.env.MUSIC_PROVIDER_METEOR_MODAL_IMAGE_ID;
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

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function availablePort() {
  const probe = createServer();
  await listen(probe);
  const address = probe.address();
  const port = address.port;
  await close(probe);
  return port;
}

async function waitUntilReady(baseUrl, childError) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/healthz`);
      if (response.ok) return;
    } catch {
      // The restarted API has not opened its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Provider catalog API did not become ready.\n${childError()}`);
}

async function stopApi(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}

async function readAuthenticatedCatalog(baseUrl, session) {
  const response = await fetch(`${baseUrl}/api/music-providers`, {
    headers: { Authorization: `Bearer ${session}` },
  });
  if (response.status !== 200) {
    assert.fail(
      `Provider readiness request failed after authentication with HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return ListGenerationProvidersResponse.parse(await response.json());
}

function assertPromotedAceStep(catalog) {
  const provider = catalog.find((candidate) => candidate.id === "ACE_STEP");
  assert.ok(provider, "Authenticated provider catalog omitted ACE-Step");
  assert.equal(provider.status, "ready");
  assert.equal(provider.available, true);
  assert.equal(provider.configured, true);
  assert.equal(provider.checkpointReady, true);
  assert.equal(provider.runtimeReady, true);
  assert.equal(provider.smokeTested, true);
  assert.equal(provider.modelVersion, "ace-step-1.5-base");
  assert.equal(provider.reportedVersion, "ace-step-1.5-base");
  assert.equal(provider.reportedChecksum, "a".repeat(64));
  assert.deepEqual(provider.runtimeProvenance, {
    model: "ace-step-1.5-base",
    checkpointSha256: "a".repeat(64),
    revision: "ace-step-1.5-base-r42",
    modalImageId: "im-AceStepPromoted42",
    sourceImageDigest: `sha256:${"c".repeat(64)}`,
    cudaVersion: "12.4",
    pytorchVersion: "2.5.1",
    gpu: "NVIDIA A100",
  });
  assert.equal(provider.lastHealth.status, "healthy");
}

async function withHealthServer(handler, run) {
  const server = createServer(handler);
  await listen(server);
  const address = server.address();
  process.env.MUSIC_PROVIDER_METEOR_URL =
    `http://127.0.0.1:${address.port}/generate`;
  process.env.MUSIC_PROVIDER_METEOR_CHECKPOINT_SHA256 = "b".repeat(64);
  process.env.MUSIC_PROVIDER_METEOR_CONTAINER_DIGEST = `sha256:${"c".repeat(64)}`;
  process.env.MUSIC_PROVIDER_METEOR_MODAL_IMAGE_ID = "im-MeteorPromoted42";
  try {
    await run();
  } finally {
    delete process.env.MUSIC_PROVIDER_METEOR_URL;
    delete process.env.MUSIC_PROVIDER_METEOR_CHECKPOINT_SHA256;
    delete process.env.MUSIC_PROVIDER_METEOR_CONTAINER_DIGEST;
    delete process.env.MUSIC_PROVIDER_METEOR_MODAL_IMAGE_ID;
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
      provider: "METEOR",
      checkpoint: { ready: true, version: "meteor", sha256: "b".repeat(64) },
      runtime: {
        ready: true,
        gpuReady: true,
        revision: "meteor-r42",
        imageId: "im-MeteorPromoted42",
        containerDigest: `sha256:${"c".repeat(64)}`,
        cudaVersion: "12.4",
        pytorchVersion: "2.5.1",
        gpu: "NVIDIA A100",
      },
      smokeTested: true,
    }));
  }, async () => {
    const registry = await verifyProviderRegistry([meteorProvider()], true);
    const [catalogEntry] = providerCatalog(registry);
    assert.equal(catalogEntry.status, "ready");
    assert.equal(catalogEntry.checkpointReady, true);
    assert.equal(catalogEntry.runtimeReady, true);
    assert.equal(catalogEntry.smokeTested, true);
    assert.equal(catalogEntry.reportedVersion, "meteor");
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

test("authenticated ACE-Step catalog identity survives an API restart", async () => {
  let api;
  let session;
  let apiError = "";
  let workerHealthChecks = 0;
  const worker = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer catalog-worker-token") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "worker authentication required" }));
      return;
    }
    if (request.url !== "/health?provider=ACE_STEP") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    workerHealthChecks += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
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
      sourceImageDigest: `sha256:${"c".repeat(64)}`,
      cudaVersion: "12.4",
      pytorchVersion: "2.5.1",
      gpu: "NVIDIA A100",
    }));
  });
  await listen(worker);
  const workerAddress = worker.address();
  const childEnvironment = {
    ...process.env,
    NODE_ENV: "test",
    MUSIC_PROVIDER_ACE_STEP_URL:
      `http://127.0.0.1:${workerAddress.port}/generate`,
    MUSIC_PROVIDER_ACE_STEP_TOKEN: "catalog-worker-token",
    MUSIC_PROVIDER_ACE_STEP_CHECKPOINT_SHA256: "a".repeat(64),
    MUSIC_PROVIDER_ACE_STEP_MODAL_IMAGE_ID: "im-AceStepPromoted42",
    MUSIC_PROVIDER_ACE_STEP_SOURCE_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
  };
  const startApi = async () => {
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    apiError = "";
    const child = spawn(
      process.execPath,
      ["--enable-source-maps", "./dist/index.mjs"],
      {
        cwd: apiDirectory,
        env: { ...childEnvironment, PORT: String(port) },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    child.stderr.on("data", (chunk) => {
      apiError += chunk.toString();
    });
    await waitUntilReady(baseUrl, () => apiError);
    return { child, baseUrl };
  };

  try {
    let running = await startApi();
    api = running.child;
    session = await createSession({
      user: {
        id: `provider-release-${process.pid}`,
        email: null,
        firstName: "Provider",
        lastName: "Release",
        profileImageUrl: null,
      },
      access_token: "test",
    });

    const anonymous = await fetch(`${running.baseUrl}/api/music-providers`);
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), { error: "Unauthorized" });
    assertPromotedAceStep(
      await readAuthenticatedCatalog(running.baseUrl, session),
    );

    await stopApi(api);
    running = await startApi();
    api = running.child;
    assertPromotedAceStep(
      await readAuthenticatedCatalog(running.baseUrl, session),
    );
    assert.ok(workerHealthChecks >= 2);
  } finally {
    await stopApi(api);
    if (session) await deleteSession(session);
    await close(worker);
  }
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

test("returns MusicGen in the provider catalog accepted by the API response schema", async () => {
  const registry = await verifyProviderRegistry(undefined, true);
  const catalog = ListGenerationProvidersResponse.parse(providerCatalog(registry));
  const musicGen = catalog.find((provider) => provider.id === "MUSICGEN");
  assert.ok(musicGen);
  assert.equal(musicGen.name, "MusicGen");
  assert.equal(musicGen.status, "unavailable");
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