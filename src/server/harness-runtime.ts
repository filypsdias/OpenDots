import { existsSync } from 'node:fs';
import type { ModelProvider } from './models.js';
import { isHarnessProvider, type HarnessProvider } from '../shared/harness.js';

// Only bounded, application-authored setup messages can reach the chat UI.
export class HarnessSetupError extends Error {}

/**
 * Local harnesses run on this machine's loopback only: development anywhere,
 * or the built app on macOS. Containers and remote bindings are refused.
 */
export function assertHarnessRuntime({
  provider,
  host = '127.0.0.1',
  nodeEnv,
  container = false,
  platform = process.platform,
}: {
  provider: ModelProvider | HarnessProvider;
  host?: string;
  nodeEnv?: string;
  container?: boolean;
  platform?: NodeJS.Platform;
}): void {
  if (!isHarnessProvider(provider)) return;
  if (
    container ||
    !['127.0.0.1', '::1', 'localhost'].includes(host) ||
    (nodeEnv !== 'development' && platform !== 'darwin')
  ) {
    throw new HarnessSetupError(
      'Subscription harnesses require this machine on a loopback host (local development, or the built app on macOS). Select an HTTPS API provider for hosted, remote, or Docker deployments.',
    );
  }
}

export function harnessEnvironment() {
  return {
    host: process.env.HOST?.trim() || '127.0.0.1',
    nodeEnv: process.env.NODE_ENV,
    container:
      ['true', '1'].includes(process.env.OPENDOTS_CONTAINER ?? '') ||
      existsSync('/.dockerenv'),
  };
}
