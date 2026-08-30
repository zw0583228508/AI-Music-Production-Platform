export type VerifiedLocalAnalysisProviderId = "BASIC_PITCH" | "DEMUCS";

export type AnalysisProviderManifestEntry = {
  version: string;
  checksum: string;
};

/** Immutable identities for analysis runtimes operated by this workspace. */
export const VERIFIED_LOCAL_ANALYSIS_PROVIDERS: Readonly<
  Record<VerifiedLocalAnalysisProviderId, AnalysisProviderManifestEntry>
> = {
  BASIC_PITCH: {
    version: "0.4.0",
    checksum: "2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec",
  },
  DEMUCS: {
    version: "4.0.1",
    checksum: "8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4",
  },
};

export type AnalysisProviderHealthAttestation = {
  provider: string;
  version: string;
  checksum: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the health contract needed before an analysis worker may receive
 * source data. A manifest entry additionally pins the worker identity.
 */
export function attestAnalysisProviderHealth(
  requestedProvider: string,
  payload: unknown,
): AnalysisProviderHealthAttestation {
  if (!record(payload)) throw new Error("health response must be a JSON object");
  const provider = typeof payload.provider === "string" ? payload.provider.trim() : "";
  const status = typeof payload.status === "string" ? payload.status.toLowerCase() : "";
  const versionValue = payload.modelVersion ?? payload.version;
  const version = typeof versionValue === "string" ? versionValue.trim() : "";
  const checksum = typeof payload.checksum === "string" ? payload.checksum.trim() : "";
  if (provider !== requestedProvider) {
    throw new Error(`health response provider must equal ${requestedProvider}`);
  }
  if (!["healthy", "ready", "ok"].includes(status)) {
    throw new Error("health response status is not healthy");
  }
  if (
    payload.runtimeReady !== true ||
    payload.checkpointReady !== true ||
    payload.smokeTested !== true
  ) {
    throw new Error("health response did not verify runtime, checkpoint, and smoke test");
  }
  if (!version || !checksum) {
    throw new Error("health response is missing version or checksum");
  }
  const expected = VERIFIED_LOCAL_ANALYSIS_PROVIDERS[
    requestedProvider as VerifiedLocalAnalysisProviderId
  ];
  if (expected && (version !== expected.version || checksum !== expected.checksum)) {
    throw new Error(`health response does not match the verified ${requestedProvider} identity`);
  }
  return { provider, version, checksum };
}