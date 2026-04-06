/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * DocPixie Plugin — NocoBase LLM Adapter
 *
 * Bridges the gap between:
 *   - DocPixie's ILLMProvider interface (processTextMessages / processMultimodalMessages)
 *   - NocoBase's LangChain-based LLMProvider (chatModel.invoke with HumanMessage, etc.)
 *
 * This adapter wraps a NocoBase LLMProvider's underlying chatModel and exposes
 * the raw message-based API that DocPixie's service layer expects.
 *
 * Image handling: Converts DocPixie's internal `image_path` content items
 * to base64 `image_url` format (same logic as the original OpenAICompatibleProvider).
 */

import * as fs from 'fs';
import * as path from 'path';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import type { ILLMProvider } from '../types';
import { ProviderError } from '../exceptions';

/** MIME type lookup by file extension */
const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.pdf': 'application/pdf',
};

/**
 * Adapter that wraps a NocoBase LangChain chatModel into DocPixie's ILLMProvider interface.
 *
 * Usage:
 * ```ts
 * const provider = new NocoBaseLLMAdapter(textChatModel, visionChatModel);
 * const text = await provider.processTextMessages([
 *   { role: 'system', content: 'You are helpful.' },
 *   { role: 'user', content: 'Hello' },
 * ]);
 * ```
 */
export class NocoBaseLLMAdapter implements ILLMProvider {
  private textModel: any;
  private visionModel: any;
  private totalCost = 0;

  /**
   * @param textModel - LangChain BaseChatModel for text-only calls
   * @param visionModel - LangChain BaseChatModel for vision/multimodal calls (can be same as textModel)
   */
  constructor(textModel: any, visionModel?: any) {
    this.textModel = textModel;
    this.visionModel = visionModel || textModel;
  }

  // ═══════════════════════════════════════════
  // ILLMProvider Implementation
  // ═══════════════════════════════════════════

  /**
   * Process text-only messages using the text model.
   */
  async processTextMessages(
    messages: Array<{ role: string; content: string }>,
    maxTokens = 500,
    temperature = 0.3,
  ): Promise<string> {
    try {
      const langchainMessages = this.convertToLangChainMessages(messages);

      // Create a copy of the model with specific parameters
      const model = this.textModel.bind({
        max_tokens: maxTokens,
        temperature,
      });

      const result = await model.invoke(langchainMessages);

      // Track cost from usage metadata if available
      this.trackCost(result);

      return this.extractContent(result);
    } catch (err: any) {
      throw new ProviderError(`Text LLM call failed: ${err.message}`, 'nocobase-llm');
    }
  }

  /**
   * Process multimodal messages (text + images) using the vision model.
   * Automatically converts `image_path` content items to base64 `image_url`.
   */
  async processMultimodalMessages(
    messages: Array<{ role: string; content: any }>,
    maxTokens = 500,
    temperature = 0.3,
  ): Promise<string> {
    try {
      const prepared = this.prepareMessages(messages);
      const langchainMessages = this.convertToLangChainMessages(prepared);

      const model = this.visionModel.bind({
        max_tokens: maxTokens,
        temperature,
      });

      const result = await model.invoke(langchainMessages);

      this.trackCost(result);

      return this.extractContent(result);
    } catch (err: any) {
      throw new ProviderError(`Vision LLM call failed: ${err.message}`, 'nocobase-llm');
    }
  }

  /** Accumulated cost of all API calls (USD) */
  getTotalCost(): number {
    return this.totalCost;
  }

  /** Reset cost counter */
  resetCost(): void {
    this.totalCost = 0;
  }

  // ═══════════════════════════════════════════
  // Message Conversion
  // ═══════════════════════════════════════════

