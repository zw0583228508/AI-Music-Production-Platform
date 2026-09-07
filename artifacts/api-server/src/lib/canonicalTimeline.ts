/**
 * The single conversion authority for Song Model v2.  Ticks are integer 960
 * PPQ positions; seconds retain the source observation and are compared with a
 * half-tick tolerance by validation.
 */
export const CANONICAL_PPQ = 960 as const;

export type TempoChange = { time: number; bpm: number };
export type MeterChange = { bar: number; meter: string };
export type CanonicalCoordinate = {
  seconds: number;
  tick: number;
  beat: number;
  bar: number;
  beatInBar: number;
};

type Meter = { numerator: number; denominator: number };

function parseMeter(value: string): Meter {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`Invalid meter: ${value}`);
  return { numerator: Number(match[1]), denominator: Number(match[2]) };
}

/**
 * Ordered maps are intentional: a later event at the same time/bar would make
 * the active value ambiguous and is therefore rejected rather than sorted away.
 */
export function createCanonicalTimeline(
  tempoChanges: TempoChange[],
  meterChanges: MeterChange[],
) {
  if (!tempoChanges.length || tempoChanges[0].time !== 0) {
    throw new Error("Tempo map must begin at 0 seconds.");
  }
  if (!meterChanges.length || meterChanges[0].bar !== 1) {
    throw new Error("Meter map must begin at bar 1.");
  }
  const tempos = tempoChanges.map((change, index) => {
    if (!Number.isFinite(change.time) || change.time < 0 || !Number.isFinite(change.bpm) || change.bpm <= 0 ||
      (index > 0 && change.time <= tempoChanges[index - 1].time)) {
      throw new Error("Tempo changes must be finite and strictly ordered.");
    }
    return { ...change };
  });
  const meters = meterChanges.map((change, index) => {
    if (!Number.isInteger(change.bar) || change.bar < 1 || (index > 0 && change.bar <= meterChanges[index - 1].bar)) {
      throw new Error("Meter changes must use strictly ordered positive bars.");
    }
    return { ...change, ...parseMeter(change.meter) };
  });

  const tickAtTempo: number[] = [0];
  for (let index = 1; index < tempos.length; index += 1) {
    const previous = tempos[index - 1];
    tickAtTempo.push(tickAtTempo[index - 1] +
      (tempos[index].time - previous.time) * previous.bpm * CANONICAL_PPQ / 60);
  }
  const tickAtMeter: number[] = [0];
  const beatAtMeter: number[] = [0];
  for (let index = 1; index < meters.length; index += 1) {
    const previous = meters[index - 1];
    tickAtMeter.push(tickAtMeter[index - 1] +
      (meters[index].bar - previous.bar) * previous.numerator * CANONICAL_PPQ * 4 / previous.denominator);
    beatAtMeter.push(beatAtMeter[index - 1] +
      (meters[index].bar - previous.bar) * previous.numerator);
  }

  const tempoIndexAtSeconds = (seconds: number) => {
    let index = 0;
    while (index + 1 < tempos.length && tempos[index + 1].time <= seconds) index += 1;
    return index;
  };
  const tempoIndexAtTick = (tick: number) => {
    let index = 0;
    while (index + 1 < tickAtTempo.length && tickAtTempo[index + 1] <= tick) index += 1;
    return index;
  };
  const meterIndexAtBar = (bar: number) => {
    let index = 0;
    while (index + 1 < meters.length && meters[index + 1].bar <= bar) index += 1;
    return index;
  };
  const meterIndexAtTick = (tick: number) => {
    let index = 0;
    while (index + 1 < tickAtMeter.length && tickAtMeter[index + 1] <= tick) index += 1;
    return index;
  };
  const secondsToTick = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Seconds must be finite and non-negative.");
    const index = tempoIndexAtSeconds(seconds);
    return Math.round(tickAtTempo[index] + (seconds - tempos[index].time) * tempos[index].bpm * CANONICAL_PPQ / 60);
  };
  const tickToSeconds = (tick: number) => {
    if (!Number.isFinite(tick) || tick < 0) throw new Error("Tick must be finite and non-negative.");
    const index = tempoIndexAtTick(tick);
    return tempos[index].time + (tick - tickAtTempo[index]) * 60 / (tempos[index].bpm * CANONICAL_PPQ);
  };
  const barToTick = (bar: number) => {
    if (!Number.isInteger(bar) || bar < 1) throw new Error("Bar must be a positive integer.");
    const index = meterIndexAtBar(bar);
    const meter = meters[index];
    return Math.round(tickAtMeter[index] + (bar - meter.bar) * meter.numerator * CANONICAL_PPQ * 4 / meter.denominator);
  };
  const tickToMusicalPosition = (tick: number) => {
    const index = meterIndexAtTick(tick);
    const meter = meters[index];
    const ticksPerBeat = CANONICAL_PPQ * 4 / meter.denominator;
    const offset = tick - tickAtMeter[index];
    const beatOffset = Math.floor(offset / ticksPerBeat + 1e-9);
    return {
      bar: meter.bar + Math.floor(beatOffset / meter.numerator),
      beatInBar: (beatOffset % meter.numerator) + 1,
      beat: beatAtMeter[index] + beatOffset + 1,
    };
  };
  const coordinateAtSeconds = (seconds: number): CanonicalCoordinate => {
    const tick = secondsToTick(seconds);
    return { seconds, tick, ...tickToMusicalPosition(tick) };
  };
  const coordinateAtBar = (bar: number): CanonicalCoordinate => {
    const tick = barToTick(bar);
    return { seconds: tickToSeconds(tick), tick, ...tickToMusicalPosition(tick) };
  };
  return { secondsToTick, tickToSeconds, barToTick, tickToMusicalPosition, coordinateAtSeconds, coordinateAtBar };
}