/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * RecursiveCharacterTextSplitter — pure TypeScript, zero dependencies.
 *
 * Mirrors the algorithm used by @langchain/textsplitters:
 * recursively splits text using a priority list of separators until all
 * chunks are at or below chunkSize, then re-merges with overlap.
 */

const DEFAULT_SEPARATORS = ['\n\n', '\n', ' ', ''];

export interface TextSplitterOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  separators?: string[];
}

export interface TextChunk {
  text: string;
  index: number; // character offset in original text
}

export class RecursiveCharacterTextSplitter {
  private chunkSize: number;
  private chunkOverlap: number;
  private separators: string[];

  constructor(options: TextSplitterOptions = {}) {
    this.chunkSize = options.chunkSize ?? 1000;
    this.chunkOverlap = options.chunkOverlap ?? 200;
    this.separators = options.separators ?? DEFAULT_SEPARATORS;

    if (this.chunkOverlap >= this.chunkSize) {
      throw new Error('chunkOverlap must be less than chunkSize');
    }
  }

  splitText(text: string): string[] {
    const chunks: string[] = [];
    this._splitText(text, this.separators, chunks);
    return chunks;
  }

  private _splitText(text: string, separators: string[], output: string[]): void {
    // Find the best separator — the first one that actually appears in the text
    let goodSeparator = separators[separators.length - 1]; // fallback: ''
    let newSeparators: string[] = [];

    for (let i = 0; i < separators.length; i++) {
      const sep = separators[i];
      if (sep === '' || text.includes(sep)) {
        goodSeparator = sep;
        newSeparators = separators.slice(i + 1);
        break;
      }
    }

    // Split the text by the chosen separator
    const splits = goodSeparator === '' ? text.split('') : text.split(goodSeparator);

    // For each split: if it fits, keep it; otherwise recurse
    const goodSplits: string[] = [];

    for (const s of splits) {
      if (s.length === 0) continue;

      if (s.length <= this.chunkSize) {
        goodSplits.push(s);
      } else if (newSeparators.length > 0) {
        // This piece is still too big — recurse with remaining separators
        if (goodSplits.length > 0) {
          this._mergeSplits(goodSplits, goodSeparator, output);
          goodSplits.length = 0;
        }
        this._splitText(s, newSeparators, output);
      } else {
        // No more separators — hard-split by chunkSize
        if (goodSplits.length > 0) {
          this._mergeSplits(goodSplits, goodSeparator, output);
          goodSplits.length = 0;
        }
        this._hardSplit(s, output);
      }
    }

    if (goodSplits.length > 0) {
      this._mergeSplits(goodSplits, goodSeparator, output);
    }
  }

  private _mergeSplits(splits: string[], separator: string, output: string[]): void {
    const sepLen = separator.length;
    const current: string[] = [];
    let currentLen = 0;

    for (const split of splits) {
      const splitLen = split.length;
      const joinerLen = current.length > 0 ? sepLen : 0;

      if (currentLen + joinerLen + splitLen > this.chunkSize && current.length > 0) {
        const chunk = current.join(separator);
        if (chunk.trim()) output.push(chunk);

        // Drop from the front until overlap is satisfied
        while (current.length > 0) {
          const dropLen = current[0].length + (current.length > 1 ? sepLen : 0);
          if (currentLen - dropLen < this.chunkOverlap) break;
          currentLen -= dropLen;
          current.shift();
        }
      }

      current.push(split);
      currentLen += splitLen + (current.length > 1 ? sepLen : 0);
    }

    if (current.length > 0) {
      const chunk = current.join(separator);
      if (chunk.trim()) output.push(chunk);
    }
  }

  private _hardSplit(text: string, output: string[]): void {
    // Hard character-boundary split with overlap
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + this.chunkSize, text.length);
      const chunk = text.slice(start, end).trim();
      if (chunk) output.push(chunk);
      start += this.chunkSize - this.chunkOverlap;
    }
  }
}
