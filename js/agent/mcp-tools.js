/**
 * MCPTools — surfaces MCP server tools to the assistant
 * (docs/COWORK_AGENT.md §2, phase C2).
 *
 * Registration happens from each server's cached tool list (captured by
 * main on every successful connect), so startup spawns NOTHING — servers
 * start lazily on the first actual tool call. Each tool registers through
 * the existing AgentTools.register() with:
 *   - a namespaced, collision-proof name: mcp_<server>_<tool>
 *   - source 'mcp:<server>' so unregisterBySource cleans up on
 *     disable/remove/refresh
 *   - keywords from the server + tool names, so 200 MCP tools don't blow
 *     up a local model's prompt — the make-or-break detail for gemma
 * Permission class: mcp_* defaults to ask (PermissionManager); a per-server
 * trust grant ('mcp:<server>') silences that server's tools — EXCEPT ones the
 * server flags destructive (destructiveHint), which keep asking (M8).
 */

const MCPTools = {
    // Server names whose tool list includes browser_* tools. AgentService
    // reads this to ship the BROWSING guidance prose only when a browser
    // server's tools are scoped into the conversation.
    browserServers: new Set(),

    async init() {
        if (typeof FEATURES !== 'undefined' && !FEATURES.isEnabled('mcp')) return;
        if (!window.electronMCP?.listServers) return;
        let servers;
        try { servers = await window.electronMCP.listServers(); } catch { return; }
        for (const s of (servers || [])) {
            if (s.enabled) this._registerServer(s);
        }
    },

    /** Re-register one server's tools (Settings calls this after test/toggle). */
    refreshServer(server) {
        if (typeof AgentTools === 'undefined') return;
        AgentTools.unregisterBySource('mcp:' + server.name);
        if (server.enabled) this._registerServer(server);
    },

    unregisterServer(name) {
        this.browserServers.delete(name);
        if (typeof AgentTools === 'undefined') return;
        AgentTools.unregisterBySource('mcp:' + name);
    },

    _registerServer(server) {
        if (typeof AgentTools === 'undefined' || !Array.isArray(server.tools)) return;
        // Keyword scope: tokens from the server name + every tool name.
        // "github" + "create issue" etc. — the message must mention one for
        // the schemas to ship.
        const keywords = new Set(server.name.split(/[-_\s]+/));
        for (const t of server.tools) {
            for (const w of String(t.name).split(/[-_\s]+/)) keywords.add(w);
        }
        // Browser servers (C6 — e.g. Playwright MCP) get web-INTENT words on
        // top of the tool-name tokens: "go to amazon.com", "log into the
        // airline website", "open https://…" name no tool, but they are
        // exactly the asks these tools exist for. com/org/net catch bare
        // domains (word boundaries sit at the dots).
        const isBrowser = server.tools.some(t => /^browser[_-]/.test(String(t.name)));
        if (isBrowser) {
            this.browserServers.add(server.name);
            for (const w of ['browse', 'website', 'websites', 'webpage', 'site',
                'url', 'urls', 'http', 'https', 'www', 'com', 'org', 'net',
                'visit', 'login', 'log in', 'sign in']) keywords.add(w);
        } else {
            this.browserServers.delete(server.name);
        }
        const words = [...keywords].filter(w => w.length >= 3);

        for (const t of server.tools) {
            const fnName = `mcp_${server.name}_${t.name}`.replace(/[^a-zA-Z0-9_]/g, '_');
            const res = AgentTools.register({
                type: 'function',
                function: {
                    name: fnName,
                    // Server attribution up front so the model (and the
                    // transparency logs) always know where a tool lives.
                    description: `[${server.name} MCP] ${t.description || t.name}`.slice(0, 320),
                    // MCP inputSchema is JSON Schema — pass through unchanged.
                    parameters: t.inputSchema
                }
            }, (args) => this._call(server.name, t.name, args), {
                source: 'mcp:' + server.name,
                keywords: words,
                // A server-supplied hint (M8): when the tool declares itself
                // destructive, a "trust this server" grant won't auto-approve
                // it — it still asks each time.
                destructive: !!(t.annotations && t.annotations.destructiveHint === true)
            });
            if (!res.ok) console.warn(`[mcp-tools] could not register ${fnName}: ${res.error}`);
        }

        // Continuation tool: main windows big tool outputs (browser
        // snapshots of real sites run to 100k+ chars) — this pages
        // through the rest instead of losing it to the cap.
        const contName = `mcp_${server.name}_continue_output`.replace(/[^a-zA-Z0-9_]/g, '_');
        AgentTools.register({
            type: 'function',
            function: {
                name: contName,
                description: `[${server.name} MCP] Read the next part of the previous ${server.name} tool result — use whenever a result says it was truncated.`,
                parameters: { type: 'object', properties: {} }
            }
        }, () => window.electronMCP.continueOutput(server.name), {
            source: 'mcp:' + server.name,
            keywords: words
        });
    },

    async _call(serverName, toolName, args) {
        if (!window.electronMCP?.callTool) return { error: 'MCP not available in this build.' };
        // Lazy start + idle lifecycle + output caps all live in main.
        return await window.electronMCP.callTool(serverName, toolName, args);
    }
};

if (typeof window !== 'undefined') {
    window.MCPTools = MCPTools;
    // Register cached tools at startup (spawns nothing).
    MCPTools.init();
}
