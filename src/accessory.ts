import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { TuyaGatePlatform } from './platform';
import { TuyaApiError, TuyaClient } from './tuya-client';

export class GateAccessory {
  private readonly lockService: Service;
  private readonly switchService?: Service;
  private busy = false;

  constructor(
    private readonly platform: TuyaGatePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: TuyaClient,
    private readonly displayName: string,
    private readonly showSwitch: boolean,
  ) {
    const { Characteristic, Service } = this.platform;

    this.accessory.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Tuya')
      .setCharacteristic(Characteristic.Model, 'Gate Camera Lock')
      .setCharacteristic(Characteristic.SerialNumber, String(this.platform.config.deviceId || 'unknown'));

    this.lockService = this.accessory.getService(Service.LockMechanism)
      || this.accessory.addService(Service.LockMechanism, displayName);
    this.lockService.setCharacteristic(Characteristic.Name, displayName);
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

    const existingSwitch = this.accessory.getService('Open Gate Switch')
      || this.accessory.getService(Service.Switch);

    if (showSwitch) {
      this.switchService = existingSwitch
        || this.accessory.addService(Service.Switch, `${displayName} Switch`, 'open-gate-switch');
      this.switchService.setCharacteristic(Characteristic.Name, `${displayName} Switch`);
      this.switchService.getCharacteristic(Characteristic.On)
        .onGet(() => false)
        .onSet((value) => this.setSwitch(value));
    } else if (existingSwitch) {
      this.accessory.removeService(existingSwitch);
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
    // HomeKit applies the UNSECURED target after onSet returns; reset on the next tick.
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
      this.platform.log.warn(`[${this.displayName}] open already in progress`);
      return;
    }
    this.busy = true;
    this.platform.log.info(`[${this.displayName}] opening gate (${source})`);
    try {
      await this.client.openGate();
      this.platform.log.info(`[${this.displayName}] open command sent`);
    } catch (error) {
      this.platform.log.error(`[${this.displayName}] ${errorMessage(error)}`);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    } finally {
      // Keep busy briefly so HomeKit retries do not spam Tuya.
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
  return 'Tuya open command failed';
}
