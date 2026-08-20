import { getCurrentUserHandle } from './st.js';

// IndexedDB 持久化：meta（聊天元数据）+ messages（消息内容），按用户 handle 分库
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
    let handle = 'default-user';
    try {
        handle = getCurrentUserHandle?.() || 'default-user';
    } catch { /* 用户模块未就绪时用默认库 */ }
    const name = `tavern-archive-${handle}`;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('meta')) {
                db.createObjectStore('meta', { keyPath: 'chatKey' });
            }
            if (!db.objectStoreNames.contains('messages')) {
                db.createObjectStore('messages', { keyPath: 'chatKey' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function getDb() {
    dbPromise ??= openDb();
    return dbPromise;
}

export async function idbGetAll(store) {
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

export async function idbPut(store, value) {
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function idbDelete(store, key) {
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function idbClear(store) {
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
