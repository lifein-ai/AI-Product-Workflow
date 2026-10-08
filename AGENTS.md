# AI Product Workflow V0

This repository is one local Fastify/TypeScript service with a same-origin
vanilla JavaScript workspace. It implements Requirement Discovery → Product
Solution → PRD → Interaction Specification → Figma Prompt, backed by
file-based project storage and pluggable AI providers.

## Commands

- Use Node from `.node-version` and pnpm from `package.json#packageManager`.
- Install dependencies: `pnpm install`.
- Run the development server: `pnpm dev`; run once without watch mode: `pnpm start`.
- Typecheck: `pnpm typecheck`.
- Test all: `pnpm test`.
- Test one file: `node --import tsx --test tests/state-machine.test.ts`.
- Test one case: `node --import tsx --test --test-name-pattern="Discovery can become ready then confirmed" tests/state-machine.test.ts`.
- Run `pnpm typecheck` and `pnpm test` before finishing a change.
- Do not invent build, lint, format, code-generation, migration, or CI commands; none are configured.

## Project map

- `src/server.ts` — compose dependencies and register Fastify route modules.
- `src/domain/` — own persisted types, factories, and the Product Spec schema.
- `src/workflow/`, `src/runtime/`, `src/tools/` — own stage rules, turn orchestration, model schemas, and state mutation.
- `src/ai/` — define `AIProvider`, provider implementations, profile persistence, and selection.
- `src/repositories/` — define `ProjectRepository` and its file/in-memory implementations.
- `src/prd/`, `src/interaction/`, `src/figma/` — manage downstream artifact lifecycles.
- `src/routes/` — expose project, provider, and static workspace routes.
- `src/web/` — provide the framework-free browser workspace served by Fastify.
- `data/03 AI Prompt库/` — hold executable prompt assets and their registries.
- `tests/` — hold automated tests; `scripts/` holds live-provider, acceptance, latency, and browser E2E programs.
- `sql/001_init.sql` — describe a future PostgreSQL schema; runtime storage remains file-based.

## Conventions

- Name implementation TypeScript files in kebab-case, use named exports, and keep `.js` suffixes on relative imports. Follow `src/workflow/stage-registry.ts`.
- Keep application composition in `src/server.ts` and provider instantiation in `src/ai/provider-factory.ts`; inject `AIProvider` and `ProjectRepository` into services.
- Route normal model calls through the injected `AIProvider`; use `ProviderLibrary` only for provider profiles, selection, and its dedicated decision path.
- Validate HTTP, model, and prompt-registry input at existing Zod boundaries before mutating state.
- Do not assume persisted project JSON is schema-validated; `normalizeProject()` in `src/repositories/file-project-repository.ts` supplies legacy compatibility.
- Apply workflow mutations through `src/tools/executor.ts`, artifact services, and `ProjectRepository`; preserve revision, record-version, source-version, hash, and stale-state checks.
- Keep error phrases matched by `src/routes/projects.ts` synchronized with its HTTP status mapping and route tests.
- Keep each prompt Markdown file, runtime registry entry, and human registry entry synchronized; select prompts by registry ID rather than filename.
- Keep the browser workspace framework-free and same-origin. Give extracted helpers a matching `.d.ts` and focused test, following `src/web/http-client.js`.

## Adding a model tool

1. Add its Zod schema in `src/tools/schemas.ts` and model schema to `modelTools` in `src/tools/definitions.ts`.
2. Add execution and invariant checks in `src/tools/executor.ts`, then allow it in `src/workflow/stage-registry.ts`.
3. Update the turn operation union and `src/tools/turn-adapter.ts` when it participates in a combined turn.
4. Add executor and complete-turn tests under `tests/`.

## Adding an API endpoint

1. Add the handler and Zod params/body parsing to the owning module in `src/routes/`.
2. Inject an existing service or repository; do not construct business dependencies in the route.
3. Register a new route module in `src/server.ts` only when no existing module owns the endpoint.
4. Add route tests and update the route error mapping for new expected failures.

## Adding a prompt capability

1. Add the prompt Markdown under the matching directory in `data/03 AI Prompt库/`.
2. Update either `3.1 PRD Prompt体系/PRD Prompt Registry.runtime.json` or `3.2 Figma Prompt体系/Figma Prompt Registry.runtime.json`.
3. Add the same capability name to the human registry named by `humanRegistryPath`; update the Figma reusable-asset registry when required.
4. Add or update selection and assembly tests, then run the local gate commands.

## Testing

- Put tests in `tests/` as `*.test.ts`; use `node:test` and `node:assert/strict`.
- Use `InMemoryProjectRepository` and injected `AIProvider` doubles for service and route behavior.
- Use `FileProjectRepository` with a temporary directory only for persistence behavior.
- Treat `pnpm smoke:ai`, `pnpm e2e:*`, and `pnpm audit:latency` as opt-in live checks; `pnpm test` does not include them.

## Boundaries

- Always inspect only files directly related to the task; expand only when a dependency or boundary is unclear.
- Always keep API keys and provider execution server-side; browser responses expose only masked key metadata.
- Always preserve artifact replacement and stale propagation: clear a current artifact through its cleanup path before replacement, and invalidate downstream artifacts after upstream edits.
- Ask before running live-provider or browser E2E commands because they can use external services or write reports.
- Never call provider SDKs from workflow or artifact code; use the injected `AIProvider`.
- Never write project records outside `ProjectRepository` or mutate artifact state outside its service and workflow helpers.
- Never commit `.env`, `.env.local`, `.runtime/`, `reports/`, or benchmark output.
- Never edit `.runtime/projects/*.json` by hand while the service is running; repository writes use locks, atomic replacement, and `recordVersion`.
- Do not perform unrelated refactors.

## Further reading

- [Architecture](docs/ARCHITECTURE.md)
- [Workflow](docs/WORKFLOW.md)
- [AI integration](docs/AI-INTEGRATION.md)
- [Current implementation state](docs/CURRENT-STATE.md)
