import type { AnalysisSection, SongModelData } from "@workspace/db";

type ProviderProvenance = SongModelData["provenance"][number];
type MelodyNote = SongModelData["melody"][number];
type BeatEvent = SongModelData["beats"][number];
type BarEvent = SongModelData["bars"][number];

export type StructureAnalysisResult = {
  providerId: "ALL_IN_ONE";
  version: string;
  bpm: number;
  meter: string;
  beats: BeatEvent[];
  bars: BarEvent[];
  sections: AnalysisSection[];
  confidence: number;
};

export type TranscriptionAnalysisResult = {
  providerId: "BASIC_PITCH";
  version: string;
  notes: MelodyNote[];
  confidence: number;
};

export type AnalysisProviderResults = {
  structure: StructureAnalysisResult | null;
  transcription: TranscriptionAnalysisResult | null;
  provenance: ProviderProvenance[];
};

type AnalysisProviderInput = {
  sourceUrl: string | null;
  sourceType: string;
  durationSeconds: number;
};

const configuredEndpoint = (providerId: string): string | null =>
  process.env[`${providerId}_API_URL`]?.trim() || null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

async function requestProvider(
  providerId: "ALL_IN_ONE" | "BASIC_PITCH",
  input: AnalysisProviderInput,
): Promise<unknown> {
  const endpoint = configuredEndpoint(providerId);
  if (!endpoint) throw new Error(`${providerId} is not configured`);
  if (!input.sourceUrl) throw new Error("A signed source URL could not be created");
  const token = process.env[`${providerId}_API_TOKEN`];
  const response = await fetch(new URL("/analyze", endpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      sourceUrl: input.sourceUrl,
      sourceType: input.sourceType,
      durationSeconds: input.durationSeconds,
    }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok) {
    throw new Error(`${providerId} returned HTTP ${response.status}`);
  }
  return response.json();
}

function parseStructure(payload: unknown, durationSeconds: number): StructureAnalysisResult {
  if (!isRecord(payload)) throw new Error("ALL_IN_ONE response must be an object");
  const bpm = payload["bpm"];
  const meter = payload["meter"];
  const confidence = payload["confidence"];
  const version = payload["version"];
  const rawBeats = payload["beats"];
  const rawSections = payload["sections"];
  if (
    !finiteNumber(bpm) || bpm < 20 || bpm > 400 ||
    typeof meter !== "string" || !/^[1-9]\d*\/[1-9]\d*$/.test(meter) ||
    !finiteNumber(confidence) || confidence < 0 || confidence > 1 ||
    typeof version !== "string" || !version.trim() ||
    !Array.isArray(rawBeats) || !rawBeats.length ||
    !Array.isArray(rawSections) || !rawSections.length
  ) {
    throw new Error("ALL_IN_ONE response does not match the structure contract");
  }

  const beats = rawBeats.map((value, index): BeatEvent => {
    if (!isRecord(value)) throw new Error(`ALL_IN_ONE beat ${index + 1} must be an object`);
    const time = value["time"];
    const beat = value["beat"];
    const bar = value["bar"];
    const itemConfidence = value["confidence"];
    if (
      !finiteNumber(time) || time < 0 || time > durationSeconds + 1 ||
      !integer(beat) || beat < 1 ||
      !integer(bar) || bar < 1 ||
      !finiteNumber(itemConfidence) || itemConfidence < 0 || itemConfidence > 1
    ) {
      throw new Error(`ALL_IN_ONE beat ${index + 1} is invalid`);
    }
    return { time, beat, bar, confidence: itemConfidence };
  });
  if (beats.some((beat, index) => index > 0 && beat.time <= beats[index - 1].time)) {
    throw new Error("ALL_IN_ONE beats must be strictly ordered");
  }
  const beatsPerBar = Number.parseInt(meter.split("/")[0], 10);
  for (let index = 0; index < beats.length; index += 1) {
    const beat = beats[index];
    const previous = beats[index - 1];
    if (beat.beat > beatsPerBar) {
      throw new Error("ALL_IN_ONE beat ordinals must match the declared meter");
    }
    if (!previous) {
      if (beat.bar !== 1 || beat.beat !== 1) {
        throw new Error("ALL_IN_ONE beats must begin at bar 1, beat 1");
      }
      continue;
    }
    if (beat.bar === previous.bar) {
      if (beat.beat !== previous.beat + 1) {
        throw new Error("ALL_IN_ONE beats must be sequential within each bar");
      }
    } else if (
      beat.bar !== previous.bar + 1 ||
      beat.beat !== 1 ||
      previous.beat !== beatsPerBar
    ) {
      throw new Error("ALL_IN_ONE bars must be sequential and meter-consistent");
    }
  }
  const finalBarNumber = beats[beats.length - 1].bar;

  const sections = rawSections.map((value, index): AnalysisSection => {
    if (!isRecord(value)) throw new Error(`ALL_IN_ONE section ${index + 1} must be an object`);
    const name = value["name"];
    const startBar = value["startBar"];
    const endBar = value["endBar"];
    const energy = value["energy"];
    if (
      typeof name !== "string" || !name.trim() ||
      !integer(startBar) || startBar < 1 ||
      !integer(endBar) || endBar < startBar ||
      !finiteNumber(energy) || energy < 0 || energy > 1
    ) {
      throw new Error(`ALL_IN_ONE section ${index + 1} is invalid`);
    }
    return { name: name.trim(), startBar, endBar, energy };
  });
  if (sections.some((section, index) =>
    index > 0 && section.startBar <= sections[index - 1].endBar
  )) {
    throw new Error("ALL_IN_ONE sections must be ordered and non-overlapping");
  }
  if (sections.some((section) => section.endBar > finalBarNumber)) {
    throw new Error("ALL_IN_ONE sections must stay within returned bar bounds");
  }

  const barsByNumber = new Map<number, BeatEvent[]>();
  for (const beat of beats) {
    const current = barsByNumber.get(beat.bar) ?? [];
    current.push(beat);
    barsByNumber.set(beat.bar, current);
  }
  const barGroups = [...barsByNumber.entries()];
  const bars = barGroups.map(([bar, barBeats], index): BarEvent => {
    const nextBar = barGroups[index + 1]?.[1];
    const start = barBeats[0].time;
    const fallbackEnd = start + (60 / bpm) * beatsPerBar;
    const end = Math.min(durationSeconds, nextBar?.[0].time ?? fallbackEnd);
    if (end <= start) {
      throw new Error("ALL_IN_ONE bar ranges must have positive duration");
    }
    return {
      bar,
      start,
      end,
      beats: barBeats.length,
      confidence: Math.min(...barBeats.map((beat) => beat.confidence)),
    };
  });

  return {
    providerId: "ALL_IN_ONE",
    version,
    bpm,
    meter,
    beats,
    bars,
    sections,
    confidence,
  };
}

