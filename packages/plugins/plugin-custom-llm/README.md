# plugin-custom-llm

## Overview
OpenAI-compatible LLM provider with auto response format detection for external LLM services.

## Features
- **Custom Endpoints**: Connect to any custom or locally hosted LLM that exposes an OpenAI-compatible API (e.g., vLLM, Ollama, LM Studio).
- **Auto Format Detection**: Automatically handles streaming vs. non-streaming responses.
- **Model Mapping**: Expose specific models (like `llama-3`, `mistral`) to the NocoBase AI system as standard options.

## Usage
1. Enable the plugin in the Plugin Manager.
2. Go to AI settings -> Add Provider -> "Custom LLM".
3. Provide the Base URL and API Key for your custom provider.
4. Add the names of the models you wish to use.
5. You can now select these models when configuring AI Employees or Chat agents.
