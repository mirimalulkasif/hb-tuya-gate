import { createHash, createHmac, randomBytes } from 'node:crypto';

import { DEFAULT_REGION, REGION_HOSTS } from './settings';

export interface TuyaClientOptions {
  accessId: string;
  accessSecret: string;
  deviceId: string;
  region?: string;
  lockCode?: string;
  /** Try opening a live stream before lock (needed on some intercoms). */
  warmupStream?: boolean;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
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
 * Minimal Tuya OpenAPI client for Gate Camera lock open.
 * Video intercoms often reject /v1.0/.../commands (error 2008); use v2 shadow properties instead.
 */
export class TuyaClient {
  private readonly host: string;
  private readonly lockCode: string;
  private readonly warmupStream: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token?: TokenCache;

  constructor(private readonly options: TuyaClientOptions) {
    const region = (options.region || DEFAULT_REGION).toLowerCase();
    this.host = REGION_HOSTS[region] || REGION_HOSTS[DEFAULT_REGION];
    this.lockCode = options.lockCode || 'accessory_lock';
    this.warmupStream = options.warmupStream !== false;
    this.fetchImpl = options.fetchImpl || fetch;
    this.now = options.now || Date.now;
  }

  /** Pulses the gate/door open command (Lock Switch / accessory_lock = true). */
  async openGate(): Promise<void> {
    if (this.warmupStream) {
      await this.tryWarmupStream();
    }
    await this.issueProperty(this.lockCode, true);
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
