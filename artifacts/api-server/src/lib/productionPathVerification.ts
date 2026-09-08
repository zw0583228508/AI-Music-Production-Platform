import { createHash } from "node:crypto";

export type ReleaseVerificationStatus = "passed" | "abstained" | "failed" | "blocked";

export type ReleaseCapabilityEvidence = {
  capability: string;
  status: ReleaseVerificationStatus;
  evidence: {
    inputSha256: string;
    outputSha256: string;
    checks: string[];
  };
  artifactIds: string[];
  provenance: {
    provider: string;
    modelVersion: string;
    runtimeSha256: string;
    runtimeIdentity: string;
    licenseReference: string;
    decisionId: string;
  };
};

export type ProductionPathVerificationInput = {
  fixtureId: string;
  canonicalTimelineSha256: string;
  seed: number;
  repairScopeSha256: string;
  lineageArtifactIds: string[];
  producerDecisionIds: string[];
  retry: {
    seed: number;
    repairScopeSha256: string;
    canonicalTimelineSha256: string;
    stageOutputAggregateSha256: string;
    masterSha256: string;
    exportSha256: string;
    lineageArtifactIds: string[];
    producerDecisionIds: string[];
  };
  audio: {
    sourceSha256: string;
    masterSha256: string;
    peak: number;
    activeFrameRatio: number;
    controlBaselineSha256: string;
    controlVariantSha256: string;
    controlDeltaRms: number;
  };
  capabilities: ReleaseCapabilityEvidence[];
};

export type ProductionPathReleaseReport = {
  contractVersion: "1.0";
  fixtureId: string;
  verificationId: string;
  releaseReady: boolean;
  summary: Record<ReleaseVerificationStatus, number>;
  invariants: {
    deterministicRecovery: boolean;
    lineagePreserved: boolean;
    producerDecisionsPreserved: boolean;
    outputAudible: boolean;
    outputNotCopied: boolean;
    producerControlsAudible: boolean;
    masterEvidenceBound: boolean;
  };
  evidence: {
    canonicalTimelineSha256: string;
    seed: number;
    repairScopeSha256: string;
    lineageArtifactIds: string[];
    producerDecisionIds: string[];
    retry: ProductionPathVerificationInput["retry"];
    audio: ProductionPathVerificationInput["audio"];
  };
  capabilities: ReleaseCapabilityEvidence[];
  blockers: string[];
};

const sha256Pattern = /^[a-f0-9]{64}$/;
const safeIdentifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const credentialShapePattern =
  /^(?:sk-|pk_|rk_|gh[pousr]_|xox[baprs]-)|(?:^|[._:-])(?:token|secret|password|bearer)(?:$|[._:-])|^[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}$/i;
export const REQUIRED_PRODUCTION_CAPABILITIES = [
  "analysis",
  "phrase_intelligence",
  "hierarchical_planning",
  "candidate_generation",
  "critique",
  "bounded_repair",
  "performance",
  "mix",
  "master",
  "export",
] as const;
const OPTIONAL_PRODUCTION_CAPABILITIES = new Set(["lyrics_alignment"]);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stageOutputAggregate(capabilities: ReleaseCapabilityEvidence[]): string {
  return createHash("sha256").update(JSON.stringify(
    capabilities
      .map((item) => [item.capability, item.evidence.outputSha256])
      .sort(([left], [right]) => left.localeCompare(right)),
  )).digest("hex");
}

function safeEvidence(value: ReleaseCapabilityEvidence): ReleaseCapabilityEvidence {
  const identifiers = [
    value.capability,
    ...value.artifactIds,
    value.provenance?.provider,
    value.provenance?.modelVersion,
    value.provenance?.runtimeIdentity,
    value.provenance?.licenseReference,
    value.provenance?.decisionId,
  ];
  if (identifiers.some((item) =>
    typeof item !== "string" ||
    !safeIdentifierPattern.test(item) ||
    credentialShapePattern.test(item))) {
    throw new Error(`Capability ${value.capability || "(missing)"} contains an unsafe identifier`);
  }
  if (
    value.evidence?.checks.length === 0 ||
    value.evidence?.checks.some((check) =>
      !safeIdentifierPattern.test(check) || credentialShapePattern.test(check)) ||
    !sha256Pattern.test(value.evidence?.inputSha256 ?? "") ||
    !sha256Pattern.test(value.evidence?.outputSha256 ?? "") ||
    !sha256Pattern.test(value.provenance?.runtimeSha256 ?? "")
  ) {
    throw new Error(`Capability ${value.capability} requires valid evidence and runtime checksums`);
  }
  if (!value.artifactIds.length) {
    throw new Error(`Capability ${value.capability} requires artifact evidence`);
  }
  return {
    capability: value.capability,
    status: value.status,
    evidence: {
      inputSha256: value.evidence.inputSha256,
      outputSha256: value.evidence.outputSha256,
      checks: [...new Set(value.evidence.checks)].sort(),
    },
    artifactIds: [...new Set(value.artifactIds)].sort(),
    provenance: { ...value.provenance },
  };
}

