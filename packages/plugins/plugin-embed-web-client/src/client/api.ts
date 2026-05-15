export const MAIN_DATA_SOURCE_HEADERS = {
  'x-data-source': 'main',
};

export function mainDataSourceRequest<T extends Record<string, any>>(
  options: T,
): T & { headers: Record<string, any> } {
  return {
    ...options,
    headers: {
      ...options.headers,
      ...MAIN_DATA_SOURCE_HEADERS,
    },
  };
}
