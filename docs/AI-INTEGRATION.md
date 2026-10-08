# AI Integration

All workflow code depends on the shared `AIProvider.generate(...)` contract. `ProviderLibrary` selects either Local Codex or a saved OpenAI-compatible profile and persists the active selection server-side.

Discovery and Product Solution normally use one structured call, with one bounded schema repair. PRD uses Meta selection plus Generation; Interaction uses Generation; Figma Prompt uses Meta selection followed by deterministic assembly.

Browser requests never contain API keys. Long-running stage and artifact generation requests expose metadata-only progress through `/requests/:requestId`.

Manual Bridge performs no provider call. It signs the current project revision, validates the pasted structured block, and applies it atomically through the same executor used by provider turns.
