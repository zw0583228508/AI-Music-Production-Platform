import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const apiDirectory = new URL("..", import.meta.url).pathname;
const harnessPath = `/tmp/music-generation-recovery-${process.pid}.mjs`;
await build({
  stdin: {
    contents: `
      export {
        queueArrangementGeneration,
        selectGenerationCandidate,
        resumePendingGenerationJobs,
        startGenerationRecoveryScheduler,
      } from "./src/lib/arrangementGeneration";
      export {
        arrangementsTable,
        db,
        musicGenerationCandidatesTable,
        musicGenerationJobsTable,
        musicProjectsTable,
        tracksTable,
      } from "@workspace/db";
      export { eq } from "drizzle-orm";
    `,
    resolveDir: apiDirectory,
    sourcefile: "generation-recovery-harness.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: harnessPath,
  external: ["pg-native"],
  banner: {
    js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);`,
  },
});

const {
  arrangementsTable,
  db,
  eq,
  musicGenerationCandidatesTable,
  musicGenerationJobsTable,
  musicProjectsTable,
  tracksTable,
  queueArrangementGeneration,
  selectGenerationCandidate,
  startGenerationRecoveryScheduler,
} = await import(pathToFileURL(harnessPath).href);

const ids = {
  project: `generation-project-${process.pid}`,
  arrangement: `generation-arrangement-${process.pid}`,
  queuedArrangement: `queued-generation-arrangement-${process.pid}`,
  unhealthyArrangement: `unhealthy-generation-arrangement-${process.pid}`,
  duplicateArrangement: `duplicate-generation-arrangement-${process.pid}`,
  job: `generation-job-${process.pid}`,
};
let providerServer;
let stopRecovery;
let receivedIdempotencyKey;
const providerRequestCounts = new Map();
let healthMode = "ready";
let healthCheckCount = 0;

function waitForListen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function waitForCompletedJob(jobId) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const [job] = await db
      .select()
      .from(musicGenerationJobsTable)
      .where(eq(musicGenerationJobsTable.id, jobId));
    if (job?.status === "succeeded" || job?.status === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Recovered generation job did not complete");
}

before(async () => {
  providerServer = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/health")) {
      healthCheckCount += 1;
      if (healthMode === "ready-once" && healthCheckCount > 1) {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ message: "worker is restarting" }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        status: "ready",
        provider: "METEOR",
        checkpointReady: true,
        runtimeReady: true,
        gpuReady: true,
        smokeTested: true,
        modelVersion: "meteor",
        checkpointSha256: "b".repeat(64),
        revision: "meteor-test-r9",
        modalImageId: "im-MeteorRecovery9",
        sourceImageDigest: `sha256:${"c".repeat(64)}`,
        cudaVersion: "12.4",
        pytorchVersion: "2.5.1",
        gpu: "NVIDIA L4",
      }));
      return;
    }
    receivedIdempotencyKey = request.headers["idempotency-key"];
    providerRequestCounts.set(
      receivedIdempotencyKey,
      (providerRequestCounts.get(receivedIdempotencyKey) ?? 0) + 1,
    );
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        requestId: "mock-request-1",
        provider: "METEOR",
        modelVersion: "meteor",
        checkpointSha256: "b".repeat(64),
        smokeTested: true,
        revision: "meteor-test-r9",
        modalImageId: "im-MeteorRecovery9",
        sourceImageDigest: `sha256:${"c".repeat(64)}`,
        cudaVersion: "12.4",
        pytorchVersion: "2.5.1",
        gpu: "NVIDIA L4",
        candidates: [
          {
            label: "Second Choice",
            score: 0.71,
            confidence: 0.79,
            summary: "A restrained provider arrangement.",
            trackModels: [],
            plan: {
              sections: [{ name: "Verse", energy: 0.5, density: 0.45, tracks: ["Piano"] }],
            },
          },
          {
            label: "Top Choice",
            score: 0.94,
            confidence: 0.91,
            summary: "A complete provider arrangement.",
            plan: {
              sections: [{ name: "Verse", energy: 0.72, density: 0.68, tracks: ["Bass"] }],
            },
          },
        ],
      }));
    });
  });
  await waitForListen(providerServer);
  const address = providerServer.address();
  process.env.MUSIC_PROVIDER_METEOR_URL =
    `http://127.0.0.1:${address.port}/generate`;
  process.env.MUSIC_PROVIDER_METEOR_CHECKPOINT_SHA256 = "b".repeat(64);
  process.env.MUSIC_PROVIDER_METEOR_MODAL_IMAGE_ID = "im-MeteorRecovery9";
  process.env.MUSIC_PROVIDER_METEOR_SOURCE_IMAGE_DIGEST =
    `sha256:${"c".repeat(64)}`;

  await db.insert(musicProjectsTable).values({
    id: ids.project,
    name: "Generation recovery test",
    sourceType: "PROMPT",
    ownerId: `generation-owner-${process.pid}`,
    status: "ready",
    bpm: 120,
    key: "C major",
    meter: "4/4",
    confidence: 0.9,
    sections: [{ name: "Verse", startBar: 1, endBar: 8, energy: 0.6 }],
    energy: [0.6],
    providers: ["TEST"],
  });
  await db.insert(arrangementsTable).values({
    id: ids.arrangement,
    projectId: ids.project,
    name: "Recovered arrangement",
    style: "orchestral",
    mode: "STUDIO",
    status: "generating",
    sections: [],
  });
  await db.insert(tracksTable).values({
    id: `generation-track-${process.pid}`,
    projectId: ids.project,
    name: "Piano",
    role: "harmony",
    kind: "midi",
    color: "#3366ff",
    status: "generated",
  });
  await db.insert(musicGenerationJobsTable).values({
    id: ids.job,
    projectId: ids.project,
    arrangementId: ids.arrangement,
    task: "ARRANGEMENT",
    status: "running",
    provider: "METEOR",
    modelVersion: "meteor",
    hardware: "AUTO",
    speed: "BALANCED",
    progress: 30,
    stage: "running_model",
    workerId: "dead-worker",
    heartbeatAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 75),
    requestedCandidates: 2,
    seed: 4242,
    parameters: { temperature: 0.4 },
    parentArtifactIds: [],
    inputSnapshot: {
      arrangement: {
        id: ids.arrangement,
        version: 1,
        style: "orchestral",
        mode: "STUDIO",
        status: "draft",
        harmonyComplexity: 5,
        energy: 0.6,
        density: 0.55,
        orchestraSize: 0.5,
        rhythmIntensity: 0.6,
      },
      songModel: {
        contractVersion: "1.0",
        validation: { status: "accepted", issues: [] },
        fusion: { selectedProvider: "TEST", confidence: 0.9, decisions: [] },
        audio: {
          name: "test.wav",
          contentType: "audio/wav",
          size: 1,
          durationSeconds: 16,
          sampleRate: 44100,
          channels: 2,
          proxyObjectPath: null,
          proxyContentType: null,
          analysisStartSeconds: 0,
          analysisDurationSeconds: 16,
          analysisCoverage: "full",
        },
        analysisStartSeconds: 0,
        analysisDurationSeconds: 16,
        analysisCoverage: 1,
        tempoMap: [{ time: 0, bpm: 120, confidence: 0.9 }],
        meterMap: [{ bar: 1, meter: "4/4", confidence: 0.9 }],
        keyMap: [{ time: 0, key: "C major", confidence: 0.9 }],
        melody: [],
        chords: [],
        sections: [{ name: "Verse", startBar: 1, endBar: 8, energy: 0.6 }],
        energy: [0.6],
        beats: [],
        bars: [],
        dynamics: [],
        waveform: [],
        stems: [],
        sourceStems: [],
        lyrics: [],
        providers: ["TEST"],
      },
      tracks: [{
        id: `generation-track-${process.pid}`,
        name: "Piano",
        role: "harmony",
        instrument: "Piano",
      }],
    },
  });
});

