import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  calibrationActivationHistoryTable,
  calibrationActivePointersTable,
  calibrationVersionsTable,
  db,
  musicProjectsTable,
  producerDecisionsTable,
  producerPreferencesTable,
  producerPreferenceVersionsTable,
} from "@workspace/db";
import {
  appendProducerDecision,
  appendProducerDecisionTx,
  activeGenerationPreferenceForOwner,
  buildCalibrationDataset,
  canPromoteCalibration,
  compareCalibrationOnHeldOut,
  learningWriteAllowed,
  heldOutAgreement,
  generationPreferenceSnapshot,
  privateDecisionContext,
  promoteCalibration,
  rollbackCalibration,
  updatePreferences,
  validateCalibrationWeights,
} from "./producerDecisionLedger";
import { rankEvaluatedCandidates } from "./candidateRanking";
import { sectionsHavePerformanceChanges } from "./arrangementRevisions";

describe("producer decision ledger privacy", () => {
  it("keeps only stable IDs and hashes in public decision context", () => {
    assert.deepEqual(privateDecisionContext({
      subjectId: "candidate-1",
      evidenceIds: ["artifact-1"],
      lineageIds: ["job-1"],
      modelVersion: "model-2",
      evidenceSha256: "a".repeat(64),
      // Type-level callers cannot provide paths; this confirms no broad object
      // is copied through this explicit allow-list boundary.
      ...({ objectPath: "/objects/private.wav", url: "https://secret" } as object),
    }), {
      subjectId: "candidate-1",
      comparedSubjectId: null,
      modelVersion: "model-2",
      evidenceIds: ["artifact-1"],
      lineageIds: ["job-1"],
      evidenceSha256: "a".repeat(64),
      rankingScore: null,
      criticScore: null,
    });
  });
});

describe("arrangement performance edit classification", () => {
  const sections = () => [{
    name: "Verse", energy: 0.5, density: 0.5, tracks: ["piano"],
    midiNotes: [{
      id: "legacy-1", pitch: 60, start: 0, duration: 1,
      velocity: 90, articulation: "legato",
    }],
    cc: [64],
    midiTracks: {
      piano: {
        notes: [{
          id: "note-1", pitch: 64, start: 1, duration: 2,
          velocity: 88, articulation: "staccato",
        }],
        cc: [32, 96],
      },
    },
  }];

  it("returns false for deeply unchanged sections", () => {
    const before = sections();
    assert.equal(
      sectionsHavePerformanceChanges(before, structuredClone(before)),
      false,
    );
  });

  it("detects note, velocity, articulation, and CC changes", () => {
    const mutations = [
      (value: ReturnType<typeof sections>) => { value[0].midiTracks.piano.notes[0].pitch += 1; },
      (value: ReturnType<typeof sections>) => { value[0].midiNotes[0].velocity += 1; },
      (value: ReturnType<typeof sections>) => { value[0].midiTracks.piano.notes[0].articulation = "accent"; },
      (value: ReturnType<typeof sections>) => { value[0].midiTracks.piano.cc[0] += 1; },
    ];
    for (const mutate of mutations) {
      const before = sections();
      const after = structuredClone(before);
      mutate(after);
      assert.equal(sectionsHavePerformanceChanges(before, after), true);
    }
  });
});

test("learning opt-out blocks explicit and inferred writes but not non-learning evidence", () => {
  const disabled = { learningEnabled: false, inferredBehaviorEnabled: true };
  assert.equal(learningWriteAllowed(disabled, "explicit_feedback"), false);
  assert.equal(learningWriteAllowed(disabled, "inferred_behavior"), false);
  assert.equal(learningWriteAllowed(disabled, "objective_evidence"), true);
});

