const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TuyaClient,
  TuyaApiError,
  discoverModeProperty,
  isRingActiveValue,
  isIpcDoorbellAlarmMessage,
} = require('../dist/tuya-client');

test('openGate uses v2 shadow properties issue, not v1 commands', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });
    if (String(url).includes('/v1.0/token')) {
      return jsonResponse({
        success: true,
        result: { access_token: 'tok', expire_time: 7200 },
      });
    }
    if (String(url).includes('/stream/actions/allocate')) {
      return jsonResponse({ success: true, result: {} });
    }
    return jsonResponse({ success: true, result: {} });
  };

  const client = new TuyaClient({
    accessId: 'id',
    accessSecret: 'secret',
    deviceId: 'dev123',
    region: 'eu',
    fetchImpl,
    now: () => 1_700_000_000_000,
  });

  await client.openGate();

  assert.ok(calls.some((call) => String(call.url).includes('/v1.0/token')));
  assert.ok(calls.some((call) => String(call.url).includes('/stream/actions/allocate')));
  const issue = calls.find((call) => String(call.url).includes('/shadow/properties/issue'));
  assert.ok(issue);
  assert.equal(issue.method, 'POST');
  assert.deepEqual(JSON.parse(issue.body), {
    properties: JSON.stringify({ accessory_lock: true }),
  });
  assert.equal(
    calls.some((call) => String(call.url).includes('/v1.0/devices/') && String(call.url).includes('/commands')),
    false,
  );
});

test('discoverModeProperty ignores motion_sensitivity and record_mode', () => {
  const code = discoverModeProperty([
    { code: 'motion_sensitivity', value: '2', dp_id: 106 },
    { code: 'record_mode', value: '1', dp_id: 151 },
    { code: 'basic_nightvision', value: '0', dp_id: 108 },
  ], { home: '0', out: '1', dormant: '2' });
  assert.equal(code, undefined);
});

test('discoverModeProperty accepts clear At Home labels', () => {
  const code = discoverModeProperty([
    { code: 'motion_sensitivity', value: '2', dp_id: 106 },
    { code: 'work_mode', value: 'at_home', dp_id: 200 },
  ], { home: '0', out: '1', dormant: '2' });
  assert.equal(code, 'work_mode');
});

test('setMode tries values and verifies readback', async () => {
  const calls = [];
  let stored = '0';
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    if (String(url).includes('/token')) {
      return jsonResponse({ success: true, result: { access_token: 'tok', expire_time: 7200 } });
    }
    if (String(url).includes('/shadow/properties/issue')) {
      const body = JSON.parse(init.body);
      const props = JSON.parse(body.properties);
      stored = props.call_mode;
      return jsonResponse({ success: true, result: {} });
    }
    if (String(url).includes('/shadow/properties')) {
      return jsonResponse({
        success: true,
        result: { properties: [{ code: 'call_mode', value: stored, dp_id: 151 }] },
      });
    }
    return jsonResponse({ success: true, result: {} });
  };

  const client = new TuyaClient({
    accessId: 'id',
    accessSecret: 'secret',
    deviceId: 'cam',
    modeCode: 'call_mode',
    warmupStream: false,
    fetchImpl,
    now: () => 1,
  });

  await client.setMode('dormant');
  assert.equal(String(stored), '2');
  assert.ok(calls.some((call) => call.url.includes('/properties/issue')));
});

test('failed property issue raises TuyaApiError', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/token')) {
      return jsonResponse({
        success: true,
        result: { access_token: 'tok', expire_time: 7200 },
      });
    }
    if (String(url).includes('/stream/')) {
      return jsonResponse({ success: false, msg: 'no stream' });
    }
    return jsonResponse({ success: false, code: 2008, msg: 'command or value not support' });
  };

  const client = new TuyaClient({
    accessId: 'id',
    accessSecret: 'secret',
    deviceId: 'dev123',
    warmupStream: false,
    fetchImpl,
    now: () => 1,
  });

  await assert.rejects(() => client.openGate(), (error) => {
    assert.ok(error instanceof TuyaApiError);
    assert.match(error.message, /command or value not support/);
    return true;
  });
});

test('isRingActiveValue treats empty doorbell_active as idle', () => {
  assert.equal(isRingActiveValue(''), false);
  assert.equal(isRingActiveValue(null), false);
  assert.equal(isRingActiveValue(0), false);
  assert.equal(isRingActiveValue('0'), false);
  assert.equal(isRingActiveValue('call'), true);
  assert.equal(isRingActiveValue(true), true);
  assert.equal(isRingActiveValue('bucket;object;key'), true);
});

test('getRingSample reads doorbell_active', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/token')) {
      return jsonResponse({ success: true, result: { access_token: 'tok', expire_time: 7200 } });
    }
    if (String(url).includes('/shadow/properties')) {
      return jsonResponse({
        success: true,
        result: { properties: [{ code: 'doorbell_active', value: 'ringing-now', dp_id: 136 }] },
      });
    }
    return jsonResponse({ success: true, result: {} });
  };
  const client = new TuyaClient({
    accessId: 'id',
    accessSecret: 'secret',
    deviceId: 'dev123',
    fetchImpl,
    now: () => 1,
  });
  // First call baselines sticky DPs; second sees active doorbell_active.
  assert.equal((await client.getRingSample()).ringing, false);
  const sample = await client.getRingSample();
  assert.equal(sample.ringing, true);
  assert.equal(sample.code, 'doorbell_active');
});

