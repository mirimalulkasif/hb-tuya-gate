# Tuya Gate for Homebridge

Homebridge plugin that opens a **Tuya Gate Camera / video intercom** from Apple Home.

It sends the same command the Tuya app uses for **Lock Switch**: pulse `accessory_lock` (`true`). Your device (DP **148**) opens the gate and returns to locked on its own.

## What you get in Home

- **Lock** (always) — Unlock opens the gate, then returns to Locked
- **Switch** (optional) — momentary control for the same open pulse; enable with `showSwitch`

## Requirements

- A Tuya IoT Cloud project with **IoT Core** trial active (extend it when it expires)
- App account linked so the Gate Camera appears under Devices
- Access ID, Access Secret, and device ID

## Install

```sh
sudo npm install -g homebridge-tuya-gate
```

Until published on npm:

```sh
sudo npm install -g github:mirimalulkasif/hb-tuya-gate
```

Restart Homebridge, then add **Tuya Gate** from the Plugins page.

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
      "showSwitch": false
    }
  ]
}
```

| Option | Meaning |
|--------|---------|
| `showSwitch: false` (default) | Only the **Lock** appears in Home |
| `showSwitch: true` | **Lock** and a momentary **Switch** (same open command) |

`region` must match the project data center (`eu` for `openapi.tuyaeu.com`).

If you have a second lock channel, you can try `"lockCode": "ipc_c_lock"` (DP 232).

## Automations

In the Home app:

- Unlock **Open Gate**, or (if enabled) turn on **Open Gate Switch**
- Then: turn on a light, send a notification, run a Shortcut for Siri announce, etc.

## Development

```sh
npm install
npm test
```

## License

Apache-2.0
