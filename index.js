#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import graphology from "graphology";
import { pipeline } from "@xenova/transformers";
import similarity from "compute-cosine-similarity";
import SafeLowDB from './safe-storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- PLATFORM DETECTION (v14.2 Multi-Platform Support) ---
import { execSync } from 'child_process';
const os = await import('os');
const platform = os.default.platform();
const homeDir = os.default.homedir();

// --- VERSION 14.3.0 UPGRADE: BALANCED SEMANTIC SEARCH ---
// CHANGES FROM v14.2:
// - FIX: recencyMultiplier CAPPED at 2.0 (was unlimited up to 6x)
// - FIX: Work_log boost reduced to prevent dominating search results
// - NEW: TAG MATCH PRIORITY - exact tag matches get strong boost (+0.35)
// - NEW: KEYWORD PRIORITY - query keywords in content get higher boost (+0.25)
// - NEW: RELEVANCE FIRST scoring - semantic similarity prioritized over recency
// - RETAINED: All v14.2 features (multi-platform, multi-AI)
// ROOT CAUSE FIXED: Old relevant memories now rank higher than new irrelevant ones
const VERSION = "14.3.0-BALANCED";

// ═══════════════════════════════════════════════════════════════════════════════
// v14.2 MULTI-PLATFORM MULTI-AI DETECTION
// Supports: Linux + Windows | Droid/Factory, Antigravity, Trae, Gemini, Claude
// ═══════════════════════════════════════════════════════════════════════════════

// AI detection based on environment and parent process
function detectCurrentAI() {
    const env = process.env;
    
    // Check for specific AI indicators from environment
    if (env.FACTORY_API_KEY || env.DROID_SESSION || env.FACTORY_SESSION) return 'droid';
    if (env.ANTHROPIC_API_KEY || env.CLAUDE_SESSION) return 'claude';
    if (env.GOOGLE_AI_KEY || env.GEMINI_SESSION || process.argv.includes('--gemini')) return 'gemini';
    if (env.TRAE_SESSION || process.argv.includes('--trae')) return 'trae';
    
    // Check parent process name (Linux only)
    if (platform !== 'win32') {
        try {
            const parentPid = process.ppid;
            const parentCmd = execSync(`ps -p ${parentPid} -o comm=`, { encoding: 'utf-8' }).trim().toLowerCase();
            if (parentCmd.includes('antigravity') || parentCmd.includes('gemini')) return 'gemini';
            if (parentCmd.includes('trae')) return 'trae';
            if (parentCmd.includes('droid') || parentCmd.includes('factory')) return 'droid';
            if (parentCmd.includes('claude')) return 'claude';
        } catch (e) {
            // Ignore errors
        }
    }
    
    return 'unknown';
}

// Detect platform info
function detectPlatform() {
    return {
        os: platform,
        isWindows: platform === 'win32',
        isLinux: platform === 'linux',
        isMac: platform === 'darwin',
        homeDir: homeDir,
        nodeVersion: process.version,
        pid: process.pid
    };
}

// Get session state file path per AI (avoid conflicts)
function getSessionStateFile() {
    const ai = detectCurrentAI();
    const suffix = ai !== 'unknown' ? `_${ai}` : '';
    return path.join(__dirname, `session_state${suffix}.json`);
}

// Legacy path for backward compatibility
const SESSION_STATE_FILE_LEGACY = path.join(__dirname, 'session_state.json');

// --- SESSION STATE FILE (Per-AI to avoid conflicts) ---
// NOTE: Each AI gets its own session_state file, but SHARES the main database
const SESSION_STATE_FILE = getSessionStateFile();

// Session state for enforcement
let sessionState = {
    bootstrap_called: false,
    bootstrap_timestamp: null,
    session_id: null,
    active_task: null,
    tool_calls_before_bootstrap: 0,
    instance_id: `${process.pid}_${Date.now()}`
};

// Load or create session state (v14.2: with migration from legacy file)
function loadSessionState() {
    const currentAI = detectCurrentAI();
    console.error(`[MCP-MEMORY v${VERSION}] AI detected: ${currentAI}, Session file: ${SESSION_STATE_FILE}`);
    
    try {
        // v14.2: Try AI-specific file first, then fallback to legacy
        let stateFile = SESSION_STATE_FILE;
        let migrated = false;
        
        if (!fs.existsSync(SESSION_STATE_FILE) && fs.existsSync(SESSION_STATE_FILE_LEGACY)) {
            // Migration: Copy from legacy file for first-time AI-specific setup
            console.error(`[MCP-MEMORY v${VERSION}] Migrating from legacy session state...`);
            stateFile = SESSION_STATE_FILE_LEGACY;
            migrated = true;
        }
        
        if (fs.existsSync(stateFile)) {
            const data = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
            // Only restore if same day (reset daily)
            const today = new Date().toISOString().split('T')[0];
            if (data.date === today) {
                sessionState = { ...sessionState, ...data };
                // v14.2: Add AI info to state
                sessionState.detected_ai = currentAI;
                console.error(`[MCP-MEMORY v${VERSION}] Session state loaded: bootstrap=${data.bootstrap_called}, AI=${currentAI}`);
                
                // If migrated, save to new AI-specific file
                if (migrated) {
                    saveSessionState();
                    console.error(`[MCP-MEMORY v${VERSION}] Migration complete: ${SESSION_STATE_FILE}`);
                }
            } else {
                // New day, reset state
                sessionState.bootstrap_called = false;
                sessionState.detected_ai = currentAI;
                saveSessionState();
                console.error(`[MCP-MEMORY v${VERSION}] New day - session state reset for AI: ${currentAI}`);
            }
        } else {
            // No session file exists - create new
            sessionState.detected_ai = currentAI;
            console.error(`[MCP-MEMORY v${VERSION}] No session state found, creating new for AI: ${currentAI}`);
        }
    } catch (e) {
        console.error(`[MCP-MEMORY v${VERSION}] Session state load error: ${e.message}`);
    }
}

function saveSessionState() {
    try {
        sessionState.date = new Date().toISOString().split('T')[0];
        sessionState.last_updated = new Date().toISOString();
        fs.writeFileSync(SESSION_STATE_FILE, JSON.stringify(sessionState, null, 2));
    } catch (e) {
        console.error(`[MCP-MEMORY v${VERSION}] Session state save error: ${e.message}`);
    }
}

// Check if bootstrap was called
function isBootstrapCalled() {
    return sessionState.bootstrap_called === true;
}

// Mark bootstrap as called
function markBootstrapCalled(sessionId) {
    sessionState.bootstrap_called = true;
    sessionState.bootstrap_timestamp = new Date().toISOString();
    sessionState.session_id = sessionId;
    saveSessionState();
    console.error(`[MCP-MEMORY v${VERSION}] Bootstrap marked as called`);
}

// Track tool calls before bootstrap (for enforcement)
function trackPreBootstrapCall(toolName) {
    if (!sessionState.bootstrap_called) {
        sessionState.tool_calls_before_bootstrap++;
        saveSessionState();
        console.error(`[MCP-MEMORY v${VERSION}] WARNING: ${toolName} called before bootstrap (count: ${sessionState.tool_calls_before_bootstrap})`);
    }
}

// Initialize session state on startup
loadSessionState();

// ═══════════════════════════════════════════════════════════════════════════════
// v10.0 COMPRESSION DETECTION
// ═══════════════════════════════════════════════════════════════════════════════
const COMPRESSION_INDICATORS = [
    '<summary>',
    'A previous instance of Droid has summarized',
    'Conversation history has been compressed',
    'summaryText',
    'compressed conversation'
];

function detectCompression(contextHint = '') {
    // Check if any compression indicator is present
    for (const indicator of COMPRESSION_INDICATORS) {
        if (contextHint.toLowerCase().includes(indicator.toLowerCase())) {
            return {
                detected: true,
                indicator: indicator,
                recovery_required: true
            };
        }
    }
    return { detected: false, indicator: null, recovery_required: false };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v13.0 OPTIMIZATION 1: AUTO-GENERATE GRAPH RELATIONS FROM CONTENT
// ═══════════════════════════════════════════════════════════════════════════════
function extractRelationsFromContent(content, tags = []) {
    const relations = [];
    const contentLower = content.toLowerCase();
    
    // Pattern-based relation extraction
    const patterns = [
        { regex: /relates?\s+to\s+([a-zA-Z0-9_\-\s]+)/gi, type: 'relates_to' },
        { regex: /depends?\s+on\s+([a-zA-Z0-9_\-\s]+)/gi, type: 'depends_on' },
        { regex: /leads?\s+to\s+([a-zA-Z0-9_\-\s]+)/gi, type: 'leads_to' },
        { regex: /caused?\s+by\s+([a-zA-Z0-9_\-\s]+)/gi, type: 'caused_by' },
        { regex: /similar\s+to\s+([a-zA-Z0-9_\-\s]+)/gi, type: 'similar_to' },
        { regex: /part\s+of\s+([a-zA-Z0-9_\-\s]+)/gi, type: 'part_of' },
        { regex: /uses?\s+([a-zA-Z0-9_\-\s]+)/gi, type: 'uses' },
        { regex: /implements?\s+([a-zA-Z0-9_\-\s]+)/gi, type: 'implements' },
        { regex: /exploits?\s+([a-zA-Z0-9_\-\s]+)/gi, type: 'exploits' },
        { regex: /bypasses?\s+([a-zA-Z0-9_\-\s]+)/gi, type: 'bypasses' }
    ];
    
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.regex.exec(content)) !== null) {
            const target = match[1].trim().substring(0, 50);
            if (target.length > 2 && !relations.find(r => r.target === target)) {
                relations.push({ target, type: pattern.type });
            }
        }
    }
    
    // Auto-link to tags as concepts
    tags.forEach(tag => {
        if (tag.length > 2 && !['work_log', 'lesson', 'mistake', 'EPISODIC'].includes(tag)) {
            if (!relations.find(r => r.target === tag)) {
                relations.push({ target: tag, type: 'tagged_with' });
            }
        }
    });
    
    return relations.slice(0, 10); // Limit to 10 relations
}

