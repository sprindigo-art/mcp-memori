/**
 * Filesystem-based Runbook Storage v7.0
 * .md files with YAML frontmatter + Intelligence Layer
 * v7.0: Query expansion, fuzzy title matching, better scoring, recency decay
 * @module storage/files
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync, renameSync } from 'fs';
import { join, basename } from 'path';
import logger from '../utils/logger.js';
import { ftsSearch, isIndexReady, incrementAccessCount } from './searchIndex.js';

export const RUNBOOKS_DIR = '/home/kali/Desktop/mcp-memori/runbooks';

// Ensure directories exist
if (!existsSync(RUNBOOKS_DIR)) mkdirSync(RUNBOOKS_DIR, { recursive: true });

/**
 * Sanitize title to valid filename
 * "[RUNBOOK] bappenas.go.id" → "RUNBOOK_bappenas.go.id.md"
 * "[TEKNIK] GeoServer RCE" → "TEKNIK_GeoServer_RCE.md"
 */
export function titleToFilename(title) {
    return title
        .replace(/\[/g, '').replace(/\]/g, '')
        .replace(/[\/\\:*?"<>|]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 200) + '.md';
}

/**
 * Filename back to approximate title
 */
export function filenameToTitle(filename) {
    return filename.replace(/\.md$/, '').replace(/_/g, ' ').replace(/^(\w+)\s/, '[$1] ');
}

/**
 * Parse YAML-like frontmatter from .md file
 */
export function parseFrontmatter(content) {
    if (!content || !content.startsWith('---\n')) {
        return { meta: {}, body: content || '' };
    }
    const endIdx = content.indexOf('\n---\n', 4);
    if (endIdx === -1) return { meta: {}, body: content };

    const frontStr = content.substring(4, endIdx);
    const body = content.substring(endIdx + 5);
    const meta = {};

    for (const line of frontStr.split('\n')) {
        const colonIdx = line.indexOf(': ');
        if (colonIdx === -1) continue;
        const key = line.substring(0, colonIdx).trim();
        let value = line.substring(colonIdx + 2).trim();

        // Strip surrounding quotes from string values
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        // Parse JSON arrays (handle both single and double quotes)
        if (value.startsWith('[') && value.endsWith(']')) {
            try { value = JSON.parse(value); } catch {
                try { value = JSON.parse(value.replace(/'/g, '"')); } catch {}
            }
            if (typeof value === 'string') value = [value];
        }
        // Parse booleans and numbers
        else if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (/^\d+$/.test(value)) value = parseInt(value, 10);
        else if (/^\d+\.\d+$/.test(value)) value = parseFloat(value);

        meta[key] = value;
    }

    return { meta, body };
}

/**
 * Build frontmatter string from metadata object
 */
export function buildFrontmatter(meta) {
    const lines = ['---'];
    for (const [key, value] of Object.entries(meta)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
            lines.push(`${key}: ${JSON.stringify(value)}`);
        } else {
            lines.push(`${key}: ${value}`);
        }
    }
    lines.push('---\n');
    return lines.join('\n');
}

/**
 * NOISE TAGS — tags terlalu generik yang ada di hampir semua runbook.
 * Tags ini DIBUANG saat merge karena tidak membantu search/filter.
 * Hanya simpan tags SPESIFIK: nama target, CVE, teknik spesifik, IP.
 */
const NOISE_TAGS = new Set([
    // Status tags (ada di semua runbook)
    'gagal', 'failed', 'success', 'berhasil', 'blocked', 'alive', 'dead',
    'active', 'critical', 'update', 'updated', 'progress', 'complete',
    'state', 'checkpoint', 'fact', 'episode', 'decision',
    // Generic technique tags (terlalu umum)
    'ssh', 'credential', 'password', 'recon', 'exploit', 'persistence',
    'root', 'rce', 'upload', 'injection', 'bypass', 'scan', 'pivot',
    'lateral-movement', 'infrastructure', 'network-map', 'database',
    'tunnel', 'fix', 'waf', 'dns', 'mail', 'smtp', 'windows', 'linux',
    // Date tags (redundant — updated_at sudah ada di frontmatter)
    'mar2026', 'apr2026', 'feb2026', 'jan2026',
    // Meta tags
    'technique', 'runbook', 'universal', 'audit', 'verification',
    'lesson-learned', 'bug', 'fatal', 'hunt', 'research', 'ready',
    'development', 'compiled', 'exhausted', 'final', 'new-target',
    'discovery', 'live-status', 're-entry', 'checklist', 'cleanup',
    'attack-chain', 'anti-sleep',
]);

/**
 * Filter out noise tags, keep only specific/useful ones
 * Useful = target name, CVE-*, IP address, specific service name, domain
 */
function filterNoiseTags(tags) {
    return tags.filter(t => {
        const tl = (t || '').toLowerCase().trim();
        if (!tl || tl.length < 2) return false;
        // Always keep: CVE IDs, IP addresses, domain-like tags
        if (/^cve-/i.test(tl)) return true;
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}/.test(tl)) return true;
        if (/\.\w{2,}$/.test(tl) && tl.includes('.')) return true; // domain-like
        // Remove noise
        if (NOISE_TAGS.has(tl)) return false;
        // Keep the rest (specific names, services, etc.)
        return true;
    });
}

/**
 * Extract keywords from text for fuzzy matching (stopwords removed)
 */
function extractMatchKeywords(text) {
    const stopwords = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
        'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
        'yang', 'dan', 'atau', 'di', 'ke', 'dari', 'untuk', 'dengan', 'pada',
        'ini', 'itu', 'adalah', 'runbook', 'teknik'
    ]);
    return (text || '')
        .toLowerCase()
        .replace(/[\[\](){}]/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/[\s.\-_]+/)
        .filter(w => w.length >= 2 && !stopwords.has(w));
}

