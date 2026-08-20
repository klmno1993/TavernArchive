import { getRequestHeaders } from './st.js';

async function post(url, body = {}) {
    const res = await fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`${url} -> HTTP ${res.status}`);
    }
    return res.json();
}

/** 某角色下全部聊天文件的元数据（空 query 即列出全部） */
export function fetchChatList(avatarUrl) {
    return post('/api/chats/search', { query: '', avatar_url: avatarUrl, group_id: null });
}

/** 某群聊下全部聊天文件的元数据 */
export function fetchGroupChatList(groupId) {
    return post('/api/chats/search', { query: '', avatar_url: null, group_id: groupId });
}

/** 角色聊天完整内容，fileId 不带 .jsonl */
export function fetchChatContent(charName, avatarUrl, fileId) {
    return post('/api/chats/get', { ch_name: charName, file_name: fileId, avatar_url: avatarUrl });
}

/** 群聊聊天完整内容，chatId 不带 .jsonl */
export function fetchGroupChatContent(chatId) {
    return post('/api/chats/group/get', { id: chatId });
}
