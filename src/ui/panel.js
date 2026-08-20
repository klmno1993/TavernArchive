import { getContext, callGenericPopup, POPUP_TYPE } from '../st.js';
import { state, onState } from '../state.js';
import { refreshIndex, rebuildIndex } from '../indexer.js';
import { parseQuery, searchIndex, buildExcerptHtml, escapeHtml, entityKeyOfMeta } from '../search.js';
import {
    getSettings, ensureTag, renameTag, deleteTag, setTagColor,
    addChatTag, removeChatTag, toggleChatFav, setChatNote,
    toggleMsgFav, isMsgFav, getOrphans, pruneOrphans,
} from '../settings.js';
import { jumpToMessage } from '../jump.js';
import { parseLooseDate, stripHtmlTags } from '../util.js';

const BATCH = 30;

let built = false;
let isOpen = false;
let wasIndexing = false;
let view = 'chat';                 // 'chat' | 'message'
let sortMode = 'time';             // 'time' | 'hits'
let onlyCurrentChat = false;       // 工具栏「当前对话」开关
const searchOpts = { regex: false, caseSensitive: false };
const timeRange = { preset: 'all', from: null, to: null };

let currentItems = [];
let renderPos = 0;
let observer = null;
let orphanNoticeShown = false;

// ---------- 初始化 ----------

export function initPanel() {
    onState(() => {
        if (!isOpen) return;
        updateStatusBar();
        if (wasIndexing && !state.indexing) {
            // 索引刚完成：刷新实体/标签列表并重搜
            rebuildEntityList();
            rebuildTagList();
            checkOrphans();
            runSearch();
        }
        wasIndexing = state.indexing;
    });
}

export function openPanel(presetQuery = '') {
    try {
        console.log('[TavernArchive] 打开面板');
        buildDom();
        isOpen = true;
        $('#ta-overlay').removeClass('ta-hidden');
        // 移动端：部分环境下 CSS 层叠会把面板高度算成 0，直接内联视口单位钉死全屏
        if (window.innerWidth < 768) {
            document.querySelector('#ta-panel').style.cssText =
                'position:fixed; top:0; left:0; width:100vw; height:100vh; height:100dvh; max-width:none; border-radius:0; border:none;';
        } else {
            document.querySelector('#ta-panel').style.cssText = '';
        }
        if (presetQuery) $('#ta-q').val(presetQuery);
        rebuildEntityList();
        rebuildTagList();
        updateStatusBar();

        if (!state.ready) {
            showHint('正在加载本地索引…');
        } else if (state.chats.size === 0 && !state.indexing && !getSettings().lastIndexAt) {
            showOnboarding();
        } else {
            runSearch();
        }

        // 索引为空或距上次刷新超过 60s 则后台增量刷新
        if (!state.indexing && (state.chats.size === 0 || Date.now() - state.lastRefresh > 60_000)) {
            refreshIndex();
        }
    } catch (e) {
        console.error('[TavernArchive] 打开面板失败', e);
        toastr.error('Tavern Archive 打开失败，请查看控制台');
    }
}

export function closePanel() {
    isOpen = false;
    $('#ta-overlay').addClass('ta-hidden');
}

// ---------- DOM ----------

