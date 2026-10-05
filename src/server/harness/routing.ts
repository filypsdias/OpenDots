import type { HttpModel } from '../models.js';
import type { PlatformConfig } from '../platform-config.js';
import type { WorkspaceStore } from '../workspace.js';
import { resolveActiveModel } from '../model-adapters.js';
import { HARNESS_LABELS, type HarnessProvider } from '../../shared/harness.js';
import type { AccountSnapshot } from './store.js';
import { HarnessTurnError } from './errors.js';
import { systemDefaultSupported } from './accounts.js';

export type TurnRoute =
  | { kind: 'http'; harness: null; model: string; resolved: HttpModel }
  | {
      kind: 'harness';
      harness: HarnessProvider;
      model: string;
      /** Snapshot taken at launch; later selection changes never affect it. */
      account: AccountSnapshot;
    };

/**
 * The single route resolver for every entry point (chat, page chat, Slack,
 * scheduled tasks, voice compute). Never falls back to another account,
 * model, provider, or the machine's ambient credentials.
 */
export function resolveTurnRoute(
  workspace: WorkspaceStore,
  config: PlatformConfig,
  threadId: string,
): TurnRoute {
  const conversation = workspace.requireThread(threadId);
  let harness = conversation.harness ?? null;
  let model = conversation.model ?? null;
  if (!harness) {
    // Legacy and HTTP conversations keep the project-configured provider.
    const resolved = resolveActiveModel(config);
    if (!resolved.harness)
      return { kind: 'http', harness: null, model: resolved.model, resolved };
    harness = resolved.provider;
    model = resolved.model;
  }
  if (conversation.modelRequired || !model)
    throw new HarnessTurnError(
      'model',
      `Choose a ${HARNESS_LABELS[harness]} model for this conversation.`,
    );
  const accountId = workspace.harness.activeAccountId(harness);
  const account = accountId ? workspace.harness.snapshot(accountId) : undefined;
  if (!account)
    throw new HarnessTurnError(
      'auth',
      `No ${HARNESS_LABELS[harness]} account is selected. Choose one in Settings › Local harnesses.`,
    );
  if (!systemDefaultSupported(account))
    throw new HarnessTurnError(
      'auth',
      `${HARNESS_LABELS[harness]} runs only with an OpenDots-managed account, because its system profile can load hooks, plugins and MCP servers OpenDots cannot disable. Add an account in Settings › Local harnesses.`,
    );
  return { kind: 'harness', harness, model, account };
}
