import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import { createServer } from "node:net";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import {
  access,
  mkdtemp,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const apiDirectory = new URL("..", import.meta.url).pathname;
const harnessPath = `${apiDirectory}/.music-export-auth-harness-${process.pid}.mjs`;
await build({
  stdin: {
    contents: `
      export { createSession, deleteSession } from "./src/lib/auth";
      export { loadExportZip, persistExportBundle } from "./src/lib/export-pipeline";
      export {
        arrangementsTable,
        db,
        musicArtifactsTable,
         musicGenerationCandidatesTable,
         musicGenerationJobsTable,
        musicProjectsTable,
        projectSourcesTable,
        projectCleanupJobsTable,
        projectUploadReservationsTable,
      } from "@workspace/db";
      export { getPrivateObject } from "./src/lib/objectStorage";
      export { eq } from "drizzle-orm";
      export { ListGenerationProvidersResponse } from "@workspace/api-zod";
    `,
    resolveDir: apiDirectory,
    sourcefile: "authorization-harness.ts",
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
  arrangementsTable,
  createSession,
  db,
  deleteSession,
  eq,
  getPrivateObject,
  ListGenerationProvidersResponse,
  loadExportZip,
  musicArtifactsTable,
  musicGenerationCandidatesTable,
  musicGenerationJobsTable,
  musicProjectsTable,
  projectSourcesTable,
  projectCleanupJobsTable,
  projectUploadReservationsTable,
  persistExportBundle,
} = await import(pathToFileURL(harnessPath).href);

let server;
let baseUrl;
let ownerSession;
let otherSession;
let projectId;
let arrangementId;
let generationJobId;
let exportId;
let raceHookDirectory;
let instrumentWorker;
let instrumentWorkerMode = "accept";
let instrumentWorkerRequests = 0;
let instrumentWorkerReceivedBytes = 0;
let instrumentWorkerLargestChunk = 0;
let instrumentWorkerDeclaredBytes = 0;

function safeRaceSubject(subject) {
  return subject.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function raceHookPath(kind, name, subject, suffix = "") {
  return join(
    raceHookDirectory,
    `${kind}-${name}-${safeRaceSubject(subject)}${suffix}`,
  );
}

async function waitForRaceHook(path) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for race hook: ${path}`);
}

async function enableRaceGate(name, subject) {
  await writeFile(raceHookPath("gate", name, subject, ".enabled"), "");
}

async function releaseRaceGate(name, subject) {
  await writeFile(raceHookPath("gate", name, subject, ".release"), "");
}
let exportStorageObjectId;
let legacyExportStorageObjectId;

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitUntilReady(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/healthz`);
      if (response.ok) return;
    } catch {
      // The child server has not opened its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Authorization test API did not become ready");
}

function request(path, session, init = {}) {
  const headers = new Headers(init.headers);
  if (session) headers.set("Authorization", `Bearer ${session}`);
  return fetch(`${baseUrl}${path}`, { ...init, headers, redirect: init.redirect ?? "manual" });
}

function assertProducerSafeEvaluation(evaluation) {
  assert.equal(evaluation.musicCritic, null);
  assert.equal("fingerprint" in evaluation.diversity, false);
  assert.equal(evaluation.diversity.reason, "near_duplicate");
  assert.equal(evaluation.diversity.distance, 0.12);
  assert.equal(evaluation.diversity.rejected, true);
}

function instrumentPackMultipart(size) {
  const boundary = `music-pack-${process.pid}`;
  const fields = [
    ["kind", "vst3"],
    ["assetId", `large-pack-${process.pid}`],
    ["identity", "Licensed Large Pack"],
    ["licenseOwner", "Authorization Test Studio"],
    ["licenseReference", "license-large-pack"],
    ["rendererIdentity", "Approved Test Host"],
  ];
  const prefix = Buffer.from(
    fields.map(([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ).join("") +
      `--${boundary}\r\nContent-Disposition: form-data; name="assetFiles"; filename="large.vst3"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const suffix = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="rendererFile"; filename="host"\r\nContent-Type: application/octet-stream\r\n\r\n#!/bin/sh\nexit 0\n\r\n--${boundary}--\r\n`,
  );
  const body = Readable.from((async function* streamPack() {
    yield prefix;
    const block = Buffer.alloc(1024 * 1024, 0x5a);
    for (let remaining = size; remaining > 0; remaining -= block.length) {
      yield block.subarray(0, Math.min(block.length, remaining));
    }
    yield suffix;
  })());
  return {
    body,
    contentLength: prefix.length + size + suffix.length,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function uploadInstrumentPack(size) {
  const multipart = instrumentPackMultipart(size);
  return request("/api/instrument-packs/stage", ownerSession, {
    method: "POST",
    headers: {
      "Content-Type": multipart.contentType,
      "Content-Length": String(multipart.contentLength),
    },
    body: multipart.body,
    duplex: "half",
  });
}

function oversizedInstrumentPackRequest(contentLength) {
  return new Promise((resolve, reject) => {
    const target = new URL("/api/instrument-packs/stage", baseUrl);
    const request = httpRequest(target, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerSession}`,
        "Content-Type": "multipart/form-data; boundary=oversized",
        "Content-Length": String(contentLength),
      },
    });
    request.once("error", reject);
    request.once("response", (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.end();
  });
}

before(async () => {
  instrumentWorker = createHttpServer((request, response) => {
    instrumentWorkerRequests += 1;
    instrumentWorkerReceivedBytes = 0;
    instrumentWorkerLargestChunk = 0;
    instrumentWorkerDeclaredBytes = Number(request.headers["content-length"] ?? 0);
    request.on("data", (chunk) => {
      instrumentWorkerReceivedBytes += chunk.length;
      instrumentWorkerLargestChunk = Math.max(instrumentWorkerLargestChunk, chunk.length);
    });
    request.on("end", () => {
      if (instrumentWorkerMode === "timeout") {
        const delayedResponse = setTimeout(() => {
          if (!response.destroyed) {
            response.writeHead(504, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ detail: "worker verification timed out" }));
          }
        }, 30_000);
        delayedResponse.unref();
        return;
      }
      if (instrumentWorkerMode === "truncated") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ detail: "multipart instrument pack was truncated" }));
        return;
      }
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        candidateId: `candidate-${process.pid}-large-pack`,
        kind: "vst3",
        assetId: `large-pack-${process.pid}`,
        identity: "Licensed Large Pack",
        licenseOwner: "Authorization Test Studio",
        licenseReference: "license-large-pack",
        rendererIdentity: "Approved Test Host",
        sha256: "a".repeat(64),
        rendererSha256: "b".repeat(64),
        status: "verified",
        smokeEvidence: {
          assetId: `large-pack-${process.pid}`,
          sha256: "a".repeat(64),
          rendererIdentity: "Approved Test Host",
          rendererSha256: "b".repeat(64),
          trackModelRendered: true,
          audible: true,
          canonicalSensitivity: true,
          nativeHostAttested: true,
          outputSha256: "c".repeat(64),
          pitchVariantSha256: "d".repeat(64),
          expressionVariantSha256: "e".repeat(64),
          peak: 0.2,
          sampleRate: 22050,
          durationSeconds: 1,
          format: "wav/pcm_s16le",
        },
      }));
    });
  });
  await new Promise((resolve, reject) => {
    instrumentWorker.once("error", reject);
    instrumentWorker.listen(0, "127.0.0.1", resolve);
  });
  const instrumentWorkerPort = instrumentWorker.address().port;
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  raceHookDirectory = await mkdtemp(
    join(tmpdir(), "music-project-storage-race-"),
  );
  server = spawn(process.execPath, ["--enable-source-maps", "./dist/index.mjs"], {
    cwd: apiDirectory,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      TEST_PROJECT_STORAGE_RACE_DIR: raceHookDirectory,
      MUSIC_AI_WORKER_URL: `http://127.0.0.1:${instrumentWorkerPort}`,
      MUSIC_AI_WORKER_TOKEN: "instrument-pack-test-token",
      MUSIC_STUDIO_ADMIN_IDS: `export-owner-${process.pid}`,
      MUSIC_STUDIO_MAX_INSTRUMENT_PACK_UPLOAD_BYTES: String(160 * 1024 * 1024),
      MUSIC_STUDIO_INSTRUMENT_PACK_TIMEOUT_SECONDS: "10",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverError = "";
  server.stderr.on("data", (chunk) => {
    serverError += chunk.toString();
  });
  server.once("exit", (code) => {
    if (code && code !== 0) serverError += `\nserver exited with ${code}`;
  });
  await waitUntilReady(baseUrl).catch((error) => {
    throw new Error(`${error.message}\n${serverError}`);
  });

  ownerSession = await createSession({
    user: {
      id: `export-owner-${process.pid}`,
      email: null,
      firstName: "Export",
      lastName: "Owner",
      profileImageUrl: null,
    },
    access_token: "test",
  });
  otherSession = await createSession({
    user: {
      id: `export-other-${process.pid}`,
      email: null,
      firstName: "Other",
      lastName: "User",
      profileImageUrl: null,
    },
    access_token: "test",
  });

  const createResponse = await request("/api/projects", ownerSession, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Authorization Test", sourceType: "FULL_SONG" }),
  });
  assert.equal(createResponse.status, 201);
  projectId = (await createResponse.json()).id;
  arrangementId = `auth-arrangement-${process.pid}`;
  generationJobId = `auth-generation-job-${process.pid}`;
  exportId = `auth-export-${process.pid}`;
  exportStorageObjectId = `${exportId}-content-addressed`;
  legacyExportStorageObjectId = `${exportId}-legacy-content-addressed`;
  await db.insert(arrangementsTable).values({
    id: arrangementId,
    projectId,
    name: "Private arrangement",
    style: "Test",
    mode: "STUDIO",
    sections: [],
    generationProvenance: {
      jobId: generationJobId,
      candidateId: `auth-candidate-${process.pid}`,
      provider: "METEOR",
      modelVersion: "historical-model",
      reportedModelVersion: null,
      providerRequestId: null,
      songModelVersion: null,
      seed: 233,
      parameters: {},
      parentArtifactIds: [],
      evaluation: {
        status: "diversity_rejected",
        providerScore: 0.7,
        renderArtifactIds: [],
        artifacts: [],
        qualityReport: null,
        error: null,
        diversity: {
          fingerprint: {
            activeTracks: ["private-track"],
            densityEnergy: [{ density: 0.5, energy: 0.5 }],
            harmonySequence: ["private-harmony"],
            trackRoleInstruments: ["private-role"],
            noteShape: [1, 2, 3],
          },
          comparedToCandidateId: "baseline-candidate",
          distance: 0.12,
          threshold: 0.25,
          rejected: true,
          reason: "near_duplicate",
        },
      },
    },
  });
  await db.insert(musicGenerationJobsTable).values({
    id: generationJobId,
    projectId,
    arrangementId,
    task: "ARRANGEMENT",
    status: "succeeded",
    provider: "METEOR",
    modelVersion: "historical-model",
    hardware: "AUTO",
    speed: "BALANCED",
    progress: 100,
    stage: "completed",
    requestedCandidates: 1,
    seed: 233,
    inputSnapshot: {},
  });
  await db.insert(musicGenerationCandidatesTable).values({
    id: `auth-candidate-${process.pid}`,
    jobId: generationJobId,
    projectId,
    arrangementId,
    provider: "METEOR",
    modelVersion: "historical-model",
    seed: 233,
    rank: null,
    label: "Historical candidate",
    score: 0.7,
    confidence: 0.8,
    summary: "Historical candidate without a Music Critic report",
    status: "diversity_rejected",
    plan: { sections: [] },
    trackModels: null,
    evaluation: {
      status: "diversity_rejected",
      providerScore: 0.7,
      renderArtifactIds: [],
      artifacts: [],
      qualityReport: null,
      error: null,
      diversity: {
        fingerprint: {
          activeTracks: ["private-track"],
          densityEnergy: [{ density: 0.5, energy: 0.5 }],
          harmonySequence: ["private-harmony"],
          trackRoleInstruments: ["private-role"],
          noteShape: [1, 2, 3],
        },
        comparedToCandidateId: "baseline-candidate",
        distance: 0.12,
        threshold: 0.25,
        rejected: true,
        reason: "near_duplicate",
      },
    },
  });
  await db.insert(musicArtifactsTable).values({
    id: exportId,
    projectId,
    type: "EXPORT",
    label: "private.zip",
    version: 1,
    size: "1 KB",
    format: "ZIP",
    state: "ready",
    url: `/api/projects/${projectId}/exports/${exportId}/download`,
    storageUri: `/api/storage/objects/exports/${exportStorageObjectId}.zip`,
  });
  await persistExportBundle({ zip: Buffer.from("private export bytes") }, exportStorageObjectId);
  await db.insert(musicArtifactsTable).values({
    id: `${exportId}-legacy`,
    projectId,
    type: "EXPORT",
    label: "private-legacy.zip",
    version: 1,
    size: "1 KB",
    format: "ZIP",
    state: "ready",
    url: `/api/projects/${projectId}/exports/${exportId}/download`,
    storageUri: `export-object://${legacyExportStorageObjectId}`,
  });
  await persistExportBundle(
    { zip: Buffer.from("legacy private export bytes") },
    legacyExportStorageObjectId,
  );
});

after(async () => {
  if (projectId) {
    await db.delete(musicProjectsTable).where(eq(musicProjectsTable.id, projectId));
  }
  if (ownerSession) await deleteSession(ownerSession);
  if (otherSession) await deleteSession(otherSession);
  if (server && !server.killed) server.kill("SIGTERM");
  if (instrumentWorker) {
    await new Promise((resolve) => instrumentWorker.close(resolve));
  }
  await unlink(harnessPath).catch(() => undefined);
  if (raceHookDirectory) {
    await rm(raceHookDirectory, { recursive: true, force: true });
  }
});

test("admin route streams a production-sized multipart instrument pack without truncation", async () => {
  instrumentWorkerMode = "accept";
  const response = await uploadInstrumentPack(128 * 1024 * 1024);
  assert.equal(response.status, 201);
  const candidate = await response.json();
  assert.equal(candidate.status, "verified");
  assert.equal(candidate.sha256, "a".repeat(64));
  assert.equal(instrumentWorkerReceivedBytes, instrumentWorkerDeclaredBytes);
  assert.ok(instrumentWorkerLargestChunk <= 1024 * 1024);
});

test("admin route rejects oversized packs before contacting the worker", async () => {
  const requestsBefore = instrumentWorkerRequests;
  const response = await oversizedInstrumentPackRequest(161 * 1024 * 1024);
  assert.equal(response.status, 413);
  assert.match(response.body, /API streaming limit/);
  assert.equal(instrumentWorkerRequests, requestsBefore);
});

test("admin route reports truncated worker uploads without activating anything", async () => {
  instrumentWorkerMode = "truncated";
  const response = await uploadInstrumentPack(1024);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /truncated/);
});

test("admin route reports verification timeouts without activating anything", async () => {
  instrumentWorkerMode = "timeout";
  const response = await uploadInstrumentPack(1024);
  assert.equal(response.status, 504);
  assert.match(await response.text(), /active pack was not changed/);
  instrumentWorkerMode = "accept";
});

async function createRaceUpload(label) {
  const createResponse = await request("/api/projects", ownerSession, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: label,
      sourceType: "FULL_SONG",
    }),
  });
  assert.equal(createResponse.status, 201);
  const raceProjectId = (await createResponse.json()).id;

  const reservationResponse = await request(
    "/api/storage/uploads/request-url",
    ownerSession,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: raceProjectId,
        name: `${label}.wav`,
        contentType: "audio/wav",
        size: 32,
      }),
    },
  );
  assert.equal(reservationResponse.status, 200);
  const reservation = await reservationResponse.json();
  return { raceProjectId, reservation };
}

