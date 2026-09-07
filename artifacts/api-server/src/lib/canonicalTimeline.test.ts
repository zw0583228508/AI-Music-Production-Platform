import assert from "node:assert/strict";
import test from "node:test";
import { createCanonicalTimeline } from "./canonicalTimeline";

test("converts constant tempo between seconds, ticks, beats, and bars", () => {
  const timeline = createCanonicalTimeline(
    [{ time: 0, bpm: 120 }],
    [{ bar: 1, meter: "4/4" }],
  );
  assert.equal(timeline.secondsToTick(2), 3840);
  assert.equal(timeline.tickToSeconds(3840), 2);
  assert.deepEqual(timeline.coordinateAtSeconds(2), {
    seconds: 2, tick: 3840, beat: 5, bar: 2, beatInBar: 1,
  });
});

test("uses the active ordered tempo change for both directions", () => {
  const timeline = createCanonicalTimeline(
    [{ time: 0, bpm: 120 }, { time: 2, bpm: 60 }],
    [{ bar: 1, meter: "4/4" }],
  );
  assert.equal(timeline.secondsToTick(3), 4800);
  assert.equal(timeline.tickToSeconds(4800), 3);
});

test("meter changes alter bar positions without changing ticks or seconds", () => {
  const timeline = createCanonicalTimeline(
    [{ time: 0, bpm: 120 }],
    [{ bar: 1, meter: "4/4" }, { bar: 3, meter: "3/4" }],
  );
  assert.equal(timeline.barToTick(3), 7680);
  assert.deepEqual(timeline.tickToMusicalPosition(9600), {
    bar: 3, beat: 11, beatInBar: 3,
  });
});

test("rejects ambiguous ordered changes", () => {
  assert.throws(() => createCanonicalTimeline(
    [{ time: 0, bpm: 120 }, { time: 0, bpm: 90 }],
    [{ bar: 1, meter: "4/4" }],
  ));
});