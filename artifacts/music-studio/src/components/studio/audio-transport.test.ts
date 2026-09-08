import assert from "node:assert/strict";
import test from "node:test";
import {
  getSourceChangePlayback,
  getSynchronizedSourceTime,
} from "./use-audio-transport";
import { getCandidatePlaybackPresentation } from "./candidate-playback";

test("a playing candidate carries its overlapping timestamp into the next source", () => {
  const change = getSourceChangePlayback(
    "/candidate-a.wav",
    "/candidate-b.wav",
    37.25,
    false,
  );

  assert.deepEqual(change, {
    pendingTime: 37.25,
    resumeAfterLoad: true,
  });
  assert.equal(getSynchronizedSourceTime(change.pendingTime, 90, 0), 37.25);
});

test("switching to a shorter candidate clamps the carried timestamp", () => {
  const change = getSourceChangePlayback(
    "/candidate-a.wav",
    "/candidate-short.wav",
    37.25,
    false,
  );

  assert.equal(getSynchronizedSourceTime(change.pendingTime, 12, 90), 12);
});

test("a paused candidate carries its timestamp without resuming", () => {
  const change = getSourceChangePlayback(
    "/candidate-a.wav",
    "/candidate-b.wav",
    18.5,
    true,
  );

  assert.deepEqual(change, {
    pendingTime: 18.5,
    resumeAfterLoad: false,
  });
});

test("candidate controls expose deterministic active play and pause state", () => {
  assert.deepEqual(
    getCandidatePlaybackPresentation({
      candidateId: "candidate-b",
      candidateLabel: "Candidate B",
      activeCandidateId: "candidate-b",
      hasAudio: true,
      transportStatus: "playing",
    }),
    {
      active: true,
      playing: true,
      disabled: false,
      label: "Pause Candidate B",
      text: "Pause",
    },
  );

  assert.equal(
    getCandidatePlaybackPresentation({
      candidateId: "candidate-c",
      candidateLabel: "Candidate C",
      activeCandidateId: "candidate-b",
      hasAudio: true,
      transportStatus: "paused",
    }).label,
    "Play Candidate C",
  );
});

test("candidate controls disable and visibly label missing audio", () => {
  const presentation = getCandidatePlaybackPresentation({
    candidateId: "candidate-missing",
    candidateLabel: "Candidate Missing",
    activeCandidateId: null,
    hasAudio: false,
    transportStatus: "paused",
  });

  assert.equal(presentation.disabled, true);
  assert.equal(presentation.text, "Unavailable");
  assert.equal(presentation.label, "Candidate Missing render unavailable");
});