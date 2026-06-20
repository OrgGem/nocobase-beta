import { describe, expect, it } from 'vitest';
import { normalizeAIEmployeeSkillSettings } from '../utils/skill-settings';

describe('normalizeAIEmployeeSkillSettings', () => {
  it('removes retired orchestrator plan tool bindings from skills', () => {
    const result = normalizeAIEmployeeSkillSettings({
      skills: [{ name: 'orchestrator_plan_goal', autoCall: false }, 'crm-research'],
      tools: [],
    });

    expect(result.changed).toBe(true);
    expect(result.skillSettings.skills).toEqual(['crm-research']);
    expect(result.skillSettings.tools).toEqual([]);
  });

  it('removes retired delegate tool names stored as skill strings', () => {
    const result = normalizeAIEmployeeSkillSettings({
      skills: ['delegate_lead_to_researcher', 'crm-research'],
    });

    expect(result.changed).toBe(true);
    expect(result.skillSettings.skills).toEqual(['crm-research']);
    expect(result.skillSettings.tools).toEqual([]);
  });

  it('removes retired dispatch tool bindings from current tools', () => {
    const result = normalizeAIEmployeeSkillSettings({
      skills: [{ name: 'dispatch_subagents_lead', autoCall: true }],
      tools: [{ name: 'dispatch_subagents_lead', autoCall: false }],
    });

    expect(result.changed).toBe(true);
    expect(result.skillSettings.skills).toEqual([]);
    expect(result.skillSettings.tools).toEqual([]);
  });

  it('moves browser and drawio tools stored as skill strings to tools', () => {
    const result = normalizeAIEmployeeSkillSettings({
      skills: ['browser_open_url', 'drawio-edit-diagram', 'crm-research'],
    });

    expect(result.changed).toBe(true);
    expect(result.skillSettings.skills).toEqual(['crm-research']);
    expect(result.skillSettings.tools).toEqual([
      { name: 'browser_open_url', autoCall: false },
      { name: 'drawio-edit-diagram', autoCall: false },
    ]);
  });

  it('moves Skill Hub tool bindings from skills to tools', () => {
    const result = normalizeAIEmployeeSkillSettings({
      skills: ['skill_hub_execute', { name: 'skill_hub_generate_report', autoCall: true }],
      tools: [],
    });

    expect(result.changed).toBe(true);
    expect(result.skillSettings.skills).toEqual([]);
    expect(result.skillSettings.tools).toEqual([
      { name: 'skill_hub_execute', autoCall: false },
      { name: 'skill_hub_generate_report', autoCall: true },
    ]);
  });
});