function buildDom() {
    if (built) return;
    built = true;

    const html = `
<div id="ta-overlay" class="ta-hidden">
  <div id="ta-panel">
    <div class="ta-header">
      <div class="ta-searchbox">
        <input id="ta-q" class="text_pole" type="text" autocomplete="off"
               placeholder='搜索全部对话内容… 支持 "短语" 与 -排除' />
        <div id="ta-regex" class="ta-flag" title="正则表达式">.*</div>
        <div id="ta-case" class="ta-flag" title="区分大小写">Aa</div>
      </div>
      <div id="ta-filter-toggle" class="menu_button"><i class="fa-solid fa-filter"></i> 筛选</div>
      <div id="ta-close" class="ta-close fa-solid fa-xmark" title="关闭 (Esc)"></div>
    </div>
    <div id="ta-progress" class="ta-hidden">
      <div class="ta-progress-track"><div id="ta-progress-fill"></div></div>
      <div id="ta-progress-label"></div>
    </div>
    <div id="ta-orphan" class="ta-hidden">
      <span id="ta-orphan-text"></span>
      <div class="menu_button" id="ta-orphan-clean">清理</div>
      <div class="menu_button" id="ta-orphan-ignore">忽略</div>
    </div>
    <div class="ta-body">
      <aside id="ta-filters">
        <div class="inline-drawer open">
          <div class="inline-drawer-toggle inline-drawer-header"><b>发送者</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
          <div class="inline-drawer-content">
            <label class="checkbox_label"><input type="radio" name="ta-sender" value="all" checked><span>全部</span></label>
            <label class="checkbox_label"><input type="radio" name="ta-sender" value="user"><span>仅用户</span></label>
            <label class="checkbox_label"><input type="radio" name="ta-sender" value="char"><span>仅角色</span></label>
          </div>
        </div>
        <div class="inline-drawer open">
          <div class="inline-drawer-toggle inline-drawer-header"><b>时间范围</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
          <div class="inline-drawer-content">
            <div class="ta-chips" id="ta-time-chips">
              <span class="ta-chip-btn ta-on" data-range="all">全部</span>
              <span class="ta-chip-btn" data-range="today">今天</span>
              <span class="ta-chip-btn" data-range="7d">近7天</span>
              <span class="ta-chip-btn" data-range="30d">近30天</span>
              <span class="ta-chip-btn" data-range="year">今年</span>
            </div>
            <div class="ta-dates">
              <input type="date" id="ta-from" class="text_pole" title="起始日期">
              <span>—</span>
              <input type="date" id="ta-to" class="text_pole" title="结束日期">
            </div>
          </div>
        </div>
        <div class="inline-drawer open">
          <div class="inline-drawer-toggle inline-drawer-header"><b>角色与群聊</b> <span id="ta-ent-sel" class="ta-badge"></span>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
          <div class="inline-drawer-content">
            <input id="ta-ent-q" class="text_pole" type="text" placeholder="搜索角色/群聊…" autocomplete="off">
            <div class="ta-ent-actions"><span id="ta-ent-all">全选</span> · <span id="ta-ent-none">清空</span></div>
            <div id="ta-ent-list"></div>
          </div>
        </div>
        <div class="inline-drawer open">
          <div class="inline-drawer-toggle inline-drawer-header"><b>收藏与标签</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
          <div class="inline-drawer-content">
            <label class="checkbox_label"><input type="checkbox" id="ta-onlyfav"><span>★ 仅收藏的聊天</span></label>
            <label class="checkbox_label"><input type="checkbox" id="ta-untagged"><span>仅无标签的聊天</span></label>
            <div id="ta-tag-list"></div>
          </div>
        </div>
      </aside>
      <main id="ta-main">
        <div class="ta-toolbar">
          <div class="ta-view-toggle">
            <div class="menu_button" id="ta-view-chat">聊天</div>
            <div class="menu_button" id="ta-view-msg">消息</div>
          </div>
          <div class="menu_button" id="ta-cur-chat" title="只在当前打开的聊天中搜索">
            <i class="fa-solid fa-crosshairs"></i> 当前对话
          </div>
          <select id="ta-sort" class="text_pole">
            <option value="time">按时间</option>
            <option value="hits">按命中数</option>
          </select>
          <span id="ta-count"></span>
        </div>
        <div id="ta-results"><div id="ta-sentinel"></div></div>
      </main>
    </div>
    <footer id="ta-statusbar">
      <span id="ta-stats"></span>
      <span class="ta-spacer"></span>
      <span id="ta-updated"></span>
      <div class="menu_button" id="ta-refresh">刷新索引</div>
      <div class="menu_button" id="ta-reindex">重建索引</div>
    </footer>
  </div>
</div>`;

    $('body').append(html);
    wireEvents();

    observer = new IntersectionObserver((entries) => {
        if (entries.some(e => e.isIntersecting)) renderBatch();
    }, { root: $('#ta-results')[0], rootMargin: '800px' });
    observer.observe($('#ta-sentinel')[0]);

    syncViewButtons();
}

