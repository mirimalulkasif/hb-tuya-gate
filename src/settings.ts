export const PLATFORM_NAME = 'TuyaGate';
export const PLUGIN_NAME = 'homebridge-tuya-gate';

export const DEFAULT_LOCK_CODE = 'accessory_lock';
export const DEFAULT_REGION = 'eu';
/** Common on Tuya Gate Camera / intercom (DP 151). */
export const DEFAULT_MODE_CODE = 'call_mode';

/**
 * Typical call_mode enums: 0 = At Home, 1 = Not at Home, 2 = Dormant.
 * Override in config if Query properties shows different values.
 */
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
