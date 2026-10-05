import { useEffect, useId, useRef, useState } from 'react';
import { api } from './api';
import {
  HARNESS_LABELS,
  type ConversationRoute,
  type HarnessAccount,
  type HarnessModel,
  type HarnessProvider,
  type TurnErrorKind,
} from '../shared/harness';

type ModelList = { models: HarnessModel[]; discovered: boolean };

/** Catalog and discovered models plus an always-available custom ID. */
export function ModelPicker({
  provider,
  value,
  onChange,
  label = 'Model',
  required = false,
  accountKey = null,
}: {
  provider: HarnessProvider;
  /** Active account; the list is refetched when it changes. */
  accountKey?: string | null;
  value: string;
  onChange: (model: string) => void;
  label?: string;
  required?: boolean;
}) {
  const id = useId();
  const [models, setModels] = useState<HarnessModel[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    void api<ModelList>(`/harness/models/${provider}`)
      .then((list) => active && setModels(list.models))
      .catch(
        () => active && setError('Model list unavailable; enter a model ID.'),
      );
    return () => {
      active = false;
    };
  }, [provider, accountKey]);
  return (
    <>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        list={`${id}-models`}
        value={value}
        required={required}
        maxLength={200}
        pattern="[\w.:/@+\-]+"
        placeholder="Choose or type a model ID"
        aria-describedby={`${id}-help`}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={`${id}-models`}>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
            {model.source === 'discovered' ? ' (available)' : ''}
          </option>
        ))}
      </datalist>
      <small className="muted" id={`${id}-help`}>
        {error || 'Pick a listed model or enter any custom model ID.'}
      </small>
    </>
  );
}

/**
 * Request generations for one mounted view. `isCurrent` is true only for the
 * newest request, for the thread still shown, while mounted (StrictMode
 * re-runs mount effects, so mounting resets the flag).
 */
export function createLatest() {
  let generation = 0;
  let mounted = true;
  return {
    mount() {
      mounted = true;
    },
    unmount() {
      mounted = false;
    },
    begin(threadId: string) {
      generation += 1;
      return { generation, threadId };
    },
    isCurrent(token: { generation: number; threadId: string }, shown: string) {
      return (
        mounted && token.generation === generation && token.threadId === shown
      );
    },
  };
}

/**
 * Arms the explicit continuation. Only the failed receipt is sent: the server
 * uses the provider's current global account, so a switch made in Settings or
 * another tab is never undone by a stale selection cached in this view.
 */
export async function continueConversation(
  threadId: string,
  receiptId: string,
  call: typeof api = api,
) {
  return call<ConversationRoute>(
    `/conversations/${threadId}/continue`,
    'POST',
    {
      receiptId,
    },
  );
}

const RECOVERY: Record<TurnErrorKind, string> = {
  quota: 'The account hit a usage or quota limit.',
  auth: 'The account needs sign-in, or none is selected.',
  model: 'The selected model is not available to this account.',
  missing_cli: 'The harness CLI is not installed or is outdated.',
  unknown: 'The last turn did not finish.',
};

/**
 * Harness, model and active account for one conversation, plus explicit
 * recovery. Selecting an account changes the provider's global selection;
 * continuing re-runs the thread without adding another user message.
 */
