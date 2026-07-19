/**
 * MCPManager — Model Context Protocol client for the assistant
 * (docs/COWORK_AGENT.md §2, phase C2). Main process only.
 *
 * Speaks MCP's stdio transport directly: newline-delimited JSON-RPC 2.0
 * (initialize → notifications/initialized → tools/list / tools/call). The
 * protocol surface the assistant needs is deliberately tiny, so a
 * hand-rolled client beats pulling the SDK into Electron's main process
 * (no ESM/CJS friction, and we own the lifecycle).
 *
 * Lifecycle mirrors the Ollama philosophy: servers start lazily on first
 * tool call, stop after IDLE_MS of no calls, and restart ONCE after a
 * crash (a flapping server stays down until the user re-tests it).
 *
 * Config lives in the machine-local settingsStore (`mcpServers`) — stdio
 * commands are machine paths, so this must never sync. Env values are
 * encrypted with safeStorage. Each server carries a `toolsCache` captured
 * on every successful connect, so the renderer can register tool schemas
 * at startup without spawning anything.
 */

const { spawn } = require('child_process');
const { safeStorage } = require('electron');

const PROTOCOL_VERSION = '2025-06-18';
const IDLE_MS = 10 * 60 * 1000;   // stop a server after 10 min without calls
const CALL_TIMEOUT_MS = 60 * 1000;
const START_TIMEOUT_MS = 15 * 1000;
const OUTPUT_CAP = 8000;          // chars of tool output returned to the model

class MCPConnection {
    constructor(config, onExit) {
        this.config = config;
        this.onExit = onExit;
        this.proc = null;
        this.buffer = '';
        this.nextId = 1;
        this.pending = new Map();   // id -> {resolve, reject, timer}
        this.idleTimer = null;
        this.initialized = false;
    }

