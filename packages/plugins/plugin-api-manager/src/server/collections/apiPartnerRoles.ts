import { defineCollection } from '@nocobase/database';

/**
 * Associates NocoBase roles with a plugin Partner. A role bound to a partner
 * inherits the partner's route access: requests authenticated with that role
 * (app Bearer token) may only call routes belonging to the same partner.
 *
 * Composite unique keeps (partner, role) 1:1 so a role belongs to one partner.
 */
export default defineCollection({
  name: 'apiPartnerRoles',
  title: 'API Partner Roles',
  createdAt: true,
  updatedAt: true,
  indexes: [
    {
      unique: true,
      fields: ['partnerId', 'roleName'],
    },
  ],
  fields: [
    {
      type: 'bigInt',
      name: 'partnerId',
      allowNull: false,
      index: true,
    },
    {
      type: 'belongsTo',
      name: 'partner',
      target: 'apiPartners',
      foreignKey: 'partnerId',
    },
    {
      type: 'string',
      name: 'roleName',
      allowNull: false,
      index: true,
      interface: 'input',
      uiSchema: {
        title: 'Role',
        type: 'string',
        'x-component': 'Input',
      },
    },
  ],
});
