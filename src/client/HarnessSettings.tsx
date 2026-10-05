import { useEffect, useState } from 'react';
import { api } from './api';
import {
  HARNESS_LABELS,
  HARNESS_PROVIDERS,
  type HarnessAccount,
  type HarnessProvider,
  type HarnessProviderStatus,
} from '../shared/harness';

type Overview = {
  providers: HarnessProviderStatus[];
  accounts: HarnessAccount[];
};
type LoginPrompt = { url: string | null; code: string | null } | null;

const STATUS: Record<HarnessAccount['status'], string> = {
  ready: 'Signed in',
  login_required: 'Sign-in required',
  login_pending: 'Waiting for sign-in…',
  unknown: 'Status unknown until checked or used',
  unsupported: 'Not available on this machine',
};

/**
 * Local harness setup: install status, the System default, and OpenDots-owned
 * accounts. Credentials stay in each CLI's own profile; only non-secret status
 * and identity are shown here.
 */
export function HarnessSettings() {
  const [overview, setOverview] = useState<Overview>();
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [prompts, setPrompts] = useState<Record<string, LoginPrompt>>({});
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [working, setWorking] = useState('');
  const load = async () => {
    try {
      setOverview(await api<Overview>('/harness'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Harness status unavailable.');
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const pending = overview?.accounts.some(
    (item) => item.status === 'login_pending',
  );
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(async () => {
      await load();
      for (const account of overview?.accounts ?? [])
        if (account.status === 'login_pending') {
          const { prompt } = await api<{ prompt: LoginPrompt }>(
            `/harness/accounts/${account.id}/login`,
          ).catch(() => ({ prompt: null }));
          setPrompts((all) => ({ ...all, [account.id]: prompt }));
        }
    }, 2000);
    return () => clearInterval(timer);
  }, [pending]);
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setWorking(key);
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The account action failed.');
    } finally {
      setWorking('');
    }
  };
  if (!overview)
    return <p className="muted">{error || 'Checking local harnesses…'}</p>;
  return (
    <div className="harness-settings">
      <p className="muted">
        Dots can run through Claude Code, Codex or GitHub Copilot CLI on this
        machine, using your subscription. System default reuses your ordinary
        login read-only (Copilot: your own `copilot login`, never a GitHub CLI
        login); OpenDots accounts (Copilot ones need the GitHub CLI to sign in)
        keep their own credential. Each harness may use only OpenDots tools and
        permissions. One account per harness is active for all new turns,
        including scheduled work and Slack.
      </p>
      {HARNESS_PROVIDERS.map((provider: HarnessProvider) => {
        const status = overview.providers.find(
          (item) => item.provider === provider,
        );
        const accounts = overview.accounts.filter(
          (item) => item.provider === provider,
        );
        return (
          <fieldset
            className="space-access-fields harness-provider"
            key={provider}
          >
            <legend>{HARNESS_LABELS[provider]}</legend>
            <p className="muted">
              {status?.installed
                ? `Installed · ${status.version}`
                : 'Not installed on this machine.'}
              {!status?.activeAccountId && ' No account selected.'}
            </p>
            <ul className="account-list">
              {accounts.map((account) => {
                const active = status?.activeAccountId === account.id;
                const prompt = prompts[account.id];
                return (
                  <li className="account-row" key={account.id}>
                    <div>
                      <strong>
                        {account.label}
                        {active && <span className="route-chip">Active</span>}
                      </strong>
                      <small>
                        {STATUS[account.status]}
                        {account.identity ? ` · ${account.identity}` : ''}
                      </small>
                      {account.status === 'login_pending' && prompt && (
                        <small>
                          {prompt.url && (
                            <a
                              href={prompt.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open sign-in page ↗
                            </a>
                          )}
                          {prompt.code && (
                            <>
                              {' '}
                              Code: <code>{prompt.code}</code>
                            </>
                          )}
                        </small>
                      )}
                      {account.status === 'login_pending' && (
                        <form
                          className="account-add"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const code = codes[account.id]?.trim();
                            if (!code) return;
                            void act(account.id, async () => {
                              await api(
                                `/harness/accounts/${account.id}/login/code`,
                                'POST',
                                { code },
                              );
                              setCodes((all) => ({ ...all, [account.id]: '' }));
                            });
                          }}
                        >
                          <label
                            className="field-label"
                            htmlFor={`code-${account.id}`}
                          >
                            Paste a code if the sign-in page shows one
                          </label>
                          <input
                            id={`code-${account.id}`}
                            value={codes[account.id] ?? ''}
                            maxLength={512}
                            autoComplete="off"
                            onChange={(event) =>
                              setCodes((all) => ({
                                ...all,
                                [account.id]: event.target.value,
                              }))
                            }
                          />
                          <button disabled={!!working}>Submit code</button>
                          <button
                            type="button"
                            disabled={!!working}
                            onClick={() =>
                              void act(account.id, () =>
                                api(
                                  `/harness/accounts/${account.id}/login/cancel`,
                                  'POST',
                                  {},
                                ),
                              )
                            }
                          >
                            Cancel sign-in
                          </button>
                        </form>
                      )}
                    </div>
                    <div className="account-actions">
                      <button
                        type="button"
                        disabled={!!working}
                        onClick={() =>
                          void act(account.id, () =>
                            api(
                              `/harness/accounts/${account.id}/refresh`,
                              'POST',
                              {},
                            ),
                          )
                        }
                      >
                        Check
                      </button>
                      {!active && account.status !== 'unsupported' && (
                        <button
                          type="button"
                          disabled={!!working}
                          onClick={() =>
                            void act(account.id, () =>
                              api('/harness/active', 'POST', {
                                provider,
                                accountId: account.id,
                              }),
                            )
                          }
                        >
                          Make active
                        </button>
                      )}
                      {account.kind === 'managed' && (
                        <>
                          <button
                            type="button"
                            disabled={!!working}
                            onClick={() =>
                              void act(account.id, async () => {
                                const started = await api<{
                                  prompt: LoginPrompt;
                                }>(
                                  `/harness/accounts/${account.id}/login`,
                                  'POST',
                                  {},
                                );
                                setPrompts((all) => ({
                                  ...all,
                                  [account.id]: started.prompt,
                                }));
                              })
                            }
                          >
                            {account.status === 'ready'
                              ? 'Sign in again'
                              : 'Sign in'}
                          </button>
                          <button
                            type="button"
                            disabled={!!working}
                            onClick={() =>
                              void act(account.id, () =>
                                api(
                                  `/harness/accounts/${account.id}/logout`,
                                  'POST',
                                  {},
                                ),
                              )
                            }
                          >
                            Sign out
                          </button>
                          <button
                            type="button"
                            className="danger-button"
                            disabled={!!working}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Remove ${account.label}? Its local profile is deleted. Conversation history is kept${active ? ', and you will need to choose another active account' : ''}.`,
                                )
                              )
                                void act(account.id, () =>
                                  api(
                                    `/harness/accounts/${account.id}`,
                                    'DELETE',
                                  ),
                                );
                            }}
                          >
                            Remove
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <form
              className="account-add"
              onSubmit={(event) => {
                event.preventDefault();
                const label = labels[provider]?.trim();
                if (!label) return;
                void act(`add-${provider}`, async () => {
                  const account = await api<HarnessAccount>(
                    '/harness/accounts',
                    'POST',
                    { provider, label },
                  );
                  setLabels((all) => ({ ...all, [provider]: '' }));
                  // Adding an account starts its sign-in right away.
                  const started = await api<{ prompt: LoginPrompt }>(
                    `/harness/accounts/${account.id}/login`,
                    'POST',
                    {},
                  );
                  setPrompts((all) => ({
                    ...all,
                    [account.id]: started.prompt,
                  }));
                });
              }}
            >
              <label className="field-label" htmlFor={`add-${provider}`}>
                Add another account (opens its sign-in)
              </label>
              <input
                id={`add-${provider}`}
                value={labels[provider] ?? ''}
                maxLength={60}
                placeholder="Work, Personal…"
                onChange={(event) =>
                  setLabels((all) => ({
                    ...all,
                    [provider]: event.target.value,
                  }))
                }
              />
              <button
                className="primary"
                disabled={!!working || !labels[provider]?.trim()}
              >
                Add and sign in
              </button>
            </form>
          </fieldset>
        );
      })}
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
