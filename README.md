# mem0-client pi extension

Source-based, publish-ready Pi memory extension with a **generic memory interface** backed by a self-hosted **Mem0** backend by default.

This repo uses a regular `package.json` with a `pi` manifest, a refactored `src/` layout, and a root `index.ts` shim so it works both as a normal Pi package and as a checked-out local extension.

The public interface is intentionally provider-agnostic:
- generic `memory_*` tools
- provider-agnostic memory records, search inputs, and scopes
- automatic memory capture + retrieval policy in a service layer
- Mem0-specific request paths and payload mapping hidden behind the default backend adapter

## Tools

- `memory_add`
- `memory_search`
- `memory_list`
- `memory_get`
- `memory_update`
- `memory_delete`

## Commands

- `/memory-config show`
- `/memory-config set <baseUrl> <apiKey> [userId]`
- `/memory-config clear`
- `/memory-test`

## Backend

The default backend implementation is Mem0.

That means this extension currently stores its backend config using Mem0 environment names and connection details, but the extension logic itself now talks to a generic memory service rather than directly to Mem0 request paths.

## Config

The config command stores backend config in a normal user config location instead of inside the extension directory:

- macOS: `~/Library/Application Support/pi/extensions/mem0-client/config.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/pi/extensions/mem0-client/config.json`
- Windows: `%APPDATA%/pi/extensions/mem0-client/config.json`

You can override that path with:

- `MEM0_CONFIG_PATH`

You can also use env vars instead:

- `MEM0_BASE_URL`
- `MEM0_API_KEY`
- `MEM0_USER_ID` (optional)

## Development

This repo uses [mise](https://mise.jdx.dev/) to pin local tooling.

```bash
mise install
npm install
npm run check
npm test
```

The repository includes:

- `.mise.toml` — pins Node.js for local development
- `tsconfig.json` — strict typechecking
- `package.json` `check` script — runs `tsc --noEmit`
- `package.json` `test` script — runs the Node test suite

## Install

### As a Pi package

Install from git or npm with Pi's package support, for example:

```bash
pi install git:<your-repo-url>
```

Pi discovers the extension via `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

### As a checked-out local extension

Pi also auto-discovers project-local extensions from `.pi/extensions/*/index.ts`, so you can place this repo at:

- `.pi/extensions/mem0-client/`

## Reload

Run `/reload` in Pi after adding or changing the extension.

## Structure

- `src/index.ts` — src entrypoint
- `src/extension.ts` — extension wiring and event registration
- `src/tools.ts` — generic memory tool definitions
- `src/commands.ts` — backend configuration and diagnostics commands
- `src/api.ts` — HTTP request helpers with base URL fallback
- `src/config.ts` — backend config path and loading logic
- `src/session.ts` — session message extraction helpers
- `src/memory/backend.ts` — provider-agnostic backend interface
- `src/memory/mem0-backend.ts` — Mem0 adapter implementation
- `src/memory/runtime.ts` — default backend wiring
- `src/memory/service.ts` — provider-agnostic memory service and auto-capture flow
- `src/memory/policy.ts` — heuristics, retrieval gating, and scoring policy
- `src/memory/types.ts` — provider-agnostic memory domain types
- `src/types.ts` — shared non-memory types
- `src/utils.ts` — string/JSON helpers
- `src/queue.ts` — async work queue
- `index.ts` — root shim for Pi auto-discovery in `.pi/extensions/*/index.ts`
- `package.json` — Pi package manifest for npm/git installs
- `tsconfig.json` — strict typechecking support
- `.mise.toml` — local toolchain pinning
