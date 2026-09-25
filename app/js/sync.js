// News – end-to-end encrypted sync against <server>/api/sync.
//
// The server stores ONE opaque blob per vault – no database, no schema, no accounts.
//
//   vault key (random 32 bytes, shared via QR code / pairing link, never sent anywhere)
//     ├─ HKDF "auth" → bearer token     (server stores the file under sha256(token))
//     └─ HKDF "enc"  → AES-256-GCM key  (server never sees it → cannot read the vault)
//
// One sync round:
//   1. GET  (If-None-Match: last ETag)  → 304 unchanged | 200 blob | 404 no vault yet
//   2. decrypt + merge into IndexedDB, last write wins per record
//   3. if this device knows something the vault doesn't: encrypt the full snapshot and
//      PUT with If-Match: <ETag> (or If-None-Match: * to create). 412 → someone else
//      was faster → start over at 1.

import * as db from './db.js';

const MAGIC = [0x4e, 0x52, 0x53, 0x31]; // "NRS1"
const FLAG_GZIP = 1;
const AAD = new TextEncoder().encode('newsreader-sync-v1');
const MAX_ROUNDS = 5;
const PRUNE_AFTER_MS = 180 * 864e5; // finished / dismissed items and unfollowed feeds are forgotten after 180 days

export class Sync extends EventTarget {
  constructor() {
    super();
    this.status = { state: 'local', pending: 0, lastSync: null, message: '', code: '' };
    this.running = null;
    this.again = false;
    this.debounce = null;
    this.keys = null; // { forKey, token, aes }
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

  /** Call after every local change: sync shortly after the user stops clicking. */
  schedule(delay = 1500) {
    clearTimeout(this.debounce);
    this.refreshPending().then(() => this.emitStatus(this.status.state));
    this.debounce = setTimeout(() => this.run(), delay);
  }

  /** Run one sync; concurrent calls are coalesced into one follow-up run. */
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
      const keys = await this.deriveKeys(key);
      const endpoint = await syncEndpoint();
      const changed = [];
      let done = false;
      for (let round = 0; round < MAX_ROUNDS && !done; round++) {
        done = await this.round(endpoint, keys, changed);
      }
      if (!done) throw Object.assign(new Error('Too many concurrent changes – will retry.'), { code: 'conflict' });
      this.status.lastSync = Date.now();
      await db.kvSet('lastSync', this.status.lastSync);
      await this.refreshPending();
      this.emitStatus('ok');
      if (changed.length) this.dispatchEvent(new CustomEvent('remote', { detail: changed }));
    } catch (err) {
      await this.refreshPending();
      if (err instanceof TypeError || err.name === 'AbortError') {
        // network failure: offline, server down, TLS/CORS problem …
        this.emitStatus(navigator.onLine ? 'unreachable' : 'offline', err.message);
      } else {
        this.emitStatus('error', err.message, err.code || '');
      }
    }
  }

  /** One GET → merge → (PUT). Returns false on a write conflict (412). */
  async round(endpoint, keys, changed) {
    const etag = await db.kvGet('etag');
    const now = Date.now();
    const sent = await db.getAll('outbox'); // markers covered by this round
    const res = await request(endpoint, keys.token, { method: 'GET', headers: etag ? { 'If-None-Match': etag } : {} });

    let dirty;
    let remoteEtag = null;
    if (res.status === 304) {
      remoteEtag = etag;
      dirty = (await db.count('outbox')) > 0;
    } else if (res.status === 404) {
      dirty = (await db.getAll('records')).some((r) => !prunable(r, now));
    } else if (res.ok) {
      remoteEtag = res.headers.get('ETag');
      const remote = await decrypt(keys.aes, new Uint8Array(await res.arrayBuffer()));
      changed.push(...await db.applyRemote(remote.records || []));
      // does this device know something the vault doesn't?
      const inVault = new Map((remote.records || []).map((r) => [`${r.kind}\u0000${r.id}`, r.updatedAt]));
      dirty = (await db.getAll('records')).some((r) => !prunable(r, now) && !(inVault.get(`${r.kind}\u0000${r.id}`) >= r.updatedAt));
    } else {
      throw await httpError(res);
    }

    if (!dirty) {
      await db.kvSet('etag', remoteEtag);
      await db.outboxAck(sent);
      return true;
    }

    // Snapshot everything this device has (it now includes the vault's content).
    const records = await db.prune((r) => prunable(r, now));
    const blob = await encrypt(keys.aes, { v: 1, at: now, records });
    const put = await request(endpoint, keys.token, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': 'application/octet-stream', ...(remoteEtag ? { 'If-Match': remoteEtag } : { 'If-None-Match': '*' }) },
    });
    if (put.status === 412) {
      await db.kvDel('etag'); // force a full download
      return false;
    }
    if (!put.ok) throw await httpError(put);
    await db.kvSet('etag', put.headers.get('ETag') || (await put.json()).etag);
    await db.outboxAck(sent);
    return true;
  }

  async deriveKeys(key) {
    if (this.keys?.forKey === key) return this.keys;
    const base = await crypto.subtle.importKey('raw', b64uDecode(key), 'HKDF', false, ['deriveBits', 'deriveKey']);
    const hkdf = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(`newsreader-sync-v1 ${info}`) });
    const token = b64uEncode(new Uint8Array(await crypto.subtle.deriveBits(hkdf('auth'), base, 256)));
    const aes = await crypto.subtle.deriveKey(hkdf('enc'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    this.keys = { forKey: key, token, aes };
    return this.keys;
  }

  // ------------------------------------------------------------ vault handling

  async createVault() {
    await this.joinVault(randomKey());
  }

  async joinVault(key) {
    if (!isValidKey(key)) throw new Error('Invalid vault key.');
    await db.kvSet('vaultKey', key);
    await db.kvDel('etag');
    await db.outboxAll(); // merge: everything local goes up, last write wins
    return this.run();
  }

  async leaveVault() {
    await db.kvDel('vaultKey');
    await db.kvDel('etag');
    await db.outboxClear();
    this.keys = null;
    await this.refreshPending();
    this.emitStatus('local');
  }

  async wipeServer() {
    const key = await db.kvGet('vaultKey');
    if (!key) return;
    const res = await request(await syncEndpoint(), (await this.deriveKeys(key)).token, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw await httpError(res);
    await db.kvDel('etag');
  }
}

// ------------------------------------------------------------ records

/** Deterministic on every device, so pruned records cannot be resurrected by an old device. */
function prunable(r, now) {
  if (now - r.updatedAt < PRUNE_AFTER_MS) return false;
  if (r.kind === 'item') return r.data?.s === 'done' || r.data?.s === 'dismissed' || r.data?.s === 'new';
  if (r.kind === 'feed') return !!r.data?.d;
  return false;
}

// ------------------------------------------------------------ crypto

export function cryptoAvailable() {
  return !!(window.isSecureContext && crypto?.subtle);
}

async function encrypt(aes, obj) {
  let plain = new TextEncoder().encode(JSON.stringify(obj));
  let flags = 0;
  if ('CompressionStream' in window) {
    plain = new Uint8Array(await new Response(new Blob([plain]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    flags |= FLAG_GZIP;
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, aes, plain));
  const out = new Uint8Array(4 + 1 + 12 + ct.length);
  out.set(MAGIC, 0);
  out[4] = flags;
  out.set(iv, 5);
  out.set(ct, 17);
  return out;
}

async function decrypt(aes, buf) {
  if (buf.length < 33 || MAGIC.some((b, i) => buf[i] !== b)) throw Object.assign(new Error('Unknown vault format on the server.'), { code: 'format' });
  const flags = buf[4];
  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(5, 17), additionalData: AAD }, aes, buf.slice(17)));
  } catch {
    throw Object.assign(new Error('Vault could not be decrypted – wrong key or damaged data.'), { code: 'decrypt' });
  }
  if (flags & FLAG_GZIP) {
    plain = new Uint8Array(await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

// ------------------------------------------------------------ helpers

export async function serverBase() {
  const s = await db.kvGet('server');
  return s || defaultServer();
}

export function defaultServer() {
  // News is served from <server>/app/ → the server is one level up.
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
  try { body = await res.json(); } catch { /* not JSON */ }
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

export function randomKey() {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export function isValidKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key);
}
