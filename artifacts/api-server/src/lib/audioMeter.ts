/** Deterministic 4x polyphase reconstruction using a 48-tap Hann-windowed sinc. */
export function estimateTruePeak4x(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  const phases = 4;
  const halfTaps = 24;
  let peak = 0;
  const sinc = (value: number) => value === 0 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value);
  for (let center = 0; center < samples.length; center += 1) {
    for (let phase = 0; phase < phases; phase += 1) {
      const fraction = phase / phases;
      let value = 0;
      for (let tap = -halfTaps + 1; tap <= halfTaps; tap += 1) {
        const index = center + tap;
        if (index < 0 || index >= samples.length) continue;
        const distance = fraction - tap;
        const coefficient = sinc(distance) * (.5 + .5 * Math.cos(Math.PI * distance / halfTaps));
        value += samples[index] * coefficient;
      }
      peak = Math.max(peak, Math.abs(value));
    }
  }
  return peak;
}