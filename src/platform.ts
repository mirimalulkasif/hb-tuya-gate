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
import { DEFAULT_LOCK_CODE, DEFAULT_REGION, PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { TuyaClient } from './tuya-client';

export class TuyaGatePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  private readonly cachedAccessories: PlatformAccessory[] = [];
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
      }),
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.api.on('didFinishLaunching', () => {
      this.ready = Promise.resolve().then(() => this.start());
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
    new GateAccessory(this, accessory, client, name, showSwitch);

    if (!existing) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    const stale = this.cachedAccessories.filter((item) => item.UUID !== uuid);
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }

    this.log.info(
      `Ready to open ${name} on device ${this.config.deviceId} (${this.config.lockCode || DEFAULT_LOCK_CODE}; ${showSwitch ? 'lock+switch' : 'lock only'})`,
    );
  }
}
