import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { TuyaGatePlatform } from './platform';
import { RingWatcher } from './ring-watcher';
import { TuyaApiError, type GateMode, type TuyaClient } from './tuya-client';

export interface GateAccessoryOptions {
  displayName: string;
  showSwitch: boolean;
  showModes: boolean;
  modePollSeconds: number;
  showRingSensor: boolean;
  ringPollSeconds: number;
  ringHoldSeconds: number;
  /** Enable Tuya Message Service push (needed for reliable rings). */
  ringPush: boolean;
  messageEnv: 'prod' | 'test';
}

/**
 * Gate Camera in Home: Lock opens the door; optional open switch;
 * optional Home / Out / Dormant mode switches; optional Ring motion for notifications.
 */
export class GateAccessory {
  private readonly lockService: Service;
  private readonly switchService?: Service;
  private readonly ringService?: Service;
  private readonly modeServices = new Map<GateMode, Service>();
  private busy = false;
  private modeBusy = false;
  private currentMode: GateMode = 'home';
  private modeTimer?: ReturnType<typeof setInterval>;
  private ringTimer?: ReturnType<typeof setInterval>;
  private ringClearTimer?: ReturnType<typeof setTimeout>;
  private ringWatcher?: RingWatcher;
  private ringing = false;
  private ringPollInFlight = false;
  private lastPollSnapshot = '';

  constructor(
    private readonly platform: TuyaGatePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: TuyaClient,
    private readonly options: GateAccessoryOptions,
  ) {
    const { Characteristic, Service } = this.platform;
    const { displayName, showSwitch, showModes, showRingSensor } = options;

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
    this.ringService = this.setupRingSensor(showRingSensor, displayName);

    if (showModes) {
      void this.bootstrapModes();
      const pollMs = Math.max(30, options.modePollSeconds) * 1000;
      this.modeTimer = setInterval(() => {
        void this.refreshMode('poll');
      }, pollMs);
    }

    if (showRingSensor && this.ringService) {
      this.platform.log.info(
        `[${displayName}] ring sensor on — codes ${this.client.getRingCodes().join(', ')}; `
          + `poll every ${options.ringPollSeconds}s`
          + (options.ringPush ? '; Message Service push enabled' : ''),
      );
      if (options.ringPush) {
        this.startRingPush();
      }
      void this.pollRing();
      const pollMs = Math.max(1, options.ringPollSeconds) * 1000;
      this.ringTimer = setInterval(() => {
        void this.pollRing();
      }, pollMs);
    }
  }

  private async bootstrapModes(): Promise<void> {
    try {
      const code = await this.client.ensureModeCode();
      this.platform.log.info(
        `[${this.options.displayName}] mode DP=${code} on device ${this.client.getModeDeviceId()}`,
      );
      const candidates = await this.client.describeModeCandidates();
      if (candidates.length > 0) {
        this.platform.log.info(
          `[${this.options.displayName}] mode-like properties: ${candidates.join(' | ')}`,
        );
      } else {
        this.platform.log.warn(
          `[${this.options.displayName}] no mode-like properties found — `
            + 'mode may be on the indoor monitor device id (set modeDeviceId), or set modeCode from Query properties',
        );
      }
    } catch (error) {
      this.platform.log.warn(`[${this.options.displayName}] mode discovery failed: ${errorMessage(error)}`);
    }
    await this.refreshMode('startup');
  }

  stop(): void {
    if (this.modeTimer) {
      clearInterval(this.modeTimer);
      this.modeTimer = undefined;
    }
    if (this.ringTimer) {
      clearInterval(this.ringTimer);
      this.ringTimer = undefined;
    }
    if (this.ringClearTimer) {
      clearTimeout(this.ringClearTimer);
      this.ringClearTimer = undefined;
    }
    this.ringWatcher?.stop();
    this.ringWatcher = undefined;
  }

