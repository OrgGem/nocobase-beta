const ENV_TEMPLATE_RE = /\{\{\s*\$env\.([a-zA-Z0-9_]+)\s*\}\}/g;

export type EnvVariableGetter = (name: string) => string | undefined;

/**
 * Expand `{{$env.NAME}}` references. Only the braced syntax is supported so
 * literal values can never be partially rewritten; unknown variables are left
 * untouched.
 */
export function resolveEnvValue(
  val: string | null | undefined,
  getEnvVal: EnvVariableGetter,
): string | null | undefined {
  if (!val || typeof val !== 'string') return val;
  return val.replace(ENV_TEMPLATE_RE, (match, name) => getEnvVal(name) ?? match);
}

export function isEnvTemplate(val: string | null | undefined): boolean {
  if (!val || typeof val !== 'string') return false;
  return new RegExp(ENV_TEMPLATE_RE.source).test(val);
}

export function createEnvGetter(app: unknown): EnvVariableGetter {
  return (name: string) => {
    const envService = (app as { environment?: { getVariable?: (n: string) => unknown } }).environment;
    const value = envService?.getVariable?.(name);
    if (value != null) return String(value);
    const fromProcess = process.env[name];
    return fromProcess == null ? undefined : fromProcess;
  };
}