/**
 * v7.0: Fuzzy title matching — find existing runbook with similar title
 * Uses Jaccard keyword overlap >= 0.6 to match
 * Prevents duplicate files when title wording slightly differs
 * @param {string} newTitle - Title being saved
 * @returns {string|null} filepath of matched runbook, or null
 */
function findByFuzzyTitle(newTitle) {
    const newKeywords = extractMatchKeywords(newTitle);
    if (newKeywords.length < 2) return null;

    const files = readdirSync(RUNBOOKS_DIR).filter(f => f.endsWith('.md'));
    let bestMatch = null;
    let bestOverlap = 0;
    let secondBestOverlap = 0;

    // Protect against merging SUCCESS with FAILED runbooks
    const newLower = newTitle.toLowerCase();
    const newIsFailure = newLower.includes('gagal') || newLower.includes('failed');
    const newIsSuccess = newLower.includes('berhasil') || newLower.includes('success');

    for (const file of files) {
        const filepath = join(RUNBOOKS_DIR, file);
        let raw;
        try { raw = readFileSync(filepath, 'utf8'); } catch { continue; }
        const { meta } = parseFrontmatter(raw);
        const existingTitle = meta.title || filenameToTitle(file);
        const existingKeywords = extractMatchKeywords(existingTitle);
        if (existingKeywords.length < 2) continue;

        // Skip if success/failure status differs
        const existLower = existingTitle.toLowerCase();
        const existIsFailure = existLower.includes('gagal') || existLower.includes('failed');
        const existIsSuccess = existLower.includes('berhasil') || existLower.includes('success');
        if ((newIsFailure && existIsSuccess) || (newIsSuccess && existIsFailure)) continue;

        // Jaccard similarity: intersection / union
        const intersection = newKeywords.filter(k => existingKeywords.includes(k));
        const unionSet = new Set([...newKeywords, ...existingKeywords]);
        const overlap = intersection.length / unionSet.size;

        if (overlap > bestOverlap) {
            secondBestOverlap = bestOverlap;
            bestOverlap = overlap;
            bestMatch = { filepath, overlap };
        } else if (overlap > secondBestOverlap) {
            secondBestOverlap = overlap;
        }
    }

    // Must be >= 75% overlap AND not ambiguous (second best < 65%)
    // Raised from 0.6 to 0.75 to prevent wrong-file appends (e.g. subdomain matching parent domain)
    if (!bestMatch || bestOverlap < 0.75) return null;
    if (secondBestOverlap >= 0.65) {
        logger.info('FUZZY MATCH AMBIGUOUS, creating new', { best: bestOverlap, second: secondBestOverlap, title: newTitle });
        return null;
    }

    logger.info('FUZZY TITLE MATCH', { title: newTitle, matched: basename(bestMatch.filepath), overlap: bestOverlap.toFixed(2) });
    return bestMatch.filepath;
}

