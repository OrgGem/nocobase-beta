export const DOCKER_REGISTRY_ACTIONS = {
  read: [
    'dockerRegistry:getPublicConfiguration',
    'dockerRegistry:testConnection',
    'dockerRegistry:listRepositories',
    'dockerRegistry:listTags',
    'dockerRegistry:getImageDetails',
  ],
  download: ['dockerRegistry:downloadImage'],
  upload: ['dockerRegistry:uploadImage'],
  delete: [
    'dockerRegistry:getDeleteImpact',
    'dockerRegistry:deleteTag',
    'dockerRegistry:getRepositoryDeleteImpact',
    'dockerRegistry:deleteRepositoryContents',
  ],
  settings: ['dockerRegistry:getSettings', 'dockerRegistry:updateSettings', 'dockerRegistry:testConnectionDraft'],
} as const;

export const DOCKER_REGISTRY_MANAGE_ACTIONS = [...new Set(Object.values(DOCKER_REGISTRY_ACTIONS).flat())];
