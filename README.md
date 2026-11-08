# Tuya Gate for Homebridge

Homebridge plugin for a **Tuya Gate Camera / video intercom** in Apple Home.

- **Open the gate** — same action as the Tuya app **Lock Switch** (`accessory_lock` via v2 shadow properties)
- **Ring notifications** — a **motion sensor** trips when someone rings so Home can notify you
- **Ring modes** — optional **At Home / Not at Home / Dormant** (only if a cloud DP exists)

## What you get in Home

- **Lock** (always) — Unlock opens the gate, then returns to Locked
- **Ring** motion sensor (default on) — trips on visitor ring
- **At Home** / **Not at Home** / **Dormant** — optional (`showModes`)
- **Switch** (optional) — momentary open pulse (`showSwitch`)

### Notify when someone rings

**Required once in Tuya IoT (cloud project):**

1. Open the project → **Cloud** → **Message Service**
2. Turn **Message Service** **On** (Production)
3. Optional for debugging: add the gate as a **Test Device** and set plugin `messageEnv` to `test`

Without Message Service, rings are push-only events and cloud polling almost always misses them — the motion sensor will stay quiet.

Then in Home:

1. **Automation** → **Create New Automation**
2. **A Sensor Detects Something** → **Open Gate Ring**
3. **Detects Motion** → **Send Notification**

## Requirements

- Tuya IoT Cloud project with **IoT Core** trial active
- Gate Camera linked under Devices
- Access ID, Access Secret, device ID

## Install / update

Use the Homebridge **Plugins** page (search `homebridge-tuya-gate` → Install / Update). Publish updates to npm; do not install from GitHub on the Pi.

## Configuration

```json
{
  "platforms": [
    {
      "platform": "TuyaGate",
      "name": "Open Gate",
      "accessId": "YOUR_ACCESS_ID",
      "accessSecret": "YOUR_ACCESS_SECRET",
      "deviceId": "bf3f24408fb356db59qioh",
      "region": "eu",
      "lockCode": "accessory_lock",
      "showRingSensor": true,
      "ringCode": "doorbell_active",
      "showSwitch": false,
      "showModes": false,
      "warmupStream": true
    }
  ]
}
```

| Option | Meaning |
|--------|---------|
| `showRingSensor` | Default `true`. Motion sensor for visitor rings |
| `ringPush` | Default `true`. Subscribe to Tuya Message Service (needed for reliable rings) |
| `messageEnv` | `prod` (default) or `test` |
| `ringCode` | Default `doorbell_active` |
| `ringPollSeconds` | Default `2` (backup poll; push is primary) |
| `ringHoldSeconds` | Default `20`. How long motion stays active after a ring |
| `showModes` | Default `false`. Enable only after you find a cloud DP for mode |
| `modeCode` | Required when `showModes` is on |
| `showSwitch` | Extra momentary open switch |
| `warmupStream` | Allocate RTSP before open (helps some cameras) |

### If modes don’t change on the device

Many kits keep **At Home / Not at Home / Dormant** only on the indoor monitor. If Query properties does **not** change when you switch mode, leave `showModes` off.

### If ring never trips

1. Confirm Message Service is **Enabled** and logs show `Ring push: Message Service connected`
2. When you ring, logs should show `visitor ringing (…/push)`
3. If push errors about the consumer, close the Tuya Console “Test Channel” page (only one consumer per Access ID)
4. Fallback: Query properties while ringing — if `doorbell_pic` gets a value, ring detection should still fire once push is on

## License

Apache-2.0
