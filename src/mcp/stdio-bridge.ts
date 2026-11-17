// `paygent mcp`: for agents that launch MCP servers as a subprocess over stdio. It forwards
// JSON-RPC messages to the running daemon on loopback HTTP, so the agent's process never holds
// keys or a passphrase. The only credential it reads is the MCP bearer token.

import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { paths as getPaths, readConfig } from "../config.ts";

export async function runStdioBridge() {
  const p = getPaths();
  const cfg = readConfig(p, readFileSync(p.ownerPub, "utf8"));
  const token = readFileSync(p.mcpToken, "utf8").trim();
  const upstream = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${cfg.mcp.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const local = new StdioServerTransport();
  local.onmessage = (m) => { upstream.send(m).catch((e) => process.stderr.write(`paygent mcp: daemon unreachable (${(e as Error).message}); is "paygent start" running?\n`)); };
  upstream.onmessage = (m) => { local.send(m).catch(() => {}); };
  upstream.onerror = (e) => process.stderr.write(`paygent mcp: ${e.message}\n`);
  local.onclose = () => { upstream.close().catch(() => {}); process.exit(0); };
  await upstream.start();
  await local.start();
}
