import { extension_settings, saveSettingsDebounced } from './st.js';

// 收藏/标签存 extension_settings，随 ST 设置持久化到服务器端 settings.json
const KEY = 'tavernArchive';

const defaults = () => ({
    favorites: {},    // chatKey -> { note, addedAt }
    chatTags: {},     // chatKey -> [tagName]
    tags: {},         // tagName -> { color }
    msgFavorites: {}, // chatKey -> { [msgIdx]: { note, addedAt } }
    lastIndexAt: 0,
});

export function getSettings() {
    const d = defaults();
    extension_settings[KEY] ??= d;
    const s = extension_settings[KEY];
    for (const k of Object.keys(d)) {
        s[k] ??= d[k];
    }
    return s;
}

export function save() {
    saveSettingsDebounced();
}

// ---------- 标签 ----------

const TAG_PALETTE = ['#e0a060', '#6aa9e0', '#7dc383', '#d97b8f', '#b58ce0', '#e0cf6a', '#6ac8c8', '#e08a6a'];

export function ensureTag(name) {
    const s = getSettings();
    if (!s.tags[name]) {
        const used = Object.keys(s.tags).length;
        s.tags[name] = { color: TAG_PALETTE[used % TAG_PALETTE.length] };
    }
    return s.tags[name];
}

export function renameTag(oldName, newName) {
    const s = getSettings();
    if (!s.tags[oldName] || s.tags[newName]) return false;
    s.tags[newName] = s.tags[oldName];
    delete s.tags[oldName];
    for (const key of Object.keys(s.chatTags)) {
        s.chatTags[key] = s.chatTags[key].map(t => (t === oldName ? newName : t));
    }
    save();
    return true;
}

export function deleteTag(name) {
    const s = getSettings();
    delete s.tags[name];
    for (const key of Object.keys(s.chatTags)) {
        s.chatTags[key] = s.chatTags[key].filter(t => t !== name);
        if (s.chatTags[key].length === 0) delete s.chatTags[key];
    }
    save();
}

export function setTagColor(name, color) {
    const s = getSettings();
    ensureTag(name);
    s.tags[name].color = color;
    save();
}

export function addChatTag(chatKey, tag) {
    const s = getSettings();
    ensureTag(tag);
    s.chatTags[chatKey] ??= [];
    if (!s.chatTags[chatKey].includes(tag)) {
        s.chatTags[chatKey].push(tag);
    }
    save();
}

export function removeChatTag(chatKey, tag) {
    const s = getSettings();
    if (!s.chatTags[chatKey]) return;
    s.chatTags[chatKey] = s.chatTags[chatKey].filter(t => t !== tag);
    if (s.chatTags[chatKey].length === 0) delete s.chatTags[chatKey];
    save();
}

// ---------- 聊天收藏 ----------

export function toggleChatFav(chatKey) {
    const s = getSettings();
    if (s.favorites[chatKey]) {
        delete s.favorites[chatKey];
    } else {
        s.favorites[chatKey] = { note: '', addedAt: Date.now() };
    }
    save();
    return !!s.favorites[chatKey];
}

export function setChatNote(chatKey, note) {
    const s = getSettings();
    if (s.favorites[chatKey]) {
        s.favorites[chatKey].note = note;
        save();
    }
}

// ---------- 消息收藏 ----------

export function toggleMsgFav(chatKey, msgIdx) {
    const s = getSettings();
    s.msgFavorites[chatKey] ??= {};
    if (s.msgFavorites[chatKey][msgIdx]) {
        delete s.msgFavorites[chatKey][msgIdx];
        if (Object.keys(s.msgFavorites[chatKey]).length === 0) delete s.msgFavorites[chatKey];
    } else {
        s.msgFavorites[chatKey][msgIdx] = { note: '', addedAt: Date.now() };
    }
    save();
    return !!s.msgFavorites[chatKey]?.[msgIdx];
}

export function isMsgFav(chatKey, msgIdx) {
    return !!getSettings().msgFavorites[chatKey]?.[msgIdx];
}

// ---------- 失效数据清理 ----------

/** 返回指向已不存在聊天的 key 列表（不删除） */
export function getOrphans(validChatKeys) {
    const s = getSettings();
    const orphans = [];
    for (const key of Object.keys(s.favorites)) {
        if (!validChatKeys.has(key)) orphans.push({ kind: '收藏', key });
    }
    for (const key of Object.keys(s.chatTags)) {
        if (!validChatKeys.has(key)) orphans.push({ kind: '标签', key });
    }
    for (const key of Object.keys(s.msgFavorites)) {
        if (!validChatKeys.has(key)) orphans.push({ kind: '消息收藏', key });
    }
    return orphans;
}

export function pruneOrphans(validChatKeys) {
    const s = getSettings();
    let removed = 0;
    for (const store of [s.favorites, s.chatTags, s.msgFavorites]) {
        for (const key of Object.keys(store)) {
            if (!validChatKeys.has(key)) {
                delete store[key];
                removed++;
            }
        }
    }
    if (removed) save();
    return removed;
}