export function RouteBar({
  threadId,
  busy,
  onContinue,
  onManage,
  refreshKey = 0,
}: {
  threadId: string;
  busy: boolean;
  onContinue: () => Promise<void>;
  onManage: () => void;
  /** Changes when account settings may have changed elsewhere. */
  refreshKey?: number;
}) {
  const [route, setRoute] = useState<ConversationRoute>();
  const [accounts, setAccounts] = useState<HarnessAccount[]>([]);
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  // Only the newest request for the current thread may update state, so a
  // slow older load can never overwrite a newer account or model.
  const latest = useRef(createLatest());
  const shown = useRef(threadId);
  useEffect(() => {
    latest.current.mount();
    return () => latest.current.unmount();
  }, []);
  useEffect(() => {
    // Never show one thread's controls with another thread's route.
    shown.current = threadId;
    setRoute(undefined);
    setModel('');
    setAccounts([]);
    setError('');
  }, [threadId]);
  const load = async () => {
    const token = latest.current.begin(threadId);
    try {
      const next = await api<ConversationRoute>(
        `/conversations/${threadId}/route`,
      );
      if (!latest.current.isCurrent(token, shown.current)) return;
      setRoute(next);
      setModel(next.model ?? '');
      setError('');
      if (next.harness) {
        const all = await api<{ accounts: HarnessAccount[] }>('/harness');
        if (!latest.current.isCurrent(token, shown.current)) return;
        setAccounts(
          all.accounts.filter((item) => item.provider === next.harness),
        );
      }
    } catch (e) {
      if (latest.current.isCurrent(token, shown.current))
        setError(e instanceof Error ? e.message : 'Route unavailable.');
    }
  };
  useEffect(() => {
    if (!busy) void load();
  }, [threadId, busy, refreshKey]);
  useEffect(() => {
    // The global account can change in another tab or window.
    const refresh = () => void load();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [threadId]);
  if (!route || route.threadId !== threadId)
    return error ? (
      <section className="route-bar" aria-label="Model route">
        <p className="chat-error" role="alert">
          {error}{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => void load()}
          >
            Retry
          </button>
        </p>
      </section>
    ) : null;
  const harness = route.harness;
  const current = route.activeAccount;
  const earlier = [
    ...new Set(
      route.receipts
        .filter(
          (receipt) =>
            receipt.accountLabel && receipt.accountId !== current?.id,
        )
        .map((receipt) => receipt.accountLabel),
    ),
  ];
  const act = async (fn: () => Promise<unknown>) => {
    // Mutations apply only to the conversation whose route is displayed.
    if (route.threadId !== shown.current) return;
    setWorking(true);
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the route.');
    } finally {
      setWorking(false);
    }
  };
  const recovery = route.recovery;
  return (
    <section className="route-bar" aria-label="Model route">
      <div className="route-chips">
        <span className="route-chip">
          {harness ? HARNESS_LABELS[harness] : 'Project model'}
        </span>
        {harness && (
          <form
            className="route-model"
            onSubmit={(event) => {
              event.preventDefault();
              void act(() =>
                api(`/conversations/${threadId}/model`, 'PUT', { model }),
              );
            }}
          >
            <ModelPicker
              provider={harness}
              value={model}
              required
              label="Model for this conversation"
              accountKey={route.activeAccount?.id ?? null}
              onChange={setModel}
            />
            <button
              className="primary"
              disabled={
                working ||
                busy ||
                !model.trim() ||
                (model === route.model && !route.modelRequired)
              }
            >
              Use model
            </button>
          </form>
        )}
        {harness && (
          <label className="route-account">
            <span className="field-label">
              Active {HARNESS_LABELS[harness]} account (all conversations)
            </span>
            <select
              value={current?.id ?? ''}
              disabled={working}
              onChange={(event) =>
                void act(() =>
                  api('/harness/active', 'POST', {
                    provider: harness,
                    accountId: event.target.value,
                  }),
                )
              }
            >
              <option value="" disabled>
                Choose an account
              </option>
              {accounts.map((account) => (
                <option
                  key={account.id}
                  value={account.id}
                  disabled={account.status === 'unsupported'}
                >
                  {account.label}
                  {account.identity ? ` · ${account.identity}` : ''}
                  {account.status === 'ready'
                    ? ''
                    : ` (${account.status.replace('_', ' ')})`}
                </option>
              ))}
            </select>
          </label>
        )}
        {harness && (
          <button type="button" className="link-button" onClick={onManage}>
            Manage accounts
          </button>
        )}
      </div>
      {earlier.length > 0 && (
        <p className="muted route-history">
          Earlier turns here were handled by: {earlier.join(', ')}.
        </p>
      )}
      {route.modelRequired && (
        <p className="chat-error" role="alert">
          Choose a model available to the active account before continuing.
        </p>
      )}
      {recovery && !busy && (
        <div className="recovery-banner" role="alert">
          <strong>{RECOVERY[recovery.kind]}</strong>
          <p>
            Your message and any partial reply are saved.
            {recovery.completedTools.length > 0 &&
              ` Completed tools will not be repeated: ${recovery.completedTools.join(', ')}.`}
            {recovery.unknownTools.length > 0 &&
              ` These tool calls were interrupted and may or may not have taken effect: ${recovery.unknownTools.join(', ')}.`}
          </p>
          <button
            className="primary"
            disabled={working || route.modelRequired || (!!harness && !current)}
            onClick={() =>
              void act(async () => {
                await continueConversation(threadId, recovery.receiptId);
                await onContinue();
              })
            }
          >
            Continue with the active account
          </button>
        </div>
      )}
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
