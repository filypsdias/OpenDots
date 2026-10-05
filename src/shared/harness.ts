// Local subscription harness routing shared by server and owner UI. Values here
// are non-secret: never add credentials, tokens, or profile paths.
export const HARNESS_PROVIDERS = ['claude-code', 'codex', 'copilot'] as const;
export type HarnessProvider = (typeof HARNESS_PROVIDERS)[number];

export const HARNESS_LABELS: Record<HarnessProvider, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  copilot: 'GitHub Copilot CLI',
};

export function isHarnessProvider(value: unknown): value is HarnessProvider {
  return (
    typeof value === 'string' &&
    (HARNESS_PROVIDERS as readonly string[]).includes(value)
  );
}

/** System default uses the machine's ordinary CLI login without changing it. */
export const systemAccountId = (provider: HarnessProvider) =>
  `system:${provider}`;

export type AccountAuthStatus =
  'ready' | 'login_required' | 'login_pending' | 'unknown' | 'unsupported';

export interface HarnessAccount {
  id: string;
  provider: HarnessProvider;
  label: string;
  kind: 'system' | 'managed';
  status: AccountAuthStatus;
  /** Non-secret display identity, such as an email, for the local owner only. */
  identity: string | null;
  createdAt: number;
}

export interface HarnessProviderStatus {
  provider: HarnessProvider;
  label: string;
  installed: boolean;
  version: string | null;
  activeAccountId: string | null;
}

export interface HarnessModel {
  id: string;
  label: string;
  source: 'catalog' | 'discovered' | 'custom';
}

export type TurnErrorKind =
  'quota' | 'auth' | 'model' | 'missing_cli' | 'unknown';

export interface TurnToolRecord {
  id: string;
  name: string;
  status: 'started' | 'completed' | 'unknown';
}

export interface TurnReceipt {
  id: string;
  threadId: string;
  runId: string;
  harness: HarnessProvider | null;
  model: string;
  accountId: string | null;
  accountLabel: string | null;
  outcome: 'running' | 'completed' | 'failed' | 'cancelled';
  errorKind: TurnErrorKind | null;
  continuation: boolean;
  tools: TurnToolRecord[];
  startedAt: number;
  finishedAt: number | null;
}

export interface ConversationRoute {
  threadId: string;
  /** null keeps the project-configured provider (legacy and HTTP providers). */
  harness: HarnessProvider | null;
  model: string | null;
  /** Set after a model error; the owner must pick a model before continuing. */
  modelRequired: boolean;
  activeAccount: HarnessAccount | null;
  receipts: TurnReceipt[];
  recovery: {
    receiptId: string;
    kind: TurnErrorKind;
    unknownTools: string[];
    completedTools: string[];
    armed: boolean;
  } | null;
}
