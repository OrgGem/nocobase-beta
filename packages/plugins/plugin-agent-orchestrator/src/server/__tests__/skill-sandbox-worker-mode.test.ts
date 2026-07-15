import { shouldRunSkillSandbox } from '../skill-hub/plugin';

describe('Skill Hub sandbox worker mode', () => {
  it.each([
    [{}, true],
    [{ SKILL_HUB_SANDBOX: 'false' }, false],
    [{ WORKER_MODE: 'main' }, false],
    [{ WORKER_MODE: 'workflow:process' }, false],
    [{ WORKER_MODE: 'skill-hub:sandbox' }, true],
    [{ WORKER_MODE: 'skill-hub.task' }, true],
    [{ WORKER_MODE: '*' }, true],
  ])('evaluates %o as %s', (env, expected) => {
    expect(shouldRunSkillSandbox(env)).toBe(expected);
  });
});
