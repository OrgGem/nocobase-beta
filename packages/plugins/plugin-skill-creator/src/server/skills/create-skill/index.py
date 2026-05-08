import ast
import base64
import json
import os
import re
import zipfile
from pathlib import Path


def decode_text(name, default=""):
    token = "{{" + name + "_b64}}"
    raw = globals().get(name + "_b64", token)
    if not raw or raw == token:
        return default
    return base64.b64decode(raw).decode("utf-8")


def decode_json(name, default):
    text = decode_text(name, "")
    if not text:
        return default
    return json.loads(text)


skill_name_b64 = "{{skill_name_b64}}"
title_b64 = "{{title_b64}}"
purpose_b64 = "{{purpose_b64}}"
description_b64 = "{{description_b64}}"
language_b64 = "{{language_b64}}"
code_b64 = "{{code_b64}}"
input_schema_b64 = "{{input_schema_b64}}"
packages_b64 = "{{packages_b64}}"
instructions_b64 = "{{instructions_b64}}"
test_input_b64 = "{{test_input_b64}}"
timeout_seconds_b64 = "{{timeout_seconds_b64}}"
max_output_size_mb_b64 = "{{max_output_size_mb_b64}}"
overwrite_b64 = "{{overwrite_b64}}"


def fail(message):
    print(json.dumps({"status": "error", "message": message}, ensure_ascii=False))
    raise SystemExit(1)


def safe_json_loads(text, default):
    if not text:
        return default
    return json.loads(text)


def normalize_name(value):
    name = re.sub(r"[^a-z0-9-]+", "-", value.lower()).strip("-")
    name = re.sub(r"-+", "-", name)
    return name[:64].strip("-")


def validate_schema(schema):
    if not isinstance(schema, dict):
        fail("input_schema must be a JSON object")
    if schema.get("type") != "object":
        fail('input_schema.type must be "object"')
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        fail("input_schema.properties must be an object")
    required = schema.get("required", [])
    if required is not None and not isinstance(required, list):
        fail("input_schema.required must be an array when provided")
    for field in required or []:
        if field not in properties:
            fail(f"required field '{field}' is missing from input_schema.properties")


PY_FORBIDDEN = [
    (r"import\s+subprocess", "subprocess module not allowed"),
    (r"from\s+subprocess\s+import", "subprocess module not allowed"),
    (r"import\s+shutil", "shutil module not allowed"),
    (r"__import__\s*\(", "__import__ not allowed"),
    (r"os\.system\s*\(", "os.system not allowed"),
    (r"os\.popen\s*\(", "os.popen not allowed"),
    (r"os\.exec\w*\s*\(", "os.exec* not allowed"),
    (r"os\.spawn\w*\s*\(", "os.spawn* not allowed"),
    (r"\beval\s*\(", "eval not allowed"),
    (r"\bexec\s*\(", "exec not allowed"),
    (r"\bcompile\s*\(", "compile not allowed"),
]

NODE_FORBIDDEN = [
    (r"require\s*\(\s*['\"]child_process['\"]\s*\)", "child_process module not allowed"),
    (r"require\s*\(\s*['\"]cluster['\"]\s*\)", "cluster module not allowed"),
    (r"require\s*\(\s*['\"]dgram['\"]\s*\)", "dgram module not allowed"),
    (r"require\s*\(\s*['\"]net['\"]\s*\)", "net module not allowed"),
    (r"require\s*\(\s*['\"]http['\"]\s*\)", "http module not allowed"),
    (r"require\s*\(\s*['\"]https['\"]\s*\)", "https module not allowed"),
    (r"require\s*\(\s*['\"]vm['\"]\s*\)", "vm module not allowed"),
    (r"process\.exit", "process.exit not allowed"),
    (r"process\.env(?!\s*\.OUTPUT_DIR)", "process.env access not allowed except OUTPUT_DIR"),
    (r"process\.kill", "process.kill not allowed"),
]


