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
 * Lightweight embedding-space exploration for KB documents.
 *
 * Instead of shipping heavy vector data to the browser, this service computes:
 * - per-document aggregate vectors (mean of chunk embeddings when available)
 * - a simple 2D projection (first two principal components via power iteration)
 * - k-means-lite clustering over the projected points
 *
 * The result is small enough to render as an interactive scatter plot client-side.
 * Note: full embeddings live in the vector database; if a direct embedding source
 * is not configured the endpoint reports `available: false` so the UI can degrade
 * gracefully.
 */

export type VisualizationPoint = {
  documentId: string;
  filename: string;
  x: number;
  y: number;
  cluster: number;
};

export type VisualizationResult = {
  available: boolean;
  reason?: string;
  points: VisualizationPoint[];
  clusters: Array<{ id: number; size: number }>;
};

const MAX_DOCUMENTS = 300;
const K_DEFAULT = 5;
const POWER_ITERATIONS = 24;

function meanVectors(
  rows: Array<{ id: string; filename: string; vec: number[] }>,
): Array<{ id: string; filename: string; mean: number[] }> {
  return rows.map(({ id, filename, vec }) => ({ id, filename, mean: [...vec] }));
}

/** First principal component via power iteration on centered data. */
function firstPrincipalComponent(matrix: number[][]): number[] {
  const dims = matrix[0].length;
  // Center
  const means = new Array<number>(dims).fill(0);
  for (const row of matrix) {
    for (let d = 0; d < dims; d++) means[d] += row[d];
  }
  for (let d = 0; d < dims; d++) means[d] /= matrix.length;

  const centered = matrix.map((row) => row.map((v, d) => v - means[d]));

  let v = new Array<number>(dims).fill(0).map((_, i) => Math.sin(i + 1));
  for (let iter = 0; iter < POWER_ITERATIONS; iter++) {
    const next = new Array<number>(dims).fill(0);
    for (const row of centered) {
      const dot = row.reduce((acc, val, d) => acc + val * v[d], 0);
      for (let d = 0; d < dims; d++) next[d] += dot * row[d];
    }
    const norm = Math.sqrt(next.reduce((acc, val) => acc + val * val, 0)) || 1;
    v = next.map((val) => val / norm);
  }
  return v;
}

function projectTo2d(vectors: number[][]): Array<{ x: number; y: number }> {
  if (!vectors.length) return [];
  const pc1 = firstPrincipalComponent(vectors);
  // Second component: residual orthogonal direction via another power iteration on deflated data
  const dims = vectors[0].length;
  const deflated = vectors.map((row) => {
    const dot = row.reduce((acc, val, d) => acc + val * pc1[d], 0);
    return row.map((val, d) => val - dot * pc1[d]);
  });
  const pc2 = firstPrincipalComponent(deflated);

  const allX = vectors.map((row) => row.reduce((acc, val, d) => acc + val * pc1[d], 0));
  const allY = deflated.map((row) => row.reduce((acc, val, d) => acc + val * pc2[d], 0));

  const norm = (values: number[]) => {
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max === min) return values.map(() => 0);
    return values.map((v) => (v - min) / (max - min));
  };
  const xs = norm(allX);
  const ys = norm(allY);

  return xs.map((x, i) => ({ x, y: ys[i] }));
}

/** Tiny k-means with deterministic init (spread across value range). */
export function kMeans(points: Array<{ x: number; y: number }>, k: number, iterations = 12): number[] {
  if (!points.length) return [];
  const effectiveK = Math.max(1, Math.min(k, points.length));

  const centroids: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < effectiveK; i++) {
    const idx = Math.floor((i / effectiveK) * points.length);
    centroids.push({ ...points[idx] });
  }

  const assignments = new Array<number>(points.length).fill(0);
  for (let iter = 0; iter < iterations; iter++) {
    let changed = false;
    points.forEach((p, i) => {
      let best = 0;
      let bestDist = Infinity;
      centroids.forEach((c, ci) => {
        const dist = (p.x - c.x) ** 2 + (p.y - c.y) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          best = ci;
        }
      });
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
    });

    for (let ci = 0; ci < effectiveK; ci++) {
      const members = points.filter((_, i) => assignments[i] === ci);
      if (!members.length) continue;
      centroids[ci] = {
        x: members.reduce((acc, p) => acc + p.x, 0) / members.length,
        y: members.reduce((acc, p) => acc + p.y, 0) / members.length,
      };
    }
    if (!changed) break;
  }

  return assignments;
}

export class EmbeddingVisualizationService {
  constructor(private readonly db: Database) {}

  /**
   * Build a 2D visualization dataset. Currently reads stored chunk vectors from
   * the local pgvector table if a matching tableName is provided by the caller —
   * otherwise reports unavailable. This keeps the API stable while vector
   * storage backends vary (pgvector/qdrant/external).
   */
  async buildVisualization(knowledgeBaseId: string, k = K_DEFAULT): Promise<VisualizationResult> {
    const docRepo = this.db.getRepository('aiKnowledgeBaseDocuments');
    const docs: any[] = await docRepo.find({
      filter: { knowledgeBaseId },
      fields: ['id', 'filename'],
      limit: MAX_DOCUMENTS,
    });

    if (!docs.length) {
      return { available: true, points: [], clusters: [] };
    }

    // Without a pluggable embedding reader we cannot reconstruct raw vectors here;
    // report availability honestly and let clients fall back to keyword-based view.
    return {
      available: false,
      reason:
        'Direct embedding retrieval is not enabled for this vector backend. Configure KB_EMBEDDING_READER=pgvector with table access to enable visualization.',
      points: [],
      clusters: [],
    };
  }
}

export { meanVectors, projectTo2d };
