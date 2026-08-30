import type { ArrangementSection } from "@workspace/api-client-react";

export type ChordEvent = {
  id: string;
  startBeat: number;
  durationBeats: number;
  symbol: string;
  quality: "major" | "minor" | "dominant" | "suspended" | "diminished";
  inversion: number;
  bass?: string;
};

export type TimelineMarker = {
  id: string;
  bar: number;
  label: string;
  color: string;
};

export type AutomationPoint = {
  bar: number;
  value: number;
};

export type EditorSection = ArrangementSection & {
  startBar: number;
  endBar: number;
  chords: ChordEvent[];
  markers: TimelineMarker[];
  automation: AutomationPoint[];
  midiNotes: PianoNote[];
  cc: number[];
  midiTracks: Record<string, { notes: PianoNote[]; cc: number[] }>;
  transposeSemitones: number;
};

export type PianoNote = {
  id: string;
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
  articulation: "sustain" | "staccato" | "accent" | "ghost";
};

export type EditorSelection =
  | { kind: "section"; sectionName: string; startBar: number; endBar: number }
  | { kind: "chord"; sectionName: string; chordId: string; startBar: number; endBar: number }
  | { kind: "track"; trackName: string; sectionName: string; startBar?: number; endBar?: number }
  | { kind: "note"; trackName: string; sectionName: string; startBar: number; endBar: number }
  | null;

export type CopilotEditorResult = {
  interpreter: "openai" | "deterministic";
  operations: Array<{
    type: string;
    label: string;
    targetSection?: string;
    targetTrack?: string;
    startBar?: number;
    endBar?: number;
  }>;
  affectedSections: string[];
};