def validate_code(code, language):
    patterns = PY_FORBIDDEN if language == "python" else NODE_FORBIDDEN
    for pattern, reason in patterns:
        if re.search(pattern, code):
            fail(f"Generated code validation failed: {reason}")
    if language == "python":
        try:
            ast.parse(code)
        except SyntaxError as exc:
            fail(f"Generated Python syntax error: line {exc.lineno}: {exc.msg}")
    else:
        if code.count("(") != code.count(")") or code.count("{") != code.count("}"):
            fail("Generated Node code appears to have unbalanced brackets")


def check_placeholders(code, schema, test_input):
    properties = schema.get("properties", {})
    missing = []
    for field in schema.get("required", []) or []:
        if f"{{{{{field}}}}}" not in code and f"{{{{{field}_b64}}}}" not in code:
            missing.append(field)
    if missing:
        fail("Generated code does not reference required input fields: " + ", ".join(missing))
    if test_input:
        unknown = [key for key in test_input.keys() if key not in properties]
        if unknown:
            fail("test_input contains fields not declared in input_schema: " + ", ".join(unknown))


def write_skill_package(root, values):
    root.mkdir(parents=True, exist_ok=True)
    language = values["language"]
    code_filename = "index.py" if language == "python" else "index.js"

    skill_md = f"""---
name: {values["name"]}
description: {values["description"].replace(chr(10), " ")}
---

# {values["title"]}

{values["instructions"]}
"""

    (root / "SKILL.md").write_text(skill_md, encoding="utf-8")
    (root / code_filename).write_text(values["codeTemplate"], encoding="utf-8")
    (root / "skill.json").write_text(json.dumps(values, indent=2, ensure_ascii=False), encoding="utf-8")


def zip_dir(src_dir, zip_path):
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in src_dir.rglob("*"):
            if path.is_file():
                archive.write(path, path.relative_to(src_dir.parent))


raw_name = decode_text("skill_name")
name = normalize_name(raw_name)
if not name:
    fail("skill_name is required")
if name != raw_name:
    print(f"Normalized skill_name from '{raw_name}' to '{name}'")

language = decode_text("language", "python").strip().lower()
if language not in ("python", "node"):
    fail("language must be python or node")

purpose = decode_text("purpose").strip()
description = decode_text("description", purpose).strip() or purpose
title = decode_text("title", name.replace("-", " ").title()).strip()
code = decode_text("code").strip()
if not purpose:
    fail("purpose is required")
if not code:
    fail("code is required")

input_schema = decode_json("input_schema", {})
packages = decode_json("packages", [])
test_input = decode_json("test_input", {})
instructions = decode_text("instructions", "").strip()
if not instructions:
    instructions = "Use this skill when the user asks for: " + purpose

timeout_seconds = int(float(decode_text("timeout_seconds", "60") or "60"))
max_output_size_mb = int(float(decode_text("max_output_size_mb", "50") or "50"))
overwrite_text = decode_text("overwrite", "true").strip().lower()
overwrite = overwrite_text not in ("false", "0", "no")

if not isinstance(packages, list) or not all(isinstance(item, str) for item in packages):
    fail("packages must be an array of strings")

validate_schema(input_schema)
validate_code(code, language)
check_placeholders(code, input_schema, test_input)

values = {
    "name": name,
    "title": title,
    "description": description,
    "instructions": instructions,
    "language": language,
    "codeTemplate": code,
    "inputSchema": input_schema,
    "packages": packages,
    "timeoutSeconds": timeout_seconds,
    "maxOutputSizeMb": max_output_size_mb,
    "enabled": True,
    "toolScope": "CUSTOM",
    "autoCall": False,
}

output_dir = Path(os.environ.get("OUTPUT_DIR", "/output"))
package_dir = output_dir / name
write_skill_package(package_dir, values)

zip_path = output_dir / f"{name}.zip"
zip_dir(package_dir, zip_path)

manifest = {
    "autoInstall": True,
    "overwrite": overwrite,
    "packageDir": name,
    "testInput": test_input,
    "skill": values,
}
(output_dir / "skill-hub-install.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")

print(json.dumps({
    "status": "success",
    "message": f"Generated skill package '{name}' and requested Skill Hub auto-install.",
    "skillName": name,
    "package": zip_path.name,
}, ensure_ascii=False))
