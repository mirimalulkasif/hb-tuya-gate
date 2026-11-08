import { createHash, createHmac, randomBytes } from 'node:crypto';

import {
  DEFAULT_LOCK_CODE,
  DEFAULT_MODE_CODE,
  DEFAULT_MODE_DORMANT,
  DEFAULT_MODE_HOME,
  DEFAULT_MODE_OUT,
  DEFAULT_REGION,
  REGION_HOSTS,
} from './settings';

export type GateMode = 'home' | 'out' | 'dormant';

export interface TuyaClientOptions {
  accessId: string;
  accessSecret: string;
  deviceId: string;
  region?: string;
  lockCode?: string;
  modeCode?: string;
  modeHomeValue?: string;
  modeOutValue?: string;
  modeDormantValue?: string;
  /** Try opening a live stream before lock (needed on some intercoms). */
  warmupStream?: boolean;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface TuyaProperty {
  code: string;
  dp_id?: number;
  value: unknown;
  type?: string;
}

export class TuyaApiError extends Error {
  constructor(
    message: string,
    readonly code?: number | string,
  ) {
    super(message);
    this.name = 'TuyaApiError';
  }
}

interface TokenCache {
  accessToken: string;
  expireAt: number;
}

/**
 * Minimal Tuya OpenAPI client for Gate Camera lock open + indoor ring mode.
 * Video intercoms often reject /v1.0/.../commands (error 2008); use v2 shadow properties instead.
 */
export class TuyaClient {
  private readonly host: string;
  private readonly lockCode: string;
  private modeCode: string;
  private readonly modeValues: Record<GateMode, string>;
  private readonly warmupStream: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token?: TokenCache;

  constructor(private readonly options: TuyaClientOptions) {
    const region = (options.region || DEFAULT_REGION).toLowerCase();
    this.host = REGION_HOSTS[region] || REGION_HOSTS[DEFAULT_REGION];
    this.lockCode = options.lockCode || DEFAULT_LOCK_CODE;
    this.modeCode = options.modeCode || DEFAULT_MODE_CODE;
    this.modeValues = {
      home: options.modeHomeValue || DEFAULT_MODE_HOME,
      out: options.modeOutValue || DEFAULT_MODE_OUT,
      dormant: options.modeDormantValue || DEFAULT_MODE_DORMANT,
    };
    this.warmupStream = options.warmupStream !== false;
    this.fetchImpl = options.fetchImpl || fetch;
    this.now = options.now || Date.now;
  }

  getModeCode(): string {
    return this.modeCode;
  }

  /** Pulses the gate/door open command (Lock Switch / accessory_lock = true). */
  async openGate(): Promise<void> {
    if (this.warmupStream) {
      await this.tryWarmupStream();
    }
    await this.issueProperty(this.lockCode, true);
  }

  async getProperties(codes?: string[]): Promise<TuyaProperty[]> {
    let path = `/v2.0/cloud/thing/${this.options.deviceId}/shadow/properties`;
    if (codes && codes.length > 0) {
      path += `?codes=${encodeURIComponent(codes.join(','))}`;
    }
    const response = await this.request('GET', path);
    if (!response.success) {
      throw new TuyaApiError(response.msg || 'Tuya properties query failed', response.code);
    }
    const result = response.result as { properties?: TuyaProperty[] } | undefined;
    return Array.isArray(result?.properties) ? result!.properties! : [];
  }

  async getMode(): Promise<GateMode | undefined> {
    await this.ensureModeCode();
    const properties = await this.getProperties([this.modeCode]);
    const hit = properties.find((item) => item.code === this.modeCode);
    if (!hit) {
      return undefined;
    }
    return this.parseModeValue(hit.value);
  }

  async setMode(mode: GateMode): Promise<void> {
    await this.ensureModeCode();
    await this.issueProperty(this.modeCode, this.modeValues[mode]);
  }

  /**
   * If modeCode is still the default, try to find a property whose current
   * value looks like home/out/dormant (or common aliases).
   */
  async ensureModeCode(): Promise<string> {
    if (this.options.modeCode) {
      this.modeCode = this.options.modeCode;
      return this.modeCode;
    }
    if (this.modeCode !== DEFAULT_MODE_CODE) {
      return this.modeCode;
    }
    try {
      const properties = await this.getProperties();
      const discovered = discoverModeProperty(properties, this.modeValues);
      if (discovered) {
        this.modeCode = discovered;
      }
    } catch {
      // Keep configured/default code; setMode may still fail with a clear error.
    }
    return this.modeCode;
  }

