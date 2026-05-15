# pacific-playwright-bridge

MCP server providing authenticated browser automation for `assurance.pacific.london` via Playwright. Runs on Windows (`C:\Users\ali\pacific-playwright-bridge\`), serves the orchestrator (Claude.ai) with read-only dashboard access as `qa@pacific.london`.

## Prerequisites

- Node.js 20+
- Windows machine with access to `assurance.pacific.london`
- `PLAYWRIGHT_QA_SECRET` env var set (get from Mo / Vercel env)

## Install

```powershell
cd C:\Users\ali\pacific-playwright-bridge
npm install
npx playwright install chromium
npm run build
```

## Environment variables

Create `.env` (or set in system env):

```env
PLAYWRIGHT_QA_SECRET=<secret from Vercel PLAYWRIGHT_QA_SECRET env var>
DASHBOARD_URL=https://assurance.pacific.london
```

## Run

```powershell
# Production (compiled)
node dist/index.js

# Development
npx ts-node src/index.ts
```

The server speaks MCP JSON-RPC 2.0 over stdio. Wire it into Claude.ai MCP settings (see below).

## Claude.ai MCP config snippet

Paste this into your Claude.ai MCP server configuration JSON:

```json
{
  "pacific-playwright-bridge": {
    "command": "node",
    "args": ["C:\\Users\\ali\\pacific-playwright-bridge\\dist\\index.js"],
    "env": {
      "PLAYWRIGHT_QA_SECRET": "<secret>",
      "DASHBOARD_URL": "https://assurance.pacific.london"
    }
  }
}
```

## Health check

Once configured, ask Claude to call `browser_health`. Expected response:

```json
{ "ok": true, "authenticated": true, "url": "https://assurance.pacific.london/admin" }
```

If `authenticated: false`, the QA session will auto-renew and retry once.

## Auth flow

1. On first run (or if `.session.json` is missing or >6 days old), the bridge calls `POST /api/auth/qa-session` with `Authorization: Bearer <PLAYWRIGHT_QA_SECRET>`.
2. The dashboard returns a `pac_staff_session` cookie value.
3. The bridge stores it in `.session.json` (mode 0600) and uses it for all Playwright requests.
4. If the session expires mid-run, the bridge self-heals: clears `.session.json`, re-fetches, retries once.

## Available tools

| Tool | Description |
|------|-------------|
| `browser_health` | Verify browser running + session authenticated |
| `browser_navigate(url)` | Navigate to URL |
| `browser_screenshot()` | Capture viewport PNG (base64 if <200KB, file path if larger) |
| `browser_read_dom(selector?)` | Read text content (full body or filtered by selector) |
| `browser_click(selector)` | Click element |
| `browser_fill(selector, value)` | Fill form input |
| `browser_wait_for(selector, timeout_ms?)` | Wait for element to appear |

## Credential rotation

1. Generate a new `PLAYWRIGHT_QA_SECRET` in Vercel dashboard (project → Environment Variables → `PLAYWRIGHT_QA_SECRET`).
2. Update the value in the MCP config JSON and restart Claude.ai.
3. Delete `.session.json` to force immediate re-auth.

## QA user

`qa@pacific.london` is provisioned in each portal's `qa_viewer_roles` table with read-only access. It can navigate and read all admin pages but cannot mutate any data. All session activity is auditable in `staff_sessions`.

**`qa@pacific.london` is an email alias** routing to `ali@pacific.london`'s Exchange Online mailbox — it is not a separate licensed mailbox, shared mailbox, or AAD/Entra identity. The bridge never uses email for auth; authentication is entirely via the `PLAYWRIGHT_QA_SECRET` bearer token.
