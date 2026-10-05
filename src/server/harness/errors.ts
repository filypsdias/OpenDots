import {
  HARNESS_LABELS,
  type HarnessProvider,
  type TurnErrorKind,
} from '../../shared/harness.js';

// Only application-authored text reaches the chat. Raw CLI output can contain
// account emails, paths or tokens, so it is classified and then discarded.
export class HarnessTurnError extends Error {
  constructor(
    readonly kind: TurnErrorKind,
    message: string,
  ) {
    super(message);
  }
}

const PATTERNS: Array<[TurnErrorKind, RegExp]> = [
  [
    'missing_cli',
    /command not found|\bENOENT\b|exit(?:ed)? (?:with )?code 127|is not installed|must be updated/i,
  ],
  [
    'quota',
    /rate.?limit|usage.?limit|quota|\b429\b|too many requests|limit (?:reached|exceeded)|out of (?:credits|usage)|insufficient_quota|(?:weekly|daily|session|monthly) limit|premium requests|credits? (?:exhausted|remaining: 0)/i,
  ],
  [
    'model',
    /model\b.*\b(?:not (?:found|available|supported|allowed)|unavailable|does not exist|no access|not enabled)|(?:invalid|unknown|unsupported) model|from --model flag is not available|model_not_found/i,
  ],
  [
    'auth',
    /not logged in|log ?in (?:is )?required|unauthori[sz]ed|\b401\b|\b403\b|authenticat|expired (?:token|session|credentials)|invalid (?:api key|token|credentials)|run .{0,30}login|re-?auth|oauth/i,
  ],
];

export function classifyHarnessFailure(text: string): TurnErrorKind {
  for (const [kind, pattern] of PATTERNS) if (pattern.test(text)) return kind;
  return 'unknown';
}

export function safeTurnMessage(
  kind: TurnErrorKind,
  provider: HarnessProvider | null,
): string {
  const name = provider ? HARNESS_LABELS[provider] : 'The model provider';
  switch (kind) {
    case 'quota':
      return `${name} reported a usage or quota limit for the active account. Your conversation and partial work are saved. Choose an account and continue.`;
    case 'auth':
      return `${name} needs you to sign in again, or no account is selected. Open Settings › Local harnesses to sign in or choose an account, then continue.`;
    case 'model':
      return `${name} cannot use the selected model with the active account. Choose a model for this conversation, then continue.`;
    case 'missing_cli':
      return `${name} is not installed on this machine, or is too old. Install or update it, then retry.`;
    default:
      return `The subscription CLI could not complete this turn (${name}). Check its local login and permissions, then retry.`;
  }
}
