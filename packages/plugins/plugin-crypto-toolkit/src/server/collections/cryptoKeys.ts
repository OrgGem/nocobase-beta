import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'cryptoKeys',
  title: 'Crypto Keys',
  createdBy: true,
  updatedBy: true,
  fields: [
    {
      type: 'string',
      name: 'name',
      allowNull: false,
      unique: true,
      interface: 'input',
      uiSchema: {
        title: 'Name',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'string',
      name: 'displayName',
      interface: 'input',
      uiSchema: {
        title: 'Display Name',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'string',
      name: 'kind',
      allowNull: false,
      interface: 'select',
      uiSchema: {
        title: 'Kind',
        type: 'string',
        'x-component': 'Select',
        enum: [
          { value: 'pgp-rsa4096', label: 'PGP (RSA 4096)' },
          { value: 'pgp-curve25519', label: 'PGP (Curve25519)' },
          { value: 'rsa-4096', label: 'RSA 4096' },
          { value: 'ed25519', label: 'Ed25519' },
          { value: 'ssh-ed25519', label: 'SSH (Ed25519)' },
          { value: 'ssh-rsa', label: 'SSH (RSA 4096)' },
        ],
      },
    },
    {
      type: 'string',
      name: 'direction',
      allowNull: false,
      defaultValue: 'own',
      interface: 'select',
      uiSchema: {
        title: 'Direction',
        type: 'string',
        'x-component': 'Select',
        enum: [
          { value: 'own', label: 'Own key' },
          { value: 'partner', label: 'Partner key' },
        ],
      },
    },
    {
      type: 'string',
      name: 'purpose',
      defaultValue: 'both',
      interface: 'select',
      uiSchema: {
        title: 'Purpose',
        type: 'string',
        'x-component': 'Select',
        enum: [
          { value: 'encrypt', label: 'Encrypt' },
          { value: 'sign', label: 'Sign' },
          { value: 'both', label: 'Encrypt & Sign' },
        ],
      },
    },
    {
      type: 'string',
      name: 'fingerprint',
      interface: 'input',
      uiSchema: {
        title: 'Fingerprint (SHA-256)',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'text',
      name: 'publicMaterial',
      allowNull: false,
      interface: 'textarea',
      uiSchema: {
        title: 'Public Key Material',
        type: 'string',
        'x-component': 'Input.TextArea',
      },
    },
    {
      type: 'string',
      name: 'publicFormat',
      allowNull: false,
      defaultValue: 'pem',
      interface: 'select',
      uiSchema: {
        title: 'Public Format',
        type: 'string',
        'x-component': 'Select',
        enum: [
          { value: 'pem', label: 'PEM' },
          { value: 'openpgp', label: 'OpenPGP (armored)' },
          { value: 'openssh', label: 'OpenSSH' },
        ],
      },
    },
    {
      type: 'string',
      name: 'privateEnvVar',
      interface: 'input',
      uiSchema: {
        title: 'Private Key Env Variable',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'text',
      name: 'notes',
      interface: 'textarea',
      uiSchema: {
        title: 'Notes',
        type: 'string',
        'x-component': 'Input.TextArea',
      },
    },
    {
      type: 'boolean',
      name: 'enabled',
      defaultValue: true,
      interface: 'checkbox',
      uiSchema: {
        title: 'Enabled',
        type: 'boolean',
        'x-component': 'Checkbox',
      },
    },
  ],
});