/**
 * Save or append to runbook .md file
 * APPEND-ONLY: existing valid content is NEVER deleted
 * v7.0: Fuzzy title matching to prevent duplicate files
 */
export function saveRunbook(title, content, tags = [], options = {}) {
    let filename = titleToFilename(title);
    let filepath = join(RUNBOOKS_DIR, filename);
    const now = new Date().toISOString();
    const newContent = (content || '').trim();

    if (!newContent) {
        return { id: filename, action: 'skipped_empty', filepath };
    }

    // TITLE MATCH: Cek apakah ada file existing dengan title sama di frontmatter
    // Ini mencegah duplikat ketika filename sanitization berbeda tapi title sama
    if (!existsSync(filepath)) {
        const matchedPath = findByTitle(title);
        if (matchedPath) {
            filepath = matchedPath;
            filename = basename(matchedPath);
            logger.info('RUNBOOK TITLE MATCH: Found existing by frontmatter title', { title, filename });
        }
    }

    // v7.0: FUZZY TITLE MATCH — fallback when exact title match fails
    if (!existsSync(filepath)) {
        const fuzzyPath = findByFuzzyTitle(title);
        if (fuzzyPath) {
            filepath = fuzzyPath;
            filename = basename(fuzzyPath);
            logger.info('RUNBOOK FUZZY MATCH: Found similar title', { title, filename });
        }
    }

    if (existsSync(filepath)) {
        // === APPEND MODE: Read existing, append new, preserve ALL old content ===
        const existing = readFileSync(filepath, 'utf8');
        const { meta, body } = parseFrontmatter(existing);
        const existingBody = body.trim();

        // Check duplicate: skip if new content already exists in runbook
        if (existingBody.includes(newContent)) {
            logger.info('RUNBOOK APPEND: Content already exists, skipping', { filename, title });
            return { id: filename, action: 'skipped_duplicate', filepath, version: meta.version || 1 };
        }

        // Merge tags (preserve old + add new, filter noise)
        const oldTags = Array.isArray(meta.tags) ? meta.tags : [];
        const mergedTags = filterNoiseTags([...new Set([...oldTags, ...tags.map(t => t.toLowerCase())])]);

        // Update metadata
        meta.tags = mergedTags;
        meta.updated = now;
        meta.version = (meta.version || 1) + 1;
        if (options.success !== undefined) meta.success = options.success;
        if (options.verified !== undefined) meta.verified = options.verified;

        // APPEND new content (preserve ALL existing)
        const newBody = existingBody + '\n\n' + newContent;
        const newFile = buildFrontmatter(meta) + newBody + '\n';

        writeFileSync(filepath, newFile, 'utf8');
        logger.info('RUNBOOK APPENDED', {
            filename, title,
            old_length: existingBody.length,
            new_length: newBody.length,
            version: meta.version
        });

        return { id: filename, action: 'appended', filepath, version: meta.version };
    } else {
        // === CREATE new runbook ===
        const meta = {
            title,
            tags: filterNoiseTags(tags.map(t => t.toLowerCase())),
            created: now,
            updated: now,
            version: 1,
            verified: options.verified || false,
            confidence: options.confidence || 0.5
        };
        if (options.success !== undefined) meta.success = options.success;

        const fileContent = buildFrontmatter(meta) + newContent + '\n';
        writeFileSync(filepath, fileContent, 'utf8');
        logger.info('RUNBOOK CREATED', { filename, title, size: fileContent.length });

        return { id: filename, action: 'created', filepath, version: 1 };
    }
}

/**
 * Read runbook by ID (filename)
 * Returns FULL content without any truncation
 */
