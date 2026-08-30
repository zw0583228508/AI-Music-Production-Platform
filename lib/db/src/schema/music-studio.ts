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
  startBar?: number;
  endBar?: number;
  chords?: Array<{
    id: string;
    startBeat: number;
    durationBeats: number;
    symbol: string;
    quality: string;
    inversion: number;
    bass?: string;
  }>;
  markers?: Array<{
    id: string;
    bar: number;
    label: string;
    color: string;
  }>;
  automation?: Array<{ bar: number; value: number }>;
  midiNotes?: Array<{
    id: string;
    pitch: number;
    start: number;
    duration: number;
    velocity: number;
    articulation: string;
  }>;
  cc?: number[];
  midiTracks?: Record<string, {
    notes: Array<{
      id: string;
      pitch: number;
      start: number;
      duration: number;
      velocity: number;
      articulation: string;
    }>;
    cc: number[];
  }>;
  transposeSemitones?: number;
};

export type ArrangementRevisionSnapshot = {
  name: string;
  harmonyComplexity: number;
  energy: number;
  density: number;
  orchestraSize: number;
  rhythmIntensity: number;
  selectedCandidateId: string | null;
  sections: ArrangementSection[];
};
export type MusicGenerationTask =
  | "SEPARATION"
  | "TRANSCRIPTION"
  | "ACCOMPANIMENT"
  | "ORCHESTRATION"
  | "ARRANGEMENT";
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

export type SongModelField =
  | "tempo"
  | "meter"
  | "key"
  | "melody"
  | "harmony"
  | "sections"
  | "energy";
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
    selectedProvider: string | null;
    confidence: number;
    decisions: ProviderFusionDecision[];
  };
  audio: SongModelCore["audio"] & {
    proxyObjectPath: string | null;
    proxyContentType: string | null;
    analysisStartSeconds: number;
    analysisDurationSeconds: number;
    analysisCoverage: "full" | "representative";
  };
  analysisStartSeconds: number;
  analysisDurationSeconds: number;
  analysisCoverage: number;
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
  waveform: number[];
  stems: Array<{
    name: string;
    role: string;
    source: string;
    channels: number;
    confidence: number;
  }>;
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
  providerProvenance: Array<{
    capability: string;
    provider: string;
    version: string;
    status: "ready" | "fallback" | "unavailable" | "failed";
    attempts?: number;
    errorCode?: string;
    errorMessage?: string;
  }>;
  fieldStatus?: Partial<Record<SongModelField, SongModelFieldStatus>>;
  provenance?: Partial<Record<SongModelField, string[]>>;
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

export type ProjectCleanupStatus = "queued" | "running" | "partial" | "completed";
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
  analysisLeaseId: text("analysis_lease_id"),
  analysisLeaseExpiresAt: timestamp("analysis_lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const analysisAttemptsTable = pgTable(
  "music_analysis_attempts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => musicProjectsTable.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => projectSourcesTable.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status").notNull().default("queued"),
    stage: text("stage").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("music_analysis_attempts_source_number_unique")
      .on(table.sourceId, table.attemptNumber),
  ],
);
export const songModelsTable = pgTable(
  "music_song_models",
  {
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
  },
  (table) => [
    uniqueIndex("music_song_models_analysis_job_idx").on(table.analysisJobId),
    uniqueIndex("music_song_models_project_version_idx").on(
      table.projectId,
      table.version,
    ),
  ],
);

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

export const arrangementsTable = pgTable(
  "music_arrangements",
  {
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
    sourceGenerationJobId: text("source_generation_job_id"),
    sourceCandidateId: text("source_candidate_id"),
    generationProvenance: jsonb("generation_provenance")
      .$type<ArrangementGenerationProvenance>(),
    styleSpec: jsonb("style_spec").$type<StyleSpec | null>(),
    plan: jsonb("plan").$type<ArrangementPlan | null>(),
    trackModels: jsonb("track_models").$type<TrackModel[]>().notNull().default([]),
    songModelVersion: integer("song_model_version"),
    parentArrangementId: text("parent_arrangement_id"),
    parameters: jsonb("parameters").$type<Record<string, number | string | boolean>>()
      .notNull()
      .default({}),
    seed: integer("seed"),
    modelVersion: text("model_version"),
    provenance: jsonb("provenance").$type<ArtifactProvenance | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("music_arrangements_source_candidate_unique").on(
      table.sourceCandidateId,
    ),
  ],
);

