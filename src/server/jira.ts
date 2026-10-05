import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { PlatformConfig } from './platform-config.js';

const issueSearch = z.object({
  issues: z.array(
    z.object({
      key: z.string(),
      fields: z.object({
        summary: z.string().nullable().optional(),
        status: z.object({ name: z.string() }).nullable().optional(),
        priority: z.object({ name: z.string() }).nullable().optional(),
        issuetype: z.object({ name: z.string() }).nullable().optional(),
        duedate: z.string().nullable().optional(),
        updated: z.string().nullable().optional(),
      }),
    }),
  ),
  nextPageToken: z.string().optional(),
  isLast: z.boolean().optional(),
});

export function jiraConfigured(config: PlatformConfig, dotId: string) {
  return !!(
    config.jiraCloudId &&
    config.jiraEmail &&
    config.jiraApiToken &&
    config.jiraSiteUrl &&
    config.jiraDotId === dotId
  );
}

export async function listMyJiraIssues(
  config: PlatformConfig,
  signal: AbortSignal,
) {
  if (
    !config.jiraCloudId ||
    !config.jiraEmail ||
    !config.jiraApiToken ||
    !config.jiraSiteUrl
  )
    throw new Error('Jira is not configured on the OpenDots server.');

  const base = new URL(config.jiraSiteUrl);
  if (
    base.protocol !== 'https:' ||
    !base.hostname.endsWith('.atlassian.net') ||
    base.pathname !== '/' ||
    base.search ||
    base.hash
  )
    throw new Error('JIRA_SITE_URL must be an Atlassian Cloud site origin.');

  const url = new URL(
    `/ex/jira/${encodeURIComponent(config.jiraCloudId)}/rest/api/3/search/jql`,
    'https://api.atlassian.com',
  );
  const auth = Buffer.from(
    `${config.jiraEmail}:${config.jiraApiToken}`,
    'utf8',
  ).toString('base64');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
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
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new Error(
        'Jira authentication or read permission failed. Check the scoped API token, account email, cloud ID, and Jira project access.',
      );
    throw new Error(`Jira issue search failed with HTTP ${response.status}.`);
  }

  const result = issueSearch.parse(await response.json());
  return {
    siteUrl: base.origin,
    issues: result.issues.map(({ key, fields }) => ({
      key,
      url: `${base.origin}/browse/${encodeURIComponent(key)}`,
      summary: fields.summary ?? '(No summary)',
      status: fields.status?.name ?? 'Unknown',
      priority: fields.priority?.name ?? 'Unspecified',
      issueType: fields.issuetype?.name ?? 'Issue',
      dueDate: fields.duedate,
      updated: fields.updated,
    })),
    truncated: result.isLast === false || !!result.nextPageToken,
  };
}
