import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { B1SessionResponseSchema } from '@ember/contracts';
import { V2LocalRuntimeHarness } from '../../../apps/benchmark/src/v2-m1/index.js';
import {
  DEVICE_TEXT_CAPABILITY,
  deviceIdSchema,
} from '../../../packages/runtime-v2/src/contracts/device-execution.js';

const DEVICE_PATH =
  /^\/v2\/devices\/([0-9a-f-]{36})\/(register|claim|tasks\/[0-9a-f-]{36}\/(?:renew|result))$/i;
const BODY_LIMIT = 32 * 1024;
type RelayMode = 'online' | 'offline' | 'drop-result-ack';
const modes: readonly RelayMode[] = ['online', 'offline', 'drop-result-ack'];

function parseControl(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON control command');
  }
  return value as Record<string, unknown>;
}

function writeEvent(event: string, details: Record<string, unknown> = {}): void {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n');
}

function isLocalAddress(host: string): boolean {
  const privateIPv4 = /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/;
  return (
    privateIPv4.test(host) &&
    Object.values(networkInterfaces()).some((interfaces) =>
      interfaces?.some(
        (iface) => iface.family === 'IPv4' && !iface.internal && iface.address === host,
      ),
    )
  );
}

async function bodyFrom(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const host = process.argv[2];
const stateDir = process.argv[3];
if (host === undefined || !isLocalAddress(host) || stateDir === undefined) {
  throw new Error('Usage: tsx iphone-native-qa.ts <Mac private IPv4> <private QA directory>');
}

const privateDir = stateDir;
await mkdir(privateDir, { recursive: true, mode: 0o700 });
const configPath = join(privateDir, 'local-device-qa.json');
const workerd = await V2LocalRuntimeHarness.start({
  target: {
    kind: 'ab_runtime',
    configPath: fileURLToPath(
      new URL('../../../apps/api/wrangler.local-v2.jsonc', import.meta.url),
    ),
  },
});

const localAccess = randomBytes(32).toString('hex');
let mode: RelayMode = 'online';
let deviceId: string | undefined;
let workDelayMs = 0;
let sessionToken: string;
let accountId: string;
const secretBytes = Buffer.from(localAccess);

function relayAuthorized(request: IncomingMessage): boolean {
  const access = request.headers['x-ember-local-access'];
  return (
    typeof access === 'string' &&
    /^[0-9a-f]{64}$/.test(access) &&
    timingSafeEqual(Buffer.from(access), secretBytes) &&
    request.headers.authorization === 'Bearer ' + sessionToken
  );
}

async function relay(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = request.url ?? '';
  const match = DEVICE_PATH.exec(path);
  const deviceToken = request.headers['x-device-token'];
  if (
    request.method !== 'POST' ||
    match === null ||
    typeof deviceToken !== 'string' ||
    !relayAuthorized(request) ||
    (deviceId !== undefined && deviceId !== match[1]?.toLowerCase())
  ) {
    response.writeHead(404).end();
    return;
  }
  if (mode === 'offline') {
    request.socket.destroy();
    return;
  }
  const body = await bodyFrom(request);
  const upstream = await workerd.fetchOverHttp(path, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + sessionToken,
      'content-type': 'application/json',
      'x-device-token': deviceToken,
    },
    body: Buffer.from(body),
  });
  const payload = await upstream.text();
  const event = match[2];
  if (event === 'register' && upstream.ok) {
    const id = match[1]?.toLowerCase();
    if (deviceId !== id) writeEvent('device_registered', { deviceId: id });
    deviceId = id;
  } else if (event === 'register' || event === 'claim' || event?.includes('/')) {
    let parsed: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(payload);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      // Non-JSON upstream error body; still log status below.
    }
    if (mode === 'drop-result-ack' && event.endsWith('/result') && upstream.ok) {
      mode = 'online';
      writeEvent('result_ack_dropped', { path, replayed: parsed['replayed'] });
      request.socket.destroy();
      return;
    }
    if (parsed['kind'] !== 'idle') {
      writeEvent('device_rpc', {
        path,
        status: upstream.status,
        kind: parsed['kind'],
        error: parsed['error'],
        taskId: parsed['taskId'],
        runId: parsed['runId'],
        leaseEpoch: parsed['leaseEpoch'],
        leaseExpiresAtMs: parsed['leaseExpiresAtMs'],
        replayed: parsed['replayed'],
      });
    }
  }
  response.writeHead(upstream.status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}