    async start() {
        // M7: don't hand the MCP child our whole environment — scrub
        // secret-shaped vars (GMAIL_CLIENT_SECRET, API keys in .env, …) with
        // the same denylist run_command uses. The server's OWN configured env
        // (decrypted) is merged on top, so intentional per-server secrets
        // still reach it; a malicious/supply-chain server just can't read
        // Anjadhe's unrelated secrets.
        const scrubbed = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (!/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k)) scrubbed[k] = v;
        }
        const env = { ...scrubbed, ...decryptEnv(this.config.env) };
        this.proc = spawn(this.config.command, this.config.args || [], {
            env,
            cwd: require('os').homedir(),
            stdio: ['pipe', 'pipe', 'pipe']
        });
        this.proc.stdout.on('data', (chunk) => this._onData(chunk));
        this.proc.stderr.on('data', (chunk) => {
            console.warn(`[mcp:${this.config.name}] stderr:`, String(chunk).slice(0, 500));
        });
        this.proc.on('exit', (code) => {
            for (const [, p] of this.pending) {
                clearTimeout(p.timer);
                p.reject(new Error(`MCP server exited (code ${code})`));
            }
            this.pending.clear();
            this.proc = null;
            this.initialized = false;
            if (this.idleTimer) clearTimeout(this.idleTimer);
            this.onExit?.(code);
        });

        // MCP handshake.
        const init = await this._request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'anjadhe', version: '1.0' }
        }, START_TIMEOUT_MS);
        this._notify('notifications/initialized', {});
        this.initialized = true;
        this.serverInfo = init?.serverInfo || null;
        this._touch();
        return init;
    }

    stop() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        if (this.proc) {
            try { this.proc.kill(); } catch {}
        }
    }

    async listTools() {
        const res = await this._request('tools/list', {});
        this._touch();
        return (res?.tools || []).map(t => ({
            name: t.name,
            description: t.description || '',
            inputSchema: t.inputSchema || { type: 'object', properties: {} },
            // MCP tool annotations (2025-06-18 spec). Server-supplied HINTS,
            // not a security boundary — but the renderer uses destructiveHint
            // to keep a "trust this server" grant from silently covering a
            // destructive tool (M8).
            annotations: (t.annotations && typeof t.annotations === 'object') ? t.annotations : null
        }));
    }

    async callTool(name, args) {
        const res = await this._request('tools/call', { name, arguments: args || {} }, CALL_TIMEOUT_MS);
        this._touch();
        return res;
    }

    _touch() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            console.log(`[mcp:${this.config.name}] idle — stopping`);
            this.stop();
        }, IDLE_MS);
    }

    _onData(chunk) {
        this.buffer += String(chunk);
        let nl;
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id !== undefined && this.pending.has(msg.id)) {
                const p = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                clearTimeout(p.timer);
                if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'));
                else p.resolve(msg.result);
            }
            // Server-initiated requests/notifications (sampling, roots…) are
            // out of scope for v1 — ignored.
        }
    }

    _request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            if (!this.proc || !this.proc.stdin.writable) {
                reject(new Error('MCP server is not running'));
                return;
            }
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP ${method} timed out`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
    }

    _notify(method, params) {
        if (this.proc && this.proc.stdin.writable) {
            this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
        }
    }
}

function encryptEnv(env) {
    const out = {};
    for (const [k, v] of Object.entries(env || {})) {
        if (!k || typeof v !== 'string') continue;
        out[k] = safeStorage.isEncryptionAvailable()
            ? { enc: safeStorage.encryptString(v).toString('base64') }
            : { plain: v };
    }
    return out;
}

function decryptEnv(env) {
    const out = {};
    for (const [k, v] of Object.entries(env || {})) {
        try {
            if (v && v.enc) out[k] = safeStorage.decryptString(Buffer.from(v.enc, 'base64'));
            else if (v && v.plain !== undefined) out[k] = v.plain;
        } catch (e) {
            console.warn(`[mcp] could not decrypt env ${k}:`, e.message);
        }
    }
    return out;
}

const MCPManager = {
    _store: null,                 // settingsStore, injected via init
    _connections: new Map(),      // server name -> MCPConnection
    _restarted: new Set(),        // names that already used their one crash-restart
    _lastOutputs: new Map(),      // server name -> { tool, text, offset } for continue_output

    init(settingsStore) {
        this._store = settingsStore;
    },

    _servers() {
        const list = this._store.get('mcpServers');
        return Array.isArray(list) ? list : [];
    },

    _saveServers(list) {
        this._store.set('mcpServers', list);
    },

    /** Public listing — env values are never sent to the renderer. */
    listServers() {
        return this._servers().map(s => ({
            name: s.name,
            command: s.command,
            args: s.args || [],
            enabled: s.enabled !== false,
            envKeys: Object.keys(s.env || {}),
            tools: s.toolsCache || [],
            running: this._connections.has(s.name)
        }));
    },

    addServer({ name, command, args, env }) {
        const clean = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
        if (!clean) return { error: 'name required' };
        if (!command || !String(command).trim()) return { error: 'command required' };
        const servers = this._servers();
        if (servers.some(s => s.name === clean)) return { error: `A server named "${clean}" already exists` };
        servers.push({
            name: clean,
            command: String(command).trim(),
            args: Array.isArray(args) ? args.map(String) : [],
            env: encryptEnv(env),
            enabled: true,
            toolsCache: [],
            createdAt: new Date().toISOString()
        });
        this._saveServers(servers);
        return { ok: true, name: clean };
    },

    removeServer(name) {
        this._stopServer(name);
        this._saveServers(this._servers().filter(s => s.name !== name));
        return { ok: true };
    },

    setEnabled(name, enabled) {
        const servers = this._servers();
        const s = servers.find(x => x.name === name);
        if (!s) return { error: 'unknown server' };
        s.enabled = enabled !== false;
        if (!s.enabled) this._stopServer(name);
        this._saveServers(servers);
        return { ok: true };
    },

    /**
     * Start (or reuse) the connection for a server. Lazy: called on first
     * tool call and by test/refresh. Refreshes toolsCache on every
     * successful connect so the renderer's registrations stay current.
     */
    async _connect(name) {
        const existing = this._connections.get(name);
        if (existing && existing.initialized) return existing;

        const config = this._servers().find(s => s.name === name);
        if (!config) throw new Error(`unknown MCP server: ${name}`);
        if (config.enabled === false) throw new Error(`MCP server "${name}" is disabled`);

        const conn = new MCPConnection(config, (code) => {
            this._connections.delete(name);
            // One crash-restart, like OllamaManager: only for dirty exits,
            // and only once until a manual test/list resets the breaker.
            if (code !== 0 && code !== null && !this._restarted.has(name)) {
                this._restarted.add(name);
                console.warn(`[mcp:${name}] crashed (code ${code}) — will restart on next call`);
            }
        });
        this._connections.set(name, conn);
        try {
            await conn.start();
            const tools = await conn.listTools();
            const servers = this._servers();
            const s = servers.find(x => x.name === name);
            if (s) { s.toolsCache = tools; this._saveServers(servers); }
            this._restarted.delete(name);
            return conn;
        } catch (e) {
            this._connections.delete(name);
            conn.stop();
            throw e;
        }
    },

    _stopServer(name) {
        const conn = this._connections.get(name);
        if (conn) {
            conn.stop();
            this._connections.delete(name);
        }
    },

    /** Test/refresh: connect (starting if needed) and list tools. */
    async testServer(name) {
        this._restarted.delete(name);  // manual action resets the crash breaker
        try {
            const conn = await this._connect(name);
            const tools = await conn.listTools();
            return { ok: true, serverInfo: conn.serverInfo, tools };
        } catch (e) {
            return { error: e.message };
        }
    },

    /**
     * Call a tool. Flattens MCP's content array to text for the model,
     * windowed to the context budget. The FULL text is kept per server so
     * mcp_<server>_continue_output can page through it — a browser
     * snapshot of a real site (Amazon: 100k+ chars) is unusable if the
     * model can only ever see the first window.
     */
    async callTool(name, toolName, args) {
        try {
            const conn = await this._connect(name);
            // Main-side gate (M8): the renderer's permission dialog is the
            // primary consent gate, but main must not be a blind executor for
            // whatever the renderer sends. _connect already rejects unknown /
            // disabled servers; here we also reject any tool the server didn't
            // advertise, so a buggy or compromised renderer can't invoke an
            // arbitrary or fabricated tool name.
            const cfg = this._servers().find(s => s.name === name);
            const known = (cfg?.toolsCache || []).some(t => t.name === toolName);
            if (!known) return { error: `MCP server "${name}" does not expose a tool named "${toolName}".` };
            const res = await conn.callTool(toolName, args);
            const text = (res?.content || [])
                .map(c => {
                    if (c.type === 'text') return c.text;
                    if (c.type === 'resource' && c.resource?.text) return c.resource.text;
                    // Text-only pipeline: an image would silently vanish —
                    // tell the model so it reaches for a text tool instead.
                    if (c.type === 'image') return '[image captured, but you cannot view images — read the page with a text tool like browser_snapshot instead]';
                    return `[${c.type} content omitted]`;
                })
                .join('\n');
            if (res?.isError) {
                return { error: text.slice(0, OUTPUT_CAP) || 'MCP tool reported an error' };
            }
            this._lastOutputs.set(name, { tool: toolName, text, offset: 0 });
            return this._outputWindow(name);
        } catch (e) {
            return { error: e.message };
        }
    },

    /** Next OUTPUT_CAP-sized window of the last tool output for a server. */
    continueOutput(name) {
        if (!this._lastOutputs.has(name)) {
            return { error: 'No previous tool output to continue — call a tool first.' };
        }
        return this._outputWindow(name);
    },

    _outputWindow(name) {
        const st = this._lastOutputs.get(name);
        const start = st.offset;
        if (start > 0 && start >= st.text.length) {
            return { result: '(end of output — nothing more)' };
        }
        const chunk = st.text.slice(start, start + OUTPUT_CAP);
        st.offset = start + chunk.length;
        const remaining = st.text.length - st.offset;
        let note = '';
        if (remaining > 0) {
            note = `\n…[${st.tool} output truncated — characters ${start.toLocaleString()}–${st.offset.toLocaleString()} of ${st.text.length.toLocaleString()}. Call mcp_${name}_continue_output to read the next part]`;
        } else if (start > 0) {
            note = '\n[end of output]';
        }
        return { result: chunk + note, truncated: remaining > 0 };
    },

    stopAll() {
        for (const name of [...this._connections.keys()]) this._stopServer(name);
    }
};

module.exports = MCPManager;
