# pacific-playwright-bridge

MCP server providing authenticated browser automation for Pacific portal dashboards via Playwright. Gives Claude.ai read-only access to navigate, screenshot, and read DOM from admin-gated pages.

## Portals

| Portal | URL | Slug |
|--------|-----|------|
| Pacific Assurance Dashboard | https://assurance.pacific.london | `assurance` |
| PTG Partner Portal | https://partners.pacific.london | `ptg` |
| PI Partner Portal | https://partners.pacificinfotech.co.uk | `pi` |

## Auth architecture

Each portal uses a shared-secret qa-session endpoint:

1. Bridge calls `POST /api/auth/qa-session` with `Authorization: Bearer <PLAYWRIGHT_QA_SECRET>`.
2. Portal returns a session cookie (`pac_staff_session` or `portal_session`).
3. Bridge caches it in `.sessions/<slug>.json` (mode 0600, TTL 6 days) and injects it into every Playwright request.
4. On expiry or auth failure, bridge self-heals: clears the cache, re-fetches, retries once.

**`qa@pacific.london` is an email alias** that routes to `ali@pacific.london`'s Exchange Online mailbox. It is **not** a separate licensed mailbox, a shared mailbox, or an AAD/Entra user identity. Emails sent to `qa@pacific.london` arrive in Mo's inbox. The bridge never sends or receives email — it uses only the `PLAYWRIGHT_QA_SECRET` bearer token for authentication.

## Available tools

| Tool | Description |
|------|-------------|
| `browser_health` | Per-portal auth and browser status |
| `browser_authenticate(slug)` | Force re-auth for a specific portal |
| `browser_navigate(url)` | Navigate to URL (infers portal from hostname) |
| `browser_screenshot()` | Viewport PNG (base64 <200KB, file path if larger) |
| `browser_read_dom(selector?)` | Read text content (full body or CSS selector) |
| `browser_click(selector)` | Click element |
| `browser_fill(selector, value)` | Fill form input |
| `browser_wait_for(selector, timeout_ms?)` | Wait for element to appear |
| `browser_render_html(html_or_path)` | Render raw HTML string or local file path |
| `browser_render_html_artefact(artifact_id)` | Fetch Sanity wfArtifact HTML and render |

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PLAYWRIGHT_QA_SECRET` | Yes (assurance portal) | Bearer token for assurance qa-session endpoint |
| `PLAYWRIGHT_QA_SECRET_PTG` | Yes (PTG portal) | Bearer token for PTG portal qa-session endpoint |
| `PLAYWRIGHT_QA_SECRET_PI` | Yes (PI portal) | Bearer token for PI portal qa-session endpoint |
| `DASHBOARD_URL` | No | Override assurance base URL (default: https://assurance.pacific.london) |
| `SANITY_TOKEN` | No | For audit event writes and browser_render_html_artefact |
| `SANITY_PROJECT_ID` | No | Sanity project (default: 74704nsd) |
| `SANITY_DATASET` | No | Sanity dataset (default: production) |

## Windows install path

```
C:\Users\ali\pacific-playwright-bridge\
```

## Wiring into Claude.ai

Paste into Claude.ai MCP configuration (Settings → Integrations → MCP):

```json
{
  "pacific-playwright-bridge": {
    "command": "node",
    "args": ["C:\\Users\\ali\\pacific-playwright-bridge\\dist\\index.js"],
    "env": {
      "PLAYWRIGHT_QA_SECRET": "<assurance secret from Vercel>",
      "PLAYWRIGHT_QA_SECRET_PTG": "<ptg secret from Vercel>",
      "PLAYWRIGHT_QA_SECRET_PI": "<pi secret from Vercel>",
      "SANITY_TOKEN": "<token from ~/.pacific/env>"
    }
  }
}
```

## Credential rotation

1. Generate new secret in Vercel: project → Environment Variables → `PLAYWRIGHT_QA_SECRET` (or PTG/PI variant).
2. Update value in Claude.ai MCP config, restart Claude.ai.
3. Delete `.sessions/<slug>.json` to force immediate re-auth.

## QA user (db-side)

`qa@pacific.london` is provisioned in each portal's `qa_viewer_roles` table and `auth_credentials` table (method: `qa_secret`). It has read-only access — no `admin_role_assignments`, no `referral_partners` row. All session activity is recorded in each portal's `staff_sessions` table.
