export function maskApiKey(secret: string): string {
  if (!secret) return '';
  if (secret.length < 4) return '*'.repeat(secret.length);

  const maskedLength = Math.ceil(secret.length * 0.7);
  const visibleLength = secret.length - maskedLength;
  const visibleStartLength = Math.ceil(visibleLength / 2);
  const visibleEndLength = visibleLength - visibleStartLength;

  return `${secret.slice(0, visibleStartLength)}${'*'.repeat(maskedLength)}${secret.slice(
    secret.length - visibleEndLength,
  )}`;
}
