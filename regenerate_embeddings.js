#!/usr/bin/env node
// REGENERATE EMBEDDINGS untuk memori lama yang tidak punya embedding
// Ini akan membuat semantic search bekerja untuk SEMUA memori

import { pipeline } from "@xenova/transformers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.join(__dirname, 'memory_god_mode.json');

let embeddingPipeline = null;

async function initAI() {
    if (!embeddingPipeline) {
        console.log('Loading embedding model...');
        embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        console.log('Model loaded!');
    }
}

async function getEmbedding(text) {
    if (!embeddingPipeline) await initAI();
    const output = await embeddingPipeline(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

async function main() {
    console.log('=== REGENERATE EMBEDDINGS ===\n');
    
    // Load memory file
    const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    const vectors = data.vectors || [];
    
    // Find vectors without embedding
    const noEmbedding = vectors.filter(v => !v.embedding || !Array.isArray(v.embedding) || v.embedding.length === 0);
    
    console.log(`Total vectors: ${vectors.length}`);
    console.log(`Without embedding: ${noEmbedding.length}`);
    console.log(`With embedding: ${vectors.length - noEmbedding.length}\n`);
    
    if (noEmbedding.length === 0) {
        console.log('All vectors already have embeddings!');
        return;
    }
    
    // Initialize AI
    await initAI();
    
    // Regenerate embeddings
    let processed = 0;
    let errors = 0;
    
    for (const v of noEmbedding) {
        try {
            const content = v.content || '';
            const tags = (v.tags || []).join(' ');
            const textToEmbed = content + ' ' + tags;
            
            if (textToEmbed.trim().length < 5) {
                console.log(`Skip ${v.id}: content too short`);
                continue;
            }
            
            v.embedding = await getEmbedding(textToEmbed);
            v.embedding_regenerated = true;
            v.embedding_regenerated_at = new Date().toISOString();
            
            processed++;
            if (processed % 10 === 0) {
                console.log(`Processed: ${processed}/${noEmbedding.length}`);
            }
        } catch (e) {
            console.error(`Error processing ${v.id}: ${e.message}`);
            errors++;
        }
    }
    
    // Save
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
    
    console.log('\n=== COMPLETE ===');
    console.log(`Processed: ${processed}`);
    console.log(`Errors: ${errors}`);
    console.log(`Now with embedding: ${vectors.filter(v => v.embedding).length}/${vectors.length}`);
}

main().catch(console.error);