function wireEvents() {
    $('#ta-close').on('click', closePanel);
    $('#ta-overlay').on('click', function (e) {
        if (e.target === this) closePanel();
    });

    $('#ta-q').on('input', debounce(runSearch, 300));
    $('#ta-regex').on('click', function () {
        searchOpts.regex = !searchOpts.regex;
        $(this).toggleClass('ta-on', searchOpts.regex);
        runSearch();
    });
    $('#ta-case').on('click', function () {
        searchOpts.caseSensitive = !searchOpts.caseSensitive;
        $(this).toggleClass('ta-on', searchOpts.caseSensitive);
        runSearch();
    });

    $('#ta-filter-toggle').on('click', () => $('#ta-filters').toggleClass('open'));

    // 折叠组（自己实现，不依赖 ST 全局委托）
    $('#ta-panel').on('click', '.inline-drawer-toggle', function () {
        $(this).closest('.inline-drawer').toggleClass('open');
    });

    // 发送者
    $('input[name="ta-sender"]').on('change', runSearch);

    // 时间
    $('#ta-time-chips .ta-chip-btn').on('click', function () {
        $('#ta-time-chips .ta-chip-btn').removeClass('ta-on');
        $(this).addClass('ta-on');
        timeRange.preset = this.dataset.range;
        timeRange.from = timeRange.to = null;
        $('#ta-from, #ta-to').val('');
        runSearch();
    });
    $('#ta-from, #ta-to').on('change', function () {
        $('#ta-time-chips .ta-chip-btn').removeClass('ta-on');
        timeRange.preset = 'custom';
        runSearch();
    });

    // 角色筛选
    $('#ta-ent-q').on('input', debounce(filterEntityRows, 150));
    $('#ta-ent-all').on('click', () => { setAllEntities(true); runSearch(); });
    $('#ta-ent-none').on('click', () => { setAllEntities(false); runSearch(); });
    $('#ta-ent-list').on('change', 'input[type="checkbox"]', function () {
        updateEntitySelBadge();
        runSearch();
    });

    // 收藏/标签筛选
    $('#ta-onlyfav, #ta-untagged').on('change', runSearch);
    $('#ta-tag-list').on('click', '.ta-tag-row', function (e) {
        if ($(e.target).closest('.ta-tag-op, input[type="color"]').length) return;
        const tag = this.dataset.tag;
        const was = $(this).hasClass('ta-on');
        $('#ta-tag-list .ta-tag-row').removeClass('ta-on');
        if (!was) $(this).addClass('ta-on');
        runSearch();
    });
    $('#ta-tag-list').on('click', '.ta-tag-rename', async function (e) {
        e.stopPropagation();
        const tag = $(this).closest('.ta-tag-row').data('tag');
        const name = await callGenericPopup(`将标签「${tag}」重命名为：`, POPUP_TYPE.INPUT, tag);
        if (name && name.trim() && name.trim() !== tag) {
            if (!renameTag(tag, name.trim())) toastr.warning('标签名已存在或标签不存在');
            rebuildTagList();
            runSearch();
        }
    });
    $('#ta-tag-list').on('click', '.ta-tag-del', async function (e) {
        e.stopPropagation();
        const tag = $(this).closest('.ta-tag-row').data('tag');
        const ok = await callGenericPopup(`删除标签「${tag}」？将从所有聊天上移除。`, POPUP_TYPE.CONFIRM);
        if (ok) {
            deleteTag(tag);
            rebuildTagList();
            runSearch();
        }
    });
    $('#ta-tag-list').on('change', 'input[type="color"]', function (e) {
        e.stopPropagation();
        setTagColor($(this).closest('.ta-tag-row').data('tag'), this.value);
        rebuildTagList();
        runSearch();
    });

    // 视图/排序
    $('#ta-view-chat').on('click', () => { view = 'chat'; syncViewButtons(); runSearch(); });
    $('#ta-view-msg').on('click', () => { view = 'message'; syncViewButtons(); runSearch(); });
    $('#ta-sort').on('change', function () { sortMode = this.value; runSearch(); });

    // 仅当前对话
    $('#ta-cur-chat').on('click', function () {
        if (!onlyCurrentChat && !currentChatKey()) {
            toastr.info('当前没有打开的聊天');
            return;
        }
        onlyCurrentChat = !onlyCurrentChat;
        syncViewButtons();
        runSearch();
    });

    // 状态栏
    $('#ta-refresh').on('click', () => refreshIndex());
    $('#ta-reindex').on('click', async () => {
        const ok = await callGenericPopup('重建索引会清空本地缓存并重新拉取全部聊天内容，收藏和标签不受影响。继续？', POPUP_TYPE.CONFIRM);
        if (ok) rebuildIndex();
    });

    // 失效数据
    $('#ta-orphan-clean').on('click', () => {
        const valid = new Set(state.chats.keys());
        const n = pruneOrphans(valid);
        toastr.success(`已清理 ${n} 条失效数据`);
        $('#ta-orphan').addClass('ta-hidden');
        runSearch();
    });
    $('#ta-orphan-ignore').on('click', () => $('#ta-orphan').addClass('ta-hidden'));

    // 结果区事件委托
    $('#ta-results').on('click', '.ta-jump', function () {
        const card = $(this).closest('[data-key]');
        const meta = state.chats.get(card.attr('data-key'));
        if (meta) jumpToMessage(meta, Number(card.attr('data-idx') ?? -1));
    });
    $('#ta-results').on('click', '.ta-open', function () {
        const meta = state.chats.get($(this).closest('[data-key]').attr('data-key'));
        if (meta) jumpToMessage(meta, -1);
    });
    $('#ta-results').on('click', '.ta-fav', function () {
        const key = $(this).closest('[data-key]').attr('data-key');
        const fav = toggleChatFav(key);
        $(this).toggleClass('fa-solid', fav).toggleClass('fa-regular', !fav);
        $(this).closest('[data-key]').find('.ta-note').toggleClass('ta-hidden', !fav);
        runSearchSoft();
    });
    $('#ta-results').on('click', '.ta-msgfav', function () {
        const card = $(this).closest('[data-key]');
        const key = card.attr('data-key');
        const idx = card.attr('data-idx');
        const fav = toggleMsgFav(key, idx);
        $(this).toggleClass('fa-solid', fav).toggleClass('fa-regular', !fav);
    });
    $('#ta-results').on('click', '.ta-copy', function () {
        const card = $(this).closest('[data-key]');
        const key = card.attr('data-key');
        const idx = Number(card.attr('data-idx'));
        const msg = (state.messages.get(key) ?? []).find(m => m.i === idx);
        if (msg) {
            navigator.clipboard.writeText(msg.text)
                .then(() => toastr.success('已复制'))
                .catch(() => toastr.error('复制失败'));
        }
    });
    $('#ta-results').on('click', '.ta-note', async function () {
        const key = $(this).closest('[data-key]').attr('data-key');
        const fav = getSettings().favorites[key];
        if (!fav) return;
        const note = await callGenericPopup('收藏备注：', POPUP_TYPE.INPUT, fav.note ?? '');
        if (note !== null && note !== undefined) {
            setChatNote(key, String(note));
            runSearchSoft();
        }
    });
    $('#ta-results').on('click', '.ta-tag-add', async function () {
        const key = $(this).closest('[data-key]').attr('data-key');
        const name = await callGenericPopup('输入标签名（可输入新标签或已有标签）：', POPUP_TYPE.INPUT, '');
        if (name && name.trim()) {
            addChatTag(key, name.trim());
            rebuildTagList();
            runSearchSoft();
        }
    });
    $('#ta-results').on('click', '.ta-chip-x', function (e) {
        e.stopPropagation();
        const key = $(this).closest('[data-key]').attr('data-key');
        removeChatTag(key, $(this).closest('.ta-chip').data('tag'));
        rebuildTagList();
        runSearchSoft();
    });
    // 引导页
    $('#ta-results').on('click', '#ta-start-index', () => rebuildIndex());

    // 键盘
    $(document).on('keydown.ta', (e) => {
        if (!isOpen) return;
        if (e.key === 'Escape') {
            if ($('#ta-filters').hasClass('open') && window.innerWidth < 768) {
                $('#ta-filters').removeClass('open');
            } else {
                closePanel();
            }
        } else if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) {
            e.preventDefault();
            $('#ta-q').trigger('focus');
        }
    });
}

