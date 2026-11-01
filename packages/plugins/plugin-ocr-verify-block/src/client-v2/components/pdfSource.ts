export function getPdfSource(url: string, origin: string, headers: Record<string, string>) {
  const resolved = new URL(url, origin);
  const local = resolved.origin === origin;
  return { url: resolved.href, httpHeaders: local ? headers : undefined, withCredentials: local };
}