test("competing arrangement save and restore requests preserve one append-only successor", async () => {
  const competingArrangementId = `revision-race-${process.pid}`;
  await db.insert(arrangementsTable).values({
    id: competingArrangementId,
    projectId,
    name: "Revision race",
    style: "Test",
    mode: "STUDIO",
    sections: [],
  });
  const revisionsResponse = await request(
    `/api/arrangements/${competingArrangementId}/revisions`,
    ownerSession,
  );
  assert.equal(revisionsResponse.status, 200);
  const revisions = await revisionsResponse.json();
  const initialRevision = revisions.find((revision) => revision.version === 1);
  assert.ok(initialRevision);

  const [saveResponse, restoreResponse] = await Promise.all([
    request(`/api/arrangements/${competingArrangementId}`, ownerSession, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ energy: 0.72, expectedVersion: 1 }),
    }),
    request(
      `/api/arrangements/${competingArrangementId}/revisions/${initialRevision.id}/restore`,
      ownerSession,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: 1 }),
      },
    ),
  ]);
  assert.deepEqual(
    [saveResponse.status, restoreResponse.status].sort(),
    [200, 409],
  );

  const historyResponse = await request(
    `/api/arrangements/${competingArrangementId}/revisions`,
    ownerSession,
  );
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert.deepEqual(history.map((revision) => revision.version), [2, 1]);
});

