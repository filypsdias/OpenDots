/* global fetch, AbortSignal */
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { setInterval, setTimeout } from 'node:timers';
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

// Only synthetic test metadata is recorded. Never record environment values.
const config = JSON.parse(
  readFileSync(process.env.OPENDOTS_TEST_HARNESS_FIXTURE, 'utf8'),
);
const provider = process.argv[2];
const args = process.argv.slice(3);
const auth =
  provider === 'claude-code' ? args[0] === 'auth' : args[0] === 'login';
const profile = {
  'claude-code': 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  copilot: 'COPILOT_HOME',
}[provider];
const record = (extra = {}) =>
  appendFileSync(
    config.receipts,
    JSON.stringify({
      provider,
      phase: auth ? 'auth' : 'turn',
      args: args.map((arg) =>
        arg.replace(/Bearer [^"}]+/g, 'Bearer [test bridge token]'),
      ),
      cwd: process.cwd(),
      pid: process.pid,
      homePresent: process.env.HOME !== undefined,
      home: process.env.HOME === config.testHome ? config.testHome : undefined,
      present: config.scrubKeys.filter((key) => key in process.env),
      // Profile path is synthetic test data; recorded to prove account binding.
      profile: process.env[profile] ?? null,
      ...extra,
    }) + '\n',
  );
const heartbeat = () => {
  setTimeout(() => process.exit(2), 15_000).unref();
  setInterval(() => writeFileSync(config.heartbeat, String(Date.now())), 40);
};

if (auth) {
  record();
  if (config.auth === 'hang') {
    // A valid partial response must not be accepted after the owner cancels.
    if (provider === 'claude-code')
      console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
    else console.error('Logged in using ChatGPT');
    heartbeat();
    await new Promise(() => {});
  }
  if (config.auth === 'missing') {
    console.error(`${provider}: command not found`);
    process.exit(127);
  }
  if (provider === 'claude-code') {
    console.log(
      JSON.stringify({
        loggedIn: config.auth !== 'logged-out',
        authMethod: config.auth === 'api-key' ? 'api_key' : 'claude.ai',
        email: 'fixture@example.invalid',
      }),
    );
  } else {
    console.error(
      config.auth === 'api-key'
        ? 'Logged in using an API key'
        : config.auth === 'logged-out'
          ? 'Not logged in'
          : 'Logged in using ChatGPT',
    );
  }
  process.exit(config.auth === 'logged-out' ? 1 : 0);
}

/** MCP tools/call against the loopback bridge used by Claude and Copilot. */
async function bridgeCall(url, authorization, id, name, input) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
    throw new Error('The test must only contact its loopback tool bridge');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: authorization,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: input },
    }),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(data ? data.slice(6) : text);
}
const denied = {
  title: 'Forbidden page',
  content: 'Forbidden',
  spaceId: 'unowned-space',
};
const allowed = {
  title: 'Bridge-created page',
  content: '# From a real CLI subprocess',
};

// ---------- Codex app-server (JSON-RPC over stdio) ----------
if (provider === 'codex') {
  if (args[0] !== 'app-server') throw new Error('Codex must use app-server');
  record();
  const send = (message) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  let thread;
  let nextId = 1000;
  const waiting = new Map();
  const ask = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      send({ id, method, params });
    });
  const lines = createInterface({ input: process.stdin });
  const notify = (method, params) => send({ method, params });
  const complete = (status, error) =>
    notify('turn/completed', {
      threadId: thread,
      turn: { id: 'turn-1', status, items: [], error: error ?? null },
    });
  const handle = async (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && !message.method) {
      waiting.get(message.id)?.(message);
      return;
    }
    if (message.method === 'initialize')
      send({
        id: message.id,
        result: {
          userAgent: `opendots-fixture/${config.codexVersion ?? '0.160.0'}`,
        },
      });
    else if (message.method === 'thread/start') {
      thread = 'fixture-thread';
      record({
        phase: 'protocol',
        threadStart: {
          environments: message.params.environments,
          dynamicTools: message.params.dynamicTools.map((tool) => tool.name),
          config: message.params.config,
          approvalPolicy: message.params.approvalPolicy,
          allowProviderModelFallback: message.params.allowProviderModelFallback,
          model: message.params.model,
          ephemeral: message.params.ephemeral,
        },
      });
      send({ id: message.id, result: { thread: { id: thread } } });
    } else if (message.method === 'turn/start') {
      record({
        phase: 'protocol',
        turnStart: { environments: message.params.environments },
      });
      send({ id: message.id, result: { turn: { id: 'turn-1' } } });
      const turn = config.turn;
      if (turn === 'hang') heartbeat();
      else if (turn === 'tools') {
        const call = (callId, input) =>
          ask('item/tool/call', {
            threadId: thread,
            turnId: 'turn-1',
            callId,
            tool: 'create_space_page',
            arguments: input,
          });
        const deniedResult = await call('call-denied', denied);
        const allowedResult = await call('call-allowed', allowed);
        const shell = await ask('item/commandExecution/requestApproval', {
          threadId: thread,
          turnId: 'turn-1',
          itemId: 'native',
        });
        writeFileSync(
          config.bridgeReceipts,
          JSON.stringify({
            denied: deniedResult.result,
            allowed: allowedResult.result,
            nativeApproval: shell,
          }),
        );
        notify('item/completed', {
          threadId: thread,
          turnId: 'turn-1',
          item: { type: 'agentMessage', id: 'msg-1', text: 'Tools done.' },
        });
        complete('completed');
      } else if (turn === 'native') {
        notify('item/started', {
          threadId: thread,
          turnId: 'turn-1',
          item: { type: 'commandExecution', id: 'cmd', command: 'ls' },
        });
      } else if (turn === 'error' || turn === 'quota') {
        complete('failed', {
          message:
            turn === 'quota'
              ? 'You have hit your usage limit (synthetic-api-key).'
              : 'Synthetic CLI turn failed: synthetic-api-key',
          codexErrorInfo: turn === 'quota' ? 'usageLimitExceeded' : 'other',
        });
      } else if (turn === 'reroute') {
        notify('model/rerouted', {
          threadId: thread,
          turnId: 'turn-1',
          fromModel: 'a',
          toModel: 'b',
          reason: 'highRiskCyberActivity',
        });
      } else {
        notify('item/agentMessage/delta', {
          threadId: thread,
          turnId: 'turn-1',
          itemId: 'msg-1',
          delta: 'Local subscription turn completed.',
        });
        notify('item/completed', {
          threadId: thread,
          turnId: 'turn-1',
          item: {
            type: 'agentMessage',
            id: 'msg-1',
            text: 'Local subscription turn completed.',
          },
        });
        complete('completed');
      }
    } else if (message.method === 'turn/interrupt')
      send({ id: message.id, result: {} });
  };
  // Handle lines concurrently: a tool call awaits a response on a later line.
  lines.on('line', (line) => void handle(line));
  await new Promise((resolve) => lines.once('close', resolve));
  process.exit(0);
}

