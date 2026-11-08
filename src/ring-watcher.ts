import { EventEmitter } from 'node:events';

// Tuya's Pulsar WebSocket SDK (package name on npm: tuya-pulsar).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TuyaWebsocket = require('tuya-pulsar').default as TuyaWebsocketCtor;

type TuyaWebsocketCtor = {
  new (config: {
    accessId: string;
    accessKey: string;
    url: string;
    env: string;
    maxRetryTimes?: number;
    logger?: (level: string, ...args: unknown[]) => void;
  }): TuyaWebsocketClient;
  URL: { CN: string; US: string; EU: string; IN: string };
  env: { PROD: string; TEST: string };
};

interface TuyaWebsocketClient {
  start(): void;
  open(cb: () => void): void;
  message(cb: (ws: unknown, message: unknown) => void): void;
  error(cb: (ws: unknown, error: unknown) => void): void;
  close(cb: () => void): void;
  ackMessage(messageId: string): void;
  reconnect?(cb: () => void): void;
}

export interface RingWatcherOptions {
  accessId: string;
  accessSecret: string;
  deviceId: string;
  region?: string;
  /** prod (default) or test — must match Tuya Message Service channel. */
  messageEnv?: 'prod' | 'test';
  ringCodes?: string[];
  log?: (message: string) => void;
  debugLog?: (message: string) => void;
}

/**
 * Real-time visitor-ring listener via Tuya Message Service (Pulsar WebSocket).
 * Cloud property polling often misses doorbell_active because it is a transient push.
 */
export class RingWatcher extends EventEmitter {
  private client?: TuyaWebsocketClient;
  private started = false;
  private readonly deviceId: string;
  private readonly ringCodes: Set<string>;
  private readonly log: (message: string) => void;
  private readonly debugLog: (message: string) => void;

  constructor(private readonly options: RingWatcherOptions) {
    super();
    this.deviceId = options.deviceId.trim();
    this.ringCodes = new Set(
      (options.ringCodes || [
        'doorbell_active',
        'doorbell_pic',
        'doorbell',
        'doorbell_ring',
        'alarm_message',
      ]).map((code) => code.toLowerCase()),
    );
    this.log = options.log || (() => undefined);
    this.debugLog = options.debugLog || this.log;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const region = (this.options.region || 'eu').toLowerCase();
    const url = regionUrl(region);
    const env = this.options.messageEnv === 'test' ? TuyaWebsocket.env.TEST : TuyaWebsocket.env.PROD;

    this.log(
      `Ring push: connecting Message Service (${region}, ${this.options.messageEnv || 'prod'})…`,
    );

    this.client = new TuyaWebsocket({
      accessId: this.options.accessId,
      accessKey: this.options.accessSecret,
      url,
      env,
      maxRetryTimes: 100,
      logger: (level: string, ...args: unknown[]) => {
        if (String(level).toUpperCase() === 'ERROR') {
          this.debugLog(`pulsar ${level}: ${args.map(String).join(' ')}`);
        }
      },
    });

    this.client.open(() => {
      this.log('Ring push: Message Service connected');
    });
    this.client.reconnect?.(() => {
      this.debugLog('Ring push: reconnecting…');
    });
    this.client.error((_ws, error) => {
      this.log(
        `Ring push error: ${errorMessage(error)}. `
          + 'Enable Message Service in the Tuya IoT project (Cloud → Message Service), '
          + 'and keep only one consumer on this Access ID.',
      );
    });
    this.client.message((_ws, message) => {
      try {
        this.handleMessage(message);
      } catch (error) {
        this.debugLog(`Ring push parse: ${errorMessage(error)}`);
      }
    });
    this.client.start();
  }

  stop(): void {
    this.started = false;
    this.removeAllListeners();
    // SDK has no public stop; drop refs — process exit / GC closes the socket.
    this.client = undefined;
  }

  private handleMessage(raw: unknown): void {
    const envelope = raw as {
      messageId?: string;
      payload?: {
        data?: unknown;
        bizCode?: string;
        bizData?: unknown;
        protocol?: number;
        productKey?: string;
      };
    };
    if (envelope.messageId && this.client) {
      this.client.ackMessage(envelope.messageId);
    }

    const data = unwrapData(envelope.payload?.data ?? envelope.payload);
    if (!data) {
      return;
    }

    const devId = String(
      data.devId || data.deviceId || data.device_id || data.uuid || '',
    ).trim();
    if (devId && devId !== this.deviceId) {
      return;
    }

    const statuses = extractStatuses(data);
    for (const status of statuses) {
      const code = String(status.code || status.dpCode || '').toLowerCase();
      if (!code || !this.ringCodes.has(code)) {
        continue;
      }
      if (!isInterestingRingStatus(code, status.value)) {
        continue;
      }
      this.log(`Ring push: ${code}=${JSON.stringify(status.value)}`);
      this.emit('ring', { code, value: status.value, source: 'pulsar' });
      return;
    }

    // Protocol 43 style doorbell notify (IPC) — treat as ring when for our device.
    const protocol = Number(envelope.payload?.protocol ?? data.protocol);
    if (protocol === 43 || data.type === 'doorbell' || data.etype === 'doorbell') {
      this.log('Ring push: doorbell protocol notify');
      this.emit('ring', { code: 'protocol_43', value: data, source: 'pulsar' });
    }
  }
}

function regionUrl(region: string): string {
  switch (region) {
    case 'cn':
      return TuyaWebsocket.URL.CN;
    case 'us':
    case 'us_west':
      return TuyaWebsocket.URL.US;
    case 'in':
      return TuyaWebsocket.URL.IN;
    case 'eu':
    default:
      return TuyaWebsocket.URL.EU;
  }
}

function unwrapData(value: unknown): Record<string, unknown> | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return unwrapData(parsed);
    } catch {
      return undefined;
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (obj.bizData && typeof obj.bizData === 'object') {
      return obj.bizData as Record<string, unknown>;
    }
    if (obj.data && typeof obj.data === 'object') {
      return unwrapData(obj.data);
    }
    return obj;
  }
  return undefined;
}

function extractStatuses(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const candidates = [data.status, data.properties, data.dps, data.dpList];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((item) => item && typeof item === 'object') as Array<Record<string, unknown>>;
    }
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      // Map of code → value
      return Object.entries(candidate as Record<string, unknown>).map(([code, value]) => ({ code, value }));
    }
  }
  if (data.code != null) {
    return [{ code: data.code, value: data.value }];
  }
  return [];
}

function isInterestingRingStatus(code: string, value: unknown): boolean {
  if (code === 'doorbell_pic' || code === 'movement_detect_pic') {
    return value != null && String(value).trim() !== '' && String(value) !== 'null';
  }
  if (value == null) {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const raw = String(value).trim().toLowerCase();
  return raw !== '' && raw !== '0' && raw !== 'false' && raw !== 'null' && raw !== '{}' && raw !== '[]';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
