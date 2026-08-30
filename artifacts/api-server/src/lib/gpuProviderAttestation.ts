const GPU_ATTESTED_PROVIDER_IDS = new Set([
  "ACE_STEP",
  "BS_ROFORMER",
  "ALL_IN_ONE",
  "MT3",
  "SYMPHONYGEN",
  "METEOR",
  "ANYACCOMP",
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

/** The registry version is the deployment pin. An explicit env value may only
 * repeat it; it cannot be used to silently select a different model. */
export function expectedGpuModelVersion(
  providerId: string,
  registryVersion: string,
): string | null {
  const key = providerId.replace(/[^A-Z0-9]/g, "_");
  const configured = process.env[`MUSIC_PROVIDER_${key}_MODEL_VERSION`]?.trim();
  return configured && configured !== registryVersion ? null : registryVersion;
}

export function anyAccompCommercialUseAuthorized(): boolean {
  return process.env.MUSIC_PROVIDER_ANYACCOMP_COMMERCIAL_USE_AUTHORIZED === "true" ||
    process.env.ANYACCOMP_COMMERCIAL_USE_AUTHORIZED === "true";
}