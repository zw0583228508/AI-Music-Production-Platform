# AI Music Production Studio

A versioned AI arrangement workspace that turns songs, vocals, and melodies into analyzed, editable multitrack productions.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/music-studio run dev` — run the web studio through its managed workflow
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Provider workers: set `MUSIC_PROVIDER_<PROVIDER>_URL` (and optional
  `MUSIC_PROVIDER_<PROVIDER>_TOKEN`) per model, or
  `MUSIC_PROVIDER_GATEWAY_URL` / `MUSIC_PROVIDER_GATEWAY_TOKEN` for a shared
  provider gateway.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/music-studio/` — React studio interface
- `artifacts/api-server/src/routes/studio.ts` — project, source-ingestion, analysis, arrangement, track, artifact, generation, and copilot API
- `artifacts/api-server/src/lib/sourceAnalyzer.ts` — FFmpeg/FFprobe preprocessing and baseline signal analysis
- `lib/api-spec/openapi.yaml` — source of truth for the API contract
- `lib/db/src/schema/music-studio.ts` — persistent project and versioned artifact schema

## Architecture decisions

- `SongModel`-style analysis data is the shared representation between model providers and the UI.
- Arrangement plans are versioned separately from projects so regeneration never destroys earlier creative decisions.
- Model-specific work stays behind provider identifiers; the product contract does not depend on one checkpoint.
- Real source uploads use authenticated presigned Object Storage URLs; raw objects remain private.
- Song Models are persisted as immutable versions so a new source analysis does not overwrite prior model output.
- The baseline analyzer uses FFmpeg/FFprobe plus local rhythm, key, energy, and section extraction; GPU providers can replace individual stages behind the same contract.
- Generation workers receive one provider-neutral JSON payload and return
  ranked candidates with canonical arrangement sections. Jobs persist the
  selected provider/model, seed, parameters, progress, confidence, and parent
  artifact IDs; the studio never fabricates candidates when workers are offline.
- Provider workers must treat the generation job ID / `Idempotency-Key` as an
  idempotency key. Long-running workers may return `202` with a same-origin
  status URL so provider-reported stages and progress can be persisted.
- Selecting a validated candidate creates a new arrangement version with
  immutable job, candidate, model, seed, Song Model, and parent-artifact
  provenance; it never mutates the source arrangement.

## Product

- Dashboard and persistent music projects
- Authenticated WAV/MP3/M4A/MIDI/video source import with preprocessing jobs
- Versioned Song Model with audio metadata, tempo, meter, key, form, energy, melody/chord slots, confidence, and provider provenance
- Arrangement Director controls and version creation
- Multitrack project view with generated/rendered status
- Ranked generation candidates and versioned artifacts
- Natural-language Studio Copilot command interpretation

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
