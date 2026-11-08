# Tuya Gate for Homebridge

Homebridge plugin for a **Tuya Gate Camera / video intercom** in Apple Home.

- **Open the gate** — same action as the Tuya app **Lock Switch** (`accessory_lock` via v2 shadow properties)
- **Ring modes** — **At Home / Not at Home / Dormant** (same as the Tuya app). This is **not** a security alarm panel.

## What you get in Home

- **Lock** (always) — Unlock opens the gate, then returns to Locked
- **At Home** / **Not at Home** / **Dormant** — ring mode (default on)
- **Switch** (optional) — momentary open pulse; enable with `showSwitch`

| Switch | Typical behaviour (Tuya app) |
|--------|------------------------------|
| **At Home** | Indoor monitor rings; app notified |
| **Not at Home** | Visitor prompted / message; app notified |
| **Dormant** | Indoor silent; app can still get the call |

Only one mode switch should stay on at a time.

## Requirements

- Tuya IoT Cloud project with **IoT Core** trial active
- Gate Camera linked under Devices
- Access ID, Access Secret, device ID

## Install

```sh
sudo npm install -g homebridge-tuya-gate
```

Or from GitHub:

```sh
sudo npm install -g github:mirimalulkasif/hb-tuya-gate
```

Restart the plugin / child bridge, then configure **Tuya Gate**.

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
      "showSwitch": false,
      "showModes": true,
      "warmupStream": true
    }
  ]
}
```

| Option | Meaning |
|--------|---------|
| `showModes` | Default `true` — At Home / Not at Home / Dormant |
| `modeCode` | Optional Tuya DP code. Leave blank to auto-detect |
| `modeHomeValue` / `modeOutValue` / `modeDormantValue` | Defaults `at_home` / `not_at_home` / `dormant` — override if Query properties shows different strings |
| `showSwitch` | Extra momentary open switch |
| `warmupStream` | Allocate RTSP before open (helps some cameras) |

### If modes don’t change on the device

1. Restart the plugin and check logs for `mode-like properties: …` and `device confirmed mode …` (or an error).
2. Modes are sometimes on the **indoor monitor** device, not the Gate Camera — set **Mode device ID** to that id.
3. Or in Tuya **API Explorer → Query properties**, change At Home / Not at Home / Dormant in the app, note which `code`/`value` changed, and set **Mode DP code** + the three values.

## License

Apache-2.0