// ---------- Copilot CLI (-p with JSONL) ----------
if (provider === 'copilot') {
  record();
  const emit = (type, data) => console.log(JSON.stringify({ type, data }));
  const mcpArg = args[args.indexOf('--additional-mcp-config') + 1];
  if (config.turn === 'hang') {
    heartbeat();
    await new Promise(() => {});
  }
  if (config.turn === 'tools') {
    const mcp = JSON.parse(readFileSync(mcpArg.slice(1), 'utf8'));
    const bridge = Object.values(mcp.mcpServers)[0];
    const d = await bridgeCall(
      bridge.url,
      bridge.headers.Authorization,
      1,
      'create_space_page',
      denied,
    );
    const a = await bridgeCall(
      bridge.url,
      bridge.headers.Authorization,
      2,
      'create_space_page',
      allowed,
    );
    writeFileSync(
      config.bridgeReceipts,
      JSON.stringify({ denied: d, allowed: a }),
    );
    emit('tool.execution_start', {
      toolCallId: 't1',
      toolName: 'tanstack-create_space_page',
      arguments: allowed,
    });
    emit('tool.execution_complete', {
      toolCallId: 't1',
      success: true,
      result: { content: 'ok' },
    });
  }
  if (config.turn === 'error') {
    emit('session.error', {
      errorType: 'query',
      message: 'Synthetic CLI turn failed: synthetic-api-key',
    });
    process.exit(1);
  }
  if (config.turn === 'quota') {
    emit('session.error', {
      errorType: 'query',
      message: 'You have exceeded your premium requests quota (429).',
    });
    process.exit(1);
  }
  if (config.turn === 'reroute') {
    emit('session.error', {
      errorType: 'model',
      message:
        'Model "x" from --model flag is not available. Using "y" instead.',
    });
  }
  emit('assistant.message_delta', {
    messageId: 'm1',
    deltaContent: 'Local subscription ',
  });
  emit('assistant.message_delta', {
    messageId: 'm1',
    deltaContent: 'turn completed.',
  });
  emit('assistant.message', {
    messageId: 'm1',
    content: 'Local subscription turn completed.',
  });
  process.exit(0);
}

// ---------- Claude Code (stream-json) ----------
record();
const emit = (event) => console.log(JSON.stringify(event));
if (config.turn === 'tools') {
  const index = args.indexOf('--mcp-config');
  const mcp = JSON.parse(readFileSync(args[index + 1], 'utf8'));
  const bridge = Object.values(mcp.mcpServers)[0];
  const d = await bridgeCall(
    bridge.url,
    bridge.headers.Authorization,
    1,
    'create_space_page',
    denied,
  );
  const a = await bridgeCall(
    bridge.url,
    bridge.headers.Authorization,
    2,
    'create_space_page',
    allowed,
  );
  writeFileSync(
    config.bridgeReceipts,
    JSON.stringify({ denied: d, allowed: a }),
  );
}
emit({
  type: 'system',
  subtype: 'init',
  session_id: 'fake-claude-session',
  model: 'fixture-model',
  tools: [],
  cwd: process.cwd(),
});
if (config.turn === 'hang') {
  heartbeat();
} else {
  // Drain stdin so the real SDK's prompt writer can complete before CLI exit.
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once('end', resolve));
  if (config.turn === 'error' || config.turn === 'quota') {
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      errors: [
        config.turn === 'quota'
          ? 'Claude usage limit reached: synthetic-api-key'
          : 'Synthetic CLI turn failed: synthetic-api-key',
      ],
    });
  } else {
    emit({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'fake-assistant',
        content: [{ type: 'text', text: 'Local subscription turn completed.' }],
      },
    });
    emit({
      type: 'result',
      subtype: 'success',
      result: 'Local subscription turn completed.',
    });
  }
}