/**
 * Builds the public release gate from already-verified stage evidence.
 * The allow-listed output deliberately cannot serialize provider errors,
 * credentials, fingerprints, detailed critic scores, or private object paths.
 */
export function buildProductionPathReleaseReport(
  input: ProductionPathVerificationInput,
): ProductionPathReleaseReport {
  if (!sha256Pattern.test(input.canonicalTimelineSha256)) {
    throw new Error("A canonical timeline checksum is required");
  }
  for (const checksum of [
    input.repairScopeSha256,
    input.retry.repairScopeSha256,
    input.retry.canonicalTimelineSha256,
    input.retry.stageOutputAggregateSha256,
    input.retry.masterSha256,
    input.retry.exportSha256,
    input.audio.sourceSha256,
    input.audio.masterSha256,
    input.audio.controlBaselineSha256,
    input.audio.controlVariantSha256,
  ]) {
    if (!sha256Pattern.test(checksum)) throw new Error("Release evidence contains an invalid checksum");
  }
  if (
    !Number.isSafeInteger(input.seed) ||
    input.seed < 0 ||
    !Number.isSafeInteger(input.retry.seed) ||
    input.retry.seed < 0 ||
    !Number.isFinite(input.audio.peak) ||
    input.audio.peak < 0 ||
    input.audio.peak > 1 ||
    !Number.isFinite(input.audio.activeFrameRatio) ||
    input.audio.activeFrameRatio < 0 ||
    input.audio.activeFrameRatio > 1 ||
    !Number.isFinite(input.audio.controlDeltaRms) ||
    input.audio.controlDeltaRms < 0 ||
    !safeIdentifierPattern.test(input.fixtureId) ||
    credentialShapePattern.test(input.fixtureId) ||
    input.lineageArtifactIds.length === 0 ||
    input.producerDecisionIds.length === 0 ||
    [...input.lineageArtifactIds, ...input.retry.lineageArtifactIds,
      ...input.producerDecisionIds, ...input.retry.producerDecisionIds]
      .some((item) => !safeIdentifierPattern.test(item) || credentialShapePattern.test(item))
  ) {
    throw new Error("Release evidence requires safe, non-empty lineage and decision identifiers");
  }
  const capabilities = input.capabilities.map(safeEvidence);
  if (capabilities.some((item) =>
    !["passed", "abstained", "failed", "blocked"].includes(item.status))) {
    throw new Error("Release evidence contains an invalid capability status");
  }
  const names = new Set(capabilities.map((item) => item.capability));
  if (names.size !== capabilities.length) {
    throw new Error("Release verification capabilities must be unique");
  }
  const unknown = capabilities.filter((item) =>
    !REQUIRED_PRODUCTION_CAPABILITIES.includes(
      item.capability as (typeof REQUIRED_PRODUCTION_CAPABILITIES)[number],
    ) && !OPTIONAL_PRODUCTION_CAPABILITIES.has(item.capability));
  if (unknown.length) throw new Error(`Unknown release capability: ${unknown[0].capability}`);
  const missing = REQUIRED_PRODUCTION_CAPABILITIES.filter((name) => !names.has(name));
  if (missing.length) throw new Error(`Missing required release capability: ${missing[0]}`);
  const lineage = new Set(input.lineageArtifactIds);
  const decisions = new Set(input.producerDecisionIds);
  for (const capability of capabilities) {
    if (capability.artifactIds.some((id) => !lineage.has(id))) {
      throw new Error(`Capability ${capability.capability} references evidence outside release lineage`);
    }
    if (!decisions.has(capability.provenance.decisionId)) {
      throw new Error(`Capability ${capability.capability} references an unretained producer decision`);
    }
  }

  const deterministicRecovery =
    input.seed === input.retry.seed &&
    input.repairScopeSha256 === input.retry.repairScopeSha256 &&
    input.canonicalTimelineSha256 === input.retry.canonicalTimelineSha256 &&
    stageOutputAggregate(capabilities) === input.retry.stageOutputAggregateSha256 &&
    input.audio.masterSha256 === input.retry.masterSha256 &&
    capabilities.find((item) => item.capability === "export")?.evidence.outputSha256 ===
      input.retry.exportSha256;
  const lineagePreserved =
    canonicalJson([...new Set(input.lineageArtifactIds)].sort()) ===
      canonicalJson([...new Set(input.retry.lineageArtifactIds)].sort());
  const producerDecisionsPreserved =
    canonicalJson([...new Set(input.producerDecisionIds)].sort()) ===
      canonicalJson([...new Set(input.retry.producerDecisionIds)].sort());
  const outputAudible =
    Number.isFinite(input.audio.peak) &&
    input.audio.peak > 0.0005 &&
    input.audio.activeFrameRatio >= 0.005;
  const outputNotCopied = input.audio.sourceSha256 !== input.audio.masterSha256;
  const producerControlsAudible =
    input.audio.controlBaselineSha256 !== input.audio.controlVariantSha256 &&
    Number.isFinite(input.audio.controlDeltaRms) &&
    input.audio.controlDeltaRms >= 0.0001;
  const masterEvidenceBound =
    capabilities.find((item) => item.capability === "master")?.evidence.outputSha256 ===
      input.audio.masterSha256 &&
    input.audio.masterSha256 === input.audio.controlVariantSha256 &&
    input.audio.masterSha256 === input.retry.masterSha256;
  const invariants = {
    deterministicRecovery,
    lineagePreserved,
    producerDecisionsPreserved,
    outputAudible,
    outputNotCopied,
    producerControlsAudible,
    masterEvidenceBound,
  };

  const blockers = [
    ...Object.entries(invariants)
      .filter(([, passed]) => !passed)
      .map(([name]) => `Invariant failed: ${name}`),
    ...capabilities
      .filter((item) =>
        item.status === "failed" ||
        item.status === "blocked" ||
        (
          item.status === "abstained" &&
          REQUIRED_PRODUCTION_CAPABILITIES.includes(
            item.capability as (typeof REQUIRED_PRODUCTION_CAPABILITIES)[number],
          )
        ))
      .map((item) =>
        `${REQUIRED_PRODUCTION_CAPABILITIES.includes(
          item.capability as (typeof REQUIRED_PRODUCTION_CAPABILITIES)[number],
        ) ? "Required" : "Optional"} capability ${item.capability} is ${item.status}`),
  ];
  const summary = { passed: 0, abstained: 0, failed: 0, blocked: 0 };
  for (const capability of capabilities) summary[capability.status] += 1;
  const reportWithoutId = {
    contractVersion: "1.0" as const,
    fixtureId: input.fixtureId,
    releaseReady: blockers.length === 0,
    summary,
    invariants,
    evidence: {
      canonicalTimelineSha256: input.canonicalTimelineSha256,
      seed: input.seed,
      repairScopeSha256: input.repairScopeSha256,
      lineageArtifactIds: [...new Set(input.lineageArtifactIds)].sort(),
      producerDecisionIds: [...new Set(input.producerDecisionIds)].sort(),
      retry: {
        seed: input.retry.seed,
        repairScopeSha256: input.retry.repairScopeSha256,
        canonicalTimelineSha256: input.retry.canonicalTimelineSha256,
        stageOutputAggregateSha256: input.retry.stageOutputAggregateSha256,
        masterSha256: input.retry.masterSha256,
        exportSha256: input.retry.exportSha256,
        lineageArtifactIds: [...new Set(input.retry.lineageArtifactIds)].sort(),
        producerDecisionIds: [...new Set(input.retry.producerDecisionIds)].sort(),
      },
      audio: {
        sourceSha256: input.audio.sourceSha256,
        masterSha256: input.audio.masterSha256,
        peak: input.audio.peak,
        activeFrameRatio: input.audio.activeFrameRatio,
        controlBaselineSha256: input.audio.controlBaselineSha256,
        controlVariantSha256: input.audio.controlVariantSha256,
        controlDeltaRms: input.audio.controlDeltaRms,
      },
    },
    capabilities,
    blockers,
  };
  return {
    ...reportWithoutId,
    verificationId: createHash("sha256")
      .update(canonicalJson({
        ...reportWithoutId,
      }))
      .digest("hex"),
  };
}