function syncViewButtons() {
    $('#ta-view-chat').toggleClass('ta-on', view === 'chat');
    $('#ta-view-msg').toggleClass('ta-on', view === 'message');
    $('#ta-cur-chat').toggleClass('ta-on', onlyCurrentChat);
}

// ---------- 筛选状态 ----------

function collectFilters() {
    const settings = getSettings();
    // 角色/群聊：全部勾选视为 null（不限制）
    const rows = $('#ta-ent-list .ta-ent-row');
    const checked = rows.filter((_, r) => $(r).find('input').prop('checked'));
    const entities = (rows.length === 0 || checked.length === rows.length)
        ? null
        : new Set(checked.map((_, r) => r.dataset.ent).get());

    let from = null, to = null;
    if (timeRange.preset === 'custom') {
        const fv = $('#ta-from').val(), tv = $('#ta-to').val();
        if (fv) from = new Date(`${fv}T00:00:00`).getTime();
        if (tv) to = new Date(`${tv}T23:59:59.999`).getTime();
    } else if (timeRange.preset !== 'all') {
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        if (timeRange.preset === 'today') from = startOfDay;
        else if (timeRange.preset === '7d') from = startOfDay - 6 * 86400_000;
        else if (timeRange.preset === '30d') from = startOfDay - 29 * 86400_000;
        else if (timeRange.preset === 'year') from = new Date(now.getFullYear(), 0, 1).getTime();
    }

    const tag = $('#ta-tag-list .ta-tag-row.ta-on').data('tag') || null;

    return {
        entities,
        onlyChatKey: onlyCurrentChat ? currentChatKey() : null,
        sender: $('input[name="ta-sender"]:checked').val() ?? 'all',
        from, to,
        onlyFav: $('#ta-onlyfav').prop('checked'),
        onlyUntagged: $('#ta-untagged').prop('checked'),
        tag,
        favorites: settings.favorites,
        chatTags: settings.chatTags,
    };
}

