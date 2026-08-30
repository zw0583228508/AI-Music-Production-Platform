import assert from "node:assert/strict";
import test from "node:test";
import { interpretCopilotCommand } from "./copilotInterpreter";

let activeOpenAiFetch: typeof fetch = async () => {
  throw new Error("No OpenAI fetch mock configured");
};
const dispatchOpenAiFetch: typeof fetch = (...args) => activeOpenAiFetch(...args);

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

async function withMockedOpenAi<T>(
  fetchMock: typeof fetch,
  operation: () => Promise<T>,
) {
  const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "https://mock-openai.test/v1";
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "test-key";
  activeOpenAiFetch = fetchMock;
  globalThis.fetch = dispatchOpenAiFetch;
  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
    if (baseUrl === undefined) delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    else process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = baseUrl;
    if (apiKey === undefined) delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    else process.env.AI_INTEGRATIONS_OPENAI_API_KEY = apiKey;
  }
}

test("uses OpenAI when configured and reports provider provenance", async () => {
  const result = await withMockedOpenAi(
    async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            reply: "AI prepared a focused arrangement change.",
            operations: [{ type: "SET_SECTION_ENERGY", label: "Raise section energy" }],
            affectedSections: ["Bridge"],
          }),
        },
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    () => interpretCopilotCommand(
      "Make the bridge bigger",
      {
        targetSection: "Bridge",
        sectionNames: ["Verse 1", "Bridge"],
        trackNames: ["Piano"],
      },
    ),
  );
  assert.equal(result.interpreter, "openai");
  assert.equal(result.reply, "AI prepared a focused arrangement change.");
  assert.equal(result.operations[0]?.targetSection, "Bridge");
  assert.deepEqual(result.affectedSections, ["Bridge"]);
});

test("keeps fallback operations usable when the OpenAI request fails", async () => {
  const result = await withMockedOpenAi(
    async () => {
      throw new Error("Provider unavailable");
    },
    () => interpretCopilotCommand(
      "Make the chorus bigger",
      {
        targetSection: "Chorus",
        sectionNames: ["Verse 1", "Chorus"],
        trackNames: ["Piano"],
      },
    ),
  );
  assert.equal(result.interpreter, "deterministic");
  assert.ok(result.operations.length > 0);
  assert.equal(result.operations[0]?.type, "SET_SECTION_ENERGY");
  assert.equal(result.operations[0]?.targetSection, "Chorus");
  assert.deepEqual(result.affectedSections, ["Chorus"]);
});

for (const scenario of [
  {
    name: "unsupported model operations",
    operations: [{ type: "DELETE_PROJECT", label: "Delete the project" }],
  },
  {
    name: "intent-mismatched model operations",
    operations: [{ type: "SET_SECTION_DENSITY", label: "Reduce arrangement density" }],
  },
  {
    name: "refinement-only model operations replaced by a specific local interpretation",
    operations: [{ type: "REFINE_ARRANGEMENT", label: "Refine arrangement direction" }],
  },
]) {
  test(`reports deterministic provenance for ${scenario.name}`, async () => {
    const result = await withMockedOpenAi(
      async () => new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              reply: "Model reply that must not be shown.",
              operations: scenario.operations,
              affectedSections: ["Chorus"],
            }),
          },
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      () => interpretCopilotCommand(
        "Make the chorus bigger",
        {
          targetSection: "Chorus",
          sectionNames: ["Verse 1", "Chorus"],
          trackNames: ["Piano"],
        },
      ),
    );
    assert.equal(result.interpreter, "deterministic");
    assert.equal(
      result.reply,
      "Prepared 1 focused arrangement change without regenerating the full song.",
    );
    assert.deepEqual(result.operations.map((operation) => operation.type), ["SET_SECTION_ENERGY"]);
    assert.equal(result.operations[0]?.targetSection, "Chorus");
    assert.deepEqual(result.affectedSections, ["Chorus"]);
  });
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
