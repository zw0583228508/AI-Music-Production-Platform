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
  const value = (
    process.env[`MUSIC_PROVIDER_${key}_CHECKPOINT_SHA256`] ??
    process.env[`${key}_CHECKPOINT_SHA256`]
  )?.trim();
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

export function expectedGpuModalImageId(providerId: string): string | null {
  const key = providerId.replace(/[^A-Z0-9]/g, "_");
  const value = process.env[`MUSIC_PROVIDER_${key}_MODAL_IMAGE_ID`]?.trim();
  return typeof value === "string" && /^im-[A-Za-z0-9]+$/.test(value)
    ? value
    : null;
}

/** The registry version is the deployment pin. An explicit env value may only
 * repeat it; it cannot be used to silently select a different model. */
export function expectedGpuModelVersion(
  providerId: string,
  registryVersion: string,
): string | null {
  const key = providerId.replace(/[^A-Z0-9]/g, "_");
  const configured = (
    process.env[`MUSIC_PROVIDER_${key}_MODEL_VERSION`] ??
    process.env[`${key}_MODEL_VERSION`]
  )?.trim();
  return configured && configured !== registryVersion ? null : registryVersion;
}

/** Source-build hash retained as a compatibility check; this is not the
 * deployed Modal/OCI runtime identity. */
export function expectedGpuSourceImageDigest(providerId: string): string | null {
  const key = providerId.replace(/[^A-Z0-9]/g, "_");
  const value = (
    process.env[`MUSIC_PROVIDER_${key}_SOURCE_IMAGE_DIGEST`] ??
    process.env[`MUSIC_PROVIDER_${key}_CONTAINER_DIGEST`] ??
    process.env[`${key}_CONTAINER_DIGEST`]
  )?.trim();
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

/** @deprecated Use expectedGpuSourceImageDigest. Kept for configuration API
 * compatibility with the former container-digest terminology. */
export const expectedGpuContainerDigest = expectedGpuSourceImageDigest;

export function anyAccompCommercialUseAuthorized(): boolean {
  return process.env.MUSIC_PROVIDER_ANYACCOMP_COMMERCIAL_USE_AUTHORIZED === "true" ||
    process.env.ANYACCOMP_COMMERCIAL_USE_AUTHORIZED === "true";
}