/** 当前打开的聊天对应的 chatKey；没有打开聊天时返回 null */
function currentChatKey() {
    const ctx = getContext();
    const chatId = String(ctx.chatId ?? '').replace(/\.jsonl$/i, '');
    if (!chatId) return null;
    if (ctx.groupId) return `g::${ctx.groupId}::${chatId}`;
    const avatar = ctx.characters?.[ctx.characterId]?.avatar;
    return avatar ? `c::${avatar}::${chatId}` : null;
}

// ---------- 搜索与渲染 ----------

function runSearch() {
    if (!state.ready) return;
    const parsed = parseQuery($('#ta-q').val());
    const filters = collectFilters();
    const result = searchIndex(state, parsed, filters, searchOpts);

    if (result.regexError) {
        showHint(`正则表达式无效：${escapeHtml(result.regexError)}`);
        $('#ta-count').text('');
        return;
    }

    if (result.matchAll) {
        // 无关键词：聊天浏览模式
        currentItems = result.hits.map(h => ({ kind: 'chat', meta: h.meta, count: 0, samples: [] }));
    } else if (view === 'message') {
        currentItems = result.hits.map(h => ({ kind: 'message', hit: h }));
    } else {
        const byChat = new Map();
        for (const h of result.hits) {
            let g = byChat.get(h.chatKey);
            if (!g) byChat.set(h.chatKey, g = { kind: 'chat', meta: h.meta, count: 0, samples: [] });
            g.count++;
            if (g.samples.length < 3) g.samples.push(h);
        }
        currentItems = [...byChat.values()];
    }

    const tsOf = (it) => parseLooseDate(it.kind === 'chat' ? it.meta.lastMes : it.hit.meta.lastMes) ?? 0;
    currentItems.sort((a, b) => {
        if (sortMode === 'hits' && a.kind === 'chat' && b.kind === 'chat') return b.count - a.count || tsOf(b) - tsOf(a);
        if (a.kind === 'message' && b.kind === 'message') return (b.hit.ts ?? 0) - (a.hit.ts ?? 0);
        return tsOf(b) - tsOf(a);
    });

    const chatCount = result.matchAll || view === 'chat'
        ? currentItems.length
        : new Set(result.hits.map(h => h.chatKey)).size;
    $('#ta-count').text(result.matchAll
        ? `${currentItems.length} 个聊天`
        : `${chatCount} 个聊天 · ${result.hits.length} 条命中${result.truncated ? '（已截断，请缩小范围）' : ''}`);

    resetResults();

    if (currentItems.length === 0) {
        if (state.chats.size === 0) {
            showHint('索引里没有任何聊天。先去和角色聊聊，或点击右下角「刷新索引」。');
        } else if (result.matchAll) {
            showHint('没有符合筛选条件的聊天，试试放宽筛选。');
        } else {
            showHint('没有命中的结果，试试更换关键词或放宽筛选。');
        }
        return;
    }
    renderBatch();
}

