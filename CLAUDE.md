@AGENTS.md

This file is a bridge — treat `AGENTS.md` as the source of truth. When asked to read, update, or add rules to `CLAUDE.md`, read from and write to `AGENTS.md` instead.

REMEMBER:
- Not edit at packages\plugins\@nocobase and Not edit at packages\core
- New plugins follow v2.x structure of nocobase (not v1.x), so it will use different api and ui components.
- New plugins need implement at packages\plugins\ not packages\plugins\@nocobase\