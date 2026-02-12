import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import cors from "cors";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execAsync = promisify(exec);

// ===== 설정 =====
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const ALLOWED_DIRS = (process.env.ALLOWED_DIRS || "/app").split(",");
const PORT = process.env.PORT || 3000;

// ===== Express 앱 =====
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ===== 인증 미들웨어 =====
function authenticate(req, res, next) {
  if (!AUTH_TOKEN) return next(); // 토큰 미설정시 패스
  const auth = req.headers.authorization;
  if (auth === `Bearer ${AUTH_TOKEN}`) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// ===== MCP 서버 생성 =====
function createMcpServer() {
  const server = new McpServer({
    name: "woo-mcp-server",
    version: "1.0.0",
  });

  // ----- Tool 1: ping -----
  server.tool("ping", "서버 상태 확인", {}, async () => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "ok",
            time: new Date().toISOString(),
            uptime: process.uptime().toFixed(0) + "s",
          }),
        },
      ],
    };
  });

  // ----- Tool 2: exec (명령 실행) -----
  server.tool(
    "exec",
    "셸 명령어 실행 (안전한 명령만)",
    {
      command: {
        type: "string",
        description: "실행할 명령어",
      },
      timeout: {
        type: "number",
        description: "타임아웃 (ms, 기본 10000)",
      },
    },
    async ({ command, timeout }) => {
      // 위험한 명령 차단
      const blocked = ["rm -rf /", "mkfs", "dd if=", ":(){ :", "shutdown", "reboot", "format"];
      if (blocked.some((b) => command.includes(b))) {
        return {
          content: [{ type: "text", text: "차단된 명령어입니다." }],
          isError: true,
        };
      }

      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: timeout || 10000,
          maxBuffer: 1024 * 1024,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ stdout: stdout.slice(0, 5000), stderr: stderr.slice(0, 2000) }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `에러: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ----- Tool 3: read_file (파일 읽기) -----
  server.tool(
    "read_file",
    "파일 내용 읽기",
    {
      path: {
        type: "string",
        description: "파일 경로",
      },
    },
    async ({ path: filePath }) => {
      try {
        const content = await fs.readFile(filePath, "utf-8");
        return {
          content: [{ type: "text", text: content.slice(0, 10000) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `파일 읽기 실패: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ----- Tool 4: write_file (파일 쓰기) -----
  server.tool(
    "write_file",
    "파일에 내용 쓰기",
    {
      path: {
        type: "string",
        description: "파일 경로",
      },
      content: {
        type: "string",
        description: "파일 내용",
      },
    },
    async ({ path: filePath, content }) => {
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf-8");
        return {
          content: [{ type: "text", text: `파일 저장 완료: ${filePath}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `파일 쓰기 실패: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ----- Tool 5: list_dir (디렉토리 목록) -----
  server.tool(
    "list_dir",
    "디렉토리 파일 목록",
    {
      path: {
        type: "string",
        description: "디렉토리 경로",
      },
    },
    async ({ path: dirPath }) => {
      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const list = entries.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "dir" : "file",
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `디렉토리 읽기 실패: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ----- Tool 6: http_request (API 호출) -----
  server.tool(
    "http_request",
    "외부 API 호출",
    {
      url: {
        type: "string",
        description: "요청 URL",
      },
      method: {
        type: "string",
        description: "HTTP 메서드 (GET, POST 등)",
      },
      headers: {
        type: "string",
        description: "헤더 JSON 문자열 (선택)",
      },
      body: {
        type: "string",
        description: "요청 body (선택)",
      },
    },
    async ({ url, method, headers, body }) => {
      try {
        const opts = {
          method: method || "GET",
          headers: headers ? JSON.parse(headers) : {},
        };
        if (body && method !== "GET") opts.body = body;
        const resp = await fetch(url, opts);
        const text = await resp.text();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: resp.status,
                body: text.slice(0, 8000),
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `HTTP 요청 실패: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ----- Tool 7: env_info (환경 정보) -----
  server.tool("env_info", "서버 환경 정보 확인", {}, async () => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            cwd: process.cwd(),
            memory: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
            uptime: `${Math.round(process.uptime())}s`,
          }),
        },
      ],
    };
  });

  return server;
}

// ===== 세션 관리 =====
const sessions = new Map();

// ===== MCP 엔드포인트 =====
app.post("/mcp", authenticate, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  let transport;
  if (sessionId && sessions.has(sessionId)) {
    transport = sessions.get(sessionId);
  } else {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
    const server = createMcpServer();
    await server.connect(transport);

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };
  }

  await transport.handleRequest(req, res, req.body);

  if (transport.sessionId && !sessions.has(transport.sessionId)) {
    sessions.set(transport.sessionId, transport);
  }
});

app.get("/mcp", authenticate, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(400).json({ error: "세션이 없습니다" });
  }
  const transport = sessions.get(sessionId);
  await transport.handleRequest(req, res);
});

app.delete("/mcp", authenticate, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId);
    await transport.close();
    sessions.delete(sessionId);
  }
  res.status(200).json({ ok: true });
});

// ===== 상태 확인 엔드포인트 =====
app.get("/", (req, res) => {
  res.json({
    name: "woo-mcp-server",
    version: "1.0.0",
    status: "running",
    mcp_endpoint: "/mcp",
    tools: ["ping", "exec", "read_file", "write_file", "list_dir", "http_request", "env_info"],
    sessions: sessions.size,
    uptime: `${Math.round(process.uptime())}s`,
  });
});

// ===== 서버 시작 =====
app.listen(PORT, () => {
  console.log(`woo-mcp-server running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Auth: ${AUTH_TOKEN ? "enabled" : "disabled (set MCP_AUTH_TOKEN)"}`);
  console.log(`Tools: ping, exec, read_file, write_file, list_dir, http_request, env_info`);
});
