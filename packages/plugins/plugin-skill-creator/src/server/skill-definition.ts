export const SKILL_CREATOR_SKILL = {
  name: 'create-skill',
  title: 'Create Skill Hub Skill',
  description:
    'Create a new executable Skill Hub skill from an AI-generated specification and install it into plugin-agent-orchestrator Skill Hub. ' +
    'Use when a user asks an AI Employee to create a reusable capability/tool/skill, for example a reporting skill, CRM export skill, data cleanup skill, or document generation skill. ' +
    'The caller must provide the final skill name, purpose, JSON input schema, language, code template, and optional smoke-test input. ' +
    'This skill validates metadata, JSON schema, unsafe Python/Node patterns, Python syntax, and generated package structure before asking Skill Hub to auto-install it.',
  language: 'python' as const,
  inputSchema: {
    type: 'object',
    properties: {
      skill_name: {
        type: 'string',
        description: 'Lowercase skill id using letters, numbers, and hyphens, e.g. generate-sales-report',
      },
      title: { type: 'string', description: 'Human readable skill title' },
      purpose: { type: 'string', description: 'What the generated skill should accomplish and when AI should use it' },
      description: { type: 'string', description: 'Tool description shown to AI employees. Defaults to purpose.' },
      language: { type: 'string', enum: ['python', 'node'], description: 'Runtime language for the generated skill' },
      code: {
        type: 'string',
        description:
          'Complete generated skill code template. Use {{field}} placeholders or {{field_b64}} placeholders matching input_schema properties.',
      },
      input_schema: {
        type: 'object',
        description: 'JSON Schema object for the generated skill input arguments',
      },
      packages: {
        type: 'array',
        items: { type: 'string' },
        description: 'Python or Node packages required by the generated skill',
      },
      instructions: {
        type: 'string',
        description: 'Optional SKILL.md workflow instructions for AI employees using the generated skill',
      },
      test_input: {
        type: 'object',
        description: 'Optional smoke-test arguments used for placeholder coverage checks',
      },
      timeout_seconds: { type: 'number', description: 'Execution timeout for generated skill. Default 60.' },
      max_output_size_mb: { type: 'number', description: 'Output size limit for generated skill. Default 50.' },
      overwrite: {
        type: 'boolean',
        description: 'Whether Skill Hub should update an existing skill with the same name. Default true.',
      },
    },
    required: ['skill_name', 'purpose', 'language', 'code', 'input_schema'],
  },
  packages: [],
  timeoutSeconds: 30,
  maxOutputSizeMb: 5,
  enabled: true,
  toolScope: 'CUSTOM',
};
