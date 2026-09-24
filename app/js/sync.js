// Flint – sync engine against Feedforge /api/sync.
//
// Push: pending local changes (outbox) → POST /api/sync (server merges last-write-wins).
// Pull: GET /api/sync?since=<cursor> → merge last-write-wins into IndexedDB.
// No account: every device that knows the vault key shares the same state.

import * as db from './db.js';

const PUSH_BATCH = 200;
const PULL_LIMIT = 500;

export class Sync extends EventTarget {
  constructor() {
    super();
    this.status = { state: 'local', pending: 0, lastSync: null, message: '' };
    this.running = null;
    this.again = false;
    this.debounce = null;
  }

  async init() {
    this.status.lastSync = await db.kvGet('lastSync', null);
    await this.refreshPending();
    this.emitStatus(await db.kvGet('vaultKey') ? 'idle' : 'local');
  }

  async refreshPending() {
    this.status.pending = await db.count('outbox');
  }

  emitStatus(state, message = '') {
    this.status.state = state;
    this.status.message = message;
    this.dispatchEvent(new CustomEvent('status', { detail: { ...this.status } }));
  }

  /** Call after every local change: sync shortly after the user stops clicking. */
  schedule(delay = 1500) {
    clearTimeout(this.debounce);
    this.refreshPending().then(() => this.emitStatus(this.status.state === 'syncing' ? 'syncing' : this.status.state));
    this.debounce = setTimeout(() => this.run(), delay);
  }

  /** Run one sync; concurrent calls are coalesced into one follow-up run. */
  run() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.runOnce()
      .finally(() => {
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
    if (!navigator.onLine) return this.emitStatus('offline');

    const endpoint = await syncEndpoint();
    this.emitStatus('syncing');
    try {
      await this.push(endpoint, key);
      const changed = await this.pull(endpoint, key);
      this.status.lastSync = Date.now();
      await db.kvSet('lastSync', this.status.lastSync);
      await this.refreshPending();
      this.emitStatus('ok');
      if (changed.length) this.dispatchEvent(new CustomEvent('remote', { detail: changed }));
    } catch (err) {
      await this.refreshPending();
      if (err instanceof TypeError || err.name === 'AbortError') {
        // network failure: not at home, server down, TLS/CORS problem …
        this.emitStatus(navigator.onLine ? 'unreachable' : 'offline', err.message);
      } else {
        this.emitStatus('error', err.message);
      }
    }
  }

  async push(endpoint, key) {
    for (;;) {
      const batch = await db.outboxBatch(PUSH_BATCH);
      if (!batch.length) return;
      const records = batch.filter((b) => b.record).map((b) => ({
        kind: b.record.kind, id: b.record.id, data: b.record.data, updatedAt: b.record.updatedAt,
      }));
      if (records.length) {
        const res = await request(endpoint, key, { method: 'POST', body: JSON.stringify({ records }) });
        await this.checkEpoch(res.epoch);
      }
      await db.outboxAck(batch.map((b) => b.marker));
      await this.refreshPending();
      this.emitStatus('syncing');
    }
  }

  async pull(endpoint, key) {
    const changed = [];
    for (let guard = 0; guard < 1000; guard++) {
      const cursor = await db.kvGet('cursor', 0);
      const res = await request(`${endpoint}?since=${cursor}&limit=${PULL_LIMIT}`, key, { method: 'GET' });
      if (await this.checkEpoch(res.epoch)) {
        // server database was reset → upload everything we have, then pull from scratch
        await this.push(endpoint, key);
        continue;
      }
      changed.push(...await db.applyRemote(res.records));
      await db.kvSet('cursor', res.cursor);
      if (!res.more) break;
    }
    return changed;
  }

  /** Detect a replaced server database. Returns true if local sync state was reset. */
  async checkEpoch(epoch) {
    if (!epoch) return false;
    const known = await db.kvGet('epoch');
    if (known === epoch) return false;
    await db.kvSet('epoch', epoch);
    if (known === null) return false;
    await db.kvSet('cursor', 0);
    await db.outboxAll();
    return true;
  }

  // ------------------------------------------------------------ vault handling

  async createVault() {
    await this.joinVault(randomKey());
  }

  async joinVault(key) {
    if (!isValidKey(key)) throw new Error('Invalid vault key.');
    await db.kvSet('vaultKey', key);
    await db.kvSet('cursor', 0);
    await db.kvDel('epoch');
    await db.outboxAll(); // merge: everything local goes up, LWW decides
    return this.run();
  }

  async leaveVault() {
    await db.kvDel('vaultKey');
    await db.kvDel('cursor');
    await db.kvDel('epoch');
    await db.write(['outbox'], (tx) => tx.objectStore('outbox').clear());
    await this.refreshPending();
    this.emitStatus('local');
  }

  async wipeServer() {
    const key = await db.kvGet('vaultKey');
    if (!key) return;
    await request(await syncEndpoint(), key, { method: 'DELETE' });
  }
}

// ------------------------------------------------------------ helpers

export async function serverBase() {
  const s = await db.kvGet('server');
  return s || defaultServer();
}

export function defaultServer() {
  // Flint is served from <feedforge>/app/ → the server is one level up.
  return new URL('../', location.href).href;
}

async function syncEndpoint() {
  return new URL('api/sync', await serverBase()).href;
}

async function request(url, key, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      const msg = body?.error?.message || `HTTP ${res.status}`;
      throw Object.assign(new Error(msg), { status: res.status, code: body?.error?.code });
    }
    if (!body) throw new Error('Unexpected response from sync server.');
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isValidKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(key);
}
