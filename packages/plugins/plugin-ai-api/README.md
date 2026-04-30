# plugin-ai-api

## Overview
Provides an internal API layer for routing and managing AI model interactions in NocoBase.

## Features
- **Centralized AI Routing**: Acts as the middleware for all AI-related requests.
- **Provider Abstraction**: Normalizes requests and responses across different LLM providers (OpenAI, Anthropic, Custom LLMs).
- **Rate Limiting & Logging**: Internal mechanisms to track token usage and API limits.

## Usage
*This is primarily an internal system plugin.*
1. Enable the plugin via the Plugin Manager.
2. Developers can use the exported API services in their custom plugins by importing `@nocobase/plugin-ai-api`.
3. Configure default AI models in the global NocoBase Settings under "AI API Provider".
