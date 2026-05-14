#!/usr/bin/env node
/**
 * pacific-playwright-bridge
 * MCP server (JSON-RPC 2.0 over stdio) providing browser automation for
 * assurance.pacific.london authenticated as qa@pacific.london (viewer).
 *
 * Auth flow:
 *   1. On first run, calls POST /api/auth/qa-session with PLAYWRIGHT_QA_SECRET.
 *   2. Gets pac_staff_session token, stores in .session.json.
 *   3. All browser requests use that session cookie.
 *   4. If session expires (7-day), self-heals by fetching a new one.
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

const DASHBOARD_BASE = process.env.DASHBOARD_URL || "https://assurance.pacific.london";
const QA_SECRET = process.env.PLAYWRIGHT_QA_SECRET || "";
const SESSION_FILE = path.join(__dirname, "..", ".session.json");

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let sessionToken: string | null = null;

// ─── Session management ────────────────────────────────────────────────────

interface SessionStore {
  token: string;
  fetchedAt: number;
}

function loadCachedSession(): string | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const data: SessionStore = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    // Session valid for 6 days (1 day margin before 7-day server expiry)
    const ageMs = Date.now() - data.fetchedAt;
    if (ageMs > 6 * 24 * 60 * 60 * 1000) return null;
    return data.token;
  } catch {
    return null;
  }
}

function saveCachedSession(token: string): void {
  const data: SessionStore = { token, fetchedAt: Date.now() };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data), { mode: 0o600 });
}

async function fetchQaSession(): Promise<string> {
  if (!QA_SECRET) throw new Error("PLAYWRIGHT_QA_SECRET not set");

  const https = await import("https");
  const url = new URL("/api/auth/qa-session", DASHBOARD_BASE);

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({});
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${QA_SECRET}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok || !parsed.sessionToken) {
            reject(new Error(`QA session fetch failed: ${JSON.stringify(parsed)}`));
          } else {
            resolve(parsed.sessionToken as string);
          }
        } catch (e) {
          reject(new Error(`QA session parse error: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function ensureSession(): Promise<string> {
  // Try cached session first
  const cached = loadCachedSession();
  if (cached) return cached;

  // Fetch fresh session
  const token = await fetchQaSession();
  saveCachedSession(token);
  return token;
}

// ─── Browser management ────────────────────────────────────────────────────

async function ensureBrowser(): Promise<void> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }

  if (!context) {
    sessionToken = await ensureSession();
    context = await browser.newContext({
      storageState: {
        cookies: [
          {
            name: "pac_staff_session",
            value: sessionToken,
            domain: new URL(DASHBOARD_BASE).hostname,
            path: "/",
            httpOnly: true,
            secure: DASHBOARD_BASE.startsWith("https"),
            sameSite: "Lax",
            expires: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
          },
        ],
        origins: [],
      },
    });
  }

  if (!page || page.isClosed()) {
    page = await context.newPage();
  }
}

async function refreshAuth(): Promise<void> {
  // Clear cached session and context, re-auth
  if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  sessionToken = null;
  if (context) {
    await context.close().catch(() => undefined);
    context = null;
    page = null;
  }
  await ensureBrowser();
}

// ─── MCP Tools ─────────────────────────────────────────────────────────────

async function browser_health(): Promise<{ ok: boolean; authenticated: boolean; url: string }> {
  try {
    await ensureBrowser();
    const currentUrl = page!.url();
    // Quick auth check: navigate to /admin and confirm no redirect to /login
    await page!.goto(`${DASHBOARD_BASE}/admin`, { waitUntil: "domcontentloaded", timeout: 15000 });
    const afterUrl = page!.url();
    const authenticated = !afterUrl.includes("/login");
    if (!authenticated) {
      await refreshAuth();
      await page!.goto(`${DASHBOARD_BASE}/admin`, { waitUntil: "domcontentloaded", timeout: 15000 });
      const retryUrl = page!.url();
      return { ok: true, authenticated: !retryUrl.includes("/login"), url: retryUrl };
    }
    return { ok: true, authenticated: true, url: afterUrl };
  } catch (e) {
    return { ok: false, authenticated: false, url: String(e) };
  }
}

async function browser_navigate(url: string): Promise<{ ok: boolean; finalUrl: string; title: string }> {
  await ensureBrowser();
  try {
    await page!.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const finalUrl = page!.url();
    if (finalUrl.includes("/login")) {
      await refreshAuth();
      await page!.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    }
    return { ok: true, finalUrl: page!.url(), title: await page!.title() };
  } catch (e) {
    return { ok: false, finalUrl: page!.url(), title: String(e) };
  }
}

async function browser_screenshot(): Promise<{ ok: boolean; base64?: string; path?: string; sizeBytes?: number; error?: string }> {
  await ensureBrowser();
  try {
    const buffer = await page!.screenshot({ type: "png", fullPage: false });
    const sizeBytes = buffer.length;
    if (sizeBytes > 200 * 1024) {
      // Too large — return path only, not base64
      const tmpPath = path.join(process.env.TEMP || process.env.TMP || "/tmp", `pad-screenshot-${Date.now()}.png`);
      fs.writeFileSync(tmpPath, buffer);
      return { ok: true, path: tmpPath, sizeBytes };
    }
    return { ok: true, base64: buffer.toString("base64"), sizeBytes };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function browser_read_dom(selector?: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  await ensureBrowser();
  try {
    if (selector) {
      const el = page!.locator(selector).first();
      const text = await el.innerText({ timeout: 10000 });
      return { ok: true, text };
    } else {
      const text = await page!.innerText("body");
      return { ok: true, text: text.slice(0, 8000) };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function browser_click(selector: string): Promise<{ ok: boolean; error?: string }> {
  await ensureBrowser();
  try {
    await page!.click(selector, { timeout: 10000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function browser_fill(selector: string, value: string): Promise<{ ok: boolean; error?: string }> {
  await ensureBrowser();
  try {
    await page!.fill(selector, value, { timeout: 10000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function browser_wait_for(selector: string, timeout_ms?: number): Promise<{ ok: boolean; error?: string }> {
  await ensureBrowser();
  try {
    await page!.waitForSelector(selector, { timeout: timeout_ms ?? 15000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ─── MCP JSON-RPC 2.0 handler ─────────────────────────────────────────────

interface McpRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const TOOLS: Record<string, { description: string; inputSchema: Record<string, unknown> }> = {
  browser_health: {
    description: "Verify that the Playwright browser is running and the QA session is authenticated.",
    inputSchema: { type: "object", properties: {} },
  },
  browser_navigate: {
    description: "Navigate the browser to a URL using the authenticated QA session.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL to navigate to" } },
      required: ["url"],
    },
  },
  browser_screenshot: {
    description: "Capture a PNG screenshot of the current viewport. Returns base64 if under 200KB, or file path.",
    inputSchema: { type: "object", properties: {} },
  },
  browser_read_dom: {
    description: "Read text content from the current page. Optionally filter by CSS selector.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS selector (omit for full body, capped at 8000 chars)" } },
    },
  },
  browser_click: {
    description: "Click a DOM element matching the CSS selector.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" } },
      required: ["selector"],
    },
  },
  browser_fill: {
    description: "Fill a form input matching the CSS selector with the given value.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        value: { type: "string" },
      },
      required: ["selector", "value"],
    },
  },
  browser_wait_for: {
    description: "Wait for a CSS selector to appear in the DOM.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default 15000)" },
      },
      required: ["selector"],
    },
  },
};

async function handleRequest(req: McpRequest): Promise<McpResponse> {
  const { id, method, params = {} } = req;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "pacific-playwright-bridge", version: "1.0.0" },
      },
    };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: Object.entries(TOOLS).map(([name, def]) => ({
          name,
          description: def.description,
          inputSchema: def.inputSchema,
        })),
      },
    };
  }

  if (method === "tools/call") {
    const toolName = params.name as string;
    const toolArgs = (params.arguments as Record<string, unknown>) || {};
    try {
      let result: unknown;
      switch (toolName) {
        case "browser_health":
          result = await browser_health();
          break;
        case "browser_navigate":
          result = await browser_navigate(toolArgs.url as string);
          break;
        case "browser_screenshot":
          result = await browser_screenshot();
          break;
        case "browser_read_dom":
          result = await browser_read_dom(toolArgs.selector as string | undefined);
          break;
        case "browser_click":
          result = await browser_click(toolArgs.selector as string);
          break;
        case "browser_fill":
          result = await browser_fill(toolArgs.selector as string, toolArgs.value as string);
          break;
        case "browser_wait_for":
          result = await browser_wait_for(toolArgs.selector as string, toolArgs.timeout_ms as number | undefined);
          break;
        default:
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${toolName}` } };
      }
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(result) }] },
      };
    } catch (e) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: String(e) },
      };
    }
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ─── stdio transport ───────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const req: McpRequest = JSON.parse(trimmed);
    const res = await handleRequest(req);
    process.stdout.write(JSON.stringify(res) + "\n");
  } catch (e) {
    const errRes: McpResponse = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: `Parse error: ${String(e)}` },
    };
    process.stdout.write(JSON.stringify(errRes) + "\n");
  }
});

rl.on("close", async () => {
  if (browser) await browser.close().catch(() => undefined);
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (browser) await browser.close().catch(() => undefined);
  process.exit(0);
});
