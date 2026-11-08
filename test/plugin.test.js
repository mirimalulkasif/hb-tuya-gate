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

test('lock only open path: unlock sends openGate', async () => {
  const opens = [];
  const { accessories, launch, platform, shutdown } = createPlatform({
    openGate: async () => {
      opens.push(true);
    },
    getMode: async () => 'home',
    setMode: async () => undefined,
  });

  try {
    launch();
    await platform.ready;
    assert.equal(accessories.length, 1);

    const lock = accessories[0].getService(hap.Service.LockMechanism);
    const target = lock.getCharacteristic(hap.Characteristic.LockTargetState);
    await setCharacteristic(target, hap.Characteristic.LockTargetState.UNSECURED);
    await waitFor(() => opens.length === 1);
    await waitFor(() => target.value === hap.Characteristic.LockTargetState.SECURED);
    assert.equal(opens.length, 1);
  } finally {
    shutdown();
  }
});

test('showSwitch true exposes a momentary switch that opens the gate', async () => {
  const opens = [];
  const { accessories, launch, platform, shutdown } = createPlatform({
    config: { showSwitch: true, showModes: false },
    openGate: async () => {
      opens.push(true);
    },
  });

  try {
    launch();
    await platform.ready;
    const sw = accessories[0].getServiceById(hap.Service.Switch, 'open-gate-switch');
    assert.ok(sw);
    const on = sw.getCharacteristic(hap.Characteristic.On);
    await setCharacteristic(on, true);
    await waitFor(() => opens.length === 1);
  } finally {
    shutdown();
  }
});

test('mode switches are off unless showModes is enabled', async () => {
  const { accessories, launch, platform, shutdown } = createPlatform({
    config: { showModes: false },
    openGate: async () => undefined,
  });
  try {
    launch();
    await platform.ready;
    assert.equal(accessories[0].getServiceById(hap.Service.Switch, 'mode-home'), undefined);
  } finally {
    shutdown();
  }
});

test('ring motion sensor trips when Tuya reports a visitor call', async () => {
  let ringing = false;
  const { accessories, launch, platform, shutdown } = createPlatform({
    config: { showRingSensor: true, ringPollSeconds: 1, ringHoldSeconds: 3 },
    getRingSample: async () => (ringing
      ? { ringing: true, code: 'doorbell_active', value: 'call' }
      : { ringing: false }),
  });

  try {
    launch();
    await platform.ready;
    const motion = accessories[0].getServiceById(hap.Service.MotionSensor, 'gate-ring');
    assert.ok(motion);
    assert.equal(motion.getCharacteristic(hap.Characteristic.MotionDetected).value, false);

    ringing = true;
    platform.accessoryHandler.triggerRingForTests();
    assert.equal(motion.getCharacteristic(hap.Characteristic.MotionDetected).value, true);
  } finally {
    shutdown();
  }
});

test('Test Ring switch trips the ring motion sensor', async () => {
  const { accessories, launch, platform, shutdown } = createPlatform({
    config: { showRingSensor: true, showTestRingSwitch: true, ringPush: false },
  });
  try {
    launch();
    await platform.ready;
    const motion = accessories[0].getServiceById(hap.Service.MotionSensor, 'gate-ring');
    const testSwitch = accessories[0].getServiceById(hap.Service.Switch, 'test-ring-switch');
    assert.ok(motion);
    assert.ok(testSwitch);
    await setCharacteristic(testSwitch.getCharacteristic(hap.Characteristic.On), true);
    assert.equal(motion.getCharacteristic(hap.Characteristic.MotionDetected).value, true);
  } finally {
    shutdown();
  }
});

test('mode switches set intercom home/out/dormant (not an alarm)', async () => {
  const modes = [];
  const { accessories, launch, platform, shutdown } = createPlatform({
    config: { showModes: true, modeCode: 'call_mode' },
    openGate: async () => undefined,
    getMode: async () => 'home',
    setMode: async (mode) => {
      modes.push(mode);
    },
  });

  try {
    launch();
    await platform.ready;
    const home = accessories[0].getServiceById(hap.Service.Switch, 'mode-home');
    const out = accessories[0].getServiceById(hap.Service.Switch, 'mode-out');
    const dormant = accessories[0].getServiceById(hap.Service.Switch, 'mode-dormant');
    assert.ok(home);
    assert.ok(out);
    assert.ok(dormant);
    assert.equal(accessories[0].getService(hap.Service.SecuritySystem), undefined);

    await waitFor(() => home.getCharacteristic(hap.Characteristic.On).value === true);

    await setCharacteristic(out.getCharacteristic(hap.Characteristic.On), true);
    await waitFor(() => modes.includes('out'));
    assert.equal(out.getCharacteristic(hap.Characteristic.On).value, true);
    assert.equal(home.getCharacteristic(hap.Characteristic.On).value, false);

    await setCharacteristic(dormant.getCharacteristic(hap.Characteristic.On), true);
    await waitFor(() => modes.includes('dormant'));
    assert.equal(dormant.getCharacteristic(hap.Characteristic.On).value, true);
  } finally {
    shutdown();
  }
});

function createPlatform({ openGate, getMode, setMode, getRingSample, config = {} }) {
  const accessories = [];
  let launch = () => {};
  let shutdown = () => {};
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
      if (event === 'shutdown') {
        shutdown = callback;
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
    ringPush: false,
    ...config,
  }, api, () => ({
    openGate: openGate || (async () => undefined),
    getMode: getMode || (async () => 'home'),
    setMode: setMode || (async () => undefined),
    getModeCode: () => 'mode',
    getModeDeviceId: () => 'bf3f24408fb356db59qioh',
    ensureModeCode: async () => 'mode',
    describeModeCandidates: async () => ['mode="at_home" (dp 1)'],
    getRingCodes: () => ['doorbell_active'],
    getRingSample: getRingSample || (async () => ({ ringing: false })),
    describeRingWatch: async () => 'doorbell_active="" | alarm_message time=? ipc_doorbell=no',
  }));

  return { accessories, launch, platform, shutdown };
}

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
        reject(new Error('timed out waiting for condition'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}
