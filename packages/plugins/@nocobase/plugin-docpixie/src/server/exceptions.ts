/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * DocPixie Plugin — Custom Exceptions
 *
 * Ported from docpixie/exceptions.py.
 * Each exception maps to a specific pipeline step for targeted error handling & debugging.
 */

/** Base exception for all DocPixie errors */
export class DocPixieError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocPixieError';
  }
}

/** Error during conversation context summarization (Step 1) */
export class ContextProcessingError extends DocPixieError {
  constructor(message: string) {
    super(message);
    this.name = 'ContextProcessingError';
  }
}

/** Error during query reformulation (Step 2) */
export class QueryReformulationError extends DocPixieError {
  constructor(message: string) {
    super(message);
    this.name = 'QueryReformulationError';
  }
}

/** Error during needs_documents classification (Step 3) */
export class QueryClassificationError extends DocPixieError {
  constructor(message: string) {
    super(message);
    this.name = 'QueryClassificationError';
  }
}

/** Error during task planning or document selection (Step 4) */
export class TaskPlanningError extends DocPixieError {
  constructor(message: string) {
    super(message);
    this.name = 'TaskPlanningError';
  }
}

/** Error during page selection (Step 5) */
export class PageSelectionError extends DocPixieError {
  constructor(message: string) {
    super(message);
    this.name = 'PageSelectionError';
  }
}

/** Error during page analysis (Step 6) */
export class TaskAnalysisError extends DocPixieError {
  constructor(message: string) {
    super(message);
    this.name = 'TaskAnalysisError';
  }
}

/** Error during adaptive plan update (Step 7) */
export class PlanUpdateError extends DocPixieError {
  constructor(message: string) {
    super(message);
    this.name = 'PlanUpdateError';
  }
}

/** Error during response synthesis (Step 8) */
export class ResponseSynthesisError extends DocPixieError {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseSynthesisError';
  }
}

/** Error from LLM/OCR provider (HTTP call failures) */
export class ProviderError extends DocPixieError {
  public provider: string;
  constructor(message: string, provider: string) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
  }
}

/** Error during document processing (file read, extraction) */
export class ProcessingError extends DocPixieError {
  public filePath?: string;
  public pageNumber?: number;
  constructor(message: string, filePath?: string, pageNumber?: number) {
    super(message);
    this.name = 'ProcessingError';
    this.filePath = filePath;
    this.pageNumber = pageNumber;
  }
}
