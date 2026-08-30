import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export type AnalysisSection = {
  name: string;
  startBar: number;
  endBar: number;
  energy: number;
};

export type ArrangementSection = {
  name: string;
  energy: number;
  density: number;
  tracks: string[];
};

export type TrackPerformance = {
  tempoMap: Array<{ tick: number; bpm: number }>;
  meterMap: Array<{ tick: number; numerator: number; denominator: number }>;
  notes: Array<{
    startTick: number;
    durationTicks: number;
    pitch: number;
    velocity: number;
  }>;
  expression: Array<{ tick: number; value: number }>;
  articulations: Array<{
    tick: number;
    type: string;
    keyswitch: number;
  }>;
};

export type ArrangementCandidateData = {
  id: string;
  label: string;
  score: number;
  summary: string;
  provider: string;
};

export type ExportFileRecord = {
  name: string;
  type: string;
  size: string;
  format: string;
  url: string;
};

export type SongModelValidationIssue = {
  code: string;
  severity: "error" | "warning";
  path: string;
  message: string;
  provider?: string;
};
export type SongModelData = SongModelCore & {
  contractVersion: "1.0";
  validation: {
    status: "accepted" | "flagged";
    issues: SongModelValidationIssue[];
  };
  fusion: {
    selectedProvider: string;
    confidence: number;
    decisions: ProviderFusionDecision[];
  };
  beats: Array<{
    time: number;
    beat: number;
    bar: number;
    confidence: number;
  }>;
  bars: Array<{
    bar: number;
    start: number;
    end: number;
    beats: number;
    confidence: number;
  }>;
  dynamics: number[];
  sourceStems: Array<{
    role: string;
    objectPath: string;
    provider: string;
    confidence: number;
  }>;
  lyrics: Array<{
    start: number;
    end: number;
    text: string;
    confidence: number;
  }>;
  confidenceByField: Record<string, number>;
  provenance: Array<{
    capability: string;
    provider: string;
    version: string;
    status: "ready" | "fallback" | "unavailable";
  }>;
};

export type SongModelCorrection = {
  correctedBy: string;
  correctedAt: string;
  fields: Array<"bpm" | "key" | "meter" | "sections">;
};

export type ModelCapability =
  | "separation"
  | "structure"
  | "transcription"
  | "harmony"
  | "arrangement"
  | "orchestration"
  | "audio_generation";

