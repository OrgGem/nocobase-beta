import { describe, expect, it } from 'vitest';
import aiKnowledgeBase from '../resources/ai-knowledge-base';

describe('aiKnowledgeBase resource', () => {
  it('exposes addDocument as a public resource action', () => {
    expect(aiKnowledgeBase.actions.addDocument).toEqual(expect.any(Function));
  });
});
