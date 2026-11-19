/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { lstatSync, readFileSync, readdirSync, realpathSync } from 'fs';
import { createRequire } from 'module';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'path';
import { Script } from 'vm';
import {
  parse,
  type CallExpression,
  type ExpressionStatement,
  type FunctionExpression,
  type Identifier,
  type MemberExpression,
} from 'acorn';
import { fullAncestor } from 'acorn-walk';
import { CodeValidator } from '../../services/CodeValidator';

export function registryNodeWrapper(entrypoint: string): string {
  return `require(${JSON.stringify(`./skill/${entrypoint}`)});\n`;
}

export function registryNodeEntrypoint(template: string, translate: (message: string) => string): string | null {
  const legacy = template.match(
    /^require\(require\('path'\)\.join\(process\.env\.SKILL_DIR, ("(?:[^"\\]|\\.)*")\)\);\s*$/,
  );
  const current = template.match(/^require\(("(?:[^"\\]|\\.)*")\);\s*$/);
  if (!legacy && !current) return null;
  let path: string;
  try {
    path = JSON.parse((legacy || current)[1]) as string;
  } catch {
    throw new Error(translate('Registry Node package requires must stay inside the package.'));
  }
  if (current && !path.startsWith('./skill/')) return null;
  const entrypoint = current ? path.slice('./skill/'.length) : path;
  if (
    !entrypoint ||
    /[\\:\0]/.test(entrypoint) ||
    entrypoint.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(translate('Registry Node package requires must stay inside the package.'));
  }
  return entrypoint;
}

/** Validate the copied package's reachable CommonJS modules before the sandbox loads them. */
export function validateRegistryNodePackage(
  code: string,
  workDir: string,
  packageDir: string,
  whitelist: string[],
  translate: (message: string) => string,
): void {
  const fail: (message: string) => never = (message) => {
    throw new Error(translate(message));
  };
  const packageRoot = realpathSync(packageDir);
  const workRoot = realpathSync(workDir);
  const checkDirectory = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail('Registry Node packages cannot contain symbolic links or bundled node_modules.');
      }
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === 'node_modules') {
          fail('Registry Node packages cannot contain symbolic links or bundled node_modules.');
        }
        checkDirectory(path);
      }
    }
  };
  if (!lstatSync(packageDir).isDirectory()) {
    fail('Registry Node package requires must stay inside the package.');
  }
  checkDirectory(packageDir);

  const validator = new CodeValidator();
  const visited = new Set<string>();
  const visit = (source: string, filename: string) => {
    validator.validate(source, 'node', { allowSkillInputFile: filename !== resolve(workRoot, 'script.js') });
    validator.validateImports(source, 'node', whitelist);
    let wrapper: FunctionExpression;
    try {
      const commonJsSource = source.replace(/^\uFEFF/, '').replace(/^#![^\r\n]*/, '');
      const wrappedSource = `(function(exports, require, module, __filename, __dirname) {\n${commonJsSource}\n});`;
      new Script(wrappedSource);
      const parsed = parse(wrappedSource, { ecmaVersion: 'latest' });
      wrapper = (parsed.body[0] as ExpressionStatement).expression as FunctionExpression;
    } catch {
      fail('Registry Node packages must use valid CommonJS code and cannot load native modules.');
    }

    const entrypoint = filename === resolve(workRoot, 'script.js') ? registryNodeEntrypoint(source, translate) : null;
    const requests: string[] = [];
    const requireError = 'Registry Node packages must use direct require calls with literal, unescaped paths.';
    fullAncestor(wrapper.body, (node, _state, ancestors) => {
      if (node.type === 'Identifier') {
        const identifier = node as Identifier;
        const parent = ancestors[ancestors.length - 2];
        if (identifier.name === 'require') {
          const call = parent as CallExpression;
          if (parent?.type !== 'CallExpression' || call.callee !== node || call.optional) fail(requireError);
        }
        if (identifier.name === 'module') {
          const member = parent as MemberExpression;
          const property = member?.property;
          const isExports =
            parent?.type === 'MemberExpression' &&
            member.object === node &&
            ((!member.computed && property.type === 'Identifier' && property.name === 'exports') ||
              (member.computed && property.type === 'Literal' && property.value === 'exports'));
          if (!isExports) fail(requireError);
        }
      }
      if (node.type === 'CallExpression') {
        const call = node as CallExpression;
        if (call.callee.type !== 'Identifier' || call.callee.name !== 'require') return;
        const argument = call.arguments[0];
        if (
          call.arguments.length !== 1 ||
          argument.type !== 'Literal' ||
          typeof argument.value !== 'string' ||
          (!entrypoint && argument.raw?.includes('\\'))
        ) {
          fail(requireError);
        }
        requests.push(argument.value);
      }
    });
    for (const request of requests) {
      if (isAbsolute(request) || /^[A-Za-z]:/.test(request) || request.startsWith('#')) {
        fail('Registry Node package requires must stay inside the package.');
      }
      if (!['.', '..'].includes(request) && !request.startsWith('./') && !request.startsWith('../')) continue;

      const requestedPath = resolve(dirname(filename), request);
      const requestedRelative = relative(packageRoot, requestedPath);
      if (requestedRelative === '..' || requestedRelative.startsWith(`..${sep}`) || isAbsolute(requestedRelative)) {
        fail('Registry Node package requires must stay inside the package.');
      }
      let resolved: string;
      try {
        resolved = realpathSync(createRequire(filename).resolve(request));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
          fail('Registry Node package contains a missing local module.');
        }
        throw error;
      }
      const inside = relative(packageRoot, resolved);
      if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        fail('Registry Node package requires must stay inside the package.');
      }
      if (resolved === resolve(workRoot, 'script.js')) {
        fail('Registry Node package requires must stay inside the package.');
      }
      const extension = extname(resolved);
      if (extension === '.node' || extension === '.mjs') {
        fail('Registry Node packages must use valid CommonJS code and cannot load native modules.');
      }
      if (extension === '.json' || visited.has(resolved)) continue;
      visited.add(resolved);

      for (let directory = dirname(resolved); extension !== '.cjs'; directory = dirname(directory)) {
        const packageJson = resolve(directory, 'package.json');
        if (lstatSync(directory).isDirectory()) {
          try {
            const metadata = JSON.parse(readFileSync(packageJson, 'utf8')) as { type?: unknown };
            if (metadata.type === 'module') {
              fail('Registry Node packages must use valid CommonJS code and cannot load native modules.');
            }
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        if (directory === packageRoot) break;
      }
      visit(readFileSync(resolved, 'utf8'), resolved);
    }
  };
  visit(code, resolve(workRoot, 'script.js'));
}
