/**
 * Treat decoded PCM as silent only when both its overall level and its peak
 * are far below normal recording levels. Requiring both measurements keeps a
 * quiet recording (or one with a short audible transient) from being rejected,
 * while catching empty decodes and codec-level digital silence deterministically.
 */
export function isEffectivelySilent(samples: Float32Array): boolean {
  if (samples.length === 0) return true;

  let sumOfSquares = 0;
  let peak = 0;
  let finiteSamples = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) continue;
    const magnitude = Math.abs(sample);
    peak = Math.max(peak, magnitude);
    sumOfSquares += sample * sample;
    finiteSamples += 1;
  }

  if (finiteSamples === 0) return true;
  const rms = Math.sqrt(sumOfSquares / finiteSamples);
  // -90 dBFS RMS and -66 dBFS peak: well below a normally quiet recording.
  return rms < 0.000_032 && peak < 0.000_5;
}

export type VocalActivityThresholds = {
  rms: number;
  peak: number;
  activitySample: number;
  activityRatio: number;
};

export type ObservedVocalWindow = { start: number; end: number };

export type DecodedVocalActivity = {
  status: "detected" | "low_confidence";
  frameSizeSamples: number;
  thresholds: VocalActivityThresholds;
  observedVoicedWindows: ObservedVocalWindow[];
  observedSilentWindows: ObservedVocalWindow[];
};

/** Fixed, documented detector parameters; no musical/template inputs are used. */
export const VOCAL_ACTIVITY_THRESHOLDS: VocalActivityThresholds = {
  rms: 0.01,
  peak: 0.02,
  activitySample: 0.005,
  activityRatio: 0.1,
};

/**
 * Classifies consecutive, non-overlapping PCM frames.  A frame is voiced only
 * when RMS, peak, and active-sample ratio independently clear their fixed
 * thresholds. Adjacent same-class frames are merged on exact sample bounds.
 */
export function detectVocalActivity(
  samples: Float32Array,
  sampleRate: number,
  thresholds: VocalActivityThresholds = VOCAL_ACTIVITY_THRESHOLDS,
): DecodedVocalActivity {
  const frameSizeSamples = Math.max(1, Math.round(sampleRate / 10));
  const voiced: ObservedVocalWindow[] = [];
  const silent: ObservedVocalWindow[] = [];
  const append = (windows: ObservedVocalWindow[], startSample: number, endSample: number) => {
    const start = startSample / sampleRate;
    const end = endSample / sampleRate;
    const previous = windows.at(-1);
    if (previous && previous.end === start) previous.end = end;
    else windows.push({ start, end });
  };

  for (let start = 0; start < samples.length; start += frameSizeSamples) {
    const end = Math.min(samples.length, start + frameSizeSamples);
    let squares = 0;
    let peak = 0;
    let active = 0;
    for (let index = start; index < end; index += 1) {
      const sample = samples[index];
      if (!Number.isFinite(sample)) continue;
      const magnitude = Math.abs(sample);
      squares += sample * sample;
      peak = Math.max(peak, magnitude);
      if (magnitude >= thresholds.activitySample) active += 1;
    }
    const length = end - start;
    const isVoiced = Math.sqrt(squares / length) >= thresholds.rms &&
      peak >= thresholds.peak &&
      active / length >= thresholds.activityRatio;
    append(isVoiced ? voiced : silent, start, end);
  }
  return {
    status: voiced.length ? "detected" : "low_confidence",
    frameSizeSamples,
    thresholds,
    observedVoicedWindows: voiced,
    observedSilentWindows: silent,
  };
}