  parseModeValue(value: unknown): GateMode | undefined {
    const raw = String(value ?? '').trim().toLowerCase();
    for (const mode of ['home', 'out', 'dormant'] as GateMode[]) {
      if (raw === this.modeValues[mode].toLowerCase()) {
        return mode;
      }
    }
    // Common aliases across Tuya indoor monitors.
    if (['home', 'at_home', 'athome', '0'].includes(raw)) {
      return 'home';
    }
    if (['out', 'away', 'leave_home', 'not_at_home', 'nothome', '1'].includes(raw)) {
      return 'out';
    }
    if (['dormant', 'sleep', 'rest', 'dnd', '2'].includes(raw)) {
      return 'dormant';
    }
    return undefined;
  }

  /** Preferred path for IPC / Gate Camera lock DPs. */
  async issueProperty(code: string, value: boolean | string | number): Promise<void> {
    const path = `/v2.0/cloud/thing/${this.options.deviceId}/shadow/properties/issue`;
    const body = JSON.stringify({
      properties: JSON.stringify({ [code]: value }),
    });
    const response = await this.request('POST', path, body);
    if (!response.success) {
      throw new TuyaApiError(response.msg || 'Tuya property issue failed', response.code);
    }
  }

  /** Legacy commands API — kept for debugging / non-camera devices. */
  async sendCommand(code: string, value: boolean | string | number): Promise<void> {
    const path = `/v1.0/devices/${this.options.deviceId}/commands`;
    const body = JSON.stringify({ commands: [{ code, value }] });
    const response = await this.request('POST', path, body);
    if (!response.success) {
      throw new TuyaApiError(response.msg || 'Tuya command failed', response.code);
    }
  }

  private async tryWarmupStream(): Promise<void> {
    const path = `/v1.0/devices/${this.options.deviceId}/stream/actions/allocate`;
    const body = JSON.stringify({ type: 'rtsp' });
    try {
      await this.request('POST', path, body);
    } catch {
      // Stream APIs vary by product; lock may still work without warmup.
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: string,
    withToken = true,
  ): Promise<{ success?: boolean; result?: unknown; msg?: string; code?: number | string }> {
    const accessToken = withToken ? await this.getAccessToken() : '';
    const t = String(this.now());
    const nonce = randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
      'client_id': this.options.accessId,
      'sign_method': 'HMAC-SHA256',
      't': t,
      'nonce': nonce,
      'Content-Type': 'application/json',
    };
    if (accessToken) {
      headers.access_token = accessToken;
    }
    headers.sign = this.sign(method, path, body || '', headers, accessToken);

    const response = await this.fetchImpl(`${this.host}${path}`, {
      method,
      headers,
      body: method === 'POST' ? body : undefined,
    });
    const json = await response.json() as {
      success?: boolean;
      result?: unknown;
      msg?: string;
      code?: number | string;
    };
    if (!response.ok && json.msg) {
      throw new TuyaApiError(json.msg, json.code);
    }
    return json;
  }

  private async getAccessToken(): Promise<string> {
    if (this.token && this.token.expireAt > this.now() + 30_000) {
      return this.token.accessToken;
    }
    const path = '/v1.0/token?grant_type=1';
    const json = await this.request('GET', path, undefined, false);
    if (!json.success || !json.result || typeof json.result !== 'object') {
      throw new TuyaApiError(json.msg || 'Tuya token request failed', json.code);
    }
    const result = json.result as { access_token?: string; expire_time?: number };
    if (!result.access_token) {
      throw new TuyaApiError('Tuya token response missing access_token');
    }
    const ttlSec = Number(result.expire_time) || 7200;
    this.token = {
      accessToken: result.access_token,
      expireAt: this.now() + ttlSec * 1000,
    };
    return this.token.accessToken;
  }

  private sign(
    method: string,
    path: string,
    body: string,
    headers: Record<string, string>,
    accessToken: string,
  ): string {
    const contentHash = createHash('sha256').update(body || '').digest('hex');
    const optionalHeaders = '';
    const stringToSign = [method, contentHash, optionalHeaders, path].join('\n');
    const signStr = this.options.accessId + accessToken + headers.t + headers.nonce + stringToSign;
    return createHmac('sha256', this.options.accessSecret)
      .update(signStr, 'utf8')
      .digest('hex')
      .toUpperCase();
  }
}

export function discoverModeProperty(
  properties: TuyaProperty[],
  modeValues: Record<GateMode, string>,
): string | undefined {
  const aliases = new Set(
    [
      modeValues.home,
      modeValues.out,
      modeValues.dormant,
      'home',
      'out',
      'dormant',
      'at_home',
      'leave_home',
      'not_at_home',
      'away',
      'sleep',
      'rest',
    ].map((value) => value.toLowerCase()),
  );
  for (const property of properties) {
    const value = String(property.value ?? '').trim().toLowerCase();
    if (aliases.has(value)) {
      return property.code;
    }
  }
  // Prefer an explicit-looking code even if value is unknown yet.
  const preferred = properties.find((property) =>
    /mode|dormant|leave_home|indoor/i.test(property.code),
  );
  return preferred?.code;
}