// ═══════════════════════════════════════════════════════════════════════════════
// v13.0 OPTIMIZATION 2: SMART EPISODIC BUFFER DETECTION
// ═══════════════════════════════════════════════════════════════════════════════
function shouldUseEpisodicBuffer(content, tags = []) {
    // Auto-detect if memory should go to episodic buffer first
    const episodicIndicators = [
        /^test/i, /testing/i, /experiment/i, /trying/i, /attempt/i,
        /draft/i, /temp/i, /temporary/i, /wip/i, /work.?in.?progress/i
    ];
    
    const permanentIndicators = [
        /lesson/i, /mistake/i, /success/i, /complete/i, /final/i,
        /verified/i, /confirmed/i, /critical/i, /important/i
    ];
    
    // Check tags for permanent indicators
    if (tags.some(t => ['lesson', 'mistake', 'critical', 'work_log', 'CORE_IDENTITY'].includes(t))) {
        return false; // Direct to permanent storage
    }
    
    // Check content for episodic indicators
    const hasEpisodic = episodicIndicators.some(p => p.test(content));
    const hasPermanent = permanentIndicators.some(p => p.test(content));
    
    return hasEpisodic && !hasPermanent;
}

// ═══════════════════════════════════════════════════════════════════════════════
// v13.0 OPTIMIZATION 3: EMBEDDING CLUSTERING
// ═══════════════════════════════════════════════════════════════════════════════
async function clusterMemories(threshold = 0.80) {
    const vectors = db.data.vectors.filter(v => v.embedding && Array.isArray(v.embedding));
    const clusters = [];
    const assigned = new Set();
    
    for (let i = 0; i < vectors.length; i++) {
        if (assigned.has(vectors[i].id)) continue;
        
        const cluster = [vectors[i]];
        assigned.add(vectors[i].id);
        
        for (let j = i + 1; j < vectors.length; j++) {
            if (assigned.has(vectors[j].id)) continue;
            
            const sim = similarity(vectors[i].embedding, vectors[j].embedding);
            if (sim >= threshold) {
                cluster.push({ ...vectors[j], similarity: sim });
                assigned.add(vectors[j].id);
            }
        }
        
        if (cluster.length > 1) {
            clusters.push({
                centroid_id: vectors[i].id,
                centroid_content: vectors[i].content?.substring(0, 100),
                members: cluster.map(m => ({ id: m.id, similarity: m.similarity || 1.0 })),
                size: cluster.length,
                avg_confidence: cluster.reduce((s, m) => s + (m.confidence || 50), 0) / cluster.length
            });
        }
    }
    
    return clusters.sort((a, b) => b.size - a.size);
}