export const arrangementRevisionsTable = pgTable(
  "music_arrangement_revisions",
  {
    id: text("id").primaryKey(),
    arrangementId: text("arrangement_id")
      .notNull()
      .references(() => arrangementsTable.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").$type<ArrangementRevisionSnapshot>().notNull(),
    summary: jsonb("summary").$type<ArrangementRevisionSummary>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("music_arrangement_revisions_arrangement_version_unique").on(
      table.arrangementId,
      table.version,
    ),
  ],
);
export const musicGenerationJobsTable = pgTable("music_generation_jobs", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => musicProjectsTable.id, { onDelete: "cascade" }),
  arrangementId: text("arrangement_id")
    .notNull()
    .references(() => arrangementsTable.id, { onDelete: "cascade" }),
  songModelId: text("song_model_id").references(() => songModelsTable.id, {
    onDelete: "set null",
  }),
  songModelVersion: integer("song_model_version"),
  task: text("task").$type<MusicGenerationTask>().notNull(),
  status: text("status").notNull().default("queued"),
  provider: text("provider").notNull(),
  modelVersion: text("model_version").notNull(),
  hardware: text("hardware").notNull(),
  speed: text("speed").notNull(),
  progress: integer("progress").notNull().default(0),
  stage: text("stage").notNull().default("queued"),
  providerRequestId: text("provider_request_id"),
  workerId: text("worker_id"),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  requestedCandidates: integer("requested_candidates").notNull().default(1),
  seed: integer("seed").notNull(),
  parameters: jsonb("parameters")
    .$type<GenerationParameters>()
    .notNull()
    .default({}),
  parentArtifactIds: jsonb("parent_artifact_ids")
    .$type<string[]>()
    .notNull()
    .default([]),
  inputSnapshot: jsonb("input_snapshot")
    .$type<GenerationInputSnapshot>()
    .notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  completedAt: timestamp("completed_at", { withTimezone: true }),
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
  instrumentDefinition: jsonb("instrument_definition").$type<InstrumentDefinition | null>(),
  trackModel: jsonb("track_model").$type<TrackModel | null>(),
  provenance: jsonb("provenance").$type<ArtifactProvenance | null>(),
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
  hash: text("hash"),
  parentIds: jsonb("parent_ids").$type<string[]>().notNull().default([]),
  createdBy: text("created_by"),
  modelVersion: text("model_version"),
  parameters: jsonb("parameters").$type<Record<string, number | string | boolean>>()
    .notNull()
    .default({}),
  storageUri: text("storage_uri"),
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

export type GenerationInputSnapshot = {
  arrangement: {
    id: string;
    version: number;
    style: string;
    mode: string;
    status: string;
    harmonyComplexity: number;
    energy: number;
    density: number;
    orchestraSize: number;
    rhythmIntensity: number;
  };
  songModel: unknown;
  tracks: Array<{ id: string; name: string; role: string; instrument: string }>;
};
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

export type ArtifactProvenance = {
  model: string;
  version: string;
  parameters: Record<string, number | string | boolean>;
  parentIds: string[];
  createdBy: string;
};
export type SongModelFieldStatus = {
  status: "detected" | "low_confidence" | "failed" | "not_available";
  confidence: number | null;
  providers: string[];
  message: string | null;
  edited: boolean;
};
export type ArrangementGenerationProvenance = {
  jobId: string;
  candidateId: string;
  provider: string;
  modelVersion: string;
  reportedModelVersion: string | null;
  providerRequestId: string | null;
  songModelVersion: number | null;
  seed: number;
  parameters: GenerationParameters;
  parentArtifactIds: string[];
};

export type CandidatePlan = {
  sections: ArrangementSection[];
  tracks?: Array<{
    id: string;
    name: string;
    role: string;
    kind: string;
  }>;
};

export const musicGenerationCandidatesTable = pgTable(
  "music_generation_candidates",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => musicGenerationJobsTable.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => musicProjectsTable.id, { onDelete: "cascade" }),
    arrangementId: text("arrangement_id")
      .notNull()
      .references(() => arrangementsTable.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id"),
    providerRequestId: text("provider_request_id"),
    reportedModelVersion: text("reported_model_version"),
    provider: text("provider").notNull(),
    modelVersion: text("model_version").notNull(),
    seed: integer("seed").notNull(),
    rank: integer("rank").notNull(),
    label: text("label").notNull(),
    score: doublePrecision("score").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    summary: text("summary").notNull(),
    status: text("status").notNull().default("validated"),
    parameters: jsonb("parameters")
      .$type<GenerationParameters>()
      .notNull()
      .default({}),
    parentArtifactIds: jsonb("parent_artifact_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    plan: jsonb("plan").$type<CandidatePlan>().notNull(),
    trackModels: jsonb("track_models").$type<TrackModel[] | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export type GenerationParameters = Record<string, unknown>;

export type StyleSpec = {
  genre: string; subgenre: string; era: string;
  tempoCharacter: "laid_back" | "steady" | "driving" | "rubato";
  rhythm: { swing: number; syncopation: number; subdivision: string };
  harmony: { complexity: number; tension: number; voicing: string };
  instrumentation: { preferredFamilies: string[]; avoid: string[] };
  orchestration: { density: number; registerSpread: number; dynamics: string };
  production: { stereoWidth: number; room: string; mixProfile: string };
  dynamics: { range: number; accentStrength: number };
};

export type TrackModel = {
  id: string; instrument: string; instrumentDefinition: InstrumentDefinition; role: string;
  notes: MusicalNote[]; cc: ControlEvent[]; articulations: ArticulationEvent[];
  automation: AutomationPoint[]; source: string; version: number; provenance: ArtifactProvenance;
};

export type ControlEvent = {
  controller: number; time: number; value: number; channel?: number;
};

export type InstrumentDefinition = {
  id: string;
  family: "keys" | "strings" | "brass" | "drums" | "guitar" | "voice" | "synth";
  playableRange: { min: number; max: number };
  comfortableRange: { min: number; max: number };
  registers: Array<{ name: string; min: number; max: number; character: string }>;
  polyphonic: boolean;
  maxVoices: number;
  articulations: string[];
  constraints: {
    maxLeap: number; minNoteDuration: number; maxSimultaneousNotes: number;
    breathSeconds?: number; strings?: number; frets?: number; hands?: number; feet?: number;
  };
  controls: { dynamics: number[]; expression: number[]; sustain?: number; pitchBend: boolean; aftertouch: boolean };
};

export type AutomationPoint = { parameter: string; time: number; value: number };

export type ArrangementPlanSection = {
  section: string; startBar: number; endBar: number; energy: number; density: number;
  tracks: Record<string, string>; operations: string[];
};

export type ArrangementPlan = {
  id: string; version: number; sections: ArrangementPlanSection[]; style: StyleSpec;
  songModelVersion: number; parameters: Record<string, number | string | boolean>;
  provenance: ArtifactProvenance;
};

export type MusicalNote = {
  id: string; start: number; duration: number; pitch: number; velocity: number;
  channel?: number; voice?: string;
};

export type ArticulationEvent = {
  time: number; name: string; keyswitch?: number; intensity?: number;
};

export type ArrangementRevisionSummary = {
  affectedSections: string[];
  affectedTracks: string[];
  chordChanges: number;
  noteChanges: number;
  conductorControls: string[];
  candidateSelectionChanged: boolean;
};

export const projectCleanupJobsTable = pgTable("music_project_cleanup_jobs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  ownerId: text("owner_id").notNull(),
  status: text("status").$type<ProjectCleanupStatus>().notNull().default("queued"),
  objectPaths: jsonb("object_paths").$type<string[]>().notNull().default([]),
  activeUploadPaths: jsonb("active_upload_paths").$type<string[]>().notNull().default([]),
  uploadLeaseExpiresAt: timestamp("upload_lease_expires_at", { withTimezone: true }),
  analysisJobIds: jsonb("analysis_job_ids").$type<string[]>().notNull().default([]),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  leaseId: text("lease_id"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const projectUploadReservationsTable = pgTable("music_project_upload_reservations", {
  objectPath: text("object_path").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => musicProjectsTable.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull(),
  contentType: text("content_type").notNull().default("application/octet-stream"),
  size: integer("size").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
