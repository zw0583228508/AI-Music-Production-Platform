import assert from "node:assert/strict";
import test from "node:test";
import { validateSourceFileMetadata } from "./sourceFormats";

test("accepts every browser-supported source metadata family", () => {
  const cases = [
    ["recording.wav", "audio/vnd.wave", "audio"],
    ["recording.flac", "audio/x-flac", "audio"],
    ["recording.mp3", "audio/x-mp3", "audio"],
    ["recording.m4a", "audio/x-m4a", "audio"],
    ["recording.aac", "audio/x-aac", "audio"],
    ["recording.ogg", "audio/vorbis", "audio"],
    ["concert.mp4", "application/mp4", "video"],
    ["concert.mov", "video/quicktime", "video"],
    ["concert.webm", "audio/webm", "video"],
    ["score.mid", "application/x-midi", "midi"],
    ["score.midi", "audio/x-midi", "midi"],
  ] as const;

  for (const [name, contentType, mediaKind] of cases) {
    const result = validateSourceFileMetadata(name, contentType);
    assert.equal(result.valid, true, `${name} should be accepted`);
    if (result.valid) assert.equal(result.mediaKind, mediaKind);
  }
});

test("normalizes generic browser MIME types from a supported extension", () => {
  for (const contentType of ["", "application/octet-stream", "binary/octet-stream", "application/binary"]) {
    const result = validateSourceFileMetadata("take.mp3", contentType);
    assert.deepEqual(result, {
      valid: true,
      normalizedContentType: "audio/mpeg",
      mediaKind: "audio",
    });
  }
});

test("rejects an incompatible extension and MIME pairing", () => {
  assert.deepEqual(validateSourceFileMetadata("take.mp3", "video/mp4"), { valid: false });
  assert.deepEqual(validateSourceFileMetadata("take.exe", "application/octet-stream"), { valid: false });
});