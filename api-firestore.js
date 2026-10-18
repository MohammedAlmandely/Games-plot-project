// GamesPlot Firestore compatibility layer backed by the local REST API + MySQL.
// Firebase Auth stays in the browser; all site data goes through the API.
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const API_BASE = window.GAMESPLOT_API_BASE ||
  ((location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:3000'
    : 'gamesplot-api-production.up.railway.app');

class ApiTimestamp {
  constructor(value) { this.value = value ? new Date(value) : new Date(); }
  toDate() { return new Date(this.value); }
  toMillis() { return this.value.getTime(); }
}

function revive(value, key = '') {
  if (Array.isArray(value)) return value.map(v => revive(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = revive(v, k);
    return out;
  }
  if (typeof value === 'string' && ['timestamp', 'createdAt', 'lastActivity'].includes(key)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return new ApiTimestamp(value);
  }
  return value;
}

async function authHeaders(extra = {}) {
  const auth = getAuth();
  const user = auth.currentUser;
  if (!user) throw new Error('AUTH_REQUIRED');
  const token = await user.getIdToken();
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function request(path, options = {}, allow404 = false) {
  const headers = await authHeaders(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' });
  const res = await fetch(API_BASE + path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  if (allow404 && res.status === 404) return null;
  let payload = null;
  try { payload = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(payload?.error || payload?.message || `API ${res.status}`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

export function getFirestore() { return { __api: true }; }
export function collection(_db, name) { return { type: 'collection', name }; }

export function doc(a, b, c) {
  if (a?.type === 'collection' && b === undefined) {
    return { type: 'doc', collection: a.name, id: null, auto: true };
  }
  if (a?.type === 'collection') {
    return { type: 'doc', collection: a.name, id: String(b), auto: false };
  }
  return { type: 'doc', collection: b, id: String(c), auto: false };
}

export function where(field, op, value) { return { type: 'where', field, op, value }; }
export function orderBy(field, direction = 'asc') { return { type: 'orderBy', field, direction }; }
export function limit(value) { return { type: 'limit', value }; }
export function query(ref, ...constraints) { return { type: 'query', collection: ref.name, constraints }; }
export function serverTimestamp() { return { __op: 'serverTimestamp' }; }
export function increment(value) { return { __op: 'increment', value: Number(value) }; }

class DocumentSnapshot {
  constructor(ref, raw) { this.ref = ref; this.id = ref.id; this._raw = raw; }
  exists() { return this._raw !== null && this._raw !== undefined; }
  data() { return this.exists() ? revive(this._raw) : undefined; }
}

class QueryDocumentSnapshot extends DocumentSnapshot {
  constructor(collectionName, raw) {
    const ref = { type: 'doc', collection: collectionName, id: String(raw.id), auto: false };
    const data = { ...raw }; delete data.id;
    super(ref, data);
  }
}

class QuerySnapshot {
  constructor(collectionName, docs) {
    this.docs = (docs || []).map(d => new QueryDocumentSnapshot(collectionName, d));
    this.empty = this.docs.length === 0;
    this.size = this.docs.length;
  }
  forEach(cb) { this.docs.forEach(cb); }
}

function normalizeQuery(ref) {
  if (ref?.type === 'collection') return { collection: ref.name, filters: [], order: null, limit: null };
  if (ref?.type !== 'query') throw new Error('Invalid query reference');
  const out = { collection: ref.collection, filters: [], order: null, limit: null };
  for (const c of ref.constraints || []) {
    if (c.type === 'where') out.filters.push({ field: c.field, op: c.op, value: c.value });
    else if (c.type === 'orderBy') out.order = { field: c.field, direction: c.direction };
    else if (c.type === 'limit') out.limit = c.value;
  }
  return out;
}

export async function getDocs(ref) {
  const q = normalizeQuery(ref);
  const payload = await request('/api/query', { method: 'POST', body: JSON.stringify(q) });
  return new QuerySnapshot(q.collection, payload?.docs || []);
}

export async function getDoc(ref) {
  const raw = await request(`/api/doc/${encodeURIComponent(ref.collection)}/${encodeURIComponent(ref.id)}`, { method: 'GET' }, true);
  return new DocumentSnapshot(ref, raw?.doc ?? null);
}

export async function addDoc(ref, data) {
  const payload = await request('/api/doc', {
    method: 'POST', body: JSON.stringify({ collection: ref.name, data })
  });
  return { type: 'doc', collection: ref.name, id: String(payload.id), auto: false };
}

export async function setDoc(ref, data) {
  if (ref.auto || ref.id === null) {
    const payload = await request('/api/doc', {
      method: 'POST', body: JSON.stringify({ collection: ref.collection, data })
    });
    ref.id = String(payload.id); ref.auto = false;
    return;
  }
  await request(`/api/doc/${encodeURIComponent(ref.collection)}/${encodeURIComponent(ref.id)}`, {
    method: 'PUT', body: JSON.stringify({ data })
  });
}

export async function updateDoc(ref, data) {
  await request(`/api/doc/${encodeURIComponent(ref.collection)}/${encodeURIComponent(ref.id)}`, {
    method: 'PATCH', body: JSON.stringify({ data })
  });
}

export async function deleteDoc(ref) {
  await request(`/api/doc/${encodeURIComponent(ref.collection)}/${encodeURIComponent(ref.id)}`, { method: 'DELETE' }, true);
}

export function writeBatch() {
  const ops = [];
  return {
    delete(ref) { ops.push({ type: 'delete', ref }); },
    update(ref, data) { ops.push({ type: 'update', ref, data }); },
    set(ref, data) { ops.push({ type: 'set', ref, data }); },
    async commit() {
      for (const op of ops) {
        if (op.type === 'delete') await deleteDoc(op.ref);
        else if (op.type === 'update') await updateDoc(op.ref, op.data);
        else await setDoc(op.ref, op.data);
      }
    }
  };
}

export function onSnapshot(ref, callback, onError) {
  let stopped = false;
  let timer = null;
  let last = null;

  const run = async () => {
    if (stopped) return;
    try {
      if (ref?.type === 'doc') {
        const snap = await getDoc(ref);
        const rawKey = JSON.stringify(snap.exists() ? snap._raw : null);
        if (rawKey !== last) { last = rawKey; callback(snap); }
      } else {
        const snap = await getDocs(ref);
        const rawKey = JSON.stringify(snap.docs.map(d => ({ id: d.id, data: d._raw })));
        if (rawKey !== last) { last = rawKey; callback(snap); }
      }
    } catch (e) {
      if (onError) onError(e); else console.error(e);
    } finally {
      if (!stopped) timer = setTimeout(run, 3500);
    }
  };
  run();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
