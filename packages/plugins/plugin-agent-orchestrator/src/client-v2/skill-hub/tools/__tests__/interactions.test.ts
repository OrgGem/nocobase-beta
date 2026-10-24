import { describe, expect, it, vi } from 'vitest';
import {
  buildInteractions,
  editedSkillArgs,
  getToolInteraction,
  loadInteractions,
  parseInteraction,
} from '../interactions';

describe('V2 Skill Hub interactions', () => {
  it('supports legacy fenced/double encoded JSON and validates the review schema', () => {
    const schema = { type: 'form', fields: { approved: { type: 'boolean', enum: [false, true, null, {}] } } };
    const parsed = parseInteraction(JSON.stringify(JSON.stringify(schema)));
    expect(parsed?.fields?.approved.enum).toEqual([false, true]);
    expect(parseInteraction('```json\n{"type":"confirm","prompt":"review"}\n```')?.prompt).toBe('review');
    expect(parseInteraction('{broken')).toBeUndefined();
    expect(parseInteraction({ type: 'unsupported' })).toBeUndefined();
    expect(parseInteraction(null)).toBeUndefined();
  });

  it('honors persisted tool names after skill renames and falls back to the server legacy naming algorithm', () => {
    const map = buildInteractions(
      [
        { id: 1, name: 'Renamed skill', toolName: 'skill_hub_old_name', interactionSchema: { type: 'confirm' } },
        { id: 2, name: ' Other / Skill ', interactionSchema: { type: 'form' } },
        { id: 3, name: '---' },
      ],
      [],
    );
    expect(map.has('skill_hub_old_name')).toBe(true);
    expect(map.has('skill_hub_renamed_skill')).toBe(false);
    expect(map.has('skill_hub_other_skill')).toBe(true);
    expect(map.size).toBe(2);
  });

  it('matches the server newest loop override, prompt inheritance and prompt-only confirmation', () => {
    const map = buildInteractions(
      [
        { id: '9007199254740993', name: 'one', interactionSchema: { type: 'form', prompt: 'legacy' } },
        { id: 2, name: 'two' },
      ],
      [
        {
          skillId: '9007199254740993',
          schema: { type: 'select', options: [{ label: 'Yes', value: 1 }] },
          prompt: 'newest',
        },
        { skillId: '9007199254740993', schema: { type: 'confirm', prompt: 'older' } },
        { skillId: 2, prompt: 'confirm this' },
      ],
    );
    expect(map.get('skill_hub_one')?.schema).toMatchObject({ type: 'select', prompt: 'newest' });
    expect(map.get('skill_hub_two')?.schema).toEqual({ type: 'confirm', prompt: 'confirm this' });
  });

  it('does not apply an execution form to generic list/describe calls and resolves generic execution by exact skill name', () => {
    const map = buildInteractions(
      [{ id: 1, name: 'Renamed Skill', toolName: 'skill_hub_old', interactionSchema: { type: 'form' } }],
      [],
    );
    expect(
      getToolInteraction(map, 'skill_hub_execute', { action: 'list', skillName: 'Renamed Skill' }),
    ).toBeUndefined();
    expect(
      getToolInteraction(map, 'skill_hub_execute', { action: 'describe', skillName: 'Renamed Skill' }),
    ).toBeUndefined();
    expect(getToolInteraction(map, 'skill_hub_execute', { action: 'execute', skillName: 'Renamed Skill' })?.type).toBe(
      'form',
    );
    expect(getToolInteraction(map, 'skill_hub_old', {})?.type).toBe('form');
  });

  it('preserves generic action/name and untouched input fields when editing, including false and zero', () => {
    const args = { action: 'execute', skillName: 'test', input: { unchanged: 42, approved: true } };
    expect(editedSkillArgs('skill_hub_execute', args, { type: 'form' }, { approved: false, count: 0 })).toEqual({
      ...args,
      input: { unchanged: 42, approved: false, count: 0 },
    });
    expect(args.input.approved).toBe(true);
    expect(editedSkillArgs('skill_hub_test', { unchanged: 42 }, { type: 'form' }, { updated: 1 })).toEqual({
      unchanged: 42,
      updated: 1,
    });
    expect(editedSkillArgs('skill_hub_execute', args, { type: 'select' }, { choice: 'yes' })).toEqual({
      ...args,
      input: { choice: 'yes' },
    });
  });

  it('loads all enabled skills with persisted identities and the same loop ordering as the server', async () => {
    const request = vi.fn().mockResolvedValue({ data: { data: [] } });
    await loadInteractions({ request });
    expect(request.mock.calls[0][0].params).toMatchObject({
      fields: ['id', 'name', 'toolName', 'interactionSchema'],
      paginate: false,
    });
    expect(request.mock.calls[1][0].params).toMatchObject({ sort: ['-updatedAt'], paginate: false });
  });

  it('retains legacy review schemas when loop-config access fails, but rejects when skill definitions are unavailable', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { data: [{ id: 1, name: 'legacy', interactionSchema: { type: 'confirm' } }] } })
      .mockRejectedValueOnce(new Error('unavailable'));
    expect((await loadInteractions({ request })).get('skill_hub_legacy')?.schema?.type).toBe('confirm');
    await expect(loadInteractions({ request: vi.fn().mockRejectedValue(new Error('unauthorized')) })).rejects.toThrow(
      'unauthorized',
    );
  });
});
