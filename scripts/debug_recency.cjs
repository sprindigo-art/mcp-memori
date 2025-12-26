const { query } = require('../src/db/index.js');
const { recencyScore } = require('../src/utils/time.js');
const path = require('path');

async function debug() {
    console.log('DEBUG RECENCY');

    // 1. Get item
    const items = await query("SELECT id, title, updated_at FROM memory_items WHERE title LIKE '%Asyncio (LAMA)%'");
    const item = items[0];

    if (!item) {
        console.log('Item not found');
        return;
    }

    console.log('Item:', item);
    console.log('updated_at type:', typeof item.updated_at);

    // 2. Test Date parsing
    const dateObj = new Date(item.updated_at);
    console.log('Date object:', dateObj.toString());
    console.log('Is Valid Date:', !isNaN(dateObj.getTime()));

    // 3. Test Recency Score
    const score = recencyScore(item.updated_at);
    console.log('Recency Score:', score);
}

debug().catch(console.error);
