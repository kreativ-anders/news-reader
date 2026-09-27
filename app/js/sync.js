// INFO: vault key (32 random bytes, never sent) ─ HKDF "auth" → bearer token, HKDF "enc" → AES-256-GCM key.
//       One round: GET (If-None-Match) → decrypt + merge (last write wins) → PUT the full snapshot with
//       If-Match / If-None-Match: * when this device knows more; 412 → start over.
//       Removing a device rotates the vault key: the old location then holds a forward ("NRF1") with the
//       new key wrapped for every remaining device (ECDH P-256 + HKDF + AES-GCM, see wrapKey()).

import * as db from './db.js';

const MAGIC = [0x4e, 0x52, 0x53, 0x31];         // "NRS1" vault snapshot
const MAGIC_FORWARD = [0x4e, 0x52, 0x46, 0x31]; // "NRF1" forward to a new vault key
const FLAG_GZIP = 1;
const AAD = new TextEncoder().encode('newsreader-sync-v1');
const AAD_FORWARD = new TextEncoder().encode('newsreader-sync-v1 forward');
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const MAX_ROUNDS = 5;
const PRUNE_AFTER_MS = 180 * 864e5;
const DEVICE_TOUCH_MS = 3600e3;
const DEVICE_NAME_MAX = 60;

export class Sync extends EventTarget {
  constructor() {
    super();
    this.status = { state: 'local', pending: 0, lastSync: null, message: '', code: '' };
    this.running = null;
    this.again = false;
    this.debounce = null;
    this.keys = null;
    this.leaving = false;
  }

  async init() {
    this.status.lastSync = await db.kvGet('lastSync', null);
    await this.refreshPending();
    this.emitStatus(await db.kvGet('vaultKey') ? 'idle' : 'local');
  }

  async refreshPending() {
    this.status.pending = await db.count('outbox');
  }

  emitStatus(state, message = '', code = '') {
    this.status.state = state;
    this.status.message = message;
    this.status.code = code;
    this.dispatchEvent(new CustomEvent('status', { detail: { ...this.status } }));
  }

  schedule(delay = 1500) {
    clearTimeout(this.debounce);
    this.refreshPending().then(() => this.emitStatus(this.status.state));
    this.debounce = setTimeout(() => this.run(), delay);
  }