async function createPlaybackSource(
  playbackProjectId,
  sourceId,
  label,
  bytes,
  sourceType = "FULL_SONG",
  contentType = "audio/wav",
) {
  const reservationResponse = await request(
    "/api/storage/uploads/request-url",
    ownerSession,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: playbackProjectId,
        name: `${label}.wav`,
        contentType,
        size: bytes.length,
      }),
    },
  );
  assert.equal(reservationResponse.status, 200);
  const reservation = await reservationResponse.json();
  const uploadResponse = await request(reservation.uploadURL, ownerSession, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.length),
    },
    body: bytes,
  });
  assert.equal(uploadResponse.status, 204);
  await db.insert(projectSourcesTable).values({
    id: sourceId,
    projectId: playbackProjectId,
    ownerId: `export-owner-${process.pid}`,
    objectPath: reservation.objectPath,
    name: `${label}.wav`,
    size: bytes.length,
    contentType,
    sourceType,
    status: "queued",
    progress: 0,
  });
  return reservation.objectPath;
}

function putReservedSource(reservation) {
  return request(reservation.uploadURL, ownerSession, {
    method: "PUT",
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": "32",
    },
    body: new Uint8Array(32),
  });
}

async function assertCompletedCleanup(
  deleteResponse,
  raceProjectId,
  objectPath,
) {
  assert.equal(deleteResponse.status, 200);
  const deletion = await deleteResponse.json();
  assert.equal(deletion.projectId, raceProjectId);
  assert.equal(deletion.status, "completed");
  assert.equal(deletion.pendingObjectCount, 0);

  const [cleanupJob] = await db
    .select()
    .from(projectCleanupJobsTable)
    .where(eq(projectCleanupJobsTable.id, deletion.id));
  assert.ok(cleanupJob);
  assert.equal(cleanupJob.status, "completed");
  assert.deepEqual(cleanupJob.objectPaths, []);

  const object = await getPrivateObject(
    objectPath.slice("/objects/".length),
  );
  assert.equal(object, null);
}