export const musicProjectsTable = pgTable("music_projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  sourceType: text("source_type").notNull(),
  sourceName: text("source_name"),
  ownerId: text("owner_id"),
  status: text("status").notNull().default("draft"),
  duration: text("duration").notNull().default("0:00"),
  key: text("key").notNull().default("—"),
  bpm: doublePrecision("bpm").notNull().default(0),
  meter: text("meter").notNull().default("4/4"),
  confidence: doublePrecision("confidence").notNull().default(0),
  coverColor: text("cover_color").notNull().default("#7c3aed"),
  sections: jsonb("sections").$type<AnalysisSection[]>().notNull().default([]),
  energy: jsonb("energy").$type<number[]>().notNull().default([]),
  providers: jsonb("providers").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const projectSourcesTable = pgTable("music_project_sources", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => musicProjectsTable.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull(),
  objectPath: text("object_path").notNull(),
  name: text("name").notNull(),
  size: integer("size").notNull(),
  contentType: text("content_type").notNull(),
  sourceType: text("source_type").notNull(),
  status: text("status").notNull().default("queued"),
  progress: integer("progress").notNull().default(0),
  durationSeconds: doublePrecision("duration_seconds"),
  sampleRate: integer("sample_rate"),
  channels: integer("channels"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const songModelsTable = pgTable("music_song_models", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => musicProjectsTable.id, { onDelete: "cascade" }),
  sourceId: text("source_id")
    .notNull()
    .references(() => projectSourcesTable.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  status: text("status").notNull().default("ready"),
  analysisJobId: text("analysis_job_id"),
  parentModelId: text("parent_model_id"),
  correction: jsonb("correction").$type<SongModelCorrection | null>(),
  model: jsonb("model").$type<SongModelData>().notNull(),
  providers: jsonb("providers").$type<string[]>().notNull().default([]),
  confidence: doublePrecision("confidence").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("music_song_models_analysis_job_idx").on(table.analysisJobId),
  uniqueIndex("music_song_models_project_version_idx").on(
    table.projectId,
    table.version,
  ),
]);

export const modelRegistryTable = pgTable("music_model_registry", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  version: text("version").notNull(),
  capabilities: jsonb("capabilities").$type<ModelCapability[]>().notNull().default([]),
  inputTypes: jsonb("input_types").$type<string[]>().notNull().default([]),
  execution: text("execution").notNull(),
  status: text("status").notNull().default("unavailable"),
  license: text("license"),
  priority: integer("priority").notNull().default(100),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const analysisJobsTable = pgTable("music_analysis_jobs", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => musicProjectsTable.id, { onDelete: "cascade" }),
  sourceId: text("source_id")
    .notNull()
    .references(() => projectSourcesTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),
  stage: text("stage").notNull().default("queued"),
  progress: integer("progress").notNull().default(0),
  attempt: integer("attempt").notNull().default(1),
  error: text("error"),
  workerId: text("worker_id"),
  leaseVersion: integer("lease_version").notNull().default(0),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("music_analysis_jobs_source_attempt_idx").on(table.sourceId, table.attempt),
]);

export const arrangementsTable = pgTable("music_arrangements", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => musicProjectsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  style: text("style").notNull(),
  mode: text("mode").notNull(),
  version: integer("version").notNull().default(1),
  status: text("status").notNull().default("draft"),
  harmonyComplexity: integer("harmony_complexity").notNull().default(5),
  energy: doublePrecision("energy").notNull().default(0.6),
  density: doublePrecision("density").notNull().default(0.55),
  orchestraSize: doublePrecision("orchestra_size").notNull().default(0.5),
  rhythmIntensity: doublePrecision("rhythm_intensity").notNull().default(0.6),
  sections: jsonb("sections").$type<ArrangementSection[]>().notNull().default([]),
  generationProvider: text("generation_provider"),
  candidates: jsonb("candidates").$type<ArrangementCandidateData[]>().notNull().default([]),
  selectedCandidateId: text("selected_candidate_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

const emptyTrackPerformance: TrackPerformance = {
  tempoMap: [],
  meterMap: [],
  notes: [],
  expression: [],
  articulations: [],
};

export const tracksTable = pgTable("music_tracks", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => musicProjectsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  role: text("role").notNull(),
  kind: text("kind").notNull(),
  color: text("color").notNull(),
  volume: doublePrecision("volume").notNull().default(0),
  muted: boolean("muted").notNull().default(false),
  solo: boolean("solo").notNull().default(false),
  status: text("status").notNull(),
  performance: jsonb("performance")
    .$type<TrackPerformance>()
    .notNull()
    .default(emptyTrackPerformance),
});

export const musicArtifactsTable = pgTable("music_artifacts", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => musicProjectsTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  label: text("label").notNull(),
  version: integer("version").notNull().default(1),
  size: text("size").notNull(),
  format: text("format").notNull(),
  url: text("url"),
  state: text("state").notNull().default("ready"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const musicExportsTable = pgTable("music_exports", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => musicProjectsTable.id, { onDelete: "cascade" }),
  arrangementId: text("arrangement_id")
    .notNull()
    .references(() => arrangementsTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("rendering"),
  masterProfile: text("master_profile").notNull(),
  bundleUrl: text("bundle_url"),
  files: jsonb("files").$type<ExportFileRecord[]>().notNull().default([]),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const studioActivitiesTable = pgTable("studio_activities", {
  id: text("id").primaryKey(),
  projectId: text("project_id").references(() => musicProjectsTable.id, {
    onDelete: "cascade",
  }),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  type: text("type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProviderFusionDecision = {
  provider: string;
  status: "selected" | "accepted" | "flagged" | "rejected";
  confidence: number;
  compatibility: number;
  issues: SongModelValidationIssue[];
};

export type SongModelCore = {
  audio: {
    name: string;
    contentType: string;
    size: number;
    durationSeconds: number;
    sampleRate: number;
    channels: number;
  };
  tempoMap: Array<{ time: number; bpm: number; confidence: number }>;
  meterMap: Array<{ bar: number; meter: string; confidence: number }>;
  keyMap: Array<{ time: number; key: string; confidence: number }>;
  melody: Array<{
    start: number;
    end: number;
    pitch: number;
    velocity: number;
    confidence: number;
    source: string;
  }>;
  chords: Array<{
    start: number;
    end: number;
    symbol: string;
    roman: string;
    confidence: number;
  }>;
  sections: AnalysisSection[];
  energy: number[];
};
