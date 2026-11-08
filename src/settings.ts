export const PLATFORM_NAME = 'TuyaGate';
export const PLUGIN_NAME = 'homebridge-tuya-gate';

export const DEFAULT_LOCK_CODE = 'accessory_lock';
export const DEFAULT_REGION = 'eu';
/**
 * Must be set explicitly for most Gate Cameras — local At Home / Not at Home /
 * Dormant on the indoor monitor often never appears in cloud shadow properties.
 */
export const DEFAULT_MODE_CODE = '';

export const DEFAULT_MODE_HOME = '0';
export const DEFAULT_MODE_OUT = '1';
export const DEFAULT_MODE_DORMANT = '2';

export const REGION_HOSTS: Record<string, string> = {
  eu: 'https://openapi.tuyaeu.com',
  us: 'https://openapi.tuyaus.com',
  us_west: 'https://openapi.tuyaus.com',
  cn: 'https://openapi.tuyacn.com',
  in: 'https://openapi.tuyain.com',
};
