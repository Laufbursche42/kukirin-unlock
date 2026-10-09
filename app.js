'use strict';
/*
 * KUKIRIN Tuning - Web Bluetooth. Implements the BLE protocol proven from the official app
 * com.vehicle.kugooa (code package com.kugoo.kugookirin, 2.2.4). Raw Android BLE, no third-party lib.
 * Proven (app_side, code-verified): three interchangeable 128-bit GATT families (CONNECT_TYPE 1/2/3,
 * picked by which write char is discovered, LFBluetootService.java:68-77,204-219; CCCD 0x2902), two
 * coexisting encodings on the one write char - ASCII/AT text (sendString) and binary AA <bytes> <XOR> BB
 * (sendHexString, XOR = 8-bit xor of AA..last payload byte). TX proven: GETDEVID (model id -> imoogoo-<code>),
 * +VER?, +SPDLT=<kmh> max-speed set, +SPLT=0/1 limiter, +LOCK=0 unlock, +CRZE/+EBKF/+BSTF/+LUMA/+TIM,
 * AA0706 headlight, AA1906 unit, AA1206 zero-start. Telemetry (device->app, AA..BB): F1/A1 battery+speed,
 * A2 trip+ODO, A4 byte7 nibble lock+light, A1-11B byte7 nibble gear, A5 fault ASCII (all offsets read
 * from VehicleFragment.java:807-1024).
 * Device-side unknowns stay gated: whether firmware honors +SPDLT above the legal cap; the 11-byte A1
 * unit bit (not decoded reliably, left out of the UI); and the mutual-auth (+PM) response, whose keys are
 * deliberately not carried here - so if a dashboard demands mutual auth this page cannot complete it.
 * Writes are gated; the risky ones are confirm-boxed, and an echo only means "accepted".
 */

// Pre-commit cache-buster auto-bumps BUILD and every ?v= on any web-asset change.
const BUILD = 'v5';

// --------------------------- UUIDs (LFBluetootService.java:68-77; Web Bluetooth wants lowercase) ---------------------------
// Three interchangeable families. CONNECT_TYPE is set by which write characteristic is discovered on the
// connected dashboard (per physical meter, not per app-model). All share the AA..BB + ASCII protocol.
const PROFILES = [
  { type: 1, service: '9546bdc0-60ba-11e9-8647-0002a5d5c51b', write: '9546bdc1-60ba-11e9-8647-0002a5d5c51b', notify: '9546bdc4-60ba-11e9-8647-0002a5d5c51b' },
  { type: 2, service: 'b1b99ca0-98e7-11e9-80fe-0002a5d5c51b', write: 'b1b99ca1-98e7-11e9-80fe-0002a5d5c51b', notify: 'b1b99ca4-98e7-11e9-80fe-0002a5d5c51b' },
  { type: 3, service: '331023c0-fdcb-11e8-8eb2-0002a5d5c51b', write: '331023c1-fdcb-11e8-8eb2-0002a5d5c51b', notify: '331023c4-fdcb-11e8-8eb2-0002a5d5c51b' }
];
const CANDIDATE_SERVICES = PROFILES.map(p => p.service);   // probed in order at connect

// --------------------------- helpers ---------------------------
const $ = (id) => document.getElementById(id);
const hex = (arr) => Array.from(arr, b => (b & 0xff).toString(16).padStart(2, '0').toUpperCase()).join(' ');
const short = (u) => String(u || '').slice(0, 8).toUpperCase();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LS = { THEME: 'kukirin_theme', OPEN: 'kukirin_open', EKFV: 'kukirin_ekfv', PUBLOG: 'kukirin_publog', DEV: 'kukirin_device', CODE: 'kukirin_code' };

let dev = null, server = null, ch = null, notifyCh = null, busy = false;
let activeProfile = null, activeWriteUuid = null, activeNotifyUuid = null;
let connected = false;

// live device state, rebuilt from the push frames + ASCII replies (the tiles read from this)
const S = {
  model: null, modelCode: null, connType: null, fw: null,
  battPct: null, speed: null, trip: null, odo: null, gear: null, lock: null, light: null, fault: null
};
function resetState() { for (const k of Object.keys(S)) S[k] = null; }

