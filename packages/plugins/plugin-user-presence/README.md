# plugin-user-presence

## Overview
Tracks user online/offline status, typing indicators, and presence broadcasting via WebSocket heartbeats.

## Features
- **Online Status**: See the green dot indicator for active users in the system.
- **Typing Indicators**: Shows "User is typing..." in chat interfaces.
- **Heartbeat Mechanism**: Efficiently tracks active sessions without overloading the database.

## Usage
*This is an infrastructure plugin.*
1. Enable the plugin.
2. Status indicators will automatically appear in supported UI components (like user avatars, team chat, and collaborative documents).