export function readRunbook(id) {
    // Try exact filename first
    let filepath = join(RUNBOOKS_DIR, id);
    if (!existsSync(filepath)) {
        // Try adding .md
        if (!id.endsWith('.md')) filepath = join(RUNBOOKS_DIR, id + '.md');
        if (!existsSync(filepath)) {
            // Try searching by title
            const found = findByTitle(id);
            if (found) filepath = found;
            else return null;
        }
    }

    const raw = readFileSync(filepath, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const stat = statSync(filepath);

    return {
        id: basename(filepath),
        title: meta.title || filenameToTitle(basename(filepath)),
        content: body,
        tags: Array.isArray(meta.tags) ? meta.tags : (typeof meta.tags === 'string' ? [meta.tags] : []),
        created_at: meta.created,
        updated_at: meta.updated,
        version: meta.version || 1,
        verified: meta.verified || false,
        confidence: meta.confidence || 0.5,
        success: meta.success,
        filepath,
        file_size: stat.size,
        content_length: body.length
    };
}

/**
 * Find runbook file by title (case-insensitive search)
 */
export function findByTitle(title) {
    const files = readdirSync(RUNBOOKS_DIR).filter(f => f.endsWith('.md'));
    const titleLower = title.toLowerCase();
    const expectedFilename = titleToFilename(title);

    // Exact filename match
    if (files.includes(expectedFilename)) {
        return join(RUNBOOKS_DIR, expectedFilename);
    }

    // Search in frontmatter titles
    for (const file of files) {
        const filepath = join(RUNBOOKS_DIR, file);
        const raw = readFileSync(filepath, 'utf8');
        const { meta } = parseFrontmatter(raw);
        if (meta.title && meta.title.toLowerCase() === titleLower) {
            return filepath;
        }
    }

    return null;
}

/**
 * QUERY EXPANSION v1.0 — Domain-specific synonym mapping
 * Expand search query with related terms for better recall
 * Ported from v5.2 + enhanced for runbook context
 */
const QUERY_SYNONYMS = {
    // Tunneling & Pivoting
    'chisel': ['tunnel', 'proxy', 'pivot', 'socks'],
    'tunnel': ['chisel', 'proxy', 'pivot', 'forward'],
    'pivot': ['tunnel', 'lateral', 'chisel'],
    'ligolo': ['tunnel', 'pivot', 'proxy'],
    'ngrok': ['tunnel', 'forward', 'reverse'],

    // Shells & Access
    'webshell': ['backdoor', 'shell', 'rce', 'upload'],
    'backdoor': ['webshell', 'persistence', 'implant'],
    'shell': ['webshell', 'reverse', 'terminal', 'bash'],
    'rce': ['command', 'injection', 'webshell', 'exploit'],
    'reverse': ['shell', 'callback', 'listener'],

    // Credentials
    'credential': ['password', 'username', 'login', 'creds', 'auth'],
    'password': ['credential', 'pass', 'secret', 'hash'],
    'username': ['user', 'login', 'credential', 'account'],
    'ssh': ['credential', 'login', 'tunnel', 'key', 'sshpass'],
    'token': ['credential', 'auth', 'jwt', 'api'],

    // Vulnerabilities
    'sqli': ['sql', 'injection', 'database', 'union'],
    'xss': ['script', 'injection', 'reflected', 'stored'],
    'lfi': ['file', 'inclusion', 'traversal', 'read'],
    'ssrf': ['request', 'forgery', 'internal', 'fetch'],
    'ssti': ['template', 'injection', 'jinja', 'twig'],
    'xxe': ['xml', 'entity', 'injection', 'dtd'],
    'deserialization': ['unserialize', 'pickle', 'gadget'],

    // Recon
    'recon': ['reconnaissance', 'scan', 'enumeration', 'discovery'],
    'scan': ['nmap', 'port', 'recon', 'rustscan'],
    'subdomain': ['subfinder', 'dns', 'enumeration', 'domain'],

    // General
    'exploit': ['vulnerability', 'payload', 'attack', 'cve'],
    'vuln': ['vulnerability', 'exploit', 'weakness', 'cve'],
    'bypass': ['waf', 'filter', 'evasion', 'circumvent'],
    'persistence': ['backdoor', 'tunnel', 'cron', 'service'],
    'privesc': ['escalation', 'privilege', 'root', 'suid'],
    'root': ['privesc', 'escalation', 'sudo', 'admin'],

    // Techniques
    'gagal': ['failed', 'error', 'blocked', 'patched'],
    'failed': ['gagal', 'error', 'blocked', 'timeout'],
    'berhasil': ['success', 'achieved', 'working'],
    'success': ['berhasil', 'achieved', 'working'],

    // Status
    'alive': ['active', 'working', 'running', 'connected'],
    'dead': ['inactive', 'down', 'disconnected', 'patched']
};

/**
 * Expand query with domain-specific synonyms for better recall
 * @param {string} queryStr - Original search query
 * @returns {string[]} Expanded query words (original + synonyms)
 */
function expandQueryWords(queryStr) {
    if (!queryStr) return [];
    const queryLower = queryStr.toLowerCase();
    const originalWords = queryLower.split(/\s+/).filter(w => w.length >= 2);
    const expanded = new Set(originalWords);

    // SKIP expansion if query contains specific identifiers (domain, hostname, IP, CVE)
    // These queries are already precise — expansion adds noise
    const hasSpecificId = /(?:\w+\.\w+\.\w+|(?:CVE|cve)-\d{4}-\d+|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.test(queryStr);
    if (hasSpecificId) {
        return Array.from(expanded);
    }

    let expansionsAdded = 0;
    const MAX_EXPANSIONS = 4; // Reduced from 6 to reduce noise

    for (const [key, synonyms] of Object.entries(QUERY_SYNONYMS)) {
        if (expansionsAdded >= MAX_EXPANSIONS) break;
        if (originalWords.includes(key) || queryLower.includes(key)) {
            for (const syn of synonyms.slice(0, 2)) {
                if (expansionsAdded >= MAX_EXPANSIONS) break;
                if (!syn.includes(' ') && !expanded.has(syn)) {
                    expanded.add(syn);
                    expansionsAdded++;
                }
            }
        }
    }

    return Array.from(expanded);
}

/**
 * Search runbooks by keyword query
 * Returns results sorted by relevance score
 * v7.0: Query expansion + better scoring + recency decay + credential boost
 */
/**
 * Extract context-aware snippet around first keyword match
 * Instead of returning first 500 chars (which is usually TOC/recon),
 * find WHERE the keyword appears and return context around it
 */
function extractContextSnippet(body, queryWords, maxLen = 600) {
    if (!queryWords.length || !body) return body.substring(0, maxLen);

    const bodyLower = body.toLowerCase();

    // PRIORITY 1: Find exact multi-word phrase match first (e.g. "pujeyden.fokuswarta.id")
    // Join query words that look like a domain/hostname and search as phrase
    const fullQuery = queryWords.join(' ').toLowerCase();
    const domainLike = queryWords.filter(w => w.includes('.') || w.length > 8);
    for (const term of domainLike) {
        const idx = bodyLower.indexOf(term.toLowerCase());
        if (idx !== -1) {
            // Found exact domain/hostname — return generous context around it
            const start = Math.max(0, idx - 200);
            return body.substring(start, start + maxLen).trim();
        }
    }

    // PRIORITY 2: Find section where MOST ORIGINAL query words co-occur (not expanded)
    const sections = body.split(/(?=^## )/m);
    let bestSection = null;
    let bestSectionScore = 0;

    for (const section of sections) {
        const sectionLower = section.toLowerCase();
        let sectionScore = 0;
        let uniqueWordsMatched = 0;
        for (const word of queryWords) {
            const matches = sectionLower.split(word).length - 1;
            if (matches > 0) {
                sectionScore += Math.min(5, matches); // Cap per-word to avoid single-keyword-heavy sections winning
                uniqueWordsMatched++;
            }
        }
        // Bonus: more unique query words matched = better section
        sectionScore *= (1 + uniqueWordsMatched * 0.3);
        if (sectionScore > bestSectionScore) {
            bestSectionScore = sectionScore;
            bestSection = section;
        }
    }

    // If found a matching section, return context around the best keyword match within it
    if (bestSection && bestSectionScore > 0) {
        // Try to find the most specific query word within the section
        const sectionLower = bestSection.toLowerCase();
        for (const word of [...domainLike, ...queryWords]) {
            const idx = sectionLower.indexOf(word.toLowerCase());
            if (idx !== -1) {
                const start = Math.max(0, idx - 150);
                return bestSection.substring(start, start + maxLen).trim();
            }
        }
        return bestSection.substring(0, maxLen).trim();
    }

    // Fallback: find first occurrence of any query word and return context
    for (const word of queryWords) {
        const idx = bodyLower.indexOf(word);
        if (idx !== -1) {
            const start = Math.max(0, idx - 150);
            return body.substring(start, start + maxLen).trim();
        }
    }

    // Final fallback: return beginning
    return body.substring(0, maxLen);
}

/**
 * Count keyword occurrences (not just presence) for better scoring
 */
function countOccurrences(text, word) {
    let count = 0;
    let pos = 0;
    while ((pos = text.indexOf(word, pos)) !== -1) {
        count++;
        pos += word.length;
    }
    return count;
}

export function searchRunbooks(queryStr, options = {}) {
    const { tags = [], limit = 20, offset = 0, fullContent = false, requiredTags = [], scopeId = '' } = options;

    // v7.1: Try FTS5 index first (fast path) — only if no scope/tag filters and index is ready
    const canUseFts = isIndexReady() && !scopeId && tags.length === 0 && requiredTags.length === 0;
    if (canUseFts) {
        const expandedQuery = expandQueryWords(queryStr).join(' ');
        const ftsResults = ftsSearch(expandedQuery, { limit: limit * 2 });

        if (ftsResults && ftsResults.length > 0) {
            // Enrich FTS results with snippets from actual files
            const enriched = [];
            const originalWords = (queryStr || '').toLowerCase().split(/\s+/).filter(w => w.length >= 2);
            const queryWords = expandQueryWords(queryStr);

            for (const fts of ftsResults) {
                const filepath = join(RUNBOOKS_DIR, fts.id);
                if (!existsSync(filepath)) continue;

                let raw;
                try { raw = readFileSync(filepath, 'utf8'); } catch { continue; }
                const { meta, body } = parseFrontmatter(raw);
                const fileTags = Array.isArray(meta.tags) ? meta.tags : (typeof meta.tags === 'string' ? [meta.tags] : []);

                // Apply usefulness boost from access_count
                let score = fts.bm25_score;
                const accessBoost = Math.min(0.5, (fts.access_count || 0) * 0.02);
                score *= (1 + accessBoost);

                // Success/verified boost
                if (fts.success) score *= 1.1;
                if (fts.verified) score *= 1.05;

                // Recency decay
                if (fts.updated_at) {
                    const days = (Date.now() - new Date(fts.updated_at).getTime()) / (1000 * 60 * 60 * 24);
                    const isTeknik = fts.id.toLowerCase().startsWith('teknik_');
                    const decay = isTeknik ? 0.003 : 0.005;
                    score *= Math.max(0.3, 1 / (1 + days * decay));
                }

                const snippet = fullContent ? body : extractContextSnippet(body, queryWords);

                enriched.push({
                    id: fts.id,
                    type: 'runbook',
                    title: meta.title || filenameToTitle(fts.id),
                    snippet,
                    content_length: body.length,
                    tags: fileTags,
                    score: Math.round(score * 100) / 100,
                    created_at: meta.created,
                    updated_at: meta.updated,
                    version: meta.version || 1
                });
            }

            // Filter out score 0 results (irrelevant noise from FTS expansion)
            const filtered = enriched.filter(r => r.score > 0.5);
            filtered.sort((a, b) => b.score - a.score);
            const total = filtered.length;
            const paginated = filtered.slice(offset, offset + limit);

            return {
                results: paginated,
                pagination: { total, offset, limit, returned: paginated.length, has_more: offset + limit < total },
                _engine: 'fts5'
            };
        }
    }

    // FALLBACK: File scan (for scope_id, tag filters, or when FTS5 unavailable)
    const files = readdirSync(RUNBOOKS_DIR).filter(f => f.endsWith('.md'));

    // v7.0: Use expanded query words (original + synonyms) for better recall
    const originalWords = (queryStr || '').toLowerCase().split(/\s+/).filter(w => w.length >= 2);
    const queryWords = expandQueryWords(queryStr);
    const queryLower = (queryStr || '').toLowerCase();

    const results = [];

    for (const file of files) {
        // scope_id filter: only search within ONE specific runbook
        if (scopeId && file !== scopeId && !file.includes(scopeId.replace(/\.md$/, ''))) continue;

        const filepath = join(RUNBOOKS_DIR, file);
        let raw;
        try { raw = readFileSync(filepath, 'utf8'); } catch { continue; }
        const { meta, body } = parseFrontmatter(raw);
        const rawTags = Array.isArray(meta.tags) ? meta.tags : (typeof meta.tags === 'string' ? [meta.tags] : []);
        const fileTags = rawTags.map(t => (t || '').toLowerCase());

        // Required tags filter (must have ALL)
        if (requiredTags.length > 0) {
            if (!requiredTags.every(rt => fileTags.includes(rt.toLowerCase()))) continue;
        }

        // Optional tags filter (must have at least ONE)
        if (tags.length > 0) {
            if (!tags.some(t => fileTags.includes(t.toLowerCase()))) continue;
        }

        // v7.0: Enhanced scoring with original word priority + expanded word support
        const titleLower = (meta.title || file).toLowerCase();
        const filenameLower = file.toLowerCase();
        const contentLower = body.toLowerCase();
        let score = 0;
        let matchedOriginal = 0;  // Track original (non-expanded) word matches
        let matchedWords = 0;

        for (const word of queryWords) {
            let wordMatched = false;
            const isOriginal = originalWords.includes(word);
            // Original words get full weight, expanded synonyms get 0.5x weight
            const weightMultiplier = isOriginal ? 1.0 : 0.5;

            // Title match (highest weight)
            if (titleLower.includes(word)) {
                score += 5 * weightMultiplier;
                wordMatched = true;
            }

            // Tag match (high weight)
            if (fileTags.some(t => t.includes(word))) {
                score += 3 * weightMultiplier;
                wordMatched = true;
            }

            // Filename match (medium-high weight)
            if (filenameLower.includes(word)) {
                score += 2 * weightMultiplier;
                wordMatched = true;
            }

            // Content match with occurrence counting
            const occurrences = countOccurrences(contentLower, word);
            if (occurrences > 0) {
                score += Math.min(5, 1 + Math.log2(occurrences)) * weightMultiplier;
                wordMatched = true;
            }

            if (wordMatched) {
                matchedWords++;
                if (isOriginal) matchedOriginal++;
            }
        }

        // Bonus: ALL ORIGINAL query words matched (precision boost)
        if (originalWords.length > 1 && matchedOriginal === originalWords.length) {
            score *= 1.5;
        }

        // Density adjustment for large files
        if (body.length > 100000 && originalWords.length >= 3 && matchedOriginal < originalWords.length) {
            score *= (matchedOriginal / originalWords.length);
        }

        // v7.0: CREDENTIAL BOOST — credential-related runbooks get priority
        const hasCredentialSignal = fileTags.some(t => ['credential', 'password', 'ssh', 'access', 'root'].includes(t)) ||
            titleLower.includes('credential') || titleLower.includes('password') || titleLower.includes('ssh');
        const queryHasCredentialIntent = originalWords.some(w => ['credential', 'password', 'ssh', 'login', 'creds', 'access', 'token'].includes(w));
        if (hasCredentialSignal && queryHasCredentialIntent) {
            score *= 1.3;
        }

        // v7.0: TECHNIQUE BOOST — technique runbooks get priority when searching for techniques
        const isTeknik = filenameLower.startsWith('teknik_') || titleLower.includes('[teknik]');
        const queryHasTechIntent = originalWords.some(w => ['teknik', 'technique', 'cve', 'exploit', 'bypass', 'rce'].includes(w));
        if (isTeknik && queryHasTechIntent) {
            score *= 1.2;
        }

        // v7.0: RECENCY DECAY — temporal intelligence per type
        // Runbooks: slow decay (knowledge endures), TEKNIK: very slow, others: normal
        if (meta.updated) {
            const daysSinceUpdate = (Date.now() - new Date(meta.updated).getTime()) / (1000 * 60 * 60 * 24);
            const decayFactor = isTeknik ? 0.003 : (filenameLower.startsWith('runbook_') ? 0.005 : 0.01);
            // Formula: 1 / (1 + days * decayFactor) → ranges 0.05 to 1.0
            const recencyMultiplier = Math.max(0.3, 1 / (1 + daysSinceUpdate * decayFactor));
            // Blend: 80% relevance score + 20% recency
            score = score * 0.8 + score * recencyMultiplier * 0.2;
        }

        // v7.0: SUCCESS/VERIFIED BOOST
        if (meta.success === true) score *= 1.1;
        if (meta.verified === true) score *= 1.05;

        if (score > 0.5 || queryWords.length === 0) {  // Raised threshold from 0 to 0.5 — filter irrelevant noise
            // Context-aware snippet: show RELEVANT section, not just file beginning
            const snippet = fullContent ? body : extractContextSnippet(body, queryWords);

            results.push({
                id: file,
                type: 'runbook',
                title: meta.title || filenameToTitle(file),
                snippet,
                content_length: body.length,
                tags: Array.isArray(meta.tags) ? meta.tags : (typeof meta.tags === 'string' ? [meta.tags] : []),
                score: Math.round(score * 100) / 100,
                created_at: meta.created,
                updated_at: meta.updated,
                version: meta.version || 1
            });
        }
    }

    // Sort by score descending, then by updated_at descending (prefer recently updated at same score)
    results.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.updated_at || '').localeCompare(a.updated_at || '');
    });

    const total = results.length;
    const paginated = results.slice(offset, offset + limit);

    return {
        results: paginated,
        pagination: { total, offset, limit, returned: paginated.length, has_more: offset + limit < total }
    };
}

/**
 * List all runbooks with optional filters
 */
export function listRunbooks(options = {}) {
    const { tags = [], limit = 20, offset = 0, titleContains = '', fullContent = false } = options;
    const files = readdirSync(RUNBOOKS_DIR).filter(f => f.endsWith('.md'));
    const items = [];

    for (const file of files) {
        const filepath = join(RUNBOOKS_DIR, file);
        let raw;
        try { raw = readFileSync(filepath, 'utf8'); } catch { continue; }
        const { meta, body } = parseFrontmatter(raw);
        const stat = statSync(filepath);

        // Tag filter (AND: must have ALL)
        if (tags.length > 0) {
            const rawTags = Array.isArray(meta.tags) ? meta.tags : (typeof meta.tags === 'string' ? [meta.tags] : []);
        const fileTags = rawTags.map(t => (t || '').toLowerCase());
            if (!tags.every(t => fileTags.includes(t.toLowerCase()))) continue;
        }

        // Title filter
        if (titleContains) {
            const title = (meta.title || file).toLowerCase();
            if (!title.includes(titleContains.toLowerCase())) continue;
        }

        const item = {
            id: file,
            title: meta.title || filenameToTitle(file),
            tags: Array.isArray(meta.tags) ? meta.tags : (typeof meta.tags === 'string' ? [meta.tags] : []),
            content_length: body.length,
            version: meta.version || 1,
            created_at: meta.created,
            updated_at: meta.updated,
            file_size: stat.size
        };

        if (fullContent) item.content = body;
        else item.snippet = body.substring(0, 500);

        items.push(item);
    }

    // Sort by updated_at desc
    items.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));

    const total = items.length;
    const paginated = items.slice(offset, offset + limit);

    return {
        items: paginated,
        pagination: { total, limit, offset, has_more: offset + limit < total, pages: Math.ceil(total / limit) }
    };
}

