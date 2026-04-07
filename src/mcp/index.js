/**
 * MCP Tools Registry v6.0 — File-based (.md runbooks)
 * Removed: feedback, maintain, reflect (not needed for file storage)
 * @module mcp/index
 */
import searchTool from './tools/memory.search.js';
import getTool from './tools/memory.get.js';
import upsertTool from './tools/memory.upsert.js';
import forgetTool from './tools/memory.forget.js';
import summarizeTool from './tools/memory.summarize.js';
import statsTool from './tools/memory.stats.js';
import listTool from './tools/memory.list.js';

/**
 * All available tools (7 tools — was 10)
 */
export const tools = {
    'memory_search': searchTool,
    'memory_get': getTool,
    'memory_upsert': upsertTool,
    'memory_forget': forgetTool,
    'memory_summarize': summarizeTool,
    'memory_stats': statsTool,
    'memory_list': listTool
};

/**
 * Get tool definitions for MCP protocol
 * @returns {Array}
 */
export function getToolDefinitions() {
    return Object.values(tools).map(t => t.definition);
}

/**
 * Execute a tool by name
 * @param {string} name 
 * @param {object} params 
 * @returns {Promise<object>}
 */
export async function executeTool(name, params) {
    const tool = tools[name];
    if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
    }
    return tool.execute(params);
}

/**
 * Check if tool exists
 * @param {string} name 
 * @returns {boolean}
 */
export function hasTool(name) {
    return name in tools;
}

export default { tools, getToolDefinitions, executeTool, hasTool };