test("project deletion cleans an upload already holding the project fence", async () => {
  const { raceProjectId, reservation } = await createRaceUpload(
    "Upload owns fence",
  );
  await enableRaceGate("source-upload-write", reservation.objectPath);

  const uploadPromise = putReservedSource(reservation);
  await waitForRaceHook(
    raceHookPath(
      "gate",
      "source-upload-write",
      reservation.objectPath,
      ".entered",
    ),
  );

  const deletePromise = request(
    `/api/projects/${raceProjectId}`,
    ownerSession,
    { method: "DELETE" },
  );
  await waitForRaceHook(
    raceHookPath("event", "project-delete-requested", raceProjectId),
  );
  await releaseRaceGate("source-upload-write", reservation.objectPath);

  const [uploadResponse, deleteResponse] = await Promise.all([
    uploadPromise,
    deletePromise,
  ]);
  assert.equal(uploadResponse.status, 204);
  await assertCompletedCleanup(
    deleteResponse,
    raceProjectId,
    reservation.objectPath,
  );
});

test("an upload waiting behind project deletion is rejected before writing", async () => {
  const { raceProjectId, reservation } = await createRaceUpload(
    "Delete owns fence",
  );
  await enableRaceGate("project-delete", raceProjectId);

  const deletePromise = request(
    `/api/projects/${raceProjectId}`,
    ownerSession,
    { method: "DELETE" },
  );
  await waitForRaceHook(
    raceHookPath("gate", "project-delete", raceProjectId, ".entered"),
  );

  const uploadPromise = putReservedSource(reservation);
  await waitForRaceHook(
    raceHookPath(
      "event",
      "source-upload-requested",
      reservation.objectPath,
    ),
  );
  await releaseRaceGate("project-delete", raceProjectId);

  const [deleteResponse, uploadResponse] = await Promise.all([
    deletePromise,
    uploadPromise,
  ]);
  assert.equal(uploadResponse.status, 404);
  await assertCompletedCleanup(
    deleteResponse,
    raceProjectId,
    reservation.objectPath,
  );
});