  // INFO: concurrent calls are coalesced into one follow-up run
  run() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.runOnce().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.run();
      }
    });
    return this.running;
  }

  async runOnce() {
    const key = await db.kvGet('vaultKey');
    await this.refreshPending();
    if (!key) return this.emitStatus('local');
    if (!cryptoAvailable()) return this.emitStatus('error', 'Sync needs HTTPS (or localhost) for encryption.', 'https');
    if (!navigator.onLine) return this.emitStatus('offline');

    this.emitStatus('syncing');
    try {
      const endpoint = await syncEndpoint();
      const changed = [];
      let done = false;
      for (let round = 0; round < MAX_ROUNDS && !done; round++) {
        done = await this.round(endpoint, await this.deriveKeys(await db.kvGet('vaultKey')), changed);
        if (done === 'removed') break;
        if (done === 'forwarded') done = false;
      }
      if (!done) throw Object.assign(new Error('Too many concurrent changes – will retry.'), { code: 'conflict' });
      if (done === 'removed' || (!this.leaving && await this.ownDeviceRemoved())) {
        const stale = !(await db.kvGet('deviceId'));
        await this.leaveVault({ announce: false });
        this.dispatchEvent(new CustomEvent('removed', { detail: { stale } }));
        return;
      }
      this.status.lastSync = Date.now();
      await db.kvSet('lastSync', this.status.lastSync);
      await this.refreshPending();
      this.emitStatus('ok');
      if (changed.length) this.dispatchEvent(new CustomEvent('remote', { detail: changed }));
    } catch (err) {
      await this.refreshPending();
      if (err instanceof TypeError || err.name === 'AbortError') {
        this.emitStatus(navigator.onLine ? 'unreachable' : 'offline', err.message);
      } else {
        this.emitStatus('error', err.message, err.code || '');
      }
    }
  }

  // INFO: true when in sync, false on a write conflict (412), 'forwarded' after a key switch,
  //       'removed' when a forward holds no key for this device
  async round(endpoint, keys, changed) {
    const etag = await db.kvGet('etag');
    const now = Date.now();
    const res = await request(endpoint, keys.token, { method: 'GET', headers: etag ? { 'If-None-Match': etag } : {} });

    let remoteEtag = null;
    let remote = [];
    if (res.status === 304) {
      remoteEtag = etag;
    } else if (res.ok) {
      remoteEtag = res.headers.get('ETag');
      const blob = await decrypt(keys.aes, new Uint8Array(await res.arrayBuffer()));
      if (blob.forward) return this.follow(blob.data);
      remote = blob.data.records || [];
      changed.push(...await db.applyRemote(remote));
    } else if (res.status !== 404) {
      throw await httpError(res);
    }

    // INFO: after the merge, so a name set on another device is kept
    await this.touchDevice(now);
    const sent = await db.getAll('outbox');

    let dirty;
    if (res.status === 304) {
      dirty = sent.length > 0;
    } else {
      const inVault = new Map(remote.map((r) => [`${r.kind}\u0000${r.id}`, r.updatedAt]));
      dirty = (await db.getAll('records')).some((r) => !prunable(r, now) && !(inVault.get(`${r.kind}\u0000${r.id}`) >= r.updatedAt));
    }

    if (!dirty) {
      await db.kvSet('etag', remoteEtag);
      await db.outboxAck(sent);
      return true;
    }

    const records = await db.prune((r) => prunable(r, now));
    const blob = await encrypt(keys.aes, { v: 1, at: now, records }, MAGIC, AAD);
    const put = await request(endpoint, keys.token, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': 'application/octet-stream', ...(remoteEtag ? { 'If-Match': remoteEtag } : { 'If-None-Match': '*' }) },
    });
    // INFO: 410 = the location became a forward meanwhile – the next round follows it
    if (put.status === 412 || put.status === 410) {
      await db.kvDel('etag');
      return false;
    }
    if (!put.ok) throw await httpError(put);
    await db.kvSet('etag', put.headers.get('ETag') || (await put.json()).etag);
    await db.outboxAck(sent);
    return true;
  }

  async deriveKeys(key) {
    if (this.keys?.forKey !== key) this.keys = await deriveVaultKeys(key);
    return this.keys;
  }

  async follow(forward) {
    const id = await db.kvGet('deviceId');
    const own = (forward.envelopes || []).find((e) => e.id === id);
    const pair = await db.kvGet('deviceKey');
    const key = own && pair ? await unwrapKey(own, pair.priv) : null;
    if (!key) return 'removed';
    await db.kvSet('vaultKey', key);
    await db.kvDel('etag');
    await db.outboxAll();
    return 'forwarded';
  }

  // INFO: new vault key → full snapshot to the new location → forward at the old location (If-Match, so no
  //       change of another device is lost) → switch locally. A failed attempt leaves an orphan that expires.
  async rotateKey() {
    if (!navigator.onLine) throw Object.assign(new Error('offline'), { code: 'offline' });
    while (this.running) await this.running.catch(() => {});
    this.running = this.rotateOnce().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.run();
      }
    });
    try {
      await this.running;
      this.emitStatus('ok');
    } catch (err) {
      this.emitStatus('error', err.message, err.code || '');
      throw err;
    }
  }

  async rotateOnce() {
    this.emitStatus('syncing');
    const endpoint = await syncEndpoint();
    for (let attempt = 0; attempt < 3; attempt++) {
      const oldKey = await db.kvGet('vaultKey');
      if (!oldKey) throw new Error('Not paired.');
      const old = await this.deriveKeys(oldKey);
      let done = false;
      for (let round = 0; round < MAX_ROUNDS && !done; round++) {
        done = await this.round(endpoint, old, []);
        if (done === 'forwarded' || done === 'removed') throw Object.assign(new Error('The vault changed meanwhile – try again.'), { code: 'conflict' });
      }
      if (!done) continue;

      const now = Date.now();
      const newKey = randomKey();
      const next = await deriveVaultKeys(newKey);
      const holders = (await this.devices()).filter((d) => typeof d.data.pub === 'string');
      const envelopes = await Promise.all(holders.map((d) => wrapKey(newKey, d.id, d.data.pub)));

      const records = await db.prune((r) => prunable(r, now));
      const created = await request(endpoint, next.token, {
        method: 'PUT',
        body: await encrypt(next.aes, { v: 1, at: now, records }, MAGIC, AAD),
        headers: { 'Content-Type': 'application/octet-stream', 'If-None-Match': '*' },
      });
      if (!created.ok) throw await httpError(created);
      const newEtag = created.headers.get('ETag') || (await created.json()).etag;

      const moved = await request(endpoint, old.token, {
        method: 'PUT',
        body: await encrypt(old.aes, { v: 1, at: now, envelopes }, MAGIC_FORWARD, AAD_FORWARD),
        headers: { 'Content-Type': 'application/octet-stream', 'If-Match': await db.kvGet('etag') },
      });
      if (moved.status === 412 || moved.status === 410) continue;
      if (!moved.ok) throw await httpError(moved);

      await db.kvSet('vaultKey', newKey);
      await db.kvSet('etag', newEtag);
      this.keys = next;
      return;
    }
    throw Object.assign(new Error('Too many concurrent changes – try again.'), { code: 'conflict' });
  }

  async createVault() {
    await this.joinVault(randomKey());
  }

  async joinVault(key) {
    if (!isValidKey(key)) throw new Error('Invalid vault key.');
    await db.kvSet('vaultKey', key);
    await db.kvDel('etag');
    await db.kvDel('deviceId');
    await db.kvDel('deviceKey');
    await db.outboxAll();
    // INFO: the vault key lives in IndexedDB – ask the browser not to evict it under storage pressure
    navigator.storage?.persist?.().catch(() => {});
    return this.run();
  }

  // INFO: announce = remove this device from the list of the other devices first (best effort)
  async leaveVault({ announce = true } = {}) {
    const id = await db.kvGet('deviceId');
    if (announce && id && navigator.onLine && await db.kvGet('vaultKey')) {
      this.leaving = true;
      try {
        await this.removeDevice(id, { sync: false });
        await this.run();
      } finally {
        this.leaving = false;
      }
    }
    await db.kvDel('vaultKey');
    await db.kvDel('etag');
    await db.kvDel('deviceId');
    await db.kvDel('deviceKey');
    await db.outboxClear();
    this.keys = null;
    await this.refreshPending();
    this.emitStatus('local');
  }

  // INFO: device list – records {kind:'device', id, data:{name, platform, since, seen, pub, r?}} inside the encrypted vault.
  //       removeDevice() marks the record; revoke() also rotates the key so the removed device is locked out.
  async devices() {
    return (await db.getAll('records'))
      .filter((r) => r.kind === 'device' && !r.data.r)
      .sort((a, b) => (b.data.seen || 0) - (a.data.seen || 0));
  }

  async renameDevice(id, name) {
    const cur = await db.get('records', ['device', id]);
    const clean = String(name ?? '').trim().slice(0, DEVICE_NAME_MAX);
    if (!cur || !clean) return;
    await db.putLocal([{ ...cur, data: { ...cur.data, name: clean }, updatedAt: Date.now() }]);
    this.schedule();
  }

  async removeDevice(id, { sync = true } = {}) {
    const cur = await db.get('records', ['device', id]);
    if (!cur) return;
    await db.putLocal([{ ...cur, data: { ...cur.data, r: 1 }, updatedAt: Date.now() }]);
    if (sync) this.schedule(0);
  }

  // WARNING: the removed device keeps whatever it already downloaded – only future changes are protected
  async revoke(id) {
    if (!navigator.onLine) throw Object.assign(new Error('offline'), { code: 'offline' });
    await this.removeDevice(id, { sync: false });
    await this.rotateKey();
  }

  async ownDeviceRemoved() {
    const id = await db.kvGet('deviceId');
    return !!id && !!(await db.get('records', ['device', id]))?.data?.r;
  }

  // INFO: creates this device's record (with its public key) on the first sync, refreshes "seen" at most hourly
  async touchDevice(now) {
    let id = await db.kvGet('deviceId');
    if (!id) {
      id = b64uEncode(crypto.getRandomValues(new Uint8Array(16)));
      await db.kvSet('deviceId', id);
    }
    let pair = await db.kvGet('deviceKey');
    if (!pair) {
      // INFO: the private key is non-extractable – it can be used on this device, never exported
      const kp = await crypto.subtle.generateKey(ECDH, false, ['deriveBits']);
      pair = { priv: kp.privateKey, pub: b64uEncode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))) };
      await db.kvSet('deviceKey', pair);
    }
    const cur = await db.get('records', ['device', id]);
    if (cur?.data?.r || (cur && cur.data.pub === pair.pub && now - (cur.data.seen || 0) < DEVICE_TOUCH_MS)) return;
    const platform = describeDevice();
    await db.putLocal([{
      kind: 'device', id, updatedAt: now,
      data: { name: cur?.data?.name || platform, platform, since: cur?.data?.since || now, seen: now, pub: pair.pub },
    }]);
  }

  async wipeServer() {
    const key = await db.kvGet('vaultKey');
    if (!key) return;
    const res = await request(await syncEndpoint(), (await this.deriveKeys(key)).token, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw await httpError(res);
    await db.kvDel('etag');
  }
}

