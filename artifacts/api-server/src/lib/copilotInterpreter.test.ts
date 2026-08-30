import assert from "node:assert/strict";
import test from "node:test";
import { interpretCopilotCommand } from "./copilotInterpreter";

async function withoutOpenAi<T>(operation: () => Promise<T>) {
  const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  try {
    return await operation();
  } finally {
    if (baseUrl === undefined) delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    else process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = baseUrl;
    if (apiKey === undefined) delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    else process.env.AI_INTEGRATIONS_OPENAI_API_KEY = apiKey;
  }
}

test("keeps every deterministic operation inside the selected scope", async () => {
  const result = await withoutOpenAi(() => interpretCopilotCommand(
    "Make this section bigger, reharmonize it, and add a cello countermelody",
    {
      targetSection: "Bridge",
      startBar: 33,
      endBar: 40,
      sectionNames: ["Verse 1", "Bridge", "Final Chorus"],
      trackNames: ["Piano", "Strings"],
    },
  ));
  assert.equal(result.interpreter, "deterministic");
  assert.ok(result.operations.length >= 3);
  assert.ok(result.operations.every((operation) =>
    operation.targetSection === "Bridge" &&
    operation.startBar === 33 &&
    operation.endBar === 40
  ));
  assert.deepEqual(result.affectedSections, ["Bridge"]);
});

test("targets an existing drum track instead of inventing one", async () => {
  const result = await withoutOpenAi(() => interpretCopilotCommand(
    "Remove drums from the verse",
    {
      sectionNames: ["Verse 1", "Chorus"],
      trackNames: ["Lead Vocal", "Drum Kit", "Bass"],
    },
  ));
  assert.equal(result.operations[0]?.type, "REMOVE_TRACK");
  assert.equal(result.operations[0]?.targetTrack, "Drum Kit");
  assert.deepEqual(result.affectedSections, ["Verse 1"]);
});

test("falls back to a harmless refinement for unsupported requests", async () => {
  const result = await withoutOpenAi(() => interpretCopilotCommand(
    "Make it feel more emotionally inevitable",
    {
      sectionNames: ["Full Song"],
      trackNames: ["Piano"],
    },
  ));
  assert.deepEqual(result.operations.map((operation) => operation.type), ["REFINE_ARRANGEMENT"]);
  assert.equal(result.interpreter, "deterministic");
});