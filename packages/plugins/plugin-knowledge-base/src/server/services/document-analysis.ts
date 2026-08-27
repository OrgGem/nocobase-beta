/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Database } from '@nocobase/database';

/**
 * Lightweight, deterministic document analysis utilities:
 *
 * - Auto keyword extraction (TF-based, language-agnostic tokenization)
 * - Exact + near duplicate detection via shingling & Jaccard similarity
 *
 * These run locally without an LLM so they stay fast and free. An optional
 * LLM-based summarizer can be layered on top later by the caller.
 */

export type DocumentAnalysis = {
  keywords: string[];
  wordCount: number;
  fingerprint: string;
};

export type DuplicatePair = {
  documentId: string;
  otherDocumentId: string;
  similarity: number;
};

const STOP_WORDS = new Set([
  // English
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'must',
  'can',
  'this',
  'that',
  'these',
  'those',
  // Vietnamese
  'của',
  'và',
  'là',
  'có',
  'được',
  'một',
  'các',
  'những',
  'trong',
  'cho',
  'từ',
  'với',
  'này',
  'khi',
  'theo',
  'không',
  'sẽ',
  'đã',
  'cũng',
  'như',
  'để',
  'trên',
  'hoặc',
  // Chinese particles (single chars filtered by length anyway)
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => token.length > 1);
}

/** Simple character n-gram shingle set used for near-duplicate similarity. */
function buildShingles(text: string, shingleSize = 8): Set<string> {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  const shingles = new Set<string>();
  if (normalized.length <= shingleSize) {
    if (normalized) shingles.add(normalized);
    return shingles;
  }
  for (let i = 0; i <= normalized.length - shingleSize; i++) {
    shingles.add(normalized.slice(i, i + shingleSize));
  }
  return shingles;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of smaller) {
    if (larger.has(item)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

/**
 * Analyze a single document: extract top keywords and compute a
 * similarity-ready fingerprint.
 */
export function analyzeDocumentText(text: string, maxKeywords = 10): DocumentAnalysis {
  const tokens = tokenize(text);
  const wordCount = tokens.length;

  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    if (STOP_WORDS.has(token)) continue;
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }

  const keywords = Array.from(frequencies.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([token]) => token);

  return {
    keywords,
    wordCount,
    fingerprint: buildShingleHash(text),
  };
}

function hashString(input: string): string {
  // FNV-1a 32-bit → hex. Deterministic across processes; not cryptographic.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Compact fingerprint from sampled shingles — cheap near-duplicate pre-filter.
 * Documents with identical fingerprints are almost certainly duplicates;
 * different fingerprints still need pairwise Jaccard for confirmation.
 */
export function buildShingleHash(text: string): string {
  const sample = text.replace(/\s+/g, ' ').trim().toLowerCase();
  const parts: string[] = [];
  const step = Math.max(1, Math.floor(sample.length / 8));
  for (let i = 0; i < 8; i++) {
    parts.push(hashString(sample.slice(i * step, i * step + 64)));
  }
  return parts.join('');
}

export class DuplicateDetectionService {
  constructor(private readonly db: Database) {}

  /**
   * Find duplicate pairs within one knowledge base using shingle fingerprints
   * as a pre-filter and Jaccard similarity for scoring.
   *
   * @param knowledgeBaseId KB to scan
   * @param threshold       minimum similarity (0–1) to report as duplicate; default 0.9
   * @param limit           max pairs returned; default 50
   */
  async findDuplicates(knowledgeBaseId: string, threshold = 0.9, limit = 50): Promise<DuplicatePair[]> {
    const docRepo = this.db.getRepository('aiKnowledgeBaseDocuments');
    const docs: any[] = await docRepo.find({
      filter: { knowledgeBaseId },
      fields: ['id', 'filename'],
      limit: 500,
    });

    const items: Array<{ id: string; shingles: Set<string> }> = [];
    for (const doc of docs) {
      const data = doc.toJSON ? doc.toJSON() : doc;
      const record = await docRepo.findOne({
        filter: { id: data.id },
        fields: ['id', 'textContent'],
      });
      const text = record?.get?.('textContent') ?? record?.textContent;
      if (typeof text === 'string' && text.trim()) {
        items.push({ id: String(data.id), shingles: buildShingles(text) });
      }
    }

    const pairs: DuplicatePair[] = [];
    for (let i = 0; i < items.length && pairs.length < limit; i++) {
      for (let j = i + 1; j < items.length && pairs.length < limit; j++) {
        const similarity = jaccardSimilarity(items[i].shingles, items[j].shingles);
        if (similarity >= threshold) {
          pairs.push({
            documentId: items[i].id,
            otherDocumentId: items[j].id,
            similarity: Number(similarity.toFixed(4)),
          });
        }
      }
    }

    return pairs.sort((a, b) => b.similarity - a.similarity);
  }
}