after(async () => {
  stopRecovery?.();
  delete process.env.MUSIC_PROVIDER_METEOR_URL;
  delete process.env.MUSIC_PROVIDER_METEOR_CHECKPOINT_SHA256;
  delete process.env.MUSIC_PROVIDER_METEOR_MODAL_IMAGE_ID;
  delete process.env.MUSIC_PROVIDER_METEOR_SOURCE_IMAGE_DIGEST;
  await db.delete(musicProjectsTable).where(eq(musicProjectsTable.id, ids.project));
  await new Promise((resolve) => providerServer.close(resolve));
  await unlink(harnessPath).catch(() => undefined);
});

test("recurring recovery reclaims a lease that expires after startup and persists ranked candidates", async () => {
  stopRecovery = startGenerationRecoveryScheduler(20);
  const job = await waitForCompletedJob(ids.job);
  assert.equal(job.status, "succeeded", job.error ?? "generation failed");
  assert.equal(receivedIdempotencyKey, ids.job);

  const candidates = await db
    .select()
    .from(musicGenerationCandidatesTable)
    .where(eq(musicGenerationCandidatesTable.jobId, ids.job))
    .orderBy(musicGenerationCandidatesTable.rank);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].label, "Second Choice");
  assert.equal(candidates[0].rank, 1);
  assert.equal(candidates[0].modelVersion, "meteor");
  assert.equal(candidates[0].reportedModelVersion, "meteor");
   assert.deepEqual(candidates.map((candidate) => candidate.seed).sort((a, b) => a - b), [4242, 4243]);
   assert.deepEqual(
     candidates.map((candidate) => candidate.evaluation.strategy?.name).sort(),
     ["balanced", "sparse"],
   );
  assert.equal(candidates[0].parameters.temperature, 0.4);
  assert.equal(candidates[0].parameters.providerScore, 0.71);
  assert.equal(candidates[0].evaluation.status, "evaluated");
  assert.ok(candidates[0].evaluation.qualityReport);
  assert.equal(candidates[0].evaluation.artifacts.length, 3);
  assert.ok(candidates[0].trackModels.length > 0);
  assert.deepEqual(
    Object.keys(candidates[0].evaluation.qualityReport.weights).sort(),
    ["clipping", "lineage", "notePlayability", "sectionCoverage", "silence", "timing"],
  );
  assert.equal(candidates[0].evaluation.qualityReport.strengths.length, 2);
  assert.equal(candidates[0].evaluation.qualityReport.weaknesses.length, 2);
  assert.ok(candidates[0].score > candidates[1].score);
  assert.equal(candidates[1].evaluation.status, "evaluated");

  await db
    .update(arrangementsTable)
    .set({
      style: "edited after evaluation",
      energy: 0.1,
      harmonyComplexity: 9,
    })
    .where(eq(arrangementsTable.id, ids.arrangement));
  const selected = await selectGenerationCandidate(
    candidates[0].id,
    `generation-owner-${process.pid}`,
  );
  assert.ok(selected);
  assert.equal(selected.style, "orchestral");
  assert.equal(selected.energy, 0.6);
  assert.equal(selected.harmonyComplexity, 5);
  assert.deepEqual(selected.plan, candidates[0].evaluatedPlan);
  assert.deepEqual(selected.styleSpec, candidates[0].evaluatedStyleSpec);
  assert.deepEqual(selected.trackModels, candidates[0].trackModels);
  assert.deepEqual(
    selected.generationProvenance.evaluation,
    candidates[0].evaluation,
  );

  await db.insert(arrangementsTable).values({
    id: ids.queuedArrangement,
    projectId: ids.project,
    name: "Normally queued arrangement",
    style: "orchestral",
    mode: "STUDIO",
    version: 2,
    sections: [],
  });
  const queued = await queueArrangementGeneration(
    ids.queuedArrangement,
    {
      candidates: 2,
      provider: "METEOR",
      task: "ARRANGEMENT",
      speed: "BALANCED",
      seed: 9191,
      parameters: { temperature: 0.7 },
    },
    `generation-owner-${process.pid}`,
  );
  assert.ok(queued);
  const completedQueued = await waitForCompletedJob(queued.id);
  assert.equal(completedQueued.status, "succeeded", completedQueued.error ?? "generation failed");
  assert.equal(completedQueued.provider, "METEOR");
  assert.equal(completedQueued.seed, 9191);
  assert.equal(receivedIdempotencyKey, queued.id);

  const queuedCandidates = await db
    .select()
    .from(musicGenerationCandidatesTable)
    .where(eq(musicGenerationCandidatesTable.jobId, queued.id))
    .orderBy(musicGenerationCandidatesTable.rank);
  assert.equal(queuedCandidates.length, 2);
  assert.equal(queuedCandidates[0].label, "Second Choice");
  assert.equal(queuedCandidates[0].rank, 1);
  assert.equal(queuedCandidates[0].parameters.temperature, 0.7);
  assert.equal(queuedCandidates[0].evaluation.status, "evaluated");
});

