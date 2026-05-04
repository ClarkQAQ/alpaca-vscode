# AGENTS.md

This file provides guidance to Clark Claude Code (ccc) when working with code in this repository.

## Build & Development Commands

| Command | Description |
|---------|-------------|
| `bun run compile` | TypeScript compilation (`tsc -p ./`) |
| `bun run watch` | TypeScript watch mode |
| `bun run bundle` | esbuild production bundle (`dist/extension.js`, minified) |
| `bun run packge` | Create `.vsix` package via `vsce` |
| `bun run lint` | ESLint check |
| `bun run format` | Prettier formatting |

## Architecture

**alpaca-vscode** is a stripped-down VS Code extension forked from [llama.vscode](https://github.com/ggml-org/llama.vscode). It focuses on exactly two features:

1. **Inline code completion (FIM)** — local LLM-powered code suggestions
2. **Git commit message generation** — generates commit messages from git diff

### High-Level Data Flow

```
User types in editor
  → InlineCompletionItemProvider (completion.ts)
    → debounce → LRU cache lookup
      → llama.cpp server /infill endpoint
        → result caching → future-request prefetching

SCM commit box
  → generateGitCommitMessage command (commit.ts)
    → git diff → chat /chat/completions
      → commit message inserted into SCM input
```

### Source Files

| File | Purpose |
|------|---------|
| `extension.ts` | Entry point — wires up completion, commit, and status bar |
| `completion.ts` | FIM logic — config, LRU cache, ring buffer context, provider, commands |
| `commit.ts` | Commit message generation — config, HTTP call, command registration |
| `statusbar.ts` | Status bar indicator showing completion state and performance stats |
| `logger.ts` | Event logger for debugging |
| `utils.ts` | Shared helper functions (text manipulation, delays) |
| `types.ts` | TypeScript interfaces for API responses |

### Configuration

All settings are under the `alpaca-vscode.*` namespace:

**Completion:**
- `completion_endpoint` — llama.cpp server URL for FIM (`/infill`)
- `completion_model` — model name to send in FIM requests (optional)
- `completion_api_key` — API key for the completion endpoint
- `n_prefix`, `n_suffix`, `n_predict` — FIM context window and generation length
- `auto` / `debounce_ms` — automatic trigger and debounce delay
- `max_cache_keys` — LRU cache size
- `ring_n_chunks`, `ring_chunk_size`, `ring_scope`, `ring_update_ms` — ring buffer context

**Commit:**
- `commit_endpoint` — chat endpoint URL
- `commit_model` — model name (e.g. `google/gemini-2.5-flash`)
- `commit_api_key` — API key for the commit endpoint
- `commit_api_version` — API version path (default `v1`)

**Shared:**
- `enabled` — global completion toggle
- `language_settings` — per-language enable/disable (`{ "markdown": false }`)
- `show_info` — show performance stats in status bar

## Key Architecture Notes

- **No classes, no singletons** — pure function modules with closure state
- **FIM caching**: LRU cache with prefix matching — caches are reused even when the cursor prompt differs
- **No UI, menus, or webviews**: All configuration via VS Code `settings.json` directly
- **No agent, RAG, embeddings, tools model**: These features have been removed from the original fork