test("approved calibration becomes an immutable bounded generation preference", () => {
  const input = {
    id: "calibration-7",
    version: 7,
    rankingWeight: .9,
    criticWeight: .1,
    heldOutAgreement: .82,
    baselineAgreement: .74,
    heldOutExamples: 6,
    evaluationSha256: "e".repeat(64),
    status: "immutable",
    promotedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const first = generationPreferenceSnapshot(input);
  const second = generationPreferenceSnapshot(structuredClone(input));
  assert.deepEqual(first, second);
  assert.equal(first.calibrationId, input.id);
  assert.equal(first.calibrationVersion, input.version);
  assert.equal(first.effects.roleEmphasis, "counterline");
  assert.equal(first.effects.voicingCharacter, "wide");
  assert.ok(first.effects.orchestrationDensity <= .18);
  assert.ok(first.effects.responseFrequency >= .25 && first.effects.responseFrequency <= .75);
  assert.match(first.evidenceSha256, /^[a-f0-9]{64}$/);
});

describe("calibrated candidate ranking", () => {
  const evaluation = (critic: number, quality: number, complete = true) => {
    const dimension = { status: "unavailable", score: null, evidence: [], explanation: "", findings: [] };
    return {
      status: complete ? "evaluated" : "rendering", providerScore: 0, error: null,
      renderArtifactIds: ["audio"], artifacts: [{ id: "audio", type: "AUDIO_TRACK", url: "safe" }, { id: "report", type: "QUALITY_REPORT", url: "safe" }],
      qualityReport: { score: quality, checks: { silence: 1, clipping: 1, notePlayability: 1, timing: 1, sectionCoverage: 1, lineage: 1 }, weights: { silence: 1, clipping: 1, notePlayability: 1, timing: 1, sectionCoverage: 1, lineage: 1 }, strengths: [], weaknesses: [], warnings: [], evaluatedAt: new Date().toISOString(), renderArtifactIds: ["audio"], lineageComplete: true },
      musicCritic: { score: critic, dimensions: Object.fromEntries(["vocalFit", "harmony", "development", "contrastAndTransitions", "registerCollisions", "playability", "repetition", "styleAndControlAdherence"].map((key) => [key, dimension])) },
      audioCritic: null,
    } as never;
  };
  it("preserves default ordering, changes with calibration, and never ranks incomplete evidence", () => {
    const candidates = [{ id: "a", score: 0, evaluation: evaluation(0.9, 0.1) }, { id: "b", score: 0, evaluation: evaluation(0.6, 0.9) }, { id: "c", score: 0, evaluation: evaluation(1, 1, false) }];
    assert.equal(rankEvaluatedCandidates(candidates)[0].id, "a");
    assert.equal(rankEvaluatedCandidates(candidates, { rankingWeight: 0.1, criticWeight: 0.9 })[0].id, "a");
    assert.equal(rankEvaluatedCandidates(candidates, { rankingWeight: 0.9, criticWeight: 0.1 })[0].id, "b");
    assert.equal(rankEvaluatedCandidates(candidates).find((candidate) => candidate.id === "c")?.rank, null);
  });
});

describe("deterministic calibration dataset", () => {
  const row = (id: string, source: string, kind: string, rating: number | null) => ({
    id, source, kind, rating, context: privateDecisionContext({
      rankingScore: 0.8, criticScore: 0.7, evidenceIds: [id],
    }),
  }) as never;
  it("has stable hash splits and never uses non-explicit labels", () => {
    const rows = [row("one", "explicit_feedback", "approval", null), row("two", "explicit_feedback", "rejection", null), row("ignored", "objective_evidence", "approval", 5)];
    assert.deepEqual(buildCalibrationDataset(rows), buildCalibrationDataset(rows));
    assert.equal(buildCalibrationDataset(rows).length, 2);
  });
  it("rejects invalid weights and makes held-out scoring deterministic", () => {
    assert.throws(() => validateCalibrationWeights(0.8, 0.8));
    const examples = [{ id: "x", label: true, rankingScore: 1, criticScore: 1, split: "held_out" as const }];
    assert.deepEqual(heldOutAgreement(examples, 0.5, 0.5), { examples: 1, heldOutAgreement: 1 });
    assert.equal(canPromoteCalibration({ examples: 5, heldOutAgreement: 0.61 }, 0.6), false);
    assert.equal(canPromoteCalibration({ examples: 5, heldOutAgreement: 0.62 }, 0.6), true);
  });
  it("rejects a worse first calibration and accepts one better than the deployed default", () => {
    const examples = Array.from({ length: 5 }, (_, index) => ({
      id: String(index),
      label: true,
      rankingScore: 0.9,
      criticScore: 0,
      split: "held_out" as const,
    }));
    const worse = compareCalibrationOnHeldOut(examples, {
      rankingWeight: 0.1,
      criticWeight: 0.9,
    });
    assert.equal(
      canPromoteCalibration(
        worse.proposal,
        worse.baseline.heldOutAgreement,
      ),
      false,
    );
    const better = compareCalibrationOnHeldOut(examples, {
      rankingWeight: 0.9,
      criticWeight: 0.1,
    });
    assert.equal(
      canPromoteCalibration(
        better.proposal,
        better.baseline.heldOutAgreement,
      ),
      true,
    );
  });
});

describe("producer decision database concurrency", () => {
  it("keeps historical promoted calibrations ranking-only when audit evidence is absent", async () => {
    const ownerId = randomUUID();
    const calibrationId = randomUUID();
    try {
      await db.insert(calibrationVersionsTable).values({
        id: calibrationId,
        ownerId,
        version: 1,
        rankingWeight: .9,
        criticWeight: .1,
        heldOutAgreement: .8,
        baselineAgreement: .7,
        status: "immutable",
        promotedAt: new Date(),
      });
      await db.insert(calibrationActivePointersTable).values({
        ownerId,
        calibrationVersionId: calibrationId,
      });
      assert.equal(await activeGenerationPreferenceForOwner(ownerId), null);
    } finally {
      await db.delete(calibrationActivePointersTable)
        .where(eq(calibrationActivePointersTable.ownerId, ownerId));
      await db.delete(calibrationVersionsTable)
        .where(eq(calibrationVersionsTable.ownerId, ownerId));
    }
  });

  it("stores multiple repair decisions for one owner in a single transaction", async () => {
    const ownerId = randomUUID();
    const projectId = randomUUID();
    await db.insert(musicProjectsTable).values({
      id: projectId,
      name: "Producer decision repair fixture",
      sourceType: "AUDIO",
      ownerId,
    });
    try {
      await db.transaction(async (tx) => {
        for (const candidateId of ["repair-a", "repair-b"]) {
          await appendProducerDecisionTx(tx, {
            ownerId,
            projectId,
            domain: "repair",
            kind: "repair_completed",
            source: "inferred_behavior",
            context: { subjectId: "source", comparedSubjectId: candidateId },
          });
        }
      });
      const rows = await db.select().from(producerDecisionsTable)
        .where(eq(producerDecisionsTable.ownerId, ownerId));
      assert.equal(rows.length, 2);
    } finally {
      await db.delete(musicProjectsTable).where(eq(musicProjectsTable.id, projectId));
    }
  });

  it("serializes concurrent preference versions and calibration promotion", async () => {
    const ownerId = randomUUID();
    const projectId = randomUUID();
    await db.insert(musicProjectsTable).values({
      id: projectId,
      name: "Producer decision calibration fixture",
      sourceType: "AUDIO",
      ownerId,
    });
    try {
      await Promise.all([
        updatePreferences(ownerId, { learningEnabled: true, inferredBehaviorEnabled: true }),
        updatePreferences(ownerId, { learningEnabled: true, inferredBehaviorEnabled: false }),
      ]);
      const preferenceVersions = await db.select().from(producerPreferenceVersionsTable)
        .where(eq(producerPreferenceVersionsTable.ownerId, ownerId));
      assert.deepEqual(
        preferenceVersions.map((row) => row.version).sort((a, b) => a - b),
        [1, 2],
      );

      const heldOutIds: string[] = [];
      for (let index = 0; heldOutIds.length < 5; index += 1) {
        const id = `${ownerId}:${index}`;
        const bucket = Number.parseInt(
          createHash("sha256").update(JSON.stringify(id)).digest("hex").slice(0, 8),
          16,
        ) % 5;
        if (bucket === 0) heldOutIds.push(id);
      }
      await db.insert(producerDecisionsTable).values(heldOutIds.map((id) => ({
        id,
        ownerId,
        projectId,
        domain: "candidate",
        kind: "approval",
        source: "explicit_feedback" as const,
        context: privateDecisionContext({ rankingScore: 0.9, criticScore: 0 }),
      })));
      const promotions = await Promise.allSettled([
        promoteCalibration(ownerId, 0.9, 0.1),
        promoteCalibration(ownerId, 0.9, 0.1),
      ]);
      assert.equal(promotions.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(promotions.filter((result) => result.status === "rejected").length, 1);
      const calibrations = await db.select().from(calibrationVersionsTable)
        .where(eq(calibrationVersionsTable.ownerId, ownerId));
      assert.equal(calibrations.length, 1);
    } finally {
      await db.delete(calibrationActivationHistoryTable)
        .where(eq(calibrationActivationHistoryTable.ownerId, ownerId));
      await db.delete(calibrationActivePointersTable)
        .where(eq(calibrationActivePointersTable.ownerId, ownerId));
      await db.delete(calibrationVersionsTable)
        .where(eq(calibrationVersionsTable.ownerId, ownerId));
      await db.delete(producerPreferenceVersionsTable)
        .where(eq(producerPreferenceVersionsTable.ownerId, ownerId));
      await db.delete(producerPreferencesTable)
        .where(eq(producerPreferencesTable.ownerId, ownerId));
      await db.delete(musicProjectsTable).where(eq(musicProjectsTable.id, projectId));
    }
  });

  it("rejects concurrent explicit and inferred writes after opt-out completes", async () => {
    const ownerId = randomUUID();
    const projectId = randomUUID();
    await db.insert(musicProjectsTable).values({
      id: projectId,
      name: "Producer decision opt-out fixture",
      sourceType: "AUDIO",
      ownerId,
    });
    try {
      await updatePreferences(ownerId, {
        learningEnabled: false,
        inferredBehaviorEnabled: false,
      });
      const results = await Promise.all([
        appendProducerDecision({
          ownerId,
          projectId,
          domain: "candidate",
          kind: "approval",
          source: "explicit_feedback",
        }),
        appendProducerDecision({
          ownerId,
          projectId,
          domain: "arrangement",
          kind: "edit",
          source: "inferred_behavior",
        }),
      ]);
      assert.deepEqual(results, [null, null]);
      const rows = await db.select().from(producerDecisionsTable)
        .where(eq(producerDecisionsTable.ownerId, ownerId));
      assert.equal(rows.length, 0);
    } finally {
      await db.delete(producerPreferenceVersionsTable)
        .where(eq(producerPreferenceVersionsTable.ownerId, ownerId));
      await db.delete(producerPreferencesTable)
        .where(eq(producerPreferencesTable.ownerId, ownerId));
      await db.delete(musicProjectsTable).where(eq(musicProjectsTable.id, projectId));
    }
  });

  it("allocates a new version above history after rollback", async () => {
    const ownerId = randomUUID();
    const projectId = randomUUID();
    const firstId = randomUUID();
    const secondId = randomUUID();
    await db.insert(musicProjectsTable).values({
      id: projectId,
      name: "Producer decision rollback fixture",
      sourceType: "AUDIO",
      ownerId,
    });
    try {
      const heldOutIds: string[] = [];
      for (let index = 0; heldOutIds.length < 5; index += 1) {
        const id = `${ownerId}:rollback:${index}`;
        const bucket = Number.parseInt(
          createHash("sha256").update(JSON.stringify(id)).digest("hex").slice(0, 8),
          16,
        ) % 5;
        if (bucket === 0) heldOutIds.push(id);
      }
      await db.insert(producerDecisionsTable).values(heldOutIds.map((id) => ({
        id,
        ownerId,
        projectId,
        domain: "candidate",
        kind: "approval",
        source: "explicit_feedback" as const,
        context: privateDecisionContext({ rankingScore: 0.9, criticScore: 0 }),
      })));
      await db.insert(calibrationVersionsTable).values([
        {
          id: firstId,
          ownerId,
          version: 1,
          rankingWeight: 0.5,
          criticWeight: 0.5,
          heldOutAgreement: .8,
          baselineAgreement: .7,
          heldOutExamples: 5,
          evaluationSha256: "a".repeat(64),
          status: "immutable",
          promotedAt: new Date(),
        },
        {
          id: secondId,
          ownerId,
          version: 2,
          rankingWeight: 0.1,
          criticWeight: 0.9,
          heldOutAgreement: .8,
          baselineAgreement: .7,
          heldOutExamples: 5,
          evaluationSha256: "b".repeat(64),
          status: "immutable",
          promotedAt: new Date(),
        },
      ]);
      await db.insert(calibrationActivePointersTable).values({
        ownerId,
        calibrationVersionId: secondId,
      });
      assert.equal((await rollbackCalibration(ownerId, firstId))?.version, 1);
      const promoted = await promoteCalibration(ownerId, 0.9, 0.1);
      assert.equal(promoted.version, 3);
    } finally {
      await db.delete(calibrationActivationHistoryTable)
        .where(eq(calibrationActivationHistoryTable.ownerId, ownerId));
      await db.delete(calibrationActivePointersTable)
        .where(eq(calibrationActivePointersTable.ownerId, ownerId));
      await db.delete(calibrationVersionsTable)
        .where(eq(calibrationVersionsTable.ownerId, ownerId));
      await db.delete(musicProjectsTable).where(eq(musicProjectsTable.id, projectId));
    }
  });
});