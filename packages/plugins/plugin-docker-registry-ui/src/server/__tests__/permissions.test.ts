import { describe, expect, it } from 'vitest';
import { DOCKER_REGISTRY_ACTIONS, DOCKER_REGISTRY_MANAGE_ACTIONS } from '../permissions';

describe('Docker Registry server permissions', () => {
  it('keeps transfer and delete capabilities independent', () => {
    expect(DOCKER_REGISTRY_ACTIONS.download).toEqual(['dockerRegistry:downloadImage']);
    expect(DOCKER_REGISTRY_ACTIONS.upload).toEqual(['dockerRegistry:uploadImage']);
    expect(DOCKER_REGISTRY_ACTIONS.delete).toEqual([
      'dockerRegistry:getDeleteImpact',
      'dockerRegistry:deleteTag',
      'dockerRegistry:getRepositoryDeleteImpact',
      'dockerRegistry:deleteRepositoryContents',
    ]);
    expect(DOCKER_REGISTRY_ACTIONS.settings).toEqual([
      'dockerRegistry:getSettings',
      'dockerRegistry:updateSettings',
      'dockerRegistry:testConnectionDraft',
    ]);
  });

  it('builds manage from concrete actions instead of snippet names', () => {
    const concreteActions = Object.values(DOCKER_REGISTRY_ACTIONS).flat();
    expect(new Set(DOCKER_REGISTRY_MANAGE_ACTIONS)).toEqual(new Set(concreteActions));
    expect(DOCKER_REGISTRY_MANAGE_ACTIONS.some((action) => action.startsWith('pm.'))).toBe(false);
  });
});
