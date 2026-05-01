/**
 * memory.timeline v1.0 — Chronological context around an anchor point
 *
 * Shows N entries before/after an observation or runbook event.
 * Uses observations table from search_index.db for chronological ordering.
 * Fallback: parse _AUTO_LOG entries from runbook files.
 *
 * @module mcp/tools/memory.timeline
 */
import { getDb, isIndexReady } from '../../storage/searchIndex.js';
import { readRunbook } from '../../storage/files.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';

export const definition = {
    name: 'memory_timeline',
    description: 'Lihat konteks kronologis di sekitar suatu event. Tampilkan N entries sebelum/sesudah anchor (observation ID atau timestamp). Berguna untuk memahami "apa yang terjadi sebelum/sesudah" suatu aksi.',
    inputSchema: {
        type: 'object',
        properties: {
            anchor_id: { type: 'number', description: 'Observation ID dari search_index.db. Gunakan hasil dari memory_search.' },
            runbook_id: { type: 'string', description: 'Runbook filename — timeline dari _AUTO_LOG runbook ini.' },
            query: { type: 'string', description: 'Query untuk auto-find anchor. Jika anchor_id tidak diberikan, cari anchor terbaik dari query ini.' },
            depth_before: { type: 'number', description: 'Jumlah entries SEBELUM anchor (default: 5)' },
            depth_after: { type: 'number', description: 'Jumlah entries SESUDAH anchor (default: 5)' }
        }
    }
};

function formatTimestamp(ts) {
    if (!ts) return '??:??';
    try {
        const d = new Date(ts);
        return d.toISOString().substring(11, 16);
    } catch { return '??:??'; }
}

function formatDate(ts) {
    if (!ts) return 'Unknown';
    try {
        const d = new Date(ts);
        return d.toISOString().substring(0, 10);
    } catch { return 'Unknown'; }
}

function dbTimeline(anchorId, depthBefore, depthAfter, query) {
    const db = getDb();
    if (!db) return null;

    let anchorRow = null;
    if (anchorId) {
        anchorRow = db.prepare('SELECT * FROM observations WHERE id = ?').get(anchorId);
    }

    if (!anchorRow && query) {
        try {
            anchorRow = db.prepare(`
                SELECT o.* FROM observations o
                WHERE o.tool_input_summary LIKE ? OR o.tool_response_summary LIKE ? OR o.tool_name LIKE ?
                ORDER BY o.timestamp DESC LIMIT 1
            `).get(`%${query}%`, `%${query}%`, `%${query}%`);
        } catch {}
    }

    if (!anchorRow) return null;

    const anchorTs = anchorRow.timestamp;

    const before = db.prepare(`
        SELECT id, runbook_id, tool_name, tool_input_summary, tool_response_summary, timestamp
        FROM observations WHERE timestamp < ? ORDER BY timestamp DESC LIMIT ?
    `).all(anchorTs, depthBefore);

    const after = db.prepare(`
        SELECT id, runbook_id, tool_name, tool_input_summary, tool_response_summary, timestamp
        FROM observations WHERE timestamp > ? ORDER BY timestamp ASC LIMIT ?
    `).all(anchorTs, depthAfter);

    return { anchor: anchorRow, before: before.reverse(), after };
}

function autologTimeline(runbookId, depthBefore, depthAfter, query) {
    const item = readRunbook(runbookId);
    if (!item) return null;

    const content = item.content || '';
    const autologIdx = content.indexOf('## _AUTO_LOG');
    if (autologIdx === -1) return null;

    const autologSection = content.substring(autologIdx);
    const lineRe = /^- \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[([^\]]+)\] (.+)$/;
    const entries = [];
    for (const line of autologSection.split('\n')) {
        const m = line.match(lineRe);
        if (m) {
            entries.push({ timestamp: m[1], event: m[2], detail: m[3] });
        }
    }

    if (entries.length === 0) return null;

    let anchorIdx = -1;
    if (query) {
        const q = query.toLowerCase();
        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].detail.toLowerCase().includes(q) || entries[i].event.toLowerCase().includes(q)) {
                anchorIdx = i;
                break;
            }
        }
    }
    if (anchorIdx === -1) anchorIdx = entries.length - 1;

    const startIdx = Math.max(0, anchorIdx - depthBefore);
    const endIdx = Math.min(entries.length - 1, anchorIdx + depthAfter);

    return {
        entries: entries.slice(startIdx, endIdx + 1),
        anchorIdx: anchorIdx - startIdx,
        total: entries.length,
        runbook: item.title
    };
}

export async function execute(params) {
    const traceId = uuidv4();
    const {
        anchor_id: anchorId,
        runbook_id: runbookId,
        query,
        depth_before: depthBefore = 5,
        depth_after: depthAfter = 5
    } = params || {};

    const lines = [];

    // MODE 1: DB-based timeline (observations table)
    if ((anchorId || query) && isIndexReady()) {
        const result = dbTimeline(anchorId, depthBefore, depthAfter, query);
        if (result) {
            const { anchor, before, after } = result;
            lines.push(`# Timeline — Anchor: #${anchor.id} (${anchor.tool_name})`);
            lines.push(`**Time:** ${anchor.timestamp} | **Runbook:** ${anchor.runbook_id || 'N/A'}`);
            lines.push(`**Window:** ${before.length} before → anchor → ${after.length} after\n`);

            lines.push('| # | Time | Tool | Input | Response |');
            lines.push('|---|------|------|-------|----------|');

            for (const row of before) {
                lines.push(`| #${row.id} | ${formatTimestamp(row.timestamp)} | ${row.tool_name || '?'} | ${(row.tool_input_summary || '').substring(0, 80)} | ${(row.tool_response_summary || '').substring(0, 60)} |`);
            }
            lines.push(`| **#${anchor.id}** | **${formatTimestamp(anchor.timestamp)}** | **${anchor.tool_name}** | **${(anchor.tool_input_summary || '').substring(0, 80)}** | **${(anchor.tool_response_summary || '').substring(0, 60)}** |`);
            for (const row of after) {
                lines.push(`| #${row.id} | ${formatTimestamp(row.timestamp)} | ${row.tool_name || '?'} | ${(row.tool_input_summary || '').substring(0, 80)} | ${(row.tool_response_summary || '').substring(0, 60)} |`);
            }

            return { __plaintext: true, text: lines.join('\n') };
        }
    }

    // MODE 2: Runbook _AUTO_LOG based timeline
    if (runbookId) {
        const result = autologTimeline(runbookId, depthBefore, depthAfter, query);
        if (result) {
            lines.push(`# Timeline — ${result.runbook}`);
            lines.push(`**Source:** _AUTO_LOG (${result.total} total entries)`);
            lines.push(`**Window:** ${depthBefore} before → anchor → ${depthAfter} after\n`);

            lines.push('| # | Time | Event | Detail |');
            lines.push('|---|------|-------|--------|');

            result.entries.forEach((e, i) => {
                const isAnchor = i === result.anchorIdx;
                const prefix = isAnchor ? '**' : '';
                const suffix = isAnchor ? '**' : '';
                lines.push(`| ${prefix}${i + 1}${suffix} | ${prefix}${e.timestamp.substring(11, 16)}${suffix} | ${prefix}${e.event}${suffix} | ${prefix}${e.detail.substring(0, 100)}${suffix} |`);
            });

            return { __plaintext: true, text: lines.join('\n') };
        }
    }

    return {
        __plaintext: true,
        text: `Timeline: tidak ada data. Gunakan anchor_id (dari memory_search) atau runbook_id + query.`
    };
}

export default { definition, execute };
