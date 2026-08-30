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