// 筛选/数据变化后保持当前搜索词重渲染（不清搜索框）
function runSearchSoft() {
    runSearch();
}

function resetResults() {
    $('#ta-results .ta-card, #ta-results .ta-hint').remove();
    renderPos = 0;
}

function renderBatch() {
    if (renderPos >= currentItems.length) return;
    const parsed = parseQuery($('#ta-q').val());
    const settings = getSettings();
    const frag = document.createDocumentFragment();
    const end = Math.min(renderPos + BATCH, currentItems.length);
    for (let k = renderPos; k < end; k++) {
        const it = currentItems[k];
        const el = it.kind === 'message'
            ? msgCardHtml(it.hit, parsed, settings)
            : chatCardHtml(it, parsed, settings);
        frag.appendChild($(el)[0]);
    }
    renderPos = end;
    $('#ta-sentinel').before(frag);
}

// ---------- 卡片 ----------

function avatarHtml(meta) {
    if (meta.type === 'char' && meta.avatar) {
        return `<img class="ta-av" src="/characters/${encodeURIComponent(meta.avatar)}" alt="" onerror="this.style.visibility='hidden'">`;
    }
    return '<span class="ta-av ta-av-group fa-solid fa-users"></span>';
}

function displayName(meta) {
    return meta.type === 'char' ? (meta.charName || meta.avatar) : (meta.groupName || '群聊');
}

function fmtDate(v) {
    const t = typeof v === 'number' ? v : parseLooseDate(v);
    return Number.isNaN(t) || !t ? '' : new Date(t).toLocaleString();
}

function chatCardHtml(item, parsed, settings) {
    const meta = item.meta;
    const key = meta.chatKey;
    const fav = !!settings.favorites[key];
    const note = settings.favorites[key]?.note ?? '';
    const tags = settings.chatTags[key] ?? [];
    const tagChips = tags.map(t => {
        const color = settings.tags[t]?.color ?? '#888';
        return `<span class="ta-chip" data-tag="${escapeHtml(t)}" style="--chip:${escapeHtml(color)}">${escapeHtml(t)}<i class="fa-solid fa-xmark ta-chip-x" title="移除标签"></i></span>`;
    }).join('');

    let excerpts = '';
    if (item.samples?.length) {
        excerpts = item.samples.map(h =>
            `<div class="ta-excerpt ta-jumpable" data-idx="${h.i}" title="点击定位到此消息">
                <span class="ta-sender">${escapeHtml(h.name)}</span>${buildExcerptHtml(stripHtmlTags(h.text), parsed, searchOpts)}
             </div>`).join('')
            + (item.count > item.samples.length ? `<div class="ta-more">还有 ${item.count - item.samples.length} 条命中…</div>` : '');
    } else {
        excerpts = `<div class="ta-chatmeta">${meta.messageCount} 条消息</div>`;
    }

    return `
<div class="ta-card ta-chat" data-key="${escapeHtml(key)}">
  <div class="ta-card-head">
    <i class="${fav ? 'fa-solid' : 'fa-regular'} fa-star ta-act ta-fav" title="收藏此聊天"></i>
    ${avatarHtml(meta)}
    <span class="ta-char">${escapeHtml(displayName(meta))}</span>
    <span class="ta-file" title="${escapeHtml(meta.fileName)}">${escapeHtml(meta.fileId)}</span>
    <span class="ta-date">${fmtDate(meta.lastMes)}</span>
    ${item.count ? `<span class="ta-badge">${item.count} 条命中</span>` : ''}
    <span class="ta-spacer"></span>
    <i class="fa-regular fa-note-sticky ta-act ta-note ${fav ? '' : 'ta-hidden'}" title="收藏备注${note ? '：' + escapeHtml(note) : ''}"></i>
    <i class="fa-solid fa-tag ta-act ta-tag-add" title="添加标签"></i>
    <i class="fa-solid fa-arrow-right ta-act ta-open" title="打开此聊天"></i>
  </div>
  ${note ? `<div class="ta-note-text">${escapeHtml(note)}</div>` : ''}
  ${tagChips ? `<div class="ta-chips">${tagChips}</div>` : ''}
  ${excerpts}
</div>`;
}

