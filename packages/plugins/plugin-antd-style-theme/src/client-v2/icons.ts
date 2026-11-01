export const ICON_GROUPS = ['Outlined', 'Filled', 'Two tone', 'Material', 'Bootstrap'] as const;
export function getIconGroup(name: string): (typeof ICON_GROUPS)[number] | undefined {
  const key = name.toLowerCase();
  if (key.endsWith('outlined')) return 'Outlined';
  if (key.endsWith('filled')) return 'Filled';
  if (key.endsWith('twotone')) return 'Two tone';
  if (key.startsWith('md')) return 'Material';
  if (key.startsWith('bs')) return 'Bootstrap';
}
