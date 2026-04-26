/**
 * memory.get v7.0 — Baca isi runbook dengan PAGINATION + SMART SECTION support + LRU CACHE
 * Section boundary = entry separator (---) atau major ## heading, BUKAN sub-heading
 * v7.0: LRU cache untuk reduce filesystem I/O
 * @module mcp/tools/memory.get
 */
import { readRunbook, isMajorSection } from '../../storage/files.js';
import { confirmRead } from './memory.forget.js';
import { incrementAccessCount } from '../../storage/searchIndex.js';
import logger from '../../utils/logger.js';
import { LRUCache } from 'lru-cache';

const MAX_OUTPUT_CHARS = 80000; // Safe limit agar tidak exceed token limit

/**
 * v7.0: LRU Cache for memory_get — reduces filesystem I/O
 * - max: 150 items (covers typical session usage)
 * - ttl: 3 minutes (shorter than v5.2 because files can change from outside)
 * - updateAgeOnGet: true (frequently accessed items stay cached)
 */
const getCache = new LRUCache({
    max: 150,
    ttl: 3 * 60 * 1000,
    updateAgeOnGet: true,
    allowStale: false
});

let cacheHits = 0;
let cacheMisses = 0;

/**
 * Invalidate cache entry (called from upsert/forget)
 */
export function invalidateGetCache(id) {
    if (id) getCache.delete(id);
}

/**
 * Clear entire cache
 */
export function clearGetCache() {
    getCache.clear();
}

/**
 * Get cache stats
 */
export function getGetCacheStats() {
    return { size: getCache.size, hits: cacheHits, misses: cacheMisses };
}

// isMajorSection imported from ../../storage/files.js (shared utility)

/**
 * Parse content into major sections (entry-level boundaries)
 * Uses --- separator AND major ## headings as boundaries
 */
function parseMajorSections(content) {
    const sections = [];
    const lines = content.split('\n');
    let currentSection = null;
    let currentStart = 0;
    let charPos = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check for --- entry separator (only if it's a standalone ---)
        if (/^---\s*$/.test(line) && currentSection) {
            // Close current section (include the ---)
            // Don't start a new section yet — next ## heading will do that
        }

        // Check for ## heading
        if (line.startsWith('## ') && isMajorSection(line)) {
            if (currentSection) {
                currentSection.end = charPos;
                currentSection.content = content.substring(currentSection.start, currentSection.end).trim();
                sections.push(currentSection);
            }
            currentSection = {
                name: line,
                cleanName: line.replace(/^## /, '').trim(),
                start: charPos,
                end: content.length,
                line: i + 1
            };
        } else if (!currentSection && line.startsWith('## ')) {
            // First heading (even if sub-heading style)
            currentSection = {
                name: line,
                cleanName: line.replace(/^## /, '').trim(),
                start: charPos,
                end: content.length,
                line: i + 1
            };
        }

        charPos += line.length + 1; // +1 for \n
    }

    // Close last section
    if (currentSection) {
        currentSection.end = content.length;
        currentSection.content = content.substring(currentSection.start, currentSection.end).trim();
        sections.push(currentSection);
    }

    return sections;
}

export const definition = {
    name: 'memory_get',
    description: 'Baca isi runbook. Support pagination (offset/limit) dan section filter untuk runbook besar. Tanpa parameter = auto-paginate jika terlalu besar.',
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Runbook ID (filename, e.g. RUNBOOK_target.com.md)' },
            offset: { type: 'number', description: 'Character offset to start reading from (default: 0)' },
            limit: { type: 'number', description: 'Max characters to return (default: 80000)' },
            section: { type: 'string', description: 'Read specific ## section by name (e.g. "CREDENTIAL", "EXPLOIT", "GAGAL"). Case-insensitive.' },
            sections_list: { type: 'boolean', description: 'If true, return list of all major sections with their char positions instead of content. Useful for navigating large runbooks.' },
            line: { type: 'number', description: 'Start reading from this line number (1-based). Overrides offset.' },
            line_count: { type: 'number', description: 'Number of lines to read (default: 200). Used with line parameter.' }
        },
        required: ['id']
    }
};