  /**
   * Convert DocPixie's {role, content} messages to LangChain message objects.
   */
  private convertToLangChainMessages(messages: Array<{ role: string; content: any }>): any[] {
    return messages.map((msg) => {
      switch (msg.role) {
        case 'system':
          return new SystemMessage(msg.content);
        case 'assistant':
          return new AIMessage(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
        case 'user':
        default:
          // For multimodal content arrays, LangChain HumanMessage accepts them directly
          return new HumanMessage({ content: msg.content });
      }
    });
  }

  // ═══════════════════════════════════════════
  // Image Processing (ported from OpenAICompatibleProvider)
  // ═══════════════════════════════════════════

  /**
   * Walk through messages and convert `image_path` content items
   * to OpenAI-compatible `image_url` with base64 data URLs.
   *
   * Input format (DocPixie internal):
   * ```json
   * { "type": "image_path", "image_path": "/path/to/img.jpg", "detail": "high" }
   * ```
   *
   * Output format (OpenAI API):
   * ```json
   * { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,...", "detail": "high" } }
   * ```
   */
  private prepareMessages(messages: any[]): any[] {
    const prepared: any[] = [];

    for (const message of messages) {
      if (message.role === 'system') {
        prepared.push(message);
      } else if (message.role === 'user' && Array.isArray(message.content)) {
        const processedContent: any[] = [];

        for (const item of message.content) {
          if (item.type === 'text') {
            processedContent.push(item);
          } else if (item.type === 'image_path') {
            const imagePath = item.image_path;
            if (this.validateImagePath(imagePath)) {
              const dataUrl = this.createImageDataUrl(imagePath);
              processedContent.push({
                type: 'image_url',
                image_url: {
                  url: dataUrl,
                  detail: item.detail || 'high',
                },
              });
            }
            // Skip invalid image paths silently (same as DocPixie Python)
          } else {
            processedContent.push(item);
          }
        }

        prepared.push({ role: message.role, content: processedContent });
      } else {
        prepared.push(message);
      }
    }

    return prepared;
  }

  // ═══════════════════════════════════════════
  // Image Helpers
  // ═══════════════════════════════════════════

  /** Encode an image file to base64 string */
  private encodeImage(imagePath: string): string {
    try {
      const buffer = fs.readFileSync(imagePath);
      return buffer.toString('base64');
    } catch (err: any) {
      throw new ProviderError(`Failed to encode image ${imagePath}: ${err.message}`, 'nocobase-llm');
    }
  }

  /** Create a data URL for an image (data:image/jpeg;base64,...) */
  private createImageDataUrl(imagePath: string): string {
    const ext = path.extname(imagePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'image/jpeg';
    const encoded = this.encodeImage(imagePath);
    return `data:${mime};base64,${encoded}`;
  }

  /** Validate that an image path exists and is readable */
  private validateImagePath(imagePath: string): boolean {
    try {
      fs.accessSync(imagePath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  // ═══════════════════════════════════════════
  // Response Helpers
  // ═══════════════════════════════════════════

  /** Extract text content from a LangChain response */
  private extractContent(result: any): string {
    if (typeof result === 'string') return result.trim();
    if (result?.content) {
      if (typeof result.content === 'string') return result.content.trim();
      // Handle content block arrays
      if (Array.isArray(result.content)) {
        return result.content
          .filter((block: any) => block.type === 'text')
          .map((block: any) => block.text || '')
          .join('')
          .trim();
      }
    }
    if (result?.text) return result.text.trim();
    throw new ProviderError(
      `Unexpected LLM response format: ${JSON.stringify(result).substring(0, 200)}`,
      'nocobase-llm',
    );
  }

  /** Track cost from LangChain response metadata */
  private trackCost(result: any): void {
    // LangChain models expose usage_metadata on the response
    const usage = result?.usage_metadata;
    if (usage) {
      // Some providers include cost directly
      if (typeof usage.cost === 'number') {
        this.totalCost += usage.cost;
      }
      // Estimate cost from token counts if available (rough estimate)
      // Most accurate cost tracking comes from provider-specific billing
    }
  }
}
