# Migration Checklist: [PLUGIN_NAME]

> Copy this template for each plugin migration. Fill in as you go.

## Plugin Info

- **Package**: `@nocobase/plugin-xxx`
- **Phase**: 1A / 1B / 2A / 2B
- **Current status**: V1_ONLY / HYBRID
- **Has Schema patterns**: Yes / No
- **Client files count**: N
- **Branch**: `codex/migrate-v2-plugin-xxx`

---

## Pre-Migration Baseline

- [ ] Build succeeds: `yarn nocobase build @nocobase/plugin-xxx --no-dts`
- [ ] Pack succeeds: `npm pack` in plugin directory
- [ ] Existing tests pass: `yarn test <test-file>`
- [ ] Screenshot of current UI (if applicable): [link/path]

---

## Files to Migrate

| File | Current API | Target API | Status |
|------|-------------|------------|--------|
| `src/client/index.tsx` | `import { Plugin } from '@nocobase/client'` | `from '@nocobase/client-v2'` | ⬜ |
| `src/client/SomeBlock.tsx` | `SchemaComponent` | `extends BlockModel` | ⬜ |
| `src/client/schemaSettings.ts` | `SchemaSettings` | `Model.registerFlow()` | ⬜ |
| ... | ... | ... | ... |

---

## Migration Steps

### Step 1: Update imports
- [ ] Replace `@nocobase/client` → `@nocobase/client-v2` in all client files
- [ ] Add `@nocobase/flow-engine` import where needed
- [ ] Verify no circular imports

### Step 2: Convert Schema patterns (if applicable)
- [ ] Identify all `SchemaInitializer` usages → create corresponding `FlowModel` subclass
- [ ] Identify all `SchemaSettings` usages → convert to `registerFlow({ key, steps })`
- [ ] Identify all `useDesignable` / `useSchemaInitializer` hooks → replace with FlowEngine APIs
- [ ] Delete old initializer/settings files

### Step 3: Register models & actions
- [ ] In `plugin.tsx` → `this.flowEngine.registerModels({...})`
- [ ] In `plugin.tsx` → `this.flowEngine.registerActions({...})` (if any)
- [ ] Field bindings: `DisplayItemModel.bindModelToInterface(...)` (if any)

### Step 4: i18n
- [ ] Static contexts use `tExpr()` instead of `t()`
- [ ] Both `en-US` and `zh-CN` keys present for new strings

### Step 5: Code style
- [ ] No `any` types introduced
- [ ] No `void someAsyncCall()` patterns
- [ ] No async IIFE in handlers
- [ ] Comments not hard-wrapped below printWidth (120)

---

## Post-Migration Verification

- [ ] Build succeeds: `yarn nocobase build @nocobase/plugin-xxx --no-dts`
- [ ] Dist output verified: `dist/client/index.js`, `dist/server/index.js` exist
- [ ] Pack succeeds: `npm pack` produces valid tarball
- [ ] Tests pass: `yarn test <test-file>`
- [ ] ESLint clean: `yarn eslint --fix src/client/**`
- [ ] Runtime check on `/v/admin`: plugin loads correctly
- [ ] Screenshot of migrated UI matches baseline: [link/path]
- [ ] No `@nocobase/client` imports remain in client code

---

## Notes / Gotchas

_Record any issues, workarounds, or discoveries here for future reference._

---

*Completed by: [name] | Date: [date]*
