import { RunCopilotResponse } from "@workspace/api-zod";

const ALLOWED_OPERATION_TYPES = new Set([
  "SET_SECTION_ENERGY",
  "SET_SECTION_DENSITY",
  "REHARMONIZE_CHORDS",
  "UPDATE_TRACK",
  "ADD_COUNTERMELODY",
  "MODULATE",
  "REMOVE_TRACK",
  "REFINE_ARRANGEMENT",
]);

export type CopilotScope = {
  targetSection?: string;
  targetTrack?: string;
  startBar?: number;
  endBar?: number;
  sectionNames: string[];
  trackNames: string[];
};

export type CopilotInterpretation = {
  reply: string;
  operations: Array<{
    type: string;
    label: string;
    targetSection?: string;
    targetTrack?: string;
    startBar?: number;
    endBar?: number;
  }>;
  affectedSections: string[];
  interpreter: "openai" | "deterministic";
};

function scopeFields(scope: CopilotScope) {
  return {
    ...(scope.targetSection ? { targetSection: scope.targetSection } : {}),
    ...(scope.targetTrack ? { targetTrack: scope.targetTrack } : {}),
    ...(scope.startBar !== undefined ? { startBar: scope.startBar } : {}),
    ...(scope.endBar !== undefined ? { endBar: scope.endBar } : {}),
  };
}

function affectedSectionsFor(command: string, scope: CopilotScope, proposed: string[] = []) {
  if (scope.targetSection) return [scope.targetSection];
  const allowed = new Set(scope.sectionNames);
  const matches = proposed.filter((section) => allowed.has(section));
  if (matches.length) return [...new Set(matches)];
  const affected: string[] = [];
  if (command.includes("bridge") || command.includes("גשר")) {
    const section = scope.sectionNames.find((name) => name.toLowerCase().includes("bridge"));
    if (section) affected.push(section);
  }
  if (command.includes("chorus") || command.includes("פזמון")) {
    const section = scope.sectionNames.find((name) => name.toLowerCase().includes("chorus"));
    if (section) affected.push(section);
  }
  if (command.includes("verse") || command.includes("בית")) {
    const section = scope.sectionNames.find((name) => name.toLowerCase().includes("verse"));
    if (section) affected.push(section);
  }
  return [...new Set(affected)];
}

function deterministicInterpretation(command: string, scope: CopilotScope): CopilotInterpretation {
  const normalized = command.toLowerCase();
  const operationScope = scopeFields(scope);
  const operations: CopilotInterpretation["operations"] = [];
  if (normalized.includes("energy") || normalized.includes("bigger") || normalized.includes("lift")) {
    operations.push({ type: "SET_SECTION_ENERGY", label: "Raise section energy", ...operationScope });
  }
  if (normalized.includes("sparse") || normalized.includes("simpler") || normalized.includes("less busy")) {
    operations.push({ type: "SET_SECTION_DENSITY", label: "Reduce arrangement density", ...operationScope });
  }
  if (normalized.includes("reharmon") || normalized.includes("chord")) {
    operations.push({ type: "REHARMONIZE_CHORDS", label: "Reharmonize local chord region", ...operationScope });
  }
  if (normalized.includes("remove") && normalized.includes("drum")) {
    const drumTrack = scope.targetTrack ??
      scope.trackNames.find((name) => name.toLowerCase().includes("drum"));
    operations.push({
      type: drumTrack ? "REMOVE_TRACK" : "REFINE_ARRANGEMENT",
      label: drumTrack ? "Remove drums" : "Remove the drum part where available",
      ...(drumTrack ? { targetTrack: drumTrack } : {}),
      ...operationScope,
    });
  } else if (normalized.includes("drum")) {
    operations.push({ type: "UPDATE_TRACK", label: "Update drums", ...operationScope });
  }
  if (normalized.includes("piano") || normalized.includes("guitar")) {
    operations.push({ type: "UPDATE_TRACK", label: "Update selected instrument", ...operationScope });
  }
  if (normalized.includes("cello") || normalized.includes("counter")) {
    operations.push({ type: "ADD_COUNTERMELODY", label: "Add cello countermelody", ...operationScope });
  }
  if (normalized.includes("modulat") || normalized.includes("tone") || normalized.includes("טון")) {
    operations.push({ type: "MODULATE", label: "Modulate local section", ...operationScope });
  }
  if (operations.length === 0) {
    operations.push({ type: "REFINE_ARRANGEMENT", label: "Refine arrangement direction", ...operationScope });
  }
  const affectedSections = affectedSectionsFor(normalized, scope);
  return {
    reply: `Prepared ${operations.length} focused arrangement ${operations.length === 1 ? "change" : "changes"} without regenerating the full song.`,
    operations,
    affectedSections: affectedSections.length ? affectedSections : ["Full arrangement"],
    interpreter: "deterministic",
  };
}

