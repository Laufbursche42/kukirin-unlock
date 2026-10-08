# Laufbursche KUKIRIN unlock

A static web page that talks to KUKIRIN (Kugoo) e-scooters over Web Bluetooth. Connect, read the live values and - straight from the browser - set the maximum speed, unlock the electronic lock and change ride settings. Nothing to install: no app store, no signing, no developer account. It runs in **Bluefy** on iOS and in **Chrome** or **Edge** on Android or desktop.

> **This is a feasibility study - the speed write is sent, its effect on hardware is unconfirmed.** It exists to show what KUKIRIN's Bluetooth protocol makes possible, not to be a finished product; the protocol was reconstructed from the official app (`com.vehicle.kugooa`, code package `com.kugoo.kugookirin`) and is documented byte for byte. One generic protocol covers every model (the app only swaps UI by the model id it reads back), and the authentication is weak: a legacy cleartext `CODE=` and a mutual-auth handshake whose keys ship inside the public APK. **Reading works:** battery, speed, trip and total mileage, fault code and the model id are decoded and shown. The max-speed write (`+SPDLT`) is sent on request, but whether the firmware accepts a value above the legal cap sits in the controller and cannot be proven from the app: it must be tested on the device. Two honest gaps are called out in the page itself: gear de-restriction (`+MDMX`) is only ever **read** by the app, never written, so it is not offered; and the mutual-auth (`+PM`) response cannot be reproduced here because the key constants are not in the protocol file. Error-free operation is not promised and there is no warranty of any kind. Whatever you do with it, you do at your own risk - read the [Legal](#legal) section before you connect a scooter.

**Open the web app: [laufbursche42.github.io/kukirin-unlock](https://laufbursche42.github.io/kukirin-unlock/)**

Or run it yourself, no build step and no dependencies: clone the repo and serve the folder over a local HTTP server. Opening `index.html` directly as a `file://` URL will not work, the page fetches its own documents and browsers block that over `file://`.

```
git clone https://github.com/Laufbursche42/kukirin-unlock.git
cd kukirin-unlock
python -m http.server 8000
```

Any static server works. With Node installed, this does the same job:

```
npx serve .
```

Then open the printed address in a browser that supports Web Bluetooth.

**Guide: [Deutsch](GUIDE.de.md) | [English](GUIDE.en.md)** covers everything step by step, from connecting to the first send.

## What it does

- **Live values** - model (resolved from the `imoogoo-<code>` id), connection profile, battery, speed, trip and total mileage, fault code and firmware version.
- **Speed** - an unlock/lock toggle (open value vs eKFV value) plus an exact km/h set. Writes the `+SPDLT` register. No limit comes back over Bluetooth, so the toggle flips manually.
- **Electronic lock** - unlock via `+LOCK=0` (the only generically proven lock command).
- **More settings** - light, unit (km/mi), zero-start protection, cruise, speed limiter, brake force, launch force, display brightness, backlight timeout.
- **Expert** - send a raw frame verbatim, build an `AA .. XOR BB` frame from an opcode plus payload, or send a raw `+AT` text command.
- **Shortcut** - a home-screen link that unlocks or locks in a single tap.

## Protocol (proven)

- Three interchangeable 128-bit GATT families (`9546bdc0..` / `b1b99ca0..` / `331023c0..`); the one whose write characteristic is discovered sets `CONNECT_TYPE`. Notifications via CCCD `0x2902`.
- Two encodings on the one write characteristic: ASCII/AT text (`sendString`) and binary `AA <op> <args> <XOR> BB`, where the checksum is the 8-bit XOR of every byte from `AA` through the last payload byte.
- TX proven: `GETDEVID`, `+VER?`, `+SPDLT=<kmh>`, `+SPLT=0/1`, `+LOCK=0`, `+CRZE`, `+EBKF`, `+BSTF`, `+LUMA`, `+TIM`, and the binary `AA0706` (headlight), `AA1906` (unit), `AA1206` (zero-start).
- RX telemetry (all `AA..BB`): `0xF1`/`0xA1` battery + speed, `0xA2` trip + total, `0xA5` fault code.

## Honesty

Device-untested by design - you test on your own scooter, which is exactly the point of a public tool. The exact status-bit offsets for lock / light / unit / gear in the `A1`/`A4` frames are not exposed by the app source, so they are shown only as raw frames and never fabricated into tiles. An echo in the log means the scooter **accepted** the frame; only the new behaviour on a test ride proves it actually took effect.

## Legal

License: PolyForm Noncommercial, see [License](LICENSE.md). Privacy: nothing leaves your device, see [Privacy](PRIVACY.md). Trademarks: KUKIRIN is a trademark of its respective owner, this project is independent, see [Trademarks](TRADEMARKS.md).

Source: https://github.com/Laufbursche42/kukirin-unlock
