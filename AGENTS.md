# AGENTS

This file holds the team-shared rules for AI coding agents working in this repository. It is the single source of truth — `CLAUDE.md` is a one-line bridge (`@AGENTS.md`) so Claude Code reads the same content.

## Personal Local Rules

If a file `AGENTS.local.md` exists in this repository root, read it once at the start of the session and treat its contents as additional personal rules that extend (but never override) the team rules in this file.

## Project Structure

- New plugins live under `packages/plugins/@nocobase/plugin-<name>/`. Reuse the existing plugin scaffold; do not invent a new layout.
- Core code and base plugins are read-only by default: do not modify `packages/core/**` or `packages/plugins/@nocobase*/**` when creating, upgrading, or fixing custom plugins unless the user explicitly asks for a core/base-plugin change in that turn. Treat these packages as upstream contracts to inspect, not implementation surfaces to patch.
- This repo has two client runtimes: legacy v1 (`src/client/`, `@nocobase/client`, `SchemaComponent`) and v2 (`src/client-v2/`, `@nocobase/client-v2`, `FlowEngine` / `FlowModel`). Confirm which runtime the file under edit belongs to before writing code. Import direction is one-way: v1 client may import from v2 (`@nocobase/client-v2`), but v2 client must never import from v1 (`@nocobase/client`).
- Pro (not open source) plugins live in individual repositories under `packages/plugins` or `packages/pro-plugins` (for example, `@nocobase/plugin-workflow-approval`), but used not as submodules. When working on a pro plugin, clone its repo separately under `packages/plugins/` or `packages/pro-plugins/` and treat it as a standalone project with git.
- Plugin `package.json` files should follow the buildable structure used by `packages/plugins/plugin-sub-agent/package.json`: top-level `name`, localized `displayName*`, `description`, `version`, `license`, `main`, `keywords`, `files`, `nocobase.supportedVersions`, `nocobase.editionLevel`, and runtime `peerDependencies`. Avoid adding top-level `types` or `devDependencies` to plugin package manifests unless a plugin specifically proves they are required, because matching this structure fixed successful plugin builds for `plugin-user-memory`.

## Plugin Build & Pack Workflow

- On Windows, prefer PowerShell for NocoBase plugin build/pack commands. The same `yarn nocobase build <plugin> --no-dts` command can fail in Claude's bash shell during the `@nocobase/build` bootstrap (`entry point ... cannot be marked as external`) while succeeding in PowerShell with the same Node version.
- Build plugins from the repository root with `yarn nocobase build <plugin-package-name> --no-dts`, for example `yarn nocobase build plugin-build-visualization-block --no-dts`.
- After a successful build, pack from the plugin directory with `npm pack`, for example `Set-Location "packages/plugins/plugin-build-visualization-block"; npm pack` in PowerShell.
- Verify the build output before reporting success: `dist/client/index.js` (or the plugin's expected client bundle), `dist/server/index.js`, locale files, and `dist/externalVersion.js` should exist.
- Do not pack after a failed build unless the user explicitly wants a tarball from stale `dist/` output.

## Code Style Rules

- Do not use `void someAsyncCall()` style fire-and-forget invocation. Prefer direct invocation such as `someAsyncCall()` and structure surrounding code accordingly.
- Avoid `any` in TypeScript. Reach for a specific type, a generic, or `unknown` with a narrowing guard instead. Replace `as any` with a named type or a type guard. When touching existing code that uses `any`, narrow it to a concrete type whenever feasible.
- For frontend components and pages, prefer Ant Design v5 components and follow its conventions. Reference https://ant.design/llms.txt for antd's LLM-friendly documentation when needed.
- For frontend components and pages, follow accessibility (a11y) best practices — add appropriate ARIA attributes, use semantic HTML, and ensure keyboard navigation works.
- Do not use async IIFE patterns in event handlers (for example: `runAsyncTask((async () => { ... })())`). Extract the async logic into a named async function or call it directly.
- Do not introduce new abstractions, error-handling layers, or feature flags beyond what the task requires. Three similar lines is better than a premature abstraction.

## Database & Migrations

- Any change to database tables, columns, or indexes must ship with a migration under the plugin's `src/server/migrations/`. Import column types from `DataTypes`; do not reuse type names from neighboring migrations without verifying they still apply.
- New collections (tables), columns, indexes will be automatically synced to database when running the command `yarn nocobase upgrade` (will also run in docker container when start). So no need to create migration files in these cases.

## Testing Rules

- Run single test file: `yarn test <path-to-test-file>`
  - Client example: `yarn test packages/core/flow-engine/src/__tests__/flow-engine.test.ts --run --reporter=verbose`
  - Server example: `yarn test packages/core/server/src/__tests__/Application.test.ts`
- Always run related test files after modifying source code to ensure no regressions.
- Co-locate unit and integration tests in `__tests__` directories, naming files `*.test.ts` or `*.spec.ts`.
- Do NOT run server tests parallelly; they may interfere with each other. Use `yarn test` to run them sequentially.

## Internationalization (i18n)

- User-facing strings (UI labels, messages, errors shown to end users) must go through the project's i18n layer (`t()` / `useTranslation()`); do not hardcode them. Add keys for both `en-US` and `zh-CN` when introducing new strings.

## Pre-Commit Workflow

- Run `yarn eslint --fix` on touched files before reporting work as done. Resolve type errors and lint warnings rather than disabling them.

## Commit Conventions

- Commit messages follow Conventional Commits, prefixed with the affected scope: `fix(plugin-workflow): ...`, `feat(client): ...`, `chore: ...`, `docs: ...`.
