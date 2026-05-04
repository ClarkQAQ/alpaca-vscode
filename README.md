# alpaca-vscode

A lean VS Code extension for **FIM code completion** and **git commit message generation**, powered by [llama.cpp](https://github.com/ggerganov/llama.cpp).

Forked from [ggml-org/llama.vscode](https://github.com/ggml-org/llama.vscode) — stripped down to just the essentials, with all agent, RAG, chat, embeddings, and webview features removed.

## Features

- **Inline code completion** — Fill-In-Middle (FIM) suggestions as you type, via llama.cpp's `/infill` endpoint
- **Git commit message generation** — automatically generate commit messages from staged changes
- **Ring buffer context** — smart context reuse from open files, yanked text, and recent edits
- **LRU cache with prefix matching** — cached completions are reused even when the cursor prompt differs
- **Status bar stats** — real-time performance metrics (tokens/sec, cache hits, context size)
- **No UI, no webview, no menus** — everything is configured via `settings.json`

## Quick Start

### 1. Install alpaca-vscode

Install the `.vsix` package via VS Code: Extensions → `...` → Install from VSIX.

### 2. Install llama.cpp

```bash
# macOS
brew install llama.cpp

# Windows
winget install llama.cpp

# Linux — download binaries from:
# https://github.com/ggerganov/llama.cpp/releases
```

### 3. Start a llama.cpp server

For code completion (FIM), start a server with a FIM-compatible model:

```bash
# Downloads Qwen2.5-Coder-1.5B and starts the server on port 8012
llama-server --fim-qwen-1.5b-default
```

For commit message generation (optional), start a second server with a chat model:

```bash
# Downloads Qwen2.5-Coder-1.5B-Instruct and starts on port 8011
llama-server -hf ggml-org/Qwen2.5-Coder-1.5B-Instruct-Q8_0-GGUF --port 8011
```

### 4. Configure in VS Code settings.json

Minimal setup (completion only):

```jsonc
{
  "alpaca-vscode.completion_endpoint": "http://127.0.0.1:8012"
}
```

With commit message generation:

```jsonc
{
  "alpaca-vscode.completion_endpoint": "http://127.0.0.1:8012",
  "alpaca-vscode.commit_endpoint": "http://127.0.0.1:8011"
}
```

Using an external API provider for commit messages (e.g. OpenRouter):

```jsonc
{
  "alpaca-vscode.completion_endpoint": "http://127.0.0.1:8012",
  "alpaca-vscode.commit_endpoint": "https://openrouter.ai/api",
  "alpaca-vscode.commit_model": "google/gemini-2.5-flash",
  "alpaca-vscode.commit_api_key": "sk-or-v1-..."
}
```

That's it — start typing in the editor to get completions, and click the sparkle icon ✨ in the SCM input box to generate a commit message.

## Configuration Reference

| Setting | Default | Description |
|---------|---------|-------------|
| `completion_endpoint` | `""` | llama.cpp server URL for FIM code completion |
| `completion_model` | `""` | Model name sent in FIM requests |
| `completion_api_key` | `""` | API key for the completion endpoint |
| `commit_endpoint` | `""` | Chat endpoint URL for commit messages |
| `commit_model` | `""` | Model name for the chat endpoint |
| `commit_api_key` | `""` | API key for the commit endpoint |
| `commit_api_version` | `"v1"` | API version path (appended to commit_endpoint) |
| `enabled` | `true` | Globally enable/disable completions |
| `language_settings` | `{}` | Per-language toggles, e.g. `{ "markdown": false }` |
| `auto` | `true` | Trigger completions automatically |
| `debounce_ms` | `0` | Debounce delay before triggering |
| `n_prefix` | `256` | Lines of prefix context |
| `n_suffix` | `64` | Lines of suffix context |
| `n_predict` | `128` | Max tokens to generate |
| `t_max_prompt_ms` | `500` | Max prompt processing time |
| `t_max_predict_ms` | `2500` | Max token generation time |
| `max_cache_keys` | `250` | FIM result cache size |
| `ring_n_chunks` | `16` | Max ring buffer chunks |
| `ring_chunk_size` | `64` | Lines per chunk |
| `ring_scope` | `1024` | Context scan range around cursor |

## Keybindings

| Key | Action |
|-----|--------|
| `Tab` | Accept inline suggestion |
| `Alt+Space` | Force-trigger completion (bypass cache) |

## Building from Source

```bash
bun install
bun run bundle          # produces dist/extension.js
bun run package          # produces .vsix package
```

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

This project is a fork of [llama.vscode](https://github.com/ggml-org/llama.vscode) by ggml-org. The original extension was implemented by Ivaylo Gardev ([@igardev](https://github.com/igardev)), using [llama.vim](https://github.com/ggml-org/llama.vim) as a reference. alpaca-vscode strips away the agent, RAG, embeddings, chat UI, and webview features, keeping only FIM completion and commit message generation.

The LLM backend is powered by [llama.cpp](https://github.com/ggerganov/llama.cpp) by ggerganov.
