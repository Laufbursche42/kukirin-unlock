# Guide

> **Important for error reports:** switch on the **Diagnostic log** at the bottom of the page *before* you connect to the scooter. Only then is the full connection handshake captured - and those are exactly the lines we need in a [ticket](https://github.com/Laufbursche42/Laufbursche42/issues) to reproduce a problem.

## What you need
- A KUKIRIN (Kugoo) e-scooter.
- A phone or computer with **Chrome**, **Edge**, or on iOS **Bluefy**. Safari and Firefox cannot do Web Bluetooth.

## Connecting
1. Turn on Bluetooth and wake the scooter.
2. Tap **Connect** and pick the scooter from the list.
3. If it is not listed, tick **Show all devices** and try again. The page probes three GATT profiles and takes the one whose write characteristic is present.
4. If your dashboard still wants the old cleartext code, type it into the **Pairing code** field before connecting. If you have none, leave it empty.
5. Once connected, the live-values, lock, speed and settings cards appear.

## Reading live values
The scooter streams its status continuously and, on request, its model code (imoogoo-...), which the page translates into the model name. Each tile appears once its value has arrived; a dash just means that value has not come in yet. Below the tiles, **All received frames** lets you follow the raw data per opcode. Lock, light and unit live in status bits and are therefore shown only as raw data, not as their own tile.

## Setting the speed
- **Unlock** writes the value from the **Open** field, **Lock** writes the **eKFV / legal** field, both into the +SPDLT register.
- **Set exact** writes any km/h value directly.
- No limit value comes back over Bluetooth, so the button flips manually between Unlock and Lock on each press.
- Important: an echo in the log only means the scooter accepted the frame. Whether the firmware accepts more than the legally allowed km/h is something you must test on your own device. Gear de-restriction (+MDMX) is only read by the app, never written, so the page does not offer it.

## Electronic lock
In the **Electronic lock** card you release the lock (+LOCK=0). Locking itself goes through a model-specific password frame and is deliberately not reproduced here.

## More settings
Light, unit (km/mi), zero-start protection, cruise, speed limiter, brake force, launch force, display brightness and backlight timeout. These are write-only commands; the scooter does not report their state back.

## Advanced settings (engine level)
**Send a raw frame** sends your hex bytes unchanged. **Build a frame** takes an opcode and payload and adds the AA marker and XOR checksum for you. **AT text command** sends a +CMD string as UTF-8.

## Shortcuts
Copy the link to your home screen, then one tap unlocks or locks directly. On iOS via Bluefy, and the scooter must have been connected normally once before.

## If something does not work
- Cannot connect? Check that the browser supports Web Bluetooth, Bluetooth is on and the scooter is awake. Retry with **Show all devices**.
- Nothing happens after a command? Check the log: if it says "sent", the page wrote the frame. Whether the firmware acted on it only shows in the scooter's behaviour.
- If the scooter wants the newer mutual authentication (+PM), this page cannot complete it, because the keys it needs are not exposed in the protocol.
- **Diagnostics: list all devices** in the log area shows every Bluetooth service of a device without writing anything - useful for support.

## Contribute
Want to find out if and how tuning works on your scooter? Test this tool on your own vehicle and open a ticket on [GitHub](https://github.com/Laufbursche42/Laufbursche42/issues) - with your model and what worked (or did not). That way we figure out together what is possible on which model.
