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

1. Open the **Home** app → **Automation** → **Create New Automation**
2. Choose **A Sensor Detects Something** → select **Open Gate Ring** (or your gate name + Ring)
3. **Detects Motion** → Next → **Send Notification**: *Someone is at the gate*

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
| `ringCode` | Default `doorbell_active`. Change only if Query properties shows another ring DP |
| `ringPollSeconds` | Default `2`. How often to poll Tuya for a ring |
| `ringHoldSeconds` | Default `20`. How long motion stays active after a ring |
| `showModes` | Default `false`. Enable only after you find a cloud DP for mode |
| `modeCode` | Required when `showModes` is on |
| `showSwitch` | Extra momentary open switch |
| `warmupStream` | Allocate RTSP before open (helps some cameras) |

### If modes don’t change on the device

Many kits keep **At Home / Not at Home / Dormant** only on the indoor monitor. If Query properties does **not** change when you switch mode, leave `showModes` off.

### If ring never trips

In Tuya IoT → Device → **Query properties**, press the outdoor call button and note which property changes (often `doorbell_active`). Set that as `ringCode`. Very short rings can be missed with cloud polling; lower `ringPollSeconds` to `1` if needed.

## License

Apache-2.0
