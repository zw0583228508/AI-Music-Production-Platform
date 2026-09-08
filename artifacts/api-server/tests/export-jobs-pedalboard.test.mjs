import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { access, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const apiDirectory = new URL("..", import.meta.url).pathname;
const harnessPath = `/tmp/export-jobs-pedalboard-${process.pid}.mjs`;
process.env.NODE_ENV = "production";
await build({
  stdin: {
    contents: `
      export { reclaimTerminalExportJobObjects, runExportProductionJob } from "./src/lib/exportJobs";
      export { queueProductionJob, retryProductionJob } from "./src/lib/productionJobs";
      export { createStyleSpec } from "./src/lib/musicEngines";
      export { deleteExportObject, getPrivateObject, saveExportObject } from "./src/lib/objectStorage";
      export {
        arrangementsTable,
        db,
        musicArtifactsTable,
        musicProjectsTable,
        productionJobsTable,
        projectSourcesTable,
        songModelsTable,
        tracksTable,
      } from "@workspace/db";
      export { eq, sql } from "drizzle-orm";
    `,
    resolveDir: apiDirectory,
    sourcefile: "export-jobs-pedalboard-harness.ts",
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
  createStyleSpec,
  db,
  deleteExportObject,
  eq,
  getPrivateObject,
  musicArtifactsTable,
  musicProjectsTable,
  productionJobsTable,
  projectSourcesTable,
  queueProductionJob,
  reclaimTerminalExportJobObjects,
  retryProductionJob,
  runExportProductionJob,
  saveExportObject,
  songModelsTable,
  sql,
  tracksTable,
} = await import(pathToFileURL(harnessPath).href);

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForPath(path) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await pathExists(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

const ids = {
  project: `pedalboard-export-project-${process.pid}`,
  source: `pedalboard-export-source-${process.pid}`,
  songModel: `pedalboard-export-song-model-${process.pid}`,
  arrangement: `pedalboard-export-arrangement-${process.pid}`,
  track: `pedalboard-export-track-${process.pid}`,
  planArtifact: `pedalboard-export-plan-${process.pid}`,
  trackArtifact: `pedalboard-export-track-artifact-${process.pid}`,
   providerArrangement: `pedalboard-provider-arrangement-${process.pid}`,
   providerAudio: `pedalboard-provider-audio-${process.pid}`,
   providerPlanArtifact: `pedalboard-provider-plan-${process.pid}`,
};
const ownerId = `pedalboard-export-owner-${process.pid}`;
const workerToken = `pedalboard-export-token-${process.pid}`;
const workerVersion = "pedalboard-test-0.9.19";
const publicationFailureTrigger = `test_export_publication_${process.pid}`;
let workerServer;
let workerMode = "valid";
let authenticatedRequests = 0;
const processedPairs = [];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function openStoredZip(zip) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(offset + 8), 0, "test expects stored ZIP entries");
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = zip.toString("utf8", nameStart, nameStart + nameLength);
    entries.set(name, zip.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}

function waitForListen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function processWav(input) {
  const output = Buffer.from(input);
  const sample = output.readInt16LE(44);
  output.writeInt16LE(sample === 32_767 ? 32_766 : sample + 1, 44);
  processedPairs.push({ input: Buffer.from(input), output: Buffer.from(output) });
  return output;
}

const provenance = {
  model: "TEST",
  version: "1",
  parameters: {},
  parentIds: [],
  createdBy: "test",
};
const instrumentDefinition = {
  id: "piano",
  family: "keys",
  playableRange: { min: 21, max: 108 },
  comfortableRange: { min: 36, max: 96 },
  registers: [{ name: "full", min: 21, max: 108, character: "balanced" }],
  polyphonic: true,
  maxVoices: 10,
  articulations: ["sustain"],
  constraints: { maxLeap: 24, minNoteDuration: 0.05, maxSimultaneousNotes: 10 },
  controls: { dynamics: [1], expression: [11], sustain: 64, pitchBend: false, aftertouch: true },
};
const trackModel = {
  id: ids.track,
  instrument: "piano",
  instrumentDefinition,
  role: "harmony",
  notes: [{ id: "note-1", start: 0, duration: 1, pitch: 60, velocity: 96 }],
  cc: [],
  articulations: [],
  automation: [],
  source: "PERFORMANCE_ENGINE",
  version: 1,
  provenance,
};
const styleSpec = createStyleSpec("pop", {
  energy: 0.6,
  density: 0.5,
  harmonyComplexity: 4,
});
const plan = {
  id: "pedalboard-plan",
  version: 1,
  sections: [{
    section: "Verse",
    startBar: 1,
    endBar: 2,
    energy: 0.6,
    density: 0.5,
    tracks: { Piano: "main_harmony" },
    activeTracks: [ids.track],
    operations: ["phrase"],
  }],
  style: styleSpec,
  songModelVersion: 1,
  parameters: {},
  provenance,
};
const songModel = {
  audio: {
    name: "source.wav",
    contentType: "audio/wav",
    size: 1,
    durationSeconds: 2,
    sampleRate: 44_100,
    channels: 2,
  },
  tempoMap: [{ time: 0, bpm: 120, confidence: 1 }],
  meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
  keyMap: [{ time: 0, key: "C major", confidence: 1 }],
  melody: [],
  chords: [],
  sections: [{ name: "Verse", startBar: 1, endBar: 2, energy: 0.6 }],
  energy: [0.6],
  beats: [],
  bars: [],
  dynamics: [],
  waveform: [],
  stems: [],
  sourceStems: [],
  lyrics: [],
  providers: ["TEST"],
  confidenceByField: {},
  provenance: [],
};

async function allocateExport(suffix, options = {}) {
  const exportId = `pedalboard-export-${suffix}-${process.pid}`;
  await db.insert(musicArtifactsTable).values({
    id: exportId,
    projectId: ids.project,
    type: "EXPORT",
    label: `${suffix} export`,
    version: 1,
    size: "Queued",
    format: "ZIP",
    state: "rendering",
    parentIds: [],
    createdBy: "export-pipeline",
    modelVersion: "EXPORT_PIPELINE@1.0.0",
    parameters: { arrangementId: ids.arrangement },
    storageUri: `db://music_exports/${exportId}`,
    immutable: false,
  });
  const { job } = await queueProductionJob({
    projectId: ids.project,
    ownerId,
    kind: "export",
    idempotencyKey: `pedalboard-${suffix}-${process.pid}`,
    inputSnapshot: {
      exportId,
      version: 1,
      arrangementId: ids.arrangement,
      includeStems: false,
      includeMidi: false,
      includeMix: true,
      includeMetadata: true,
      processingProvider: "PEDALBOARD_BUILTIN",
      ...options,
    },
    requiredCapabilities: ["export"],
    resourcePool: "STUDIO_RENDER",
    estimatedCostUnits: 100,
  });
  return { exportId, jobId: job.id };
}

async function allocateProviderExport(suffix, options = {}) {
  const exportId = `pedalboard-provider-export-${suffix}-${process.pid}`;
  await db.insert(musicArtifactsTable).values({
    id: exportId,
    projectId: ids.project,
    type: "EXPORT",
    label: `${suffix} provider export`,
    version: 1,
    size: "Queued",
    format: "ZIP",
    state: "rendering",
    parentIds: [],
    createdBy: "export-pipeline",
    modelVersion: "EXPORT_PIPELINE@1.0.0",
    parameters: { arrangementId: ids.providerArrangement },
    storageUri: `db://music_exports/${exportId}`,
    immutable: false,
  });
  const { job } = await queueProductionJob({
    projectId: ids.project,
    ownerId,
    kind: "export",
    idempotencyKey: `pedalboard-provider-${suffix}-${process.pid}`,
    inputSnapshot: {
      exportId,
      version: 1,
      arrangementId: ids.providerArrangement,
      includeStems: false,
      includeMidi: false,
      includeMix: true,
      includeMetadata: true,
      processingProvider: "PEDALBOARD_BUILTIN",
      ...options,
    },
    requiredCapabilities: ["export"],
    resourcePool: "STUDIO_RENDER",
    estimatedCostUnits: 100,
  });
  return { exportId, jobId: job.id };
}

async function artifact(id) {
  const [row] = await db.select().from(musicArtifactsTable)
    .where(eq(musicArtifactsTable.id, id));
  return row;
}

async function productionJob(id) {
  const [row] = await db.select().from(productionJobsTable)
    .where(eq(productionJobsTable.id, id));
  return row;
}

async function installPublicationFailure() {
  await db.execute(sql.raw(`
    create or replace function ${publicationFailureTrigger}_fn()
    returns trigger language plpgsql as $$
    begin
      if new.id like 'pedalboard-export-cleanup-%' and new.state = 'ready' then
        raise exception 'forced export publication failure';
      end if;
      return new;
    end;
    $$;
    drop trigger if exists ${publicationFailureTrigger} on music_artifacts;
    create trigger ${publicationFailureTrigger}
      before update on music_artifacts
      for each row execute function ${publicationFailureTrigger}_fn();
  `));
}

async function removePublicationFailure() {
  await db.execute(sql.raw(`
    drop trigger if exists ${publicationFailureTrigger} on music_artifacts;
    drop function if exists ${publicationFailureTrigger}_fn();
  `));
}

before(async () => {
  workerServer = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${workerToken}`) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    authenticatedRequests += 1;
    if (request.method === "GET" && request.url?.startsWith("/health")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        status: "ok",
        healthy: true,
        runtimeReady: true,
        packageReady: true,
        checkpointReady: true,
        smokeTested: true,
        provider: "PEDALBOARD_BUILTIN",
        modelVersion: workerVersion,
      }));
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = Buffer.from(JSON.parse(body).audio_base64, "base64");
      const output = processWav(input);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        provider: "PEDALBOARD_BUILTIN",
        version: workerMode === "invalid-evidence" ? "wrong-version" : workerVersion,
        format: "wav",
        encoding: "pcm_s16le",
        audio_base64: output.toString("base64"),
      }));
    });
  });
  await waitForListen(workerServer);
  const address = workerServer.address();
  process.env.MUSIC_AI_WORKER_URL = `http://127.0.0.1:${address.port}`;
  process.env.MUSIC_AI_WORKER_TOKEN = workerToken;

  await db.insert(musicProjectsTable).values({
    id: ids.project,
    name: "Pedalboard queued export",
    sourceType: "PROMPT",
    ownerId,
    status: "ready",
    duration: "0:02",
    key: "C major",
    bpm: 120,
    meter: "4/4",
    confidence: 1,
    sections: songModel.sections,
    energy: [0.6],
    providers: ["TEST"],
  });
  await db.insert(projectSourcesTable).values({
    id: ids.source,
    projectId: ids.project,
    ownerId,
    objectPath: `/objects/uploads/00000000-0000-4000-8000-${String(process.pid).padStart(12, "0").slice(-12)}`,
    name: "source.wav",
    size: 1,
    contentType: "audio/wav",
    sourceType: "PROMPT",
    status: "ready",
  });
  await db.insert(songModelsTable).values({
    id: ids.songModel,
    projectId: ids.project,
    sourceId: ids.source,
    version: 1,
    model: songModel,
    providers: ["TEST"],
    confidence: 1,
  });
  await db.insert(arrangementsTable).values({
    id: ids.arrangement,
    projectId: ids.project,
    name: "Pedalboard arrangement",
    style: "pop",
    mode: "STUDIO",
    status: "ready",
    harmonyComplexity: 4,
    energy: 0.6,
    density: 0.5,
    sections: [{
      name: "Verse",
      startBar: 1,
      endBar: 2,
      energy: 0.6,
      density: 0.5,
      tracks: ["Piano"],
    }],
    styleSpec,
    plan,
    trackModels: [trackModel],
    songModelVersion: 1,
    provenance,
  });
  await db.insert(tracksTable).values({
    id: ids.track,
    projectId: ids.project,
    name: "Piano",
    role: "harmony",
    kind: "midi",
    color: "#3366ff",
    status: "generated",
    trackModel,
    instrumentDefinition,
    provenance,
  });
  await db.insert(musicArtifactsTable).values([
    {
      id: ids.planArtifact,
      projectId: ids.project,
      type: "ARRANGEMENT_PLAN",
      label: "Plan",
      size: "DB",
      format: "JSON",
      storageUri: `db://music_arrangements/${ids.arrangement}`,
      parentIds: [],
    },
    {
      id: ids.trackArtifact,
      projectId: ids.project,
      type: "TRACK_MODEL",
      label: "Piano model",
      size: "DB",
      format: "JSON",
      storageUri: `db://music_arrangements/${ids.arrangement}/tracks/${ids.track}`,
      parameters: { trackId: ids.track },
      parentIds: [ids.planArtifact],
    },
  ]);

  const providerWav = Buffer.alloc(48);
  providerWav.write("RIFF", 0, "ascii");
  providerWav.writeUInt32LE(providerWav.length - 8, 4);
  providerWav.write("WAVE", 8, "ascii");
  providerWav.write("fmt ", 12, "ascii");
  providerWav.writeUInt32LE(16, 16);
  providerWav.writeUInt16LE(1, 20);
  providerWav.writeUInt16LE(1, 22);
  providerWav.writeUInt32LE(44_100, 24);
  providerWav.writeUInt32LE(88_200, 28);
  providerWav.writeUInt16LE(2, 32);
  providerWav.writeUInt16LE(16, 34);
  providerWav.write("data", 36, "ascii");
  providerWav.writeUInt32LE(4, 40);
  providerWav.writeInt16LE(1234, 44);
  const providerStorageUri = await saveExportObject(
    `generation/pedalboard-test-${process.pid}/provider/render.wav`,
    providerWav,
    "audio/wav",
  );
  await db.insert(arrangementsTable).values({
    id: ids.providerArrangement,
    projectId: ids.project,
    name: "Provider audio arrangement",
    style: "pop",
    mode: "STUDIO",
    status: "ready",
    harmonyComplexity: 4,
    energy: 0.6,
    density: 0.5,
    sections: [{
      name: "Verse",
      startBar: 1,
      endBar: 2,
      energy: 0.6,
      density: 0.5,
      tracks: [],
    }],
    styleSpec,
    plan,
    trackModels: [],
    songModelVersion: 1,
    generationProvider: "TEST_PROVIDER",
    modelVersion: "provider-model-1",
    generationProvenance: {
      provider: "TEST_PROVIDER",
      modelVersion: "provider-model-1",
      reportedModelVersion: "provider-model-1",
      candidateId: "provider-candidate-1",
      providerRequestId: "provider-request-1",
      seed: 42,
      parentArtifactIds: [ids.planArtifact],
      evaluation: {
        status: "evaluated",
        providerScore: 0.9,
        renderArtifactIds: [ids.providerAudio],
        artifacts: [{
          id: ids.providerAudio,
          type: "AUDIO_TRACK",
          label: "Provider audio",
          url: providerStorageUri,
        }],
        qualityReport: null,
        error: null,
      },
    },
    provenance,
  });
  await db.insert(musicArtifactsTable).values([
    {
      id: ids.providerPlanArtifact,
      projectId: ids.project,
      type: "ARRANGEMENT_PLAN",
      label: "Provider plan",
      size: "DB",
      format: "JSON",
      storageUri: `db://music_arrangements/${ids.providerArrangement}`,
      parentIds: [ids.planArtifact],
    },
    {
      id: ids.providerAudio,
      projectId: ids.project,
      type: "AUDIO_TRACK",
      label: "Provider generated audio",
      version: 1,
      size: `${providerWav.length} B`,
      format: "WAV",
      storageUri: providerStorageUri,
      url: providerStorageUri,
      hash: sha256(providerWav),
      checksum: sha256(providerWav),
      parentIds: [ids.providerPlanArtifact, ids.planArtifact],
      createdBy: "gpu-provider-output-ingest",
      modelVersion: "provider-model-1",
      provider: "TEST_PROVIDER",
    },
  ]);
});

after(async () => {
  await removePublicationFailure().catch(() => undefined);
  delete process.env.MUSIC_AI_WORKER_URL;
  delete process.env.MUSIC_AI_WORKER_TOKEN;
  const exports = await db.select().from(musicArtifactsTable)
    .where(eq(musicArtifactsTable.projectId, ids.project));
  await Promise.all(exports
    .filter((row) => row.type === "EXPORT" && row.storageUri?.startsWith("/api/storage/objects/exports/"))
    .map((row) => deleteExportObject(row.storageUri)));
  await db.delete(musicProjectsTable).where(eq(musicProjectsTable.id, ids.project));
  await new Promise((resolve) => workerServer.close(resolve));
  await unlink(harnessPath).catch(() => undefined);
});

test("queued export publishes processed WAV bytes with matching Pedalboard evidence", async () => {
  workerMode = "valid";
  processedPairs.length = 0;
  const { exportId, jobId } = await allocateExport("success");
  await runExportProductionJob(jobId);

  const [readyExport, completedJob] = await Promise.all([
    artifact(exportId),
    productionJob(jobId),
  ]);
  assert.equal(completedJob.status, "succeeded", JSON.stringify(completedJob.error));
  assert.equal(readyExport.state, "ready");
  assert.ok(authenticatedRequests >= 2);
  assert.ok(processedPairs.length >= 1);

  const object = await getPrivateObject(
    readyExport.storageUri.slice("/api/storage/objects/".length),
  );
  assert.ok(object, "published export ZIP must exist");
  const [zip] = await object.download();
  const entries = openStoredZip(zip);
  const manifest = JSON.parse(entries.get("metadata/export-manifest.json").toString());
  const processedFileNames = Object.keys(manifest.processingEvidence);
  const processedFileName = processedFileNames.find((name) => name.startsWith("mix/"));
  assert.ok(processedFileName, "export manifest must identify a processed final mix");
  const shippedWav = entries.get(processedFileName);
  assert.ok(shippedWav);
  const shippedPair = processedPairs.find(({ output }) => output.equals(shippedWav));
  assert.ok(shippedPair, "shipped master must be one of the authenticated worker outputs");
  assert.notDeepEqual(shippedWav, shippedPair.input);

  const evidence = {
    provider: "PEDALBOARD_BUILTIN",
    version: workerVersion,
    inputSha256: sha256(shippedPair.input),
    outputSha256: sha256(shippedPair.output),
  };
  const projectManifest = JSON.parse(entries.get("project/manifest.json").toString());
  assert.deepEqual(
    {
      provider: manifest.processingEvidence[processedFileName].provider,
      version: manifest.processingEvidence[processedFileName].version,
      inputSha256: manifest.processingEvidence[processedFileName].inputSha256,
      outputSha256: manifest.processingEvidence[processedFileName].outputSha256,
    },
    evidence,
  );
  assert.deepEqual(projectManifest.processingEvidence, manifest.processingEvidence);

  const rows = await db.select().from(musicArtifactsTable)
    .where(eq(musicArtifactsTable.projectId, ids.project));
  assert.equal(processedFileNames.length, processedPairs.length);
  for (const fileName of processedFileNames) {
    const fileEvidence = manifest.processingEvidence[fileName];
    const shipped = entries.get(fileName);
    const pair = processedPairs.find(({ output }) => output.equals(shipped));
    assert.ok(pair, `${fileName} must contain authenticated worker output`);
    assert.equal(fileEvidence.provider, "PEDALBOARD_BUILTIN");
    assert.equal(fileEvidence.version, workerVersion);
    assert.equal(fileEvidence.inputSha256, sha256(pair.input));
    assert.equal(fileEvidence.outputSha256, sha256(pair.output));
    const wavArtifact = rows.find((row) =>
      row.parameters.exportId === exportId && row.label === fileName);
    assert.ok(wavArtifact);
    assert.equal(wavArtifact.hash, fileEvidence.outputSha256);
    assert.equal(wavArtifact.checksum, fileEvidence.outputSha256);
    assert.equal(wavArtifact.technicalMetadata.processingProvider, fileEvidence.provider);
    assert.equal(wavArtifact.technicalMetadata.processingVersion, fileEvidence.version);
    assert.equal(wavArtifact.technicalMetadata.processingInputSha256, fileEvidence.inputSha256);
    assert.equal(wavArtifact.technicalMetadata.processingOutputSha256, fileEvidence.outputSha256);
  }
});

test("all master profiles and export options preserve evidence only on shipped final WAVs", async () => {
  workerMode = "valid";
  const profiles = ["STREAMING", "DYNAMIC", "CLASSICAL", "POP", "LOUD", "FILM"];
  for (const [index, masterProfile] of profiles.entries()) {
    processedPairs.length = 0;
    const includeMetadata = index % 2 === 0;
    const includeStems = index % 3 !== 0;
    const includeMidi = index % 2 !== 0;
    const { exportId, jobId } = await allocateExport(`matrix-${masterProfile.toLowerCase()}`, {
      masterProfile,
      includeMetadata,
      includeStems,
      includeMidi,
    });
    await runExportProductionJob(jobId);

    const readyExport = await artifact(exportId);
    assert.equal(readyExport.state, "ready", `${masterProfile} export must succeed`);
    const object = await getPrivateObject(
      readyExport.storageUri.slice("/api/storage/objects/".length),
    );
    assert.ok(object);
    const [zip] = await object.download();
    const entries = openStoredZip(zip);
    const manifest = JSON.parse(entries.get("metadata/export-manifest.json").toString());
    const evidenceNames = Object.keys(manifest.processingEvidence).sort();
    const shippedFinalWavs = manifest.files
      .filter((file) => ["MIX", "MASTER"].includes(file.type) && file.format === "WAV")
      .map((file) => file.name)
      .sort();
    assert.deepEqual(evidenceNames, shippedFinalWavs);
    assert.equal(
      entries.has("project/manifest.json"),
      includeMetadata,
      "metadata option must only control the optional project manifest",
    );

    const rows = await db.select().from(musicArtifactsTable)
      .where(eq(musicArtifactsTable.projectId, ids.project));
    for (const fileName of evidenceNames) {
      const shipped = entries.get(fileName);
      const evidence = manifest.processingEvidence[fileName];
      const pair = processedPairs.find(({ output }) => output.equals(shipped));
      assert.ok(pair, `${masterProfile} ${fileName} must ship authenticated processed bytes`);
      assert.equal(evidence.inputSha256, sha256(pair.input));
      assert.equal(evidence.outputSha256, sha256(shipped));
      const row = rows.find((candidate) =>
        candidate.parameters.exportId === exportId && candidate.label === fileName);
      assert.ok(row);
      assert.equal(row.hash, evidence.outputSha256);
      assert.equal(row.checksum, evidence.outputSha256);
      assert.equal(row.technicalMetadata.processingOutputSha256, evidence.outputSha256);
    }
    for (const stem of manifest.files.filter((file) => file.type === "STEM")) {
      assert.equal(manifest.processingEvidence[stem.name], undefined);
      const row = rows.find((candidate) =>
        candidate.parameters.exportId === exportId && candidate.label === stem.name);
      assert.ok(row);
      assert.equal(row.technicalMetadata.processingProvider, undefined);
      assert.equal(
        processedPairs.some(({ output }) => output.equals(entries.get(stem.name))),
        false,
        `${stem.name} must remain remixable and unprocessed`,
      );
    }
    assert.deepEqual(
      JSON.parse(readyExport.technicalMetadata.processingEvidence),
      manifest.processingEvidence,
    );
  }
});

test("processing cannot publish contradictory evidence when final mixes are excluded", async () => {
  workerMode = "valid";
  const { exportId, jobId } = await allocateExport("no-final-mix", {
    includeMix: false,
    includeStems: true,
    includeMidi: true,
    includeMetadata: false,
  });
  await runExportProductionJob(jobId);
  const [failedExport, failedJob] = await Promise.all([
    artifact(exportId),
    productionJob(jobId),
  ]);
  assert.equal(failedJob.status, "failed");
  assert.equal(failedExport.state, "failed");
  const children = await db.select().from(musicArtifactsTable)
    .where(eq(musicArtifactsTable.projectId, ids.project));
  assert.equal(children.some((row) => row.parameters.exportId === exportId), false);
});

test("provider-only export preserves source lineage and matches mastered byte evidence", async () => {
  workerMode = "valid";
  processedPairs.length = 0;
  const { exportId, jobId } = await allocateProviderExport("success");
  await runExportProductionJob(jobId);

  const readyExport = await artifact(exportId);
  assert.equal(readyExport.state, "ready");
  const object = await getPrivateObject(
    readyExport.storageUri.slice("/api/storage/objects/".length),
  );
  assert.ok(object);
  const [zip] = await object.download();
  const entries = openStoredZip(zip);
  const manifest = JSON.parse(entries.get("metadata/export-manifest.json").toString());
  const fileName = "mix/generated-accompaniment.wav";
  const shipped = entries.get(fileName);
  const evidence = manifest.processingEvidence[fileName];
  const pair = processedPairs.find(({ output }) => output.equals(shipped));
  assert.ok(pair, "provider final audio must ship authenticated mastered bytes");
  assert.equal(evidence.inputSha256, sha256(pair.input));
  assert.equal(evidence.outputSha256, sha256(shipped));
  assert.equal(manifest.generation.provider, "TEST_PROVIDER");
  assert.equal(manifest.generation.modelVersion, "provider-model-1");
  assert.equal(manifest.generation.candidateId, "provider-candidate-1");
  assert.deepEqual(
    manifest.artifactGraph.find((entry) => entry.file === fileName).parentIds,
    [ids.providerAudio],
  );

  const rows = await db.select().from(musicArtifactsTable)
    .where(eq(musicArtifactsTable.projectId, ids.project));
  const wavArtifact = rows.find((row) =>
    row.parameters.exportId === exportId && row.label === fileName);
  assert.ok(wavArtifact);
  assert.equal(wavArtifact.hash, sha256(shipped));
  assert.equal(wavArtifact.checksum, sha256(shipped));
  assert.equal(wavArtifact.provider, "TEST_PROVIDER");
  assert.deepEqual(wavArtifact.parentIds, [ids.providerAudio]);
  assert.equal(wavArtifact.technicalMetadata.processingInputSha256, sha256(pair.input));
  assert.equal(wavArtifact.technicalMetadata.processingOutputSha256, sha256(shipped));
});

test("provider-only export cannot publish processing evidence when mix is excluded", async () => {
  workerMode = "valid";
  const { exportId, jobId } = await allocateProviderExport("no-final-mix", {
    includeMix: false,
    includeMetadata: false,
  });
  await runExportProductionJob(jobId);
  const [failedExport, failedJob] = await Promise.all([
    artifact(exportId),
    productionJob(jobId),
  ]);
  assert.equal(failedJob.status, "failed");
  assert.equal(failedExport.state, "failed");
  const children = await db.select().from(musicArtifactsTable)
    .where(eq(musicArtifactsTable.projectId, ids.project));
  assert.equal(children.some((row) => row.parameters.exportId === exportId), false);
});

test("invalid worker evidence leaves no ready export or published output", async () => {
  workerMode = "invalid-evidence";
  const { exportId, jobId } = await allocateExport("invalid-evidence");
  await runExportProductionJob(jobId);

  const [failedExport, failedJob] = await Promise.all([
    artifact(exportId),
    productionJob(jobId),
  ]);
  assert.equal(failedJob.status, "failed");
  assert.equal(
    failedJob.retryable,
    false,
    "known permanent export failures must preserve structured retryability",
  );
  assert.equal(failedJob.error.retryable, false);
  assert.equal(failedExport.state, "failed");
  assert.equal(failedExport.storageUri, `db://music_exports/${exportId}`);
  const children = await db.select().from(musicArtifactsTable)
    .where(eq(musicArtifactsTable.projectId, ids.project));
  assert.equal(children.some((row) => row.parameters.exportId === exportId), false);
});

test("database publication failure removes the uploaded ZIP and rolls back evidence rows", async () => {
  workerMode = "valid";
  const { exportId, jobId } = await allocateExport("cleanup");
  const originalFetch = globalThis.fetch;
  let uploadedZip;
  globalThis.fetch = async (url, options) => {
    if (options?.method === "PUT" && options.body) {
      uploadedZip = Buffer.from(options.body);
    }
    return originalFetch(url, options);
  };
  await installPublicationFailure();
  try {
    await runExportProductionJob(jobId);
  } finally {
    globalThis.fetch = originalFetch;
    await removePublicationFailure();
  }

  const [failedExport, failedJob] = await Promise.all([
    artifact(exportId),
    productionJob(jobId),
  ]);
  assert.equal(failedJob.status, "failed");
  assert.equal(failedExport.state, "failed");
  const children = await db.select().from(musicArtifactsTable)
    .where(eq(musicArtifactsTable.projectId, ids.project));
  assert.equal(children.some((row) => row.parameters.exportId === exportId), false);
  assert.ok(uploadedZip, "fixture must fail after uploading the incomplete ZIP");
  const incompleteObject = await getPrivateObject(
    `exports/${exportId}-${sha256(uploadedZip)}.zip`,
  );
  assert.equal(incompleteObject, null, "incomplete uploaded ZIP must be deleted");
});

test("terminal cleanup cannot delete the package produced by a concurrent retry", async () => {
  workerMode = "valid";
  const { exportId, jobId } = await allocateExport("cleanup-retry-race");
  await db.update(productionJobsTable).set({
    status: "failed",
    stage: "worker_interrupted",
    retryable: true,
    attempt: 1,
    leaseExpiresAt: null,
  }).where(eq(productionJobsTable.id, jobId));
  await db.update(musicArtifactsTable).set({
    state: "failed",
    size: "Failed",
  }).where(eq(musicArtifactsTable.id, exportId));

  const orphanBytes = Buffer.from("crashed-worker-incomplete-zip");
  const orphanRelativePath = `${exportId}-${sha256(orphanBytes)}.zip`;
  const orphanUri = await saveExportObject(
    orphanRelativePath,
    orphanBytes,
    "application/zip",
  );
  const gateDirectory = await mkdtemp(join(tmpdir(), "export-reclaim-race-"));
  const safeExportId = exportId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const gateBase = join(gateDirectory, `gate-export-reclaim-${safeExportId}`);
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  process.env.TEST_PROJECT_STORAGE_RACE_DIR = gateDirectory;
  await writeFile(`${gateBase}.enabled`, "");
  try {
    const cleanup = reclaimTerminalExportJobObjects(jobId);
    await waitForPath(`${gateBase}.entered`);
    let retrySettled = false;
    const retry = retryProductionJob(jobId, ownerId).finally(() => {
      retrySettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      retrySettled,
      false,
      "retry must wait for terminal reclamation's project lock",
    );
    await writeFile(`${gateBase}.release`, "");
    assert.deepEqual(await cleanup, {
      discovered: 1,
      reclaimed: 1,
      preservedReady: 0,
      failedDeletions: 0,
      reclaimedStorageUris: [orphanUri],
    });
    const retried = await retry;
    assert.equal(retried?.status, "queued");
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    delete process.env.TEST_PROJECT_STORAGE_RACE_DIR;
    await rm(gateDirectory, { recursive: true, force: true });
  }

  assert.equal(
    await getPrivateObject(`exports/${orphanRelativePath}`),
    null,
    "the old crashed package must be reclaimed",
  );
  await runExportProductionJob(jobId);
  const [readyExport, completedJob] = await Promise.all([
    artifact(exportId),
    productionJob(jobId),
  ]);
  assert.equal(completedJob.status, "succeeded", JSON.stringify(completedJob.error));
  assert.equal(readyExport.state, "ready");
  const readyObject = await getPrivateObject(
    readyExport.storageUri.slice("/api/storage/objects/".length),
  );
  assert.ok(readyObject, "the concurrent retry's ready package must remain downloadable");
});