function parseTranscription(payload: unknown, durationSeconds: number): TranscriptionAnalysisResult {
  if (!isRecord(payload)) throw new Error("BASIC_PITCH response must be an object");
  const rawNotes = payload["notes"];
  const confidence = payload["confidence"];
  const version = payload["version"];
  if (
    !Array.isArray(rawNotes) ||
    !finiteNumber(confidence) || confidence < 0 || confidence > 1 ||
    typeof version !== "string" || !version.trim()
  ) {
    throw new Error("BASIC_PITCH response does not match the transcription contract");
  }
  const notes = rawNotes.map((value, index): MelodyNote => {
    if (!isRecord(value)) throw new Error(`BASIC_PITCH note ${index + 1} must be an object`);
    const start = value["start"];
    const end = value["end"];
    const pitch = value["pitch"];
    const velocity = value["velocity"];
    const itemConfidence = value["confidence"];
    if (
      !finiteNumber(start) || start < 0 ||
      !finiteNumber(end) || end <= start || end > durationSeconds + 1 ||
      !integer(pitch) || pitch < 0 || pitch > 127 ||
      !integer(velocity) || velocity < 1 || velocity > 127 ||
      !finiteNumber(itemConfidence) || itemConfidence < 0 || itemConfidence > 1
    ) {
      throw new Error(`BASIC_PITCH note ${index + 1} is invalid`);
    }
    return {
      start,
      end,
      pitch,
      velocity,
      confidence: itemConfidence,
      source: "BASIC_PITCH",
    };
  });
  if (notes.some((note, index) => index > 0 && note.start < notes[index - 1].start)) {
    throw new Error("BASIC_PITCH notes must be ordered by onset");
  }
  return { providerId: "BASIC_PITCH", version, notes, confidence };
}

export async function runAnalysisProviders(
  input: AnalysisProviderInput,
): Promise<AnalysisProviderResults> {
  const wantsStructure = ["FULL_SONG", "INSTRUMENTAL", "VIDEO"].includes(input.sourceType);
  const wantsTranscription = ["VOCAL_ONLY", "SOLO_INSTRUMENT"].includes(input.sourceType);
  const provenance: ProviderProvenance[] = [];
  let structure: StructureAnalysisResult | null = null;
  let transcription: TranscriptionAnalysisResult | null = null;

  const tasks: Promise<void>[] = [];
  if (wantsStructure) {
    const endpoint = configuredEndpoint("ALL_IN_ONE");
    if (!endpoint || !input.sourceUrl) {
      provenance.push({
        capability: "structure",
        provider: "ALL_IN_ONE",
        version: endpoint ? "source-unavailable" : "not-configured",
        status: "unavailable",
      });
    } else {
      tasks.push(requestProvider("ALL_IN_ONE", input)
        .then((payload) => {
          structure = parseStructure(payload, input.durationSeconds);
          provenance.push({
            capability: "structure",
            provider: "ALL_IN_ONE",
            version: structure.version,
            status: "ready",
          });
        })
        .catch(() => {
          provenance.push({
            capability: "structure",
            provider: "ALL_IN_ONE",
            version: "provider-failed",
            status: "unavailable",
          });
        }));
    }
  }
  if (wantsTranscription) {
    const endpoint = configuredEndpoint("BASIC_PITCH");
    if (!endpoint || !input.sourceUrl) {
      provenance.push({
        capability: "transcription",
        provider: "BASIC_PITCH",
        version: endpoint ? "source-unavailable" : "not-configured",
        status: "unavailable",
      });
    } else {
      tasks.push(requestProvider("BASIC_PITCH", input)
        .then((payload) => {
          transcription = parseTranscription(payload, input.durationSeconds);
          provenance.push({
            capability: "transcription",
            provider: "BASIC_PITCH",
            version: transcription.version,
            status: "ready",
          });
        })
        .catch(() => {
          provenance.push({
            capability: "transcription",
            provider: "BASIC_PITCH",
            version: "provider-failed",
            status: "unavailable",
          });
        }));
    }
  }
  await Promise.all(tasks);
  return { structure, transcription, provenance };
}