// --------------------------- log (eg-unlock redaction pipeline: scrub secrets + anonymize PII) ---------------------------
let logBuffer = [];   // { raw, cls }
let publicLog = true; // anonymize device name/id/MAC on display/copy/save (default on)
let diag = false;     // verbose diagnostics (default off)
function redact(text) {
  let s = String(text);
  if (dev && dev.id) s = s.split(dev.id).join('[redacted-id]');
  s = s.replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, '[redacted-mac]');
  s = s.replace(/\b(secret|token|key|aes|pwd|password|pin|mac|serial|vin|uid|imei)\b(\s*[:=]\s*)("?)([^\s",]+)\3/gi,
    (m, k, sep) => k + sep + '[redacted]');
  s = s.replace(/\b[0-9A-Fa-f]{16,}\b/g, '[redacted-hex]');
  return s;
}
// Unconditional secret scrubber, runs at the source before the buffer (independent of the Public Log toggle).
function maskSecrets(text) {
  let s = String(text);
  s = s.replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[redacted-jwt]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
  s = s.replace(/\b(access[_-]?token|refresh[_-]?token|token|jwt|password|passwd|pwd|secret|code|otp)\b(\s*[:=]\s*)("?)([^\s",}]+)\3/gi,
    (m, k, sep) => k + sep + '***');
  return s;
}
function anonymize(s) {
  if (!publicLog) return String(s).replace(/\x01/g, '');
  return redact(String(s).replace(/\x01[^\x01]*\x01/g, 'XX').replace(/\x01/g, ''));
}
function logLine(cls, text) {
  const safe = '[' + new Date().toTimeString().slice(0, 8) + '] ' + maskSecrets(text);
  logBuffer.push({ raw: safe, cls: cls });
  const el = $('log'); if (!el) return;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = anonymize(safe) + '\n';
  el.appendChild(span); el.scrollTop = el.scrollHeight;
}
function renderLog() {
  const el = $('log'); if (!el) return;
  el.textContent = '';
  for (const e of logBuffer) { const span = document.createElement('span'); if (e.cls) span.className = e.cls; span.textContent = anonymize(e.raw) + '\n'; el.appendChild(span); }
  el.scrollTop = el.scrollHeight;
}
function logText() { return logBuffer.map(e => anonymize(e.raw)).join('\n'); }
const logTx = (b) => logLine('log-tx', '>>> ' + short(activeWriteUuid) + ' | ' + hex(b));
const logRx = (b) => logLine('log-rx', '<<< ' + short(activeNotifyUuid) + ' | ' + hex(b));
const logSys = (t) => logLine('', '--- ' + t);
const logErr = (t) => logLine('log-err', '!!! ' + t);
const logDiag = (t) => { if (diag) logLine('', '... ' + t); };
// CRLF on Windows so the copied log pastes cleanly into Notepad (nv osNewline polish).
function osNewline() { return (navigator.platform || '').toLowerCase().indexOf('win') === 0 ? '\r\n' : '\n'; }
function saveLog() {
  try {
    const blob = new Blob([logText().split('\n').join(osNewline())], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'laufbursche42-kukirin-log.txt';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    logSys('log saved');
  } catch (e) { logErr('save failed: ' + (e && e.message ? e.message : e)); }
}
function logDiagnosticHeader() {
  logLine('', '=== kukirin-unlock diagnostic ===');
  logLine('', 'build: ' + BUILD);
  logLine('', 'time: ' + new Date().toISOString());
  logLine('', 'userAgent: ' + (navigator.userAgent || '?'));
  logLine('', 'platform: ' + (navigator.platform || '?'));
  logLine('', 'webBluetooth: ' + (navigator.bluetooth ? 'yes' : 'no'));
  logLine('', 'protocol self-test: ' + (FRAME_OK ? 'OK' : 'FAILED'));
  logLine('', '================================');
}

// =========================================================================================
//  VERIFIED PROTOCOL CORE (code-proven from com.kugoo.kugookirin; self-test below runs at load)
// =========================================================================================
// Binary frame: [0]=0xAA | [1..]=payload (op + args) | [N-2]=XOR | [N-1]=0xBB.
// checksum = 8-bit XOR of every byte from 0xAA through the last payload byte (YiHuoUtil.xor / BytesUtils.xor).
// Verified against literal frames in the APK: headlight AA070601AABB/AA070600ABBB, zero-start AA120601BFBB/
// AA120600BEBB, unit AA190601B4BB/AA190600B5BB, kgkrn05 gear AA03040188010025BB.
function aaXor(bytes) { let x = 0; for (const b of bytes) x ^= (b & 0xff); return x & 0xff; }
// payload = bytes BETWEEN the AA marker and the checksum (i.e. op + args).
function buildHex(payload) {
  const body = [0xaa, ...(payload || []).map(b => b & 0xff)];
  return [...body, aaXor(body), 0xbb];
}
// strict validator: AA ... XOR BB, XOR over AA..last payload byte
function validFrame(f) {
  if (f.length < 5 || f[0] !== 0xaa || f[f.length - 1] !== 0xbb) return false;
  return aaXor(f.slice(0, f.length - 2)) === f[f.length - 2];
}
// ASCII/AT text command -> UTF-8 bytes (LFBluetootService.sendString)
const enc = new TextEncoder();
function asciiBytes(str) { return Array.from(enc.encode(String(str))); }

// RX parsers (telemetry AA..BB, VehicleFragment broadcast receiver :807-1024)
const clampPct = (v) => Math.max(0, Math.min(100, v & 0xff));
const CMD_LABEL = { 0xf1: 'battery/speed', 0xa1: 'status', 0xa2: 'trip/odo', 0xa4: 'lock/light', 0xa5: 'fault' };
function parseFrame(f) {
  const cmd = f[1], n = f.length;
  if (cmd === 0xf1 && n >= 6) {               // 6B battery% + speed (:909-934)
    S.battPct = clampPct(f[2]); S.speed = f[3] & 0xff;
  } else if (cmd === 0xa1 && n >= 8) {        // A1 battery(byte3 clamp) + speed(byte4<<8|byte5) (:867-905,:936-1023)
    S.battPct = clampPct(f[3]); S.speed = ((f[4] & 0xff) << 8) | (f[5] & 0xff);
  } else if (cmd === 0xa2 && n >= 10) {       // A2 trip(byte3<<8|byte4) + ODO(byte5<<16|byte6<<8|byte7)
    S.trip = ((f[3] & 0xff) << 8) | (f[4] & 0xff);
    S.odo = ((f[5] & 0xff) << 16) | ((f[6] & 0xff) << 8) | (f[7] & 0xff);
  } else if (cmd === 0xa4 && n >= 10) {       // 10B A4: byte7 nibbles -> light(high)/lock(low) (:871-888)
    const lo = f[7] & 0x0f, hi = (f[7] >> 4) & 0x0f;   // hexString10 of byte7: substring(1,2)=lock, substring(0,1)=light
    if (lo === 0) S.lock = false; else if (lo === 1) S.lock = true;
    if (hi === 0) S.light = false; else if (hi === 1) S.light = true;
  } else if (cmd === 0xa5) {                  // 12B fault/error code ASCII (:812-833)
    const body = f.slice(2, n - 2);
    S.fault = new TextDecoder().decode(Uint8Array.from(body)).replace(/\0+/g, '').trim();
  }
  // 11B A1 also carries gear in byte7 low nibble (readable gear switch): 1..4 -> gear.
  if (cmd === 0xa1 && n === 11) { const g = f[7] & 0x0f; if (g >= 1 && g <= 4) S.gear = g; }
  // The 11B A1 unit bit is not decoded reliably, so it stays out of the UI; the raw A1 frame is still
  // visible under "all frames". kug11/kug19 report speed scaled *1.167 (cap 450).
  if ((S.model === 'kug11' || S.model === 'kug19') && S.speed != null) S.speed = Math.min(450, Math.round(S.speed * 1.167));
}

// model registry: GETDEVID reply "imoogoo-<code>" -> canonical type (getVehicleType, 49 codes -> 32 types)
const MODELS = {
  fmi01: 'fmi01', fmi02: 'fmi02', kug01: 'MERCURY3',
  kug02: 's1', kug08: 's1', kug09: 's1', kugst02: 's1', kugst03: 's1',
  kug03: 'kug03', kug04: 'b1', kug05: 'b205', kug07: 'c2', kug10: 's2',
  kug11: 'kug11', kug12: 'kug12', kug13: 'b11', kugst04: 'b11', kug17: 'b17',
  kug18: 's3', kug19: 'kug19', kug20: 'kug20', vyg01: 'voyager',
  kgkrn02: 'kgkrn02', kgkrn03: 'kgkrn03', kgkrn04: 'kgkrn04',
  kgkrn05: 'kgkrn05', kgkrn06: 'kgkrn05', kgkrn11: 'kgkrn05', kgkrn12: 'kgkrn05',
  kgkrn07: 'kgkrn07', kgkrn08: 'kgkrn07', kgkrn17: 'kgkrn07', kgkrn18: 'kgkrn07',
  kgkrn19: 'kgkrn07', kgkrn20: 'kgkrn07', kgkrn21: 'kgkrn07', kgkrn30: 'kgkrn07', kgkrn34: 'kgkrn07',
  kgkrn10: 'kgkrn10', kgkrn14: 'kgkrn14', kgkrn15: 'kgkrn15', kgkrn16: 'kgkrn16',
  kgkrn23: 'kgkrn23', kgkrn25: 'kgkrn25', kgkrn29: 'kgkrn29', kgkrn44: 'kgkrn29',
  kgkrn40: 'kgkrn40', kugst01: 'b2', kg01: 'h6'
};

// load-time self-test: builder must match known-good APK literals, every built frame must re-validate
const FRAME_OK = (function () {
  const eq = (a, b) => a.length === b.length && a.every((v, i) => (v & 0xff) === (b[i] & 0xff));
  const t1 = eq(buildHex([0x07, 0x06, 0x01]), [0xaa, 0x07, 0x06, 0x01, 0xaa, 0xbb]);   // headlight on
  const t2 = eq(buildHex([0x07, 0x06, 0x00]), [0xaa, 0x07, 0x06, 0x00, 0xab, 0xbb]);   // headlight off
  const t3 = eq(buildHex([0x19, 0x06, 0x00]), [0xaa, 0x19, 0x06, 0x00, 0xb5, 0xbb]);   // unit toggle
  const t4 = eq(buildHex([0x03, 0x04, 0x01, 0x88, 0x01, 0x00]), [0xaa, 0x03, 0x04, 0x01, 0x88, 0x01, 0x00, 0x25, 0xbb]); // kgkrn05 gear1
  return t1 && t2 && t3 && t4 && validFrame(buildHex([0x12, 0x06, 0x01])) && validFrame(buildHex([0x07, 0x06, 0x01]));
})();

// --------------------------- tiles ---------------------------
const TILE_IDS = ['t-model', 't-conntype', 't-batt', 't-speed', 't-gear', 't-trip', 't-odo', 't-lock', 't-light', 't-fault', 't-fw'];
function setTile(id, val) { const el = $(id); if (el) el.textContent = (val == null ? '-' : val); }
function resetTiles() { TILE_IDS.forEach(id => setTile(id, null)); }
function onOff(v) { return v == null ? null : (v ? t('valOn') : t('valOff')); }
function refreshTiles() {
  setTile('t-model', S.model == null ? null : (S.modelCode && S.modelCode !== S.model ? S.model + ' (' + S.modelCode + ')' : S.model));
  setTile('t-conntype', S.connType == null ? null : ('Typ ' + S.connType));
  setTile('t-batt', S.battPct == null ? null : S.battPct + ' %');
  setTile('t-speed', S.speed == null ? null : S.speed + ' km/h');
  setTile('t-gear', S.gear == null ? null : String(S.gear));
  setTile('t-trip', S.trip == null ? null : String(S.trip));
  setTile('t-odo', S.odo == null ? null : String(S.odo));
  setTile('t-lock', S.lock == null ? null : (S.lock ? t('valLocked') : t('valOpen')));
  setTile('t-light', onOff(S.light));
  setTile('t-fault', S.fault == null ? null : (S.fault === '' || S.fault === '0' ? t('valNone') : String(S.fault)));
  setTile('t-fw', S.fw == null ? null : String(S.fw));
}

// last frame bytes per cmd byte (kept so disconnect can clear decode state)
const seenFrames = {};

// --------------------------- i18n ---------------------------
let lang = 'de';
function table() { return (window.I18N && window.I18N[lang]) || {}; }
function t(key) { const v = table()[key]; return (typeof v === 'string') ? v : ''; }
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach(n => { const v = t(n.getAttribute('data-t')); if (/[<&]/.test(v)) n.innerHTML = v; else n.textContent = v; }); // scan-ok: curated i18n values with markup (banner/disclaimer links); own table, not user input
  document.querySelectorAll('[data-t-ph]').forEach(n => { const v = t(n.getAttribute('data-t-ph')); if (v) n.setAttribute('placeholder', v); });
  ['GUIDE', 'README', 'LICENSE', 'PRIVACY', 'TRADEMARKS'].forEach(name => { const el = $('link-' + name.toLowerCase()); if (el) el.href = docFile(name); });
  { const el = $('langs'); if (el) el.setAttribute('aria-label', t('langGroup')); }
  { const el = $('build-ver'); if (el) el.textContent = t('buildLabel') + ' ' + BUILD; }
  document.querySelectorAll('#langs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  refreshTiles(); updateSpeedUI();
  { const el = $('status'); setStatus(el ? el.dataset.state : 'disconnected'); }
  { const dark = document.documentElement.getAttribute('data-theme') !== 'light'; const el = $('btn-theme'); if (el) { el.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); el.title = el.getAttribute('aria-label'); } }
}
function initLangSwitch() { document.querySelectorAll('#langs button').forEach(b => b.addEventListener('click', () => { lang = b.dataset.lang; applyLang(); })); }

