import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { HarnessProvider } from '../../shared/harness.js';

/**
 * Secrets OpenDots holds for managed accounts. On macOS they live in the login
 * Keychain under an OpenDots-only service name, so they never share an entry
 * with the ordinary CLI or Orca credentials. Elsewhere (and in tests) a 0600
 * file inside the 0700 profile root is used.
 */
export interface CredentialVault {
  get(accountId: string): Promise<string | null>;
  set(accountId: string, secret: string): Promise<void>;
  delete(accountId: string): Promise<void>;
}

export const KEYCHAIN_SERVICE = 'OpenDots harness credential';
const SAFE_ID = /^[a-f0-9-]{36}$/;
const SAFE_SECRET = /^[\w.~+/=:-]{8,4096}$/;

function run(
  command: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: options.timeoutMs ?? 15_000,
    });
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('error', () => resolve({ code: 127, stdout: '' }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
    child.stdin.end(options.input ?? '');
  });
}

export function keychainVault(): CredentialVault {
  return {
    async get(accountId) {
      if (!SAFE_ID.test(accountId)) return null;
      const result = await run('security', [
        'find-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        accountId,
        '-w',
      ]);
      return result.code === 0 ? result.stdout.trim() || null : null;
    },
    async set(accountId, secret) {
      if (!SAFE_ID.test(accountId) || !SAFE_SECRET.test(secret))
        throw new Error('Account credential has an unexpected format.');
      // `security -i` reads the command from stdin, so the secret never
      // appears in a process argument list.
      const result = await run('security', ['-i'], {
        input: `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a ${accountId} -w ${secret}\n`,
      });
      if (result.code !== 0)
        throw new Error('Could not save the account credential to Keychain.');
    },
    async delete(accountId) {
      if (!SAFE_ID.test(accountId)) return;
      const result = await run('security', [
        'delete-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        accountId,
      ]);
      // 44: errSecItemNotFound — nothing to delete. Any other failure means
      // the credential may still exist, so sign-out must not report success.
      if (result.code !== 0 && result.code !== 44)
        throw new Error(
          'Account credential could not be removed from Keychain.',
        );
    },
  };
}

export function fileVault(root: string): CredentialVault {
  const dir = join(root, 'credentials');
  const path = (id: string) => {
    if (!SAFE_ID.test(id)) throw new Error('Unknown account.');
    return join(dir, id);
  };
  return {
    async get(id) {
      try {
        return readFileSync(path(id), 'utf8').trim() || null;
      } catch {
        return null;
      }
    },
    async set(id, secret) {
      if (!SAFE_SECRET.test(secret))
        throw new Error('Account credential has an unexpected format.');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      writeFileSync(path(id), secret, { mode: 0o600 });
    },
    async delete(id) {
      rmSync(path(id), { force: true });
    },
  };
}

export function defaultVault(root: string): CredentialVault {
  return process.platform === 'darwin' &&
    process.env.OPENDOTS_CREDENTIAL_STORE !== 'file'
    ? keychainVault()
    : fileVault(root);
}

/** Read-only view of the ordinary (System default) CLI login. */
export type SystemCredential =
  | { ok: true; secret: string; identity: string | null }
  | { ok: false; reason: 'missing' | 'expired' | 'stale' };

/** Base64url JWT claims without verification (display identity only). */
function jwtEmail(token: unknown): string | null {
  if (typeof token !== 'string') return null;
  try {
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    return typeof claims.email === 'string' ? claims.email : null;
  } catch {
    return null;
  }
}

/**
 * A System default Codex snapshot gets no refresh token (see
 * `snapshotCodexAuth`), so it cannot rotate the ordinary login. Fail early
 * when the access token is likely too old to be accepted.
 */
export const CODEX_REFRESH_GUARD_MS = 7 * 24 * 3600_000;

export function parseCodexAuth(
  text: string,
  now = Date.now(),
  guard = true,
): SystemCredential {
  try {
    const auth = JSON.parse(text) as {
      tokens?: { access_token?: unknown; id_token?: unknown };
      last_refresh?: unknown;
      OPENAI_API_KEY?: unknown;
    };
    if (typeof auth.tokens?.access_token !== 'string')
      return { ok: false, reason: 'missing' };
    const refreshed =
      typeof auth.last_refresh === 'string'
        ? Date.parse(auth.last_refresh)
        : NaN;
    if (
      guard &&
      (!Number.isFinite(refreshed) || now - refreshed > CODEX_REFRESH_GUARD_MS)
    )
      return { ok: false, reason: 'stale' };
    return {
      ok: true,
      secret: text,
      identity: jwtEmail(auth.tokens.id_token),
    };
  } catch {
    return { ok: false, reason: 'missing' };
  }
}

