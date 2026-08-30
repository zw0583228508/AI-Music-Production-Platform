const GPU_ATTESTED_PROVIDER_IDS = new Set([
  "ACE_STEP",
  "ACE_STEP_LEGO",
  "MUSICGEN",
  "BS_ROFORMER",
  "MT3",
]);

export function isGpuAttestedProvider(providerId: string): boolean {
  return GPU_ATTESTED_PROVIDER_IDS.has(providerId);
}

export function expectedGpuCheckpointSha256(providerId: string): string | null {
  const key = providerId.replace(/[^A-Z0-9]/g, "_");
  const value = process.env[`MUSIC_PROVIDER_${key}_CHECKPOINT_SHA256`]?.trim();
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)
    ? value.toLowerCase()
    : null;
}