// --------------------------- theme ---------------------------
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const b = $('btn-theme');
  if (b) { b.textContent = dark ? '\u2600' : '\u263E'; b.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); b.title = b.getAttribute('aria-label'); }
  try { localStorage.setItem(LS.THEME, dark ? 'dark' : 'light'); } catch (e) {}
}
function initTheme() {
  let saved = null; try { saved = localStorage.getItem(LS.THEME); } catch (e) {}
  applyTheme(saved !== 'light');
  const b = $('btn-theme'); if (b) b.addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'light'));
}

// --------------------------- status ---------------------------
function statusLabel(s) {
  const map = { disconnected: 'stDisconnected', connecting: 'stConnecting', linking: 'stLinking', connected: 'stConnected', 'no-service': 'stNoService' };
  return t(map[s] || 'stDisconnected') || s;
}
function setStatus(s) {
  const el = $('status'); if (el) { el.dataset.state = s; el.textContent = statusLabel(s); }
  const cb = $('btn-conn');
  if (cb) { const on = (s === 'connecting' || s === 'linking' || s === 'connected'); cb.textContent = on ? t('btnDisconnect') : t('btnConnect'); cb.dataset.act = on ? 'disconnect' : 'connect'; }
}
function setControlsEnabled(on) {
  // cards hidden until connected (header/intro/connect/shortcut/log stay visible)
  ['live-card', 'batt-card', 'more-card', 'raw-card'].forEach(id => { const el = $(id); if (el) el.hidden = !on; });
  document.querySelectorAll('[data-conn]').forEach(e => { e.disabled = !on; });
}