export function parseClaudeKeychain(
  text: string,
  now = Date.now(),
): SystemCredential {
  try {
    const value = JSON.parse(text) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const token = value.claudeAiOauth?.accessToken;
    if (typeof token !== 'string') return { ok: false, reason: 'missing' };
    const expires = Number(value.claudeAiOauth?.expiresAt);
    if (Number.isFinite(expires) && expires - now < 5 * 60_000)
      return { ok: false, reason: 'expired' };
    return { ok: true, secret: token, identity: null };
  } catch {
    return { ok: false, reason: 'missing' };
  }
}

export interface SystemReaders {
  read(provider: HarnessProvider): Promise<SystemCredential>;
  /** Ordinary Copilot active-user projection, or null when none exists. */
  copilotState?(): CopilotNativeState | null;
}

/**
 * Reads the ordinary login of each CLI without writing or refreshing it.
 * The normal user profile is resolved from the real home directory, ignoring
 * any inherited Orca/agent profile override.
 */
export function systemReaders(
  env: NodeJS.ProcessEnv,
  home = homedir(),
): SystemReaders {
  return {
    copilotState() {
      // The ordinary profile, never an inherited COPILOT_HOME override.
      try {
        return parseCopilotState(
          readFileSync(join(home, '.copilot', 'config.json'), 'utf8'),
        );
      } catch {
        return null;
      }
    },
    async read(provider) {
      if (provider === 'codex') {
        const path = join(home, '.codex', 'auth.json');
        if (!existsSync(path)) return { ok: false, reason: 'missing' };
        return parseCodexAuth(readFileSync(path, 'utf8'));
      }
      if (provider === 'claude-code') {
        const result = await run(
          'security',
          ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
          { env },
        );
        return result.code === 0
          ? parseClaudeKeychain(result.stdout.trim())
          : { ok: false, reason: 'missing' };
      }
      // Copilot's ordinary login is resolved by Copilot itself (SDK
      // useLoggedInUser), never by reading another tool's token.
      return { ok: false, reason: 'missing' };
    },
  };
}

/**
 * Read-only System default Codex credential: the refresh token is removed so
 * Codex can never rotate (and thereby invalidate) the ordinary login. When the
 * access token expires the turn fails with renewal guidance instead.
 */
export function snapshotCodexAuth(authJson: string): string {
  const value = JSON.parse(authJson) as { tokens?: Record<string, unknown> };
  // Codex requires the field (`missing field refresh_token` otherwise), so an
  // inert empty value replaces it: any refresh attempt fails instead of
  // rotating the ordinary login.
  if (value.tokens) value.tokens.refresh_token = '';
  return JSON.stringify(value);
}

/**
 * Auth-only projection of the ordinary Copilot CLI state. Copilot resolves
 * its "user" login from `lastLoggedInUser`/`loggedInUsers` in
 * `$COPILOT_HOME/config.json` and reads the token from the native keyring by
 * (host, login). Only the active identity is copied; tokens, settings,
 * plugins, hooks and MCP configuration never are.
 */
export interface CopilotNativeState {
  lastLoggedInUser: { host: string; login: string };
  loggedInUsers: Array<{ host: string; login: string }>;
}

export function parseCopilotState(text: string): CopilotNativeState | null {
  try {
    const value = JSON.parse(
      text
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n'),
    ) as Record<string, unknown>;
    const user = value.lastLoggedInUser as
      { host?: unknown; login?: unknown } | undefined;
    if (typeof user?.host !== 'string' || typeof user.login !== 'string')
      return null;
    const active = { host: user.host, login: user.login };
    // The plaintext `copilotTokens` key format is built in native code and
    // is not source-proven, so it is never copied: only the keyring entry
    // for exactly this (host, login) can authenticate.
    return { lastLoggedInUser: active, loggedInUsers: [active] };
  } catch {
    return null;
  }
}