test("source-qualified playback stays on the requested upload when analyses finish out of order", async () => {
  const createResponse = await request("/api/projects", ownerSession, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `Playback source identity ${process.pid}`,
      sourceType: "FULL_SONG",
    }),
  });
  assert.equal(createResponse.status, 201);
  const playbackProjectId = (await createResponse.json()).id;
  const firstSourceId = `playback-first-${process.pid}`;
  const secondSourceId = `playback-second-${process.pid}`;
  const missingObjectSourceId = `playback-missing-${process.pid}`;
  const midiSourceId = `playback-midi-${process.pid}`;
  const firstBytes = new TextEncoder().encode("first-upload-audio");
  const secondBytes = new TextEncoder().encode("second-upload-audio");
  try {
    await createPlaybackSource(
      playbackProjectId,
      firstSourceId,
      "first",
      firstBytes,
    );
    await createPlaybackSource(
      playbackProjectId,
      secondSourceId,
      "second",
      secondBytes,
    );
    await db
      .update(projectSourcesTable)
      .set({ status: "ready", progress: 100 })
      .where(eq(projectSourcesTable.id, secondSourceId));
    await db
      .update(projectSourcesTable)
      .set({ status: "ready", progress: 100 })
      .where(eq(projectSourcesTable.id, firstSourceId));

    const firstPlayback = await request(
      `/api/projects/${playbackProjectId}/playback?sourceId=${firstSourceId}`,
      ownerSession,
    );
    assert.equal(firstPlayback.status, 200);
    assert.equal(firstPlayback.headers.get("accept-ranges"), "bytes");
    assert.equal(
      Buffer.from(await firstPlayback.arrayBuffer()).toString(),
      "first-upload-audio",
    );

    const secondPlayback = await request(
      `/api/projects/${playbackProjectId}/playback?sourceId=${secondSourceId}`,
      ownerSession,
    );
    assert.equal(secondPlayback.status, 200);
    assert.equal(
      Buffer.from(await secondPlayback.arrayBuffer()).toString(),
      "second-upload-audio",
    );

    const rangedPlayback = await request(
      `/api/projects/${playbackProjectId}/playback?sourceId=${firstSourceId}`,
      ownerSession,
      { headers: { Range: "bytes=6-10" } },
    );
    assert.equal(rangedPlayback.status, 206);
    assert.equal(
      rangedPlayback.headers.get("content-range"),
      `bytes 6-10/${firstBytes.length}`,
    );
    assert.equal(
      Buffer.from(await rangedPlayback.arrayBuffer()).toString(),
      "uploa",
    );

    const suffixPlayback = await request(
      `/api/projects/${playbackProjectId}/playback?sourceId=${secondSourceId}`,
      ownerSession,
      { headers: { Range: "bytes=-5" } },
    );
    assert.equal(suffixPlayback.status, 206);
    assert.equal(
      Buffer.from(await suffixPlayback.arrayBuffer()).toString(),
      "audio",
    );

    const invalidRange = await request(
      `/api/projects/${playbackProjectId}/playback?sourceId=${firstSourceId}`,
      ownerSession,
      { headers: { Range: "bytes=999-1000" } },
    );
    assert.equal(invalidRange.status, 416);
    assert.equal(
      invalidRange.headers.get("content-range"),
      `bytes */${firstBytes.length}`,
    );

    assert.equal(
      (
        await request(
          `/api/projects/${playbackProjectId}/playback?sourceId=${firstSourceId}`,
          otherSession,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await request(
          `/api/projects/${playbackProjectId}/playback?sourceId=does-not-exist`,
          ownerSession,
        )
      ).status,
      409,
    );

    await db.insert(projectSourcesTable).values({
      id: missingObjectSourceId,
      projectId: playbackProjectId,
      ownerId: `export-owner-${process.pid}`,
      objectPath: "/objects/uploads/00000000-0000-4000-8000-000000000000",
      name: "missing.wav",
      size: 64,
      contentType: "audio/wav",
      sourceType: "FULL_SONG",
      status: "ready",
      progress: 100,
    });
    const missingObjectPlayback = await request(
      `/api/projects/${playbackProjectId}/playback?sourceId=${missingObjectSourceId}`,
      ownerSession,
    );
    assert.equal(missingObjectPlayback.status, 404);

    await createPlaybackSource(
      playbackProjectId,
      midiSourceId,
      "notes",
      new TextEncoder().encode("midi-data"),
      "MIDI",
      "audio/midi",
    );
    await db
      .update(projectSourcesTable)
      .set({ status: "ready", progress: 100 })
      .where(eq(projectSourcesTable.id, midiSourceId));
    const midiPlayback = await request(
      `/api/projects/${playbackProjectId}/playback?sourceId=${midiSourceId}`,
      ownerSession,
    );
    assert.equal(midiPlayback.status, 409);
    assert.equal((await midiPlayback.json()).code, "PLAYBACK_UNAVAILABLE");
  } finally {
    const cleanupResponse = await request(
      `/api/projects/${playbackProjectId}`,
      ownerSession,
      { method: "DELETE" },
    );
    assert.ok([200, 202, 404].includes(cleanupResponse.status));
  }
});