// --------------------------- connect (filter on the 3 service families; 4x retry; profile auto-resolve) ---------------------------
async function connect() {
  if (!navigator.bluetooth) { logErr(t('errNoWebBt')); return; }
  try {
    setStatus('connecting');
    const showAll = ($('showall') || {}).checked;
    const opts = showAll
      ? { acceptAllDevices: true, optionalServices: CANDIDATE_SERVICES }
      : { filters: CANDIDATE_SERVICES.map(s => ({ services: [s] })), optionalServices: CANDIDATE_SERVICES };
    dev = await navigator.bluetooth.requestDevice(opts);
    dev.addEventListener('gattserverdisconnected', onDisconnected);
    try { localStorage.setItem(LS.DEV, dev.id); } catch (e) {}
    logSys('device: \x01' + (dev.name || '(no name)') + '\x01');
    setStatus('linking');
    await connectGatt();
    setStatus('connected'); connected = true;
    setControlsEnabled(true);
    { const el = $('devinfo'); if (el) el.textContent = t('devPrefix') + ' \x01' + (dev.name || 'KUKIRIN') + '\x01' + ' (' + t('connTypeLabel') + ' ' + S.connType + ')'; }
    logSys('connected, CONNECT_TYPE ' + S.connType + ', subscribed to ' + short(activeNotifyUuid));
    await afterConnectInit();
  } catch (e) {
    logErr('connect failed: ' + (e && e.message ? e.message : e));
    connected = false; setStatus('disconnected'); setControlsEnabled(false);
  }
}
// tolerate the Android discovery race (nv 4x retry): service can be briefly absent right after link.
async function connectGatt() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      server = await dev.gatt.connect();
      const prof = await resolveProfile(server);
      if (!prof) { setStatus('no-service'); throw new Error('KUKIRIN service (9546/b1b99c/331023) not found'); }
      activeProfile = prof; S.connType = prof.type; activeWriteUuid = prof.write; activeNotifyUuid = prof.notify;
      const svc = await server.getPrimaryService(prof.service);
      ch = await svc.getCharacteristic(prof.write);
      notifyCh = await svc.getCharacteristic(prof.notify);
      await notifyCh.startNotifications();
      notifyCh.addEventListener('characteristicvaluechanged', onCharValue);
      return;
    } catch (e) {
      lastErr = e; logDiag('connect attempt ' + attempt + ' failed: ' + (e && e.message ? e.message : e));
      try { if (dev.gatt.connected) dev.gatt.disconnect(); } catch (_) {}
      await sleep(400);
    }
  }
  throw lastErr || new Error('gatt connect failed');
}
// try each family in order; the family whose write char is present sets CONNECT_TYPE
async function resolveProfile(srv) {
  for (const p of PROFILES) {
    try { const svc = await srv.getPrimaryService(p.service); const w = await svc.getCharacteristic(p.write); if (w) return p; } catch (_) {}
  }
  return null;
}
// after link: optional legacy pairing code, then model + version query (all proven TX)
async function afterConnectInit() {
  let code = null; try { code = localStorage.getItem(LS.CODE); } catch (e) {}
  const field = ($('code-in') || {}).value;
  if (field && /^\d{6}$/.test(field)) code = field;
  if (code && /^\d{6}$/.test(code)) { try { localStorage.setItem(LS.CODE, code); } catch (e) {} await sendAscii('CODE=' + code, t('pairLabel')); }
  await sendAscii('GETDEVID', t('modelLabel'));
  await sendAscii('+VER?', t('verLabel'));
}
function onDisconnected() {
  connected = false; ch = null; notifyCh = null; activeProfile = null; activeWriteUuid = null; activeNotifyUuid = null;
  setStatus('disconnected'); setControlsEnabled(false);
  resetState(); resetTiles(); clearAcks(); for (const k of Object.keys(seenFrames)) delete seenFrames[k];
  updateSpeedUI();
  const el = $('devinfo'); if (el) el.textContent = '';
  logSys('disconnected');
}
function disconnect() { if (dev && dev.gatt.connected) dev.gatt.disconnect(); }

