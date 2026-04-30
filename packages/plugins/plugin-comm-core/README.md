# plugin-comm-core

## Overview
Foundation layer for realtime communication suite - shared database models, event contracts, and WebSocket message routing for chat, presence, and meetings.

## Features
- **WebSocket Routing**: Core messaging bus for realtime events.
- **Shared Schemas**: Provides foundational database models for Messages, Channels, and Threads.
- **Pub/Sub System**: Efficient event distribution across NocoBase instances.

## Usage
*This is a core dependency plugin and runs in the background.*
1. Enable the plugin (usually activated automatically by dependent plugins like `plugin-team-chat` or `plugin-user-presence`).
2. Developers can hook into `CommCoreService` to broadcast custom realtime events to connected clients.
