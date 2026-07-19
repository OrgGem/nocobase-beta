import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'oidcClients',
  title: 'OIDC clients',
  filterTargetKey: 'id',
  fields: [
    { type: 'string', name: 'name', allowNull: false },
    { type: 'string', name: 'clientId', allowNull: false, unique: true, index: true },
    { type: 'string', name: 'clientSecret', length: 512, allowNull: true, hidden: true },
    { type: 'json', name: 'redirectUris', allowNull: false, defaultValue: [] },
    { type: 'json', name: 'postLogoutRedirectUris', allowNull: false, defaultValue: [] },
    { type: 'json', name: 'scopes', allowNull: false, defaultValue: ['openid', 'profile', 'email'] },
    { type: 'string', name: 'clientType', allowNull: false, defaultValue: 'confidential' },
    { type: 'boolean', name: 'allowDynamicLoopbackPort', allowNull: false, defaultValue: false },
    { type: 'string', name: 'tokenEndpointAuthMethod', allowNull: false, defaultValue: 'client_secret_basic' },
    { type: 'boolean', name: 'autoApprove', allowNull: false, defaultValue: false },
    { type: 'boolean', name: 'enabled', allowNull: false, defaultValue: true },
  ],
});
