import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { TuyaGatePlatform } from './platform';
import { TuyaApiError, type GateMode, type TuyaClient } from './tuya-client';

export interface GateAccessoryOptions {
  displayName: string;
  showSwitch: boolean;
  showModes: boolean;
  modePollSeconds: number;
}

/**
 * Gate Camera in Home: Lock opens the door; optional open switch;
 * optional Home / Out / Dormant mode switches (intercom ring behaviour — not an alarm).
 */
export class GateAccessory {
  private readonly lockService: Service;
  private readonly switchService?: Service;
  private readonly modeServices = new Map<GateMode, Service>();
  private busy = false;
  private modeBusy = false;
  private currentMode: GateMode = 'home';
  private modeTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly platform: TuyaGatePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: TuyaClient,
    private readonly options: GateAccessoryOptions,
  ) {
    const { Characteristic, Service } = this.platform;
    const { displayName, showSwitch, showModes } = options;

    this.accessory.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Tuya')
      .setCharacteristic(Characteristic.Model, 'Gate Camera Lock')
      .setCharacteristic(Characteristic.SerialNumber, String(this.platform.config.deviceId || 'unknown'));

    this.lockService = this.accessory.getService(Service.LockMechanism)
      || this.accessory.addService(Service.LockMechanism, displayName);
    this.lockService.setCharacteristic(Characteristic.Name, displayName);
    this.lockService.setPrimaryService(true);
    this.lockService.updateCharacteristic(
      Characteristic.LockCurrentState,
      Characteristic.LockCurrentState.SECURED,
    );
    this.lockService.updateCharacteristic(
      Characteristic.LockTargetState,
      Characteristic.LockTargetState.SECURED,
    );
    this.lockService.getCharacteristic(Characteristic.LockTargetState)
      .onSet((value) => this.setLockTarget(value));
    this.lockService.getCharacteristic(Characteristic.LockCurrentState)
      .onGet(() => Characteristic.LockCurrentState.SECURED);

    const existingOpenSwitch = this.accessory.getServiceById(Service.Switch, 'open-gate-switch')
      || this.accessory.getService('Open Gate Switch');

    if (showSwitch) {
      this.switchService = existingOpenSwitch
        || this.accessory.addService(Service.Switch, `${displayName} Switch`, 'open-gate-switch');
      this.switchService.setCharacteristic(Characteristic.Name, `${displayName} Switch`);
      this.switchService.getCharacteristic(Characteristic.On)
        .onGet(() => false)
        .onSet((value) => this.setSwitch(value));
      this.lockService.addLinkedService(this.switchService);
    } else if (existingOpenSwitch) {
      this.accessory.removeService(existingOpenSwitch);
    }

    this.setupModeSwitches(showModes);

    if (showModes) {
      void this.refreshMode('startup');
      const pollMs = Math.max(30, options.modePollSeconds) * 1000;
      this.modeTimer = setInterval(() => {
        void this.refreshMode('poll');
      }, pollMs);
    }
  }

  stop(): void {
    if (this.modeTimer) {
      clearInterval(this.modeTimer);
      this.modeTimer = undefined;
    }
  }

  private setupModeSwitches(enabled: boolean): void {
    const { Characteristic, Service } = this.platform;
    // Distinct labels — Home often shows the accessory name ("Open Gate") for every
    // linked switch unless the service Name is clearly different.
    const modes: Array<{ mode: GateMode; subtype: string; label: string }> = [
      { mode: 'home', subtype: 'mode-home', label: 'Intercom Home (ring)' },
      { mode: 'out', subtype: 'mode-out', label: 'Intercom Out' },
      { mode: 'dormant', subtype: 'mode-dormant', label: 'Intercom Dormant (silent)' },
    ];

    for (const entry of modes) {
      const existing = this.accessory.getServiceById(Service.Switch, entry.subtype);
      if (!enabled) {
        if (existing) {
          this.accessory.removeService(existing);
        }
        continue;
      }
      const service = existing
        || this.accessory.addService(Service.Switch, entry.label, entry.subtype);
      service.displayName = entry.label;
      service.setCharacteristic(Characteristic.Name, entry.label);
      // ConfiguredName is what modern Home apps show / allow renaming.
      if ('ConfiguredName' in Characteristic) {
        try {
          service.setCharacteristic(Characteristic.ConfiguredName, entry.label);
        } catch {
          // Older HAP builds may not allow ConfiguredName on Switch.
        }
      }
      service.getCharacteristic(Characteristic.On)
        .onGet(() => this.currentMode === entry.mode)
        .onSet((value) => this.setModeSwitch(entry.mode, value));
      this.modeServices.set(entry.mode, service);
      this.lockService.addLinkedService(service);
    }
  }

  private async setModeSwitch(mode: GateMode, value: CharacteristicValue): Promise<void> {
    if (!value) {
      // Keep the active mode switch on — modes are radio buttons, not independent toggles.
      this.applyModeToHomeKit(this.currentMode);
      return;
    }
    if (this.modeBusy) {
      this.platform.log.warn(`[${this.options.displayName}] mode change already in progress`);
      this.applyModeToHomeKit(this.currentMode);
      return;
    }
    this.modeBusy = true;
    this.platform.log.info(`[${this.options.displayName}] setting intercom mode → ${mode}`);
    try {
      await this.client.setMode(mode);
      this.currentMode = mode;
      this.applyModeToHomeKit(mode);
      this.platform.log.info(
        `[${this.options.displayName}] mode set to ${mode} (DP ${this.client.getModeCode()})`,
      );
    } catch (error) {
      this.platform.log.error(`[${this.options.displayName}] ${errorMessage(error)}`);
      this.applyModeToHomeKit(this.currentMode);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    } finally {
      this.modeBusy = false;
    }
  }

  private async refreshMode(reason: string): Promise<void> {
    try {
      const mode = await this.client.getMode();
      if (!mode) {
        this.platform.log.warn(
          `[${this.options.displayName}] could not read intercom mode (${reason}). `
            + `Set modeCode in config from the device shadow properties if needed.`,
        );
        return;
      }
      if (mode !== this.currentMode) {
        this.platform.log.info(`[${this.options.displayName}] intercom mode is ${mode} (${reason})`);
      }
      this.currentMode = mode;
      this.applyModeToHomeKit(mode);
    } catch (error) {
      this.platform.log.warn(`[${this.options.displayName}] mode refresh failed: ${errorMessage(error)}`);
    }
  }

  private applyModeToHomeKit(mode: GateMode): void {
    for (const [key, service] of this.modeServices) {
      service.updateCharacteristic(this.platform.Characteristic.On, key === mode);
    }
  }

  private async setLockTarget(value: CharacteristicValue): Promise<void> {
    const { Characteristic } = this.platform;
    if (Number(value) !== Characteristic.LockTargetState.UNSECURED) {
      this.lockService.updateCharacteristic(
        Characteristic.LockCurrentState,
        Characteristic.LockCurrentState.SECURED,
      );
      return;
    }
    await this.pulseOpen('lock');
    setTimeout(() => {
      this.lockService.updateCharacteristic(
        Characteristic.LockTargetState,
        Characteristic.LockTargetState.SECURED,
      );
      this.lockService.updateCharacteristic(
        Characteristic.LockCurrentState,
        Characteristic.LockCurrentState.SECURED,
      );
    }, 50);
  }

  private async setSwitch(value: CharacteristicValue): Promise<void> {
    if (!value || !this.switchService) {
      return;
    }
    await this.pulseOpen('switch');
    setTimeout(() => {
      this.switchService?.updateCharacteristic(this.platform.Characteristic.On, false);
    }, 500);
  }

  private async pulseOpen(source: string): Promise<void> {
    if (this.busy) {
      this.platform.log.warn(`[${this.options.displayName}] open already in progress`);
      return;
    }
    this.busy = true;
    this.platform.log.info(`[${this.options.displayName}] opening gate (${source})`);
    try {
      await this.client.openGate();
      this.platform.log.info(`[${this.options.displayName}] open command sent`);
    } catch (error) {
      this.platform.log.error(`[${this.options.displayName}] ${errorMessage(error)}`);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    } finally {
      setTimeout(() => {
        this.busy = false;
      }, 1500);
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof TuyaApiError) {
    return error.code != null ? `${error.message} (${error.code})` : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Tuya command failed';
}
