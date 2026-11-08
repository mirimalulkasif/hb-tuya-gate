export const PLATFORM_NAME = 'TuyaGate';
export const PLUGIN_NAME = 'homebridge-tuya-gate';

export const DEFAULT_LOCK_CODE = 'accessory_lock';
export const DEFAULT_REGION = 'eu';
export const DEFAULT_MODE_CODE = 'mode';

/** Tuya enum values often used for indoor monitor ring modes. */
export const DEFAULT_MODE_HOME = 'home';
export const DEFAULT_MODE_OUT = 'out';
export const DEFAULT_MODE_DORMANT = 'dormant';

export const REGION_HOSTS: Record<string, string> = {
  eu: 'https://openapi.tuyaeu.com',
  us: 'https://openapi.tuyaus.com',
  us_west: 'https://openapi.tuyaus.com',
  cn: 'https://openapi.tuyacn.com',
  in: 'https://openapi.tuyain.com',
};
