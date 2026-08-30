import assert from "node:assert/strict";
import test from "node:test";
import type { SongModelData } from "@workspace/db";
import { resolveExportSongModel } from "./exportLineage";

function model(version: number, bpm = 120): { version: number; model: SongModelData } {
  return {
    version,
    model: {
      contractVersion: "1.0",
      validation: { status: "accepted", issues: [] },
      fusion: { selectedProvider: null, confidence: 1, decisions: [] },
      audio: {
        name: "test.wav",
        contentType: "audio/wav",
        size: 1,
        durationSeconds: 4,
        sampleRate: 48_000,
        channels: 2,
        proxyObjectPath: null,
        proxyContentType: null,
        analysisStartSeconds: 0,
        analysisDurationSeconds: 4,
        analysisCoverage: "full",
      },
      analysisStartSeconds: 0,
      analysisDurationSeconds: 4,
      analysisCoverage: 1,
      beats: [],
      bars: [],
      dynamics: [],
      tempoMap: [{ time: 0, bpm, confidence: 1 }],
      meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
      keyMap: [{ time: 0, key: version === 1 ? "C major" : "D major", confidence: 1 }],
      melody: [],
      chords: [],
      sections: [],
      energy: [],
      waveform: [],
      stems: [],
      sourceStems: [],
      lyrics: [],
      confidenceByField: {},
      providerProvenance: [],
    },
  };
}

test("resolves only the arrangement's exact Song Model version", () => {
  const resolved = resolveExportSongModel([model(2, 132), model(1, 96)], 1);
  assert.equal(resolved.songModel.version, 1);
  assert.equal(resolved.bpm, 96);
  assert.equal(resolved.key, "C major");
  assert.equal(resolved.meter, "4/4");
});

test("never falls back to the latest Song Model", () => {
  assert.throws(
    () => resolveExportSongModel([model(2)], 1),
    /Song Model version 1 is unavailable/,
  );
});