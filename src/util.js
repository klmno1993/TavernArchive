// ST 的 send_date / last_mes 使用英文人性化格式（如 "April 13, 2025 2:20am"），
// Date.parse 无法解析，这里统一兜底处理。

const MONTHS = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/** 摘要展示用：剥掉消息里的 HTML 标签，折叠多余空白 */
export function stripHtmlTags(text) {
    return String(text ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * 宽松日期解析：ISO 等标准格式 → ST 人性化格式 → 毫秒数字 → moment 兜底。
 * @returns {number|null} 毫秒时间戳，解析失败为 null
 */
export function parseLooseDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;

    const s = String(v).trim();

    const t = Date.parse(s);
    if (!Number.isNaN(t)) return t;

    // "April 13, 2025 2:20am"（humanizedDateTime 格式）
    const m = s.match(/^(\w+)\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)$/i);
    if (m) {
        const mon = MONTHS[m[1].toLowerCase()];
        if (mon !== undefined) {
            let h = Number(m[4]) % 12;
            if (m[7].toLowerCase() === 'pm') h += 12;
            return new Date(Number(m[3]), mon, Number(m[2]), h, Number(m[5]), Number(m[6] ?? 0)).getTime();
        }
    }

    // 毫秒时间戳字符串
    if (/^\d{10,}$/.test(s)) return Number(s);

    if (typeof window !== 'undefined' && typeof window.moment === 'function') {
        const mm = window.moment(s);
        if (mm.isValid()) return mm.valueOf();
    }
    return null;
}
