// SPDX-License-Identifier: Apache-2.0

export default {
  name: 'startupGuardianClusterMembers',
  hidden: true,
  autoGenId: true,
  createdAt: false,
  updatedAt: false,
  indexes: [{ unique: true, fields: ['appId', 'deploymentId', 'nodeId'] }],
  fields: [
    { name: 'appId', type: 'string', length: 120, allowNull: false },
    { name: 'deploymentId', type: 'string', length: 120, allowNull: false },
    { name: 'nodeId', type: 'string', length: 120, allowNull: false },
    { name: 'bootId', type: 'string', length: 80, allowNull: true },
    { name: 'coreVersion', type: 'string', length: 40, allowNull: true },
    { name: 'protocolVersion', type: 'integer', allowNull: false },
    { name: 'state', type: 'string', length: 32, allowNull: false },
    { name: 'acknowledgedRevision', type: 'integer', defaultValue: 0, allowNull: false },
    { name: 'appliedRevision', type: 'integer', defaultValue: 0, allowNull: false },
    { name: 'lastHeartbeatAt', type: 'date', allowNull: true },
    { name: 'incident', type: 'json', allowNull: true },
  ],
};
