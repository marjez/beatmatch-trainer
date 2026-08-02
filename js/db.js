// db.js — IndexedDB persistence for the crate (audio blobs + metadata) and round stats.
// Tracks survive app restarts and work fully offline once loaded.

const DB_NAME = 'beatmatch-trainer';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) {
        db.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('rounds')) {
        db.createObjectStore('rounds', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
  });
}

export async function addTrack({ name, bpm, bpmSource, blob }) {
  const db = await openDB();
  return tx(db, 'tracks', 'readwrite', s => s.add({ name, bpm, bpmSource, blob, added: Date.now() }));
}

export async function getAllTracks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('tracks').objectStore('tracks').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function updateTrack(track) {
  const db = await openDB();
  return tx(db, 'tracks', 'readwrite', s => s.put(track));
}

export async function deleteTrack(id) {
  const db = await openDB();
  return tx(db, 'tracks', 'readwrite', s => s.delete(id));
}

export async function saveRound({ score, err, mode, aName, bName }) {
  const db = await openDB();
  return tx(db, 'rounds', 'readwrite', s =>
    s.add({ score, err, mode, aName, bName, at: Date.now() }));
}

export async function getRounds(limit = 500) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('rounds').objectStore('rounds').getAll();
    req.onsuccess = () => resolve(req.result.slice(-limit));
    req.onerror = () => reject(req.error);
  });
}

// Ask the browser not to evict our storage (iOS can clear unused site data).
export async function requestPersistence() {
  if (navigator.storage && navigator.storage.persist) {
    try { return await navigator.storage.persist(); } catch { return false; }
  }
  return false;
}
