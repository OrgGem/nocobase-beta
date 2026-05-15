# plugin-ai-browser

AI Browser Automation plugin for NocoBase.

## Overview

This plugin enables the NocoBase **AI Employee to natively control a browser** end-to-end, while users watch in readonly mode. 
Instead of relying on an external autonomous agent (like `browser-use`), the AI Employee is the "brain", using granular tools (`click`, `type`, `scroll`) via Playwright CDP to control a headless `browserless/chromium` container.

This guarantees:
1. **1x LLM Cost**: Only NocoBase AI Manager uses LLM tokens (no external agent calling LLM).
2. **Full Context**: AI Employee shares session context directly with the user conversation.
3. **True Agentic Control**: AI Employee reasons based on DOM and screenshots at every step.

## Architecture

```
plugin-ai-browser
  ├─ server
  │  ├─ services/          — Session, Profile, Policy services
  │  ├─ drivers/           — PlaywrightDriver, IBrowserDriver interface
  │  ├─ actions/           — Config, driver status endpoints
  │  ├─ collections/       — 8 collections (sessions, tasks, profiles, events, caches, config)
  │  └─ tools/             — Granular AI tools (open, click, type, read_page, scroll)
  └─ client
     ├─ AIBrowserBlock     — Readonly iframe viewer (VNC / browserless debug)
     ├─ AIBrowserManager   — Admin settings page
     ├─ AIBrowserSessionCard — Compact card for AI chat
     └─ AIBrowserWorkContext — Chat context provider
```

## AI Tools

| Tool | Description |
|------|-------------|
| `browser_open_url` | Open a browser session and navigate to a URL |
| `browser_click_element` | Click on an element using Playwright/CSS selector |
| `browser_input_text` | Type text into an input field |
| `browser_scroll` | Scroll up, down, top, or bottom |
| `browser_read_page` | Get screenshot and simplified DOM |
| `browser_get_session` | Get session details |
| `browser_stop_session` | Stop a running session |
| `browser_list_sessions` | List sessions with filters |
| `browser_get_artifacts` | Get session screenshots and action logs |

## Driver Setup (Playwright)

The plugin uses `PlaywrightDriver` to connect over CDP.
In production, it connects to a `browserless/chromium` container in the NocoBase network.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_BROWSER_CDP_URL` | `ws://browser:3000` | WebSocket endpoint of the headless browser |
| `AI_BROWSER_LIVE_URL` | derived from `AI_BROWSER_CDP_URL` | Public/same-origin readonly viewer URL exposed in session metadata |

In Docker, do not expose the internal `browser` hostname to the browser UI. Use a public URL or a same-origin nginx proxy, for example:

```env
AI_BROWSER_CDP_URL=ws://browser:3000
AI_BROWSER_LIVE_URL=/ai-browser-live/
```

The bundled production compose proxies `/ai-browser-live/` to `browserless:3000`.

## Cache Strategy

Workflows are cached as intent → ordered steps → element fingerprints:
- Cache matching uses a weighted score (URL pattern, intent similarity, success rate, scope)
- AI Employee will attempt to follow cached step selectors directly to save tokens.

## License

Apache-2.0
