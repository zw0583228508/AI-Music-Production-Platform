import assert from "node:assert/strict";
import test from "node:test";
import { buildMeterAwareEvidence, createCanonicalTimeline } from "./canonicalTimeline";

test("converts constant tempo between seconds, ticks, beats, and bars", () => {
  const timeline = createCanonicalTimeline(
    [{ time: 0, bpm: 120 }],
    [{ bar: 1, meter: "4/4" }],
  );
  assert.equal(timeline.secondsToTick(2), 3840);
  assert.equal(timeline.tickToSeconds(3840), 2);
  assert.deepEqual(timeline.coordinateAtSeconds(2), {
    seconds: 2, tick: 3840, beat: 5, bar: 2, beatInBar: 1, beatFraction: 0,
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
    bar: 3, beat: 11, beatInBar: 3, beatFraction: 0,
  });
});

test("preserves fractional positions within a beat", () => {
  const timeline = createCanonicalTimeline(
    [{ time: 0, bpm: 120 }],
    [{ bar: 1, meter: "4/4" }],
  );
  assert.equal(timeline.coordinateAtSeconds(0.25).beatFraction, 0.5);
});

test("rejects ambiguous ordered changes", () => {
  assert.throws(() => createCanonicalTimeline(
    [{ time: 0, bpm: 120 }, { time: 0, bpm: 90 }],
    [{ bar: 1, meter: "4/4" }],
  ));
});

test("round-trips unusual valid tempo and meter maps without moving musical events", () => {
  const tempoMap = [
    { time: 0, bpm: 120 },
    { time: 1.25, bpm: 90 },
    { time: 3.25, bpm: 150 },
  ];
  const meterMap = [
    { bar: 1, meter: "7/8" },
    { bar: 3, meter: "5/16" },
    { bar: 6, meter: "3/2" },
  ];
  const timeline = createCanonicalTimeline(tempoMap, meterMap);
  const noMeterChanges = createCanonicalTimeline(tempoMap, [{ bar: 1, meter: "4/4" }]);
  const musicalEventTicks = [0, 959, 2_400, 3_360, 6_720, 10_320, 12_000];

  for (const tick of musicalEventTicks) {
    const seconds = timeline.tickToSeconds(tick);
    assert.equal(timeline.secondsToTick(seconds), tick);
    // Meter labels may change, but never the event's absolute tick or time.
    assert.equal(noMeterChanges.secondsToTick(seconds), tick);
    assert.equal(noMeterChanges.tickToSeconds(tick), seconds);
  }
  assert.equal(timeline.barToTick(3), 6_720);
  assert.equal(timeline.barToTick(6), 10_320);
  assert.deepEqual(timeline.tickToMusicalPosition(6_720), {
    bar: 3, beat: 15, beatInBar: 1, beatFraction: 0,
  });
  assert.deepEqual(timeline.tickToMusicalPosition(10_320), {
    bar: 6, beat: 30, beatInBar: 1, beatFraction: 0,
  });
});

test("rejects maps whose distinct events cannot occupy distinct canonical ticks", () => {
  assert.throws(() => createCanonicalTimeline(
    [{ time: 0, bpm: 120 }, { time: 0.000_001, bpm: 120 }],
    [{ bar: 1, meter: "4/4" }],
  ), /strictly ordered canonical ticks/);
  assert.throws(() => createCanonicalTimeline(
    [{ time: 0, bpm: 120 }],
    [{ bar: 1, meter: "5/7" }],
  ), /representable/);
});

test("derives 6/8 MIDI beat and bar evidence from source ticks", () => {
  const evidence = buildMeterAwareEvidence(
    480,
    2_880,
    [{ tick: 0, meter: "6/8" }],
    (tick) => tick / 960,
  );
  assert.deepEqual(evidence.meterMap, [{ bar: 1, meter: "6/8" }]);
  assert.equal(evidence.beats[5].beat, 6);
  assert.equal(evidence.beats[6].bar, 2);
  assert.deepEqual(evidence.bars.map(({ bar, start, end }) => ({ bar, start, end })), [
    { bar: 1, start: 0, end: 1.5 },
    { bar: 2, start: 1.5, end: 3 },
  ]);
});

test("keeps MIDI meter-change bars stable across a tempo change", () => {
  const tickToSeconds = (tick: number) =>
    tick <= 1_440 ? tick / 960 : 1.5 + (tick - 1_440) / 480;
  const evidence = buildMeterAwareEvidence(
    480,
    4_320,
    [{ tick: 0, meter: "6/8" }, { tick: 2_880, meter: "3/4" }],
    tickToSeconds,
  );
  assert.deepEqual(evidence.meterMap, [
    { bar: 1, meter: "6/8" },
    { bar: 3, meter: "3/4" },
  ]);
  assert.equal(evidence.bars[1].start, 1.5);
  assert.equal(evidence.bars[2].start, 4.5);
});