test("an unhealthy runtime replaces the queued health snapshot and retries under the lease", async () => {
  await db.insert(arrangementsTable).values({
    id: ids.unhealthyArrangement,
    projectId: ids.project,
    name: "Runtime loss arrangement",
    style: "orchestral",
    mode: "STUDIO",
    version: 3,
    sections: [],
  });
  healthMode = "ready-once";
  healthCheckCount = 0;
  const queued = await queueArrangementGeneration(
    ids.unhealthyArrangement,
    {
      candidates: 2,
      provider: "METEOR",
      task: "ARRANGEMENT",
      speed: "BALANCED",
      seed: 2222,
    },
    `generation-owner-${process.pid}`,
  );
  const failed = await waitForCompletedJob(queued.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "PROVIDER_RUNTIME_UNAVAILABLE");
  assert.equal(failed.providerRuntime.availability, "configured");
  assert.equal(failed.providerRuntime.healthStatus, "unhealthy");
  assert.match(failed.providerRuntime.message, /HTTP 503/);
  assert.equal(failed.attempt, failed.maxAttempts);
  healthMode = "ready";
});

test("competing incompatible idempotency requests dispatch only one paid generation", async () => {
  await db.insert(arrangementsTable).values({
    id: ids.duplicateArrangement,
    projectId: ids.project,
    name: "Idempotency fence arrangement",
    style: "orchestral",
    mode: "STUDIO",
    version: 4,
    sections: [],
  });
  const requestKey = `generation-conflict-${process.pid}`;
  const results = await Promise.allSettled([
    queueArrangementGeneration(
      ids.duplicateArrangement,
      {
        candidates: 1,
        provider: "METEOR",
        task: "ARRANGEMENT",
        speed: "BALANCED",
        seed: 101,
        parameters: { temperature: 0.2 },
        idempotencyKey: requestKey,
      },
      `generation-owner-${process.pid}`,
    ),
    queueArrangementGeneration(
      ids.duplicateArrangement,
      {
        candidates: 1,
        provider: "METEOR",
        task: "ARRANGEMENT",
        speed: "BALANCED",
        seed: 101,
        parameters: { temperature: 0.8 },
        idempotencyKey: requestKey,
      },
      `generation-owner-${process.pid}`,
    ),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /Idempotency key.*different generation input/);

  const job = await waitForCompletedJob(fulfilled[0].value.id);
  assert.equal(job.status, "succeeded", job.error ?? "generation failed");
  assert.equal(providerRequestCounts.get(job.id), 1);
});