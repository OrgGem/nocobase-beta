import { describe, expect, it } from 'vitest';
import { calculateLlmCost, type PriceSnapshot } from '../billing';

function price(values: Partial<PriceSnapshot> = {}): PriceSnapshot {
  return {
    id: 1,
    currency: 'USD',
    inputPricePerMillionTokens: '5.0000000000',
    outputPricePerMillionTokens: '15.0000000000',
    fixedCostPerRequest: '0.0000000000',
    ...values,
  };
}

describe('AI API LLM cost calculation', () => {
  it('calculates input and output token cost using decimal arithmetic', () => {
    expect(calculateLlmCost(10_000, 2_000, price())).toBe('0.08000000');
  });

  it('includes a fixed per-request cost', () => {
    expect(calculateLlmCost(0, 0, price({ fixedCostPerRequest: '0.1250000000' }))).toBe('0.12500000');
  });

  it('rounds to eight decimal places without floating-point drift', () => {
    expect(
      calculateLlmCost(
        1,
        1,
        price({ inputPricePerMillionTokens: '0.1000000000', outputPricePerMillionTokens: '0.2000000000' }),
      ),
    ).toBe('0.00000030');
  });
});
