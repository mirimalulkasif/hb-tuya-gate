import type { API } from 'homebridge';

import { TuyaGatePlatform } from './platform';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

export = (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, TuyaGatePlatform);
};
