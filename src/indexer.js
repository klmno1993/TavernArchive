import { getContext } from './st.js';
import { fetchChatList, fetchGroupChatList, fetchChatContent, fetchGroupChatContent } from './api.js';
import { idbGetAll, idbPut, idbDelete, idbClear } from './store.js';
import { state, emit, emitSoon } from './state.js';
import { getSettings, save } from './settings.js';
import { parseLooseDate } from './util.js';

export const charChatKey = (avatar, fileId) => `c::${avatar}::${fileId}`;
export const groupChatKey = (groupId, chatId) => `g::${groupId}::${chatId}`;

/** 从 IndexedDB 恢复索引到内存 */
export async function loadFromDb() {
    try {
        const [metas, msgs] = await Promise.all([idbGetAll('meta'), idbGetAll('messages')]);
        state.chats = new Map(metas.map(m => [m.chatKey, m]));
        state.messages = new Map(msgs.map(m => [m.chatKey, m.messages]));
    } catch (e) {
        console.error('[TavernArchive] IndexedDB 加载失败', e);
    }
    state.ready = true;
    emit();
}

/** 清空并全量重建 */
export async function rebuildIndex() {
    await idbClear('meta');
    await idbClear('messages');
    state.chats.clear();
    state.messages.clear();
    await refreshIndex({ force: true });
}

/**
 * 增量刷新：拉元数据比对，只重拉变化的聊天，剔除已删除的。
 */
export async function refreshIndex({ force = false } = {}) {
    if (state.indexing) return;
    state.indexing = true;
    state.progress = { done: 0, total: 0, label: '正在读取聊天列表…' };
    emit();
    try {
        const ctx = getContext();
        const entities = [
            ...(ctx.characters ?? []).map(c => ({ type: 'char', avatar: c.avatar, name: c.name })),
            ...(ctx.groups ?? []).map(g => ({ type: 'group', id: g.id, name: g.name })),
        ].filter(e => (e.type === 'char' ? !!e.avatar : !!e.id));

        console.log(`[TavernArchive] 开始索引：${entities.length} 个实体（${(ctx.characters ?? []).length} 角色 / ${(ctx.groups ?? []).length} 群聊）`);
        if (entities.length === 0) {
            console.warn('[TavernArchive] 角色/群聊列表为空——可能是 ST 尚未加载完成，稍后会自动重试');
            return;
        }

        let listFailCount = 0;
        const listings = await mapLimit(entities, 6, async (ent) => {
            try {
                const list = ent.type === 'char'
                    ? await fetchChatList(ent.avatar)
                    : await fetchGroupChatList(ent.id);
                return { ent, list: Array.isArray(list) ? list : [] };
            } catch (e) {
                listFailCount++;
                console.warn('[TavernArchive] 聊天列表获取失败', ent, e);
                return { ent, list: [] };
            }
        });
        const listedCount = listings.reduce((n, l) => n + l.list.length, 0);
        console.log(`[TavernArchive] 聊天列表拉取完成：共 ${listedCount} 个聊天，失败 ${listFailCount} 个实体`);

        const seen = new Set();
        const todo = [];
        for (const { ent, list } of listings) {
            for (const item of list) {
                const fileId = String(item.file_name ?? '').replace(/\.jsonl$/i, '');
                if (!fileId) continue;
                const chatKey = ent.type === 'char'
                    ? charChatKey(ent.avatar, fileId)
                    : groupChatKey(ent.id, fileId);
                seen.add(chatKey);
                const meta = {
                    chatKey,
                    type: ent.type,
                    avatar: ent.avatar ?? null,
                    charName: ent.name ?? '',
                    groupId: ent.id ?? null,
                    groupName: ent.name ?? '',
                    fileId,
                    fileName: `${fileId}.jsonl`,
                    messageCount: item.message_count ?? 0,
                    lastMes: item.last_mes ?? null,
                    fileSize: item.file_size ?? '',
                    indexedAt: Date.now(),
                };
                const prev = state.chats.get(chatKey);
                const changed = force
                    || !prev
                    || prev.messageCount !== meta.messageCount
                    || prev.lastMes !== meta.lastMes
                    || prev.fileSize !== meta.fileSize;
                if (changed || !state.messages.has(chatKey)) {
                    todo.push({ ent, meta });
                }
            }
        }

        // 剔除已删除的聊天
        for (const key of [...state.chats.keys()]) {
            if (!seen.has(key)) {
                state.chats.delete(key);
                state.messages.delete(key);
                await idbDelete('meta', key);
                await idbDelete('messages', key);
            }
        }

        state.progress = { done: 0, total: todo.length, label: todo.length ? '正在下载聊天内容…' : '没有需要更新的聊天' };
        emit();

        await mapLimit(todo, 4, async ({ ent, meta }) => {
            try {
                const raw = ent.type === 'char'
                    ? await fetchChatContent(ent.name, ent.avatar, meta.fileId)
                    : await fetchGroupChatContent(meta.fileId);
                const messages = parseChatContent(raw);
                state.chats.set(meta.chatKey, meta);
                state.messages.set(meta.chatKey, messages);
                await idbPut('meta', meta);
                await idbPut('messages', { chatKey: meta.chatKey, messages });
            } catch (e) {
                console.warn('[TavernArchive] 聊天内容获取失败', meta.chatKey, e);
            }
            state.progress.done++;
            state.progress.label = meta.type === 'char' ? meta.charName : meta.groupName;
            emitSoon();
        });
        console.log(`[TavernArchive] 索引完成：${state.chats.size} 个聊天在索引中，本轮更新 ${todo.length} 个`);

        const s = getSettings();
        s.lastIndexAt = Date.now();
        save();
        state.lastRefresh = Date.now();
    } finally {
        state.indexing = false;
        state.progress = null;
        emit();
    }
}

/**
 * 解析聊天内容为消息数组。i 保持与 ST 的 chat 数组下标一致（对应 DOM 的 mesid）。
 * 跳过 chat_metadata 头与 is_system 消息；text 取当前 swipe。
 */
export function parseChatContent(raw) {
    if (!Array.isArray(raw)) return [];
    const arr = [...raw];
    if (arr.length && arr[0] && typeof arr[0] === 'object'
        && (arr[0].chat_metadata !== undefined || arr[0].mes === undefined)) {
        arr.shift();
    }
    const out = [];
    arr.forEach((m, idx) => {
        if (!m || typeof m !== 'object' || m.is_system) return;
        let text = m.mes;
        if (Array.isArray(m.swipes) && typeof m.swipe_id === 'number' && m.swipes[m.swipe_id] !== undefined) {
            text = m.swipes[m.swipe_id];
        }
        out.push({
            i: idx,
            name: String(m.name ?? ''),
            isUser: !!m.is_user,
            ts: parseLooseDate(m.send_date),
            text: String(text ?? ''),
        });
    });
    return out;
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
            const cur = i++;
            results[cur] = await fn(items[cur]);
        }
    });
    await Promise.all(workers);
    return results;
}
