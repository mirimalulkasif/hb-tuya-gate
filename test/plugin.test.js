const assert = require('node:assert/strict');
const test = require('node:test');

const hap = require('hap-nodejs');
const { PlatformAccessory } = require('homebridge/lib/platformAccessory');

const plugin = require('../dist/index');
const { TuyaGatePlatform } = require('../dist/platform');

test('the plugin registers the Tuya Gate platform', () => {
  let registered = null;
  plugin({
    registerPlatform(pluginName, platformName, constructor) {
      registered = { pluginName, platformName, constructor };
    },
  });
  assert.deepEqual(registered, {
    pluginName: 'homebridge-tuya-gate',
    platformName: 'TuyaGate',
    constructor: TuyaGatePlatform,
  });
});

test('unlocking the lock sends openGate once', async () => {
  const opens = [];
  const accessories = [];
  let launch = () => {};

  const api = {
    hap,
    platformAccessory: PlatformAccessory,
    registerPlatformAccessories(_pluginName, _platformName, list) {
      accessories.push(...list);
    },
    unregisterPlatformAccessories() {},
    on(event, callback) {
      if (event === 'didFinishLaunching') {
        launch = callback;
      }
    },
  };

  const platform = new TuyaGatePlatform({
    info() {},
    warn() {},
    error() {},
    debug() {},
  }, {
    name: 'Open Gate',
    accessId: 'id',
    accessSecret: 'secret',
    deviceId: 'bf3f24408fb356db59qioh',
    region: 'eu',
  }, api, () => ({
    openGate: async () => {
      opens.push(true);
    },
  }));

  launch();
  await platform.ready;
  assert.equal(accessories.length, 1);

  const lock = accessories[0].getService(hap.Service.LockMechanism);
  const target = lock.getCharacteristic(hap.Characteristic.LockTargetState);
  const sw = accessories[0].getService('Open Gate Switch');
  const on = sw.getCharacteristic(hap.Characteristic.On);

  await setCharacteristic(on, true);
  await waitFor(() => opens.length === 1);
  assert.equal(opens.length, 1);

  await setCharacteristic(target, hap.Characteristic.LockTargetState.UNSECURED);
  await waitFor(() => opens.length === 2);
  assert.equal(opens.length, 2);
  assert.equal(target.value, hap.Characteristic.LockTargetState.SECURED);
});

function setCharacteristic(characteristic, value) {
  return new Promise((resolve, reject) => {
    characteristic.setValue(value, (error) => (error ? reject(error) : resolve()));
  });
}

function waitFor(predicate, timeoutMs = 1000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timed out waiting for openGate'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}