function intentSupportsOperation(type: string, command: string) {
  const normalized = command.toLowerCase();
  const hasAny = (...terms: string[]) => terms.some((term) => normalized.includes(term));
  switch (type) {
    case "SET_SECTION_ENERGY":
      return hasAny("energy", "bigger", "lift", "build", "power", "עוצמ", "אנרג");
    case "SET_SECTION_DENSITY":
      return hasAny("sparse", "simpler", "less busy", "density", "strip", "דליל", "פשוט");
    case "REHARMONIZE_CHORDS":
      return hasAny("reharmon", "chord", "harmony", "אקורד", "הרמונ");
    case "UPDATE_TRACK":
      return hasAny("drum", "piano", "guitar", "bass", "string", "brass", "track", "תוף", "פסנתר", "גיטר", "בס", "מיתר");
    case "ADD_COUNTERMELODY":
      return hasAny("counter", "cello", "counterpoint", "מלודיה נגדית", "קונטר");
    case "MODULATE":
      return hasAny("modulat", "whole tone", "semitone", "key change", "טון", "מודול");
    case "REMOVE_TRACK":
      return hasAny("remove", "mute", "without", "drop out", "הסר", "בלי", "השתק");
    case "REFINE_ARRANGEMENT":
      return true;
    default:
      return false;
  }
}

function parseModelOutput(content: string, command: string, scope: CopilotScope): CopilotInterpretation | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    return null;
  }
  // Provenance is assigned by this server, never accepted from model output.
  // Injecting it for validation keeps the public response schema strict while
  // ensuring a model cannot claim that it was not the interpreter.
  const parsed = RunCopilotResponse.safeParse(
    decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? { ...decoded, interpreter: "openai" }
      : decoded,
  );
  if (!parsed.success || parsed.data.operations.length === 0) return null;
  const operationScope = scopeFields(scope);
  const modelOperations = parsed.data.operations
    .filter((operation) =>
      ALLOWED_OPERATION_TYPES.has(operation.type) &&
      intentSupportsOperation(operation.type, command)
    )
    .map((operation) => ({
      type: operation.type,
      label: operation.label.trim() || "Update arrangement",
      ...operationScope,
    }));
  const deterministicOperations = deterministicInterpretation(command, scope).operations
    .filter((operation) => operation.type !== "REFINE_ARRANGEMENT");
  const operations = [...modelOperations];
  for (const operation of deterministicOperations) {
    if (!operations.some((candidate) => candidate.type === operation.type)) {
      operations.push(operation);
    }
  }
  if (operations.some((operation) => operation.type !== "REFINE_ARRANGEMENT")) {
    for (let index = operations.length - 1; index >= 0; index -= 1) {
      if (operations[index]?.type === "REFINE_ARRANGEMENT") operations.splice(index, 1);
    }
  }
  const hasAcceptedModelOperation = modelOperations.some((operation) =>
    operations.includes(operation)
  );
  if (!operations.length || !hasAcceptedModelOperation) return null;
  const affectedSections = affectedSectionsFor(command.toLowerCase(), scope, parsed.data.affectedSections);
  return {
    reply: parsed.data.reply,
    operations,
    affectedSections: affectedSections.length ? affectedSections : ["Full arrangement"],
    interpreter: "openai",
  };
}

export async function interpretCopilotCommand(
  command: string,
  scope: CopilotScope,
): Promise<CopilotInterpretation> {
  const fallback = () => deterministicInterpretation(command, scope);
  if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || !process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    return fallback();
  }
  try {
    const { openai } = await import("@workspace/integrations-openai-ai-server");
    const response = await openai.chat.completions.create({
      model: "gpt-5.6-terra",
      max_completion_tokens: 2048,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You are a music-arrangement copilot.",
            "Return only JSON matching: {reply:string, operations:{type:string,label:string}[], affectedSections:string[]}.",
            "Allowed operation types: SET_SECTION_ENERGY, SET_SECTION_DENSITY, REHARMONIZE_CHORDS, UPDATE_TRACK, ADD_COUNTERMELODY, MODULATE, REMOVE_TRACK, REFINE_ARRANGEMENT.",
            "Never invent a section or track. The server will apply the requested scope to every operation.",
            `Available sections: ${scope.sectionNames.join(", ") || "none"}.`,
            `Available tracks: ${scope.trackNames.join(", ") || "none"}.`,
          ].join("\n"),
        },
        { role: "user", content: command },
      ],
    });
    const content = response.choices[0]?.message?.content;
    return typeof content === "string" ? parseModelOutput(content, command, scope) ?? fallback() : fallback();
  } catch {
    return fallback();
  }
}
