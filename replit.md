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

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/music-studio/` — React studio interface
- `artifacts/api-server/src/routes/studio.ts` — project, analysis, arrangement, track, artifact, generation, and copilot API
- `lib/api-spec/openapi.yaml` — source of truth for the API contract
- `lib/db/src/schema/music-studio.ts` — persistent project and versioned artifact schema

## Architecture decisions

- `SongModel`-style analysis data is the shared representation between model providers and the UI.
- Arrangement plans are versioned separately from projects so regeneration never destroys earlier creative decisions.
- Model-specific work stays behind provider identifiers; the product contract does not depend on one checkpoint.
- The first vertical slice is operational with deterministic providers, while GPU inference, object storage, and audio rendering can replace them incrementally.

## Product

- Dashboard and persistent music projects
- Source-analysis model with tempo, meter, key, confidence, form, and energy
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
