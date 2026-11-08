import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { GateAccessory } from './accessory';
import {
  DEFAULT_LOCK_CODE,
  DEFAULT_MODE_CODE,
  DEFAULT_MODE_DORMANT,
  DEFAULT_MODE_HOME,
  DEFAULT_MODE_OUT,
  DEFAULT_REGION,
  DEFAULT_RING_CODE,
  DEFAULT_RING_HOLD_SECONDS,
  DEFAULT_RING_POLL_SECONDS,
  PLATFORM_NAME,
  PLUGIN_NAME,
} from './settings';
import { TuyaClient } from './tuya-client';

export class TuyaGatePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  private readonly cachedAccessories: PlatformAccessory[] = [];
  /** Exposed for tests. */
  accessoryHandler?: GateAccessory;
  public ready: Promise<void> = Promise.resolve();

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
    private readonly clientFactory: (config: PlatformConfig) => TuyaClient = (cfg) =>
      new TuyaClient({
        accessId: String(cfg.accessId || ''),
        accessSecret: String(cfg.accessSecret || ''),
        deviceId: String(cfg.deviceId || ''),
        region: String(cfg.region || DEFAULT_REGION),
        lockCode: String(cfg.lockCode || DEFAULT_LOCK_CODE),
        modeDeviceId: cfg.modeDeviceId ? String(cfg.modeDeviceId) : undefined,
        modeCode: cfg.modeCode ? String(cfg.modeCode) : undefined,
        modeHomeValue: String(cfg.modeHomeValue || DEFAULT_MODE_HOME),
        modeOutValue: String(cfg.modeOutValue || DEFAULT_MODE_OUT),
        modeDormantValue: String(cfg.modeDormantValue || DEFAULT_MODE_DORMANT),
        ringCode: cfg.ringCode ? String(cfg.ringCode) : DEFAULT_RING_CODE,
        warmupStream: cfg.warmupStream !== false,
      }),
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.api.on('didFinishLaunching', () => {
      this.ready = Promise.resolve().then(() => this.start());
    });
    this.api.on('shutdown', () => {
      this.accessoryHandler?.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
    this.log.debug(`Restoring cached accessory ${accessory.displayName}`);
  }

  private start(): void {
    const missing = ['accessId', 'accessSecret', 'deviceId'].filter((key) => !this.config[key]);
    if (missing.length > 0) {
      this.log.error(`Missing Tuya Gate configuration: ${missing.join(', ')}`);
      return;
    }

    const name = String(this.config.name || 'Open Gate');
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.config.deviceId}`);
    const existing = this.cachedAccessories.find((item) => item.UUID === uuid);
    const accessory = existing ?? new this.api.platformAccessory(name, uuid);
    accessory.context.deviceId = this.config.deviceId;

    const client = this.clientFactory(this.config);
    const showSwitch = this.config.showSwitch === true;
    // Off by default: many Gate Cameras do not expose ring mode over Tuya cloud.
    const showModes = this.config.showModes === true;
    const modePollSeconds = Number(this.config.modePollSeconds) || 120;
    // On by default — Home can notify when this motion sensor trips.
    const showRingSensor = this.config.showRingSensor !== false;
    // Off by default — cannot drive the physical intercom; only tests Home notifications.
    const showTestRingSwitch = this.config.showTestRingSwitch === true;
    const ringPollSeconds = Number(this.config.ringPollSeconds) || DEFAULT_RING_POLL_SECONDS;
    const ringHoldSeconds = Number(this.config.ringHoldSeconds) || DEFAULT_RING_HOLD_SECONDS;
    const ringPush = this.config.ringPush !== false;
    const messageEnv = this.config.messageEnv === 'test' ? 'test' : 'prod';

    this.accessoryHandler = new GateAccessory(this, accessory, client, {
      displayName: name,
      showSwitch,
      showModes,
      modePollSeconds,
      showRingSensor,
      showTestRingSwitch,
      ringPollSeconds,
      ringHoldSeconds,
      ringPush,
      messageEnv,
    });

    if (!existing) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    const stale = this.cachedAccessories.filter((item) => item.UUID !== uuid);
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }

    this.log.info(
      `Ready: ${name} device=${this.config.deviceId} lock=${this.config.lockCode || DEFAULT_LOCK_CODE}`
        + ` modes=${showModes ? `on (${this.config.modeCode || `${DEFAULT_MODE_CODE}/auto`})` : 'off'}`
        + ` ring=${showRingSensor ? `on (${this.config.ringCode || DEFAULT_RING_CODE})` : 'off'}`
        + ` openSwitch=${showSwitch ? 'on' : 'off'}`,
    );
  }
}
