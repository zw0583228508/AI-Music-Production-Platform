import type { SongModelCore } from "@workspace/db";

export const validSongModel: SongModelCore = {
  audio: {
    name: "fixture.wav",
    contentType: "audio/wav",
    size: 1_024_000,
    durationSeconds: 16,
    sampleRate: 44_100,
    channels: 2,
  },
  tempoMap: [{ time: 0, bpm: 120, confidence: 0.92 }],
  meterMap: [{ bar: 1, meter: "4/4", confidence: 0.9 }],
  keyMap: [{ time: 0, key: "C major", confidence: 0.88 }],
  melody: [
    { start: 0, end: 0.5, pitch: 60, velocity: 92, confidence: 0.91, source: "MT3" },
    { start: 0.5, end: 1, pitch: 64, velocity: 90, confidence: 0.9, source: "MT3" },
    { start: 1, end: 1.5, pitch: 67, velocity: 94, confidence: 0.89, source: "MT3" },
  ],
  chords: [
    { start: 0, end: 2, symbol: "C", roman: "I", confidence: 0.9 },
  ],
  sections: [
    { name: "Verse", startBar: 1, endBar: 4, energy: 0.45 },
    { name: "Chorus", startBar: 5, endBar: 8, energy: 0.82 },
  ],
  energy: [0.35, 0.5, 0.82, 0.7],
};

export const tempoDriftSongModel: SongModelCore = {
  ...validSongModel,
  tempoMap: [
    { time: 0, bpm: 120, confidence: 0.92 },
    { time: 8, bpm: 148, confidence: 0.84 },
  ],
};

export const octaveJumpSongModel: SongModelCore = {
  ...validSongModel,
  melody: [
    { start: 0, end: 0.5, pitch: 48, velocity: 92, confidence: 0.91, source: "MT3" },
    { start: 0.55, end: 1, pitch: 72, velocity: 90, confidence: 0.9, source: "MT3" },
  ],
};

export const microNoteSongModel: SongModelCore = {
  ...validSongModel,
  melody: [
    { start: 0, end: 0.02, pitch: 60, velocity: 92, confidence: 0.91, source: "MT3" },
  ],
};

export const missingSectionsSongModel: SongModelCore = {
  ...validSongModel,
  sections: [],
};

export const chordMelodyConflictSongModel: SongModelCore = {
  ...validSongModel,
  melody: [
    { start: 0, end: 0.3, pitch: 61, velocity: 92, confidence: 0.91, source: "MT3" },
    { start: 0.3, end: 0.6, pitch: 63, velocity: 90, confidence: 0.9, source: "MT3" },
    { start: 0.6, end: 0.9, pitch: 66, velocity: 94, confidence: 0.89, source: "MT3" },
    { start: 0.9, end: 1.2, pitch: 70, velocity: 88, confidence: 0.88, source: "MT3" },
  ],
};