// INFO: deterministic on every device, so pruned records cannot be resurrected by an old device
function prunable(r, now) {
  if (now - r.updatedAt < PRUNE_AFTER_MS) return false;
  if (r.kind === 'item') return r.data?.s === 'done' || r.data?.s === 'dismissed' || r.data?.s === 'new';
  if (r.kind === 'feed') return !!r.data?.d;
  return r.kind === 'device';
}

function describeDevice() {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android'
    : /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Windows/.test(ua) ? 'Windows'
    : /Macintosh|Mac OS X/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox'
    : /OPR\//.test(ua) ? 'Opera'
    : /Chrome|CriOS/.test(ua) ? 'Chrome'
    : /Safari/.test(ua) ? 'Safari' : '';
  return [os, browser].filter(Boolean).join(' · ') || 'Browser';
}

export function cryptoAvailable() {
  return !!(window.isSecureContext && crypto?.subtle);
}

async function deriveVaultKeys(key) {
  const base = await crypto.subtle.importKey('raw', b64uDecode(key), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const hkdf = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(`newsreader-sync-v1 ${info}`) });
  const token = b64uEncode(new Uint8Array(await crypto.subtle.deriveBits(hkdf('auth'), base, 256)));
  const aes = await crypto.subtle.deriveKey(hkdf('enc'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { forKey: key, token, aes };
}

// INFO: ephemeral-static ECDH per device; the device id is bound into HKDF info and AAD
async function wrapSecret(shared, id) {
  const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(`newsreader-sync-v1 wrap ${id}`) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function wrapKey(vaultKey, id, pub) {
  const peer = await crypto.subtle.importKey('raw', b64uDecode(pub), ECDH, false, []);
  const eph = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const aes = await wrapSecret(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, eph.privateKey, 256), id);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) }, aes, b64uDecode(vaultKey));
  return {
    id,
    epk: b64uEncode(new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey))),
    iv: b64uEncode(iv),
    ct: b64uEncode(new Uint8Array(ct)),
  };
}