const server = createServer({ requestTimeout: 5_000 }, (request, response) => {
  void relay(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
});

async function saveConfig(origin: string): Promise<void> {
  await writeFile(
    configPath,
    JSON.stringify({
      EMBER_DEVICE_RELAY_URL: origin,
      EMBER_DEVICE_SESSION_TOKEN: sessionToken,
      EMBER_DEVICE_LOCAL_ACCESS: localAccess,
      EMBER_DEVICE_ACCOUNT_ID: accountId,
      EMBER_DEVICE_WORK_DELAY_MS: workDelayMs,
    }),
    { mode: 0o600 },
  );
  await chmod(configPath, 0o600);
}

async function cloudCommand(path: string, method: 'GET' | 'POST', body?: unknown): Promise<void> {
  const response = await workerd.fetchOverHttp(path, {
    method,
    headers: {
      authorization: 'Bearer ' + sessionToken,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  writeEvent('cloud_rpc', {
    path,
    status: response.status,
    body: await response.json(),
  });
}

try {
  const signIn = await workerd.fetchOverHttp('/v1/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'dev', identity_token: randomUUID(), nonce: randomUUID() }),
  });
  const session = B1SessionResponseSchema.parse(await signIn.json());
  sessionToken = session.access_token;
  accountId = randomUUID();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('relay did not bind');
  const origin = 'http://' + host + ':' + address.port;
  await saveConfig(origin);
  writeEvent('ready', { configPath, origin });

  const input = createInterface({ input: process.stdin, terminal: false });
  for await (const line of input) {
    try {
      const cmd = parseControl(line);
      switch (cmd['action']) {
        case 'exit':
          input.close();
          break;
        case 'delay':
          if (
            typeof cmd['workDelayMs'] !== 'number' ||
            !Number.isInteger(cmd['workDelayMs']) ||
            cmd['workDelayMs'] < 0 ||
            cmd['workDelayMs'] > 60_000
          ) {
            throw new Error('Invalid work delay');
          }
          workDelayMs = cmd['workDelayMs'];
          await saveConfig(origin);
          writeEvent('config_updated', { configPath, workDelayMs });
          break;
        case 'mode': {
          const next = modes.find((allowed) => allowed === cmd['mode']);
          if (next === undefined) throw new Error('Invalid relay mode');
          mode = next;
          writeEvent('relay_mode', { mode });
          break;
        }
        case 'dispatch':
          if (deviceId === undefined) throw new Error('device has not registered');
          await cloudCommand('/v2/device-tasks', 'POST', {
            deviceId,
            operationId: cmd['operationId'] ?? randomUUID(),
            capability: DEVICE_TEXT_CAPABILITY,
            version: 1,
            input: { operation: 'stats', text: cmd['text'] },
            ...(cmd['deadlineMs'] === undefined ? {} : { deadlineMs: cmd['deadlineMs'] }),
          });
          break;
        case 'status':
          await cloudCommand('/v2/device-tasks/' + deviceIdSchema.parse(cmd['taskId']), 'GET');
          break;
        case 'cancel':
          await cloudCommand(
            '/v2/device-tasks/' + deviceIdSchema.parse(cmd['taskId']) + '/cancel',
            'POST',
          );
          break;
        case 'revoke': {
          const targetDeviceId =
            cmd['deviceId'] === undefined ? deviceId : deviceIdSchema.parse(cmd['deviceId']);
          if (targetDeviceId === undefined) throw new Error('device has not registered');
          await cloudCommand('/v2/devices/' + targetDeviceId + '/revoke', 'POST');
          break;
        }
        case 'runs': {
          const [headId] = await workerd.listDurableObjectIds('AGENT_HEAD');
          if (headId === undefined) throw new Error('missing Agent Head');
          const rows = await workerd.readDurableObjectRows(
            'AGENT_HEAD',
            { id: headId },
            `SELECT id, status, lease_epoch, executor_kind, leased_until_ms FROM runs
               WHERE task_id = ? ORDER BY attempt`,
            deviceIdSchema.parse(cmd['taskId']),
          );
          writeEvent('runs', { taskId: deviceIdSchema.parse(cmd['taskId']), rows });
          break;
        }
        default:
          throw new Error('Unknown control command');
      }
    } catch {
      writeEvent('control_command_failed');
    }
  }
} finally {
  server.closeAllConnections();
  server.close();
  await workerd.dispose();
}