test('getProperties keeps commas literal in codes query', async () => {
  let seenUrl = '';
  const fetchImpl = async (url) => {
    seenUrl = String(url);
    if (seenUrl.includes('/token')) {
      return jsonResponse({ success: true, result: { access_token: 'tok', expire_time: 7200 } });
    }
    return jsonResponse({ success: true, result: { properties: [] } });
  };
  const client = new TuyaClient({
    accessId: 'id',
    accessSecret: 'secret',
    deviceId: 'dev123',
    fetchImpl,
    now: () => 1,
  });
  await client.getProperties('dev123', ['doorbell_active', 'alarm_message']);
  assert.match(seenUrl, /codes=doorbell_active,alarm_message/);
  assert.equal(seenUrl.includes('%2C'), false);
});

test('isIpcDoorbellAlarmMessage decodes base64 ipc_doorbell', () => {
  const payload = Buffer.from(JSON.stringify({
    v: '5.0',
    cmd: 'ipc_doorbell',
    type: 'image',
  })).toString('base64');
  assert.equal(isIpcDoorbellAlarmMessage(payload), true);
  assert.equal(isIpcDoorbellAlarmMessage(Buffer.from('{"cmd":"motion"}').toString('base64')), false);
});

test('getRingSample edges on newer alarm_message ipc_doorbell', async () => {
  const alarm = Buffer.from(JSON.stringify({ cmd: 'ipc_doorbell', type: 'image' })).toString('base64');
  let time = 1000;
  const fetchImpl = async (url) => {
    if (String(url).includes('/token')) {
      return jsonResponse({ success: true, result: { access_token: 'tok', expire_time: 7200 } });
    }
    // Full shadow (no codes=) — production ring poll path.
    assert.equal(String(url).includes('codes='), false);
    return jsonResponse({
      success: true,
      result: {
        properties: [
          { code: 'doorbell_active', value: '', dp_id: 136, time: 1 },
          { code: 'alarm_message', value: alarm, dp_id: 185, time },
        ],
      },
    });
  };
  const client = new TuyaClient({
    accessId: 'id',
    accessSecret: 'secret',
    deviceId: 'dev123',
    fetchImpl,
    now: () => 1,
  });
  assert.equal((await client.getRingSample()).ringing, false); // baseline
  assert.equal((await client.getRingSample()).ringing, false); // unchanged sticky
  time = 2000;
  const sample = await client.getRingSample();
  assert.equal(sample.ringing, true);
  assert.equal(sample.code, 'alarm_message');
});

test('simulateVisitorRing issues alarm_message ipc_doorbell', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    if (String(url).includes('/token')) {
      return jsonResponse({ success: true, result: { access_token: 'tok', expire_time: 7200 } });
    }
    if (String(url).includes('/properties/issue')) {
      return jsonResponse({ success: true, result: {} });
    }
    return jsonResponse({ success: true, result: { properties: [] } });
  };
  const client = new TuyaClient({
    accessId: 'id',
    accessSecret: 'secret',
    deviceId: 'dev123',
    fetchImpl,
    now: () => 1_700_000_000_000,
  });
  const written = await client.simulateVisitorRing();
  assert.equal(written.code, 'alarm_message');
  assert.equal(isIpcDoorbellAlarmMessage(written.value), true);
  const issue = calls.find((call) => call.url.includes('/properties/issue'));
  assert.ok(issue);
  const body = JSON.parse(issue.body);
  const props = JSON.parse(body.properties);
  assert.equal(isIpcDoorbellAlarmMessage(props.alarm_message), true);
});

test('describeRingWatch summarizes ipc_doorbell alarm_message', async () => {
  const alarm = Buffer.from(JSON.stringify({ cmd: 'ipc_doorbell' })).toString('base64');
  const fetchImpl = async (url) => {
    if (String(url).includes('/token')) {
      return jsonResponse({ success: true, result: { access_token: 'tok', expire_time: 7200 } });
    }
    return jsonResponse({
      success: true,
      result: {
        properties: [
          { code: 'doorbell_active', value: '', dp_id: 136 },
          { code: 'alarm_message', value: alarm, dp_id: 185, time: 99 },
        ],
      },
    });
  };
  const client = new TuyaClient({
    accessId: 'id',
    accessSecret: 'secret',
    deviceId: 'dev123',
    fetchImpl,
    now: () => 1,
  });
  const summary = await client.describeRingWatch();
  assert.match(summary, /ipc_doorbell=yes/);
  assert.match(summary, /time=99/);
});

function jsonResponse(payload) {
  return {
    ok: true,
    async json() {
      return payload;
    },
  };
}
