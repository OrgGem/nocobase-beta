import type { Context } from '@nocobase/actions';
import { createAIEmployeeOptions } from '../utils/ai-employee-runtime';

describe('AI API agent completions', () => {
  it('creates the object-shaped options required by AIEmployee', () => {
    const ctx = { app: {}, db: {} } as Context;
    const employee = { username: 'support-agent' };

    const options = createAIEmployeeOptions(ctx, employee, 'session-1', {
      llmService: 'internal-deepseek',
      model: 'deepseek-r1',
    });

    expect(options).toEqual({
      ctx,
      employee,
      sessionId: 'session-1',
      webSearch: false,
      model: {
        llmService: 'internal-deepseek',
        model: 'deepseek-r1',
      },
      legacy: false,
    });
  });
});
