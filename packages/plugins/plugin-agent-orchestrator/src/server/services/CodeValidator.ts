interface ForbiddenPattern {
  pattern: RegExp;
  reason: string;
}

const DANGEROUS_NODE_PATTERNS: ForbiddenPattern[] = [
  { pattern: /require\s*\(\s*['"]child_process['"]\s*\)/, reason: 'child_process module not allowed' },
  { pattern: /require\s*\(\s*['"]cluster['"]\s*\)/, reason: 'cluster module not allowed' },
  { pattern: /require\s*\(\s*['"]dgram['"]\s*\)/, reason: 'dgram module not allowed' },
  { pattern: /require\s*\(\s*['"]net['"]\s*\)/, reason: 'net module not allowed' },
  { pattern: /require\s*\(\s*['"]http['"]\s*\)/, reason: 'http module not allowed' },
  { pattern: /require\s*\(\s*['"]https['"]\s*\)/, reason: 'https module not allowed' },
  { pattern: /require\s*\(\s*['"]vm['"]\s*\)/, reason: 'vm module not allowed' },
  { pattern: /require\s*\(\s*['"]worker_threads['"]\s*\)/, reason: 'worker_threads module not allowed' },
  { pattern: /require\s*\(\s*['"]inspector['"]\s*\)/, reason: 'inspector module not allowed' },
  { pattern: /require\s*\(\s*['"]v8['"]\s*\)/, reason: 'v8 module not allowed' },
  { pattern: /process\.exit/, reason: 'process.exit not allowed' },
  { pattern: /process\.env(?!\s*\.OUTPUT_DIR)/, reason: 'process.env access not allowed (use OUTPUT_DIR only)' },
  { pattern: /process\.kill/, reason: 'process.kill not allowed' },
  { pattern: /process\.binding\s*\(/, reason: 'process.binding not allowed' },
  { pattern: /\bglobalThis\b/, reason: 'globalThis access not allowed' },
  // Indirect eval / dynamic Function construction (bypasses the import allowlist).
  { pattern: /\beval\s*\(/, reason: 'eval not allowed' },
  { pattern: /\bnew\s+Function\s*\(/, reason: 'new Function() not allowed' },
  { pattern: /\bFunction\s*\(/, reason: 'Function() constructor not allowed' },
  // Dynamic import() can pull arbitrary modules at runtime, bypassing require() checks.
  { pattern: /\bimport\s*\(/, reason: 'dynamic import() not allowed' },
  // require resolved from a non-literal expression (e.g. require(varName)).
  { pattern: /require\s*\(\s*(?!['"])/, reason: 'require() with a non-literal argument not allowed' },
];

const DANGEROUS_PYTHON_PATTERNS: ForbiddenPattern[] = [
  { pattern: /import\s+subprocess/, reason: 'subprocess module not allowed' },
  { pattern: /from\s+subprocess\s+import/, reason: 'subprocess module not allowed' },
  { pattern: /import\s+shutil/, reason: 'shutil module not allowed' },
  { pattern: /import\s+socket/, reason: 'socket module not allowed' },
  { pattern: /import\s+ctypes/, reason: 'ctypes module not allowed' },
  { pattern: /import\s+pickle/, reason: 'pickle module not allowed' },
  { pattern: /import\s+marshal/, reason: 'marshal module not allowed' },
  { pattern: /import\s+importlib/, reason: 'importlib module not allowed' },
  {
    pattern: /from\s+(?:socket|ctypes|pickle|marshal|importlib)\s+import/,
    reason: 'restricted module import not allowed',
  },
  { pattern: /__import__\s*\(/, reason: '__import__ not allowed' },
  { pattern: /\bimportlib\b/, reason: 'importlib access not allowed' },
  { pattern: /os\.system\s*\(/, reason: 'os.system not allowed' },
  { pattern: /os\.popen\s*\(/, reason: 'os.popen not allowed' },
  { pattern: /os\.exec\w*\s*\(/, reason: 'os.exec* not allowed' },
  { pattern: /os\.spawn\w*\s*\(/, reason: 'os.spawn* not allowed' },
  { pattern: /os\.fork\s*\(/, reason: 'os.fork not allowed' },
  // getattr/setattr can reconstruct blocked names like getattr(os,'sys'+'tem').
  { pattern: /\bgetattr\s*\(/, reason: 'getattr not allowed (can bypass name checks)' },
  { pattern: /\bsetattr\s*\(/, reason: 'setattr not allowed' },
  { pattern: /\b__builtins__\b/, reason: '__builtins__ access not allowed' },
  { pattern: /\beval\s*\(/, reason: 'eval not allowed' },
  { pattern: /\bexec\s*\(/, reason: 'exec not allowed' },
  { pattern: /\bcompile\s*\(/, reason: 'compile not allowed' },
];

/** Built-in Node.js modules that are always allowed in sandbox code */
const NODE_BUILTINS = [
  'fs',
  'path',
  'os',
  'crypto',
  'util',
  'stream',
  'buffer',
  'querystring',
  'url',
  'assert',
  'events',
  'string_decoder',
  'zlib',
];

/** Built-in Python modules that are always allowed in sandbox code */
const PYTHON_BUILTINS = [
  'os',
  'sys',
  'json',
  'math',
  'datetime',
  'collections',
  'itertools',
  'functools',
  'pathlib',
  'typing',
  'io',
  'csv',
  're',
  'string',
  'textwrap',
  'decimal',
  'fractions',
  'random',
  'statistics',
  'runpy',
  'copy',
  'enum',
  'dataclasses',
  'abc',
  'contextlib',
  'operator',
  'time',
  'calendar',
  'locale',
  'struct',
  'hashlib',
  'base64',
  'binascii',
  'codecs',
  'unicodedata',
  'pprint',
  'warnings',
  'traceback',
  'logging',
  'unittest',
  'argparse',
  'ast',
  'tempfile',
  'xml',
  'zipfile',
  // Pre-installed local packages (trusted, bundled with plugin)
  'svg_to_pptx',
];

/**
 * Maps PyPI package names to their Python import names
 * (only where they differ from the package name).
 */
const PYTHON_IMPORT_NAME_MAP: Record<string, string> = {
  'python-docx': 'docx',
  'python-pptx': 'pptx',
  Pillow: 'PIL',
  pyyaml: 'yaml',
};

export class CodeValidator {
  /**
   * Check code against forbidden patterns (dangerous modules/functions).
   * @throws CodeValidationError if a forbidden pattern is found.
   */
  validate(code: string, language: 'node' | 'python'): void {
    const patterns = language === 'node' ? DANGEROUS_NODE_PATTERNS : DANGEROUS_PYTHON_PATTERNS;

    for (const { pattern, reason } of patterns) {
      if (pattern.test(code)) {
        throw new CodeValidationError(reason, pattern.source);
      }
    }
  }

  /**
   * Validate that code only imports packages in the allowlist (builtins +
   * whitelist). Called after the basic forbidden pattern check.
   *
   * An empty whitelist does NOT skip validation: only built-in modules are
   * then allowed. This closes an exfiltration hole — stdlib modules such as
   * Python `urllib`/`socket`/`ftplib` need no install, so skipping the check
   * when the env was not initialized would let a skill open outbound
   * connections. Set SKILL_HUB_ALLOW_ANY_IMPORT=true to restore the old
   * skip-when-empty behaviour for legacy deployments.
   *
   * @param code - The code to validate
   * @param language - 'node' or 'python'
   * @param whitelist - Allowed package names (from skillWorkerConfigs.packageWhitelist)
   */
  validateImports(code: string, language: 'node' | 'python', whitelist: string[]): void {
    if (!whitelist?.length && process.env.SKILL_HUB_ALLOW_ANY_IMPORT === 'true') {
      return;
    }
    const list = whitelist || [];

    if (language === 'node') {
      this.validateNodeImports(code, list);
    } else if (language === 'python') {
      this.validatePythonImports(code, list);
    }
  }

  /**
   * Check Node.js require() calls against the whitelist.
   * Built-in modules (fs, path, etc.) are always allowed.
   */
  private validateNodeImports(code: string, whitelist: string[]): void {
    // Match require statements with string literal arguments (non-relative paths)
    const requires = [...code.matchAll(/require\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g)];

    for (const match of requires) {
      const raw = match[1];
      // Handle scoped packages (e.g. '@org/lib') and subpaths (e.g. 'lib/utils')
      const pkgName = raw.startsWith('@') ? raw.split('/').slice(0, 2).join('/') : raw.split('/')[0];

      if (NODE_BUILTINS.includes(pkgName)) continue;
      if (whitelist.includes(pkgName)) continue;

      throw new CodeValidationError(
        `Package "${pkgName}" is not in the allowed whitelist. Allowed: ${whitelist.join(', ')}`,
        `require('${pkgName}')`,
      );
    }
  }

  /**
   * Check Python import/from statements against the whitelist.
   * Built-in modules (os, sys, json, etc.) are always allowed.
   * Handles PyPI→import name mapping (e.g., python-docx → docx, Pillow → PIL).
   */
  private validatePythonImports(code: string, whitelist: string[]): void {
    // Match: import pkg, from pkg import ..., import pkg.sub
    const imports = [...code.matchAll(/(?:^|\n)\s*(?:import|from)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g)];

    // Build allowed import names from whitelist
    const allowedImports = new Set([...PYTHON_BUILTINS, ...whitelist.map((p) => PYTHON_IMPORT_NAME_MAP[p] || p)]);

    for (const match of imports) {
      const pkg = match[1];
      if (allowedImports.has(pkg)) continue;

      throw new CodeValidationError(
        `Module "${pkg}" is not in the allowed whitelist. Allowed: ${[...allowedImports].join(', ')}`,
        `import ${pkg}`,
      );
    }
  }
}

export class CodeValidationError extends Error {
  constructor(
    message: string,
    public matchedPattern: string,
  ) {
    super(`Code validation failed: ${message}`);
    (this as any).name = 'CodeValidationError';
  }
}
