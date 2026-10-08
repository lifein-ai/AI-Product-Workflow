# Architecture

The application is one local Fastify service with a dependency-free browser workspace.

- `src/server.ts` composes the file repository, AI provider library, workflow runtime, artifact services, and HTTP routes.
- `src/runtime/` runs Discovery and Product Solution turns.
- `src/workflow/` owns stage transitions, confirmation, invalidation, and Confirmed Product State.
- `src/prd/`, `src/interaction/`, and `src/figma/` generate downstream artifacts.
- `src/web/` is a same-origin vanilla JavaScript workspace.
- `.runtime/projects/` stores one JSON record per project using atomic replacement and record-version checks.

Keep API keys and provider execution server-side. Reuse these boundaries; this personal local tool does not need a frontend framework, job queue, or database until measured usage requires one.