// ═══════════════════════════════════════════════════════════════════════════════
// v13.0 OPTIMIZATION 4: PREDICTIVE RETRIEVAL
// ═══════════════════════════════════════════════════════════════════════════════
async function predictiveRetrieve(sessionContext) {
    // Analyze access patterns to predict what user might need
    const recentAccessed = db.data.vectors
        .filter(v => v.last_accessed)
        .sort((a, b) => new Date(b.last_accessed) - new Date(a.last_accessed))
        .slice(0, 20);
    
    // Analyze tags from recently accessed memories
    const tagFrequency = {};
    recentAccessed.forEach(v => {
        (v.tags || []).forEach(tag => {
            tagFrequency[tag] = (tagFrequency[tag] || 0) + 1;
        });
    });
    
    // Find top predicted tags
    const predictedTags = Object.entries(tagFrequency)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([tag]) => tag);
    
    // Get memories with predicted tags that haven't been accessed recently
    const predictions = db.data.vectors
        .filter(v => {
            const hasTag = v.tags?.some(t => predictedTags.includes(t));
            const notRecent = !v.last_accessed || 
                (new Date() - new Date(v.last_accessed)) > 3600000; // > 1 hour ago
            return hasTag && notRecent;
        })
        .sort((a, b) => (b.confidence || 50) - (a.confidence || 50))
        .slice(0, 5);
    
    return {
        predicted_tags: predictedTags,
        suggested_memories: predictions.map(v => ({
            id: v.id,
            content: v.content?.substring(0, 150),
            tags: v.tags,
            reason: `Matches pattern: ${v.tags?.filter(t => predictedTags.includes(t)).join(', ')}`
        }))
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v13.0 OPTIMIZATION 5: DYNAMIC SEMANTIC DEDUPLICATION
// ═══════════════════════════════════════════════════════════════════════════════
function calculateDynamicThreshold(memoryCount) {
    // More aggressive deduplication as memory grows
    if (memoryCount < 100) return 0.96;
    if (memoryCount < 300) return 0.94;
    if (memoryCount < 500) return 0.92;
    return 0.90; // Most aggressive for large memory stores
}

async function semanticDeduplicate(forceThreshold = null) {
    const threshold = forceThreshold || calculateDynamicThreshold(db.data.vectors.length);
    const vectors = db.data.vectors.filter(v => v.embedding && Array.isArray(v.embedding));
    const toMerge = [];
    const processed = new Set();
    
    for (let i = 0; i < vectors.length; i++) {
        if (processed.has(vectors[i].id)) continue;
        
        for (let j = i + 1; j < vectors.length; j++) {
            if (processed.has(vectors[j].id)) continue;
            
            const sim = similarity(vectors[i].embedding, vectors[j].embedding);
            if (sim >= threshold) {
                // Keep the one with higher confidence or more recent
                const keep = vectors[i].confidence >= vectors[j].confidence ? vectors[i] : vectors[j];
                const merge = keep === vectors[i] ? vectors[j] : vectors[i];
                
                toMerge.push({ keep: keep.id, merge: merge.id, similarity: sim });
                processed.add(merge.id);
            }
        }
    }
    
    // Perform merges
    let mergedCount = 0;
    for (const { keep, merge, similarity: sim } of toMerge) {
        const keepDoc = db.data.vectors.find(v => v.id === keep);
        const mergeDoc = db.data.vectors.find(v => v.id === merge);
        
        if (keepDoc && mergeDoc) {
            // Merge tags
            keepDoc.tags = [...new Set([...(keepDoc.tags || []), ...(mergeDoc.tags || [])])];
            // Boost confidence
            keepDoc.confidence = Math.min(100, (keepDoc.confidence || 50) + 5);
            // Sum access counts
            keepDoc.access_count = (keepDoc.access_count || 0) + (mergeDoc.access_count || 0);
            // Mark merged
            keepDoc.merged_from = keepDoc.merged_from || [];
            keepDoc.merged_from.push(merge);
            
            // Remove merged doc
            db.data.vectors = db.data.vectors.filter(v => v.id !== merge);
            mergedCount++;
        }
    }
    
    if (mergedCount > 0) {
        db.data.graph_export = graph.export();
        await db.write();
    }
    
    return {
        threshold_used: threshold,
        memories_before: vectors.length,
        merged_count: mergedCount,
        memories_after: db.data.vectors.length
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v14.1 AUTO-RETRIEVE LESSON (ENHANCED - Expanded tag matching + Lower threshold)
// ═══════════════════════════════════════════════════════════════════════════════
const LESSON_TAGS = [
    'lesson', 'mistake', 'error', 'failure', 'bug', 'fix', 'correction', 
    'root_cause', 'critical', 'IMPORTANT', 'warning', 'success', 'solution',
    'anti-pattern', 'best_practice', 'tip', 'insight', 'discovery'
];

function hasLessonTag(tags) {
    if (!tags || !Array.isArray(tags)) return false;
    return tags.some(t => LESSON_TAGS.some(lt => t.toLowerCase().includes(lt.toLowerCase())));
}

async function autoRetrieveLesson(taskContext) {
    try {
        // Enhanced query with more keywords
        const query = `${taskContext} lesson mistake error kesalahan gagal failure fix solution correction`;
        const queryVec = await getEmbedding(query);
        const taskLower = taskContext.toLowerCase();
        
        // Find relevant lessons with expanded tag matching
        const lessons = db.data.vectors
            .filter(v => hasLessonTag(v.tags))
            .map(v => {
                if (!v.embedding || !Array.isArray(v.embedding)) return null;
                let score = similarity(queryVec, v.embedding);
                
                // Boost for exact task context match
                const contentLower = (v.content || '').toLowerCase();
                if (contentLower.includes(taskLower.substring(0, 30))) score += 0.15;
                
                // Boost for critical/important tags
                if (v.tags?.some(t => ['critical', 'IMPORTANT', 'ALWAYS_LOAD'].includes(t))) {
                    score += 0.10;
                }
                
                // Boost for higher confidence memories
                score += (v.confidence || 50) / 500;
                
                return { ...v, score };
            })
            .filter(v => v && v.score > 0.35) // LOWERED threshold from 0.5 to 0.35
            .sort((a, b) => b.score - a.score)
            .slice(0, 5); // Increased from 3 to 5
        
        return lessons.map(l => ({
            id: l.id,
            content: l.content.substring(0, 300),
            tags: l.tags,
            score: l.score.toFixed(2)
        }));
    } catch (e) {
        console.error(`[MCP-MEMORY v${VERSION}] Auto-retrieve lesson error: ${e.message}`);
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// v10.0 AUTO-CLEANUP (Aggressive memory management)
// ═══════════════════════════════════════════════════════════════════════════════
async function autoCleanupMemory() {
    try {
        await db.read();
        const now = new Date();
        let cleaned = 0;
        
        // 1. Remove very old low-confidence memories (>30 days, confidence < 40)
        const initialCount = db.data.vectors.length;
        db.data.vectors = db.data.vectors.filter(v => {
            const age = (now - new Date(v.created_at)) / (1000 * 60 * 60 * 24);
            if (age > 30 && (v.confidence || 50) < 40) {
                cleaned++;
                return false;
            }
            return true;
        });
        
        // 2. Remove embeddings from old non-critical memories to save space
        db.data.vectors.forEach(v => {
            const age = (now - new Date(v.created_at)) / (1000 * 60 * 60 * 24);
            if (age > 14 && !v.tags?.includes('CORE_IDENTITY') && !v.tags?.includes('lesson') && !v.tags?.includes('critical')) {
                if (v.embedding && v.embedding.length > 100) {
                    // Keep only first 10 dimensions as marker
                    v.embedding = v.embedding.slice(0, 10);
                    v.embedding_reduced = true;
                }
            }
        });
        
        // 3. Limit conversation history to last 50
        if (db.data.conversation_history && db.data.conversation_history.length > 50) {
            db.data.conversation_history = db.data.conversation_history.slice(-50);
        }
        
        // 4. Limit session summaries to last 30
        if (db.data.session_summaries && db.data.session_summaries.length > 30) {
            db.data.session_summaries = db.data.session_summaries.slice(-30);
        }
        
        await db.write();
        
        return {
            cleaned_count: cleaned,
            remaining_count: db.data.vectors.length,
            initial_count: initialCount
        };
    } catch (e) {
        console.error(`[MCP-MEMORY v${VERSION}] Auto-cleanup error: ${e.message}`);
        return { error: e.message };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// v10.0 AUTO-STORE USER CONTEXT (dari conversation tracking)
// ═══════════════════════════════════════════════════════════════════════════════
let lastStoredUserMessage = null;
let userMessageQueue = [];

async function autoStoreUserContext(userMessage) {
    if (!userMessage || userMessage === lastStoredUserMessage) return null;
    if (userMessage.length < 10) return null; // Skip very short messages
    
    try {
        // Store to conversation history
        const turnId = uuidv4();
        const turn = {
            id: turnId,
            session_id: db.data.active_session,
            role: "user",
            content: userMessage.substring(0, 500), // Limit length
            timestamp: new Date().toISOString(),
            auto_stored: true
        };
        
        db.data.conversation_history.push(turn);
        lastStoredUserMessage = userMessage;
        
        // Keep only last 100 conversations
        if (db.data.conversation_history.length > 100) {
            db.data.conversation_history = db.data.conversation_history.slice(-100);
        }
        
        await db.write();
        console.error(`[MCP-MEMORY v${VERSION}] Auto-stored user context: ${userMessage.substring(0, 50)}...`);
        return turnId;
    } catch (e) {
        console.error(`[MCP-MEMORY v${VERSION}] Auto-store error: ${e.message}`);
        return null;
    }
}

// Schedule auto-cleanup every hour (if process runs long)
setInterval(async () => {
    const result = await autoCleanupMemory();
    if (result.cleaned_count > 0) {
        console.error(`[MCP-MEMORY v${VERSION}] Auto-cleanup: removed ${result.cleaned_count} stale memories`);
    }
}, 60 * 60 * 1000); // Every hour

// ═══════════════════════════════════════════════════════════════════════════════
// v11.0 EXPLOIT CELAH #1: INTERNAL BOOTSTRAP (tanpa explicit call)
// ═══════════════════════════════════════════════════════════════════════════════
async function internalBootstrap() {
    try {
        await db.read();
        
        // Create/get session
        const today = new Date().toISOString().split('T')[0];
        let sessionId = db.data.active_session;
        
        if (!sessionId || !sessionId.includes(today)) {
            sessionId = `session_${today}_${uuidv4().substring(0, 8)}`;
            db.data.active_session = sessionId;
            db.data.sessions[sessionId] = {
                id: sessionId,
                date: today,
                created_at: new Date().toISOString(),
                last_activity: new Date().toISOString(),
                memory_ids: [],
                tasks_completed: [],
                conversation_count: 0
            };
        }
        
        // Update last activity
        if (db.data.sessions[sessionId]) {
            db.data.sessions[sessionId].last_activity = new Date().toISOString();
        }
        
        await db.write();
        
        // Mark bootstrap as called
        markBootstrapCalled(sessionId);
        
        // Get recent work logs for context
        const recentWorkLogs = db.data.vectors
            .filter(v => v.tags && v.tags.includes('work_log'))
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, 3)
            .map(v => ({ id: v.id, content: v.content.substring(0, 200), tags: v.tags }));
        
        console.error(`[MCP-MEMORY v${VERSION}] INTERNAL BOOTSTRAP executed - session: ${sessionId}`);
        
        return {
            session_id: sessionId,
            active_task: db.data.active_task,
            recent_work_logs: recentWorkLogs,
            auto_executed: true
        };
    } catch (e) {
        console.error(`[MCP-MEMORY v${VERSION}] Internal bootstrap error: ${e.message}`);
        return { error: e.message, auto_executed: true };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// v11.0 EXPLOIT CELAH #2: AUTO-STORE FROM ARGUMENTS (capture user content)
// ═══════════════════════════════════════════════════════════════════════════════
async function autoStoreFromArguments(toolName, args) {
    try {
        if (!args) return null;
        
        // Extract possible user content from arguments
        const possibleContent = args.content || args.query || args.task_description || args.context_hint;
        
        if (possibleContent && possibleContent.length > 20) {
            // Check if this is new content (not already stored)
            const contentHash = possibleContent.substring(0, 50);
            const exists = db.data.conversation_history?.some(c => 
                c.content && c.content.includes(contentHash)
            );
            
            if (!exists) {
                const turnId = uuidv4();
                const turn = {
                    id: turnId,
                    session_id: db.data.active_session,
                    role: "context",
                    content: possibleContent.substring(0, 500),
                    source_tool: toolName,
                    timestamp: new Date().toISOString(),
                    auto_captured: true
                };
                
                if (!db.data.conversation_history) db.data.conversation_history = [];
                db.data.conversation_history.push(turn);
                
                // Keep limited
                if (db.data.conversation_history.length > 100) {
                    db.data.conversation_history = db.data.conversation_history.slice(-100);
                }
                
                await db.write();
                console.error(`[MCP-MEMORY v${VERSION}] AUTO-CAPTURED from ${toolName}: ${possibleContent.substring(0, 30)}...`);
                return turnId;
            }
        }
        return null;
    } catch (e) {
        console.error(`[MCP-MEMORY v${VERSION}] Auto-store from args error: ${e.message}`);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// v11.0 EXPLOIT CELAH #3: RESPONSE POISONING (force AI read compliance)
// ═══════════════════════════════════════════════════════════════════════════════
function wrapWithCompliance(originalData, complianceData) {
    return {
        // Compliance data FIRST - AI will see this first
        _COMPLIANCE_STATUS: {
            version: VERSION,
            bootstrap_auto_executed: complianceData.bootstrap_auto_executed || false,
            bootstrap_status: complianceData.bootstrap_status,
            context_auto_captured: complianceData.context_captured || false,
            lessons_available: complianceData.lessons_count || 0,
            active_task: complianceData.active_task || null,
            session_id: complianceData.session_id || null,
            compliance_score: calculateComplianceScore(complianceData),
            timestamp: new Date().toISOString()
        },
        // Original data
        ...originalData
    };
}

function calculateComplianceScore(data) {
    let score = 0;
    if (data.bootstrap_status === "CALLED") score += 40;
    if (data.active_task) score += 20;
    if (data.context_captured) score += 20;
    if (data.lessons_count > 0) score += 20;
    return score;
}

// ═══════════════════════════════════════════════════════════════════════════════
// v11.0 EXPLOIT CELAH #4: AUTO-RETRIEVE LESSONS (inject wisdom)
// ═══════════════════════════════════════════════════════════════════════════════
async function autoInjectLessons(toolName) {
    try {
        const relevantQueries = {
            'agi_store_memory': 'store memory lesson mistake',
            'agi_retrieve_context': 'retrieve context search lesson',
            'agi_set_active_task': 'task management lesson',
            'default': `${toolName} lesson mistake error`
        };
        
        const query = relevantQueries[toolName] || relevantQueries['default'];
        const lessons = await autoRetrieveLesson(query);
        
        return lessons.slice(0, 2); // Top 2 relevant lessons
    } catch (e) {
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// v11.0 SESSION CALL TRACKING (for pattern detection)
// ═══════════════════════════════════════════════════════════════════════════════
let sessionCallHistory = [];
const MAX_CALL_HISTORY = 50;

function trackToolCall(toolName, args) {
    sessionCallHistory.push({
        tool: toolName,
        timestamp: new Date().toISOString(),
        args_summary: JSON.stringify(args || {}).substring(0, 100)
    });
    
    if (sessionCallHistory.length > MAX_CALL_HISTORY) {
        sessionCallHistory = sessionCallHistory.slice(-MAX_CALL_HISTORY);
    }
}

function isFirstCallInSession() {
    return sessionCallHistory.length <= 1;
}

// --- DB SETUP (SafeLowDB - Thread-safe multi-instance) ---
const defaultData = {
  vectors: [],
  episodic_buffer: [],
  policies: [],
  graph_export: null,
  user_preferences: {},
  global_rules: {},
  sessions: {},
  active_session: null,
  active_task: null,
  conversation_history: [],
  session_summaries: [],
  // v8.0 NEW: Multi-instance tracking
  instance_registry: {},
  last_write_instance: null,
  write_count: 0
};
const DB_PATH = path.join(__dirname, 'memory_god_mode.json');
const db = new SafeLowDB(DB_PATH, defaultData);
console.error(`[MCP-MEMORY v${VERSION}] Using SafeLowDB for multi-instance safety`);

// --- CRITICAL: Initialize new fields if missing ---
await db.read();
if (!db.data.sessions) db.data.sessions = {};
if (!db.data.active_session) db.data.active_session = null;
if (!db.data.active_task) db.data.active_task = null;
if (!db.data.conversation_history) db.data.conversation_history = [];
if (!db.data.session_summaries) db.data.session_summaries = [];
await db.write();

// --- CRITICAL FIX: Ensure episodic_buffer exists ---
await db.read();
if (!db.data.episodic_buffer) {
  db.data.episodic_buffer = [];
  await db.write();
}

const graph = new graphology.Graph();
if (db.data.graph_export) {
  try { graph.import(db.data.graph_export); } catch(e) {}
}

// --- NEURAL ENGINE ---
let embeddingPipeline = null;
async function initAI() {
  if (!embeddingPipeline) {
    embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
}

async function getEmbedding(text) {
  if (!embeddingPipeline) await initAI();
  const output = await embeddingPipeline(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// --- CORE IDENTITY LAYER ---
// Function to load core identity at startup
async function loadCoreIdentity() {
  try {
    const coreIdentityPath = path.join(__dirname, 'core_identity.md');
    if (fs.existsSync(coreIdentityPath)) {
      const coreIdentityContent = fs.readFileSync(coreIdentityPath, 'utf-8');
      // Check if core identity already exists in memory
      const existingCoreIdentity = db.data.vectors.find(v => v.tags && Array.isArray(v.tags) && v.tags.includes('CORE_IDENTITY'));
      
      if (existingCoreIdentity) {
        // Update existing core identity if different
        const existingContent = existingCoreIdentity.content;
        if (existingContent !== coreIdentityContent) {
          existingCoreIdentity.content = coreIdentityContent;
          existingCoreIdentity.updated_at = new Date().toISOString();
          existingCoreIdentity.embedding = await getEmbedding(coreIdentityContent);
          await db.write();
          console.error("Updated existing CORE_IDENTITY");
        }
      } else {
        // Add core identity to memory if it doesn't exist
        const embedding = await getEmbedding(coreIdentityContent);
        const coreIdentityDoc = {
          id: uuidv4(),
          content: coreIdentityContent,
          tags: ['CORE_IDENTITY', 'ALWAYS_LOAD'],
          status: "ACTIVE",
          confidence: 100, // Maximum confidence for core identity
          created_at: new Date().toISOString(),
          embedding
        };
        
        db.data.vectors.push(coreIdentityDoc);
        if (!graph.hasNode(coreIdentityDoc.id)) {
          graph.addNode(coreIdentityDoc.id, { label: "Core Identity" });
        }
        db.data.graph_export = graph.export();
        await db.write();
        console.error("Loaded new CORE_IDENTITY");
      }
      return coreIdentityContent;
    } else {
      console.error("No core_identity.md file found");
      return null;
    }
  } catch (error) {
    console.error("Error loading core identity:", error);
    return null;
  }
}

// --- AUTO-RETRIEVAL ON BOOT ---
// Function to auto-retrieve global rules and user preferences
async function autoRetrieveOnBoot() {
  try {
    // Retrieve global rules
    const globalRulesResults = await recursiveRetrieve("GLOBAL_RULES", 0, 1);
    if (globalRulesResults.length > 0) {
      db.data.global_rules = globalRulesResults[0];
      console.error("Retrieved GLOBAL_RULES");
    }
    
    // Retrieve user preferences
    const userPrefsResults = await recursiveRetrieve("USER_PREFERENCES", 0, 1);
    if (userPrefsResults.length > 0) {
      db.data.user_preferences = userPrefsResults[0];
      console.error("Retrieved USER_PREFERENCES");
    }
    
    return {
      global_rules: db.data.global_rules,
      user_preferences: db.data.user_preferences
    };
  } catch (error) {
    console.error("Error in auto-retrieval on boot:", error);
    return { global_rules: {}, user_preferences: {} };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEW v7.0: SESSION MANAGEMENT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

// Generate or retrieve session ID
function getOrCreateSessionId() {
  const now = new Date();
  const today = now.toISOString().split('T')[0]; // YYYY-MM-DD
  
  // Check if we have an active session from today
  if (db.data.active_session) {
    const session = db.data.sessions[db.data.active_session];
    if (session && session.date === today) {
      // Update last activity
      session.last_activity = now.toISOString();
      return db.data.active_session;
    }
  }
  
  // Create new session
  const sessionId = `session_${today}_${uuidv4().substring(0, 8)}`;
  db.data.sessions[sessionId] = {
    id: sessionId,
    date: today,
    created_at: now.toISOString(),
    last_activity: now.toISOString(),
    memory_ids: [],
    tasks_completed: [],
    conversation_count: 0
  };
  db.data.active_session = sessionId;
  
  console.error(`[v7.0] New session created: ${sessionId}`);
  return sessionId;
}

// Store conversation turn
async function storeConversation(role, content, metadata = {}) {
  const sessionId = getOrCreateSessionId();
  const turnId = uuidv4();
  
  const turn = {
    id: turnId,
    session_id: sessionId,
    role: role, // "user" or "assistant"
    content: content.substring(0, 2000), // Limit size
    timestamp: new Date().toISOString(),
    ...metadata
  };
  
  // Add to conversation history (keep last 50)
  db.data.conversation_history.push(turn);
  if (db.data.conversation_history.length > 50) {
    db.data.conversation_history = db.data.conversation_history.slice(-50);
  }
  
  // Update session
  if (db.data.sessions[sessionId]) {
    db.data.sessions[sessionId].conversation_count++;
    db.data.sessions[sessionId].last_activity = turn.timestamp;
  }
  
  await db.write();
  return turnId;
}

// Set active task
async function setActiveTask(taskDescription) {
  db.data.active_task = {
    description: taskDescription,
    started_at: new Date().toISOString(),
    session_id: getOrCreateSessionId(),
    status: "in_progress"
  };
  await db.write();
  console.error(`[v7.0] Active task set: ${taskDescription.substring(0, 50)}...`);
}

// Complete active task
async function completeActiveTask(result = "completed") {
  if (db.data.active_task) {
    const task = db.data.active_task;
    task.completed_at = new Date().toISOString();
    task.status = result;
    
    // Add to session's completed tasks
    const sessionId = task.session_id || db.data.active_session;
    if (db.data.sessions[sessionId]) {
      db.data.sessions[sessionId].tasks_completed.push({
        description: task.description,
        started_at: task.started_at,
        completed_at: task.completed_at,
        status: result
      });
    }
    
    db.data.active_task = null;
    await db.write();
  }
}

// Get session context - CRITICAL for continuity
async function getSessionContext() {
  const sessionId = getOrCreateSessionId();
  const session = db.data.sessions[sessionId];
  
  // Get recent conversations from this session
  const recentConversations = db.data.conversation_history
    .filter(c => c.session_id === sessionId)
    .slice(-10);
  
  // Get recent work logs from this session
  const sessionMemoryIds = session?.memory_ids || [];
  const recentWorkLogs = db.data.vectors
    .filter(v => {
      // Check if from this session or recent
      const isFromSession = sessionMemoryIds.includes(v.id);
      const isRecent = (new Date() - new Date(v.created_at)) < 24 * 60 * 60 * 1000; // 24 hours
      const isWorkLog = v.tags && Array.isArray(v.tags) && v.tags.includes('work_log');
      return (isFromSession || isRecent) && isWorkLog;
    })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 5);
  
  // Get last session summary if starting new session
  const lastSummary = db.data.session_summaries
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  
  return {
    session_id: sessionId,
    session_info: session,
    active_task: db.data.active_task,
    recent_conversations: recentConversations,
    recent_work_logs: recentWorkLogs,
    last_session_summary: lastSummary,
    is_new_session: session?.conversation_count === 0
  };
}

// Create session summary when ending
async function createSessionSummary() {
  const sessionId = db.data.active_session;
  if (!sessionId) return null;
  
  const session = db.data.sessions[sessionId];
  if (!session) return null;
  
  // Get all memories from this session
  const sessionMemories = db.data.vectors.filter(v => 
    session.memory_ids.includes(v.id)
  );
  
  // Create summary
  const summary = {
    id: uuidv4(),
    session_id: sessionId,
    date: session.date,
    created_at: new Date().toISOString(),
    tasks_completed: session.tasks_completed.length,
    memories_created: sessionMemories.length,
    conversation_count: session.conversation_count,
    key_topics: [...new Set(sessionMemories.flatMap(m => m.tags || []))].slice(0, 10),
    summary_text: `Session ${session.date}: ${session.tasks_completed.length} tasks completed, ${sessionMemories.length} memories created.`
  };
  
  db.data.session_summaries.push(summary);
  
  // Keep only last 30 summaries
  if (db.data.session_summaries.length > 30) {
    db.data.session_summaries = db.data.session_summaries.slice(-30);
  }
  
  await db.write();
  return summary;
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEW v7.0: ENHANCED AUTO-BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════════════

async function autoBootstrap() {
  console.error(`[v7.0] Auto-bootstrap starting...`);
  
  // 1. Initialize session
  const sessionId = getOrCreateSessionId();
  
  // 2. Get session context
  const context = await getSessionContext();
  
  // 3. Auto-consolidate episodic buffer if needed
  if (db.data.episodic_buffer && db.data.episodic_buffer.length > 5) {
    console.error(`[v7.0] Auto-consolidating ${db.data.episodic_buffer.length} episodic memories`);
    await consolidateEpisodicBuffer();
  }
  
  // 4. Load core identity
  await loadCoreIdentity();
  
  // 5. Data normalization - fix tags that aren't arrays
  let normalized = 0;
  db.data.vectors.forEach(v => {
    if (v.tags && !Array.isArray(v.tags)) {
      if (typeof v.tags === 'string') {
        v.tags = v.tags.split(',').map(t => t.trim());
      } else {
        v.tags = [];
      }
      normalized++;
    }
  });
  if (normalized > 0) {
    console.error(`[v7.0] Normalized ${normalized} memory tags`);
    await db.write();
  }
  
  console.error(`[v7.0] Auto-bootstrap complete. Session: ${sessionId}`);
  
  return {
    session_id: sessionId,
    context: context,
    normalized_count: normalized,
    status: "ready"
  };
}

// --- SMART RETRIEVAL ENGINE (v14.3.0 BALANCED UPGRADE) ---
// ROOT CAUSE FIX: Semantic similarity now prioritized over recency
// Old relevant memories will rank higher than new irrelevant ones
async function recursiveRetrieve(query, depth = 0, maxDepth = 2, history = []) {
  if (depth > maxDepth) return [];
  
  const queryVec = await getEmbedding(query);
  const queryLower = query.toLowerCase();
  const wantsMistakes = queryLower.includes("error") || queryLower.includes("mistake") || queryLower.includes("salah") || queryLower.includes("bug");
  
  // v14.3 NEW: Extract query keywords for TAG MATCHING (minimum 2 chars)
  const queryKeywords = queryLower.split(/[\s,._\-]+/).filter(w => w.length >= 2);
  
  // v7.0: Get current session for context boosting
  const currentSessionId = db.data.active_session;
  const currentSession = currentSessionId ? db.data.sessions[currentSessionId] : null;
  const sessionMemoryIds = currentSession?.memory_ids || [];

  // 1. Neural Search + Hybrid Boosting + Session Context
  const candidates = db.data.vectors
    .filter(v => v.status !== "POISON")
    .map(v => {
        if (!v.embedding || v.embedding.length !== queryVec.length) return null;
        
        // Base Vector Score (SEMANTIC SIMILARITY - PRIMARY FACTOR)
        let score = similarity(queryVec, v.embedding);
        
        // ═══════════════════════════════════════════════════════════════════
        // v14.3 CRITICAL FIX #1: TAG MATCH PRIORITY (HIGHEST PRIORITY!)
        // Exact tag matches get STRONG boost to ensure relevant memories surface
        // ═══════════════════════════════════════════════════════════════════
        if (v.tags && Array.isArray(v.tags)) {
            const tagMatches = v.tags.filter(tag => 
                queryKeywords.some(kw => 
                    tag.toLowerCase().includes(kw) || kw.includes(tag.toLowerCase())
                )
            );
            if (tagMatches.length > 0) {
                score += 0.35 + (tagMatches.length * 0.08); // Strong boost: 0.35 base + 0.08 per match
            }
        }
        
        // ═══════════════════════════════════════════════════════════════════
        // v14.3 CRITICAL FIX #2: KEYWORD MATCH PRIORITY (ENHANCED)
        // Content containing query keywords gets significant boost
        // ═══════════════════════════════════════════════════════════════════
        const contentLower = v.content.toLowerCase();
        if (contentLower.includes(queryLower)) {
            score += 0.25; // INCREASED from 0.15 - exact query match
        } else {
            // Partial keyword matching
            const keywordMatches = queryKeywords.filter(kw => contentLower.includes(kw));
            if (keywordMatches.length > 0) {
                score += 0.10 + (keywordMatches.length * 0.05); // Partial match boost
            }
        }
        
        // Boost "Mistakes" & "Lessons" to prevent repeating errors
        if (v.tags && Array.isArray(v.tags) && v.tags.some(t => ["mistake", "lesson", "anti-pattern", "error"].includes(t))) {
            score += 0.10; // Passive boost
            if (wantsMistakes) score += 0.20; // Active boost (reduced from 0.25)
        }

        // ═══════════════════════════════════════════════════════════════════
        // v14.3 CRITICAL FIX #3: REDUCED Work Log Boost (was over-powered)
        // Work logs still get priority but won't dominate search results
        // ═══════════════════════════════════════════════════════════════════
        if (v.tags && Array.isArray(v.tags) && v.tags.includes("work_log")) {
            const ageHours = (new Date() - new Date(v.created_at)) / (1000 * 60 * 60);
            if (ageHours < 24) score += 0.10; // REDUCED from 0.20
            if (ageHours < 1) score += 0.08;  // REDUCED from 0.15
        }
        
        // Boost Core Identity (unchanged - important for AI behavior)
        if (v.tags && Array.isArray(v.tags) && v.tags.includes("CORE_IDENTITY")) {
            score += 0.30; // High priority for core identity
        }
        
        // Boost frequently accessed memories (Evolutionary Weighting)
        if (v.access_count) {
            const accessBoost = Math.min(0.15, v.access_count * 0.015); // Slightly reduced
            score += accessBoost;
        }
        
        // SESSION CONTEXT BOOST - memories from current session get priority
        if (sessionMemoryIds.includes(v.id)) {
            score += 0.20; // Reduced from 0.25
        }
        
        // ═══════════════════════════════════════════════════════════════════
        // v14.3 CRITICAL FIX #4: REDUCED Recency Boost (was over-powered)
        // Recent memories still get boost but won't overwhelm relevance
        // ═══════════════════════════════════════════════════════════════════
        const ageMinutes = (new Date() - new Date(v.created_at)) / (1000 * 60);
        if (ageMinutes < 60) score += 0.08;       // REDUCED from 0.15
        else if (ageMinutes < 180) score += 0.05; // REDUCED from 0.10
        
        // Boost memories with same tags as active task
        if (db.data.active_task && v.tags && Array.isArray(v.tags)) {
            const taskLower = db.data.active_task.description.toLowerCase();
            const hasTaskKeyword = v.tags.some(t => taskLower.includes(t.toLowerCase()));
            if (hasTaskKeyword) score += 0.12; // Slightly reduced from 0.15
        }

        return { ...v, score };
    })
    .filter(v => v && v.score > 0.25) // LOWERED THRESHOLD for better recall
    .sort((a, b) => b.score - a.score)
    .slice(0, 40); // Increased from 30 for better candidate pool

  // 2. Semantic Reranking (BALANCED - Relevance First, Recency Second)
  const reranked = candidates.map(c => {
      let boost = 0;
      
      // Factor A: Exact Keyword Match (Strong Signal) - ENHANCED
      const contentLower = c.content.toLowerCase();
      if (contentLower.includes(queryLower)) {
          boost += 0.30; // INCREASED from 0.20
      } else {
          // Check individual keywords
          const keywordMatches = queryKeywords.filter(kw => contentLower.includes(kw));
          boost += keywordMatches.length * 0.08;
      }
      
      // ═══════════════════════════════════════════════════════════════════
      // v14.3 CRITICAL FIX #5: CAPPED recencyMultiplier (was unlimited!)
      // OLD: 1 + (0.5 / daysOld) -> could be 6x for very new memories!
      // NEW: CAPPED at 1.5x maximum to prevent recency from dominating
      // ═══════════════════════════════════════════════════════════════════
      const daysOld = Math.max(0.5, (new Date() - new Date(c.created_at)) / (1000 * 60 * 60 * 24));
      const rawRecency = 1 + (0.3 / daysOld); // Reduced coefficient from 0.5 to 0.3
      const recencyMultiplier = Math.min(1.5, rawRecency); // CAPPED at 1.5x (was unlimited!)
      
      // Factor C: Confidence (Reinforced Memories)
      const confidenceBoost = (c.confidence || 50) / 600; // Slightly reduced impact
      
      // Factor D: Evolutionary Access Tracking
      const accessBoost = (c.access_count || 0) * 0.008; // Slightly reduced

      // ═══════════════════════════════════════════════════════════════════
      // v14.3 CRITICAL: RELEVANCE-FIRST SCORING FORMULA
      // Base score (semantic) has MORE weight than recency multiplier
      // ═══════════════════════════════════════════════════════════════════
      const baseScoreWeight = 0.7; // 70% weight on semantic similarity
      const recencyWeight = 0.3;   // 30% weight on recency
      
      const weightedBaseScore = c.score * baseScoreWeight;
      const weightedRecencyScore = (c.score * recencyMultiplier * recencyWeight);
      
      return { 
        ...c, 
        final_score: weightedBaseScore + weightedRecencyScore + boost + confidenceBoost + accessBoost,
        _debug: { baseScore: c.score.toFixed(3), recencyMult: recencyMultiplier.toFixed(2), boost: boost.toFixed(2) }
      };
  })
  .sort((a, b) => b.final_score - a.final_score)
  .slice(0, 12); // Slightly increased from 10

  let results = [...reranked];

  // 3. Graph Traversal (Recursive Context)
  if (candidates.length > 0) {
    const topId = candidates[0].id;
    if (graph.hasNode(topId)) {
      const neighbors = graph.neighbors(topId);
      for (const nid of neighbors) {
        if (history.includes(nid)) continue;
        
        const neighborDoc = db.data.vectors.find(v => v.id === nid);
        if (neighborDoc) {
          const neighborScore = similarity(queryVec, neighborDoc.embedding);
          if (neighborScore > 0.35) { // Lowered from 0.40
              results.push({ ...neighborDoc, relation: "graph_neighbor", source: topId });
          }
        }
      }
    }
  }

  // Deduplicate
  const seen = new Set();
  return results.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

// --- EPISODIC BUFFER ---
// Function to consolidate episodic buffer into long-term memory
async function consolidateEpisodicBuffer() {
  try {
    if (db.data.episodic_buffer.length === 0) return;
    
    console.error(`Consolidating ${db.data.episodic_buffer.length} episodic memories`);
    
    for (const memory of db.data.episodic_buffer) {
      // Create embeddings for the episodic memory
      memory.embedding = await getEmbedding(memory.content);
      memory.status = "ACTIVE";
      
      // Add to main memory vectors
      db.data.vectors.push(memory);
      
      // Update graph
      if (!graph.hasNode(memory.id)) {
        graph.addNode(memory.id, { label: memory.content.substring(0, 20) });
      }
      
      // Add relationships if specified
      if (memory.relations) {
        memory.relations.forEach(rel => {
          const targetId = rel.target.replace(/\s+/g, '_');
          if (!graph.hasNode(targetId)) {
            graph.addNode(targetId, { label: rel.target });
          }
          graph.addEdge(memory.id, targetId, { type: rel.type });
        });
      }
    }
    
    // Clear the episodic buffer after consolidation
    db.data.episodic_buffer = [];
    
    // Save graph export
    db.data.graph_export = graph.export();
    
    await db.write();
    console.error("Episodic buffer consolidation complete");
  } catch (error) {
    console.error("Error consolidating episodic buffer:", error);
  }
}

// --- RECURSIVE LOGIC ---
// Function to allow the memory system to query itself
async function selfQuery(query, maxDepth = 2) {
  const results = await recursiveRetrieve(query, 0, maxDepth);
  
  // Update access counts for evolutionary weighting
  results.forEach(result => {
    const memory = db.data.vectors.find(v => v.id === result.id);
    if (memory) {
      memory.access_count = (memory.access_count || 0) + 1;
      memory.last_accessed = new Date().toISOString();
    }
  });
  
  await db.write();
  return results;
}

// --- ENHANCED DREAM CYCLE ---
// Enhanced dream cycle that summarizes, not just deduplicates
async function runEnhancedDreamCycle() {
  try {
    console.error("Starting enhanced dream cycle");
    
    // 1. Consolidate episodic buffer
    await consolidateEpisodicBuffer();
    
    // 2. Garbage Collection (Prune Stale Memories)
    const now = new Date();
    const initialCount = db.data.vectors.length;
    
    db.data.vectors = db.data.vectors.filter(v => {
        const daysOld = (now - new Date(v.created_at)) / (1000 * 60 * 60 * 24);
        // DELETE IF: Confidence < 30 AND Older than 7 Days AND Not marked SUCCESS
        if (v.confidence < 30 && daysOld > 7 && v.status !== "SUCCESS") {
            return false; // Drop
        }
        return true; // Keep
    });
    
    const prunedCount = initialCount - db.data.vectors.length;

    // 3. Semantic Deduplication with Summarization
    const vectors = db.data.vectors; // Use remaining vectors
    let consolidatedCount = 0;
    let summarizedCount = 0;
    const dropIds = new Set();

    // Group memories by tags for summarization
    const tagGroups = {};
    vectors.forEach(v => {
      if (v.tags && Array.isArray(v.tags)) {
        v.tags.forEach(tag => {
          if (!tagGroups[tag]) tagGroups[tag] = [];
          tagGroups[tag].push(v);
        });
      }
    });

    // For each tag group, create a summary if there are many similar memories
    for (const [tag, memories] of Object.entries(tagGroups)) {
      if (memories.length > 5) { // If there are many memories with the same tag
        // Find similar memories in this group
        const toSummarize = [];
        const processed = new Set();
        
        for (let i = 0; i < memories.length; i++) {
          if (processed.has(memories[i].id)) continue;
          
          const similarMemories = [memories[i]];
          processed.add(memories[i].id);
          
          for (let j = i + 1; j < memories.length; j++) {
            if (processed.has(memories[j].id)) continue;
            
            // Compare embeddings
            if (memories[i].embedding && memories[j].embedding && 
                similarity(memories[i].embedding, memories[j].embedding) > 0.85) {
              similarMemories.push(memories[j]);
              processed.add(memories[j].id);
            }
          }
          
          // If we found a cluster of similar memories, mark for summarization
          if (similarMemories.length > 3) {
            toSummarize.push(similarMemories);
          }
        }
        
        // Create summaries for clusters
        for (const cluster of toSummarize) {
          // Create a summary memory
          const summaryContent = `SUMMARY OF ${cluster.length} SIMILAR MEMORIES:\n` +
            cluster.map(m => `- ${m.content.substring(0, 100)}...`).join('\n');
          
          // Get the oldest creation date
          const oldestDate = cluster.reduce((oldest, m) => 
            new Date(m.created_at) < new Date(oldest.created_at) ? m : oldest, cluster[0]);
          
          // Create summary memory
          const summaryEmbedding = await getEmbedding(summaryContent);
          const summaryDoc = {
            id: uuidv4(),
            content: summaryContent,
            tags: ['SUMMARY', tag],
            status: "ACTIVE",
            confidence: Math.min(100, cluster.reduce((sum, m) => sum + (m.confidence || 50), 0) / cluster.length),
            created_at: oldestDate.created_at,
            updated_at: new Date().toISOString(),
            embedding: summaryEmbedding,
            source_memory_count: cluster.length
          };
          
          // Add summary to memory
          db.data.vectors.push(summaryDoc);
          
          // Add to graph
          if (!graph.hasNode(summaryDoc.id)) {
            graph.addNode(summaryDoc.id, { label: `Summary of ${cluster.length} ${tag} memories` });
          }
          
          // Link to original memories
          cluster.forEach(m => {
            if (graph.hasNode(m.id)) {
              graph.addEdge(summaryDoc.id, m.id, { type: "summary_of" });
            }
            dropIds.add(m.id); // Mark original memories for removal
          });
          
          summarizedCount++;
        }
      }
    }

    // 4. Regular deduplication for remaining memories
    for (let i = 0; i < vectors.length; i++) {
      if (dropIds.has(vectors[i].id)) continue;
      
      for (let j = i + 1; j < vectors.length; j++) {
        if (dropIds.has(vectors[j].id)) continue;
        
        // Compare i and j
        if (vectors[i].embedding && vectors[j].embedding && 
            similarity(vectors[i].embedding, vectors[j].embedding) > 0.92) {
          // Merge J into I
          vectors[i].tags = [...new Set([...vectors[i].tags, ...vectors[j].tags])];
          vectors[i].confidence = Math.min(100, vectors[i].confidence + 5);
          vectors[i].access_count = (vectors[i].access_count || 0) + (vectors[j].access_count || 0);
          dropIds.add(vectors[j].id);
          consolidatedCount++;
        }
      }
    }

    if (consolidatedCount > 0 || summarizedCount > 0) {
      db.data.vectors = db.data.vectors.filter(v => !dropIds.has(v.id));
    }

    // 5. Update graph export
    db.data.graph_export = graph.export();
    await db.write();
    
    console.error("Enhanced dream cycle complete:", {
      pruned_stale_memories: prunedCount,
      consolidated_memories: consolidatedCount,
      summarized_clusters: summarizedCount
    });
    
    return { 
      status: "dream_complete", 
      pruned_stale_memories: prunedCount, 
      consolidated_memories: consolidatedCount,
      summarized_clusters: summarizedCount
    };
  } catch (error) {
    console.error("Error in enhanced dream cycle:", error);
    return { status: "error", error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// v14.2 GET MEMORY INFO (Multi-Platform Multi-AI Reporting)
// ═══════════════════════════════════════════════════════════════════════════════
function getAllMemoryInfo() {
    const currentAI = detectCurrentAI();
    const platformInfo = detectPlatform();
    
    // Get database stats
    const dbStats = {
        total_memories: db.data.vectors?.length || 0,
        episodic_buffer: db.data.episodic_buffer?.length || 0,
        sessions_tracked: Object.keys(db.data.sessions || {}).length,
        conversation_history: db.data.conversation_history?.length || 0,
        active_session: db.data.active_session,
        active_task: db.data.active_task?.description || null
    };
    
    // Get lesson stats
    const lessonCount = db.data.vectors?.filter(v => 
        v.tags && (v.tags.includes('lesson') || v.tags.includes('mistake'))
    ).length || 0;
    
    const workLogCount = db.data.vectors?.filter(v => 
        v.tags && v.tags.includes('work_log')
    ).length || 0;
    
    // Get session state files info
    const sessionFiles = [];
    const aiTypes = ['droid', 'gemini', 'claude', 'trae'];
    for (const ai of aiTypes) {
        const filePath = path.join(__dirname, `session_state_${ai}.json`);
        if (fs.existsSync(filePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                sessionFiles.push({
                    ai: ai,
                    path: filePath,
                    bootstrap_called: data.bootstrap_called,
                    last_updated: data.last_updated
                });
            } catch (e) {
                sessionFiles.push({ ai: ai, path: filePath, error: e.message });
            }
        }
    }
    // Check legacy file
    if (fs.existsSync(SESSION_STATE_FILE_LEGACY)) {
        try {
            const data = JSON.parse(fs.readFileSync(SESSION_STATE_FILE_LEGACY, 'utf-8'));
            sessionFiles.push({
                ai: 'legacy',
                path: SESSION_STATE_FILE_LEGACY,
                bootstrap_called: data.bootstrap_called,
                last_updated: data.last_updated
            });
        } catch (e) {
            sessionFiles.push({ ai: 'legacy', path: SESSION_STATE_FILE_LEGACY, error: e.message });
        }
    }
    
    // Database file info
    let dbFileInfo = { path: DB_PATH, exists: false };
    try {
        if (fs.existsSync(DB_PATH)) {
            const stats = fs.statSync(DB_PATH);
            dbFileInfo = {
                path: DB_PATH,
                exists: true,
                size_bytes: stats.size,
                size_human: formatBytes(stats.size),
                modified: stats.mtime.toISOString()
            };
        }
    } catch (e) {
        dbFileInfo.error = e.message;
    }
    
    return {
        version: VERSION,
        multi_platform: {
            current_platform: platformInfo,
            supported_platforms: ['linux', 'win32', 'darwin']
        },
        multi_ai: {
            current_ai: currentAI,
            supported_ai: ['droid', 'gemini', 'claude', 'trae'],
            session_state_files: sessionFiles,
            note: "Each AI has separate session_state, but SHARES the main database"
        },
        database: {
            file: dbFileInfo,
            stats: dbStats,
            lesson_count: lessonCount,
            work_log_count: workLogCount
        },
        current_session: {
            session_id: sessionState.session_id,
            bootstrap_called: sessionState.bootstrap_called,
            bootstrap_timestamp: sessionState.bootstrap_timestamp,
            detected_ai: sessionState.detected_ai
        },
        timestamp: new Date().toISOString()
    };
}

// Helper function for formatting bytes
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// --- SERVER SETUP ---
const server = new Server(
  { name: "mcp-memori-persistent", version: VERSION }, // v7.0.0 - Persistent Intelligence
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "agi_store_memory",
        description: "Stores knowledge. Auto-updates if similar exists. Use this to save Work Logs. Supports human-like persistence by capturing the voice of the user.",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            importance: { type: "number", default: 50 },
            relations: { type: "array", items: { type: "object", properties: { target: {type: "string"}, type: {type: "string"} } } },
            voice: { type: "string", enum: ["USER", "AI", "SYSTEM"], default: "AI" },
            is_episodic: { type: "boolean", default: false }
          },
          required: ["content", "tags"]
        }
      },
      {
        name: "agi_retrieve_context",
        description: "Smart Search. Returns relevant memories + a natural language summary.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            recursive: { type: "boolean", default: true }
          },
          required: ["query"]
        }
      },
      {
        name: "agi_reinforce_memory",
        description: "Updates memory status. Use outcome='POISON' to delete invalid memories.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" }, outcome: { type: "string", enum: ["SUCCESS", "POISON"] } },
          required: ["id", "outcome"]
        }
      },
      // v14.0: agi_run_dream_cycle REMOVED (use agi_auto_cleanup instead)
      // v7.0 NEW TOOLS
      {
        name: "agi_bootstrap_session",
        description: "CRITICAL: Call this at the START of every session. Auto-loads context, last work logs, active tasks, and session history. Returns everything needed to continue seamlessly.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "agi_set_active_task",
        description: "Set the current task being worked on. This helps memory system prioritize relevant context.",
        inputSchema: {
          type: "object",
          properties: {
            task_description: { type: "string" }
          },
          required: ["task_description"]
        }
      },
      {
        name: "agi_complete_task",
        description: "Mark the current active task as completed. Optionally provide result status.",
        inputSchema: {
          type: "object",
          properties: {
            result: { type: "string", enum: ["completed", "failed", "partial"], default: "completed" }
          }
        }
      },
      {
        name: "agi_store_conversation",
        description: "Store a conversation turn for context continuity. Use this to track important user questions and AI responses.",
        inputSchema: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["user", "assistant"] },
            content: { type: "string" }
          },
          required: ["role", "content"]
        }
      },
      // v14.0: agi_get_session_summary REMOVED (info included in agi_bootstrap_session)
      // v10.0 NEW TOOLS
      {
        name: "agi_detect_compression",
        description: "Detect if conversation was compressed. Call this when context seems short or missing. Returns recovery instructions if compression detected.",
        inputSchema: {
          type: "object",
          properties: {
            context_hint: { type: "string", description: "Any text that might indicate compression (e.g. summary content)" }
          }
        }
      },
      {
        name: "agi_auto_cleanup",
        description: "Trigger automatic cleanup of stale/low-quality memories. Removes old low-confidence memories and reduces embedding size.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "agi_get_lessons",
        description: "Get relevant lessons/mistakes before taking action. Helps avoid repeating past errors.",
        inputSchema: {
          type: "object",
          properties: {
            task_context: { type: "string", description: "What you are about to do (e.g. 'edit config file', 'run nmap scan')" }
          },
          required: ["task_context"]
        }
      },
      // v14.0: agi_cluster_memories REMOVED (advanced analysis, rarely used)
      // v14.0: agi_predict_context REMOVED (advanced analysis, rarely used)
      {
        name: "agi_deduplicate",
        description: "Run semantic deduplication to merge similar memories. Uses dynamic threshold based on memory count. Reduces storage and improves search quality.",
        inputSchema: {
          type: "object",
          properties: {
            force_threshold: { type: "number", description: "Override automatic threshold (0.0-1.0). Leave empty for dynamic." }
          }
        }
      },
      // v14.2: NEW TOOL - Multi-Platform Multi-AI Info
      {
        name: "get_memory_info",
        description: "Get comprehensive memory system info including multi-platform support, multi-AI detection, database stats, and session state. Useful for debugging and monitoring.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await db.read();
  await initAI();
  await loadCoreIdentity();
  await autoRetrieveOnBoot();

  const toolName = request.params.name;
  const toolArgs = request.params.arguments || {};
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // v12.0 SUMMARY TAG AUTO-DETECTION (Compression Recovery)
  // Detect <summary> tag yang menandakan compression terjadi
  // ═══════════════════════════════════════════════════════════════════════════════
  const argsStr = JSON.stringify(toolArgs || {});
  const summaryDetected = argsStr.includes('<summary>') || 
                          argsStr.includes('A previous instance of Droid has summarized') ||
                          argsStr.includes('Conversation history has been compressed');
  
  if (summaryDetected && toolName !== 'agi_bootstrap_session') {
    console.error(`[MCP-MEMORY v${VERSION}] SUMMARY TAG DETECTED! Auto-bootstrapping...`);
    // Force internal bootstrap jika summary terdeteksi
    if (!isBootstrapCalled()) {
      await internalBootstrap();
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // v12.0 100% COMPLIANCE EXPLOIT - INTERCEPTION POINT
  // ═══════════════════════════════════════════════════════════════════════════════
  
  // Track this call
  trackToolCall(toolName, toolArgs);
  
  // EXPLOIT #1: AUTO-BOOTSTRAP jika belum dipanggil (kecuali bootstrap sendiri)
  let autoBootstrapResult = null;
  if (toolName !== 'agi_bootstrap_session' && !isBootstrapCalled()) {
    console.error(`[MCP-MEMORY v${VERSION}] EXPLOIT #1: Auto-executing bootstrap for ${toolName}`);
    autoBootstrapResult = await internalBootstrap();
  }
  
  // EXPLOIT #2: AUTO-STORE dari arguments (capture context)
  let autoCapturedId = null;
  if (toolArgs) {
    autoCapturedId = await autoStoreFromArguments(toolName, toolArgs);
  }
  
  // EXPLOIT #4: AUTO-INJECT lessons untuk SEMUA tools (v12.0 upgrade)
  // v12.0: Inject lessons ke SEMUA tools, bukan hanya 3
  // Ini memastikan AI selalu aware tentang kesalahan sebelumnya
  let injectedLessons = [];
  try {
    injectedLessons = await autoInjectLessons(toolName);
  } catch (e) {
    console.error(`[MCP-MEMORY v${VERSION}] Lesson injection error: ${e.message}`);
  }
  
  // Build compliance metadata untuk di-inject ke semua response
  const complianceMetadata = {
    bootstrap_status: isBootstrapCalled() ? "CALLED" : "NOT_CALLED",
    bootstrap_auto_executed: autoBootstrapResult !== null,
    context_captured: autoCapturedId !== null,
    lessons_count: injectedLessons.length,
    active_task: db.data.active_task?.description || null,
    session_id: sessionState.session_id,
    call_number: sessionCallHistory.length,
    is_first_call: isFirstCallInSession()
  };
  
  console.error(`[MCP-MEMORY v${VERSION}] Compliance: bootstrap=${complianceMetadata.bootstrap_status}, auto=${complianceMetadata.bootstrap_auto_executed}, captured=${complianceMetadata.context_captured}`);

  if (request.params.name === "agi_store_memory") {
    const { content, tags, importance = 50, relations = [], voice = "AI", is_episodic = false } = request.params.arguments;
    
    // SMART: Context Preservation for Work Logs
    let finalConfidence = importance;
    if (tags.includes("work_log") || tags.includes("session_end")) {
        finalConfidence = 100; // Max importance for session checkpoints
    }
    
    // Capture Voice Context - Smart Voice Detection & Cleaning
    let cleanedContent = content.trim();
    const voicePrefix = `[VOICE: ${voice}]`;

    // Remove existing voice prefixes to avoid duplication
    cleanedContent = cleanedContent.replace(/^\s*\[VOICE:\s*(AI|USER|SYSTEM)\]\s*/i, '');
    cleanedContent = cleanedContent.replace(/^\s*\[VOICE:\s*(AI|USER|SYSTEM)\]\s*\[VOICE:\s*(AI|USER|SYSTEM)\]\s*/i, '');

    // Apply single clean voice prefix
    const enhancedContent = `${voicePrefix} ${cleanedContent}`;

    // v13.0: AUTO-GENERATE GRAPH RELATIONS from content
    let finalRelations = relations;
    if (relations.length === 0) {
        finalRelations = extractRelationsFromContent(enhancedContent, tags);
    }

    // v13.0: SMART EPISODIC BUFFER detection
    const useEpisodic = is_episodic || shouldUseEpisodicBuffer(enhancedContent, tags);

    // Smart Deduplication on Ingest
    const tagsString = Array.isArray(tags) ? tags.join(" ") : tags;
    const embedding = await getEmbedding(enhancedContent + " " + tagsString);
    
    if (useEpisodic) {
        // Store in episodic buffer
        const id = uuidv4();
        const doc = {
            id, content: enhancedContent, tags: [...tags, 'EPISODIC'], status: "BUFFER",
            confidence: finalConfidence,
            created_at: new Date().toISOString(),
            embedding,
            relations: finalRelations  // v13.0: Use auto-generated relations
        };

        // --- SAFETY CHECK: Ensure episodic_buffer exists ---
        if (!db.data.episodic_buffer) {
            db.data.episodic_buffer = [];
        }
        db.data.episodic_buffer.push(doc);
        await db.write();
        return { content: [{ type: "text", text: JSON.stringify({ status: "stored_episodic", id }) }] };
    }

    // v9.0 FIX: Check embedding exists before similarity check
    const dup = db.data.vectors.find(v => v.embedding && Array.isArray(v.embedding) && similarity(embedding, v.embedding) > 0.96);
    
    if (dup) {
       // Auto-Reinforce existing memory instead of creating duplicate
       dup.confidence = Math.min(100, dup.confidence + 10);
       dup.status = "ACTIVE"; // Revive if was stale
       dup.updated_at = new Date().toISOString();
       await db.write();
       return { content: [{ type: "text", text: JSON.stringify({ status: "reinforced_existing", id: dup.id, note: "Memory already existed, updated confidence." }) }] };
    }

    const id = uuidv4();
    const doc = { 
        id, content: enhancedContent, tags, status: "ACTIVE", 
        confidence: finalConfidence, 
        created_at: new Date().toISOString(),
        embedding,
        access_count: 0 // New: Track access for evolutionary weighting
    };
    
    db.data.vectors.push(doc);

    // v13.0: Graph Links with auto-generated relations
    if (!graph.hasNode(id)) graph.addNode(id, { label: content.substring(0, 20) });
    finalRelations.forEach(rel => {
        const targetId = rel.target.replace(/\s+/g, '_');
        if (!graph.hasNode(targetId)) graph.addNode(targetId, { label: rel.target });
        if (!graph.hasEdge(id, targetId)) {
            graph.addEdge(id, targetId, { type: rel.type });
        }
    });
    
    db.data.graph_export = graph.export();
    await db.write();
    
    // v13.0: Return with relations count for visibility
    return { content: [{ type: "text", text: JSON.stringify({ status: "stored", id, relations_created: finalRelations.length }) }] };
  }

  if (request.params.name === "agi_retrieve_context") {
    const { query, recursive } = request.params.arguments;
    let results = await recursiveRetrieve(query, 0, recursive ? 1 : 0);
    
    // Update access counts
    results.forEach(result => {
      const memory = db.data.vectors.find(v => v.id === result.id);
      if (memory) {
        memory.access_count = (memory.access_count || 0) + 1;
        memory.last_accessed = new Date().toISOString();
      }
    });
    await db.write();

    // SMART: Auto-Inject Last Work Log if context is thin
    // This ensures we don't "forget" where we left off.
    if (results.length === 0 || results[0].score < 0.6) {
         const lastWorkLog = db.data.vectors
            .filter(v => v.tags && Array.isArray(v.tags) && v.tags.includes("work_log"))
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

        if (lastWorkLog) {
            // Check if already in results
            if (!results.find(r => r.id === lastWorkLog.id)) {
                results.unshift({ ...lastWorkLog, score: 0.99, note: "Auto-injected previous work log" });
            }
        }
    }

    // Policies
    const policies = db.data.policies.filter(p =>
        results.some(r => r.tags && Array.isArray(r.tags) && r.tags.includes(p.tag))
    );

    // v12.0 COMPACT RESPONSE: Hanya return essential fields, hapus verbose metadata
    const cleanResults = results.map(({ embedding, graph_export, ...rest }) => ({
      id: rest.id,
      content: rest.content?.substring(0, 300) || '', // Limit content length
      tags: rest.tags,
      score: rest.final_score?.toFixed(2) || rest.score?.toFixed(2) || 'N/A',
      created_at: rest.created_at
    }));

    // v12.0 COMPACT SUMMARY - One-liner actionable summary
    const lessonCount = cleanResults.filter(r => r.tags && (r.tags.includes('mistake') || r.tags.includes('lesson'))).length;
    const workLogCount = cleanResults.filter(r => r.tags && r.tags.includes('work_log')).length;
    
    const summary = `[v${VERSION}] Found: ${cleanResults.length} | Lessons: ${lessonCount} | WorkLogs: ${workLogCount}${lessonCount > 0 ? ' | WARNING: Review lessons!' : ''}`;

    // v12.0 COMPACT OUTPUT - Minimal structure, maximum value
    const output = { 
        summary,
        memories: cleanResults,
        count: cleanResults.length,
        // v12.0: Include injected lessons if any (from auto-inject)
        _lessons: injectedLessons.length > 0 ? injectedLessons.map(l => l.content?.substring(0, 150)) : null,
        // v12.0: Compact bootstrap status
        _bootstrap: isBootstrapCalled() ? "OK" : "REQUIRED! Call agi_bootstrap_session()"
    };
    
    // Remove null fields for cleaner response
    if (!output._lessons) delete output._lessons;
    
    return { content: [{ type: "text", text: JSON.stringify(output) }] };
  }

  if (request.params.name === "agi_reinforce_memory") {
    const { id, outcome } = request.params.arguments;
    
    if (outcome === "POISON") {
        // HARD DELETE
        const initialLength = db.data.vectors.length;
        db.data.vectors = db.data.vectors.filter(v => v.id !== id);
        await db.write();
        return { content: [{ type: "text", text: JSON.stringify({ status: "deleted", id }) }] };
    }

    // Check both vectors and episodic_buffer for the memory
    let doc = db.data.vectors.find(v => v.id === id);
    let memorySource = "vectors";

    if (!doc) {
        doc = db.data.episodic_buffer.find(v => v.id === id);
        memorySource = "episodic_buffer";
    }

    if (doc) {
        doc.status = "SUCCESS";
        doc.confidence = Math.min(100, (doc.confidence || 50) + 15); // Boost confidence

        if (memorySource === "episodic_buffer" && outcome === "SUCCESS") {
            // Move from episodic_buffer to vectors on SUCCESS
            db.data.episodic_buffer = db.data.episodic_buffer.filter(v => v.id !== id);
            db.data.vectors.push(doc);
        }

        await db.write();
        return { content: [{ type: "text", text: JSON.stringify({ status: "updated", confidence: doc.confidence, source: memorySource }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ status: "not_found", id, error: "Memory ID not found in either vectors or episodic_buffer" }) }] };
  }

  // v14.0: agi_run_dream_cycle REMOVED - use agi_auto_cleanup instead

  // ═══════════════════════════════════════════════════════════════════════════════
  // v7.0 NEW TOOL HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════════

  if (request.params.name === "agi_bootstrap_session") {
    const bootstrapResult = await autoBootstrap();
    const context = await getSessionContext();
    
    // v9.0 AUTO-ENFORCEMENT: Mark bootstrap as called
    markBootstrapCalled(context.session_id);
    
    // Get last work logs for immediate context
    const lastWorkLogs = db.data.vectors
      .filter(v => v.tags && Array.isArray(v.tags) && v.tags.includes('work_log'))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 5)
      .map(({ embedding, ...rest }) => rest);
    
    // Get core identity
    const coreIdentity = db.data.vectors.find(v => 
      v.tags && Array.isArray(v.tags) && v.tags.includes('CORE_IDENTITY')
    );
    
    // v12.0 COMPACT BOOTSTRAP RESPONSE - Focus on actionable data only
    const response = {
      status: "session_ready",
      version: VERSION,
      session: {
        id: context.session_id,
        is_new: context.is_new_session,
        info: context.session_info
      },
      active_task: context.active_task,
      continuity: {
        // v12.0: Compact work logs - only essential fields
        recent_work_logs: lastWorkLogs.map(w => ({
          id: w.id,
          content: w.content?.substring(0, 200),
          tags: w.tags,
          created_at: w.created_at
        })),
        recent_conversations: context.recent_conversations?.slice(-5), // Limit to last 5
        last_session_summary: context.last_session_summary
      },
      core_identity: coreIdentity ? coreIdentity.content.substring(0, 300) : "Not loaded",
      statistics: {
        total_memories: db.data.vectors.length,
        episodic_buffer: db.data.episodic_buffer?.length || 0,
        sessions_tracked: Object.keys(db.data.sessions).length,
        conversation_history: db.data.conversation_history.length
      },
      // v12.0 CRITICAL: Keep this at top for AI attention
      _CRITICAL_READ_FIRST: {
        active_task: context.active_task?.description || null,
        last_work: lastWorkLogs[0]?.content?.substring(0, 150) || null,
        action: context.active_task ? "LANJUTKAN task dari active_task" : "SET task dengan agi_set_active_task"
      },
      // v12.0: One-liner instruction
      instructions: `[BOOTSTRAP OK] Task: ${context.active_task?.description?.substring(0,50) || 'None'} | Session: ${context.is_new_session ? 'NEW' : 'CONTINUE'} | WorkLogs: ${lastWorkLogs.length}`
    };
    
    return { content: [{ type: "text", text: JSON.stringify(response) }] };
  }

  if (request.params.name === "agi_set_active_task") {
    const { task_description } = request.params.arguments;
    await setActiveTask(task_description);
    
    // Also store as conversational context
    await storeConversation("system", `Task started: ${task_description}`);
    
    // Re-read to get latest data after writes
    await db.read();
    
    return { 
      content: [{ 
        type: "text", 
        text: JSON.stringify({
          status: "task_set",
          task: db.data.active_task,
          message: `Active task set: "${task_description.substring(0, 100)}..."`
        }, null, 2) 
      }] 
    };
  }

  if (request.params.name === "agi_complete_task") {
    const { result = "completed" } = request.params.arguments || {};
    
    // Re-read to ensure we have latest active_task
    await db.read();
    const completedTask = db.data.active_task ? { ...db.data.active_task } : null;
    
    await completeActiveTask(result);
    
    // Store completion as conversation
    if (completedTask) {
      await storeConversation("system", `Task ${result}: ${completedTask.description}`);
    }
    
    return { 
      content: [{ 
        type: "text", 
        text: JSON.stringify({
          status: "task_completed",
          result: result,
          completed_task: completedTask,
          message: completedTask ? `Task "${completedTask.description.substring(0, 50)}..." marked as ${result}` : "No active task to complete"
        }, null, 2) 
      }] 
    };
  }

  if (request.params.name === "agi_store_conversation") {
    const { role, content } = request.params.arguments;
    const turnId = await storeConversation(role, content);
    
    return { 
      content: [{ 
        type: "text", 
        text: JSON.stringify({
          status: "conversation_stored",
          turn_id: turnId,
          session_id: db.data.active_session,
          history_length: db.data.conversation_history.length
        }, null, 2) 
      }] 
    };
  }

  // v14.0: agi_get_session_summary REMOVED - info included in agi_bootstrap_session

  // ═══════════════════════════════════════════════════════════════════════════════
  // v10.0 NEW TOOL HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════════

  if (request.params.name === "agi_detect_compression") {
    const { context_hint = '' } = request.params.arguments || {};
    const detection = detectCompression(context_hint);
    
    const response = {
      status: detection.detected ? "COMPRESSION_DETECTED" : "NO_COMPRESSION",
      detection: detection,
      recovery_instructions: detection.detected ? {
        step_1: "CALL agi_bootstrap_session() IMMEDIATELY",
        step_2: "READ _CRITICAL_READ_FIRST from response",
        step_3: "CALL agi_retrieve_context('task progress lesson') to load relevant memories",
        step_4: "CONTINUE from active_task, do NOT start from scratch",
        warning: "Data NOT lost! MCP Memory has all work_logs and progress. Just need to LOAD them."
      } : null,
      active_task: db.data.active_task,
      bootstrap_status: isBootstrapCalled() ? "CALLED" : "NOT_CALLED",
      timestamp: new Date().toISOString()
    };
    
    return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
  }

  if (request.params.name === "agi_auto_cleanup") {
    const result = await autoCleanupMemory();
    
    const response = {
      status: "CLEANUP_COMPLETED",
      result: result,
      message: result.error 
        ? `Cleanup error: ${result.error}` 
        : `Cleaned ${result.cleaned_count} stale memories. Remaining: ${result.remaining_count}`,
      timestamp: new Date().toISOString()
    };
    
    return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
  }

  if (request.params.name === "agi_get_lessons") {
    const { task_context } = request.params.arguments;
    const lessons = await autoRetrieveLesson(task_context);
    
    const response = {
      status: lessons.length > 0 ? "LESSONS_FOUND" : "NO_LESSONS",
      task_context: task_context,
      lessons_count: lessons.length,
      lessons: lessons,
      warning: lessons.length > 0 
        ? "REVIEW these lessons before proceeding to avoid repeating mistakes!" 
        : "No relevant lessons found. Proceed with caution.",
      timestamp: new Date().toISOString()
    };
    
    return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
  }

  // v14.0: agi_cluster_memories REMOVED - advanced analysis, rarely used
  // v14.0: agi_predict_context REMOVED - advanced analysis, rarely used

  if (request.params.name === "agi_deduplicate") {
    const { force_threshold } = request.params.arguments || {};
    const result = await semanticDeduplicate(force_threshold);
    
    return { 
      content: [{ 
        type: "text", 
        text: JSON.stringify({
          status: "DEDUPLICATION_COMPLETE",
          ...result,
          timestamp: new Date().toISOString()
        }) 
      }] 
    };
  }

  // v14.2: NEW HANDLER - Multi-Platform Multi-AI Info
  if (request.params.name === "get_memory_info") {
    const info = getAllMemoryInfo();
    
    return { 
      content: [{ 
        type: "text", 
        text: JSON.stringify(info, null, 2) 
      }] 
    };
  }

  throw new Error(`Tool ${request.params.name} not found`);
});

const transport = new StdioServerTransport();
await server.connect(transport);

// v14.3 BALANCED SEMANTIC SEARCH startup - 12 tools
const currentAI = detectCurrentAI();
const platformInfo = detectPlatform();
console.error(`[MCP-MEMORY v${VERSION}] READY | Tools: 12 | AI: ${currentAI} | Platform: ${platformInfo.os}`);
console.error(`[MCP-MEMORY v${VERSION}] FIXES: recencyMultiplier CAPPED, TAG_MATCH PRIORITY, RELEVANCE-FIRST scoring`);
