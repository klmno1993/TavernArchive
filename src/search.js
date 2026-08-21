// 查询解析 + 内存搜索。索引全在内存，直接遍历即可。

import { parseLooseDate } from './util.js';

/**
 * 解析查询字符串："短语" -排除 普通词
 * @returns {{ phrases:string[], terms:string[], excludes:string[], empty:boolean, raw:string }}
 */
export function parseQuery(input) {
    const raw = String(input ?? '');
    const phrases = [], terms = [], excludes = [];
    const re = /"([^"]+)"|(\S+)/g;
    let m;
    while ((m = re.exec(raw))) {
        if (m[1] !== undefined) {
            phrases.push(m[1]);
        } else {
            const tok = m[2];
            if (tok.startsWith('-') && tok.length > 1) {
                excludes.push(tok.slice(1));
            } else {
                terms.push(tok);
            }
        }
    }
    return {
        phrases, terms, excludes, raw,
        empty: phrases.length === 0 && terms.length === 0 && excludes.length === 0,
    };
}

const MAX_HITS = 5000;

/**
 * 搜索。
 * @param {object} state { chats: Map, messages: Map }
 * @param {object} parsed parseQuery 的结果
 * @param {object} filters { entities:Set|null, sender:'all'|'user'|'char', from:number|null, to:number|null,
 *                           onlyFav:boolean, onlyUntagged:boolean, tag:string|null,
 *                           favorites:object, chatTags:object }
 * @param {object} opts { regex:boolean, caseSensitive:boolean }
 * @returns {{ hits:Array, truncated:boolean, regexError:string|null, matchAll:boolean }}
 */
export function searchIndex(state, parsed, filters, opts) {
    const { regex = false, caseSensitive = false } = opts ?? {};

    let regexObj = null, regexError = null;
    if (regex && parsed.raw.trim()) {
        try {
            regexObj = new RegExp(parsed.raw.trim(), caseSensitive ? '' : 'i');
        } catch (e) {
            regexError = e.message;
        }
    }
    const matchAll = parsed.empty && !regexObj;

    let terms = null;
    if (!matchAll && !regexObj) {
        const norm = caseSensitive ? (x) => x : (x) => x.toLowerCase();
        const required = [...parsed.phrases, ...parsed.terms].map(norm);
        const excluded = parsed.excludes.map(norm);
        terms = { required, excluded, norm };
    }

    const hits = [];
    let truncated = false;

    outer:
    for (const [chatKey, meta] of state.chats) {
        // 聊天级过滤
        if (filters.onlyChatKey && chatKey !== filters.onlyChatKey) continue;
        if (filters.entities && !filters.entities.has(entityKeyOfMeta(meta))) continue;
        if (filters.onlyFav && !filters.favorites[chatKey]) continue;
        const tagsOf = filters.chatTags[chatKey] ?? [];
        if (filters.onlyUntagged && tagsOf.length > 0) continue;
        if (filters.tag && !tagsOf.includes(filters.tag)) continue;
        const favMsgs = filters.onlyMsgFav ? (filters.msgFavorites[chatKey] ?? null) : null;
        if (filters.onlyMsgFav && !favMsgs) continue;

        const chatTs = parseLooseDate(meta.lastMes) ?? 0;
        if (matchAll && !filters.onlyMsgFav) {
            hits.push({ chatKey, meta, i: -1, name: '', isUser: false, ts: chatTs, text: '' });
            if (hits.length >= MAX_HITS) { truncated = true; break; }
            continue;
        }

        const messages = state.messages.get(chatKey) ?? [];
        for (const msg of messages) {
            if (filters.onlyMsgFav && !favMsgs[msg.i]) continue;
            if (filters.sender === 'user' && !msg.isUser) continue;
            if (filters.sender === 'char' && msg.isUser) continue;
            if (filters.from != null || filters.to != null) {
                if (msg.ts == null) continue;
                if (filters.from != null && msg.ts < filters.from) continue;
                if (filters.to != null && msg.ts > filters.to) continue;
            }
            if (!matchAll) {
                if (regexObj) {
                    regexObj.lastIndex = 0;
                    if (!regexObj.test(msg.text)) continue;
                } else {
                    const hay = terms.norm(msg.text);
                    if (terms.excluded.some(t => hay.includes(t))) continue;
                    if (!terms.required.every(t => hay.includes(t))) continue;
                }
            }
            hits.push({ chatKey, meta, i: msg.i, name: msg.name, isUser: msg.isUser, ts: msg.ts ?? chatTs, text: msg.text });
            if (hits.length >= MAX_HITS) { truncated = true; break outer; }
        }
    }

    return { hits, truncated, regexError, matchAll };
}

export function entityKeyOfMeta(meta) {
    return meta.type === 'char' ? `c::${meta.avatar}` : `g::${meta.groupId}`;
}

/**
 * 构造高亮摘要 HTML：截取首个命中位置前后各 radius 字符，全部命中处包 <mark>。
 * 所有文本先转义再包裹，避免注入。
 */
export function buildExcerptHtml(text, parsed, { regex = false, caseSensitive = false, radius = 60 } = {}) {
    let ranges = [];
    if (regex) {
        try {
            const re = new RegExp(parsed.raw.trim(), caseSensitive ? 'g' : 'gi');
            let m;
            while ((m = re.exec(text)) && ranges.length < 50) {
                if (m[0].length === 0) { re.lastIndex++; continue; }
                ranges.push([m.index, m.index + m[0].length]);
            }
        } catch { /* 非法正则上层已提示 */ }
    } else {
        const needles = [...parsed.phrases, ...parsed.terms].filter(Boolean);
        const hay = caseSensitive ? text : text.toLowerCase();
        for (const n of needles) {
            const needle = caseSensitive ? n : n.toLowerCase();
            let from = 0;
            while (ranges.length < 50) {
                const idx = hay.indexOf(needle, from);
                if (idx === -1) break;
                ranges.push([idx, idx + needle.length]);
                from = idx + Math.max(needle.length, 1);
            }
        }
    }
    ranges.sort((a, b) => a[0] - b[0]);

    if (ranges.length === 0) {
        return escapeHtml(truncate(text, radius * 2));
    }

    const first = ranges[0][0];
    const start = Math.max(0, first - radius);
    const end = Math.min(text.length, first + radius);
    const slice = text.slice(start, end);
    const off = start;

    let html = start > 0 ? '…' : '';
    let cursor = 0;
    for (const [s, e] of ranges) {
        const rs = s - off, re2 = e - off;
        if (re2 < 0 || rs > slice.length) continue;
        const cs = Math.max(rs, 0), ce = Math.min(re2, slice.length);
        if (cs < cursor) continue;
        html += escapeHtml(slice.slice(cursor, cs));
        html += `<mark>${escapeHtml(slice.slice(cs, ce))}</mark>`;
        cursor = ce;
    }
    html += escapeHtml(slice.slice(cursor));
    if (end < text.length) html += '…';
    return html;
}

function truncate(text, len) {
    return text.length > len ? text.slice(0, len) + '…' : text;
}

export function escapeHtml(s) {
    return String(s ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
