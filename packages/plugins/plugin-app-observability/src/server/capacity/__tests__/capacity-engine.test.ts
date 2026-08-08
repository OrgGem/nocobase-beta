import { describe, expect, it } from 'vitest';

import { assessCapacity } from '../capacity-engine';

describe('assessCapacity', () => {
  it('identifies the most saturated reliable signal', () => {
    const assessment = assessCapacity({
      cpuPercent: 92,
      memoryPercent: 50,
      eventLoopUtilizationPercent: 40,
      eventLoopDelayP99Ms: 10,
    });
    expect(assessment.state).toBe('critical');
    expect(assessment.constrainingSignal).toBe('cpu');
    expect(assessment.confidence).toBeGreaterThan(0.5);
  });

  it('does not treat missing data as zero utilization', () => {
    const assessment = assessCapacity({ cpuPercent: null, memoryPercent: null, eventLoopUtilizationPercent: null });
    expect(assessment.state).toBe('watch');
    expect(assessment.confidence).toBeLessThan(0.5);
    expect(assessment.evidence[0].key).toContain('Insufficient');
  });
});
