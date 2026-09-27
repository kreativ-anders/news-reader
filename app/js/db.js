// INFO: stores – records (synced feeds/items), outbox (unsynced changes), entries (per device),
//       kv (local settings incl. vault key), articles (offline copies, per device)

export const DB_NAME = 'news';
const DB_VERSION = 2;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: ['kind', 'id'] });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: ['kind', 'id'] });
      if (!db.objectStoreNames.contains('entries')) {
        const s = db.createObjectStore('entries', { keyPath: 'id' });
        s.createIndex('feedId', 'feedId');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('articles')) db.createObjectStore('articles', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database blocked – close other News tabs.'));
  });
  return dbPromise;
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const txDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
});

export async function getAll(store) {
  const db = await open();
  return done(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, key) {
  const db = await open();
  return done(db.transaction(store).objectStore(store).get(key));
}

export async function count(store) {
  const db = await open();
  return done(db.transaction(store).objectStore(store).count());
}

export async function write(stores, fn) {
  const db = await open();
  const tx = db.transaction(stores, 'readwrite');
  const result = fn(tx);
  await txDone(tx);
  return result;
}

export async function kvGet(k, fallback = null) {
  const row = await get('kv', k);
  return row ? row.v : fallback;
}

export async function kvSet(k, v) {
  return write(['kv'], (tx) => tx.objectStore('kv').put({ k, v }));
}

export async function kvDel(k) {
  return write(['kv'], (tx) => tx.objectStore('kv').delete(k));
}

export async function putLocal(records) {
  return write(['records', 'outbox'], (tx) => {
    const rs = tx.objectStore('records');
    const ob = tx.objectStore('outbox');
    for (const r of records) {
      rs.put(r);
      ob.put({ kind: r.kind, id: r.id, updatedAt: r.updatedAt });
    }
  });
}

// INFO: a marker is only removed if the record was not changed again meanwhile
export async function outboxAck(markers) {
  if (!markers.length) return;
  const db = await open();
  const tx = db.transaction(['outbox'], 'readwrite');
  const ob = tx.objectStore('outbox');
  const cur = new Map((await done(ob.getAll())).map((m) => [key(m), m.updatedAt]));
  for (const m of markers) if (cur.get(key(m)) === m.updatedAt) ob.delete([m.kind, m.id]);
  return txDone(tx);
}

export async function outboxClear() {
  return write(['outbox'], (tx) => tx.objectStore('outbox').clear());
}

// INFO: returns the remaining records – the snapshot that goes into the sync vault
export async function prune(drop) {
  const db = await open();
  const tx = db.transaction(['records', 'outbox'], 'readwrite');
  const all = await done(tx.objectStore('records').getAll());
  const keep = [];
  for (const r of all) {
    if (drop(r)) {
      tx.objectStore('records').delete([r.kind, r.id]);
      tx.objectStore('outbox').delete([r.kind, r.id]);
    } else {
      keep.push(r);
    }
  }
  await txDone(tx);
  return keep;
}

export async function outboxAll() {
  const all = await getAll('records');
  return write(['outbox'], (tx) => {
    const ob = tx.objectStore('outbox');
    for (const r of all) ob.put({ kind: r.kind, id: r.id, updatedAt: r.updatedAt });
  });
}

// INFO: last write wins; malformed records, timestamps too far in the future and skip(r) are ignored.
//       A local record with such a timestamp (accepted before this check) loses against any valid one.
export async function applyRemote(records, skip = () => false) {
  const now = Date.now();
  const db = await open();
  const tx = db.transaction(['records'], 'readwrite');
  const rs = tx.objectStore('records');
  const cur = new Map((await done(rs.getAll())).map((r) => [key(r), r.updatedAt]));
  const applied = [];
  for (const r of records) {
    if (!validRecord(r, now) || skip(r)) continue;
    const t = cur.get(key(r));
    if (t === undefined || r.updatedAt > t || t > now + MAX_SKEW_MS) {
      rs.put(r);
      cur.set(key(r), r.updatedAt);
      applied.push(r);
    }
  }
  await txDone(tx);
  return applied;
}

export async function putEntries(entries, removeIds = []) {
  return write(['entries'], (tx) => {
    const s = tx.objectStore('entries');
    for (const e of entries) s.put(e);
    for (const id of removeIds) s.delete(id);
  });
}

export async function entriesForFeed(feedId) {
  const db = await open();
  return done(db.transaction('entries').objectStore('entries').index('feedId').getAll(feedId));
}

export async function deleteEntriesForFeed(feedId) {
  const ids = (await entriesForFeed(feedId)).map((e) => e.id);
  return putEntries([], ids);
}

const key = (r) => `${r.kind}\u0000${r.id}`;

export const MAX_SKEW_MS = 864e5;
export const ITEM_STATES = ['new', 'reading', 'later', 'done', 'dismissed'];

const str = (v) => typeof v === 'string';
const optStr = (v) => v == null || str(v);
const num = (v) => Number.isFinite(v) && Math.abs(v) < 8.64e15;
const optNum = (v) => v == null || num(v);
const optFlag = (v) => v == null || v === 0 || v === 1 || v === false || v === true;
const SCHEMA = {
  feed: (d) => str(d.url) && optStr(d.title) && optStr(d.g) && optNum(d.since) && optNum(d.added) && optFlag(d.d),
  item: (d) => ITEM_STATES.includes(d.s) && optStr(d.t) && optStr(d.u) && optStr(d.i) && optStr(d.f) && (optStr(d.p) || num(d.p)),
  device: (d) => optStr(d.name) && optStr(d.platform) && optStr(d.pub) && optNum(d.since) && optNum(d.seen) && optFlag(d.r),
};

// INFO: shape check for records from the vault (written by other devices); unknown extra fields are kept
export function validRecord(r, now = Date.now()) {
  return !!r && typeof r === 'object' && Object.hasOwn(SCHEMA, r.kind) && str(r.id) && r.id.length > 0 && r.id.length <= 200
    && num(r.updatedAt) && r.updatedAt >= 0 && r.updatedAt <= now + MAX_SKEW_MS
    && !!r.data && typeof r.data === 'object' && !Array.isArray(r.data) && SCHEMA[r.kind](r.data);
}
