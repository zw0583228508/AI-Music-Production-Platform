export type VerifiedLocalAnalysisProviderId = "BASIC_PITCH" | "DEMUCS";
export type VerifiedGpuAnalysisProviderId = "BS_ROFORMER" | "ALL_IN_ONE" | "MT3";

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

export const VERIFIED_GPU_ANALYSIS_PROVIDERS: Readonly<
  Record<VerifiedGpuAnalysisProviderId, Pick<AnalysisProviderManifestEntry, "version">>
> = {
  BS_ROFORMER: {
    version: "bs-roformer-viperx-v1",
  },
  ALL_IN_ONE: {
    version: "all-in-one-infer",
  },
  MT3: {
    version: "mt3-ismir2021",
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
  const gpuExpected = VERIFIED_GPU_ANALYSIS_PROVIDERS[
    requestedProvider as VerifiedGpuAnalysisProviderId
  ];
  if (gpuExpected) {
    const expectedChecksum = process.env[
      `${requestedProvider}_CHECKPOINT_SHA256`
    ]?.trim().toLowerCase();
    const runtime = record(payload.runtime) ? payload.runtime : {};
    const requiredRuntimeProvenance = [
      payload.revision ?? payload.checkpointRevision ?? runtime.revision,
      payload.containerDigest ?? runtime.containerDigest,
      payload.cudaVersion ?? runtime.cudaVersion,
      payload.pytorchVersion ?? payload.torchVersion ?? runtime.pytorchVersion ?? runtime.torchVersion,
      payload.gpu ?? payload.gpuModel ?? runtime.gpu ?? runtime.gpuModel,
    ].every((value) =>
      typeof value === "string" && value.trim().length > 0 && value.trim().length <= 256
    );
    if (
      version !== gpuExpected.version ||
      !/^[a-f0-9]{64}$/i.test(checksum) ||
      !expectedChecksum ||
      checksum.toLowerCase() !== expectedChecksum ||
      payload.gpuReady !== true ||
      !requiredRuntimeProvenance
    ) {
      throw new Error(
        `health response does not match the verified GPU ${requestedProvider} identity`,
      );
    }
  }
  return { provider, version, checksum };
}