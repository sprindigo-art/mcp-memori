#!/usr/bin/env node
/**
 * MCP Memory Server - Strict JSON-RPC 2.0 over Stdio Implementation
 * @module server
 */
import { createInterface } from 'readline';
import { initDb, closeDb, getDbType } from './db/index.js';
import { getToolDefinitions, executeTool, hasTool } from './mcp/index.js';
import { getEmbeddingMode } from './utils/embedding.js';
import logger from './utils/logger.js';

// Protocol version
const MCP_PROTOCOL_VERSION = '2024-11-05';

class McpServer {
    constructor() {
        this.initialized = false;
        // Use readline interface for robust line-by-line reading
        this.rl = createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: false // Important for stdio pipe
        });
    }

    /**
     * Start the server loop
     */
    async start() {
        // Log startup to stderr (NEVER stdout)
        logger.info('Starting MCP Memory Server...', { pid: process.pid });

        // Handle termination signals
        const cleanup = async (signal) => {
            logger.info(`Received ${signal}, shutting down...`);
            await closeDb();
            process.exit(0);
        };
        process.on('SIGINT', () => cleanup('SIGINT'));
        process.on('SIGTERM', () => cleanup('SIGTERM'));

        // Process line by line
        this.rl.on('line', async (line) => {
            if (!line.trim()) return;
            await this.handleLine(line);
        });

        // Initialize database asynchronously (don't block start)
        try {
            await initDb();
            logger.info('Database initialized', { db: getDbType() });
        } catch (err) {
            logger.error('Database initialization failed', { error: err.message });
            process.exit(1);
        }
    }

    /**
     * Handle raw input line
     */
    async handleLine(line) {
        let request;
        try {
            request = JSON.parse(line);
        } catch (err) {
            this.sendError(null, -32700, "Parse error");
            return;
        }

        // Validate JSON-RPC structure
        if (!request || typeof request !== 'object') {
            this.sendError(request?.id, -32600, "Invalid Request");
            return;
        }

        const { jsonrpc, id, method, params } = request;

        if (jsonrpc !== '2.0') {
            this.sendError(id, -32600, "Invalid Request: jsonrpc must be 2.0");
            return;
        }

        try {
            await this.dispatch(id, method, params);
        } catch (err) {
            logger.error('Dispatch error', { method, error: err.message });
            this.sendError(id, -32603, `Internal error: ${err.message}`);
        }
    }

    /**
     * Dispatch method to handler
     */
    async dispatch(id, method, params) {
        // Notifications (no id)
        if (id === undefined || id === null) {
            if (method === 'notifications/initialized') {
                logger.info('Client initialized notification received');
                this.initialized = true;
            }
            // Ignore other notifications for now
            return;
        }

        // Methods (require response)
        switch (method) {
            case 'initialize':
                return this.handleInitialize(id, params);

            case 'ping':
                return this.sendResult(id, {});

            case 'tools/list':
                return this.handleToolsList(id);

            case 'tools/call':
                return this.handleToolsCall(id, params);

            default:
                return this.sendError(id, -32601, `Method not found: ${method}`);
        }
    }

    /**
     * Handle 'initialize'
     */
    async handleInitialize(id, params) {
        logger.info('Client initializing', { clientInfo: params?.clientInfo });

        const response = {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
                tools: {
                    listChanged: false
                }
            },
            serverInfo: {
                name: 'mcp-memori',
                version: '1.0.0'
            }
        };

        this.sendResult(id, response);
    }

    /**
     * Handle 'tools/list'
     */
    async handleToolsList(id) {
        const tools = getToolDefinitions();
        this.sendResult(id, { tools });
    }

    /**
     * Handle 'tools/call'
     */
    async handleToolsCall(id, params) {
        if (!params || !params.name) {
            return this.sendError(id, -32602, "Invalid params: name required");
        }

        if (!hasTool(params.name)) {
            return this.sendError(id, -32601, `Tool not found: ${params.name}`);
        }

        try {
            const toolResult = await executeTool(params.name, params.arguments || {});

            // Format result according to MCP spec (content array)
            const result = {
                content: [{
                    type: 'text',
                    text: JSON.stringify(toolResult, null, 2)
                }],
                isError: false
            };

            this.sendResult(id, result);
        } catch (err) {
            // Return tool execution error as a result with isError=true (not JSON-RPC error)
            // UNLESS it's a catastrophic failure. MCP allows returning error content.
            const errorResult = {
                content: [{
                    type: 'text',
                    text: `Tool execution failed: ${err.message}`
                }],
                isError: true
            };
            this.sendResult(id, errorResult);
        }
    }

    /**
     * Send success response
     */
    sendResult(id, result) {
        const response = {
            jsonrpc: '2.0',
            id,
            result
        };
        this.write(response);
    }

    /**
     * Send error response
     */
    sendError(id, code, message, data = null) {
        const response = {
            jsonrpc: '2.0',
            id,
            error: {
                code,
                message,
                data
            }
        };
        this.write(response);
    }

    /**
     * Write JSON to stdout
     */
    write(obj) {
        try {
            const str = JSON.stringify(obj);
            process.stdout.write(str + '\n');
        } catch (err) {
            logger.error('Failed to write response', { error: err.message });
        }
    }
}

// Start server
const server = new McpServer();
server.start();
