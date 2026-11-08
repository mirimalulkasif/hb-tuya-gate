# Tuya Gate for Homebridge

Homebridge plugin for a **Tuya Gate Camera / video intercom** in Apple Home.

- **Open the gate** — same action as the Tuya app **Lock Switch** (`accessory_lock` via v2 shadow properties)
- **Ring modes** — **Home / Out / Dormant** switches matching the indoor monitor (who rings / stays silent). This is **not** a security alarm panel.

## What you get in Home

- **Lock** (always) — Unlock opens the gate, then returns to Locked
- **Intercom Home (ring)** / **Intercom Out** / **Intercom Dormant (silent)** — ring mode (default on)
- **Switch** (optional) — momentary open pulse; enable with `showSwitch`

| Switch | Typical behaviour (Tuya app) |
|--------|------------------------------|
| **Intercom Home (ring)** | Indoor monitor rings; app notified |
| **Intercom Out** | Visitor prompted / message; app notified |
| **Intercom Dormant (silent)** | Indoor silent; app can still get the call |

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
| `showModes` | Default `true` — Home / Out / Dormant switches |
| `modeCode` | Optional Tuya DP code. Leave blank to auto-detect |
| `modeHomeValue` / `modeOutValue` / `modeDormantValue` | Exact enum strings if your device differs (`home` / `out` / `dormant`) |
| `showSwitch` | Extra momentary open switch |
| `warmupStream` | Allocate RTSP before open (helps some cameras) |

If mode switches fail, open Tuya **API Explorer → Query properties**, change mode once in the Tuya app, and set `modeCode` (and values) from the property that changed.

## License

Apache-2.0
