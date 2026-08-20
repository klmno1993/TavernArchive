import { getContext, selectCharacterById, openCharacterChat, openGroupChat, showMoreMessages } from './st.js';

/**
 * 跳转到某条消息：打开对应角色/群聊的对应聊天，滚动定位并闪烁高亮。
 * 注意 ST 对长聊天分页渲染（默认只渲染最后 100 条），早期消息需循环 showMoreMessages。
 */
export async function jumpToMessage(meta, msgIdx) {
    const ctx = getContext();
    try {
        if (meta.type === 'char') {
            const id = (ctx.characters ?? []).findIndex(c => c.avatar === meta.avatar);
            if (id === -1) {
                toastr.warning('该角色卡已不存在，无法跳转');
                return;
            }
            await selectCharacterById(id);
            await openCharacterChat(meta.fileId);
        } else {
            const group = (ctx.groups ?? []).find(g => g.id === meta.groupId);
            if (!group || !group.chats?.includes(meta.fileId)) {
                toastr.warning('该群聊或聊天记录已不存在，无法跳转');
                return;
            }
            await openGroupChat(meta.groupId, meta.fileId);
        }
    } catch (e) {
        console.error('[TavernArchive] 打开聊天失败', e);
        toastr.error('打开聊天失败，详情请见控制台');
        return;
    }
    if (msgIdx >= 0) {
        await locateMessage(msgIdx);
    }
}

async function locateMessage(idx) {
    const find = () => document.querySelector(`#chat .mes[mesid="${idx}"]`);
    // 等一轮让聊天渲染出来
    await new Promise(r => setTimeout(r, 300));

    let guard = 0;
    while (!find()) {
        const moreBtn = document.querySelector('#show_more_messages');
        if (!moreBtn || guard++ >= 200) break;
        await showMoreMessages();
        await new Promise(r => setTimeout(r, 120));
    }

    const el = find();
    if (!el) {
        toastr.info('未能定位到该消息（可能已被删除）');
        return;
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('ta-flash');
    setTimeout(() => el.classList.remove('ta-flash'), 2600);
}
