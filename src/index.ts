#!/usr/bin/env node
/**
 * pacific-playwright-bridge v2.0 (Wave 18)
 * MCP server (JSON-RPC 2.0 over stdio) providing authenticated browser automation
 * for all Pacific portals plus local HTML artefact rendering.
 *
 * Multi-portal session architecture:
 *   - Each portal has its own BrowserContext with cached session cookies
 *   - Sessions stored at .sessions/<slug>.json (600 perms)
 *   - browser_navigate infers portal slug from hostname and uses correct context
 *   - browser_health returns per-portal auth status
 *   - browser_authenticate(slug) forces re-auth for one portal
 *
 * HTML rendering:
 *   - browser_render_html accepts raw HTML string or absolute file path
 *   - browser_render_html_artefact fetches from Sanity then renders
 *   - Both use an anonymous browser context (no auth cookies)
 *
 * Audit trail:
 *   - Every browser_* call (except browser_health) writes a wfEvent to Sanity
 *   - Fire-and-forget; failures logged to stderr only
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as os from "os";
import * as https from "https";

// ─── Portal registry ───────────────────────────────────────────────────────

interface PortalConfig {
  slug: string;
  baseUrl: string;
  sessionCookie: string;
  qaSecretEnvVar: string;
  qaSessionEndpoint: string;
  sessionDurationDays: number;
  requiresAuth: boolean;
}

const PORTAL_REGISTRY: PortalConfig[] = [
  {
    slug: "assurance",
    baseUrl: process.env.DASHBOARD_URL || "https://assurance.pacific.london",
    sessionCookie: "pac_staff_session",
    qaSecretEnvVar: "PLAYWRIGHT_QA_SECRET",
    qaSessionEndpoint: "/api/auth/qa-session",
    sessionDurationDays: 6,
    requiresAuth: true,
  },
  {
    slug: "partners-ptg",
    baseUrl: "https://partners.pacific.london",
    sessionCookie: "ptg_session",
    qaSecretEnvVar: "PLAYWRIGHT_QA_SECRET_PTG",
    qaSessionEndpoint: "/api/auth/qa-session",
    sessionDurationDays: 6,
    requiresAuth: true,
  },
  {
    slug: "partners-pi",
    baseUrl: "https://partners.pacificinfotech.co.uk",
    sessionCookie: "ptg_session",
    qaSecretEnvVar: "PLAYWRIGHT_QA_SECRET_PI",
    qaSessionEndpoint: "/api/auth/qa-session",
    sessionDurationDays: 6,
    requiresAuth: true,
  },
  {
    slug: "pacific-london",
    baseUrl: "https://pacific.london",
    sessionCookie: "",
    qaSecretEnvVar: "",
    qaSessionEndpoint: "",
    sessionDurationDays: 0,
    requiresAuth: false,
  },
  {
    slug: "pacificinfotech",
    baseUrl: "https://pacificinfotech.co.uk",
    sessionCookie: "",
    qaSecretEnvVar: "",
    qaSessionEndpoint: "",
    sessionDurationDays: 0,
    requiresAuth: false,
  },
];

function getPortalBySlug(slug: string): PortalConfig | undefined {
  return PORTAL_REGISTRY.find((p) => p.slug === slug);
}

function inferPortalFromUrl(url: string): PortalConfig | undefined {
  try {
    const hostname = new URL(url).hostname;
    return PORTAL_REGISTRY.find((p) => {
      const portalHost = new URL(p.baseUrl).hostname;
      return hostname === portalHost || hostname.endsWith("." + portalHost);
    });
  } catch {
    return undefined;
  }
}

// ─── Session management ────────────────────────────────────────────────────

const SESSIONS_DIR = path.join(__dirname, "..", ".sessions");

interface SessionStore {
  token: string;
  fetchedAt: number;
}

function ensureSessionsDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { mode: 0o700, recursive: true });
  }
}

function sessionFilePath(slug: string): string {
  ensureSessionsDir();
  return path.join(SESSIONS_DIR, `${slug}.json`);
}

function loadCachedSession(portal: PortalConfig): string | null {
  try {
    const fp = sessionFilePath(portal.slug);
    if (!fs.existsSync(fp)) return null;
    const data: SessionStore = JSON.parse(fs.readFileSync(fp, "utf8"));
    const ageMs = Date.now() - data.fetchedAt;
    const maxAge = portal.sessionDurationDays * 24 * 60 * 60 * 1000;
    if (ageMs > maxAge) return null;
    return data.token;
  } catch {
    return null;
  }
}

function saveCachedSession(portal: PortalConfig, token: string): void {
  ensureSessionsDir();
  const data: SessionStore = { token, fetchedAt: Date.now() };
  fs.writeFileSync(sessionFilePath(portal.slug), JSON.stringify(data), { mode: 0o600 });
}

function clearCachedSession(portal: PortalConfig): void {
  const fp = sessionFilePath(portal.slug);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

async function fetchQaSession(portal: PortalConfig): Promise<string> {
  const secret = process.env[portal.qaSecretEnvVar];
  if (!secret) throw new Error(`${portal.qaSecretEnvVar} not set`);

  const url = new URL(portal.qaSessionEndpoint, portal.baseUrl);
  const body = JSON.stringify({});
  const isHttps = url.protocol === "https:";

  return new Promise((resolve, reject) => {
    const mod = isHttps ? https : require("http");
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = mod.request(options, (res: any) => {
      let data = "";
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok || !parsed.sessionToken) {
            reject(new Error(`QA session fetch failed for ${portal.slug}: ${JSON.stringify(parsed)}`));
          } else {
            resolve(parsed.sessionToken as string);
          }
        } catch (e) {
          reject(new Error(`QA session parse error for ${portal.slug}: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function ensureSession(portal: PortalConfig): Promise<string> {
  const cached = loadCachedSession(portal);
  if (cached) return cached;
  const token = await fetchQaSession(portal);
  saveCachedSession(portal, token);
  return token;
}

// ─── Browser management ────────────────────────────────────────────────────

interface PortalContext {
  context: BrowserContext;
  page: Page;
}

let browser: Browser | null = null;
const portalContexts: Map<string, PortalContext> = new Map();
let currentPortalSlug: string | null = null;
let currentPage: Page | null = null;

// Anonymous context for HTML file rendering (no auth cookies)
let anonContext: BrowserContext | null = null;
let anonPage: Page | null = null;

async function ensureBrowser(): Promise<void> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
    // Invalidate all contexts if browser restarted
    portalContexts.clear();
    anonContext = null;
    anonPage = null;
    currentPage = null;
    currentPortalSlug = null;
  }
}

async function ensurePortalContext(portal: PortalConfig): Promise<PortalContext> {
  await ensureBrowser();

  const existing = portalContexts.get(portal.slug);
  if (existing && !existing.page.isClosed()) {
    return existing;
  }

  let context: BrowserContext;

  if (!portal.requiresAuth) {
    context = await browser!.newContext();
  } else {
    const token = await ensureSession(portal);
    const portalUrl = new URL(portal.baseUrl);
    context = await browser!.newContext({
      storageState: {
        cookies: [
          {
            name: portal.sessionCookie,
            value: token,
            domain: portalUrl.hostname,
            path: "/",
            httpOnly: true,
            secure: portal.baseUrl.startsWith("https"),
            sameSite: "Lax",
            expires: Math.floor(Date.now() / 1000) + portal.sessionDurationDays * 24 * 60 * 60,
          },
        ],
        origins: [],
      },
    });
  }

  const page = await context.newPage();
  const pc: PortalContext = { context, page };
  portalContexts.set(portal.slug, pc);
  return pc;
}

async function refreshPortalAuth(portal: PortalConfig): Promise<void> {
  clearCachedSession(portal);
  const existing = portalContexts.get(portal.slug);
  if (existing) {
    await existing.context.close().catch(() => undefined);
    portalContexts.delete(portal.slug);
  }
  if (currentPortalSlug === portal.slug) {
    currentPage = null;
    currentPortalSlug = null;
  }
  await ensurePortalContext(portal);
}

async function ensureAnonContext(): Promise<{ context: BrowserContext; page: Page }> {
  await ensureBrowser();
  if (!anonContext) {
    anonContext = await browser!.newContext();
  }
  if (!anonPage || anonPage.isClosed()) {
    anonPage = await anonContext.newPage();
  }
  return { context: anonContext, page: anonPage };
}

function getActivePage(): Page {
  if (!currentPage || currentPage.isClosed()) {
    throw new Error("No active page. Call browser_navigate first.");
  }
  return currentPage;
}

// ─── Audit trail ──────────────────────────────────────────────────────────

const SANITY_TOKEN = process.env.SANITY_TOKEN;
const SANITY_PROJECT_ID = process.env.SANITY_PROJECT_ID || "74704nsd";
const SANITY_DATASET = process.env.SANITY_DATASET || "production";
const PLAYWRIGHT_RUN_ID = process.env.PLAYWRIGHT_RUN_ID;

function writeAuditEvent(
  tool: string,
  portal: string,
  url: string,
  extras: Record<string, unknown> = {}
): void {
  if (!SANITY_TOKEN) return;

  const eventDoc = {
    mutations: [
      {
        create: {
          _type: "wfEvent",
          type: "browser-action",
          title: `browser_* audit: ${tool} on ${portal}`,
          runId: PLAYWRIGHT_RUN_ID || undefined,
          portal,
          url,
          tool,
          timestamp: new Date().toISOString(),
          ...extras,
        },
      },
    ],
  };

  const body = JSON.stringify(eventDoc);
  const reqOptions = {
    hostname: `${SANITY_PROJECT_ID}.api.sanity.io`,
    port: 443,
    path: `/v2024-01-01/data/mutate/${SANITY_DATASET}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SANITY_TOKEN}`,
      "Content-Length": Buffer.byteLength(body),
    },
  };

  const req = https.request(reqOptions, (res) => {
    res.resume();
  });
  req.on("error", (e) => process.stderr.write(`audit write error: ${e.message}\n`));
  req.write(body);
  req.end();
}

// ─── MCP Tools ─────────────────────────────────────────────────────────────

interface HealthStatus {
  authenticated: boolean;
  checkedAt: string;
  error?: string;
}

async function browser_health(): Promise<{ ok: boolean; portals: Record<string, HealthStatus> }> {
  const result: Record<string, HealthStatus> = {};
  const checkedAt = new Date().toISOString();

  for (const portal of PORTAL_REGISTRY) {
    if (!portal.requiresAuth) {
      result[portal.slug] = { authenticated: true, checkedAt };
      continue;
    }

    try {
      const pc = await ensurePortalContext(portal);
      const testUrl = portal.baseUrl + "/";
      await pc.page.goto(testUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      const finalUrl = pc.page.url();
      const authenticated = !finalUrl.includes("/login") && !finalUrl.includes("/auth");
      if (!authenticated) {
        await refreshPortalAuth(portal);
        const pc2 = await ensurePortalContext(portal);
        await pc2.page.goto(testUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        const retryUrl = pc2.page.url();
        result[portal.slug] = {
          authenticated: !retryUrl.includes("/login") && !retryUrl.includes("/auth"),
          checkedAt,
        };
      } else {
        result[portal.slug] = { authenticated: true, checkedAt };
      }
    } catch (e) {
      result[portal.slug] = { authenticated: false, checkedAt, error: String(e) };
    }
  }

  return { ok: true, portals: result };
}

async function browser_authenticate(portal_slug: string): Promise<{ ok: boolean; error?: string }> {
  const portal = getPortalBySlug(portal_slug);
  if (!portal) return { ok: false, error: `Unknown portal slug: ${portal_slug}` };
  if (!portal.requiresAuth) return { ok: true };

  try {
    await refreshPortalAuth(portal);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function browser_navigate(url: string): Promise<{ ok: boolean; finalUrl: string; title: string }> {
  const portal = inferPortalFromUrl(url);

  try {
    let page: Page;

    if (!portal) {
      // Unknown URL — use anonymous context
      const anon = await ensureAnonContext();
      page = anon.page;
    } else {
      const pc = await ensurePortalContext(portal);
      page = pc.page;
    }

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    let finalUrl = page.url();

    // If redirected to login and portal requires auth, re-auth and retry
    if (portal?.requiresAuth && (finalUrl.includes("/login") || finalUrl.includes("/auth"))) {
      await refreshPortalAuth(portal);
      const pc2 = await ensurePortalContext(portal);
      page = pc2.page;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      finalUrl = page.url();
    }

    currentPage = page;
    currentPortalSlug = portal?.slug ?? null;

    writeAuditEvent("browser_navigate", portal?.slug ?? "unknown", finalUrl);
    return { ok: true, finalUrl, title: await page.title() };
  } catch (e) {
    return { ok: false, finalUrl: "", title: String(e) };
  }
}

async function browser_screenshot(): Promise<{ ok: boolean; base64?: string; path?: string; sizeBytes?: number; error?: string }> {
  try {
    const page = getActivePage();
    const buffer = await page.screenshot({ type: "png", fullPage: false });
    const sizeBytes = buffer.length;
    const currentUrl = page.url();
    const portal = inferPortalFromUrl(currentUrl)?.slug ?? "unknown";

    let screenshotPath: string | undefined;
    if (sizeBytes > 200 * 1024) {
      const tmpPath = path.join(os.tmpdir(), `pacific-screenshot-${Date.now()}.png`);
      fs.writeFileSync(tmpPath, buffer);
      screenshotPath = tmpPath;
      writeAuditEvent("browser_screenshot", portal, currentUrl, { screenshotPath });
      return { ok: true, path: tmpPath, sizeBytes };
    }

    writeAuditEvent("browser_screenshot", portal, currentUrl);
    return { ok: true, base64: buffer.toString("base64"), sizeBytes };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function browser_read_dom(selector?: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  try {
    const page = getActivePage();
    const currentUrl = page.url();
    const portal = inferPortalFromUrl(currentUrl)?.slug ?? "unknown";

    let text: string;
    if (selector) {
      const el = page.locator(selector).first();
      text = await el.innerText({ timeout: 10000 });
    } else {
      text = (await page.innerText("body")).slice(0, 8000);
    }

    writeAuditEvent("browser_read_dom", portal, currentUrl, { selector: selector ?? "body" });
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function browser_click(selector: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const page = getActivePage();
    const currentUrl = page.url();
    const portal = inferPortalFromUrl(currentUrl)?.slug ?? "unknown";
    await page.click(selector, { timeout: 10000 });
    writeAuditEvent("browser_click", portal, currentUrl, { selector });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function browser_fill(selector: string, value: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const page = getActivePage();
    const currentUrl = page.url();
    const portal = inferPortalFromUrl(currentUrl)?.slug ?? "unknown";
    await page.fill(selector, value, { timeout: 10000 });
    writeAuditEvent("browser_fill", portal, currentUrl, { selector });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function browser_wait_for(selector: string, timeout_ms?: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const page = getActivePage();
    await page.waitForSelector(selector, { timeout: timeout_ms ?? 15000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function browser_render_html(html_or_path: string): Promise<{
  ok: boolean;
  base64?: string;
  path?: string;
  sizeBytes?: number;
  domText?: string;
  error?: string;
}> {
  let filePath: string;
  let isTempFile = false;

  try {
    // Determine if input is a path or raw HTML
    if (html_or_path.startsWith("/") || html_or_path.startsWith("C:\\") || html_or_path.startsWith("file://")) {
      // It's a file path
      filePath = html_or_path.startsWith("file://") ? new URL(html_or_path).pathname : html_or_path;
    } else {
      // It's raw HTML — write to temp file
      filePath = path.join(os.tmpdir(), `pacific-render-${Date.now()}.html`);
      fs.writeFileSync(filePath, html_or_path, "utf8");
      isTempFile = true;
    }

    const { page } = await ensureAnonContext();
    const fileUrl = `file://${filePath}`;

    await page.goto(fileUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(300); // small settle for CSS

    const buffer = await page.screenshot({ type: "png", fullPage: true });
    const sizeBytes = buffer.length;
    const domText = (await page.innerText("body").catch(() => "")).slice(0, 4000);

    writeAuditEvent("browser_render_html", "local", fileUrl, { filePath });

    if (sizeBytes > 200 * 1024) {
      const screenshotPath = path.join(os.tmpdir(), `pacific-render-screenshot-${Date.now()}.png`);
      fs.writeFileSync(screenshotPath, buffer);
      return { ok: true, path: screenshotPath, sizeBytes, domText };
    }

    return { ok: true, base64: buffer.toString("base64"), sizeBytes, domText };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    if (isTempFile && filePath!) {
      fs.unlink(filePath, () => undefined);
    }
  }
}

async function browser_render_html_artefact(artefact_id: string): Promise<{
  ok: boolean;
  base64?: string;
  path?: string;
  sizeBytes?: number;
  domText?: string;
  artefactTitle?: string;
  error?: string;
}> {
  if (!SANITY_TOKEN) {
    return { ok: false, error: "SANITY_TOKEN not set — cannot fetch artefact from Sanity" };
  }

  try {
    // Fetch artefact from Sanity
    const query = encodeURIComponent(
      `*[_type == "wfArtifact" && (_id == "${artefact_id}" || artifactId == "${artefact_id}")][0]{title, content, htmlContent}`
    );
    const sanityUrl = `https://${SANITY_PROJECT_ID}.api.sanity.io/v2024-01-01/data/query/${SANITY_DATASET}?query=${query}`;

    const artefact = await new Promise<{ title?: string; content?: string; htmlContent?: string } | null>((resolve, reject) => {
      const options = {
        hostname: `${SANITY_PROJECT_ID}.api.sanity.io`,
        port: 443,
        path: `/v2024-01-01/data/query/${SANITY_DATASET}?query=${query}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${SANITY_TOKEN}`,
        },
      };
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.result ?? null);
          } catch {
            reject(new Error(`Sanity parse error: ${data.slice(0, 200)}`));
          }
        });
      });
      req.on("error", reject);
      req.end();
    });

    if (!artefact) {
      return { ok: false, error: `Artefact ${artefact_id} not found in Sanity` };
    }

    const html = artefact.htmlContent || artefact.content;
    if (!html) {
      return { ok: false, error: `Artefact ${artefact_id} has no htmlContent or content field` };
    }

    const rendered = await browser_render_html(html);
    return { ...rendered, artefactTitle: artefact.title };
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
    description: "Return auth status for every registered Pacific portal. Call this first before navigating. Returns per-portal authenticated boolean and timestamp.",
    inputSchema: { type: "object", properties: {} },
  },
  browser_authenticate: {
    description: "Explicitly re-run the auth flow for one Pacific portal by slug. Use when browser_health shows a portal as expired or unauthenticated.",
    inputSchema: {
      type: "object",
      properties: { portal_slug: { type: "string", description: "Portal slug: assurance | partners-ptg | partners-pi" } },
      required: ["portal_slug"],
    },
  },
  browser_navigate: {
    description: "Navigate to a URL. Automatically authenticates if the URL is a Pacific portal that requires auth. Infers portal from hostname.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Full URL to navigate to" } },
      required: ["url"],
    },
  },
  browser_screenshot: {
    description: "Capture a PNG screenshot of the current viewport. Returns base64 (< 200KB) or file path for larger images.",
    inputSchema: { type: "object", properties: {} },
  },
  browser_read_dom: {
    description: "Read text content from the current page. Optionally filter by CSS selector (returns up to 8000 chars).",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS selector (omit for full body)" } },
    },
  },
  browser_click: {
    description: "Click a DOM element matching the CSS selector on the current page.",
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
    description: "Wait for a CSS selector to appear in the DOM on the current page.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default 15000)" },
      },
      required: ["selector"],
    },
  },
  browser_render_html: {
    description: "Render HTML for visual verification. Accepts either a raw HTML string or an absolute filesystem path to an HTML file. Opens in a headless browser via file:// URL. Returns a PNG screenshot (base64 or file path) plus DOM text dump. Use this to visually verify every HTML report, mockup, or artefact before presenting it to Mo.",
    inputSchema: {
      type: "object",
      properties: {
        html_or_path: {
          type: "string",
          description: "Raw HTML string OR absolute path to an HTML file (e.g. /tmp/report.html)",
        },
      },
      required: ["html_or_path"],
    },
  },
  browser_render_html_artefact: {
    description: "Fetch a wfArtifact from Sanity by ID and render its HTML content for visual verification. Returns screenshot and DOM text. Requires SANITY_TOKEN env var on the bridge process.",
    inputSchema: {
      type: "object",
      properties: {
        artefact_id: {
          type: "string",
          description: "Sanity document _id or artifactId of a wfArtifact with htmlContent or content field",
        },
      },
      required: ["artefact_id"],
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
        serverInfo: { name: "pacific-playwright-bridge", version: "2.0.0" },
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
        case "browser_authenticate":
          result = await browser_authenticate(toolArgs.portal_slug as string);
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
        case "browser_render_html":
          result = await browser_render_html(toolArgs.html_or_path as string);
          break;
        case "browser_render_html_artefact":
          result = await browser_render_html_artefact(toolArgs.artefact_id as string);
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
  for (const pc of portalContexts.values()) {
    await pc.context.close().catch(() => undefined);
  }
  if (anonContext) await anonContext.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  process.exit(0);
});

process.on("SIGTERM", async () => {
  for (const pc of portalContexts.values()) {
    await pc.context.close().catch(() => undefined);
  }
  if (anonContext) await anonContext.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  process.exit(0);
});
