import { afterEach, describe, expect, it } from 'vitest';
import { CodeValidator, CodeValidationError } from '../services/CodeValidator';

const validator = new CodeValidator();

describe('CodeValidator.validate — dangerous patterns', () => {
  it('blocks node child_process and dynamic require', () => {
    expect(() => validator.validate(`require('child_process')`, 'node')).toThrow(CodeValidationError);
    expect(() => validator.validate(`const m = 'fs'; require(m);`, 'node')).toThrow(CodeValidationError);
  });

  it('blocks node indirect eval / Function constructor / dynamic import', () => {
    expect(() => validator.validate(`eval('1+1')`, 'node')).toThrow(CodeValidationError);
    expect(() => validator.validate(`new Function('return 1')()`, 'node')).toThrow(CodeValidationError);
    expect(() => validator.validate(`import('fs')`, 'node')).toThrow(CodeValidationError);
    expect(() => validator.validate(`process.binding('spawn_sync')`, 'node')).toThrow(CodeValidationError);
  });

  it('blocks python subprocess / socket / importlib / getattr bypass', () => {
    expect(() => validator.validate(`import subprocess`, 'python')).toThrow(CodeValidationError);
    expect(() => validator.validate(`import socket`, 'python')).toThrow(CodeValidationError);
    expect(() => validator.validate(`import importlib`, 'python')).toThrow(CodeValidationError);
    expect(() => validator.validate(`getattr(os, 'sys' + 'tem')('id')`, 'python')).toThrow(CodeValidationError);
    expect(() => validator.validate(`__import__('os')`, 'python')).toThrow(CodeValidationError);
  });

  it('allows benign code', () => {
    expect(() => validator.validate(`const fs = require('fs'); fs.writeFileSync('x', '1');`, 'node')).not.toThrow();
    expect(() => validator.validate(`import json\nprint(json.dumps({'a': 1}))`, 'python')).not.toThrow();
  });
});

describe('CodeValidator.validateImports — allowlist', () => {
  afterEach(() => {
    delete process.env.SKILL_HUB_ALLOW_ANY_IMPORT;
  });

  it('blocks stdlib network modules even when whitelist is empty (exfiltration hole)', () => {
    // urllib / ftplib are stdlib (no install needed) and must NOT pass on empty whitelist.
    expect(() => validator.validateImports(`import urllib.request`, 'python', [])).toThrow(CodeValidationError);
    expect(() => validator.validateImports(`import ftplib`, 'python', [])).toThrow(CodeValidationError);
  });

  it('allows builtins on empty whitelist', () => {
    expect(() => validator.validateImports(`import json`, 'python', [])).not.toThrow();
  });

  it('allows whitelisted package and maps PyPI→import name', () => {
    expect(() => validator.validateImports(`import requests`, 'python', ['requests'])).not.toThrow();
    expect(() => validator.validateImports(`from docx import Document`, 'python', ['python-docx'])).not.toThrow();
  });

  it('blocks non-whitelisted node package but allows builtins', () => {
    expect(() => validator.validateImports(`require('lodash')`, 'node', [])).toThrow(CodeValidationError);
    expect(() => validator.validateImports(`require('lodash')`, 'node', ['lodash'])).not.toThrow();
    expect(() => validator.validateImports(`require('path')`, 'node', [])).not.toThrow();
  });

  it('honours SKILL_HUB_ALLOW_ANY_IMPORT escape hatch on empty whitelist', () => {
    process.env.SKILL_HUB_ALLOW_ANY_IMPORT = 'true';
    expect(() => validator.validateImports(`import urllib.request`, 'python', [])).not.toThrow();
  });
});