export async function execute(params) {
    const { id, offset = 0, limit = MAX_OUTPUT_CHARS, section, sections_list, line, line_count = 200 } = params;

    try {
        // v7.0: Check LRU cache first (skip for section/pagination requests that need fresh data)
        const useCache = !section && !sections_list && !line && offset === 0;
        let item = null;

        if (useCache) {
            item = getCache.get(id);
            if (item) {
                cacheHits++;
                logger.debug('CACHE HIT', { id, hits: cacheHits });
            }
        }

        if (!item) {
            cacheMisses++;
            item = readRunbook(id);
            if (item && useCache) {
                getCache.set(id, item);
            }
        }

        if (!item) {
            return { error: 'Runbook not found: ' + id };
        }

        const fullContent = item.content || '';
        const totalChars = fullContent.length;

        // Parse major sections (smart boundary detection)
        const majorSections = parseMajorSections(fullContent);

        // MODE 1: List all sections (for navigation)
        // NOTE: sections_list ALONE does NOT unlock upsert — must also read content
        if (sections_list) {
            confirmRead(item.id, 'sections_list', 0);

            // v7.5 Aturan 15: Section health analysis
            const emptySections = majorSections.filter(s => {
                const bodyOnly = (s.content || '').replace(/^##[^\n]*\n/, '').trim();
                return bodyOnly.length < 10;
            });
            const largestSection = majorSections.reduce((max, s) => (s.content || '').length > (max.content || '').length ? s : max, majorSections[0] || { content: '' });
            const healthNotes = [];
            if (emptySections.length > 0) {
                healthNotes.push(`⚠️ ${emptySections.length} section kosong: ${emptySections.map(s => s.cleanName).slice(0, 5).join(', ')}`);
            }
            if (largestSection && (largestSection.content || '').length > 50000) {
                healthNotes.push(`⚠️ Section "${largestSection.cleanName}" terlalu besar (${Math.round((largestSection.content || '').length / 1024)}KB) — pertimbangkan split`);
            }
            const healthStr = healthNotes.length > 0 ? '\n\n**Health:** ' + healthNotes.join(' | ') : '';

            return {
                __plaintext: true,
                text: `# ${item.title} — SECTIONS INDEX\n\nTotal: ${totalChars} chars | ${majorSections.length} major sections${healthStr}\n\n` +
                    majorSections.map((s, i) => {
                        const size = s.content ? s.content.length : 0;
                        // Preview: first 150 chars of section content (strip heading line)
                        const bodyOnly = (s.content || '').replace(/^##[^\n]*\n/, '').trim();
                        const preview = bodyOnly.substring(0, 150).replace(/\n/g, ' ').trim();
                        return `- **${s.cleanName}** (offset: ${s.start}, ~${size} chars)\n  > ${preview}${bodyOnly.length > 150 ? '...' : ''}`;
                    }).join('\n')
            };
        }

        // MODE 2: Line-based read (e.g. line:50, line_count:100 → read lines 50-149)
        if (line && line > 0) {
            const allLines = fullContent.split('\n');
            const totalLines = allLines.length;
            const startLine = Math.max(1, Math.min(line, totalLines));
            const endLine = Math.min(startLine + line_count - 1, totalLines);
            const selectedLines = allLines.slice(startLine - 1, endLine);
            const result = selectedLines.map((l, i) => `${String(startLine + i).padStart(5)}│ ${l}`).join('\n');
            const charsRead = selectedLines.join('\n').length;

            confirmRead(item.id, charsRead > 500 ? 'full' : 'section', charsRead);

            const hasMore = endLine < totalLines;
            let header = `# ${item.title} — Lines ${startLine}-${endLine} of ${totalLines}`;
            if (hasMore) {
                header += ` | **Next**: memory_get({id:"${item.id}", line:${endLine + 1}, line_count:${line_count}}) | ${totalLines - endLine} lines remaining`;
            } else {
                header += ' | **END**';
            }

            return {
                __plaintext: true,
                text: `${header}\n\n${result}`
            };
        }

        // MODE 3: Read specific section
        if (section) {
            const sectionLower = section.toLowerCase();

            // Find matching section(s) — prioritize EXACT match, then includes
            const matched = [];
            const matchedNames = [];

            // Pass 1: Exact name match
            for (const s of majorSections) {
                if (s.cleanName.toLowerCase() === sectionLower) {
                    matched.push(s.content);
                    matchedNames.push(s.name);
                }
            }

            // Pass 2: If no exact match, try includes
            if (matched.length === 0) {
                for (const s of majorSections) {
                    if (s.cleanName.toLowerCase().includes(sectionLower)) {
                        matched.push(s.content);
                        matchedNames.push(s.name);
                    }
                }
            }

            if (matched.length === 0) {
                return {
                    __plaintext: true,
                    text: `# ${item.title}\n\nSection "${section}" not found.\n\nAvailable sections:\n` +
                        majorSections.map(s => `- ${s.name}`).join('\n')
                };
            }

            let result = matched.join('\n\n---\n\n');
            const totalResultChars = result.length;
            const effectiveLimit = Math.min(limit, MAX_OUTPUT_CHARS);

            // Apply offset for pagination within section results
            if (offset > 0 && offset < totalResultChars) {
                result = result.substring(offset);
            }

            // Truncate if still too big + show pagination info
            if (result.length > effectiveLimit) {
                const currentEnd = offset + effectiveLimit;
                result = result.substring(0, effectiveLimit) +
                    `\n\n... [TRUNCATED — ${totalResultChars - currentEnd} of ${totalResultChars} chars remaining` +
                    ` | **Next**: memory_get({id:"${item.id}", section:"${section}", offset:${currentEnd}})]`;
            }

            // Section read = unlock partial (track chars read)
            confirmRead(item.id, 'section', totalResultChars);

            const header = `# ${item.title} — Section: ${section} (${matched.length} match${matched.length > 1 ? 'es' : ''}, ${totalResultChars} chars total)` +
                (matchedNames.length > 1 ? `\n> Matched: ${matchedNames.slice(0, 20).join(', ')}${matchedNames.length > 20 ? ` ... +${matchedNames.length - 20} more` : ''}` : '');

            return {
                __plaintext: true,
                text: `${header}\n\n${result}`
            };
        }

        // MODE 4: Paginated read (default) — FULL content read = unlock upsert
        const effectiveLimit = Math.min(limit, MAX_OUTPUT_CHARS);
        const chunk = fullContent.substring(offset, offset + effectiveLimit);
        const hasMore = (offset + effectiveLimit) < totalChars;
        const remaining = totalChars - offset - effectiveLimit;

        // Full read or significant chunk = confirm as full read
        confirmRead(item.id, 'full', chunk.length);

        // v7.1: Track usefulness — increment access count in search index
        try { incrementAccessCount(item.id); } catch {}

        // v7.5: Health warnings — stale data + bloat detection (from research)
        const warnings = [];
        const itemUpdated = item.updated_at || item.updated;
        if (itemUpdated) {
            const updatedDate = new Date(itemUpdated);
            const daysSinceUpdate = Math.floor((Date.now() - updatedDate.getTime()) / (1000 * 60 * 60 * 24));
            if (daysSinceUpdate > 30) {
                warnings.push(`⚠️ STALE: Runbook belum di-update ${daysSinceUpdate} hari. Data mungkin OUTDATED — verifikasi sebelum gunakan.`);
            }
        }
        if (totalChars > 200000) {
            warnings.push(`⚠️ BLOAT: Runbook ${Math.round(totalChars/1024)}KB — pertimbangkan split/archive section yang tidak aktif.`);
        }
        const itemVersion = item.version || 1;
        if (itemVersion > 50) {
            warnings.push(`ℹ️ MATURE: v${itemVersion} — runbook ini sudah berkembang ${itemVersion}x. Keep evolving!`);
        }

        let header = `# ${item.title}`;
        if (warnings.length > 0) {
            header += '\n\n' + warnings.join('\n');
        }
        if (totalChars > effectiveLimit || offset > 0) {
            header += `\n\n> **Pagination**: chars ${offset}-${offset + chunk.length} of ${totalChars}` +
                (hasMore ? ` | **Next**: memory_get({id:"${item.id}", offset:${offset + effectiveLimit}}) | ${remaining} chars remaining` : ' | **END**');
        }

        return {
            __plaintext: true,
            text: `${header}\n\n${chunk}`
        };

    } catch (err) {
        logger.error('memory_get error', { error: err.message });
        throw err;
    }
}

export default { definition, execute };
