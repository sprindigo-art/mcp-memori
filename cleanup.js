#!/usr/bin/env node
/**
 * AGGRESSIVE MEMORY CLEANUP v1.0
 * Reduces memory_god_mode.json size by removing:
 * - Stale memories (low confidence + old)
 * - Duplicate content (exact match)
 * - Keeping only recent work_logs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.join(__dirname, 'memory_god_mode.json');
const BACKUP_FILE = path.join(__dirname, 'memory_god_mode.backup.json');

async function aggressiveCleanup() {
    console.log('=== AGGRESSIVE MEMORY CLEANUP ===\n');
    
    // Read current file
    const rawData = fs.readFileSync(MEMORY_FILE, 'utf-8');
    const data = JSON.parse(rawData);
    
    const originalSize = Buffer.byteLength(rawData, 'utf-8');
    const originalCount = data.vectors?.length || 0;
    
    console.log(`Original file size: ${(originalSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Original memory count: ${originalCount}`);
    
    // Backup first
    fs.writeFileSync(BACKUP_FILE, rawData);
    console.log(`Backup saved to: ${BACKUP_FILE}\n`);
    
    const now = new Date();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);
    
    // Phase 1: Remove stale memories
    let beforePhase1 = data.vectors.length;
    data.vectors = data.vectors.filter(v => {
        const createdAt = new Date(v.created_at);
        const confidence = v.confidence || 50;
        
        // Keep if: high confidence, recent, or important tags
        const isImportant = v.tags?.some(t => 
            ['CORE_IDENTITY', 'work_log', 'lesson', 'mistake', 'SUCCESS'].includes(t)
        );
        const isRecent = createdAt > threeDaysAgo;
        const isHighConfidence = confidence >= 50;
        const isVeryOld = createdAt < sevenDaysAgo;
        
        // Delete if: low confidence + old + not important
        if (confidence < 30 && isVeryOld && !isImportant) {
            return false;
        }
        
        // Delete if: very low confidence + moderately old + not important
        if (confidence < 20 && createdAt < threeDaysAgo && !isImportant) {
            return false;
        }
        
        return true;
    });
    console.log(`Phase 1 (Stale removal): ${beforePhase1} -> ${data.vectors.length} (-${beforePhase1 - data.vectors.length})`);
    
    // Phase 2: Remove exact duplicates (by content hash)
    let beforePhase2 = data.vectors.length;
    const seenContent = new Map();
    data.vectors = data.vectors.filter(v => {
        const contentHash = v.content.substring(0, 200).toLowerCase().trim();
        if (seenContent.has(contentHash)) {
            const existing = seenContent.get(contentHash);
            // Keep the one with higher confidence
            if (v.confidence > existing.confidence) {
                // Replace with this one
                seenContent.set(contentHash, v);
                return true;
            }
            return false;
        }
        seenContent.set(contentHash, v);
        return true;
    });
    console.log(`Phase 2 (Dedup): ${beforePhase2} -> ${data.vectors.length} (-${beforePhase2 - data.vectors.length})`);
    
    // Phase 3: Remove embeddings from old memories to save space
    let embeddingsRemoved = 0;
    data.vectors.forEach(v => {
        const createdAt = new Date(v.created_at);
        const isOld = createdAt < threeDaysAgo;
        const isImportant = v.tags?.some(t => 
            ['CORE_IDENTITY', 'lesson', 'mistake'].includes(t)
        );
        
        // Remove embeddings from old non-important memories
        if (isOld && !isImportant && v.embedding) {
            delete v.embedding;
            embeddingsRemoved++;
        }
    });
    console.log(`Phase 3 (Embedding cleanup): Removed ${embeddingsRemoved} old embeddings`);
    
    // Phase 4: Limit work_logs to last 50
    let beforePhase4 = data.vectors.length;
    const workLogs = data.vectors.filter(v => v.tags?.includes('work_log'));
    const nonWorkLogs = data.vectors.filter(v => !v.tags?.includes('work_log'));
    
    // Sort work_logs by date and keep only last 50
    const sortedWorkLogs = workLogs
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 50);
    
    data.vectors = [...nonWorkLogs, ...sortedWorkLogs];
    console.log(`Phase 4 (Work log limit): Kept ${sortedWorkLogs.length}/${workLogs.length} work_logs`);
    
    // Phase 5: Limit total to 500 if still too many
    if (data.vectors.length > 500) {
        let beforePhase5 = data.vectors.length;
        // Keep important ones first
        const important = data.vectors.filter(v => 
            v.tags?.some(t => ['CORE_IDENTITY', 'lesson', 'mistake', 'SUCCESS'].includes(t))
        );
        const rest = data.vectors.filter(v => 
            !v.tags?.some(t => ['CORE_IDENTITY', 'lesson', 'mistake', 'SUCCESS'].includes(t))
        );
        
        // Sort rest by date and confidence, keep best ones
        const sortedRest = rest
            .sort((a, b) => {
                const scoreA = (a.confidence || 50) + (new Date(a.created_at).getTime() / 1e12);
                const scoreB = (b.confidence || 50) + (new Date(b.created_at).getTime() / 1e12);
                return scoreB - scoreA;
            })
            .slice(0, 500 - important.length);
        
        data.vectors = [...important, ...sortedRest];
        console.log(`Phase 5 (Hard limit 500): ${beforePhase5} -> ${data.vectors.length}`);
    }
    
    // Clean up other arrays
    if (data.conversation_history?.length > 30) {
        data.conversation_history = data.conversation_history.slice(-30);
        console.log(`Conversation history trimmed to 30`);
    }
    
    if (data.session_summaries?.length > 20) {
        data.session_summaries = data.session_summaries.slice(-20);
        console.log(`Session summaries trimmed to 20`);
    }
    
    if (data.episodic_buffer?.length > 10) {
        data.episodic_buffer = data.episodic_buffer.slice(-10);
        console.log(`Episodic buffer trimmed to 10`);
    }
    
    if (data.auto_store_queue?.length > 20) {
        data.auto_store_queue = data.auto_store_queue.slice(-20);
        console.log(`Auto store queue trimmed to 20`);
    }
    
    // Write cleaned data
    const newData = JSON.stringify(data, null, 2);
    fs.writeFileSync(MEMORY_FILE, newData);
    
    const newSize = Buffer.byteLength(newData, 'utf-8');
    const newCount = data.vectors.length;
    
    console.log('\n=== CLEANUP COMPLETE ===');
    console.log(`New file size: ${(newSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`New memory count: ${newCount}`);
    console.log(`Size reduction: ${((1 - newSize / originalSize) * 100).toFixed(1)}%`);
    console.log(`Memory reduction: ${originalCount - newCount} memories removed`);
}

aggressiveCleanup().catch(console.error);
