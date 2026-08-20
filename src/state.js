// 内存中的全量索引状态 + 简单订阅通知
export const state = {
    ready: false,        // IndexedDB 已加载进内存
    indexing: false,
    progress: null,      // { done, total, label }
    chats: new Map(),    // chatKey -> meta
    messages: new Map(), // chatKey -> [{ i, name, isUser, ts, text }]
    lastRefresh: 0,
};

const listeners = new Set();

export function onState(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function emit() {
    for (const fn of listeners) fn(state);
}

// 高频进度更新用节流版本，避免 UI 被刷爆
let throttleTimer = null;
export function emitSoon() {
    if (throttleTimer) return;
    throttleTimer = setTimeout(() => {
        throttleTimer = null;
        emit();
    }, 120);
}