// --------------------------- notify + ACK ---------------------------
let rxBuf = [];
function onCharValue(ev) {
  const b = Array.from(new Uint8Array(ev.target.value.buffer));
  logRx(b);
  for (const x of b) rxBuf.push(x);
  drainRx();
}
// the device interleaves binary AA..BB frames and ASCII/AT replies on the same notify channel
function drainRx() {
  let guard = 0;
  while (rxBuf.length && guard++ < 128) {
    if (rxBuf[0] === 0xaa) {
      const end = findFrameEnd(rxBuf);
      if (end < 0) { if (rxBuf.length > 80) rxBuf.shift(); else break; continue; }
      const frame = rxBuf.slice(0, end + 1); rxBuf = rxBuf.slice(end + 1);
      if (!validFrame(frame)) { logDiag('bad checksum, dropped: ' + hex(frame)); continue; }
      handleFrame(frame);
    } else if (isPrintable(rxBuf[0])) {
      let i = 0; while (i < rxBuf.length && rxBuf[i] !== 0xaa && (isPrintable(rxBuf[i]) || rxBuf[i] === 0x0d || rxBuf[i] === 0x0a)) i++;
      const chunk = rxBuf.slice(0, i); rxBuf = rxBuf.slice(i);
      const txt = new TextDecoder().decode(Uint8Array.from(chunk)).trim();
      if (txt) handleText(txt);
    } else { rxBuf.shift(); }
  }
}
function isPrintable(b) { return b >= 0x20 && b < 0x7f; }
// smallest end>=4 where buf[end]==0xBB and the XOR over AA..payload validates
function findFrameEnd(buf) {
  for (let end = 4; end < buf.length; end++) { if (buf[end] === 0xbb && aaXor(buf.slice(0, end - 1)) === buf[end - 1]) return end; }
  return -1;
}
function handleFrame(frame) {
  const cmd = frame[1];
  parseFrame(frame);
  seenFrames[cmd] = frame;
  resolveAck('cmd:' + cmd);
  refreshTiles(); updateSpeedUI();
}
function handleText(txt) {
  const m = txt.match(/imoogoo-([A-Za-z0-9]+)/i);
  if (m) { S.modelCode = m[1]; S.model = MODELS[m[1]] || m[1]; logSys('model: ' + S.model + ' (imoogoo-' + m[1] + ')'); refreshTiles(); return; }
  if (/^CODE_OK/i.test(txt)) { logSys('pairing code accepted'); return; }
  if (/^CODE_NG/i.test(txt)) { logErr('pairing code rejected'); return; }
  const v = txt.match(/^\+VER[=?]?\s*(.+)$/i);
  if (v) { S.fw = v[1].trim(); refreshTiles(); logSys('version: ' + S.fw); return; }
  logDiag('text rx: ' + txt);
}
const pendingAcks = new Map();
const ACK_TIMEOUT_MS = 3000;
function armAck(key, label) {
  clearAckTimer(key);
  const timer = setTimeout(() => { pendingAcks.delete(key); logSys(label + ': ' + t('ackNone')); }, ACK_TIMEOUT_MS);
  pendingAcks.set(key, { timer, label });
}
function resolveAck(key) { const a = pendingAcks.get(key); if (a) { clearTimeout(a.timer); pendingAcks.delete(key); logSys(a.label + ': ' + t('ackOk')); } }
function clearAckTimer(key) { const a = pendingAcks.get(key); if (a) { clearTimeout(a.timer); pendingAcks.delete(key); } }
function clearAcks() { for (const a of pendingAcks.values()) clearTimeout(a.timer); pendingAcks.clear(); }

