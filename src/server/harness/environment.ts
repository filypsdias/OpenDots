import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { HarnessProvider } from '../../shared/harness.js';
import type { AccountSnapshot } from './store.js';

/**
 * OpenDots-owned profiles live in per-user app data, never in the repository.
 * macOS: ~/Library/Application Support/OpenDots/harness-profiles.
 */
export function profileRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  repository = process.cwd(),
): string {
  const root = env.OPENDOTS_PROFILE_ROOT?.trim()
    ? resolve(env.OPENDOTS_PROFILE_ROOT)
    : platform === 'darwin'
      ? join(
          home,
          'Library',
          'Application Support',
          'OpenDots',
          'harness-profiles',
        )
      : join(
          env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share'),
          'opendots',
          'harness-profiles',
        );
  const inside = relative(resolve(repository), root);
  if (!inside || (!inside.startsWith('..') && !isAbsolute(inside)))
    throw new Error(
      'Harness profiles must be stored outside the OpenDots repository.',
    );
  return root;
}

export function profileDirectory(root: string, snapshot: AccountSnapshot) {
  if (!snapshot.profileKey || !/^[a-f0-9-]{36}$/.test(snapshot.profileKey))
    throw new Error('Account profile is unavailable.');
  return join(root, snapshot.provider, snapshot.profileKey);
}

/** Creates the private profile directory (0700) for a managed account. */
export function ensureProfile(root: string, snapshot: AccountSnapshot) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const dir = profileDirectory(root, snapshot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // Copilot reads user-level hooks from its home config; a managed profile
  // starts with every hook disabled (documented `disableAllHooks`).
  const copilotConfig = join(dir, 'config.json');
  if (snapshot.provider === 'copilot' && !existsSync(copilotConfig))
    writeFileSync(copilotConfig, JSON.stringify({ disableAllHooks: true }), {
      mode: 0o600,
    });
  return dir;
}

export function deleteProfile(root: string, snapshot: AccountSnapshot) {
  rmSync(profileDirectory(root, snapshot), { recursive: true, force: true });
}

const PROFILE_VARIABLE: Record<HarnessProvider, string> = {
  'claude-code': 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  copilot: 'COPILOT_HOME',
};

// Inherited variables that would silently replace the selected subscription
// login with another credential, endpoint or provider.
const AUTH_OVERRIDES: Record<HarnessProvider, string[]> = {
  'claude-code': [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  ],
  codex: [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_API_BASE',
    'CODEX_MODEL',
  ],
  copilot: [
    'COPILOT_GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'COPILOT_MODEL',
    'COPILOT_ALLOW_ALL',
    'COPILOT_OFFLINE',
    'COPILOT_CUSTOM_INSTRUCTIONS_DIRS',
    'COPILOT_ASSISTED_APPROVAL',
    'GH_HOST',
    'COPILOT_GH_HOST',
  ],
};

/**
 * Every inherited variable the child must not see for this provider. All
 * provider profile overrides are removed (the parent may itself run under a
 * managed CLI profile); a managed account then sets its own profile explicitly.
 */
export function scrubbedVariables(
  provider: HarnessProvider,
  env: NodeJS.ProcessEnv = process.env,
  keepProfile = false,
): string[] {
  const keys = Object.keys(env).filter(
    (key) =>
      /(?:_KEY|_TOKEN|_SECRET)$/i.test(key) ||
      /^_*(?:VARLOCK|DMNO)_/i.test(key) ||
      /^COPILOT_PROVIDER_/i.test(key) ||
      ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key) ||
      Object.values(AUTH_OVERRIDES).some((list) => list.includes(key)),
  );
  const profiles = Object.entries(PROFILE_VARIABLE)
    .filter(([owner]) => !(keepProfile && owner === provider))
    .map(([, variable]) => variable);
  return [...new Set([...keys, ...AUTH_OVERRIDES[provider], ...profiles])];
}

/**
 * Account-bound child variables. Managed accounts point the native CLI at
 * their private profile; the system account keeps the ordinary CLI profile and
 * OpenDots never writes to it.
 */
export function accountVariables(
  root: string,
  snapshot: AccountSnapshot,
): Record<string, string> {
  if (snapshot.kind === 'system') return {};
  return {
    [PROFILE_VARIABLE[snapshot.provider]]: profileDirectory(root, snapshot),
  };
}

export function profileVariable(provider: HarnessProvider) {
  return PROFILE_VARIABLE[provider];
}
