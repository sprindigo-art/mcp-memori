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
import { JSONFilePreset } from 'lowdb/node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- VERSION 7.1.0 UPGRADE: AUTO-BOOTSTRAP & ENHANCED REMINDERS ---
const VERSION = "7.1.0";

// --- DB SETUP (LowDB v7) ---
const defaultData = {
  vectors: [],
  episodic_buffer: [],
  policies: [],
  graph_export: null,
  user_preferences: {},
  global_rules: {},
  // NEW v7.0: Session & Conversation Tracking
  sessions: {},           // Track all sessions
  active_session: null,   // Current active session ID
  active_task: null,      // Current task being worked on
  conversation_history: [], // Recent conversation context
  session_summaries: []   // Summaries of past sessions
};
const db = await JSONFilePreset(path.join(__dirname, 'memory_god_mode.json'), defaultData);

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

// --- SMART RETRIEVAL ENGINE (v7.0 Upgrade) ---
async function recursiveRetrieve(query, depth = 0, maxDepth = 2, history = []) {
  if (depth > maxDepth) return [];
  
  const queryVec = await getEmbedding(query);
  const queryLower = query.toLowerCase();
  const wantsMistakes = queryLower.includes("error") || queryLower.includes("mistake") || queryLower.includes("salah") || queryLower.includes("bug");
  
  // v7.0: Get current session for context boosting
  const currentSessionId = db.data.active_session;
  const currentSession = currentSessionId ? db.data.sessions[currentSessionId] : null;
  const sessionMemoryIds = currentSession?.memory_ids || [];

  // 1. Neural Search + Hybrid Boosting + Session Context
  const candidates = db.data.vectors
    .filter(v => v.status !== "POISON")
    .map(v => {
        if (!v.embedding || v.embedding.length !== queryVec.length) return null;
        
        // Base Vector Score
        let score = similarity(queryVec, v.embedding);
        
        // Hybrid Keyword Bonus (Simple overlap)
        const contentLower = v.content.toLowerCase();
        if (contentLower.includes(queryLower)) score += 0.15;
        
        // CRITICAL: Boost "Mistakes" & "Lessons" to prevent repeating errors
        if (v.tags && Array.isArray(v.tags) && v.tags.some(t => ["mistake", "lesson", "anti-pattern", "error"].includes(t))) {
            score += 0.10; // Passive boost
            if (wantsMistakes) score += 0.25; // Active boost
        }

        // CRITICAL: Boost "Work Logs" for context continuity
        if (v.tags && Array.isArray(v.tags) && v.tags.includes("work_log")) {
            const ageHours = (new Date() - new Date(v.created_at)) / (1000 * 60 * 60);
            if (ageHours < 24) score += 0.20; // Recent work logs get huge priority
            if (ageHours < 1) score += 0.15; // Extra boost for very recent (< 1 hour)
        }
        
        // NEW: Boost Core Identity
        if (v.tags && Array.isArray(v.tags) && v.tags.includes("CORE_IDENTITY")) {
            score += 0.30; // High priority for core identity
        }
        
        // NEW: Boost frequently accessed memories (Evolutionary Weighting)
        if (v.access_count) {
            const accessBoost = Math.min(0.20, v.access_count * 0.02); // Cap at 0.20
            score += accessBoost;
        }
        
        // v7.0 NEW: SESSION CONTEXT BOOST - memories from current session get priority
        if (sessionMemoryIds.includes(v.id)) {
            score += 0.25; // Strong boost for same-session memories
        }
        
        // v7.0 NEW: RECENCY BOOST - stronger for very recent memories
        const ageMinutes = (new Date() - new Date(v.created_at)) / (1000 * 60);
        if (ageMinutes < 60) score += 0.15; // Within last hour
        else if (ageMinutes < 180) score += 0.10; // Within last 3 hours
        
        // v7.0 NEW: Boost memories with same tags as active task
        if (db.data.active_task && v.tags && Array.isArray(v.tags)) {
            const taskLower = db.data.active_task.description.toLowerCase();
            const hasTaskKeyword = v.tags.some(t => taskLower.includes(t.toLowerCase()));
            if (hasTaskKeyword) score += 0.15;
        }

        return { ...v, score };
    })
    .filter(v => v && v.score > 0.30) // LOWERED THRESHOLD (0.35 -> 0.30) for even better recall
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);

  // 2. Semantic Reranking (Context & Recency Aware)
  const reranked = candidates.map(c => {
      let boost = 0;
      
      // Factor A: Exact Keyword Match (Strong Signal)
      if (c.content.toLowerCase().includes(queryLower)) boost += 0.20;
      
      // Factor B: Recency Decay (Freshness matters)
      const daysOld = Math.max(0.1, (new Date() - new Date(c.created_at)) / (1000 * 60 * 60 * 24));
      const recencyMultiplier = 1 + (0.5 / daysOld); 
      
      // Factor C: Confidence (Reinforced Memories)
      const confidenceBoost = (c.confidence || 50) / 500;
      
      // Factor D: Evolutionary Access Tracking
      const accessBoost = (c.access_count || 0) * 0.01;

      return { 
        ...c, 
        final_score: (c.score * recencyMultiplier) + boost + confidenceBoost + accessBoost 
      };
  })
  .sort((a, b) => b.final_score - a.final_score)
  .slice(0, 10); // Increased from 8 to 10

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
      {
        name: "agi_run_dream_cycle",
        description: "Maintenance: Deduplicates similar memories and prunes garbage (Low confidence + Old).",
        inputSchema: { type: "object", properties: {} }
      },
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
      {
        name: "agi_get_session_summary",
        description: "Get a summary of the current or previous sessions. Useful for understanding what was accomplished.",
        inputSchema: {
          type: "object",
          properties: {
            include_history: { type: "boolean", default: false }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await db.read();
  await initAI();
  await loadCoreIdentity(); // Ensure core identity is loaded
  await autoRetrieveOnBoot(); // Ensure rules/prefs are loaded

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

    // Smart Deduplication on Ingest
    const tagsString = Array.isArray(tags) ? tags.join(" ") : tags;
    const embedding = await getEmbedding(enhancedContent + " " + tagsString);
    
    if (is_episodic) {
        // Store in episodic buffer
        const id = uuidv4();
        const doc = {
            id, content: enhancedContent, tags: [...tags, 'EPISODIC'], status: "BUFFER",
            confidence: finalConfidence,
            created_at: new Date().toISOString(),
            embedding,
            relations
        };

        // --- SAFETY CHECK: Ensure episodic_buffer exists ---
        if (!db.data.episodic_buffer) {
            db.data.episodic_buffer = [];
        }
        db.data.episodic_buffer.push(doc);
        await db.write();
        return { content: [{ type: "text", text: JSON.stringify({ status: "stored_episodic", id }) }] };
    }

    const dup = db.data.vectors.find(v => similarity(embedding, v.embedding) > 0.96); // Very high threshold
    
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

    // Graph Links
    if (!graph.hasNode(id)) graph.addNode(id, { label: content.substring(0, 20) });
    relations.forEach(rel => {
        const targetId = rel.target.replace(/\s+/g, '_');
        if (!graph.hasNode(targetId)) graph.addNode(targetId, { label: rel.target });
        graph.addEdge(id, targetId, { type: rel.type });
    });
    
    db.data.graph_export = graph.export();
    await db.write();
    
    return { content: [{ type: "text", text: JSON.stringify({ status: "stored", id }) }] };
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

    const cleanResults = results.map(({ embedding, ...rest }) => rest);

    // Generate Natural Language Summary - Enhanced & Actionable
    let coreIdentity = db.data.vectors.find(v => v.tags && Array.isArray(v.tags) && v.tags.includes('CORE_IDENTITY'))?.content || "No Core Identity Loaded";
    
    // Build actionable insights
    let insights = [];
    if (cleanResults.length === 0) {
      insights.push("⚠️ TIDAK ADA MEMORI RELEVAN - Ini task baru, belum ada lesson learned sebelumnya");
    } else {
      const topMatch = cleanResults[0];
      insights.push(`✅ MEMORI TERKUAT: ${topMatch.content.substring(0, 150)}... (Score: ${topMatch.final_score?.toFixed(2) || topMatch.score?.toFixed(2) || 'N/A'})`);
      
      // Check for mistakes/lessons
      const mistakes = cleanResults.filter(r => r.tags && (r.tags.includes('mistake') || r.tags.includes('lesson')));
      if (mistakes.length > 0) {
        insights.push(`⚠️ LESSON LEARNED: ${mistakes.length} kesalahan sebelumnya ditemukan - JANGAN ULANGI!`);
      }
      
      // Check for work logs
      const workLogs = cleanResults.filter(r => r.tags && r.tags.includes('work_log'));
      if (workLogs.length > 0) {
        insights.push(`📝 CONTEXT CONTINUATION: ${workLogs.length} work log sebelumnya - Lanjutkan dari sini`);
      }
      
      // Recency check
      const recentMemories = cleanResults.filter(r => {
        const ageHours = (new Date() - new Date(r.created_at)) / (1000 * 60 * 60);
        return ageHours < 24;
      });
      if (recentMemories.length > 0) {
        insights.push(`🔥 FRESH CONTEXT: ${recentMemories.length} memori dari 24 jam terakhir`);
      }
    }
    
    const summary = `
═══════════════════════════════════════════════════════════════
                    MEMORY RETRIEVAL REPORT
═══════════════════════════════════════════════════════════════

🧠 CORE IDENTITY:
${coreIdentity.substring(0, 300)}...

📊 QUERY ANALYSIS:
   Query: "${query}"
   Memories Found: ${cleanResults.length}
   Strategy: Semantic Vector Search + Keyword Boost + Recency + Evolutionary Weight

💡 ACTIONABLE INSIGHTS:
${insights.map((i, idx) => `   ${idx + 1}. ${i}`).join('\n')}

📚 TOP RELEVANT MEMORIES:
${cleanResults.slice(0, 3).map((r, idx) => `
   ${idx + 1}. [${r.tags ? r.tags.join(', ') : 'no tags'}] (Score: ${r.final_score?.toFixed(2) || r.score?.toFixed(2) || 'N/A'})
      ${r.content.substring(0, 200)}...
      Created: ${r.created_at} | Access: ${r.access_count || 0}x
`).join('')}

═══════════════════════════════════════════════════════════════
`;

    const output = { 
        summary,
        memories: cleanResults, 
        policies,
        meta: {
            count: cleanResults.length,
            strategy: "Semantic + Recency Weighted + Hybrid Boost + Evolutionary Weighting",
            query: query,
            timestamp: new Date().toISOString()
        }
    };
    return { 
        content: [{ 
            type: "text", 
            text: JSON.stringify(output, null, 2) 
        }] 
    };
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

  if (request.params.name === "agi_run_dream_cycle") {
    const result = await runEnhancedDreamCycle();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // v7.0 NEW TOOL HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════════

  if (request.params.name === "agi_bootstrap_session") {
    const bootstrapResult = await autoBootstrap();
    const context = await getSessionContext();
    
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
    
    // Build comprehensive bootstrap response
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
        recent_work_logs: lastWorkLogs,
        recent_conversations: context.recent_conversations,
        last_session_summary: context.last_session_summary
      },
      core_identity: coreIdentity ? coreIdentity.content.substring(0, 500) : "Not loaded",
      statistics: {
        total_memories: db.data.vectors.length,
        episodic_buffer: db.data.episodic_buffer?.length || 0,
        sessions_tracked: Object.keys(db.data.sessions).length,
        conversation_history: db.data.conversation_history.length
      },
      instructions: `
═══════════════════════════════════════════════════════════════
          MCP MEMORY v${VERSION} - SESSION BOOTSTRAPPED
═══════════════════════════════════════════════════════════════

🎯 ACTIVE TASK: ${context.active_task ? context.active_task.description : 'None - use agi_set_active_task to set'}

📝 LAST WORK LOGS:
${lastWorkLogs.slice(0, 3).map((w, i) => `   ${i+1}. ${w.content.substring(0, 150)}...`).join('\n')}

💡 INSTRUCTIONS FOR AI:
   1. Review 'recent_work_logs' to understand last progress
   2. If continuing a task, it should be in 'active_task'
   3. Use 'agi_retrieve_context' for specific queries
   4. Use 'agi_store_memory' to save important results
   5. Use 'agi_set_active_task' to track current work

🔄 SESSION CONTINUITY: ${context.is_new_session ? 'NEW SESSION' : 'CONTINUING'}
═══════════════════════════════════════════════════════════════
`
    };
    
    return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
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

  if (request.params.name === "agi_get_session_summary") {
    const { include_history = false } = request.params.arguments || {};
    
    // Create summary for current session if not exists
    const currentSummary = await createSessionSummary();
    
    const sessionInfo = {
      current_session: {
        id: db.data.active_session,
        info: db.data.sessions[db.data.active_session],
        active_task: db.data.active_task
      },
      statistics: {
        total_sessions: Object.keys(db.data.sessions).length,
        total_memories: db.data.vectors.length,
        total_summaries: db.data.session_summaries.length
      },
      recent_summaries: db.data.session_summaries
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 5)
    };
    
    if (include_history) {
      sessionInfo.conversation_history = db.data.conversation_history.slice(-20);
    }
    
    return { 
      content: [{ 
        type: "text", 
        text: JSON.stringify(sessionInfo, null, 2) 
      }] 
    };
  }

  throw new Error(`Tool ${request.params.name} not found`);
});

const transport = new StdioServerTransport();
await server.connect(transport);

// v7.1 Enhanced startup message with reminder
console.error(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║     🧠 MCP MEMORY v${VERSION} - PERSISTENT INTELLIGENCE SYSTEM 🧠              ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║ v7.1 ENHANCEMENTS:                                                            ║
║   • Enhanced bootstrap response with checklist reminder                       ║
║   • Better session continuity tracking                                        ║
║   • Improved work_log prioritization                                          ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║ CRITICAL TOOLS - WAJIB DIGUNAKAN:                                             ║
║   • agi_bootstrap_session - AWAL SESI: Load context dan state                 ║
║   • agi_set_active_task - REGISTER: Task yang dikerjakan                      ║
║   • agi_retrieve_context - CARI: Lesson learned sebelumnya                    ║
║   • agi_store_memory - SIMPAN: Hasil kerja dan progress                       ║
║   • agi_complete_task - SELESAI: Tandai task selesai                          ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║ 🚨 REMINDER: Panggil agi_bootstrap_session di AWAL SETIAP SESI! 🚨            ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);
