import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  parseHarmony,
  parseSeparation,
  runAnalysisProviders,
} from "./analysisProviders";

test("parses valid harmony evidence and rejects out-of-range chords", () => {
  const result = parseHarmony({
    version: "1.2.0",
    confidence: 0.91,
    chords: [
      { start: 0, end: 2, symbol: "Cmaj7", roman: "Imaj7", confidence: 0.9 },
      { start: 2, end: 4, symbol: "Am7", roman: "vi7", confidence: 0.88 },
    ],
  }, 4);
  assert.equal(result.providerId, "SHEET_SAGE");
  assert.equal(result.chords.length, 2);
  assert.throws(() => parseHarmony({
    version: "1.2.0",
    confidence: 0.91,
    chords: [
      { start: 3, end: 5.1, symbol: "C", roman: "I", confidence: 0.9 },
    ],
  }, 4), /invalid/);
});

test("accepts unique private stem outputs and rejects duplicate output paths", () => {
  const result = parseSeparation({
    version: "2026.08",
    confidence: 0.93,
    stems: [
      {
        role: "vocals",
        objectPath: "/objects/analysis/job/vocals.wav",
        durationSeconds: 10,
        confidence: 0.94,
      },
      {
        role: "instrumental",
        objectPath: "/objects/analysis/job/instrumental.wav",
        durationSeconds: 10,
        confidence: 0.92,
      },
    ],
  }, 10);
  assert.equal(result.stems.length, 2);
  assert.throws(() => parseSeparation({
    version: "2026.08",
    confidence: 0.9,
    stems: [
      { role: "vocals", objectPath: "/objects/analysis/same.wav", confidence: 0.9 },
      { role: "drums", objectPath: "/objects/analysis/same.wav", confidence: 0.9 },
    ],
  }, 10), /duplicate/);
});

test("keeps absent providers explicit without fabricating analysis results", async () => {
  const keys = [
    "ALL_IN_ONE_API_URL",
    "MT3_API_URL",
    "BS_ROFORMER_API_URL",
    "SHEET_SAGE_API_URL",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    const result = await runAnalysisProviders({
      sourceUrl: null,
      sourceType: "FULL_SONG",
      durationSeconds: 60,
    });
    assert.equal(result.structure, null);
    assert.equal(result.transcription, null);
    assert.equal(result.separation, null);
    assert.equal(result.harmony, null);
    assert.deepEqual(
      new Set(result.provenance.map((item) => item.provider)),
      new Set(["ALL_IN_ONE", "MT3", "BS_ROFORMER", "SHEET_SAGE"]),
    );
    assert.ok(result.provenance.every((item) => item.status === "unavailable"));
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("polls an asynchronous provider job and returns its completed result", async () => {
  let polls = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "POST" && request.url === "/analyze") {
      response.writeHead(202);
      response.end(JSON.stringify({ jobId: "transcription-1", status: "queued" }));
      return;
    }
    if (request.method === "GET" && request.url === "/jobs/transcription-1") {
      polls += 1;
      response.writeHead(200);
      response.end(JSON.stringify({
        jobId: "transcription-1",
        status: "completed",
        result: {
          version: "async-1",
          confidence: 0.92,
          notes: [
            { start: 0, end: 0.5, pitch: 60, velocity: 96, confidence: 0.94 },
          ],
        },
      }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previousBasicPitch = process.env.BASIC_PITCH_API_URL;
  const previousSheetSage = process.env.SHEET_SAGE_API_URL;
  process.env.BASIC_PITCH_API_URL = `http://127.0.0.1:${address.port}`;
  delete process.env.SHEET_SAGE_API_URL;
  try {
    const result = await runAnalysisProviders({
      sourceUrl: "https://storage.invalid/signed-source",
      sourceType: "VOCAL_ONLY",
      durationSeconds: 10,
    });
    assert.equal(result.transcription?.providerId, "BASIC_PITCH");
    assert.equal(result.transcription?.notes[0]?.pitch, 60);
    assert.equal(polls, 1);
  } finally {
    if (previousBasicPitch === undefined) delete process.env.BASIC_PITCH_API_URL;
    else process.env.BASIC_PITCH_API_URL = previousBasicPitch;
    if (previousSheetSage === undefined) delete process.env.SHEET_SAGE_API_URL;
    else process.env.SHEET_SAGE_API_URL = previousSheetSage;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});