  private startRingPush(): void {
    const cfg = this.platform.config;
    this.ringWatcher = new RingWatcher({
      accessId: String(cfg.accessId || ''),
      accessSecret: String(cfg.accessSecret || ''),
      deviceId: String(cfg.deviceId || ''),
      region: String(cfg.region || 'eu'),
      messageEnv: this.options.messageEnv,
      ringCodes: this.client.getRingCodes(),
      log: (message) => this.platform.log.info(`[${this.options.displayName}] ${message}`),
      debugLog: (message) => this.platform.log.debug(`[${this.options.displayName}] ${message}`),
    });
    this.ringWatcher.on('ring', (event: { code: string }) => {
      this.markRinging(`${event.code}/push`);
    });
    this.ringWatcher.start();
  }

  /** Test helper — inject a ring without Tuya. */
  triggerRingForTests(): void {
    this.markRinging('test');
  }

  private setupRingSensor(enabled: boolean, displayName: string): Service | undefined {
    const { Characteristic, Service } = this.platform;
    const existing = this.accessory.getServiceById(Service.MotionSensor, 'gate-ring')
      || this.accessory.getService(`${displayName} Ring`);
    if (!enabled) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return undefined;
    }
    const label = `${displayName} Ring`;
    const service = existing || this.accessory.addService(Service.MotionSensor, label, 'gate-ring');
    service.setCharacteristic(Characteristic.Name, label);
    if ('ConfiguredName' in Characteristic) {
      try {
        service.setCharacteristic(Characteristic.ConfiguredName, label);
      } catch {
        // older HAP
      }
    }
    service.updateCharacteristic(Characteristic.MotionDetected, false);
    service.getCharacteristic(Characteristic.MotionDetected).onGet(() => this.ringing);
    this.lockService.addLinkedService(service);
    return service;
  }

  private async pollRing(): Promise<void> {
    if (this.ringPollInFlight || !this.ringService) {
      return;
    }
    this.ringPollInFlight = true;
    try {
      const sample = await this.client.getRingSample();
      const snapshot = `${sample.code || ''}:${sample.time || ''}:${JSON.stringify(sample.value ?? '')}`;
      if (snapshot !== this.lastPollSnapshot && sample.ringing) {
        this.platform.log.info(
          `[${this.options.displayName}] ring poll hit ${sample.code}`
            + (sample.time ? ` time=${sample.time}` : ''),
        );
      }
      this.lastPollSnapshot = snapshot;
      if (sample.ringing) {
        this.markRinging(`${sample.code || 'ring'}/poll`);
      }
    } catch (error) {
      this.platform.log.warn(`[${this.options.displayName}] ring poll: ${errorMessage(error)}`);
    } finally {
      this.ringPollInFlight = false;
    }
  }

  private markRinging(source: string): void {
    if (!this.ringService) {
      return;
    }
    const { Characteristic } = this.platform;
    if (!this.ringing) {
      this.platform.log.info(`[${this.options.displayName}] visitor ringing (${source})`);
    }
    this.ringing = true;
    this.ringService.updateCharacteristic(Characteristic.MotionDetected, true);
    if (this.ringClearTimer) {
      clearTimeout(this.ringClearTimer);
    }
    this.ringClearTimer = setTimeout(() => {
      this.ringing = false;
      this.ringService?.updateCharacteristic(Characteristic.MotionDetected, false);
      this.platform.log.info(`[${this.options.displayName}] ring cleared`);
    }, Math.max(3, this.options.ringHoldSeconds) * 1000);
  }

  private setupModeSwitches(enabled: boolean): void {
    const { Characteristic, Service } = this.platform;
    // Distinct labels — Home often shows the accessory name ("Open Gate") for every
    // linked switch unless the service Name is clearly different.
    const modes: Array<{ mode: GateMode; subtype: string; label: string }> = [
      { mode: 'home', subtype: 'mode-home', label: 'At Home' },
      { mode: 'out', subtype: 'mode-out', label: 'Not at Home' },
      { mode: 'dormant', subtype: 'mode-dormant', label: 'Dormant' },
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
    this.platform.log.info(
      `[${this.options.displayName}] setting intercom mode → ${mode} `
        + `(DP ${this.client.getModeCode()} on ${this.client.getModeDeviceId()})`,
    );
    try {
      await this.client.setMode(mode);
      this.currentMode = mode;
      this.applyModeToHomeKit(mode);
      this.platform.log.info(`[${this.options.displayName}] device confirmed mode ${mode}`);
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
            + 'If the wall unit mode does not change any Query properties value, Tuya cloud cannot control it — leave showModes off.',
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
