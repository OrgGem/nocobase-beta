/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * DocPixie Plugin — Type Definitions
 *
 * Shared interfaces and types used across the plugin's server-side modules.
 * These types model the data flowing through the document processing pipeline:
 *
 *   Upload → Extract (OCR) → Store → Query (LLM) → Response
 *
 * Adapted for NocoBase: LLM configuration uses llmServiceName references
 * to the NocoBase `llmServices` collection instead of raw endpoint/apiKey.
 */

// ─────────────────────────────────────────────
// Document Processing Types
// ─────────────────────────────────────────────

/** Status of a document through the processing pipeline */
export type DocumentStatus = 'pending' | 'extracting' | 'summarizing' | 'ready' | 'failed';

/** Strategy for analyzing document pages */
export type AnalysisStrategy = 'vision' | 'ocr_only' | 'hybrid';

/** Supported OCR provider backends */
export type OCRProviderType = 'external_api' | 'none';

/**
 * Configuration for the DocPixie processing engine.
 * Stored in the `docpixie_config` collection.
 *
 * Unlike the original draft that stored raw llmEndpoint/apiKey,
 * this version references NocoBase's centralized LLM service config.
 */
export interface DocPixiePluginConfig {
  /** Name of the LLM service in NocoBase `llmServices` collection (for text processing) */
  llmServiceName: string;
  /** Name of the LLM service for vision/multimodal processing (can be same as text) */
  visionLlmServiceName: string;
  /** How pages are analyzed: vision (images→LLM), ocr_only (text→LLM), hybrid (OCR select + vision analyze) */
  analysisStrategy: AnalysisStrategy;
  /** OCR engine to use for text extraction */
  ocrProvider: OCRProviderType;
  /** Base URL when ocrProvider is 'external_api' */
  ocrApiEndpoint?: string;
  /** API key when ocrProvider is 'external_api' */
  ocrApiKey?: string;
  /** Max pages the vision LLM may analyze per task */
  maxPagesPerTask: number;
  /** Max tasks the adaptive planner may create per query */
  maxTasksPerPlan: number;
}

// ─────────────────────────────────────────────
// Structured Extraction Types
// ─────────────────────────────────────────────

/**
 * A region detected by layout analysis (DeepDoc / YOLO).
 * Each region represents one semantic block on a page.
 */
export interface PageRegion {
  /** Region type detected by layout model */
  type: 'text' | 'table' | 'figure' | 'header' | 'footer' | 'caption' | 'list';
  /** Bounding box [x1, y1, x2, y2] in pixels */
  bbox: [number, number, number, number];
  /** OCR-extracted text content (empty for figures) */
  text: string;
  /** Markdown representation (especially useful for tables) */
  markdown?: string;
  /** For figures: relative path to the cropped image file */
  imagePath?: string;
  /** Confidence score from the layout model (0–1) */
  confidence: number;
}

/**
 * Structured extraction result for a single page.
 * Produced by the extraction pipeline and stored in `docpixie_pages`.
 */
export interface PageExtraction {
  /** 1-based page number */
  pageNumber: number;
  /** Full structured text in reading order (Markdown) */
  structuredText: string;
  /** Individual detected regions with their types and bounding boxes */
  regions: PageRegion[];
  /** Path to the rendered page image (JPEG) */
  imagePath: string;
  /** true if any table regions were detected */
  hasTables: boolean;
  /** true if any figure regions were detected */
  hasFigures: boolean;
  /** List of heading strings found on this page */
  headings: string[];
  /** OCR engine used for this page */
  extractionMethod: OCRProviderType | 'text_layer';
}

// ─────────────────────────────────────────────
// Query & Response Types
// ─────────────────────────────────────────────

/**
 * Input for a document query submitted through the NocoBase API.
 */
export interface DocPixieQueryInput {
  /** The user's natural-language question */
  query: string;
  /** Restrict analysis to these document IDs (optional — defaults to all) */
  documentIds?: number[];
  /** Override analysis strategy for this query only */
  strategy?: AnalysisStrategy;
  /** Previous messages for multi-turn conversation */
  conversationHistory?: ConversationTurn[];
  /** Optional user ID executing the query */
  userId?: number;
}

/** A single turn in the conversation history */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Result returned by the query pipeline.
 */
export interface DocPixieQueryResult {
  /** The final synthesized answer */
  answer: string;
  /** Pages that were analyzed to produce the answer */
  sourcePages: SourcePage[];
  /** Confidence score (0–1) */
  confidence: number;
  /** Total LLM API cost for this query (USD) */
  totalCost: number;
  /** Processing time in seconds */
  processingTime: number;
  /** Summary of tasks executed by the adaptive agent */
  tasksSummary: TaskSummary[];
}

/** Reference to a source page used in the answer */
export interface SourcePage {
  documentId: number;
  documentName: string;
  pageNumber: number;
}

/** Summary of one task in the adaptive agent plan */
export interface TaskSummary {
  taskName: string;
  documentName: string;
  pagesAnalyzed: number[];
  status: 'completed' | 'cancelled' | 'failed';
}

// ─────────────────────────────────────────────
// Service Interfaces
// ─────────────────────────────────────────────

/**
 * Contract for any OCR engine that extracts text from a page image.
 * Implementations: ExternalAPIExtractor (or none for vision-only).
 */
export interface IOCRProvider {
  /** Unique name of this provider */
  readonly name: OCRProviderType;

  /**
   * Extract text content from a page image.
   *
   * @param imagePath - Absolute path to the page image (JPEG)
   * @returns Extracted text as plain string
   */
  extractText(imagePath: string): Promise<string>;

  /**
   * Extract structured content from a page image, including regions.
   * Returns richer data than `extractText` — includes layout regions.
   *
   * @param imagePath - Absolute path to the page image (JPEG)
   * @returns Full page extraction with regions, markdown tables, etc.
   */
  extractStructured(imagePath: string): Promise<PageExtraction>;

  /**
   * Check if this provider is available (dependencies installed, API reachable).
   * Called at plugin startup to validate configuration.
   */
  isAvailable(): Promise<boolean>;
}

/**
 * Contract for the LLM provider that processes text and multimodal messages.
 * In the NocoBase version, this is implemented by NocoBaseLLMAdapter which
 * wraps the LangChain-based LLMProvider from plugin-ai.
 */
export interface ILLMProvider {
  /**
   * Process text-only messages (no images).
   * Used by: TaskPlanner, QueryClassifier, QueryReformulator, ContextProcessor, Synthesizer.
   *
   * @param messages - Array of {role, content} chat messages
   * @param maxTokens - Maximum tokens in the response
   * @param temperature - Sampling temperature (0–1)
   * @returns LLM response text
   */
  processTextMessages(
    messages: Array<{ role: string; content: string }>,
    maxTokens?: number,
    temperature?: number,
  ): Promise<string>;

  /**
   * Process multimodal messages (text + images).
   * Used by: PageSummarizer, VisionPageSelector, Agent page analysis.
   *
   * @param messages - Array of chat messages; user messages may contain image_path items
   * @param maxTokens - Maximum tokens in the response
   * @param temperature - Sampling temperature (0–1)
   * @returns LLM response text
   */
  processMultimodalMessages(
    messages: Array<{ role: string; content: any }>,
    maxTokens?: number,
    temperature?: number,
  ): Promise<string>;

  /** Accumulated cost of all API calls made through this provider instance (USD) */
  getTotalCost(): number;

  /** Reset accumulated cost counter */
  resetCost(): void;
}
