import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import cors from "cors";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { WebSocketServer } from "ws";

const execAsync = promisify(exec);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const PORT = process.env.PORT || 3000;
const BRIDGE_KEY = process.env.BRIDGE_KEY || "woo-local-2026";
let localBridge = null;

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

function authenticate(req, res, next) {
  if (!AUTH_TOKEN) return next();
  if (req.headers.authorization === `Bearer ${AUTH_TOKEN}`) return next();
  res.status(401).json({ error: "Unauthorized" });
}

function createMcpServer() {
  const server = new McpServer({ name: "woo-mcp-server", version: "1.0.0" });

  server.tool("ping", "server status", {}, async () => ({
    content: [{ type: "text", text: JSON.stringify({ status: "ok", time: new Date().toISOString(), uptime: process.uptime().toFixed(0) + "s", bridge: localBridge?.readyState === 1 ? "connected" : "disconnected" }) }]
  }));

  server.tool("exec", "run shell command", { command: z.string(), timeout: z.number().optional() }, async ({ command, timeout }) => {
    const blocked = ["rm -rf /", "mkfs", "dd if=", ":(){ :", "shutdown", "reboot"];
    if (blocked.some(b => command.includes(b))) return { content: [{ type: "text", text: "blocked" }], isError: true };
    try {
      const { stdout, stderr } = await execAsync(command, { timeout: timeout || 10000, maxBuffer: 1024 * 1024 });
      return { content: [{ type: "text", text: JSON.stringify({ stdout: stdout.slice(0, 5000), stderr: stderr.slice(0, 2000) }) }] };
    } catch (err) { return { content: [{ type: "text", text: err.message }], isError: true }; }
  });

  server.tool("read_file", "read file", { path: z.string() }, async ({ path: p }) => {
    try { const c = await fs.readFile(p, "utf-8"); return { content: [{ type: "text", text: c.slice(0, 10000) }] }; }
    catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }
  });

  server.tool("write_file", "write file", { path: z.string(), content: z.string() }, async ({ path: p, content: c }) => {
    try { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, c, "utf-8"); return { content: [{ type: "text", text: "saved: " + p }] }; }
    catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }
  });

  server.tool("list_dir", "list directory", { path: z.string() }, async ({ path: p }) => {
    try { const entries = await fs.readdir(p, { withFileTypes: true }); return { content: [{ type: "text", text: JSON.stringify(entries.map(e => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" })), null, 2) }] }; }
    catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }
  });

  server.tool("http_request", "HTTP request", { url: z.string(), method: z.string().optional(), headers: z.string().optional(), body: z.string().optional() }, async ({ url, method, headers, body }) => {
    try {
      const opts = { method: method || "GET", headers: headers ? JSON.parse(headers) : {} };
      if (body && method !== "GET") opts.body = body;
      const resp = await fetch(url, opts);
      const text = await resp.text();
      return { content: [{ type: "text", text: JSON.stringify({ status: resp.status, body: text.slice(0, 8000) }) }] };
    } catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }
  });

  server.tool("env_info", "environment info", {}, async () => ({
    content: [{ type: "text", text: JSON.stringify({ node: process.version, platform: process.platform, cwd: process.cwd(), memory: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`, uptime: `${Math.round(process.uptime())}s` }) }]
  }));

  server.tool("local_bridge", "execute on local PC via bridge", { action: z.string(), command: z.string().optional(), path: z.string().optional(), content: z.string().optional(), cwd: z.string().optional() }, async ({ action, command, path: filePath, content, cwd }) => {
    if (!localBridge || localBridge.readyState !== 1) return { content: [{ type: "text", text: "bridge not connected" }], isError: true };
    try {
      const id = Date.now();
      const result = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout 15s")), 15000);
        const h = (data) => { const m = JSON.parse(data.toString()); if (m.id === id) { localBridge.removeListener("message", h); clearTimeout(t); resolve(m.result || m.error); } };
        localBridge.on("message", h);
        localBridge.send(JSON.stringify({ id, action, command, path: filePath, content, cwd }));
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }
  });

  return server;
}

const sessions = new Map();
app.post("/mcp", authenticate, async (req, res) => {
  const sid = req.headers["mcp-session-id"];
  let t; if (sid && sessions.has(sid)) { t = sessions.get(sid); } else { t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() }); const s = createMcpServer(); await s.connect(t); t.onclose = () => { if (t.sessionId) sessions.delete(t.sessionId); }; }
  await t.handleRequest(req, res, req.body);
  if (t.sessionId && !sessions.has(t.sessionId)) sessions.set(t.sessionId, t);
});
app.get("/mcp", authenticate, async (req, res) => { const sid = req.headers["mcp-session-id"]; if (!sid || !sessions.has(sid)) return res.status(400).json({ error: "no session" }); await sessions.get(sid).handleRequest(req, res); });
app.delete("/mcp", authenticate, async (req, res) => { const sid = req.headers["mcp-session-id"]; if (sid && sessions.has(sid)) { await sessions.get(sid).close(); sessions.delete(sid); } res.json({ ok: true }); });
app.get("/", (req, res) => res.json({ name: "woo-mcp-server", version: "1.0.0", status: "running", bridge: localBridge?.readyState === 1 ? "connected" : "disconnected", tools: ["ping","exec","read_file","write_file","list_dir","http_request","env_info","local_bridge"], sessions: sessions.size }));

const httpServer = app.listen(PORT, () => console.log(`woo-mcp-server on port ${PORT}`));
const wss = new WebSocketServer({ server: httpServer, path: "/bridge" });
wss.on("connection", (ws, req) => {
  if (req.headers["x-bridge-key"] !== BRIDGE_KEY) { ws.close(4001); return; }
  console.log("Bridge connected!"); localBridge = ws;
  ws.on("message", d => { const m = JSON.parse(d.toString()); if (m.type === "register") console.log(`PC: ${m.hostname} (${m.platform})`); });
  ws.on("close", () => { console.log("Bridge disconnected"); if (localBridge === ws) localBridge = null; });
});
