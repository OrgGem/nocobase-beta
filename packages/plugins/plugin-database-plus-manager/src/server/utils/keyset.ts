export function buildSeekFilter(
  filter: Record<string, unknown>,
  sort: string[],
  values: unknown[],
): Record<string, unknown> {
  if (!values.length) return filter;
  const clauses = sort.map((field, index) => {
    const name = field.replace(/^[+-]/, '');
    const operator = field.startsWith('-') ? '$lt' : '$gt';
    const equalFields = sort.slice(0, index).map((previous, equalIndex) => ({
      [previous.replace(/^[+-]/, '')]: { $eq: values[equalIndex] },
    }));
    return { $and: [...equalFields, { [name]: { [operator]: values[index] } }] };
  });
  return { $and: [filter, { $or: clauses }] };
}
