import { describe, expect, it } from 'vitest';
import { createEnvGetter, isEnvTemplate, resolveEnvValue } from '../services/resolve-env';

const vars: Record<string, string> = {
  CRYPTO_TEST_KEY: '-----BEGIN PUBLIC KEY-----abc-----END PUBLIC KEY-----',
  CRYPTO_TEST_NAME: 'partner-a',
};

const getVar = (name: string) => vars[name];

describe('resolveEnvValue', () => {
  it('resolves {{$env.VAR}} mustache syntax', () => {
    expect(resolveEnvValue('{{$env.CRYPTO_TEST_NAME}}', getVar)).toBe('partner-a');
    expect(resolveEnvValue('{{ $env.CRYPTO_TEST_NAME }}', getVar)).toBe('partner-a');
  });

  it('resolves templates embedded in longer strings', () => {
    expect(resolveEnvValue('key of {{$env.CRYPTO_TEST_NAME}}!', getVar)).toBe('key of partner-a!');
  });

  it('resolves multiline key material', () => {
    expect(resolveEnvValue('{{$env.CRYPTO_TEST_KEY}}', getVar)).toContain('BEGIN PUBLIC KEY');
  });

  it('leaves unknown variables untouched', () => {
    expect(resolveEnvValue('{{$env.NOT_DEFINED_VAR}}', getVar)).toBe('{{$env.NOT_DEFINED_VAR}}');
  });

  it('passes through non-template values, null and undefined', () => {
    expect(resolveEnvValue('plain-value', getVar)).toBe('plain-value');
    expect(resolveEnvValue(null, getVar)).toBeNull();
    expect(resolveEnvValue(undefined, getVar)).toBeUndefined();
  });
});

describe('isEnvTemplate', () => {
  it('detects env templates', () => {
    expect(isEnvTemplate('{{$env.SOME_VAR}}')).toBe(true);
    expect(isEnvTemplate('prefix {{ $env.SOME_VAR }} suffix')).toBe(true);
  });

  it('rejects plain values', () => {
    expect(isEnvTemplate('SOME_VAR')).toBe(false);
    expect(isEnvTemplate(null)).toBe(false);
    expect(isEnvTemplate('')).toBe(false);
  });
});

describe('createEnvGetter', () => {
  it('reads from the app environment service first', () => {
    const app = { environment: { getVariable: (n: string) => (n === 'FROM_APP' ? 'app-value' : undefined) } };
    const getter = createEnvGetter(app);
    expect(getter('FROM_APP')).toBe('app-value');
  });

  it('reads from getVariables() map (real NocoBase Environment shape)', () => {
    // The real Environment class exposes getVariables() returning a name->value map,
    // not getVariable(name). DB-stored secret env vars must resolve through this path.
    const app = {
      environment: {
        getVariables: () => ({ CRYPTO_TOOLKIT_KEY_PRIVATE: '-----BEGIN PGP PRIVATE KEY BLOCK-----' }),
      },
    };
    const getter = createEnvGetter(app);
    expect(getter('CRYPTO_TOOLKIT_KEY_PRIVATE')).toBe('-----BEGIN PGP PRIVATE KEY BLOCK-----');
    expect(getter('MISSING_VAR')).toBeUndefined();
  });

  it('prefers getVariable() over getVariables() when both exist', () => {
    const app = {
      environment: {
        getVariable: (n: string) => (n === 'X' ? 'from-getVariable' : undefined),
        getVariables: () => ({ X: 'from-getVariables' }),
      },
    };
    const getter = createEnvGetter(app);
    expect(getter('X')).toBe('from-getVariable');
  });

  it('falls back to process.env', () => {
    process.env.CRYPTO_TOOLKIT_TEST_FALLBACK = 'process-value';
    const getter = createEnvGetter({});
    expect(getter('CRYPTO_TOOLKIT_TEST_FALLBACK')).toBe('process-value');
    delete process.env.CRYPTO_TOOLKIT_TEST_FALLBACK;
  });

  it('returns undefined when the variable is missing everywhere', () => {
    const getter = createEnvGetter({});
    expect(getter('CRYPTO_TOOLKIT_TEST_MISSING')).toBeUndefined();
  });
});
