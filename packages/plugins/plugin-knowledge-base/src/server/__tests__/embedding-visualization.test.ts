import { describe, expect, it, vi } from 'vitest';
import { EmbeddingVisualizationService, kMeans, projectTo2d } from '../services/embedding-visualization';

describe('kMeans', () => {
  it('assigns cluster labels for every point', () => {
    const points = [
      { x: 0.0, y: 0.0 },
      { x: 0.1, y: 0.05 },
      { x: 0.9, y: 0.95 },
      { x: 0.85, y: 1.0 },
    ];
    const assignments = kMeans(points, 2);
    expect(assignments).toHaveLength(4);
    expect(new Set(assignments).size).toBeLessThanOrEqual(2);
  });

  it('handles single-point input', () => {
    const assignments = kMeans([{ x: 0.5, y: 0.5 }], 3);
    expect(assignments).toEqual([0]);
  });
});

describe('projectTo2d', () => {
  it('normalizes projections into [0,1] range', () => {
    // Two well-separated clusters in 4D
    const vectors = [
      [1, 0, 0, 0],
      [0.9, 0.1, 0, 0],
      [0, 1, 0, 0],
      [0.1, 0.9, 0, 0],
    ];
    const projected = projectTo2d(vectors);
    expect(projected).toHaveLength(4);
    for (const p of projected) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });
});

describe('EmbeddingVisualizationService.buildVisualization', () => {
  it('reports unavailable gracefully when embedding reader is not configured', async () => {
    const db = {
      getRepository: vi.fn(() => ({
        find: vi.fn(async () => [{ id: 'doc-1', filename: 'a.txt', toJSON() { return this; } }]),
      })),
    } as never;
    const service = new EmbeddingVisualizationService(db);

    const result = await service.buildVisualization('kb-1');

    expect(result.available).toBe(false);
    expect(result.reason).toContain('not enabled');
    expect(result.points).toEqual([]);
  });
});