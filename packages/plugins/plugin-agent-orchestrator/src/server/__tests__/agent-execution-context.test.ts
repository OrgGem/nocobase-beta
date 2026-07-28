import { describe, expect, it } from 'vitest';
import { getAgentExecutionContext, runWithAgentExecutionContext } from '../services/AgentExecutionContext';

describe('AgentExecutionContext', () => {
  it('keeps concurrent agent identities isolated across async work', async () => {
    const readIdentity = (employeeUsername: string, delay: number) =>
      runWithAgentExecutionContext({ employeeUsername }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return getAgentExecutionContext()?.employeeUsername;
      });

    await expect(Promise.all([readIdentity('ocr-agent', 5), readIdentity('report-agent', 1)])).resolves.toEqual([
      'ocr-agent',
      'report-agent',
    ]);
    expect(getAgentExecutionContext()).toBeUndefined();
  });
});
