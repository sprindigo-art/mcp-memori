/**
 * Privacy Scrubber v1.0 — redact sensitive patterns for auto-capture hooks
 *
 * IMPORTANT: Scrubber HANYA digunakan oleh hook auto-capture untuk
 * section `## _AUTO_LOG`. Manual memory_upsert ke section state
 * (CREDENTIAL/EXPLOIT/LIVE STATUS) TIDAK di-scrub — itu wajib apa adanya
 * karena memang dibutuhkan AI untuk re-exploitation.
 *
 * Scrubber tujuannya:
 * 1. Cegah bocoran accidental di log (output tool yang tidak relevan tapi
 *    mengandung session token / password ambient).
 * 2. Strip `<private>...</private>` tags eksplisit dari user.
 *
 * @module utils/scrubber
 */

/**
 * Redaction patterns — sanitize sensitive data from auto-log ONLY.
 * Each pattern matches a key-value or credential-like structure and replaces
 * the value portion with [REDACTED].
 */
const PATTERNS = [
    // <private>...</private> tags (user-controlled privacy)
    { re: /<private>[\s\S]*?<\/private>/gi, replace: '[REDACTED-PRIVATE]' },

    // SSH private key blocks
    { re: /-----BEGIN (?:OPENSSH |RSA |DSA |EC |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH |RSA |DSA |EC |PGP )?PRIVATE KEY-----/g, replace: '[REDACTED-SSH-KEY]' },

    // AWS / Azure / GCP key patterns
    { re: /AKIA[0-9A-Z]{16}/g, replace: '[REDACTED-AWS-KEY]' },
    { re: /AIza[0-9A-Za-z_-]{35}/g, replace: '[REDACTED-GCP-KEY]' },

    // Bearer tokens / JWT (3 base64 segments)
    { re: /\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replace: '[REDACTED-JWT]' },

    // GitHub / GitLab personal access tokens
    { re: /\bghp_[A-Za-z0-9]{36,}\b/g, replace: '[REDACTED-GH-TOKEN]' },
    { re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, replace: '[REDACTED-GL-TOKEN]' },

    // Generic "password: value" / "passwd=value" / "pass: value" in ambient logs
    // Only scrubs when key follows a space/newline/start, preventing false positives
    // like "password_hash" or "passwordless". Matches value until whitespace/quote/end.
    { re: /(^|[\s,;({[])(password|passwd|pass|pwd|secret|api[_-]?key|auth[_-]?token)\s*[:=]\s*["']?([^\s"'<>,;)}\]]{4,})["']?/gi, replace: '$1$2: [REDACTED]' },

    // "Authorization: ..." HTTP header
    { re: /Authorization:\s*[^\r\n]+/gi, replace: 'Authorization: [REDACTED]' },

    // Cookie header values
    { re: /(Cookie|Set-Cookie):\s*[^\r\n]+/gi, replace: '$1: [REDACTED]' },
];

/**
 * Scrub sensitive patterns from text.
 * Returns scrubbed text + count of redactions performed (for logging).
 * @param {string} text
 * @returns {{text: string, redactions: number}}
 */
export function scrub(text) {
    if (!text || typeof text !== 'string') return { text: '', redactions: 0 };
    let out = text;
    let count = 0;
    for (const { re, replace } of PATTERNS) {
        const before = out;
        out = out.replace(re, replace);
        if (before !== out) {
            // Estimate redaction count by comparing match counts
            const matches = before.match(re);
            count += matches ? matches.length : 0;
        }
    }
    return { text: out, redactions: count };
}

/**
 * Truncate large payload to a max length, keeping head + tail.
 * Useful for tool_response that can be MBs of scan output.
 * @param {string} text
 * @param {number} maxLen - default 3000 chars
 * @returns {string}
 */
export function truncate(text, maxLen = 3000) {
    if (!text) return '';
    if (text.length <= maxLen) return text;
    const head = Math.floor(maxLen * 0.6);
    const tail = maxLen - head - 30;
    return text.substring(0, head) + `\n...[${text.length - head - tail} chars truncated]...\n` + text.substring(text.length - tail);
}

export default { scrub, truncate };