// --------------------------- transmit (single funnel: log TX, arm ack, write) ---------------------------
async function writeFrame(bytes) {
  const arr = Uint8Array.from(bytes);
  // KUKIRIN writes to the discovered write characteristic; prefer with-response, fall back per stack.
  if (ch.properties.write) return ch.writeValueWithResponse(arr);
  if (ch.properties.writeWithoutResponse) return ch.writeValueWithoutResponse(arr);
  return ch.writeValue(arr);
}
async function transmit(bytes, label, ackKey) {
  if (!connected || !ch) { logErr(t('errNotConnected')); return; }
  logTx(bytes);
  if (ackKey) armAck(ackKey, label);
  try { await writeFrame(bytes); logSys(label + ': ' + t('txSent')); }
  catch (e) { clearAckTimer(ackKey); logErr(label + ' ' + t('txFailed') + ': ' + (e && e.message ? e.message : e)); }
}
// writes do not echo their own opcode on this protocol (telemetry is the proof), so no ackKey is armed.
async function sendHex(payload, label) { await transmit(buildHex(payload), label); }
async function sendAscii(str, label) { await transmit(asciiBytes(str), label); }
// serialize writes on the single characteristic (eg guard mutex; vr/ap/vmax omit it)
async function guard(fn) { if (busy) return; busy = true; try { await fn(); } catch (e) { logErr(e && e.message ? e.message : String(e)); } finally { busy = false; } }

// --------------------------- commands ---------------------------
// max-speed register: +SPDLT=<kmh> (SettingsActivity.java:546; UI slider+10 = km/h). Device-side cap unknown.
async function setSpeed(kmh) { await sendAscii('+SPDLT=' + (kmh & 0xff), t('speedLabel') + ' ' + (kmh & 0xff) + ' km/h'); }

// --------------------------- speed card (manual Unlock/Lock toggle - no limit telemetry to drive it) ---------------------------
function updateSpeedUI() {
  const info = $('speed-current');
  if (info) info.textContent = t('speedCurUnknown');
  const b = $('btn-toggle'); if (!b) return;
  if (b.dataset.mode !== 'lock') b.dataset.mode = 'unlock';
  b.textContent = b.dataset.mode === 'lock' ? t('btnLock') : t('btnUnlock');
}

// --------------------------- settings (static set-rows in more-card; each wired by id, no read-back) ---------------------------
// row: { id (matches #<id>-in select + #btn-<id>), send:(v)->write, risky?:warnKey }
const SETTINGS = [
  { id: 'throttle', send: v => sendAscii('+BSTF=' + v, t('lblThrottle')) },
  { id: 'brake', send: v => sendAscii('+EBKF=' + v, t('lblBrake')) },
  { id: 'cruise', send: v => sendAscii('+CRZE=' + (v ? 1 : 0), t('lblCruise')) },
  { id: 'limiter', send: v => sendAscii('+SPLT=' + (v ? 1 : 0), t('lblLimiter')), risky: 'warnLimiter' },
  { id: 'light', send: v => sendHex([0x07, 0x06, v ? 1 : 0], t('lblLight')) },
  { id: 'unit', send: v => sendHex([0x19, 0x06, v ? 1 : 0], t('lblUnit')) },
  { id: 'zerostart', send: v => sendHex([0x12, 0x06, v ? 1 : 0], t('lblZeroStart')) },
  { id: 'bright', send: v => sendAscii('+LUMA=M0L' + v, t('lblBright')) },
  { id: 'backlight', send: v => sendAscii('+TIM=L' + [3, 5, 7][v], t('lblBacklight')) },
  // auto-shutdown time in minutes (SettingsActivity shut-down seekbar, max 9 -> 1..10 min); 1..9 zero-padded.
  { id: 'standby', send: v => sendAscii('+STBY=' + (v < 10 ? '0' + v : '' + v), t('lblStandby')) }
];
function wireSettings() {
  for (const s of SETTINGS) {
    const btn = $('btn-' + s.id), sel = $(s.id + '-in');
    if (!btn || !sel) continue;
    btn.addEventListener('click', () => guard(async () => {
      const v = parseInt(sel.value, 10) || 0;
      if (s.risky && !await confirmRisky(t(s.risky))) return;
      await s.send(v);
    }));
  }
}

// --------------------------- electronic lock (unlock is the only proven generic TX) ---------------------------
async function doUnlock() { if (!await confirmRisky(t('warnUnlock'))) return; await sendAscii('+LOCK=0', t('lblLock')); }

