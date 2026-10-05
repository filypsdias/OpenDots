import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { jiraConfigured, listMyJiraIssues } from '../src/server/jira.js';

const config: PlatformConfig = {
  baseUrl: 'https://api.openai.com/v1',
  voiceName: 'marin',
  slackUsers: [],
  runtimeUrl: 'http://127.0.0.1:4310/api/copilotkit',
  jiraCloudId: 'cloud-id',
  jiraEmail: 'filipe@example.com',
  jiraApiToken: 'secret-token',
  jiraSiteUrl: 'https://eci-solutions.atlassian.net',
  jiraDotId: 'work-dot',
};

afterEach(() => vi.unstubAllGlobals());

describe('Jira integration', () => {
  it('exposes Jira only to the configured Dot', () => {
    expect(jiraConfigured(config, 'work-dot')).toBe(true);
    expect(jiraConfigured(config, 'another-dot')).toBe(false);
    expect(
      jiraConfigured({ ...config, jiraDotId: undefined }, 'work-dot'),
    ).toBe(false);
  });

  it('runs a bounded read-only search for unresolved issues assigned to current user', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          isLast: true,
          issues: [
            {
              key: 'PAY02-56',
              fields: {
                summary: 'Review settlement flow',
                status: { name: 'In Progress' },
                priority: { name: 'High' },
                issuetype: { name: 'Task' },
                duedate: null,
                updated: '2026-10-05T12:00:00.000Z',
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await listMyJiraIssues(config, new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      'https://api.atlassian.com/ex/jira/cloud-id/rest/api/3/search/jql',
    );
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('filipe@example.com:secret-token').toString('base64')}`,
    });
    expect(JSON.parse(String(init.body))).toEqual({
      jql: 'assignee = currentUser() AND resolution = Unresolved ORDER BY priority DESC, updated DESC',
      maxResults: 50,
      fields: [
        'summary',
        'status',
        'priority',
        'issuetype',
        'duedate',
        'updated',
      ],
    });
    expect(result).toMatchObject({
      siteUrl: 'https://eci-solutions.atlassian.net',
      truncated: false,
      issues: [
        {
          key: 'PAY02-56',
          url: 'https://eci-solutions.atlassian.net/browse/PAY02-56',
          summary: 'Review settlement flow',
          status: 'In Progress',
          priority: 'High',
          issueType: 'Task',
        },
      ],
    });
  });

  it('does not reveal credentials when Jira rejects authentication', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 401 })),
    );
    await expect(
      listMyJiraIssues(config, new AbortController().signal),
    ).rejects.toThrow(/authentication or read permission failed/i);
  });

  it('rejects non-Atlassian site URLs before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      listMyJiraIssues(
        { ...config, jiraSiteUrl: 'https://example.com' },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/JIRA_SITE_URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
