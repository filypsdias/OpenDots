# Local harness routing

OpenDots can route a Dot's chat turns through a subscription CLI on this
machine: Claude Code, Codex, or GitHub Copilot CLI. Routing is local only
(loopback host, no containers; development anywhere or the built app on macOS).

## Routing

- **Dot defaults** — each Dot has a default harness and model (Dot settings ›
  Model route). "Project configuration" keeps the server's `MODEL_PROVIDER`.
- **Conversations** copy the Dot's harness and model when created. The harness
  never changes afterwards; the model can be changed in that conversation only.
- **Accounts** — Settings › Local harnesses lists a System default and any
  OpenDots-owned accounts. One account per harness is active globally. Every new
  turn (chat, page chat, Slack, scheduled tasks, voice compute) uses the active
  account; a running turn keeps the account it started with.
- There is no automatic account, model or provider fallback. A missing model or
  account stops the turn with guidance.

## Tool boundary

Each harness sees only OpenDots tools, which run in the OpenDots server with the
existing Dot, Space and computer permission checks.

| Harness     | Mechanism                                                                                                                                                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `--tools ""`, `--strict-mcp-config` (only the per-turn loopback bridge), `--disable-slash-commands`, `--setting-sources project` in an empty per-thread directory, `--permission-mode default` with only `mcp__tanstack` allowed.                                                                                                                  |
| Codex       | `codex app-server` thread with `environments: []` (no shell, patch, file or image tools), `features.stable_environment_tools=false`, apps/plugins/collaboration/web search disabled, `mcp_servers={}`; OpenDots tools are dynamic tools executed by OpenDots. Native tool items or approval requests stop/deny the turn. Requires Codex ≥ 0.160.0. |
| Copilot CLI | `--available-tools` limited to `tanstack-*` bridge tools, `--disable-builtin-mcps`, `--no-custom-instructions`, `--no-ask-user`; managed homes set `disableAllHooks`.                                                                                                                                                                              |

The **System default** is supported for Claude Code only. Codex and Copilot load
user hooks, plugins, MCP servers and profiles from their default home, which
OpenDots cannot disable per run, so they require an OpenDots-managed account.

## Accounts and secrets

Managed profiles live outside the repository (macOS:
`~/Library/Application Support/OpenDots/harness-profiles`, mode 0700) and are
selected per child process with `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or
`COPILOT_HOME`. Inherited credentials and profile overrides are scrubbed. Native
login flows store credentials (Claude Code and Copilot use the macOS Keychain;
Codex uses its profile). APIs return only non-secret status and identity.
Account details and receipts are never sent to models or CopilotKit metadata.

## Recovery

Quota, auth, model and missing-CLI failures show an application-authored message
and a local receipt. The owner chooses an account and explicitly continues: the
thread re-runs without a duplicate user message, completed tool results are
restated instead of replayed, and interrupted tool calls are reported as having
an unknown outcome. Background failures wait for the owner.

## Known limitations

- Live CLI behaviour was verified only against local help, generated protocol
  schemas and fixtures; no live inference or login was run during development.
- Copilot CLI's JSONL event names and MCP tool naming (`<server>-<tool>`) are not
  formally documented; the adapter fails closed if they differ.
- Copilot has no machine-readable auth status; status is known after login or a
  turn. Copilot sign-out cannot remove Keychain credentials.
- Model discovery uses `codex debug models` for Codex; Claude and Copilot use a
  catalog plus custom IDs.
