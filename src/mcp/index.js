/**
 * MCP Tools Registry
 * @module mcp/index
 */
import searchTool from './tools/memory.search.js';
import getTool from './tools/memory.get.js';
import upsertTool from './tools/memory.upsert.js';
import forgetTool from './tools/memory.forget.js';
import summarizeTool from './tools/memory.summarize.js';
import feedbackTool from './tools/memory.feedback.js';
import maintainTool from './tools/memory.maintain.js';

/**
 * All available tools
 */
export const tools = {
    'memory_search': searchTool,
    'memory_get': getTool,
    'memory_upsert': upsertTool,
    'memory_forget': forgetTool,
    'memory_summarize': summarizeTool,
    'memory_feedback': feedbackTool,
    'memory_maintain': maintainTool
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
