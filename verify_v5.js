import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  console.log("[TEST] Starting Verification of mcp-memori v5.0.0...");

  const transport = new StdioClientTransport({
    command: "node",
    args: ["D:\\Games\\bot\\mcp-memori\\index.js"],
  });

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log("[TEST] Connected to Server.");

  // 1. Store Memory
  console.log("[TEST] Storing Memory...");
  await client.callTool({
    name: "agi_store_memory",
    arguments: {
      content: "The code for Project Omega is 'RED-SUN-99'. This is a secret.",
      tags: ["secret", "omega", "codes"],
      importance: 90
    }
  });

  // 2. Retrieve Memory
  console.log("[TEST] Retrieving Memory...");
  const result = await client.callTool({
    name: "agi_retrieve_context",
    arguments: {
      query: "What is the code for Omega?",
      recursive: true
    }
  });

  const data = JSON.parse(result.content[0].text);
  
  // 3. Verification Logic
  console.log("\n--- RESULTS ---");
  
  if (data.summary) {
      console.log("[PASS] 'summary' field present.");
      console.log(`[SUMMARY]: ${data.summary}`);
  } else {
      console.error("[FAIL] 'summary' field MISSING.");
  }

  const memory = data.memories.find(m => m.content.includes("RED-SUN-99"));
  if (memory) {
      console.log("[PASS] Memory retrieved successfully.");
      console.log(`[SCORE]: ${memory.final_score}`);
      console.log(`[CONFIDENCE]: ${memory.confidence}`);
      
      if (memory.final_score > 0.6) {
          console.log("[PASS] Relevance Score is high (Smart Reranking works).");
      } else {
          console.warn("[WARN] Relevance Score is low.");
      }
  } else {
      console.error("[FAIL] Memory NOT found.");
  }

  // 4. Dream Cycle
  console.log("\n[TEST] Running Dream Cycle...");
  const dream = await client.callTool({
      name: "agi_run_dream_cycle",
      arguments: {}
  });
  console.log(`[DREAM OUTPUT]: ${dream.content[0].text}`);

  process.exit(0);
}

main().catch(err => {
    console.error("[FATAL ERROR]", err);
    process.exit(1);
});
