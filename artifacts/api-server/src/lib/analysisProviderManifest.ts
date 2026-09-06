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
export type VerifiedMossAnalysisProviderId =
  | "MOSS_MUSIC_INSTRUCT"
  | "MOSS_MUSIC_THINKING";

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
    checksum: "b74344cd0c58261dae0cd52050d85ab6f901a5e219f27046ab4640673bba1046",
  },
  DEMUCS: {
    version: "4.0.1",
    checksum: "8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4",
  },
};

const VERIFIED_BASIC_PITCH_SOURCE = {
  repository: "https://github.com/spotify/basic-pitch",
  revision: "9991303bba609a3b93089d13ec80d1d495083596",
  license: "Apache-2.0",
  licenseSha256: "929c910bae2152fa87199a5d0660e09263419b7eee6d4b301d05ee2aaf211c37",
  noticeSha256: "b810e55c0e3b520fabb45fc2ccc74880187bf84e309971968541cc812dcde905",
  packageArtifactSha256: "738adb503aae7fdfc7d1e1511aa0ce35052315f260a19531ef4c356708425db0",
  packageTreeSha256: "89cfb8516927e3bc536da99139ddb4ad7ce79dc833e29df33e5bca27ccef116c",
  inferenceBackend: "tensorflow-saved-model",
  runtimePackages: {
    tensorflow: "2.14.0",
    numpy: "1.26.4",
    librosa: "0.11.0",
    resampy: "0.4.2",
    "pretty-midi": "0.2.11.post0",
  },
} as const;

const VERIFIED_DEMUCS_SOURCE = {
  repository: "https://github.com/facebookresearch/demucs",
  revision: "ef66d254cd6d558e207eeff2c4b8d053db2e77dd",
  license: "MIT",
  licenseSha256: "cf9b17822d1fcd4ff32ccbe14183386fb3adf6f2ff92dc184130823f7fc28173",
  packageArtifactSha256: "e45a5a788bae79767c37bbf6e69aae03862ddcca05550fb79b926346a177d713",
  packageTreeSha256: "75d9c33232395acb77124da9d163084db4c10f08f0475160a36dece847fcc4cd",
} as const;

