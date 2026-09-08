import assert from "node:assert/strict";
import test from "node:test";
import type { GenerationCandidate } from "@workspace/api-client-react";
import {
  isRepairEligible,
  repairLineageLabel,
  repairOutcomeTitle,
  retainedRepairSourceForJob,
  resolveRepairSourceCandidate,
} from "./project-workspace-repair";

function candidate(overrides: Partial<GenerationCandidate> = {}): GenerationCandidate {
  return {
    id: "source-candidate-1234",
    jobId: "source-job",
    label: "Original Groove",
    status: "validated",
    plan: {
      sections: [
        { name: "Verse", startBar: 1, endBar: 8 },
        { name: "Chorus", startBar: 9, endBar: 16 },
      ],
      tracks: [],
    },
    trackModels: [
      { id: "drums", instrument: "Drums" },
      { id: "bass", instrument: "Bass" },
    ],
    evaluation: {},
    ...overrides,
  } as GenerationCandidate;
}

test("only eligible critic dimensions offer a bounded repair", () => {
  const source = candidate();
  const finding = {
    id: "music-critic-v1:groove:Chorus:9-12:drums",
    affectedSections: ["Chorus"],
    startBar: 9,
    endBar: 12,
    affectedTrackIds: ["drums"],
    musicalReason: "The chorus rushes the backbeat.",
  };
  assert.ok(finding);
  assert.equal(isRepairEligible(source, { status: "available", score: 0.72 }, null, finding), true);
  assert.equal(isRepairEligible(source, { status: "failed", score: null }, null, finding), false);
  assert.equal(isRepairEligible(source, { status: "available", score: 1 }, null, finding), false);
  assert.equal(isRepairEligible(candidate({ status: "selected" }), { status: "available", score: 0.72 }, null, finding), false);
  assert.equal(isRepairEligible(source, { status: "available", score: 0.72 }, { improved: false }, finding), false);
  assert.equal(isRepairEligible(source, { status: "available", score: 0.72 }, null, null), false);
});

test("progress and unsuccessful outcomes retain the original candidate", () => {
  const source = candidate();
  assert.equal(retainedRepairSourceForJob("queued", 0, source), source);
  assert.equal(retainedRepairSourceForJob("running", 0, source), source);
  assert.equal(retainedRepairSourceForJob("failed", 0, source), source);
  assert.equal(retainedRepairSourceForJob("succeeded", 1, source), null);
  assert.equal(
    repairOutcomeTitle({ outsideScopePreserved: true, improved: false }),
    "Repair did not improve the candidate",
  );
  assert.equal(
    repairOutcomeTitle({ outsideScopePreserved: false, improved: true }),
    "Repair violated its scope",
  );
});

test("successful repair identifies its parent immediately and after reload", () => {
  const source = candidate();
  const repaired = candidate({
    id: "repaired-candidate",
    evaluation: {
      repair: { sourceCandidateId: source.id },
    },
  } as Partial<GenerationCandidate>);

  assert.equal(repairLineageLabel(source.id, undefined, source), "Repair of Original Groove");
  const reloadedSource = resolveRepairSourceCandidate(null, [source], [repaired]);
  assert.equal(reloadedSource?.id, source.id);
  assert.equal(repairLineageLabel(source.id, undefined, reloadedSource), "Repair of Original Groove");
  assert.equal(
    repairLineageLabel(source.id, source.label, null),
    "Repair of Original Groove",
  );
});

test("queued and failed rendering paths retain a reload-derived source", () => {
  const source = candidate();
  const repaired = candidate({
    id: "repaired-candidate",
    evaluation: {
      repair: { sourceCandidateId: source.id },
    },
  } as Partial<GenerationCandidate>);
  const reloadedSource = resolveRepairSourceCandidate(null, [source], [repaired]);

  assert.equal(retainedRepairSourceForJob("queued", 0, reloadedSource)?.label, "Original Groove");
  assert.equal(retainedRepairSourceForJob("running", 0, reloadedSource)?.label, "Original Groove");
  assert.equal(retainedRepairSourceForJob("failed", 0, reloadedSource)?.label, "Original Groove");
});
