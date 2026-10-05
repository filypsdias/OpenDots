# Local harness routing

OpenDots can route a Dot's chat turns through a subscription harness on this
machine: Claude Code, Codex, or GitHub Copilot. Routing is local only (loopback
host, never in a container; development anywhere or the built app on macOS).
The same guard protects the account, login and model-management API.

## Routing

- **Dot defaults** — each Dot has a default harness and model. "Project
  configuration" keeps the server's `MODEL_PROVIDER`.
- **Conversations** copy the Dot's harness and model when created and keep the
  harness forever; only the conversation's model can change. Legacy Dots and
  conversations that ran through a project-configured harness are seeded once
  with that route.
- **Accounts** — one active account per harness, globally: the System default
  or an OpenDots account. Every entry point (chat, page chat, Slack, scheduled
  tasks, voice compute) uses one resolver; a running turn keeps the account it
  started with, and an in-use account cannot be re-authenticated, signed out
  or removed. Only one turn runs per conversation at a time.
- No automatic account, model or provider fallback. Copilot model changes and
  Codex reroutes stop the turn and require a model choice.

## Isolation

Every turn runs in a fresh 0700 runtime home (`CLAUDE_CONFIG_DIR`,
`CODEX_HOME` or `COPILOT_HOME`), deleted afterwards, and receives only the
account credential. Credentials, every provider profile override, Orca/agent
session variables, OpenTelemetry export and shell startup hooks are scrubbed;
telemetry and update checks are disabled.

| Harness        | Tools                                                                                                                                                                                                                                                                                                                                                          | Credential                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code    | `--tools ""`, `--strict-mcp-config` (per-turn loopback bridge only), `--disable-slash-commands`, `--setting-sources ''`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS`/`AUTO_MEMORY`/`GIT_INSTRUCTIONS`, `--permission-mode default` allowing only `mcp__tanstack`.                                                                                                         | `CLAUDE_CODE_OAUTH_TOKEN`. Managed: minted by `claude setup-token` in a throwaway profile, stored in Keychain under an OpenDots-only service. System default: the ordinary `Claude Code-credentials` Keychain item, read-only.                                                                                                                                                                      |
| Codex          | `codex app-server` thread with `environments: []` (confirmed by the server, or the turn is refused), `stable_environment_tools=false`, apps/plugins/hooks/MCP/collaboration/web search off; OpenDots tools are dynamic tools executed by OpenDots; native items, approvals, other threads/turns and repeated call IDs stop the turn. Requires Codex ≥ 0.160.0. | Copy of the account's `auth.json`. Managed: `codex login` (file storage) in a throwaway home, promoted into the private profile only if the login is still current; refreshed tokens are kept by compare-and-swap. System default: ordinary `~/.codex/auth.json`, read-only, with the refresh token removed so it can never be rotated.                                                             |
| GitHub Copilot | Official `@github/copilot-sdk` session: only OpenDots custom tools in `availableTools`, everything else denied; config discovery, custom instructions, skills, file hooks, MCP servers, telemetry and git operations off.                                                                                                                                      | Managed: token from `gh auth login` in an isolated `GH_CONFIG_DIR` (requires GitHub CLI), stored in Keychain, used with `useLoggedInUser: false`. System default: Copilot's own login resolution (`useLoggedInUser: true`) with an empty GitHub CLI profile, so a gh identity is never substituted; if Copilot's own login cannot be resolved from the isolated runtime, sign-in guidance is shown. |

## Recovery

Provider errors are classified inside the adapter (quota, auth, model, missing
CLI, unknown) before any engine or app logging; only application-authored text
is shown. Side-effecting OpenDots tools are journaled durably per user message:
intent is recorded before execution and the full result afterwards. An explicit
continuation (bound to the unanswered message; a new message discards it)
returns stored results for identical completed actions, refuses actions whose
outcome is unknown, and rechecks current permissions first. Turns interrupted
by a server restart are marked failed with unknown tool outcomes.

## Evidence for credential handling

- **Copilot System default.** In the installed package
  (`@github/copilot-darwin-arm64/app.js`), the auth manager's `"user"` login is
  `{host, login}` from `authGetLastLoggedInUser(path)` over
  `$COPILOT_HOME/config.json` (`_x`/`jK` resolve `config` under the home), and
  its token comes from `tokenStoreGetToken(store, host, login, configPath, …)`
  (`x9n.getToken`), a Rust keyring store in `prebuilds/darwin-arm64/runtime.node`
  (`keyring` + `apple-native-keyring-store`). The native state keys
  (`stateGlobalStateKeysJson`) are `lastLoggedInUser`, `loggedInUsers` and
  `copilotTokens` (plaintext fallback). OpenDots copies only the active
  `{host, login}` from the ordinary `~/.copilot/config.json` into the turn's
  private home — never tokens, settings, plugins, hooks or MCP config — writes
  `disableAllHooks`/`remoteExport: false` to its `settings.json`, empties
  `GH_CONFIG_DIR`, and before any session requires `getAuthStatus()` to report
  `authType: "user"` with exactly that login and host. Without an ordinary
  Copilot login the turn stops with `copilot login` guidance.
- **Claude.** The installed binary reads `claudeAiOauth.accessToken`,
  `refreshToken` and `expiresAt` from the `Claude Code-credentials` item, and
  documents `CLAUDE_CODE_OAUTH_TOKEN` (and `claude setup-token`) for
  inference-only tokens.
- **Codex.** A fake `auth.json` without `refresh_token` fails Codex's parser
  (`missing field refresh_token`); with an empty value it is accepted. System
  default snapshots therefore carry `refresh_token: ""`, so a refresh can never
  rotate the ordinary login. Codex's default credential store is `file`
  (`CODEX_HOME/auth.json`); keyring-only ordinary logins show sign-in guidance.

## Known limitations

- No live inference or login ran during development. Native flag and SDK
  behavior was verified from installed help text, binary strings, generated
  Codex protocol schemas and SDK type definitions, with fake CLI and SDK
  fixtures.
- `claude setup-token` and `gh auth login` run without a terminal UI; a code the
  browser shows can be pasted in Settings. The Claude Keychain JSON shape and the
  Codex `last_refresh` field are based on observed formats, not documentation.
- Copilot's keyring service naming lives in native code: the source shows the
  lookup is keyed by `(host, login)` and receives the config path only for the
  plaintext fallback, but whether the keyring entry itself depends on
  `COPILOT_HOME` could not be proven without a live login. If it does, the System
  default fails closed with guidance instead of using another identity. Logins
  stored only in the plaintext `copilotTokens` map (keyring unavailable or
  `storeTokenPlaintext`) are not projected, because that key format is built in
  native code; they also fail closed.
- Copilot model discovery uses the SDK; Claude uses a catalog plus custom IDs.
