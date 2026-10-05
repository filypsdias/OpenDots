import { Hono } from 'hono';
import { z } from 'zod';
import type { Platform } from './platform.js';
import { assertHarnessRuntime, harnessEnvironment } from './harness-runtime.js';
import {
  HARNESS_PROVIDERS,
  type ConversationRoute,
} from '../shared/harness.js';

const provider = z.enum(HARNESS_PROVIDERS);
const modelId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\w.:/@+-]+$/, 'Use a model ID without spaces.');

/** Owner-only local routing API. Responses never include profile paths or credentials. */
export function harnessRoutes(platform: Platform) {
  const app = new Hono();
  const { workspace } = platform;
  const ledger = workspace.harness;

  // Account, login and model management drive local CLIs and credentials:
  // only on this machine's loopback host, outside containers, like turns.
  app.use('/harness/*', async (c, next) => {
    try {
      assertHarnessRuntime({ provider: 'codex', ...harnessEnvironment() });
    } catch {
      return c.json(
        {
          error:
            'Local harness management is available only for OpenDots running on this machine (loopback host, not in a container).',
        },
        403,
      );
    }
    await next();
  });
  app.use('/harness', async (c, next) => {
    try {
      assertHarnessRuntime({ provider: 'codex', ...harnessEnvironment() });
    } catch {
      return c.json(
        {
          error:
            'Local harness management is available only for OpenDots running on this machine (loopback host, not in a container).',
        },
        403,
      );
    }
    await next();
  });
  app.get('/harness', async (c) =>
    c.json({
      providers: await workspace.accounts.providers(),
      accounts: ledger.accounts(),
    }),
  );
  app.post('/harness/accounts', async (c) => {
    const data = z
      .object({ provider, label: z.string().trim().min(1).max(60) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Choose a harness and an account label.' }, 400);
    return c.json(
      workspace.accounts.add(data.data.provider, data.data.label),
      201,
    );
  });
  app.post('/harness/accounts/:id/refresh', async (c) =>
    c.json(await workspace.accounts.refresh(c.req.param('id'))),
  );
  app.post('/harness/accounts/:id/login', (c) =>
    c.json(workspace.accounts.login(c.req.param('id'))),
  );
  app.get('/harness/accounts/:id/login', (c) => {
    const account = ledger.account(c.req.param('id'));
    if (!account) return c.json({ error: 'Account not found.' }, 404);
    return c.json({
      account,
      prompt: workspace.accounts.loginPrompt(account.id),
    });
  });
  app.post('/harness/accounts/:id/login/code', async (c) => {
    const data = z
      .object({ code: z.string().trim().min(4).max(512) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ error: 'Enter the sign-in code.' }, 400);
    workspace.accounts.submitLoginCode(c.req.param('id'), data.data.code);
    return c.json({ ok: true });
  });
  app.post('/harness/accounts/:id/login/cancel', (c) => {
    workspace.accounts.cancelLogin(c.req.param('id'));
    return c.json(ledger.account(c.req.param('id')) ?? { ok: true });
  });
  app.post('/harness/accounts/:id/logout', async (c) =>
    c.json(await workspace.accounts.logout(c.req.param('id'))),
  );
  app.delete('/harness/accounts/:id', async (c) => {
    await workspace.accounts.remove(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/harness/active', async (c) => {
    const data = z
      .object({ provider, accountId: z.string().min(1).max(100) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ error: 'Choose an account.' }, 400);
    // Selection only: new turns use it; running turns keep their snapshot.
    return c.json(ledger.activate(data.data.provider, data.data.accountId));
  });
  app.get('/harness/models/:provider', async (c) => {
    const parsed = provider.safeParse(c.req.param('provider'));
    if (!parsed.success) return c.json({ error: 'Unknown harness.' }, 404);
    return c.json(
      await workspace.accounts.models(
        parsed.data,
        c.req.query('refresh') === '1',
      ),
    );
  });

  const route = (threadId: string): ConversationRoute => {
    const thread = workspace.requireThread(threadId);
    const receipts = ledger.receipts(threadId);
    const activeId = thread.harness
      ? ledger.activeAccountId(thread.harness)
      : null;
    const last = receipts[0];
    const armed = ledger.continuation(threadId);
    return {
      threadId,
      harness: thread.harness ?? null,
      model: thread.model ?? null,
      modelRequired: !!thread.modelRequired,
      activeAccount: activeId ? (ledger.account(activeId) ?? null) : null,
      receipts,
      recovery:
        last && last.outcome === 'failed' && last.errorKind
          ? {
              receiptId: last.id,
              kind: last.errorKind,
              completedTools: last.tools
                .filter((tool) => tool.status === 'completed')
                .map((tool) => tool.name),
              unknownTools: last.tools
                .filter((tool) => tool.status !== 'completed')
                .map((tool) => tool.name),
              armed: armed?.receiptId === last.id,
            }
          : null,
    };
  };
  app.get('/conversations/:id/route', (c) => c.json(route(c.req.param('id'))));
  app.put('/conversations/:id/model', async (c) => {
    const data = z
      .object({ model: modelId })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ error: 'Enter a valid model ID.' }, 400);
    workspace.setConversationModel(c.req.param('id'), data.data.model);
    return c.json(route(c.req.param('id')));
  });
  /**
   * Arms one explicit continuation of the last failed turn. The client then
   * re-runs the thread without adding a message, so the user prompt is never
   * duplicated; completed tool results are restated rather than replayed.
   */
  app.post('/conversations/:id/continue', async (c) => {
    // Receipt only: the turn uses the provider's global selection at launch,
    // so a stale client can never reverse an account switch made elsewhere.
    const data = z
      .object({ receiptId: z.string().min(1).max(100) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Choose a failed turn to continue.' }, 400);
    const threadId = c.req.param('id');
    const current = route(threadId);
    if (!current.recovery || current.recovery.receiptId !== data.data.receiptId)
      return c.json(
        { error: 'Conversation has no failed turn to continue.' },
        409,
      );
    if (
      ledger.isLive(threadId) ||
      current.receipts.some((receipt) => receipt.outcome === 'running')
    )
      return c.json({ error: 'Conversation is already running.' }, 409);
    if (current.modelRequired)
      return c.json(
        { error: 'Choose a model for this conversation first.' },
        409,
      );
    if (!ledger.receipt(data.data.receiptId)?.promptId)
      return c.json(
        { error: 'This failed turn has no unanswered message to continue.' },
        409,
      );
    ledger.armContinuation(threadId, data.data.receiptId);
    return c.json(route(threadId));
  });
  return app;
}