const VERIFIED_MOSS_MUSIC_IDENTITY = {
  sourceRepository: "OpenMOSS/MOSS-Music",
  sourceRevision: "ad107c7ddaa06de168a0dfbc18d3e1e6a40c0e5e",
  sglangRepository: "OpenMOSS/sglang",
  sglangRevision: "c28a945853c7fee357f55d976b8abce51874bd94",
  runtimePackages: {
    python: "3.12.3",
    cuda: "12.8",
    torch: "2.9.1+cu128",
    torchaudio: "2.9.1+cu128",
    torchcodec: "0.8.0",
    transformers: "4.57.1",
    accelerate: "1.12.0",
    huggingfaceHub: "0.36.2",
    gradio: "5.44.1",
    pydantic: "2.11.10",
    fastapi: "0.115.12",
    cudnn: "9.10.2.21",
    ffmpeg: "7.1.1",
  },
  modelIdentities: {
    MOSS_MUSIC_INSTRUCT: {
      repository: "OpenMOSS-Team/MOSS-Music-8B-Instruct",
      revision: "fce7f8304e96cc2d3398b8106456cbb2ecec3139",
      role: "DIRECT_MUSICAL_SEMANTIC_REASONING",
    },
    MOSS_MUSIC_THINKING: {
      repository: "OpenMOSS-Team/MOSS-Music-8B-Thinking",
      revision: "2ce899988b94b8ecc5dd0dacbc5ce1874d3500e3",
      role: "DELIBERATE_MUSICAL_SEMANTIC_REASONING",
    },
  },
  fixture: {
    repository: "OpenMOSS/MOSS-Music",
    revision: "ad107c7ddaa06de168a0dfbc18d3e1e6a40c0e5e",
    path: "test/tonghua.mp3",
    git_blob_oid: "cb886c933968ed9dde9d8d74bc7bbcb845dd76a6",
    bytes: 4_027_752,
    sha256: "460f18e2333b27d6aff92cf2dc8181232a34ef5d08212ae74240f1ca93561540",
  },
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
    version: "mt3-pytorch-multitrack",
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

const MIR_WORKER_SOURCE_TREE_SHA256 =
  "a148ba1e1732a065e5e2343306273d77e28403ae39bd213900861978d038a7aa";
const MIR_EVALUATION_FIXTURE_SHA256 =
  "9c5c2715978ccbe3cc8b90738d9d110346ff26f1f2797ab32dba51a8f666dd52";
const MIR_RUNTIME_PY311 = {
  fastapi: "0.141.1",
  librosa: "0.11.0",
  numpy: "1.26.4",
  pydantic: "2.13.5",
  resampy: "0.4.3",
  scipy: "1.13.1",
  soundfile: "0.13.1",
  torch: "2.14.0",
  torchaudio: "2.11.0",
  uvicorn: "0.52.4",
} as const;
const MIR_RUNTIME_PY314 = {
  fastapi: "0.141.1",
  librosa: "1.0.0",
  numpy: "2.5.2",
  pydantic: "2.13.5",
  scipy: "1.18.1",
  soundfile: "0.13.1",
  uvicorn: "0.52.4",
} as const;
const MIR_REQUIREMENTS_LOCK_PY311 =
  "210354042a315551890099c011b375f2ad7df7b5261f9527a16b5176cf2ec2ff";
const MIR_REQUIREMENTS_LOCK_PY314 =
  "e209910f7ef96fa768ebd08e2a7101baaf122c9b7b833707d49604721b3d3d1f";

type VerifiedMirIdentity = Readonly<{
  modelVersion: string;
  checksum: string;
  sourceRepository: string;
  sourceRevision: string;
  packageName: string;
  packageVersion: string;
  packageArtifactSha256: string;
  packageTreeSha256: string;
  pythonVersion: string;
  runtimePackages: Readonly<Record<string, string>>;
  requirementsLockSha256: string;
  license: string;
  licenseClassification: "COMMERCIAL" | "RESEARCH_ONLY";
  licenseSha256: string;
  noticeSha256: string | null;
  commercialUse: boolean;
  modelRepository: string;
  modelRevision: string;
  modelArtifactsSha256: string;
  smokeEvidenceSha256: string;
  resultSha256: string;
}>;

const VERIFIED_MIR_IDENTITIES: Readonly<
  Record<VerifiedMirAnalysisProviderId, VerifiedMirIdentity>
> = {
  MADMOM: {
    modelVersion: "madmom-infer-0.2.0-downbeats-blstm-2016",
    checksum: "321f2953f6c102b6485f191dc8e1c7dec7867b6a5b92c27078528b9529c8fcb9",
    sourceRepository: "https://github.com/openmirlab/madmom-infer",
    sourceRevision: "cb7a1d3f43e0c7ca1ea9c10316c710b32e18e7a",
    packageName: "madmom-infer",
    packageVersion: "0.2.0",
    packageArtifactSha256: "f4013a7ac2135f2f198d97f9e7840db4fbd993e2922f70b28862394c8f8d28f1",
    packageTreeSha256: "65b186bcc2b8700e318720f2067860ee402c3be041c18b2ab082111f628be9cd",
    pythonVersion: "3.11.11",
    runtimePackages: MIR_RUNTIME_PY311,
    requirementsLockSha256: MIR_REQUIREMENTS_LOCK_PY311,
    license: "BSD-2-Clause",
    licenseClassification: "RESEARCH_ONLY",
    licenseSha256: "4eac23726289b6a20602be93e570016dd06e4353bc59a4a00207cf8da4ff2839",
    noticeSha256: "6b8d927d1e7a807c9884e3781888a40de31d3b12c2131afb5c6f9f7c0b9417e3",
    commercialUse: false,
    modelRepository: "https://github.com/CPJKU/madmom",
    modelRevision: "sha256:2cbc981348700f7d75f3c0d9551f1b8381b2a0edd2b1b5da3674f7cec1575807",
    modelArtifactsSha256: "422855d74225017086720b926298de8363f089883cd238062418f5dbeacd1155",
    smokeEvidenceSha256: "12cca65e4ee4aa2dfe33afd93e7b970f823e451456d20e1911e66b519559e9cd",
    resultSha256: "fbacb146b61336f539204b3000255c5c690118272d62e8351b15871110ee1f8e",
  },
  TORCHCREPE: {
    modelVersion: "torchcrepe-0.0.24-full",
    checksum: "736f74980913dc3440b6ca4d582adfc0c9c4523c063a44ccfbf2044076c9144b",
    sourceRepository: "https://pypi.org/project/torchcrepe/0.0.24/",
    sourceRevision: "pypi-wheel-sha256:ec054c23c9d45328f213f93a0131570a3f0e5903e9382792bed95f17a8c36d5a",
    packageName: "torchcrepe",
    packageVersion: "0.0.24",
    packageArtifactSha256: "ec054c23c9d45328f213f93a0131570a3f0e5903e9382792bed95f17a8c36d5a",
    packageTreeSha256: "092a0c98bef33d6581ae86b578211967b48589989b2194529f7aef6584fa6e42",
    pythonVersion: "3.11.11",
    runtimePackages: MIR_RUNTIME_PY311,
    requirementsLockSha256: MIR_REQUIREMENTS_LOCK_PY311,
    license: "MIT",
    licenseClassification: "COMMERCIAL",
    licenseSha256: "2e1d0b22e64e0f0937cb213dbe45b0b02c97d278c4db8bae926ae031325b2417",
    noticeSha256: null,
    commercialUse: true,
    modelRepository: "https://github.com/maxrmorrison/torchcrepe",
    modelRevision: "sha256:08ae0c1856a3ae5037d1a95e5c856659518ae9e10b97ee79296a9ebbabf64936",
    modelArtifactsSha256: "934d3fd30d40a8ed5a8d96cde66958f63b27f0d6f681a4d47e61b5c60e524ac7",
    smokeEvidenceSha256: "9ec8dfb25cbd6cddd9dba246fc287a96cb549b9f72bdf8d2048a6c78e7d74321",
    resultSha256: "e973f5a9de723a579a08baa8b77ea7d0d7dfdd664b33553702860ecb6d7a57c0",
  },
  ESSENTIA: {
    modelVersion: "essentia-2.1b6.dev1438-key-hpcp",
    checksum: "fcce4ef2b3e11796c49377f566af66883d76b7151da678e06d218ea607216850",
    sourceRepository: "https://github.com/MTG/essentia",
    sourceRevision: "8dbdc0735c0dc54fc2c57e083883b4baba7bf272",
    packageName: "essentia",
    packageVersion: "2.1b6.dev1438",
    packageArtifactSha256: "1ee6107fe63fb3b50f8aa68466951f6ca1e162a700d8deffd46ab0506dab9acb",
    packageTreeSha256: "8da7426d8b58cede3564a9fdb9674eb954ac0a909181c16d88ace81da0b0d669",
    pythonVersion: "3.14.0",
    runtimePackages: MIR_RUNTIME_PY314,
    requirementsLockSha256: MIR_REQUIREMENTS_LOCK_PY314,
    license: "AGPL-3.0-only",
    licenseClassification: "COMMERCIAL",
    licenseSha256: "857d4e8afe59718161905db0295c7e09d00674e0be844c2a0500465afbe06521",
    noticeSha256: null,
    commercialUse: true,
    modelRepository: "https://github.com/MTG/essentia",
    modelRevision: "sha256:8da7426d8b58cede3564a9fdb9674eb954ac0a909181c16d88ace81da0b0d669",
    modelArtifactsSha256: "8da7426d8b58cede3564a9fdb9674eb954ac0a909181c16d88ace81da0b0d669",
    smokeEvidenceSha256: "854bc605fc26f56155e0527a2a6092d890859329ab16f6a3e1c5acc5589066f9",
    resultSha256: "14c65b26d90b2574dacb2ca6dada653de4772a7a00f506fd53c7debfea53a13e",
  },
  CHROMA: {
    modelVersion: "essentia-2.1b6.dev1438-hpcp-plus-librosa-1.0.0",
    checksum: "4ad194dcae3a9919251a77128026ec07f51c1b7b6b04f146294498e078bc01d5",
    sourceRepository: "composite:https://github.com/MTG/essentia+https://github.com/librosa/librosa",
    sourceRevision: "essentia@8dbdc0735c0dc54fc2c57e083883b4baba7bf272+librosa@3e4ff7bf5898ac5b326e7dee56463b4b325b91cb",
    packageName: "essentia+librosa",
    packageVersion: "2.1b6.dev1438+1.0.0",
    packageArtifactSha256: "596701e7b643a3f5454e20725bfe6743feb56273b8ac3d7e50db4ea45341e972",
    packageTreeSha256: "842c6916f5cef5f701996c0086c4ff79d553eb74a5c751e3139c4817ed0b371d",
    pythonVersion: "3.14.0",
    runtimePackages: MIR_RUNTIME_PY314,
    requirementsLockSha256: MIR_REQUIREMENTS_LOCK_PY314,
    license: "AGPL-3.0-only + ISC",
    licenseClassification: "COMMERCIAL",
    licenseSha256: "39d84b05db5601ec7e0e62a074685fc540cb889cda251f695e792dd112804c3e",
    noticeSha256: null,
    commercialUse: true,
    modelRepository: "composite:https://github.com/MTG/essentia+https://github.com/librosa/librosa",
    modelRevision: "sha256:62c10b5315ed3e1136f5f908e5d1428d6562ad05c4918d589c827215f60ed975",
    modelArtifactsSha256: "62c10b5315ed3e1136f5f908e5d1428d6562ad05c4918d589c827215f60ed975",
    smokeEvidenceSha256: "78da1a741b5fe2f984203c4a0e8c8346322253262659e1c0024865a4c6e80752",
    resultSha256: "181e6e9c3aea0912ec546305901096c504b22a21a083a442e0a1ed75d57becbf",
  },
  PYLOUDNORM: {
    modelVersion: "pyloudnorm-0.2.0-ebur128",
    checksum: "0f9cb48c78a10c760b2ae2cee033da6c0c78cef2b5d6bcddad8f191a12e65c2e",
    sourceRepository: "https://github.com/csteinmetz1/pyloudnorm",
    sourceRevision: "b8d67bfd3ce5deef872f688fcfa491a0ca69fddd",
    packageName: "pyloudnorm",
    packageVersion: "0.2.0",
    packageArtifactSha256: "9bb69afb904f59d007a7f9ba3d75d16fb8aeef35c44d6df822a9f192d69cf13f",
    packageTreeSha256: "eba032eb536122df592108c3fdaf67484a5bb770579948759c8462dfdfcd156b",
    pythonVersion: "3.11.11",
    runtimePackages: MIR_RUNTIME_PY311,
    requirementsLockSha256: MIR_REQUIREMENTS_LOCK_PY311,
    license: "MIT",
    licenseClassification: "COMMERCIAL",
    licenseSha256: "1616faebaa2add8b57d4f76403c0c4aa427fdb0d241d8e52b7a12dce4906beaa",
    noticeSha256: null,
    commercialUse: true,
    modelRepository: "https://github.com/csteinmetz1/pyloudnorm",
    modelRevision: "sha256:eba032eb536122df592108c3fdaf67484a5bb770579948759c8462dfdfcd156b",
    modelArtifactsSha256: "eba032eb536122df592108c3fdaf67484a5bb770579948759c8462dfdfcd156b",
    smokeEvidenceSha256: "72779a7a48c6945807db305498c7e357a19b996f55142c472b01b5b8e93667e6",
    resultSha256: "bba694e4c4e5ca75760b17377437beecfa26bf9c0e5b58decdec8993771f14f2",
  },
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

function exactStringRecord(
  actual: unknown,
  expected: Readonly<Record<string, string>>,
): boolean {
  if (!record(actual)) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every(
    (key, index) => key === expectedKeys[index] && actual[key] === expected[key],
  );
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)]),
  );
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
  if (
    requestedProvider === "MOSS_MUSIC_INSTRUCT" ||
    requestedProvider === "MOSS_MUSIC_THINKING"
  ) {
    const expected = VERIFIED_MOSS_MUSIC_IDENTITY;
    const sourceRevision = `${expected.sourceRepository}@${expected.sourceRevision}`;
    const sha256 = /^[a-f0-9]{64}$/i;
    if (
      payload.healthy !== true ||
      payload.version !== expected.sourceRevision ||
      payload.modelVersion !== expected.sourceRevision ||
      payload.sourceRevision !== sourceRevision ||
      payload.sglangRevision !== expected.sglangRevision ||
      !exactStringRecord(payload.runtimePackages, expected.runtimePackages) ||
      JSON.stringify(canonicalValue(payload.modelIdentities)) !==
        JSON.stringify(canonicalValue(expected.modelIdentities)) ||
      JSON.stringify(canonicalValue(payload.fixture)) !==
        JSON.stringify(canonicalValue(expected.fixture)) ||
      payload.runtimeReady !== true ||
      payload.packageReady !== true ||
      payload.compatibilityReady !== true ||
      payload.pipCheckPassed !== true ||
      payload.mediaPreflightPassed !== true ||
      payload.checkpointReady !== true ||
      payload.smokeTested !== true ||
      payload.semanticOnly !== true ||
      payload.canonicalTruth !== false ||
      !sha256.test(checksum) ||
      !sha256.test(String(payload.compatibilityEvidenceSha256 ?? "")) ||
      !sha256.test(String(payload.assetManifestSha256 ?? "")) ||
      !sha256.test(String(payload.smokeEvidenceSha256 ?? "")) ||
      payload.imageEvidence !== `sha256:${checksum}`
    ) {
      throw new Error(
        `health response does not match the verified MOSS-Music source, SGLang, runtime, model, asset, compatibility, and real-song smoke identity for ${requestedProvider}`,
      );
    }
    return {
      provider,
      version: expected.sourceRevision,
      checksum,
    };
  }
  const mirExpected = VERIFIED_MIR_IDENTITIES[
    requestedProvider as VerifiedMirAnalysisProviderId
  ];
  if (mirExpected) {
    if (
      payload.ready !== true ||
      payload.modelVersion !== mirExpected.modelVersion ||
      checksum !== mirExpected.checksum ||
      payload.identityChecksum !== mirExpected.checksum ||
      payload.sourceRepository !== mirExpected.sourceRepository ||
      payload.sourceRevision !== mirExpected.sourceRevision ||
      payload.packageName !== mirExpected.packageName ||
      payload.packageVersion !== mirExpected.packageVersion ||
      payload.packageArtifactSha256 !== mirExpected.packageArtifactSha256 ||
      payload.packageTreeSha256 !== mirExpected.packageTreeSha256 ||
      payload.pythonVersion !== mirExpected.pythonVersion ||
      !exactStringRecord(payload.runtimePackages, mirExpected.runtimePackages) ||
      payload.requirementsLockSha256 !== mirExpected.requirementsLockSha256 ||
      payload.license !== mirExpected.license ||
      payload.licenseClassification !== mirExpected.licenseClassification ||
      payload.licenseSha256 !== mirExpected.licenseSha256 ||
      payload.noticeSha256 !== mirExpected.noticeSha256 ||
      payload.commercialUse !== mirExpected.commercialUse ||
      payload.modelRepository !== mirExpected.modelRepository ||
      payload.modelRevision !== mirExpected.modelRevision ||
      payload.modelArtifactsSha256 !== mirExpected.modelArtifactsSha256 ||
      payload.workerSourceTreeSha256 !== MIR_WORKER_SOURCE_TREE_SHA256 ||
      payload.promotionRequired !== false ||
      payload.packageReady !== true ||
      payload.assetReady !== true ||
      payload.assetsVerified !== true ||
      payload.featureExecutionReady !== true ||
      payload.runtimeReady !== true ||
      payload.checkpointReady !== true ||
      payload.smokeTested !== true ||
      payload.smokeProofVerified !== true ||
      payload.identityReady !== true ||
      payload.smokeEvidenceSha256 !== mirExpected.smokeEvidenceSha256 ||
      payload.fixtureSha256 !== MIR_EVALUATION_FIXTURE_SHA256 ||
      payload.resultSha256 !== mirExpected.resultSha256 ||
      payload.reason !== null
    ) {
      throw new Error(
        `health response does not match the exact source, package, runtime, model, worker, and smoke identity for ${requestedProvider}`,
      );
    }
    return {
      provider,
      version: mirExpected.packageVersion,
      checksum,
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
    (
      (requestedProvider === "BASIC_PITCH" || requestedProvider === "DEMUCS") &&
      payload.packageReady !== true
    ) ||
    payload.smokeTested !== true
  ) {
    throw new Error(
      "health response did not verify runtime, package, checkpoint, and smoke test",
    );
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
    requestedProvider === "BASIC_PITCH" &&
    (
      payload.sourceRepository !== VERIFIED_BASIC_PITCH_SOURCE.repository ||
      payload.sourceRevision !== VERIFIED_BASIC_PITCH_SOURCE.revision ||
      payload.license !== VERIFIED_BASIC_PITCH_SOURCE.license ||
      payload.licenseSha256 !== VERIFIED_BASIC_PITCH_SOURCE.licenseSha256 ||
      payload.noticeSha256 !== VERIFIED_BASIC_PITCH_SOURCE.noticeSha256 ||
      payload.packageArtifactSha256 !== VERIFIED_BASIC_PITCH_SOURCE.packageArtifactSha256 ||
      payload.packageTreeSha256 !== VERIFIED_BASIC_PITCH_SOURCE.packageTreeSha256 ||
      payload.inferenceBackend !== VERIFIED_BASIC_PITCH_SOURCE.inferenceBackend ||
      JSON.stringify(payload.runtimePackages) !==
        JSON.stringify(VERIFIED_BASIC_PITCH_SOURCE.runtimePackages)
    )
  ) {
    throw new Error(
      "health response does not match the verified BASIC_PITCH source, license, package, and runtime identity",
    );
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
