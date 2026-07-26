export function getErrorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { errors?: { message?: string }[] } }; message?: string };
  return e?.response?.data?.errors?.[0]?.message || e?.message || fallback;
}
