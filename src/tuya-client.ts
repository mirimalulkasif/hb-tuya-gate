import { createHash, createHmac, randomBytes } from 'node:crypto';

import {
  DEFAULT_LOCK_CODE,
  DEFAULT_MODE_CODE,
  DEFAULT_MODE_DORMANT,
  DEFAULT_MODE_HOME,
  DEFAULT_MODE_OUT,
  DEFAULT_REGION,
  DEFAULT_RING_CODE,
  DEFAULT_RING_CODE_FALLBACKS,
  REGION_HOSTS,
} from './settings';

export type GateMode = 'home' | 'out' | 'dormant';

export interface TuyaClientOptions {
  accessId: string;
  accessSecret: string;
  deviceId: string;
  /** If modes live on the indoor monitor, set its device id here. */
  modeDeviceId?: string;
  region?: string;
  lockCode?: string;
  modeCode?: string;
  modeHomeValue?: string;
  modeOutValue?: string;
  modeDormantValue?: string;
  /** Primary DP for visitor ring (default doorbell_active). */
  ringCode?: string;
  /** Extra ring DP codes to poll. */
  ringCodes?: string[];
  /** Try opening a live stream before lock (needed on some intercoms). */
  warmupStream?: boolean;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface RingSample {
  ringing: boolean;
  code?: string;
  value?: unknown;
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

const MODE_VALUE_CANDIDATES: Record<GateMode, Array<string | number>> = {
  home: ['0', 0, 'at_home', 'home', 'At Home', 'at home'],
  out: ['1', 1, 'not_at_home', 'out', 'Not at Home', 'not at home', 'leave_home', 'away'],
  dormant: ['2', 2, 'dormant', 'Dormant', 'sleep', 'rest', 'hibernate'],
};

const MODE_CODE_CANDIDATES = [
  'call_mode',
  'doorbell_mode',
  'work_mode',
  'indoor_mode',
  'device_mode',
  'ipc_mode',
  'scene_mode',
  'master_mode',
  'mode',
];

/** Never treat these as the At Home / Not at Home / Dormant DP. */
const MODE_CODE_BLOCKLIST = [
  'motion_sensitivity',
  'basic_nightvision',
  'nightvision',
  'sd_status',
  'sd_format',
  'sd_storge',
  'sd_format_state',
  'motion_switch',
  'basic_flip',
  'basic_osd',
  'record_mode',
  'record_switch',
  'basic_indicator',
];

/**
 * Minimal Tuya OpenAPI client for Gate Camera lock open + indoor ring mode.
 * Video intercoms often reject /v1.0/.../commands (error 2008); use v2 shadow properties instead.
 */
export class TuyaClient {
  private readonly host: string;
  private readonly lockCode: string;
  private modeCode: string;
  private readonly configuredModeValues: Record<GateMode, string>;
  private learnedModeValues: Partial<Record<GateMode, string | number>> = {};
  private readonly warmupStream: boolean;
  private readonly ringCodes: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token?: TokenCache;

  constructor(private readonly options: TuyaClientOptions) {
    const region = (options.region || DEFAULT_REGION).toLowerCase();
    this.host = REGION_HOSTS[region] || REGION_HOSTS[DEFAULT_REGION];
    this.lockCode = options.lockCode || DEFAULT_LOCK_CODE;
    this.modeCode = (options.modeCode || DEFAULT_MODE_CODE).trim();
    this.configuredModeValues = {
      home: options.modeHomeValue || DEFAULT_MODE_HOME,
      out: options.modeOutValue || DEFAULT_MODE_OUT,
      dormant: options.modeDormantValue || DEFAULT_MODE_DORMANT,
    };
    this.warmupStream = options.warmupStream !== false;
    this.ringCodes = uniqueCodes([
      options.ringCode || DEFAULT_RING_CODE,
      ...(options.ringCodes || []),
      ...DEFAULT_RING_CODE_FALLBACKS,
    ]);
    this.fetchImpl = options.fetchImpl || fetch;
    this.now = options.now || Date.now;
  }

  getRingCodes(): string[] {
    return [...this.ringCodes];
  }

  /**
   * Detect a visitor ringing the outdoor station.
   * Tuya `doorbell_active` is usually "" when idle and a non-empty payload when ringing.
   */
  async getRingSample(): Promise<RingSample> {
    const properties = await this.getProperties(this.options.deviceId, this.ringCodes);
    for (const code of this.ringCodes) {
      const hit = properties.find((item) => item.code === code);
      if (!hit) {
        continue;
      }
      // doorbell_pic / alarm_message are often the lasting evidence of a ring.
      if (code === 'doorbell_pic' || code === 'alarm_message' || code === 'movement_detect_pic') {
        if (hit.value != null && String(hit.value).trim() !== '' && String(hit.value) !== 'null') {
          return { ringing: true, code, value: hit.value };
        }
        continue;
      }
      if (isRingActiveValue(hit.value)) {
        return { ringing: true, code, value: hit.value };
      }
    }
    return { ringing: false };
  }

  getModeCode(): string {
    return this.modeCode;
  }

  getModeDeviceId(): string {
    return (this.options.modeDeviceId || this.options.deviceId).trim();
  }

  /** Pulses the gate/door open command (Lock Switch / accessory_lock = true). */
  async openGate(): Promise<void> {
    if (this.warmupStream) {
      await this.tryWarmupStream();
    }
    await this.issueProperty(this.options.deviceId, this.lockCode, true);
  }

  async getProperties(deviceId?: string, codes?: string[]): Promise<TuyaProperty[]> {
    const id = deviceId || this.options.deviceId;
    let path = `/v2.0/cloud/thing/${id}/shadow/properties`;
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

  /** Log-friendly list of properties that might be the ring mode. */
  async describeModeCandidates(): Promise<string[]> {
    const properties = await this.getProperties(this.getModeDeviceId());
    return properties
      .filter((property) => {
        const code = property.code.toLowerCase();
        const value = String(property.value ?? '').toLowerCase();
        return (
          MODE_CODE_CANDIDATES.some((candidate) => code.includes(candidate.replace('_', ''))) ||
          /mode|home|dormant|away|leave|scene|sleep/i.test(property.code) ||
          this.parseModeValue(property.value) != null ||
          /home|dormant|away|sleep|out/.test(value)
        );
      })
      .map((property) => `${property.code}=${JSON.stringify(property.value)} (dp ${property.dp_id ?? '?'})`);
  }

  async getMode(): Promise<GateMode | undefined> {
    await this.ensureModeCode();
    const properties = await this.getProperties(this.getModeDeviceId(), [this.modeCode]);
    const hit = properties.find((item) => item.code === this.modeCode);
    if (!hit) {
      return undefined;
    }
    return this.parseModeValue(hit.value);
  }

  async setMode(mode: GateMode): Promise<void> {
    await this.ensureModeCode();
    if (!this.modeCode || MODE_CODE_BLOCKLIST.includes(this.modeCode.toLowerCase())) {
      throw new TuyaApiError(
        'Intercom ring mode is not available on this Tuya device via cloud. '
          + 'Set modeCode only if Query properties changes when you switch At Home / Not at Home / Dormant in the Tuya app.',
      );
    }
    const deviceId = this.getModeDeviceId();
    const candidates = this.valueCandidatesFor(mode);
    let lastError: unknown;

    for (const value of candidates) {
      try {
        await this.issueProperty(deviceId, this.modeCode, value);
        // Confirm the device accepted / stored the value.
        await delay(400);
        const properties = await this.getProperties(deviceId, [this.modeCode]);
        const hit = properties.find((item) => item.code === this.modeCode);
        const parsed = hit ? this.parseModeValue(hit.value) : undefined;
        if (parsed === mode || valuesEqual(hit?.value, value)) {
          this.learnedModeValues[mode] = value;
          return;
        }
        lastError = new TuyaApiError(
          `Mode DP ${this.modeCode} still ${JSON.stringify(hit?.value)} after setting ${JSON.stringify(value)}`,
        );
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new TuyaApiError(`Failed to set intercom mode ${mode} on ${this.modeCode}`);
  }

  /**
   * Resolve which property holds At Home / Not at Home / Dormant.
   */
  async ensureModeCode(): Promise<string> {
    if (this.options.modeCode) {
      this.modeCode = this.options.modeCode.trim();
      return this.modeCode;
    }
    // Do not auto-pick motion_sensitivity / record_mode / etc. — require an explicit modeCode
    // unless a property already holds a clear At Home / Not at Home / Dormant label.
    try {
      const properties = await this.getProperties(this.getModeDeviceId());
      const discovered = discoverModeProperty(properties, this.configuredModeValues);
      if (discovered && !MODE_CODE_BLOCKLIST.includes(discovered.toLowerCase())) {
        this.modeCode = discovered;
      }
    } catch {
      // leave empty
    }
    return this.modeCode;
  }

  parseModeValue(value: unknown): GateMode | undefined {
    const raw = String(value ?? '').trim().toLowerCase();
    for (const mode of ['home', 'out', 'dormant'] as GateMode[]) {
      const learned = this.learnedModeValues[mode];
      if (learned != null && valuesEqual(learned, value)) {
        return mode;
      }
      if (raw === String(this.configuredModeValues[mode]).toLowerCase()) {
        return mode;
      }
    }
    if (['home', 'at_home', 'athome', 'at home', '0'].includes(raw)) {
      return 'home';
    }
    if (['out', 'away', 'leave_home', 'not_at_home', 'nothome', 'not at home', '1'].includes(raw)) {
      return 'out';
    }
    if (['dormant', 'sleep', 'rest', 'dnd', 'hibernate', '2'].includes(raw)) {
      return 'dormant';
    }
    return undefined;
  }

  private valueCandidatesFor(mode: GateMode): Array<string | number> {
    const ordered: Array<string | number> = [];
    const push = (value: string | number) => {
      if (!ordered.some((item) => valuesEqual(item, value))) {
        ordered.push(value);
      }
    };
    if (this.learnedModeValues[mode] != null) {
      push(this.learnedModeValues[mode]!);
    }
    // User-configured value first (unless still the generic default and we should try broader set).
    push(this.configuredModeValues[mode]);
    for (const value of MODE_VALUE_CANDIDATES[mode]) {
      push(value);
    }
    return ordered;
  }

  async issueProperty(
    deviceId: string,
    code: string,
    value: boolean | string | number,
  ): Promise<void> {
    const path = `/v2.0/cloud/thing/${deviceId}/shadow/properties/issue`;
    const body = JSON.stringify({
      properties: JSON.stringify({ [code]: value }),
    });
    const response = await this.request('POST', path, body);
    if (!response.success) {
      throw new TuyaApiError(response.msg || 'Tuya property issue failed', response.code);
    }
  }

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
      // ignore
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
  const usable = properties.filter(
    (property) => !MODE_CODE_BLOCKLIST.includes(property.code.toLowerCase()),
  );

  // Only match clear string labels (At Home / Not at Home / Dormant). Never bare 0/1/2.
  const aliases = new Set(
    [
      modeValues.home,
      modeValues.out,
      modeValues.dormant,
      'home',
      'out',
      'dormant',
      'at_home',
      'at home',
      'leave_home',
      'not_at_home',
      'not at home',
      'away',
      'sleep',
      'rest',
      'hibernate',
    ].map((value) => String(value).toLowerCase()),
  );

  for (const property of usable) {
    const value = String(property.value ?? '').trim().toLowerCase();
    if (aliases.has(value)) {
      return property.code;
    }
  }

  // Prefer exact known mode DP names only if present (still better than guessing enums).
  for (const candidate of MODE_CODE_CANDIDATES) {
    if (candidate === 'mode') {
      continue; // too generic
    }
    const hit = usable.find((property) => property.code.toLowerCase() === candidate);
    if (hit) {
      return hit.code;
    }
  }
  return undefined;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return String(a) === String(b);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueCodes(codes: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const code of codes) {
    const trimmed = code.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/** True when a Tuya ring DP indicates an active visitor call. */
export function isRingActiveValue(value: unknown): boolean {
  if (value == null) {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const raw = String(value).trim();
  if (!raw) {
    return false;
  }
  const lower = raw.toLowerCase();
  if (lower === '0' || lower === 'false' || lower === 'off' || lower === 'idle' || lower === 'none') {
    return false;
  }
  if (lower === '{}' || lower === '[]' || lower === 'null') {
    return false;
  }
  return true;
}
