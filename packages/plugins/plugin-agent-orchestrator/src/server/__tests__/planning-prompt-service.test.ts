import { PlanningPromptService } from '../services/PlanningPromptService';

describe('PlanningPromptService', () => {
  it('adds planning instructions as a system message without modifying the user request', () => {
    const service = new PlanningPromptService();
    const messages = [{ role: 'user', content: { type: 'text', content: 'Create a plan for the rollout' } }];

    expect(service.applyPlanningContext(messages)).toBe(true);
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages[1]).toEqual({
      role: 'user',
      content: { type: 'text', content: 'Create a plan for the rollout' },
    });
  });

  it('does not add planning context for a simple request', () => {
    const service = new PlanningPromptService();
    const messages = [{ role: 'user', content: 'Show the current status' }];

    expect(service.applyPlanningContext(messages)).toBe(false);
    expect(messages).toHaveLength(1);
  });
});
