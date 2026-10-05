// Native-tool lockdown for each local harness. Every harness may call only the
// OpenDots tools served by the per-turn loopback MCP bridge ("tanstack"); those
// tools run inside OpenDots, where Dot/Space/computer permission checks apply.
// Ambient CLI tools, plugins, hooks, skills, user MCP servers and project
// instructions are disabled. Values are generated here so tests can assert the
// exact configuration rather than a mock.

export const BRIDGE_SERVER = 'tanstack';

/** POSIX single-quote escape. */
export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const CLAUDE_WRAPPER = '.opendots-claude';

/** Claude Code: no built-in tools, only the bridge MCP config, no skills. */
export const CLAUDE_LOCKDOWN_ARGS = [
  '--tools',
  '',
  '--strict-mcp-config',
  '--disable-slash-commands',
] as const;

export function claudeWrapperScript() {
  return `#!/bin/sh\nexec claude ${CLAUDE_LOCKDOWN_ARGS.map(shellQuote).join(' ')} "$@"\n`;
}

/** Adapter options that pair with the wrapper. */
export const CLAUDE_ADAPTER_POLICY = {
  // `--setting-sources ''`: no user, project or local settings at all, so
  // ancestor .claude/settings.json hooks or plugins can never load.
  settingSources: [] as Array<'project'>,
  // Non-interactive default mode denies anything not explicitly allowed.
  permissionMode: 'default' as const,
  allowedTools: [`mcp__${BRIDGE_SERVER}`],
  emitDiff: false,
};

// Codex: see codex-app-server.ts (thread with `environments: []`).

// Copilot: see copilot-adapter.ts (official SDK session configuration).
