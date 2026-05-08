---
name: create-skill
description: Create and auto-install a new Skill Hub skill from an AI-generated specification. Use when a user asks an AI Employee to add a reusable tool/capability/skill such as report generation, data cleanup, document export, CRM analysis, or any workflow that should become a future Skill Hub tool.
---

# Create Skill

Use this skill after you have designed the new Skill Hub skill.

## Required workflow

1. Convert the user's request into a focused reusable skill.
2. Choose a stable `skill_name` using lowercase letters, numbers, and hyphens.
3. Write a strict `input_schema` for the future tool. Mark required fields explicitly.
4. Write complete executable `code` for the future skill using only Skill Hub sandbox-safe APIs.
5. Prefer safe placeholders:
   - Use `{{field_b64}}` for multiline strings, JSON text, HTML, SVG, markdown, or user content with quotes.
   - Use `{{field}}` only for simple enum/numeric/scalar values.
6. Provide `test_input` whenever possible so placeholder coverage can be checked.
7. Call this skill once. On success, Skill Hub auto-installs or updates the generated skill.

## Code constraints

- Python skills may import sandbox-safe standard modules and packages declared in `packages`.
- Node skills may use sandbox-safe built-ins such as `fs` and `path`.
- Do not generate code that imports process-control, networking, shell, dynamic evaluation, or environment secrets.
- Write output files under `OUTPUT_DIR`.

## Result

The tool returns a generated package zip and an install manifest. The Skill Hub worker consumes the manifest and creates or updates the `skillDefinitions` record automatically.
