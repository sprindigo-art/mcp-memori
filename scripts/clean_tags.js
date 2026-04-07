/**
 * One-time script: Clean noise tags from all existing runbooks
 * Run: node scripts/clean_tags.js
 */
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const RUNBOOKS_DIR = '/home/kali/Desktop/mcp-memori/runbooks';

const NOISE_TAGS = new Set([
    'gagal', 'failed', 'success', 'berhasil', 'blocked', 'alive', 'dead',
    'active', 'critical', 'update', 'updated', 'progress', 'complete',
    'state', 'checkpoint', 'fact', 'episode', 'decision',
    'ssh', 'credential', 'password', 'recon', 'exploit', 'persistence',
    'root', 'rce', 'upload', 'injection', 'bypass', 'scan', 'pivot',
    'lateral-movement', 'infrastructure', 'network-map', 'database',
    'tunnel', 'fix', 'waf', 'dns', 'mail', 'smtp', 'windows', 'linux',
    'mar2026', 'apr2026', 'feb2026', 'jan2026',
    'technique', 'runbook', 'universal', 'audit', 'verification',
    'lesson-learned', 'bug', 'fatal', 'hunt', 'research', 'ready',
    'development', 'compiled', 'exhausted', 'final', 'new-target',
    'discovery', 'live-status', 're-entry', 'checklist', 'cleanup',
    'attack-chain', 'anti-sleep',
]);

function filterNoiseTags(tags) {
    return tags.filter(t => {
        const tl = (t || '').toLowerCase().trim();
        if (!tl || tl.length < 2) return false;
        if (/^cve-/i.test(tl)) return true;
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}/.test(tl)) return true;
        if (/\.\w{2,}$/.test(tl) && tl.includes('.')) return true;
        if (NOISE_TAGS.has(tl)) return false;
        return true;
    });
}

function parseFrontmatter(content) {
    if (!content || !content.startsWith('---\n')) return { meta: {}, body: content || '' };
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
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
            value = value.slice(1, -1);
        if (value.startsWith('[') && value.endsWith(']')) {
            try { value = JSON.parse(value); } catch {
                try { value = JSON.parse(value.replace(/'/g, '"')); } catch {}
            }
            if (typeof value === 'string') value = [value];
        } else if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (/^\d+$/.test(value)) value = parseInt(value, 10);
        else if (/^\d+\.\d+$/.test(value)) value = parseFloat(value);
        meta[key] = value;
    }
    return { meta, body };
}

function buildFrontmatter(meta) {
    const lines = ['---'];
    for (const [key, value] of Object.entries(meta)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) lines.push(`${key}: ${JSON.stringify(value)}`);
        else lines.push(`${key}: ${value}`);
    }
    lines.push('---\n');
    return lines.join('\n');
}

const files = readdirSync(RUNBOOKS_DIR).filter(f => f.endsWith('.md'));
let cleaned = 0;
let totalRemoved = 0;

for (const file of files) {
    const filepath = join(RUNBOOKS_DIR, file);
    const raw = readFileSync(filepath, 'utf8');
    const { meta, body } = parseFrontmatter(raw);

    if (!Array.isArray(meta.tags) || meta.tags.length === 0) continue;

    const oldCount = meta.tags.length;
    meta.tags = filterNoiseTags(meta.tags);
    const newCount = meta.tags.length;
    const removed = oldCount - newCount;

    if (removed > 0) {
        writeFileSync(filepath, buildFrontmatter(meta) + body, 'utf8');
        totalRemoved += removed;
        cleaned++;
        console.log(`${file}: ${oldCount} → ${newCount} tags (-${removed})`);
    }
}

console.log(`\nDone: ${cleaned} files cleaned, ${totalRemoved} noise tags removed`);
