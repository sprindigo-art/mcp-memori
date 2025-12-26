/**
 * Text normalization utilities
 * @module utils/normalize
 */

/**
 * Normalize text untuk search
 * @param {string} text 
 * @returns {string}
 */
export function normalizeText(text) {
    if (!text) return '';
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
        .replace(/[^\w\s]/g, ' ')        // Replace punctuation with space
        .replace(/\s+/g, ' ')            // Collapse whitespace
        .trim();
}

/**
 * Extract keywords dari text
 * @param {string} text 
 * @param {number} minLength - minimum word length
 * @returns {string[]}
 */
export function extractKeywords(text, minLength = 3) {
    const normalized = normalizeText(text);
    const words = normalized.split(' ');

    // Common stopwords
    const stopwords = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
        'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
        'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
        'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'this',
        'that', 'these', 'those', 'it', 'its', 'yang', 'dan', 'atau', 'di',
        'ke', 'dari', 'untuk', 'dengan', 'pada', 'ini', 'itu', 'adalah',
        'akan', 'sudah', 'telah', 'belum', 'tidak', 'bukan', 'jika', 'jika',
        'maka', 'karena', 'sebab', 'oleh', 'ada', 'bisa', 'dapat', 'harus'
    ]);

    return words.filter(w => w.length >= minLength && !stopwords.has(w));
}

/**
 * Generate snippet dari content
 * @param {string} content 
 * @param {number} maxLength 
 * @returns {string}
 */
export function generateSnippet(content, maxLength = 150) {
    if (!content) return '';
    const clean = content.replace(/\s+/g, ' ').trim();
    if (clean.length <= maxLength) return clean;
    return clean.slice(0, maxLength - 3) + '...';
}

/**
 * Normalize tags to array
 * @param {string|string[]|null} tags 
 * @returns {string[]}
 */
export function normalizeTags(tags) {
    if (!tags) return [];
    if (Array.isArray(tags)) return tags.map(t => t.toLowerCase().trim());
    if (typeof tags === 'string') {
        try {
            const parsed = JSON.parse(tags);
            return Array.isArray(parsed) ? parsed.map(t => t.toLowerCase().trim()) : [];
        } catch {
            return tags.split(',').map(t => t.toLowerCase().trim()).filter(Boolean);
        }
    }
    return [];
}

export default { normalizeText, extractKeywords, generateSnippet, normalizeTags };