function msgCardHtml(hit, parsed, settings) {
    const meta = hit.meta;
    const fav = isMsgFav(hit.chatKey, hit.i);
    return `
<div class="ta-card ta-msg" data-key="${escapeHtml(hit.chatKey)}" data-idx="${hit.i}">
  <div class="ta-card-head">
    ${avatarHtml(meta)}
    <span class="ta-char">${escapeHtml(displayName(meta))}</span>
    <span class="ta-file" title="${escapeHtml(meta.fileName)}">${escapeHtml(meta.fileId)}</span>
    <span class="ta-date">${fmtDate(hit.ts)}</span>
    <span class="ta-badge">${hit.isUser ? '用户' : '角色'}</span>
    <span class="ta-spacer"></span>
    <i class="fa-regular fa-copy ta-act ta-copy" title="复制消息内容"></i>
    <i class="${fav ? 'fa-solid' : 'fa-regular'} fa-star ta-act ta-msgfav" title="收藏此消息"></i>
    <i class="fa-solid fa-arrow-right ta-act ta-jump" title="定位到此消息"></i>
  </div>
  <div class="ta-excerpt"><span class="ta-sender">${escapeHtml(hit.name)}</span>${buildExcerptHtml(stripHtmlTags(hit.text), parsed, searchOpts)}</div>
</div>`;
}

// 摘录点击 → 定位该条消息
$(document).on('click', '.ta-excerpt.ta-jumpable', function () {
    const card = $(this).closest('[data-key]');
    const meta = state.chats.get(card.attr('data-key'));
    if (meta) jumpToMessage(meta, Number(this.dataset.idx ?? -1));
});

// ---------- 列表构建 ----------

function rebuildEntityList() {
    if (!built) return;
    const agg = new Map(); // entityKey -> { name, avatar, type, count }
    for (const meta of state.chats.values()) {
        const ek = entityKeyOfMeta(meta);
        let a = agg.get(ek);
        if (!a) agg.set(ek, a = { name: displayName(meta), avatar: meta.avatar, type: meta.type, count: 0 });
        a.count++;
    }
    const prevChecked = new Set(
        $('#ta-ent-list .ta-ent-row').filter((_, r) => $(r).find('input').prop('checked')).map((_, r) => r.dataset.ent).get(),
    );
    const hadRows = $('#ta-ent-list .ta-ent-row').length > 0;

    const rows = [...agg.entries()]
        .sort((a, b) => a[1].name.localeCompare(b[1].name, 'zh'))
        .map(([ek, a]) => {
            const checked = hadRows ? prevChecked.has(ek) : true;
            const av = a.type === 'char'
                ? `<img class="ta-av" src="/characters/${encodeURIComponent(a.avatar)}" alt="" onerror="this.style.visibility='hidden'">`
                : '<span class="ta-av ta-av-group fa-solid fa-users"></span>';
            return `<label class="checkbox_label ta-ent-row" data-ent="${escapeHtml(ek)}" data-name="${escapeHtml(a.name.toLowerCase())}">
                <input type="checkbox" ${checked ? 'checked' : ''}>${av}<span class="ta-ent-name">${escapeHtml(a.name)}</span><em>${a.count}</em>
            </label>`;
        }).join('');

    $('#ta-ent-list').html(rows || '<div class="ta-hint">（索引为空）</div>');
    filterEntityRows();
    updateEntitySelBadge();
}

