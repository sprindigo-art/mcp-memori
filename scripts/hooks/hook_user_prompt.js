#!/usr/bin/env node
/**
 * UserPromptSubmit hook — per-prompt semantic memory injection.
 *
 * ONLY injects when prompt contains target-identifiable keywords
 * (domain, IP, CVE, technique name). Generic prompts like "fix this"
 * or "ujicoba perbaikan" get NOTHING — prevents noise injection.
 *
 * CONTRACT (Claude Code hook):
 * - Input: stdin JSON { prompt, session_id, ... }
 * - Output: stdout JSON { hookSpecificOutput: { hookEventName, additionalContext } }
 * - Exit 0 always (never block user)
 */
import { readStdinJson, hookLog } from './hook_lib.js';
import { searchRunbooks } from '../../src/storage/files.js';
import { initSearchIndex, isIndexReady } from '../../src/storage/searchIndex.js';

const MAX_CONTEXT_CHARS = 1200;
const MIN_PROMPT_LENGTH = 20;
const MAX_RESULTS = 2;
const MIN_SCORE = 5.0;

function emptyOutput() {
    return JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: ''
        }
    });
}

/**
 * Check if prompt contains target-identifiable signals.
 * Only inject memory when prompt is ABOUT a specific target/technique.
 * Generic prompts ("fix bug", "coba lagi", "ujicoba") = skip.
 */
function hasTargetSignal(prompt) {
    const lower = prompt.toLowerCase();
    // Domain-like pattern (x.y.z or x.y)
    if (/[a-z0-9][-a-z0-9]*\.[a-z]{2,}(?:\.[a-z]{2,})?/.test(lower)) return true;
    // IP address
    if (/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(lower)) return true;
    // CVE
    if (/cve-\d{4}-\d+/i.test(lower)) return true;
    // Specific technique/tool keywords (not generic)
    const techSignals = [
        'webshell', 'reverse shell', 'privesc', 'rce ', 'sqli', 'xss',
        'credential', 'ssh ', 'tunnel', 'proxmox', 'oracle', 'fpx',
        'payment', 'checkout', 'exploit', 'duitnow', 'hackerone',
        'bugbounty', 'bug bounty', 'runbook', 'target'
    ];
    if (techSignals.some(sig => lower.includes(sig))) return true;
    return false;
}

async function main() {
    const input = readStdinJson();
    const prompt = input?.prompt || input?.content || '';

    if (!prompt || prompt.length < MIN_PROMPT_LENGTH || prompt.startsWith('/')) {
        process.stdout.write(emptyOutput());
        process.exit(0);
    }

    // CRITICAL: Only inject when prompt is about a specific target
    if (!hasTargetSignal(prompt)) {
        process.stdout.write(emptyOutput());
        process.exit(0);
    }

    try {
        if (!isIndexReady()) {
            try { initSearchIndex(); } catch {}
        }

        const { results } = searchRunbooks(prompt, { limit: 10, offset: 0 });

        if (!results || results.length === 0) {
            process.stdout.write(emptyOutput());
            process.exit(0);
        }

        // Dedup by ID + filter by MIN_SCORE
        const seen = new Set();
        const relevant = [];
        for (const r of results) {
            if (r.score < MIN_SCORE) continue;
            const id = r.id;
            if (seen.has(id)) continue;
            seen.add(id);
            relevant.push(r);
            if (relevant.length >= MAX_RESULTS) break;
        }

        if (relevant.length === 0) {
            process.stdout.write(emptyOutput());
            process.exit(0);
        }

        const parts = ['# Memory Context (auto-injected)'];
        let totalChars = parts[0].length;

        for (const r of relevant) {
            const title = r.title || r.id;
            const snippet = (r.snippet || '').substring(0, 300).replace(/\n/g, ' ').trim();
            const entry = `- **${title}** (v${r.version || 1}, ${r.content_length || 0} chars): ${snippet}`;

            if (totalChars + entry.length > MAX_CONTEXT_CHARS) break;
            parts.push(entry);
            totalChars += entry.length;
        }

        if (parts.length <= 1) {
            process.stdout.write(emptyOutput());
            process.exit(0);
        }

        parts.push(`\n> \`memory_get({id:"ID"})\` for full runbook.`);
        const context = parts.join('\n');

        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext: context
            }
        }));

        hookLog('INFO', 'UserPromptSubmit injected', {
            prompt_preview: prompt.substring(0, 60),
            results: relevant.length,
            context_len: context.length,
            top_score: relevant[0]?.score,
            top_id: relevant[0]?.id
        });
    } catch (err) {
        hookLog('ERROR', 'UserPromptSubmit exception', { error: err?.message });
        process.stdout.write(emptyOutput());
    }

    process.exit(0);
}

main().catch((err) => {
    hookLog('FATAL', 'UserPromptSubmit fatal', { error: err?.message });
    process.stdout.write(emptyOutput());
    process.exit(0);
});
