# pi-noodle

Long-term memory for Pi.

This repo is building a small, opinionated memory system that tries to be:

- **useful** — retrieve facts that actually help future turns
- **safe** — avoid saving temporary or sensitive content
- **automatic** — capture durable signals from normal conversation
- **inspectable** — review what was saved, pending, or discarded

Under the hood it uses the [Turso database engine](https://docs.turso.tech/introduction) (via `@tursodatabase/database` for local, `@tursodatabase/sync` for local-first sync, and `@tursodatabase/serverless` for cloud) for storage and native vector similarity search for retrieval.

![](img/dashboard.jpeg)

## Quick start

```bash
# Install as a Pi extension
pi install @brianmichel/pi-noodle

# In Pi, configure interactively
/noodle settings
```

The setup screen shows the full config on one page:
1. Database mode — local file, Turso Cloud, or local-first Sync
2. Embedding provider — OpenAI, LM Studio, Ollama, or custom
3. Relevant fields update in place as you switch modes/providers
4. Required fields are validated before save

Settings are saved to `~/.pi/noodle/config.json` — memories travel with you across all projects.

## `/noodle` command

```
/noodle                  Show current config (paths, endpoint, masked API key)
/noodle remember <text>  Save a memory directly
/noodle forget <query>   Find and delete a memory
/noodle edit <query>     Find and update a memory
/noodle review           Review recent auto-saved memories
/noodle sync             Push/pull a sync-mode DB with Turso Cloud (flushes writes first)
/noodle settings         Interactive single-screen configuration editor with validation
/noodle setup            Alias for /noodle settings
/noodle init             Create a default config file for manual editing
/noodle web              Start the Memory Explorer (auto-stops when all tabs close)
/noodle web stop         Stop the explorer immediately
/noodle web dev          Dev mode — hot reload on save, use web stop when done
/noodle web 8080         Start on a custom port
```

For UI development outside Pi, run `npm run web:dev` from the repo — it connects to your configured database and reloads the browser whenever you edit `src/web/index.html`.

### Memory Explorer Web UI

Launch a dark-themed web interface to browse, search, and visualize your memories:

- **Live stats** — total memories, categories, scopes
- **Category filter** — dropdown of all stored categories
- **Text search** — substring matching on memory text
- **Dark mode** — GitHub-inspired color scheme

Run `/noodle web` in Pi to open the explorer in your browser. The server runs in a background process and **shuts down automatically ~2 seconds after you close all tabs**. Use `/noodle web stop` to kill it manually.

## Config file

`~/.pi/noodle/config.json`:

```json
{
  "db": {
    "mode": "local",
    "path": "/Users/you/.pi/noodle/memories.db"
  },
  "embedding": {
    "provider": "openai",
    "apiKey": "sk-...",
    "baseUrl": "https://api.openai.com/v1",
    "model": "text-embedding-3-small"
  }
}
```

### Sync mode (local-first + cloud sync)

Local-first embedded replica: all reads and writes hit a local Turso database
file, and changes are pushed to / pulled from Turso Cloud on a configurable
interval (and on `/noodle sync`). On first launch the local DB bootstraps from
the remote, so the remote must be reachable once. Set `syncIntervalSeconds` to
`0` for manual-only sync.

```json
{
  "db": {
    "mode": "sync",
    "path": "/Users/you/.pi/noodle/memories.db",
    "url": "libsql://my-db-org.turso.io",
    "authToken": "eyJ...",
    "syncIntervalSeconds": 300
  },
  "embedding": {
    "provider": "openai",
    "apiKey": "sk-...",
    "baseUrl": "https://api.openai.com/v1",
    "model": "text-embedding-3-small"
  }
}
```

### Cloud mode (Turso)

```json
{
  "db": {
    "mode": "cloud",
    "url": "libsql://my-db-org.turso.io",
    "authToken": "eyJ..."
  },
  "embedding": {
    "provider": "openai",
    "apiKey": "sk-...",
    "baseUrl": "https://api.openai.com/v1",
    "model": "text-embedding-3-small"
  },
  "extractor": {
    "mode": "balanced",
    "model": "deepseek/deepseek-v4-flash:free",
    "triggerEvery": 10
  }
}
```

### Memory modes

When memory mode is not `off`, capture uses a **unified capture pipeline** with policy-gated persistence:

- `conservative`
  - fewer extraction runs
  - higher bar for auto-save
  - softer inferences are usually discarded until reinforced
- `balanced` (recommended default)
  - durable facts can auto-save
  - medium-confidence preferences go to `/noodle review`
- `proactive`
  - more frequent extraction
  - more candidate discovery
  - pending review queue grows faster, but saved-memory safety rules stay the same

The extractor model is configurable too, so you can tune quality/speed/cost separately from behavior mode.

## Environment variable overrides

Env vars take priority over the config file:

| Variable | Overrides |
|---|---|
| `NOODLE_CONFIG_PATH` | Config file location |
| `NOODLE_DB_PATH` | Local DB path |
| `NOODLE_DB_URL` | Cloud DB URL (sets mode to `cloud`) |
| `NOODLE_DB_TOKEN` | Cloud DB auth token |
| `NOODLE_DB_SYNC_URL` | Sync DB URL (sets mode to `sync`) |
| `NOODLE_DB_SYNC_INTERVAL` | Sync push/pull interval in seconds (`0` = manual) |
| `OPENAI_API_KEY` | Embedding API key |
| `EMBEDDING_BASE_URL` | Embedding endpoint URL |
| `EMBEDDING_MODEL` | Embedding model name |
| `NOODLE_EXTRACTOR_MODE` | Memory mode: off / conservative / balanced / proactive |
| `NOODLE_EXTRACTOR_MODEL` | Extractor model ID |
| `NOODLE_EXTRACTOR_TRIGGER_EVERY` | Automatic extraction cadence in user turns |
| `NOODLE_EXTRACTOR_DEBUG` | Show the extractor debug widget: true / false |

## Architecture

```text
Pi lifecycle events
  └─► MemoryService.capture(event)
        ├─► heuristic capture
        ├─► optional LLM extraction
        ├─► candidate promotion policy
        └─► conversation capture / consolidation when needed
                    │
                    ▼
              MemoryBackend
                    │
               TursoBackend
               ├─► Turso engine (local database | sync | serverless)
               └─► Embedder
```

### Capture pipeline

```text
input / compact / switch / shutdown
  │
  └─► MemoryService.capture(event)
        │
        ├─► heuristic prefilter
        │      ├─ blocks sensitive / temporary content
        │      └─ catches explicit memory asks
        │
        ├─► optional LLM extraction
        │      └─ turns conversation context into memory candidates
        │
        ├─► local promotion policy
        │      ├─ save     → durable memory DB
        │      ├─ pending  → /noodle review only
        │      └─ discard  → dropped
        │
        └─► retrieval injects only saved memories
```

### Why it is shaped this way

- Pi only tells the memory system **what event happened**
- `MemoryService` decides **which capture stages should run**
- heuristic and LLM candidates share the **same promotion path**
- pending memories stay out of retrieval until reviewed or reinforced

### What gets stored

Every memory is a row in the local Turso database with `text`, `embedding` (stored as a vector BLOB via `vector32()`), `category`, `categories`, `scope` (userId/assistantId/sessionId), and arbitrary `metadata`.

### Search

Vector similarity via `vector_distance_cos()` in Turso, ranked by cosine distance, post-filtered by category and threshold.

### Policy and review

The system intentionally separates:

- **detection** — heuristics and LLM extraction find memory candidates
- **promotion** — local policy decides save / pending / discard
- **retrieval** — only saved memories are injected into prompts

That keeps the system proactive without letting low-confidence guesses pollute retrieval. Pending candidates stay visible in `/noodle review` but are **not** injected until promoted.

## File layout

```
src/
├── config.ts              # Config resolution (~/.pi/noodle/config.json + env vars)
├── config-screen.ts       # Flat single-screen config editor for /noodle settings
├── constants.ts           # DEFAULT_AGENT_ID
├── types.ts               # NoodleConfig, JsonObject, NotificationTarget, etc.
├── utils.ts               # maskSecret, describeError, formatJson, extractTextContent
├── commands.ts            # /noodle command + interactive setup entrypoint
├── commands/           # index, status, setup, sync, review, memory-crud, web, ui
├── extension.ts           # Pi extension lifecycle hooks
├── tools.ts               # memory_add / search / list / get / update / delete
├── session.ts             # Session message collection
├── queue.ts               # Sequential async write queue
├── notifications.ts       # UI notification helpers
└── memory/
    ├── backend.ts         # MemoryBackend interface
    ├── types.ts           # MemoryRecord, MemoryScope, etc.
    ├── turso-backend.ts   # TursoBackend (Turso engine + vector search)
    ├── turso-client.ts    # Engine picker + libSQL-compat adapter + lazy backend
    ├── sync-manager.ts    # SyncManager (push/pull + interval for sync mode)
    ├── embedder.ts        # Embedder type
    ├── embedders/         # openai.ts, lm-studio.ts
    ├── service.ts         # MemoryService (event-driven capture pipeline + promotion)
    ├── policy.ts          # Heuristics (classification, repetition, retrieval)
    └── runtime.ts         # Wiring (config + TursoBackend + MemoryService + SyncManager)
```
