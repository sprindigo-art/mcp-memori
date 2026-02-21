/**
 * Result reranking and post-processing
 * @module retrieval/rerank
 */
import { extractKeywords } from '../utils/normalize.js';
import logger from '../utils/logger.js';

/**
 * v5.2: Common technique/hacking words excluded from target-tag boost.
 * These words appear in queries but are NOT target identifiers (domains, hosts, services).
 * Example: "inarisk exploit rce" → "inarisk" is target, "exploit"/"rce" are techniques.
 */
const COMMON_TECHNIQUE_WORDS = new Set([
    // Attack techniques
    'exploit', 'vulnerability', 'payload', 'attack', 'hack', 'shell', 'webshell',
    'rce', 'xxe', 'sqli', 'xss', 'ssrf', 'lfi', 'rfi', 'ssti', 'idor', 'csrf',
    'injection', 'bypass', 'brute', 'force', 'enum', 'enumeration', 'scan', 'scanner',
    // Infrastructure
    'credential', 'creds', 'password', 'tunnel', 'persistence', 'backdoor', 'reverse',
    'ssh', 'rdp', 'ftp', 'http', 'https', 'mysql', 'postgresql', 'redis', 'smb',
    'port', 'proxy', 'socks', 'chisel', 'ngrok', 'cloudflare', 'cloudflared',
    // Actions
    'recon', 'install', 'deploy', 'upload', 'download', 'exfil', 'exfiltration',
    'access', 'login', 'connect', 'pivot', 'escalate', 'privesc', 'dump',
    // Status/types
    'failed', 'success', 'blocked', 'patched', 'active', 'state', 'decision',
    'episode', 'fact', 'runbook', 'guardrail', 'banned', 'critical',
    // Common qualifiers
    'full', 'updated', 'server', 'target', 'host', 'domain', 'windows', 'linux',
    'tier', 'phase', 'chain', 'kill', 'hunt', 'final', 'master', 'migration'
]);

/**
 * Rerank results based on additional signals
 * @param {Array} results - Search results
 * @param {string} query - Original query
 * @param {object} options - Reranking options
 * @returns {Array}
 */
export function rerank(results, query, options = {}) {
    const {
        boostVerified = true,
        boostRecent = true,
        penalizeErrors = true,
        maxResults = 10
    } = options;

    const keywords = extractKeywords(query);

    const reranked = results.map(result => {
        // v5.1 FIX: Use final_score from hybridSearch (already includes verified, usefulness,
        // type priority, credential boost, recency, and decay multipliers)
        // EVIDENCE: raw score was 20-26 scale vs final_score 0.6-0.85 = INCONSISTENT ranking
        let score = result.final_score || result.score || 0;

        // Penalize items with errors (NOT applied in hybridSearch, unique to rerank)
        if (penalizeErrors && result.error_count > 0) {
            score *= Math.max(0.5, 1 - (result.error_count * 0.1));
        }

        // Title match bonus (NOT applied in hybridSearch, unique to rerank)
        if (keywords.length > 0) {
            const titleLower = (result.title || '').toLowerCase();
            const titleMatches = keywords.filter(k => titleLower.includes(k)).length;
            if (titleMatches > 0) {
                score *= (1 + (titleMatches / keywords.length) * 0.15);
            }
        }

        // v5.2 FIX: Target-Tag Relevance Boost
        // If query contains target identifiers (domain-like names, not common technique words),
        // boost items whose tags contain those exact identifiers.
        // This fixes search precision: "inarisk bnpb exploit" will prioritize items tagged ["inarisk","bnpb"]
        // over generic exploit items tagged ["exploit","rce"] from other targets.
        if (keywords.length > 0) {
            const targetKeywords = keywords.filter(k => !COMMON_TECHNIQUE_WORDS.has(k) && k.length >= 3);
            if (targetKeywords.length > 0) {
                let itemTags = [];
                try {
                    itemTags = typeof result.tags === 'string'
                        ? JSON.parse(result.tags || '[]')
                        : (result.tags || []);
                } catch { itemTags = []; }
                const lowerTags = itemTags.map(t => (t || '').toLowerCase());

                const tagMatches = targetKeywords.filter(tk => lowerTags.includes(tk)).length;
                if (tagMatches > 0) {
                    // 25% boost per matching target keyword, capped at 50%
                    const boost = Math.min(0.5, tagMatches * 0.25);
                    score *= (1 + boost);
                }
            }
        }

        return {
            ...result,
            score, // Reranked score with all adjustments
            final_score: score // v5.2 FIX: Override hybridSearch final_score so search output uses reranked score
        };
    });

    // Sort by final score
    reranked.sort((a, b) => b.score - a.score);

    return reranked.slice(0, maxResults);
}

/**
 * Diversify results to avoid redundancy
 * @param {Array} results 
 * @param {number} maxPerType - Max results per type
 * @returns {Array}
 */
export function diversify(results, maxPerType = 3) {
    const byType = new Map();
    const diversified = [];

    for (const result of results) {
        const type = result.type || 'fact';
        const count = byType.get(type) || 0;

        if (count < maxPerType) {
            diversified.push(result);
            byType.set(type, count + 1);
        }
    }

    return diversified;
}

export default { rerank, diversify };
