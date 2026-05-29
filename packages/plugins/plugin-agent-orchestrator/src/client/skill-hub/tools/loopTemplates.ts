export type InteractionSchema = {
  type: 'form' | 'select' | 'confirm';
  prompt: string;
  options?: { label: string; value: string | number }[];
  fields?: Record<string, { type?: string; title?: string; required?: boolean; enum?: any[] }>;
};

export type LoopTemplate = {
  key: string;
  title: string;
  description: string;
  schema: InteractionSchema;
};

export const LOOP_TEMPLATES: LoopTemplate[] = [
  {
    key: 'confirm',
    title: 'Confirm before run',
    description: 'Ask the user to approve or cancel the skill call.',
    schema: {
      type: 'confirm',
      prompt: 'Review this skill call before execution.',
    },
  },
  {
    key: 'review-input',
    title: 'Review editable input',
    description: 'Show selected input fields so the user can edit them before running.',
    schema: {
      type: 'form',
      prompt: 'Review and edit the skill input before execution.',
      fields: {},
    },
  },
  {
    key: 'choose-option',
    title: 'Choose one option',
    description: 'Ask the user to choose one option before running.',
    schema: {
      type: 'select',
      prompt: 'Choose how to run this skill.',
      options: [
        { label: 'Default', value: 'default' },
        { label: 'Careful', value: 'careful' },
      ],
    },
  },
];

export function getLoopTemplate(key?: string) {
  return LOOP_TEMPLATES.find((template) => template.key === key) || LOOP_TEMPLATES[0];
}
