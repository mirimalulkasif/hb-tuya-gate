const assert = require('node:assert/strict');
const test = require('node:test');

const { TuyaClient, TuyaApiError, discoverModeProperty } = require('../dist/tuya-client');

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

test('discoverModeProperty prefers call_mode over motion_sensitivity', () => {
  const code = discoverModeProperty([
    { code: 'motion_sensitivity', value: '2', dp_id: 106 },
    { code: 'call_mode', value: '1', dp_id: 151 },
    { code: 'basic_nightvision', value: '0', dp_id: 108 },
  ], { home: '0', out: '1', dormant: '2' });
  assert.equal(code, 'call_mode');
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

function jsonResponse(payload) {
  return {
    ok: true,
    async json() {
      return payload;
    },
  };
}