// --------------------------- engine level (raw verbatim + AA-frame builder + AT text) ---------------------------
function hexToBytes(s) {
  const clean = String(s).replace(/[^0-9a-fA-F]/g, '');   // strip spaces/punctuation
  const out = []; for (let i = 0; i + 2 <= clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));   // pairs; drop a dangling nibble
  return out;
}
async function cmdRaw() {
  const bytes = hexToBytes(($('raw-in') || {}).value || '');
  if (!bytes.length) { logErr(t('errNoBytes')); return; }
  await transmit(bytes, t('rawLabel'));   // sent verbatim, no marker/checksum added
}
async function cmdFree() {
  const op = parseInt(($('free-op') || {}).value, 16);
  if (isNaN(op)) { logErr(t('errBadOp')); return; }
  const payload = hexToBytes(($('free-payload') || {}).value || '');
  await transmit(buildHex([op, ...payload]), t('freeLabel') + ' 0x' + (op & 0xff).toString(16));   // wraps AA .. XOR BB
}
async function cmdAt() {
  const s = (($('at-in') || {}).value || '').trim();
  if (!s) { logErr(t('errNoText')); return; }
  await sendAscii(s, t('atLabel') + ' ' + s);   // sent as UTF-8 verbatim
}

// --------------------------- confirm dialog (themed; window.confirm fallback) ---------------------------
function confirmRisky(msg) {
  return new Promise(resolve => {
    const dlg = $('confirm'); const body = $('confirm-body');
    if (!dlg || !dlg.showModal) { resolve(window.confirm(msg)); return; }
    if (body) body.textContent = msg;
    const ok = $('confirm-ok'), cancel = $('confirm-x'), no = $('confirm-no');
    const done = (v) => { dlg.close(); ok.removeEventListener('click', onOk); if (no) no.removeEventListener('click', onNo); if (cancel) cancel.removeEventListener('click', onNo); resolve(v); };
    const onOk = () => done(true), onNo = () => done(false);
    ok.addEventListener('click', onOk); if (no) no.addEventListener('click', onNo); if (cancel) cancel.addEventListener('click', onNo);
    dlg.showModal();
  });
}