/**
 * Delete runbook (move to .deleted/ for safety)
 */
export function deleteRunbook(id, reason = '') {
    const filepath = join(RUNBOOKS_DIR, id);
    if (!existsSync(filepath)) return false;

    const deletedDir = join(RUNBOOKS_DIR, '.deleted');
    if (!existsSync(deletedDir)) mkdirSync(deletedDir, { recursive: true });

    const raw = readFileSync(filepath, 'utf8');
    const timestamp = new Date().toISOString();
    writeFileSync(join(deletedDir, `${timestamp.replace(/[:.]/g, '-')}_${id}`), `<!-- DELETED: ${reason} at ${timestamp} -->\n${raw}`, 'utf8');
    unlinkSync(filepath);

    logger.info('RUNBOOK DELETED', { id, reason });
    return true;
}

/**
 * Get stats about runbooks
 */
export function getStats() {
    const files = readdirSync(RUNBOOKS_DIR).filter(f => f.endsWith('.md'));
    let totalSize = 0;
    let totalContent = 0;

    for (const file of files) {
        const stat = statSync(join(RUNBOOKS_DIR, file));
        totalSize += stat.size;
        try {
            const raw = readFileSync(join(RUNBOOKS_DIR, file), 'utf8');
            const { body } = parseFrontmatter(raw);
            totalContent += body.length;
        } catch {}
    }

    const deletedDir = join(RUNBOOKS_DIR, '.deleted');
    const deletedCount = existsSync(deletedDir) ? readdirSync(deletedDir).length : 0;

    return {
        total_runbooks: files.length,
        total_size_bytes: totalSize,
        total_size_mb: Math.round(totalSize / 1024 / 1024 * 100) / 100,
        total_content_chars: totalContent,
        deleted_count: deletedCount,
        directory: RUNBOOKS_DIR
    };
}

export { filterNoiseTags };

export default {
    RUNBOOKS_DIR,
    titleToFilename,
    filenameToTitle,
    parseFrontmatter,
    buildFrontmatter,
    saveRunbook,
    readRunbook,
    findByTitle,
    findByFuzzyTitle,
    searchRunbooks,
    listRunbooks,
    deleteRunbook,
    getStats,
    expandQueryWords,
    filterNoiseTags
};
