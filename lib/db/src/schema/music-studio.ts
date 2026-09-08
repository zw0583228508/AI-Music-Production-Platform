import {
  boolean,
  doublePrecision,
  integer,
  index,
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
  /** Present on v2 analysis output when the section has observed bar bounds. */
  coordinates?: CanonicalTimeRange;
};

/** A v2 musical location expressed on every canonical timeline axis. */
export type CanonicalTimeCoordinate = {
  seconds: number;
  tick: number;
  beat: number;
  bar: number;
  beatInBar: number;
  beatFraction: number;
};

export type CanonicalTimeRange = {
  start: CanonicalTimeCoordinate;
  end: CanonicalTimeCoordinate;
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

export type AceStepOperation =
  | "COMPLETE"
  | "LEGO"
  | "REPAINT"
  | "COVER"
  | "EXTRACT";

export type AceStepRegion = {
  unit: "bar" | "beat" | "time";
  start: number;
  end: number;
  crossfadeSeconds: number;
};

export type ProductionJobKind =
  | "analysis"
  | "separation"
  | "transcription"
  | "arrangement"
  | "rendering"
  | "mixing"
  | "mastering"
  | "quality"
  | "export";
export type TrackPerformance = {
  /**
   * Performances created before Song Model v2 omit this field and are
   * interpreted at the legacy 480 PPQ by export consumers.
   */
  ppq?: number;
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
  /** Identity of the exact performed material represented by this MIDI data. */
  performedMaterialSha256?: string;
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

/** Immutable producer-facing mix/master decision, including render proof. */
export type MixMasterControls = {
  tracks: Record<string, {
    levelDb: number;
    pan: number;
    bus: "MIX" | "DRUMS" | "MUSIC" | "VOCALS" | "FX";
    sendDb: number;
    processing: { highPassHz: number; compressorRatio: number; saturation: number };
  }>;
  master: { targetLufs: number; truePeakDbtp: number; processing: { limiter: boolean; stereoWidth: number } };
};
export type MixMasterFinding = {
  id: string;
  severity: "info" | "warning" | "error";
  message: string;
  control: string;
  startSeconds: number;
  endSeconds: number;
};
export type MixMasterRevisionEvidence = {
  arrangementId: string;
  arrangementVersion: number;
  songModelVersion: number | null;
  timelineSha256: string;
  artifactIds: string[];
  variants: {
    original: { url: string; sourceId: string; timelineSha256: string; durationSeconds: number } | null;
    repaired: { url: string; artifactId: string; checksum: string; timelineSha256: string; durationSeconds: number } | null;
    mixed: { url: string; artifactId: string; checksum: string; timelineSha256: string; durationSeconds: number };
    mastered: { url: string; artifactId: string; checksum: string; timelineSha256: string; durationSeconds: number };
  };
  renderer: string;
  quality: { integratedLufs: number; truePeakDbtp: number; truePeakMethod: "4x-windowed-sinc-estimate"; findings: MixMasterFinding[] };
};

export type SongModelField =
  | "tempo"
  | "meter"
  | "key"
  | "melody"
  | "bass"
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
  contractVersion: "1.0" | "2.0";
  /**
   * Canonical v2 models declare their musical coordinate system explicitly.
   * Historical v1 models remain readable without this field.
   */
  timebase?: {
    ppq: 960;
    originSeconds: 0;
    coordinateSystem: "seconds+ticks";
  };
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
    coordinates?: CanonicalTimeCoordinate;
  }>;
  bars: Array<{
    bar: number;
    start: number;
    end: number;
    beats: number;
    confidence: number;
    coordinates?: CanonicalTimeRange;
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
    /** SHA-256 of the persisted provider stem bytes when available. */
    checksum?: string;
  }>;
  /**
   * Activity observations made solely from decoded PCM of a verified
   * vocal/voice separation stem. This deliberately does not infer vocal
   * space from lyrics, melody, structure, or full-mix duration.
   */
  vocalEvidence?: {
    status: "detected" | "low_confidence" | "not_available" | "failed";
    reason: string | null;
    provenance: {
      sourceStemRole: string;
      objectPath: string;
      provider: string;
      contentChecksum?: string;
    } | null;
    sampleRate: number | null;
    channels: number | null;
    frameSizeSamples: number | null;
    thresholds: {
      rms: number;
      peak: number;
      activitySample: number;
      activityRatio: number;
    } | null;
    observedVoicedWindows: Array<{
      start: number;
      end: number;
      coordinates?: CanonicalTimeRange;
    }>;
    observedSilentWindows: Array<{
      start: number;
      end: number;
      coordinates?: CanonicalTimeRange;
    }>;
  };
  vocalIntelligence?: {
    version: "1.0";
    provenance: {
      sourceStemRole: string;
      objectPath: string;
      provider: string;
      contentChecksum?: string;
    } | null;
    phrases: {
      status: "detected" | "low_confidence" | "not_available" | "conflicting";
      reason: string | null;
      events: Array<{
        id: string;
        start: number;
        end: number;
        confidence: number;
        coordinates?: CanonicalTimeRange;
      }>;
    };
    breaths: {
      status: "detected" | "not_available";
      reason: string | null;
      events: Array<{
        id: string;
        start: number;
        end: number;
        confidence: number;
        kind: "inter_phrase";
        coordinates?: CanonicalTimeRange;
      }>;
    };
    lyricAlignment: {
      status: "aligned" | "not_available" | "conflicting";
      reason: string | null;
      alignments: Array<{ phraseId: string; lyricIndexes: number[]; confidence: number }>;
    };
    melodyAlignment: {
      status: "aligned" | "not_available" | "conflicting";
      reason: string | null;
      alignments: Array<{ phraseId: string; melodyIndexes: number[]; confidence: number }>;
    };
    arrangementSpace: {
      status: "detected" | "not_available";
      reason: string | null;
      windows: Array<{
        id: string;
        start: number;
        end: number;
        confidence: number;
        phraseBeforeId: string | null;
        phraseAfterId: string | null;
        bars: number[];
        sections: string[];
        coordinates?: CanonicalTimeRange;
      }>;
    };
  };
  lyrics: Array<{
    start: number;
    end: number;
    text: string;
    confidence: number;
    coordinates?: CanonicalTimeRange;
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
  rhythmEvidence?: Array<{
    provider: string;
    version: string;
    beats: number[];
    downbeats: number[];
    tempoBpm: number;
  }>;
  timingEvidence?: Array<{
    provider: string;
    version: string;
    events: Array<{
      start: number;
      end: number;
      beat: number;
    }>;
  }>;
  pitchEvidence?: Array<{
    provider: string;
    version: string;
    sourceStem: string;
    frames: Array<{
      time: number;
      frequencyHz: number;
      midiPitch: number | null;
      periodicity: number;
      voiced: boolean;
      confidence: number;
    }>;
  }>;
  keyEvidence?: Array<{
    provider: string;
    version: string;
    key: string;
    scale: string;
    confidence: number;
    hpcp: number[];
  }>;
  loudness?: {
    provider: string;
    version: string;
    integratedLUFS: number;
    loudnessRange: number;
    /** Linear sample peak. This is deliberately not labelled true peak. */
    samplePeak: number;
  } | null;
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

export type ProviderAvailabilityStatus =
  | "ready"
  | "configured"
  | "unavailable";

export type ProviderHealthStatus =
  | "healthy"
  | "unhealthy"
  | "unknown";

export type ProviderRuntimeSnapshot = {
  availability: ProviderAvailabilityStatus;
  configurationReady: boolean;
  checkpointReady: boolean;
  runtimeReady: boolean;
  smokeTested: boolean;
  healthStatus: ProviderHealthStatus;
  checkedAt: string | null;
  latencyMs: number | null;
  message: string | null;
  reportedVersion: string | null;
  // A provider may advertise a lower per-request candidate ceiling during its
  // health check. Absent means that the platform ceiling applies.
  maximumCandidates?: number | null;
  reportedChecksum?: string | null;
  runtimeProvenance?: {
    model: string;
    checkpointSha256: string;
    revision: string;
    modalImageId: string;
    sourceImageDigest: string;
    cudaVersion: string;
    pytorchVersion: string;
    gpu: string;
  } | null;
};

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
  status: text("status")
    .$type<ProviderAvailabilityStatus>()
    .notNull()
    .default("unavailable"),
  configurationReady: boolean("configuration_ready").notNull().default(false),
  checkpointReady: boolean("checkpoint_ready").notNull().default(false),
  runtimeReady: boolean("runtime_ready").notNull().default(false),
  healthStatus: text("health_status")
    .$type<ProviderHealthStatus>()
    .notNull()
    .default("unknown"),
  healthCheckedAt: timestamp("health_checked_at", { withTimezone: true }),
  healthLatencyMs: integer("health_latency_ms"),
  healthMessage: text("health_message"),
  reportedVersion: text("reported_version"),
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
  providerRuntime: jsonb("provider_runtime").$type<ProviderRuntimeSnapshot | null>(),
  hardware: text("hardware").notNull(),
  speed: text("speed").notNull(),
  progress: integer("progress").notNull().default(0),
  stage: text("stage").notNull().default("queued"),
  providerRequestId: text("provider_request_id"),
  providerCancelUrl: text("provider_cancel_url"),
  providerCancellationAcknowledgedAt: timestamp(
    "provider_cancellation_acknowledged_at",
    { withTimezone: true },
  ),
  workerId: text("worker_id"),
  leaseVersion: integer("lease_version").notNull().default(0),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  idempotencyKey: text("idempotency_key"),
  attempt: integer("attempt").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  retryable: boolean("retryable").notNull().default(true),
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
  errorCode: text("error_code"),
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
}, (table) => [
  uniqueIndex("music_generation_jobs_arrangement_idempotency_unique").on(
    table.arrangementId,
    table.idempotencyKey,
  ),
]);
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
  checksum: text("checksum"),
  parentIds: jsonb("parent_ids").$type<string[]>().notNull().default([]),
  createdBy: text("created_by"),
  modelVersion: text("model_version"),
  parameters: jsonb("parameters").$type<Record<string, number | string | boolean>>()
    .notNull()
    .default({}),
  storageUri: text("storage_uri"),
  technicalMetadata: jsonb("technical_metadata")
    .$type<Record<string, string | number | boolean | null>>()
    .notNull()
    .default({}),
  provider: text("provider"),
  license: text("license"),
  retentionPolicy: text("retention_policy").notNull().default("project"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  immutable: boolean("immutable").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Provider-neutral queue contract for long-running work that is not represented
 * by the legacy analysis or arrangement tables. A row is the source of truth
 * for recovery; workers must fence every write with workerId + leaseVersion.
 */
export const productionJobsTable = pgTable("music_production_jobs", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => musicProjectsTable.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull(),
  kind: text("kind").$type<ProductionJobKind>().notNull(),
  status: text("status").$type<ProductionJobStatus>().notNull().default("queued"),
  stage: text("stage").notNull().default("queued"),
  progress: integer("progress").notNull().default(0),
  attempt: integer("attempt").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  idempotencyKey: text("idempotency_key").notNull(),
  inputSnapshot: jsonb("input_snapshot").$type<Record<string, unknown>>().notNull(),
  requiredCapabilities: jsonb("required_capabilities").$type<string[]>().notNull().default([]),
  resourcePool: text("resource_pool").notNull().default("AUTO"),
  provider: text("provider"),
  modelVersion: text("model_version"),
  workerId: text("worker_id"),
  leaseVersion: integer("lease_version").notNull().default(0),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
  retryable: boolean("retryable").notNull().default(true),
  error: jsonb("error").$type<ProductionJobError | null>(),
  outputArtifactIds: jsonb("output_artifact_ids").$type<string[]>().notNull().default([]),
  estimatedCostUnits: integer("estimated_cost_units").notNull().default(0),
  actualCostUnits: integer("actual_cost_units"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("music_production_jobs_project_idempotency_unique").on(
    table.projectId,
    table.idempotencyKey,
  ),
]);
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

export const mixMasterRevisionsTable = pgTable(
  "music_mix_master_revisions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => musicProjectsTable.id, { onDelete: "cascade" }),
    arrangementId: text("arrangement_id").notNull().references(() => arrangementsTable.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    controls: jsonb("controls").$type<MixMasterControls>().notNull(),
    evidence: jsonb("evidence").$type<MixMasterRevisionEvidence>().notNull(),
    previewArtifactId: text("preview_artifact_id").notNull().references(() => musicArtifactsTable.id, { onDelete: "restrict" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("music_mix_master_revisions_project_version_unique").on(table.projectId, table.version)],
);

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

/**
 * Private, append-only producer learning record. `context` deliberately holds
 * stable IDs and server-derived hashes only; it must never contain object paths,
 * signed URLs, or acoustic fingerprints.
 */
export type ProducerDecisionContext = {
  subjectId: string | null;
  comparedSubjectId: string | null;
  modelVersion: string | null;
  evidenceIds: string[];
  lineageIds: string[];
  evidenceSha256: string | null;
  rankingScore?: number | null;
  criticScore?: number | null;
};
export type ProducerDecisionSource =
  | "explicit_feedback"
  | "inferred_behavior"
  | "objective_evidence";
export const producerDecisionsTable = pgTable("music_producer_decisions", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  projectId: text("project_id").notNull().references(() => musicProjectsTable.id, { onDelete: "cascade" }),
  domain: text("domain").notNull(),
  kind: text("kind").notNull(),
  source: text("source").$type<ProducerDecisionSource>().notNull(),
  rating: integer("rating"),
  reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
  context: jsonb("context").$type<ProducerDecisionContext>().notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("music_producer_decisions_owner_created_at_idx").on(table.ownerId, table.createdAt),
]);

export const producerPreferencesTable = pgTable("music_producer_preferences", {
  ownerId: text("owner_id").primaryKey(),
  learningEnabled: boolean("learning_enabled").notNull().default(true),
  inferredBehaviorEnabled: boolean("inferred_behavior_enabled").notNull().default(true),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Immutable snapshots preserve owner preference-control history. */
export const producerPreferenceVersionsTable = pgTable("music_producer_preference_versions", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  version: integer("version").notNull(),
  learningEnabled: boolean("learning_enabled").notNull(),
  inferredBehaviorEnabled: boolean("inferred_behavior_enabled").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("music_producer_preference_versions_unique").on(table.ownerId, table.version)]);

export const calibrationVersionsTable = pgTable("music_calibration_versions", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  version: integer("version").notNull(),
  rankingWeight: doublePrecision("ranking_weight").notNull(),
  criticWeight: doublePrecision("critic_weight").notNull(),
  heldOutAgreement: doublePrecision("held_out_agreement").notNull(),
  baselineAgreement: doublePrecision("baseline_agreement").notNull(),
  heldOutExamples: integer("held_out_examples"),
  evaluationSha256: text("evaluation_sha256"),
  status: text("status").notNull().default("candidate"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
}, (table) => [uniqueIndex("music_calibration_versions_owner_version_unique").on(table.ownerId, table.version)]);
export const calibrationActivePointersTable = pgTable("music_calibration_active_pointers", {
  ownerId: text("owner_id").primaryKey(),
  calibrationVersionId: text("calibration_version_id").notNull().references(() => calibrationVersionsTable.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const calibrationActivationHistoryTable = pgTable("music_calibration_activation_history", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  calibrationVersionId: text("calibration_version_id").notNull().references(() => calibrationVersionsTable.id, { onDelete: "restrict" }),
  action: text("action").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const musicAuditEventsTable = pgTable("music_audit_events", {
  id: text("id").primaryKey(),
  projectId: text("project_id").references(() => musicProjectsTable.id, {
    onDelete: "cascade",
  }),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  requestId: text("request_id"),
  outcome: text("outcome").notNull().default("success"),
  metadata: jsonb("metadata")
    .$type<Record<string, string | number | boolean | null>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type GenerationInputSnapshot = {
  operation: AceStepOperation | null;
  sourceArtifactId: string | null;
  instrument: string | null;
  region: AceStepRegion | null;
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
  /** Immutable approved producer controls frozen before provider work begins. */
  generationPreference?: GenerationPreferenceSnapshot | null;
  /** Absent on generation jobs persisted before bounded repairs were introduced. */
  repair?: CandidateRepairSnapshot | null;
};

export type CriticRepairFinding = {
  id: string;
  affectedSections: string[];
  startBar: number;
  endBar: number;
  affectedTrackIds: string[];
  /** Roles are copied from the rendered tracks, never inferred from names. */
  affectedRoles?: string[];
  /** Inclusive canonical bar scope used by repair validation. */
  canonicalScope?: { startBar: number; endBar: number };
  /** Bounded, non-secret references to the evidence used for this finding. */
  evidenceReferences?: Array<{ source: string; summary: string }>;
  /** The repair worker may perform only one of these local operations. */
  permissibleRepairOperations?: CriticRepairOperation[];
  musicalReason: string;
};
export type CriticRepairOperation =
  | "adjust_notes"
  | "adjust_rhythm"
  | "adjust_register"
  | "adjust_dynamics"
  | "adjust_voicing"
  | "adjust_directive";
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
  tempoMap: Array<{ time: number; bpm: number; confidence: number; coordinates?: CanonicalTimeCoordinate }>;
  meterMap: Array<{ bar: number; meter: string; confidence: number; coordinates?: CanonicalTimeCoordinate }>;
  keyMap: Array<{ time: number; key: string; confidence: number; coordinates?: CanonicalTimeCoordinate }>;
  melody: Array<{
    start: number;
    end: number;
    pitch: number;
    velocity: number;
    confidence: number;
    source: string;
    coordinates?: CanonicalTimeRange;
  }>;
  /** Observed bass notes from harmony providers; absent/empty means no bass evidence. */
  bass?: Array<{
    start: number;
    end: number;
    pitch: number;
    confidence: number;
    provider?: string;
    sourceStem?: string;
    sourceStemProvider?: string;
    providers?: string[];
    coordinates?: CanonicalTimeRange;
  }>;
  chords: ChordHarmonyEvent[];
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
/**
 * The original chord fields remain required so Song Models written before the
 * canonical harmony contract can continue to be read unchanged. The remaining
 * fields enrich an event when a harmony provider can supply them.
 */
export type ChordTiming = {
  startBeat?: number;
  durationBeats?: number;
  startSeconds?: number;
  endSeconds?: number;
};

export type MelodyConflictEvidence = {
  noteId?: string;
  pitch?: number;
  start?: number;
  end?: number;
  conflict: "clash" | "avoid_note" | "unresolved_tension" | "unknown";
  severity?: number;
  explanation?: string;
};

export type ChordCandidateProvenance = {
  candidateId: string;
  provider: string;
  modelVersion?: string;
  score?: number;
  selected?: boolean;
  evidence?: string[];
};

export type ChordBassSupportEvidence = {
  start: number;
  end: number;
  pitch: number;
  confidence: number;
  provider: string;
};

export type ChordHarmonyEvent = {
  /** Legacy timing and display fields. */
  start: number;
  end: number;
  symbol: string;
  roman: string;
  confidence: number;
  /** Canonical harmony fields; optional for legacy persisted Song Models. */
  root?: string;
  quality?: string;
  extensions?: string[];
  alterations?: string[];
  inversion?: number;
  bass?: string;
  function?: string;
  timing?: ChordTiming;
  melodyConflictEvidence?: MelodyConflictEvidence[];
  candidateProvenance?: ChordCandidateProvenance[];
  bassSupportEvidence?: ChordBassSupportEvidence[];
  coordinates?: CanonicalTimeRange;
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
  checkpointSha256: string | null;
  providerRequestId: string | null;
  songModelVersion: number | null;
  seed: number;
  parameters: GenerationParameters;
  parentArtifactIds: string[];
  evaluation: CandidateEvaluation;
};

export type CandidateEvaluationStatus =
  | "plan_received"
  | "rendering"
  | "render_succeeded"
  | "analyzing"
  | "evaluated"
  | "render_failed"
  | "analysis_failed"
  | "diversity_rejected"
  | "repair_not_improved"
  | "repair_scope_violated";
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
    checkpointSha256: text("checkpoint_sha256"),
    provider: text("provider").notNull(),
    modelVersion: text("model_version").notNull(),
    seed: integer("seed").notNull(),
    rank: integer("rank"),
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
    evaluatedPlan: jsonb("evaluated_plan").$type<ArrangementPlan | null>(),
    evaluatedStyleSpec: jsonb("evaluated_style_spec").$type<StyleSpec | null>(),
    evaluation: jsonb("evaluation")
      .$type<CandidateEvaluation>()
      .notNull()
      .default({
        status: "plan_received",
        providerScore: 0,
        renderArtifactIds: [],
        artifacts: [],
        qualityReport: null,
        musicCritic: null,
        audioCritic: null,
        error: null,
      }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export type HarmonyCandidateRationale = {
  symbol: string;
  function: string;
  score: number;
  melodyFit: number;
  bassFit: number;
  voiceLeading: number;
  selected: boolean;
};

export type HarmonyDecisionEvidence = {
  start: number;
  end: number;
  symbol: string;
  function?: string;
  source: "song_model_chord_evidence" | "deterministic_candidate_scoring";
  score?: number;
  melodyFit?: number;
  bassFit?: number;
  voiceLeading?: number;
  harmonicBars?: number;
  complexity?: number;
  candidateRationale?: HarmonyCandidateRationale[];
  bassSupportEvidence?: ChordBassSupportEvidence[];
};

export type GenerationParameters = Record<string, unknown> & {
  harmonyDecisions?: HarmonyDecisionEvidence[];
  styleGrammarVersion?: StyleGrammar["version"];
  styleGrammarEvidenceSha256?: string;
  generationPreference?: GenerationPreferenceSnapshot | null;
};

export type StyleGrammar = {
  version: "1.0";
  evidenceSha256: string;
  vocabulary: {
    groove: "straight" | "swung" | "syncopated" | "four_on_floor";
    voicing: "close" | "open" | "drop_two" | "quartal" | "wide";
    articulation: "legato" | "tight" | "accented" | "pulsed";
    instrumentation: "acoustic" | "electronic" | "hybrid" | "orchestral";
    phraseBehavior: "call_response" | "continuous" | "sparse_answers" | "motivic";
    fills: "none" | "cadential" | "frequent" | "sectional";
    transitions: "hard_cut" | "thin_build" | "riser" | "orchestral_swell";
    development: "repetition" | "additive" | "transformative" | "dynamic_arc";
  };
};
export type StyleSpec = {
  genre: string; subgenre: string; era: string;
  tempoCharacter: "laid_back" | "steady" | "driving" | "rubato";
  rhythm: { swing: number; syncopation: number; subdivision: string };
  harmony: { complexity: number; tension: number; voicing: string };
  instrumentation: { preferredFamilies: string[]; avoid: string[] };
  orchestration: { density: number; registerSpread: number; dynamics: string };
  production: { stereoWidth: number; room: string; mixProfile: string };
  dynamics: { range: number; accentStrength: number };
  /** Absent on historical arrangements. */
  grammar?: StyleGrammar;
};

export type TrackModel = {
  id: string; instrument: string; instrumentDefinition: InstrumentDefinition; role: string;
  notes: MusicalNote[]; cc: ControlEvent[]; articulations: ArticulationEvent[];
  automation: AutomationPoint[]; source: string; version: number; provenance: ArtifactProvenance;
  /** Optional section-level intent and renderer mapping for canonical plans. */
  directive?: TrackDirective;
  appliedDirectives?: AppliedTrackDirective[];
  mapping?: TrackMappingMetadata;
  /** Deterministic performance decisions and canonical timeline binding. */
  performanceEvidence?: TrackPerformanceEvidence;
  harmonyEvidence?: {
    version: "2.0";
    mode: "advanced_voicing" | "phrase_countermelody";
    selectedMotion?: number;
    baselineMotion?: number;
    maximumLeap?: number;
    motifRefs?: string[];
    resolutionObligations?: number;
    melodyEvidencePreserved: boolean;
    bassEvidencePreserved: boolean;
  };
};

export type TrackPerformanceEvidence = {
  version: "1.0";
  /** Historical field containing the performance/humanization seed. */
  seed: number;
  /** Canonical Composition Intelligence seed, when a versioned plan exists. */
  compositionSeed?: number;
  /** Explicit alias for the derived performance/humanization seed. */
  performanceSeed?: number;
  instrumentFamily: InstrumentDefinition["family"];
  articulationProfile: string;
  timingProfile: string;
  dynamicsProfile: string;
  canonicalTimelineSha256: string;
  phraseIds: string[];
  sectionRanges: Array<{
    section: string;
    startBar: number;
    endBar: number;
    start: number;
    end: number;
  }>;
  playability: {
    valid: boolean;
    checkedNotes: number;
    violations: string[];
  };
  performedMaterialSha256: string;
};
export type AppliedTrackDirective = {
  section: string;
  startBar: number;
  endBar: number;
  start: number;
  end: number;
  directive: TrackDirective;
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
  /** Maps provider-neutral directives onto instrument-specific renderer data. */
  directiveMappings?: InstrumentDirectiveMappings;
};

export type AutomationPoint = { parameter: string; time: number; value: number };

export type ArrangementPlanSection = {
  section: string; startBar: number; endBar: number; energy: number; density: number;
  tracks: Record<string, string>; operations: string[];
  /** Explicit membership; `tracks` remains the compatibility role map. */
  activeTracks?: string[];
  /** Provider-neutral orchestration intent indexed by track id. */
  trackDirectives?: Record<string, TrackDirective>;
};

export type CompositionIntelligenceVersion = "1.0" | "2.0";
export type CompositionPhraseIntent =
  | "state"
  | "develop"
  | "answer"
  | "build"
  | "release"
  | "protect_vocal";

export type PhraseIntention =
  | "support"
  | "silence"
  | "response"
  | "transition"
  | "foreground";
export type OrchestrationRole =
  | "foundation"
  | "pulse"
  | "groove"
  | "harmonic_support"
  | "texture"
  | "countermelody"
  | "hook"
  | "response"
  | "lift"
  | "transition"
  | "accent"
  | "doubling"
  | "pad";
export type InstrumentFunction =
  | "foundation"
  | "pulse"
  | "harmony"
  | "lead"
  | "counterline"
  | "texture";

export type GrooveResponsibility =
  | "foundation"
  | "pulse"
  | "syncopation"
  | "accent"
  | "fill";
export type GrooveGesture =
  | "state"
  | "pickup"
  | "push"
  | "anticipation"
  | "break"
  | "fill";

/** Shared, deterministic rhythm-section decisions on the canonical timeline. */
export type SharedGroovePlan = {
  version: "1.0";
  seed: number;
  evidenceSha256: string;
  subdivision: "8th" | "16th";
  roles: Array<{
    trackId: string;
    responsibility: GrooveResponsibility;
  }>;
  motifs: Array<{
    id: string;
    sourceMotifId: string | null;
    phraseId: string;
    variation: "state" | "develop" | "answer";
  }>;
  events: Array<{
    id: string;
    motifId: string;
    sectionId: string;
    phraseId: string;
    trackId: string;
    responsibility: GrooveResponsibility;
    gesture: GrooveGesture;
    sharedAccentId: string | null;
    coordinate: CanonicalTimeCoordinate;
    durationTicks: number;
    velocity: number;
  }>;
};

/** Immutable reasoning identity and decisions used to materialize performance events. */
export type CompositionIntelligencePlan = {
  version: CompositionIntelligenceVersion;
  mode: "legacy" | "reasoning_core";
  precedence: ["song_intent", "dramatic_arc", "section_function", "phrase_intent", "instrument_role", "motif", "harmony_rhythm_voicing", "event"];
  seed: number;
  evidenceSha256: string;
  songIntent: "preserve_observed_form" | "develop_observed_form";
  motifs: Array<{
    id: string;
    fingerprint: string;
    sourceSectionId: string;
    sourcePhraseId: string;
    parentMotifId: string | null;
    transformation: MotifTransformation;
    ownerTrackId: string | null;
    evidenceSha256: string;
  }>;
  tensionRelease: Array<{
    sectionId: string;
    tension: number;
    release: number;
  }>;
  phrases: Array<{
    id: string;
    sectionId: string;
    startBar: number;
    endBar: number;
    startSeconds?: number;
    endSeconds?: number;
    intent: CompositionPhraseIntent;
    tension: number;
    motifRef: string;
    sourceMotifRef: string | null;
    intention: PhraseIntention;
    transformation: MotifTransformation;
    responseToPhraseId: string | null;
    ownerTrackId: string | null;
  }>;
  instrumentRoles: Array<{
    trackId: string;
    function: InstrumentFunction;
    authority: "project_track";
  }>;
  /** Present on v2 plans; absent historical plans keep their original behavior. */
  groove?: SharedGroovePlan;
  orchestrationAssignments?: Array<{
    sectionId: string;
    phraseId: string;
    trackId: string;
    role: OrchestrationRole;
    register: "low" | "middle" | "high";
    handoffFromTrackId: string | null;
    doublingTrackId: string | null;
  }>;
};

export type ArrangementHierarchyScope = {
  level: "song" | "section" | "phrase" | "bar" | "event";
  id: string;
};

export type ArrangementHierarchy = {
  version: "1.0";
  status: "applied" | "no_op";
  reason: string | null;
  precedence: ["song", "section", "phrase", "bar", "event"];
  song: {
    id: string;
    intent: "development_arc" | "preserve_observed_form";
    climaxSectionId: string | null;
  };
  sections: Array<{
    id: string;
    sourceSection: string;
    startBar: number;
    endBar: number;
    function: "intro" | "verse" | "prechorus" | "chorus" | "bridge" | "outro" | "neutral";
    development: "initial" | "development" | "reprise" | "neutral";
    targetEnergy: number;
    targetDensity: number;
    phraseIds: string[];
    barIds: string[];
  }>;
  phrases: Array<{
    id: string;
    sectionId: string;
    startBar: number;
    endBar: number;
    confidence: number;
    intent: "protect_vocal_phrase";
  }>;
  bars: Array<{
    id: string;
    sectionId: string;
    bar: number;
    meter: string;
    phraseIds: string[];
    vocalSpace: "occupied" | "available" | "unknown";
  }>;
  events: Array<{
    id: string;
    sectionId: string;
    barId: string;
    trackId: string;
    intent: "support_vocal" | "use_vocal_space" | "follow_section";
    source: "section" | "vocal_phrase" | "vocal_space";
  }>;
};

export type OrchestrationCue = {
  bar?: number;
  beat?: number;
  mode?: string;
  durationBeats?: number;
};

export type TrackDirective = {
  role?: string;
  musicalFunction?: OrchestrationRole;
  register?: string;
  rhythmicActivity?: number;
  harmonicActivity?: number;
  dynamicTarget?: number;
  articulationFamily?: string;
  entry?: OrchestrationCue;
  exit?: OrchestrationCue;
  transition?: string;
  fill?: boolean;
  handoffFromTrackId?: string;
  doublingTrackId?: string;
};

export type TrackMappingMetadata = {
  midiChannel?: number;
  program?: number;
  articulationMap?: Record<string, string | number>;
  controlMap?: Record<string, number>;
};

export type InstrumentDirectiveMappings = {
  registers?: Record<string, { min: number; max: number }>;
  articulationFamilies?: Record<string, string[]>;
  dynamicTargets?: Record<string, number>;
  controls?: Record<string, number>;
};

export type ArrangementPlan = {
  id: string; version: number; sections: ArrangementPlanSection[]; style: StyleSpec;
  songModelVersion: number; parameters: Record<string, number | string | boolean>;
  provenance: ArtifactProvenance;
  /** Auditable song → section → phrase → bar → event planning authority. */
  hierarchy: ArrangementHierarchy;
  /** Absent only on historical persisted plans, which are interpreted as v1. */
  compositionIntelligence?: CompositionIntelligencePlan;
  /** Frozen before notes are generated; absent on historical plans. */
  generationPreference?: GenerationPreferenceSnapshot | null;
};

export type MusicalNote = {
  id: string; start: number; duration: number; pitch: number; velocity: number;
  channel?: number; voice?: string;
  /** Canonical motif decision that authored this event. */
  motif?: {
    id: string;
    fingerprint: string;
    parentMotifId: string | null;
    transformation: MotifTransformation;
    phraseId: string;
    intention: PhraseIntention;
    evidenceSha256: string;
    windowEndSeconds?: number;
  };
};

export type ArticulationEvent = {
  time: number; name: string; keyswitch?: number; intensity?: number;
};

export type ArrangementRevisionSummary = {
  affectedSections: string[];
  affectedTracks: string[];
  trackMembershipChanges: number;
  chordChanges: number;
  noteChanges: number;
  ccChanges: number;
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

export type ProductionJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "cancelled";

export type ProductionJobError = {
  code: string;
  message: string;
  retryable: boolean;
  provider?: string;
  details?: Record<string, string | number | boolean>;
};

export const musicUsageLedgerTable = pgTable("music_usage_ledger", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => musicProjectsTable.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull(),
  jobId: text("job_id"),
  kind: text("kind").notNull(),
  units: integer("units").notNull().default(0),
  estimatedCostCents: integer("estimated_cost_cents").notNull().default(0),
  actualCostCents: integer("actual_cost_cents"),
  status: text("status").notNull().default("reserved"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("music_usage_ledger_job_unique").on(table.jobId),
]);

export type CandidateEvaluation = {
  status: CandidateEvaluationStatus;
  providerScore: number;
  renderArtifactIds: string[];
  artifacts: CandidateEvaluationArtifact[];
  qualityReport: CandidateQualityReport | null;
  musicCritic: CandidateMusicCriticReport | null;
  /** Deterministic PCM-only evidence, deliberately independent of the symbolic critic. */
  audioCritic: CandidateAudioCriticReport | null;
  error: string | null;
  strategy?: CandidateStrategyEvidence;
  diversity?: CandidateDiversityEvidence;
  repair?: CandidateRepairEvidence;
};

export type CandidateRepairEvidence = {
  sourceCandidateId: string;
  /** Display-safe lineage persisted for repairs created after this field was introduced. */
  sourceCandidateLabel?: string;
  findingId: string;
  seed: number;
  attempt: number;
  maxAttempts: number;
  scope: {
    affectedSections: string[];
    startBar: number;
    endBar: number;
    affectedTrackIds: string[];
  };
  musicalReason: string;
  outsideScopePreserved: boolean;
  changedScopes: ArrangementHierarchyScope[];
  sourceQualityScore: number;
  repairedQualityScore: number | null;
  improved: boolean;
};
export type CandidateStrategyEvidence = {
  name: "sparse" | "balanced" | "rhythmic" | "harmonic" | "orchestral";
  index: number;
  baseSeed: number;
  seed: number;
};

export type CandidateDiversityEvidence = {
  fingerprint: {
    activeTracks: string[];
    densityEnergy: Array<{ density: number; energy: number }>;
    harmonySequence: string[];
    trackRoleInstruments: string[];
    noteShape: number[];
  };
  comparedToCandidateId: string | null;
  distance: number | null;
  threshold: number;
  rejected: boolean;
  reason: "baseline_retained" | "near_duplicate" | "sufficiently_distinct";
};

export type CandidateQualityReport = {
  score: number;
  checks: Record<string, number>;
  weights: Record<string, number>;
  strengths: string[];
  weaknesses: string[];
  warnings: string[];
  evaluatedAt: string;
  renderArtifactIds: string[];
  lineageComplete: boolean;
};

export type CandidateMusicCriticDimension =
  | "vocalFit"
  | "harmony"
  | "development"
  | "contrastAndTransitions"
  | "registerCollisions"
  | "playability"
  | "repetition"
  | "styleAndControlAdherence"
  | "motifContinuityAndDevelopment"
  | "phraseIntent"
  | "vocalInteraction"
  | "roleDuplication"
  | "orchestralBalance"
  | "grooveCoordination"
  | "voiceLeading"
  | "countermelodyShape"
  | "dramaticTrajectory";

export type CandidateMusicCriticEvidence = {
  source:
    | "vocal_activity"
    | "harmony_decisions"
    | "section_plan"
    | "track_notes"
    | "instrument_constraints"
    | "style_and_directives"
    | "composition_intelligence"
    | "rhythm_evidence";
  summary: string;
  observations: Record<string, string | number | boolean>;
};

export type CandidateMusicCriticDimensionResult = {
  status: "available" | "unavailable" | "failed";
  score: number | null;
  evidence: CandidateMusicCriticEvidence[];
  explanation: string;
  findings: CriticRepairFinding[];
};

export type CandidateMusicCriticReport = CandidateMusicCriticReportV1 | CandidateMusicCriticReportV2;
type CandidateMusicCriticReportCoverage = {
  availableDimensions: number;
  totalDimensions: number;
  sparse: boolean;
};
export type CandidateMusicCriticReportV2 = {
  version: "music-critic-v2";
  score: number;
  coverage: CandidateMusicCriticReportCoverage;
  dimensions: Record<
    CandidateMusicCriticDimension,
    CandidateMusicCriticDimensionResult
  >;
};
export type CandidateMusicCriticReportV1 = {
  version: "music-critic-v1";
  score: number;
  coverage: CandidateMusicCriticReportCoverage;
  dimensions: Record<Exclude<CandidateMusicCriticDimension,
    "motifContinuityAndDevelopment" | "phraseIntent" | "vocalInteraction" | "roleDuplication" |
    "orchestralBalance" | "grooveCoordination" | "voiceLeading" | "countermelodyShape" | "dramaticTrajectory">,
    CandidateMusicCriticDimensionResult>;
};

export type CandidateAudioCriticDimension =
  | "vocalFit"
  | "masking"
  | "balance"
  | "dynamics"
  | "artifactsAndDistortion"
  | "transitions"
  | "repetition";

export type CandidateAudioCriticFinding = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  /** Present only where a rendered stem or a single-track render supports attribution. */
  affectedTrackIds?: string[];
  confidence: number;
  provenance: "rendered_pcm";
  recommendation: string;
};

export type CandidateAudioCriticDimensionResult = {
  status: "available" | "unavailable" | "failed";
  score: number | null;
  explanation: string;
  findings: CandidateAudioCriticFinding[];
};

export type CandidateAudioCriticReport = {
  version: "perceptual-audio-critic-v1";
  status: "available" | "unavailable" | "failed" | "insufficient";
  score: number | null;
  coverage: { availableDimensions: number; totalDimensions: 7; sufficient: boolean };
  /** Hash/metadata only: samples and storage locations are never persisted in critic evidence. */
  evidence: {
    artifactId: string;
    artifactSha256: string;
    sampleRate: number;
    analyzerVersion: string;
  } | null;
  dimensions: Record<CandidateAudioCriticDimension, CandidateAudioCriticDimensionResult>;
};

export type CandidateEvaluationArtifact = {
  id: string;
  type: "AUDIO_TRACK" | "MIDI" | "QUALITY_REPORT";
  label: string;
  url: string;
  /** Exact stored artifact bytes; optional only for historical rows. */
  artifactSha256?: string;
};

export type CandidateRepairSnapshot = {
  sourceCandidateId: string;
  sourceCandidateLabel: string;
  sourceScore: number;
  seed: number;
  maxAttempts: number;
  finding: CriticRepairFinding;
  plan: ArrangementPlan;
  trackModels: TrackModel[];
};

export type GenerationPreferenceEffects = {
  orchestrationDensity: number;
  responseFrequency: number;
  roleEmphasis: "foundation" | "pulse" | "harmony" | "counterline" | "texture";
  voicingCharacter: "close" | "open" | "wide";
  development: "restrained" | "balanced" | "progressive";
  transitionIntensity: number;
};

export type MotifTransformation =
  | "repetition"
  | "rhythmic_variation"
  | "augmentation"
  | "diminution"
  | "register_displacement"
  | "answering_gesture"
  | "orchestral_handoff";

export type GenerationPreferenceSnapshot = {
  contractVersion: "1.0";
  calibrationId: string;
  calibrationVersion: number;
  heldOutAgreement: number;
  baselineAgreement: number;
  heldOutExamples: number;
  evaluationSha256: string;
  evidenceSha256: string;
  effects: GenerationPreferenceEffects;
};