// --------------------------- doc viewer (markdown of our own docs) ---------------------------
const DOC_TITLES = { 'GUIDE.de.md': 'footGuide', 'GUIDE.en.md': 'footGuide', 'README.md': 'footReadme', 'LICENSE.de.md': 'footLicense', 'LICENSE.md': 'footLicense', 'PRIVACY.de.md': 'footPrivacy', 'PRIVACY.md': 'footPrivacy', 'TRADEMARKS.de.md': 'footTrademarks', 'TRADEMARKS.md': 'footTrademarks', 'DISCLAIMER.de.md': 'footDisclaimer', 'DISCLAIMER.md': 'footDisclaimer' };
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = s => s.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
function docFile(name) { if (name === 'README') return 'README.md'; if (name === 'GUIDE') return 'GUIDE.' + lang + '.md'; return name + (lang === 'de' ? '.de.md' : '.md'); }
function mdToHtml(src) {
  const inline = s => escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, text, href) => DOC_TITLES[href] ? '<a href="' + href + '" data-docfile="' + href + '">' + text + '</a>' : '<a href="' + href + '" target="_blank" rel="noopener">' + text + '</a>');
  const lines = String(src).split(/\r?\n/); let html = '', inList = false, inCode = false;
  for (const ln of lines) {
    if (/^```/.test(ln)) { if (inCode) { html += '</pre>'; inCode = false; } else { if (inList) { html += '</ul>'; inList = false; } html += '<pre class="doc-code">'; inCode = true; } continue; }
    if (inCode) { html += escHtml(ln) + '\n'; continue; }
    const h = ln.match(/^(#{1,4})\s+(.*)$/);
    if (h) { if (inList) { html += '</ul>'; inList = false; } const lvl = h[1].length + 1; html += '<h' + lvl + ' id="' + slug(h[2]) + '">' + inline(h[2]) + '</h' + lvl + '>'; continue; }
    const li = ln.match(/^\s*[-*]\s+(.*)$/);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(li[1]) + '</li>'; continue; }
    if (/^\s*$/.test(ln)) { if (inList) { html += '</ul>'; inList = false; } continue; }
    if (inList) { html += '</ul>'; inList = false; }
    html += '<p>' + inline(ln) + '</p>';
  }
  if (inList) html += '</ul>'; if (inCode) html += '</pre>';
  return html;
}
const docCache = {};
async function openDocFile(file) {
  const dlg = $('doc'); const titleEl = $('doc-title'); const bodyEl = $('doc-body');
  titleEl.textContent = t(DOC_TITLES[file] || 'footReadme');
  if (lang === 'de' && /\.md$/.test(file) && !/\.de\.md$/.test(file) && file !== 'README.md') titleEl.textContent += ' (englisch)';
  try { if (!docCache[file]) { const r = await fetch(file); docCache[file] = await r.text(); } bodyEl.innerHTML = mdToHtml(docCache[file]); } // scan-ok: own in-repo markdown rendered via mdToHtml; not user input
  catch (e) { bodyEl.textContent = 'Could not load ' + file; }
  if (dlg.showModal) dlg.showModal();
}
function wireDocViewer() {
  // delegated: footer doc links, the intro guide link (injected by i18n at runtime), in-doc links, disclaimer
  document.addEventListener('click', e => {
    const d = e.target.closest('a[data-doc]'); if (d) { e.preventDefault(); openDocFile(docFile(d.getAttribute('data-doc'))); return; }
    const df = e.target.closest('a[data-docfile]'); if (df) { e.preventDefault(); openDocFile(df.getAttribute('data-docfile')); return; }
    const disc = e.target.closest('[data-open-disclaimer]'); if (disc) { e.preventDefault(); openDocFile(docFile('DISCLAIMER')); return; }
  });
  ['doc-x', 'doc-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', () => $('doc').close()); });
}

// --------------------------- help modal ---------------------------
const HELP = ['connect', 'live', 'speed', 'more', 'raw', 'publiclog', 'diaglog'];
function openHelp(key) { openHelpText(t('help_' + key + '_t'), t('help_' + key + '_b')); }
function openHelpText(title, body) {
  const dlg = $('help'); $('help-title').textContent = title || ''; const b = $('help-body'); if (/[<&]/.test(body || '')) b.innerHTML = body; else b.textContent = body || ''; // scan-ok: curated i18n help text; own table, not user input
  if (dlg.showModal) dlg.showModal();
}
function closeHelp() { const d = $('help'); if (d) d.close(); }

// --------------------------- init ---------------------------
window.addEventListener('DOMContentLoaded', () => {
  initLangSwitch(); initTheme(); wireDocViewer(); wireSettings();
  try { const o = localStorage.getItem(LS.OPEN); if (o && $('open-in')) $('open-in').value = o; } catch (e) {}
  try { const k = localStorage.getItem(LS.EKFV); if (k && $('ekfv-in')) $('ekfv-in').value = k; } catch (e) {}
  try { const c = localStorage.getItem(LS.CODE); if (c && $('code-in')) $('code-in').value = c; } catch (e) {}
  applyLang(); setStatus('disconnected'); resetTiles();
  logDiagnosticHeader();
  if (!FRAME_OK) logErr('protocol self-test FAILED - builders do not match known vectors; do not trust writes');

  $('btn-conn').addEventListener('click', () => { if ($('btn-conn').dataset.act === 'disconnect') disconnect(); else guard(connect); });
  { const o = $('open-in'); if (o) o.addEventListener('change', () => { try { localStorage.setItem(LS.OPEN, o.value); } catch (e) {} }); }
  { const k = $('ekfv-in'); if (k) k.addEventListener('change', () => { try { localStorage.setItem(LS.EKFV, k.value); } catch (e) {} updateSpeedUI(); }); }
  { const c = $('code-in'); if (c) c.addEventListener('change', () => { try { localStorage.setItem(LS.CODE, c.value); } catch (e) {} }); }

  $('btn-toggle').addEventListener('click', () => guard(async () => {
    const mode = ($('btn-toggle').dataset.mode === 'lock') ? 'lock' : 'unlock';
    const id = (mode === 'lock') ? 'ekfv-in' : 'open-in';
    const v = parseInt($(id).value, 10);
    if (!(v >= 1 && v <= 99)) { logErr(t('errSpeedRange')); return; }
    await setSpeed(v);
    const next = (mode === 'lock') ? 'unlock' : 'lock';   // no telemetry to drive it, so flip manually
    $('btn-toggle').dataset.mode = next; $('btn-toggle').textContent = next === 'lock' ? t('btnLock') : t('btnUnlock');
  }));
  { const b = $('btn-lock'); if (b) b.addEventListener('click', () => guard(doUnlock)); }

  { const b = $('btn-raw'); if (b) b.addEventListener('click', () => guard(cmdRaw)); }
  { const b = $('btn-free'); if (b) b.addEventListener('click', () => guard(cmdFree)); }
  { const b = $('btn-at'); if (b) b.addEventListener('click', () => guard(cmdAt)); }

  document.querySelectorAll('.help-btn[data-help]').forEach(btn => btn.addEventListener('click', () => openHelp(btn.getAttribute('data-help'))));
  ['help-x', 'help-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', closeHelp); });
  { const b = $('link-disclaimer'); if (b) b.addEventListener('click', e => { e.preventDefault(); openDocFile(docFile('DISCLAIMER')); }); }

  { const cb = $('public-log'); if (cb) { let saved = null; try { saved = localStorage.getItem(LS.PUBLOG); } catch (e) {} publicLog = saved !== '0'; cb.checked = publicLog; cb.addEventListener('change', () => { publicLog = cb.checked; try { localStorage.setItem(LS.PUBLOG, cb.checked ? '1' : '0'); } catch (e) {} logSys('public-log: ' + (cb.checked ? 'on (anonymizing device name/id)' : 'off')); renderLog(); }); } }
  { const cb = $('showall'); if (cb) cb.addEventListener('change', () => { logSys('show-all-frames: ' + (cb.checked ? 'on' : 'off')); renderLog(); }); }
  { const cb = $('diag-log'); if (cb) { cb.addEventListener('change', () => { diag = cb.checked; logSys(diag ? 'diagnostic log on' : 'diagnostic log off'); }); } }
  { const b = $('btn-clear-log'); if (b) b.addEventListener('click', () => { logBuffer = []; $('log').textContent = ''; logDiagnosticHeader(); }); }
  { const b = $('btn-copy-log'); if (b) b.addEventListener('click', () => navigator.clipboard.writeText(logText()).then(() => logSys('log copied')).catch(() => {})); }
  { const b = $('btn-save-log'); if (b) b.addEventListener('click', saveLog); }
});
