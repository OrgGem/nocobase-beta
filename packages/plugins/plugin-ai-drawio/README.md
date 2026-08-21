# plugin-ai-drawio

## Overview
Embed a self-hosted draw.io editor inside the AI Employee chat with a single shared canvas, plus tools to create, inspect, edit, and append diagrams via chat.

## Features
- **Single shared canvas**: The plugin keeps exactly ONE draw.io screen for the whole chat. The first time the AI displays a diagram, an "Open Diagram" button appears; once opened, every later display/edit call updates the SAME canvas in place — no new screen is created per reply.
- **No server session / DB records**: The self-hosted draw.io server keeps its data in the browser, so the plugin only pushes XML into the iframe. A lightweight list of XML schemas (title + XML per diagram) is kept in localStorage so diagrams survive page refreshes.
- **Reopen behavior**: If the user closes the canvas, the next AI tool call shows the "Open Diagram" button again so they can reopen the shared canvas.
- **AI Diagram Generation**: Ask the AI Employee to generate architectural flows, sequence diagrams, or mind maps.
- **General AI Employee tools**: All enabled AI Employees receive the Draw.io tools automatically; no per-employee tool or work-context registration is needed.
- **Reliable editing**: The AI inspects the current diagram before editing, so it receives the live XML and cell IDs from the canvas.

## Usage
1. Activate the plugin in the Plugin Manager.
2. (Optional, admin) In plugin settings, set the self-hosted draw.io base URL (defaults to https://embed.diagrams.net).
3. Open AI Chat and request "Create a flowchart for user login". Click "Open Diagram" on the first result; subsequent replies update the same canvas.