async function unwrapKey(env, priv) {
  try {
    const epk = await crypto.subtle.importKey('raw', b64uDecode(env.epk), ECDH, false, []);
    const aes = await wrapSecret(await crypto.subtle.deriveBits({ name: 'ECDH', public: epk }, priv, 256), env.id);
    const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64uDecode(env.iv), additionalData: new TextEncoder().encode(env.id) }, aes, b64uDecode(env.ct));
    const key = b64uEncode(new Uint8Array(raw));
    return isValidKey(key) ? key : null;
  } catch {
    return null;
  }
}

async function encrypt(aes, obj, magic, aad) {
  let plain = new TextEncoder().encode(JSON.stringify(obj));
  let flags = 0;
  if ('CompressionStream' in window) {
    plain = new Uint8Array(await new Response(new Blob([plain]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    flags |= FLAG_GZIP;
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aes, plain));
  const out = new Uint8Array(4 + 1 + 12 + ct.length);
  out.set(magic, 0);
  out[4] = flags;
  out.set(iv, 5);
  out.set(ct, 17);
  return out;
}

// INFO: { forward: bool, data }
async function decrypt(aes, buf) {
  const is = (magic) => magic.every((b, i) => buf[i] === b);
  const forward = is(MAGIC_FORWARD);
  if (buf.length < 33 || (!forward && !is(MAGIC))) throw Object.assign(new Error('Unknown vault format on the server.'), { code: 'format' });
  const flags = buf[4];
  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(5, 17), additionalData: forward ? AAD_FORWARD : AAD }, aes, buf.slice(17)));
  } catch {
    throw Object.assign(new Error('Vault could not be decrypted – wrong key or damaged data.'), { code: 'decrypt' });
  }
  if (flags & FLAG_GZIP) {
    plain = new Uint8Array(await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  }
  return { forward, data: JSON.parse(new TextDecoder().decode(plain)) };
}

export async function serverBase() {
  const s = await db.kvGet('server');
  return s || defaultServer();
}

export function defaultServer() {
  // INFO: News is served from <server>/app/
  return new URL('../', location.href).href;
}

async function syncEndpoint() {
  return new URL('api/sync', await serverBase()).href;
}

async function request(url, token, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function httpError(res) {
  let body = null;
  try { body = await res.json(); } catch { /* INFO: not JSON */ }
  const msg = body?.error?.message || `Sync server answered HTTP ${res.status}`;
  return Object.assign(new Error(msg), { status: res.status, code: body?.error?.code });
}

function b64uEncode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

function randomKey() {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export function isValidKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key);
}
