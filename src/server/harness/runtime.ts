import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import type { HarnessProvider } from '../../shared/harness.js';
import { HarnessTurnError } from './errors.js';
import { profileVariable, scrubbedVariables } from './environment.js';
import { snapshotCodexAuth } from './credentials.js';

/** The only credential a turn receives, injected by environment. */
export type TurnCredential =
  | { provider: 'claude-code'; oauthToken: string }
  /** Managed: explicit token. System default: Copilot's own logged-in user. */
  | { provider: 'copilot'; githubToken: string | null }
  /** `refreshable` is false for System default snapshots (no refresh token). */
  | { provider: 'codex'; authJson: string; refreshable: boolean };

/** Nonessential traffic, telemetry and update checks are switched off. */
export const QUIET_ENVIRONMENT: Record<string, string> = {
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DO_NOT_TRACK: '1',
  COPILOT_AUTO_UPDATE: 'false',
  NO_COLOR: '1',
};

export const COPILOT_TOKEN_VARIABLE = 'COPILOT_SDK_AUTH_TOKEN';

export interface TurnRuntime {
  /** Fresh private home: no config, plugins, hooks, MCP or instructions. */
  home: string;
  /** Variables to set on the child. */
  env: Record<string, string>;
  /** Inherited variables to remove (never includes anything in `env`). */
  scrub: string[];
  /**
   * Refreshed managed Codex auth after the turn, with the auth the turn
   * started from (for compare-and-swap), or null when nothing changed.
   */
  refreshedCodexAuth(): { original: string; refreshed: string } | null;
  dispose(): void;
}

/**
 * Builds the isolated runtime for one turn. The CLI's home directory is an
 * empty temporary profile created for this turn only, so the ordinary CLI or
 * Orca profile is neither read for configuration nor written; the account's
 * credential is the only thing passed in.
 */
export function prepareRuntime(
  root: string,
  credential: TurnCredential,
  inherited: NodeJS.ProcessEnv = process.env,
): TurnRuntime {
  const base = join(root, 'runtime');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  chmodSync(base, 0o700);
  const home = mkdtempSync(join(base, `${credential.provider}-`));
  chmodSync(home, 0o700);
  const env: Record<string, string> = {
    ...QUIET_ENVIRONMENT,
    [profileVariable(credential.provider)]: home,
  };
  let original: string | null = null;
  if (credential.provider === 'claude-code') {
    env.CLAUDE_CODE_OAUTH_TOKEN = credential.oauthToken;
    // Supported switches (installed claude binary): no CLAUDE.md discovery,
    // auto-memory or git instructions from ancestors of the scratch dir.
    env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = '1';
  } else if (credential.provider === 'copilot') {
    if (credential.githubToken)
      env[COPILOT_TOKEN_VARIABLE] = credential.githubToken;
    // An empty GitHub CLI profile: Copilot's documented gh-auth fallback can
    // never substitute another (gh) identity for the selected account.
    const gh = join(home, 'gh');
    mkdirSync(gh, { mode: 0o700 });
    env.GH_CONFIG_DIR = gh;
    // Documented Copilot setting: no user- or repo-level hooks.
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ disableAllHooks: true }),
      { mode: 0o600 },
    );
  } else {
    const authJson = credential.refreshable
      ? credential.authJson
      : snapshotCodexAuth(credential.authJson);
    // Only refreshable (managed) credentials are ever written back.
    original = credential.refreshable ? authJson : null;
    writeFileSync(join(home, 'auth.json'), authJson, { mode: 0o600 });
  }
  const scrub = scrubbedVariables(credential.provider, inherited).filter(
    (key) => !(key in env),
  );
  return {
    home,
    env,
    scrub,
    refreshedCodexAuth() {
      if (original === null) return null;
      try {
        const now = readFileSync(join(home, 'auth.json'), 'utf8');
        return now !== original ? { original, refreshed: now } : null;
      } catch {
        return null;
      }
    },
    dispose() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Child environment for a direct spawn (no sandbox provider). */
export function childEnvironment(
  runtime: Pick<TurnRuntime, 'env' | 'scrub'>,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited };
  for (const key of runtime.scrub) delete env[key];
  return { ...env, ...runtime.env };
}

export function missingCredential(provider: HarnessProvider, reason: string) {
  const name =
    provider === 'claude-code'
      ? 'Claude Code'
      : provider === 'codex'
        ? 'Codex'
        : 'GitHub Copilot';
  return new HarnessTurnError(
    'auth',
    reason === 'stale'
      ? `${name}'s ordinary login needs a refresh. Run ${name} once on this machine (OpenDots never refreshes it for you), or choose another account, then continue.`
      : reason === 'expired'
        ? `${name}'s ordinary login has expired. Run ${name} once on this machine to renew it, or choose another account, then continue.`
        : provider === 'copilot'
          ? 'GitHub Copilot has no usable sign-in for the active account. The System default uses only your Copilot CLI login (run `copilot login` on this machine); OpenDots never substitutes a GitHub CLI login. Or add an OpenDots account in Settings › Local harnesses, then continue.'
          : `${name} has no usable sign-in for the active account. Sign in from Settings › Local harnesses (System default uses your ordinary ${name} login), then continue.`,
  );
}
