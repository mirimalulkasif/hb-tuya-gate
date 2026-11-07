const assert = require('node:assert/strict');
const test = require('node:test');

const { TuyaClient, TuyaApiError } = require('../dist/tuya-client');

test('openGate requests a token then sends accessory_lock true', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });
    if (String(url).includes('/v1.0/token')) {
      return jsonResponse({
        success: true,
        result: { access_token: 'tok', expire_time: 7200 },
      });
    }
    return jsonResponse({ success: true, result: true });
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

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /openapi\.tuyaeu\.com\/v1\.0\/token/);
  assert.match(calls[1].url, /\/v1\.0\/devices\/dev123\/commands/);
  assert.equal(calls[1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].body), {
    commands: [{ code: 'accessory_lock', value: true }],
  });
  assert.equal(calls[1].headers.access_token, 'tok');
  assert.ok(calls[1].headers.sign);
});

test('failed command raises TuyaApiError', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/token')) {
      return jsonResponse({
        success: true,
        result: { access_token: 'tok', expire_time: 7200 },
      });
    }
    return jsonResponse({ success: false, code: 2001, msg: 'device offline' });
  };

  const client = new TuyaClient({
    accessId: 'id',
    accessSecret: 'secret',
    deviceId: 'dev123',
    fetchImpl,
    now: () => 1,
  });

  await assert.rejects(() => client.openGate(), (error) => {
    assert.ok(error instanceof TuyaApiError);
    assert.match(error.message, /device offline/);
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
