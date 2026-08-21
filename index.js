import { eventSource, event_types, getContext } from './src/st.js';
import { loadFromDb, refreshIndex, rebuildIndex } from './src/indexer.js';
import { getSettings } from './src/settings.js';
import { initPanel, openPanel, togglePanel } from './src/ui/panel.js';
import { state } from './src/state.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';

// 顶部导航栏放大镜图标（与自带顶部功能一致：再点一次关闭）
function addTopBarButton() {
    const btn = $('<div id="ta-top-btn" class="drawer-icon fa-solid fa-magnifying-glass fa-fw closedIcon" title="Tavern Archive · 对话搜索"></div>');
    btn.on('click', () => togglePanel());
    $('#top-settings-holder').append(btn);
}

// 扩展设置面板入口
function addSettingsBlock() {
    const html = `
    <div id="ta-settings-drawer" class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Tavern Archive</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <p>全局对话内容搜索 · 收藏 · 标签</p>
            <div class="menu_button" id="ta-open-panel">打开搜索面板</div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);
    $('#ta-open-panel').on('click', () => openPanel());
    // 抽屉折叠自行处理，不依赖 ST 全局委托
    $('#ta-settings-drawer .inline-drawer-toggle').on('click', function () {
        $(this).closest('.inline-drawer').toggleClass('open');
    });
}

// 斜杠命令：/archive 或 /archive 关键词
function registerSlashCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'archive',
        callback: async (_named, unnamed) => {
            openPanel(String(unnamed ?? '').trim());
            return '';
        },
        helpString: '打开 Tavern Archive 对话搜索面板，可直接跟搜索词，如 /archive 关键词',
    }));
}

jQuery(async () => {
    getSettings();
    initPanel();
    addTopBarButton();
    addSettingsBlock();
    registerSlashCommand();

    await loadFromDb();

    // 调试句柄：控制台里可用 TavernArchive.refresh() 手动触发索引
    window.TavernArchive = {
        state,
        refresh: refreshIndex,
        rebuild: rebuildIndex,
        context: getContext,
    };

    // 等 ST 把角色列表加载完再做首次后台索引，否则 entities 为空
    const startIndex = () => refreshIndex();
    if ((getContext().characters?.length ?? 0) > 0) {
        startIndex();
    } else {
        console.log('[TavernArchive] 等待角色列表加载…');
        eventSource.once(event_types.CHARACTER_PAGE_LOADED, startIndex);
    }
});
