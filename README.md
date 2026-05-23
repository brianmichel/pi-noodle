# mem0-client pi extension

Source-based, publish-ready Pi extension package for talking to a self-hosted Mem0 REST API.

This repo uses a regular `package.json` with a `pi` manifest, a refactored `src/` layout, and a root `index.ts` shim so it works both as a normal Pi package and as a checked-out local extension.

By default, it uses `agent_id: "pi"` for add/search/list operations unless you explicitly override `agent_id`.
It also tries to auto-save useful session memories before compaction, before session switches like `/new`, and on session shutdown.

## Tools

- `mem0_add_memory`
- `mem0_search_memories`
- `mem0_list_memories`
- `mem0_get_memory`
- `mem0_update_memory`
- `mem0_delete_memory`

## Commands

- `/mem0-config show`
- `/mem0-config set <baseUrl> <apiKey> [userId]`
- `/mem0-config clear`
- `/mem0-test`

## Config

The command stores config in a normal user config location instead of inside the extension directory:

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
```

The repository includes:

- `.mise.toml` — pins Node.js for local development
- `tsconfig.json` — strict typechecking
- `package.json` `check` script — runs `tsc --noEmit`

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
- `src/tools.ts` — Mem0 tool definitions
- `src/commands.ts` — slash commands
- `src/api.ts` — HTTP request helpers
- `src/config.ts` — config path and config loading logic
- `src/session.ts` — session memory extraction and autosave helpers
- `src/types.ts` — shared types
- `src/utils.ts` — string/JSON helpers
- `src/queue.ts` — async write queue
- `index.ts` — root shim for Pi auto-discovery in `.pi/extensions/*/index.ts`
- `package.json` — Pi package manifest for npm/git installs
- `tsconfig.json` — strict typechecking support
- `.mise.toml` — local toolchain pinning
