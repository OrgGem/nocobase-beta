/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * LangChain-compatible embeddings wrapper for local ONNX inference
 * via plugin-embed-web-client's embedTexts() function.
 *
 * Accepts embedTexts as a function reference to avoid a hard dependency
 * on plugin-embed-web-client — the function is resolved at runtime.
 */

type EmbedTextsFn = (texts: string[], modelId: string, dtype: string) => Promise<number[][]>;

const BATCH_SIZE = 16;

export class LocalOnnxEmbeddings {
  readonly modelName: string;

  constructor(
    private embedTextsFn: EmbedTextsFn,
    private modelId: string,
    private dtype: string,
  ) {
    this.modelName = `${modelId}::${dtype}`;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const vectors = await this.embedTextsFn(batch, this.modelId, this.dtype);
      results.push(...vectors);
    }
    return results;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embedTextsFn([text], this.modelId, this.dtype);
    return vec;
  }
}
