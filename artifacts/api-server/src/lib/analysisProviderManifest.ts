import { gpuPromotionAttestationFailure } from "./gpuProviderAttestation";

export type VerifiedLocalAnalysisProviderId = "BASIC_PITCH" | "DEMUCS";
export type VerifiedMirAnalysisProviderId =
  | "MADMOM"
  | "TORCHCREPE"
  | "ESSENTIA"
  | "CHROMA"
  | "PYLOUDNORM";
export type VerifiedGpuAnalysisProviderId =
  | "BS_ROFORMER"
  | "ALL_IN_ONE"
  | "MT3"
  | "MR_MT3"
  | "YOUR_MT3"
  | "BEAT_THIS";

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

const VERIFIED_DEMUCS_SOURCE = {
  repository: "https://github.com/facebookresearch/demucs",
  revision: "ef66d254cd6d558e207eeff2c4b8d053db2e77dd",
  license: "MIT",
  licenseSha256: "cf9b17822d1fcd4ff32ccbe14183386fb3adf6f2ff92dc184130823f7fc28173",
  packageArtifactSha256: "e45a5a788bae79767c37bbf6e69aae03862ddcca05550fb79b926346a177d713",
  packageTreeSha256: "75d9c33232395acb77124da9d163084db4c10f08f0475160a36dece847fcc4cd",
} as const;

export const VERIFIED_GPU_ANALYSIS_PROVIDERS: Readonly<
  Record<VerifiedGpuAnalysisProviderId, Pick<AnalysisProviderManifestEntry, "version">>
> = {
  BS_ROFORMER: {
    version: "bs-roformer-viperx-v1",
  },
  ALL_IN_ONE: {
    version: "all-in-one-infer-3.1.0",
  },
  MT3: {
    version: "mt3-ismir2021",
  },
  MR_MT3: {
    version: "mr-mt3",
  },
  YOUR_MT3: {
    version: "your-mt3",
  },
  BEAT_THIS: {
    version: "1.1.0",
  },
};

const VERIFIED_MIR_PACKAGES: Readonly<Record<VerifiedMirAnalysisProviderId, {
  packageName: string | null;
  version: string;
}>> = {
  MADMOM: { packageName: "madmom-infer", version: "0.2.0" },
  TORCHCREPE: { packageName: "torchcrepe", version: "0.0.24" },
  ESSENTIA: { packageName: "essentia", version: "2.1b6.dev1438" },
  CHROMA: { packageName: null, version: "essentia-hpcp-plus-librosa-0.11.0" },
  PYLOUDNORM: { packageName: "pyloudnorm", version: "0.2.0" },
};

export type AnalysisProviderHealthAttestation = {
  provider: string;
  version: string;
  checksum: string;
};

const SHEETSAGE_IDENTITY = {
  version: "0.2.1",
  sourceRevision: "openmirlab/sheetsage-infer@ee7c2aeeb8084840a4f938ae6913f566afdaebdc",
} as const;

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
  endpoint?: string,
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
  const mirExpected = VERIFIED_MIR_PACKAGES[
    requestedProvider as VerifiedMirAnalysisProviderId
  ];
  if (mirExpected) {
    const packageName = payload.packageName === null
      ? null
      : typeof payload.packageName === "string" ? payload.packageName.trim() : "";
    const packageVersion = typeof payload.packageVersion === "string"
      ? payload.packageVersion.trim()
      : "";
    if (
      payload.ready !== true ||
      payload.packageReady !== true ||
      payload.assetReady !== true ||
      payload.featureExecutionReady !== true ||
      payload.runtimeReady !== true ||
      payload.smokeTested !== true ||
      packageName !== mirExpected.packageName ||
      packageVersion !== mirExpected.version
    ) {
      throw new Error(
        `health response does not contain verified runtime, package, asset, and smoke proof for ${requestedProvider}`,
      );
    }
    return {
      provider,
      version: packageVersion,
      checksum: /^[a-f0-9]{64}$/i.test(checksum) ? checksum : "runtime-smoke-attested",
    };
  }
  if (requestedProvider === "SHEETSAGE") {
    if (
      version !== SHEETSAGE_IDENTITY.version ||
      payload.sourceRevision !== SHEETSAGE_IDENTITY.sourceRevision ||
      payload.assetsVerified !== true ||
      payload.runtimeReady !== true ||
      payload.checkpointReady !== true ||
      payload.smokeTested !== true ||
      payload.smokeProofVerified !== true ||
      !/^[a-f0-9]{64}$/i.test(checksum)
    ) {
      throw new Error(
        "health response does not match the verified SheetSage source, asset, runtime, and signed-smoke identity",
      );
    }
    return { provider, version, checksum };
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
  if (
    requestedProvider === "DEMUCS" &&
    (
      payload.sourceRepository !== VERIFIED_DEMUCS_SOURCE.repository ||
      payload.sourceRevision !== VERIFIED_DEMUCS_SOURCE.revision ||
      payload.license !== VERIFIED_DEMUCS_SOURCE.license ||
      payload.licenseSha256 !== VERIFIED_DEMUCS_SOURCE.licenseSha256 ||
      payload.packageArtifactSha256 !== VERIFIED_DEMUCS_SOURCE.packageArtifactSha256 ||
      payload.packageTreeSha256 !== VERIFIED_DEMUCS_SOURCE.packageTreeSha256
    )
  ) {
    throw new Error("health response does not match the verified DEMUCS source and license identity");
  }
  const gpuExpected = VERIFIED_GPU_ANALYSIS_PROVIDERS[
    requestedProvider as VerifiedGpuAnalysisProviderId
  ];
  if (gpuExpected) {
    const promotionFailure = endpoint
      ? gpuPromotionAttestationFailure(requestedProvider, endpoint, payload)
      : "GPU provider endpoint is required for promotion attestation.";
    if (
      version !== gpuExpected.version ||
      !/^[a-f0-9]{64}$/i.test(checksum) ||
      payload.gpuReady !== true ||
      promotionFailure
    ) {
      throw new Error(
        `health response does not match the verified GPU ${requestedProvider} identity: ${
          promotionFailure ?? "model readiness is invalid"
        }`,
      );
    }
  }
  return { provider, version, checksum };
}