function filterEntityRows() {
    const q = ($('#ta-ent-q').val() ?? '').toLowerCase();
    $('#ta-ent-list .ta-ent-row').each(function () {
        $(this).toggle(!q || (this.dataset.name ?? '').includes(q));
    });
}

function setAllEntities(val) {
    $('#ta-ent-list .ta-ent-row input[type="checkbox"]').prop('checked', val);
    updateEntitySelBadge();
}

function updateEntitySelBadge() {
    const rows = $('#ta-ent-list .ta-ent-row');
    const checked = rows.filter((_, r) => $(r).find('input').prop('checked')).length;
    $('#ta-ent-sel').text(rows.length && checked < rows.length ? `(${checked}/${rows.length})` : '');
}

function rebuildTagList() {
    if (!built) return;
    const settings = getSettings();
    const counts = {};
    for (const tags of Object.values(settings.chatTags)) {
        for (const t of tags) counts[t] = (counts[t] ?? 0) + 1;
    }
    const prevTag = $('#ta-tag-list .ta-tag-row.ta-on').data('tag') || null;

    const rows = Object.keys(settings.tags).sort((a, b) => a.localeCompare(b, 'zh')).map(t => {
        const color = settings.tags[t]?.color ?? '#888';
        return `<div class="ta-tag-row ${prevTag === t ? 'ta-on' : ''}" data-tag="${escapeHtml(t)}">
            <input type="color" value="${escapeHtml(color)}" title="标签颜色">
            <span class="ta-tag-name">${escapeHtml(t)}</span>
            <em>${counts[t] ?? 0}</em>
            <i class="fa-solid fa-pen ta-tag-op ta-tag-rename" title="重命名"></i>
            <i class="fa-solid fa-xmark ta-tag-op ta-tag-del" title="删除"></i>
        </div>`;
    }).join('');

    $('#ta-tag-list').html(rows || '<div class="ta-hint">还没有标签。在结果卡片上点 <i class="fa-solid fa-tag"></i> 即可添加。</div>');
}

// ---------- 状态与提示 ----------

function updateStatusBar() {
    if (!built) return;
    let msgCount = 0;
    for (const msgs of state.messages.values()) msgCount += msgs.length;
    const chars = new Set([...state.chats.values()].filter(m => m.type === 'char').map(m => m.avatar)).size;
    const groups = new Set([...state.chats.values()].filter(m => m.type === 'group').map(m => m.groupId)).size;
    $('#ta-stats').text(`${chars} 角色 · ${groups} 群聊 · ${state.chats.size} 聊天 · ${msgCount} 条消息`);

    const at = getSettings().lastIndexAt;
    $('#ta-updated').text(at ? `上次更新 ${new Date(at).toLocaleString()}` : '尚未建立索引');

    if (state.indexing && state.progress) {
        $('#ta-progress').removeClass('ta-hidden');
        const { done, total, label } = state.progress;
        const pct = total ? Math.round((done / total) * 100) : 0;
        $('#ta-progress-fill').css('width', `${pct}%`);
        $('#ta-progress-label').text(total ? `${label} ${done}/${total}` : label);
    } else {
        $('#ta-progress').addClass('ta-hidden');
    }
}

function checkOrphans() {
    if (orphanNoticeShown) return;
    const orphans = getOrphans(new Set(state.chats.keys()));
    if (orphans.length > 0) {
        orphanNoticeShown = true;
        $('#ta-orphan-text').text(`发现 ${orphans.length} 条收藏/标签指向已删除或重命名的聊天。`);
        $('#ta-orphan').removeClass('ta-hidden');
    }
}

function showHint(text) {
    resetResults();
    $('#ta-sentinel').before(`<div class="ta-hint ta-hint-big">${text}</div>`);
}

function showOnboarding() {
    resetResults();
    $('#ta-sentinel').before(`
        <div class="ta-hint ta-hint-big ta-onboarding">
          <p><b>Tavern Archive</b> 需要先为你的全部聊天建立本地索引。</p>
          <p>聊天越多耗时越长，期间可以正常使用 SillyTavern。索引只读不写，不会修改任何聊天数据。</p>
          <div class="menu_button" id="ta-start-index">开始建立索引</div>
        </div>`);
}

function debounce(fn, ms) {
    let t = null;
    return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), ms);
    };
}