test("project and export endpoints enforce owner authorization", async () => {
  const anonymousCreate = await request("/api/projects", null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Anonymous", sourceType: "FULL_SONG" }),
  });
  assert.equal(anonymousCreate.status, 401);

  assert.equal((await request(`/api/projects/${projectId}`, ownerSession)).status, 200);
  assert.equal((await request(`/api/projects/${projectId}`, otherSession)).status, 404);
  assert.equal(
    (await request(`/api/arrangements/${arrangementId}`, null, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, name: "Anonymous edit" }),
    })).status,
    401,
  );
  assert.equal(
    (await request(`/api/arrangements/${arrangementId}/export`, null, {
      method: "POST",
    })).status,
    401,
  );

  const [beforeCrossOwnerEdit] = await db
    .select({ sections: arrangementsTable.sections })
    .from(arrangementsTable)
    .where(eq(arrangementsTable.id, arrangementId));
  const crossOwnerEdit = await request(
    `/api/arrangements/${arrangementId}`,
    otherSession,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        sections: [{
          name: "Unauthorized edit",
          energy: 0.5,
          density: 0.5,
          tracks: [],
          startBar: 1,
          endBar: 1,
        }],
      }),
    },
  );
  assert.equal(crossOwnerEdit.status, 404);
  const [afterCrossOwnerEdit] = await db
    .select({ sections: arrangementsTable.sections })
    .from(arrangementsTable)
    .where(eq(arrangementsTable.id, arrangementId));
  assert.deepEqual(afterCrossOwnerEdit.sections, beforeCrossOwnerEdit.sections);

  const ownerEdit = await request(
    `/api/arrangements/${arrangementId}`,
    ownerSession,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, name: "Owner edit" }),
    },
  );
  assert.equal(ownerEdit.status, 200);
  const arrangementDetail = await ownerEdit.json();
  assert.equal(arrangementDetail.name, "Owner edit");
  assertProducerSafeEvaluation(arrangementDetail.generationProvenance.evaluation);
  assert.equal(JSON.stringify(arrangementDetail).includes("private-track"), false);

  const arrangementListResponse = await request(
    `/api/projects/${projectId}/arrangements`,
    ownerSession,
  );
  assert.equal(arrangementListResponse.status, 200);
  const arrangementList = await arrangementListResponse.json();
  const listedArrangement = arrangementList.find(({ id }) => id === arrangementId);
  assert.ok(listedArrangement);
  assertProducerSafeEvaluation(listedArrangement.generationProvenance.evaluation);
  assert.equal(JSON.stringify(listedArrangement).includes("private-track"), false);

  const candidatesResponse = await request(
    `/api/generation-jobs/${generationJobId}/candidates`,
    ownerSession,
  );
  assert.equal(candidatesResponse.status, 200);
  const candidates = await candidatesResponse.json();
  assert.equal(candidates.length, 1);
  assertProducerSafeEvaluation(candidates[0].evaluation);
  assert.equal(JSON.stringify(candidates[0]).includes("private-track"), false);

  const crossUserExport = await request(`/api/projects/${projectId}/export`, otherSession, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ arrangementId }),
  });
  assert.equal(crossUserExport.status, 404);

  const crossUserLegacy = await request(
    `/api/arrangements/${arrangementId}/export`,
    otherSession,
    { method: "POST" },
  );
  assert.equal(crossUserLegacy.status, 404);

  const ownerLegacy = await request(
    `/api/arrangements/${arrangementId}/export`,
    ownerSession,
    { method: "POST" },
  );
  assert.equal(ownerLegacy.status, 307);
  assert.equal(
    ownerLegacy.headers.get("location"),
    `/api/projects/${projectId}/export?arrangementId=${arrangementId}`,
  );

  assert.equal(
    (await request(`/api/exports/${exportId}/download`, otherSession)).status,
    404,
  );
  assert.equal(
    (await request("/api/storage/objects/exports/private-test.zip", null)).status,
    401,
  );
  assert.equal(
    (await request("/api/storage/objects/exports/private-test.zip", otherSession)).status,
    404,
  );

  const traversalSource = await request(
    `/api/projects/${projectId}/sources`,
    ownerSession,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objectPath: "/objects/uploads/../../exports/private-test.zip",
        name: "unsafe.wav",
        size: 128,
        contentType: "audio/wav",
        sourceType: "FULL_SONG",
      }),
    },
  );
  assert.equal(traversalSource.status, 400);

  const pendingUploadPath = `/objects/uploads/00000000-0000-4000-8000-${String(process.pid).padStart(12, "0")}`;
  await db.insert(projectUploadReservationsTable).values({
    objectPath: pendingUploadPath,
    projectId,
    ownerId: `export-owner-${process.pid}`,
    contentType: "audio/wav",
    size: 128,
    expiresAt: new Date(Date.now() + 15 * 60_000),
  });

  const crossUserDelete = await request(
    `/api/projects/${projectId}`,
    otherSession,
    { method: "DELETE" },
  );
  assert.equal(crossUserDelete.status, 404);
  const [projectAfterCrossUserDelete] = await db
    .select({ id: musicProjectsTable.id })
    .from(musicProjectsTable)
    .where(eq(musicProjectsTable.id, projectId));
  assert.equal(projectAfterCrossUserDelete.id, projectId);

  const ownerDelete = await request(
    `/api/projects/${projectId}`,
    ownerSession,
    { method: "DELETE" },
  );
  assert.ok([200, 202].includes(ownerDelete.status));
  const deletion = await ownerDelete.json();
  assert.equal(deletion.projectId, projectId);
  assert.ok(["completed", "partial"].includes(deletion.status));

  const [deletedProject, deletedArrangement, deletedArtifact] = await Promise.all([
    db.select({ id: musicProjectsTable.id })
      .from(musicProjectsTable)
      .where(eq(musicProjectsTable.id, projectId)),
    db.select({ id: arrangementsTable.id })
      .from(arrangementsTable)
      .where(eq(arrangementsTable.id, arrangementId)),
    db.select({ id: musicArtifactsTable.id })
      .from(musicArtifactsTable)
      .where(eq(musicArtifactsTable.id, exportId)),
  ]);
  assert.equal(deletedProject.length, 0);
  assert.equal(deletedArrangement.length, 0);
  assert.equal(deletedArtifact.length, 0);
  assert.equal(await loadExportZip(exportStorageObjectId), null);
  assert.equal(await loadExportZip(legacyExportStorageObjectId), null);
  assert.equal(
    (await request(
      `/api/storage/uploads/${pendingUploadPath.split("/").at(-1)}`,
      ownerSession,
      {
        method: "PUT",
        headers: { "Content-Type": "audio/wav" },
        body: "x".repeat(128),
      },
    )).status,
    404,
  );

  assert.equal(
    (await request(`/api/project-deletions/${deletion.id}`, ownerSession)).status,
    200,
  );
  assert.equal(
    (await request(`/api/project-deletions/${deletion.id}`, otherSession)).status,
    404,
  );
  const [cleanupJob] = await db
    .select()
    .from(projectCleanupJobsTable)
    .where(eq(projectCleanupJobsTable.id, deletion.id));
  assert.equal(cleanupJob.ownerId, `export-owner-${process.pid}`);

  const staleCleanupId = `stale-cleanup-${process.pid}`;
  await db.insert(projectCleanupJobsTable).values({
    id: staleCleanupId,
    projectId,
    ownerId: `export-owner-${process.pid}`,
    status: "running",
    objectPaths: [],
    analysisJobIds: [],
    attempts: 1,
    leaseId: "expired-worker",
    leaseExpiresAt: new Date(Date.now() - 60_000),
  });
  const reclaimedCleanup = await request(
    `/api/project-deletions/${staleCleanupId}/retry`,
    ownerSession,
    { method: "POST" },
  );
  assert.equal(reclaimedCleanup.status, 200);
  assert.equal((await reclaimedCleanup.json()).status, "completed");
  const [reclaimedJob] = await db
    .select()
    .from(projectCleanupJobsTable)
    .where(eq(projectCleanupJobsTable.id, staleCleanupId));
  assert.equal(reclaimedJob.attempts, 2);
  assert.equal(reclaimedJob.leaseId, null);
});

test("authenticated provider catalog requests return a schema-valid MusicGen entry", async () => {
  const response = await request("/api/music-providers", ownerSession);
  assert.equal(response.status, 200);

  const providers = ListGenerationProvidersResponse.parse(await response.json());
  const musicGen = providers.find((provider) => provider.id === "MUSICGEN");
  assert.ok(musicGen);
});
