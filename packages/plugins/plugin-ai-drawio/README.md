# plugin-ai-drawio

## Overview
Embed self-hosted draw.io editor as a NocoBase block, with AI Employee tools to create, inspect, edit, and append diagrams via chat.

## Features
- **Native Block Integration**: Add fully functional draw.io diagrams anywhere in NocoBase UI.
- **AI Diagram Generation**: Ask the AI Employee to generate architectural flows, sequence diagrams, or mind maps.
- **General AI Employee tools**: All enabled AI Employees receive the Draw.io tools automatically; no per-employee tool or work-context registration is needed.
- **Reliable editing**: The AI inspects an open diagram before editing, so it receives the live XML and cell IDs from the embedded editor.
- **Auto-Sync**: Changes made by AI or users are automatically synced and saved as NocoBase attachments.

## Usage
1. Activate the plugin in the Plugin Manager.
2. In any NocoBase page, add a new block and select "Draw.io Diagram".
3. To use via AI: Open AI Chat and request "Create a flowchart for user login". The AI can create a diagram even when no Draw.io block is open. To edit an open diagram, ask for the change while that diagram is visible on the page.
