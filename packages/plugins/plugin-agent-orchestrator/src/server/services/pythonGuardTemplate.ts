/**
 * Python audit-hook guard, written by WorkerEnvManager.executeInit() to
 * <storagePath>/sandbox-workspace/py-guard/sitecustomize.py and auto-imported
 * by CPython's `site` module because SandboxRunner prepends that directory to
 * PYTHONPATH for python executions.
 *
 * Stored as a TS string constant (same precedent as SkillManager's seed
 * templates) so no build-pipeline asset copying is needed.
 *
 * Explicit caveat: per CPython docs, sys.addaudithook is NOT a hard sandbox
 * boundary — it cannot be removed once installed, but native extensions can
 * bypass it at the C level. It is defense-in-depth against whitelisted-but-
 * misbehaving packages and gaps in the static CodeValidator, not the trust
 * boundary (that is bwrap / the container). Network events (socket.*) are
 * deliberately NOT blocked: whitelisted packages like `requests` need them;
 * network egress control belongs to bwrap --unshare-net, not this hook.
 */
export const PY_GUARD_SITECUSTOMIZE_SOURCE = `"""NocoBase skill-hub sandbox guard (auto-generated; do not edit)."""
import os
import sys

_BLOCKED_EVENTS = frozenset((
    "os.system",
    "os.fork",
    "os.forkpty",
    "os.exec",
    "os.spawn",
    "os.posix_spawn",
    "subprocess.Popen",
    "_posixsubprocess.fork_exec",
    "ctypes.dlopen",
    "ctypes.dlsym",
    "ctypes.dlsym/handle",
))

_raw_roots = os.environ.get("SKILL_HUB_WRITE_ROOTS", "")
_WRITE_ROOTS = tuple(
    os.path.realpath(root) for root in _raw_roots.split(os.pathsep) if root
)

_WRITE_FLAGS = (
    os.O_WRONLY
    | os.O_RDWR
    | os.O_APPEND
    | getattr(os, "O_CREAT", 0)
    | getattr(os, "O_TRUNC", 0)
)


def _is_write_open(mode, flags):
    if isinstance(mode, str):
        return any(ch in mode for ch in ("w", "a", "x", "+"))
    try:
        return bool(int(flags) & _WRITE_FLAGS)
    except (TypeError, ValueError):
        return False


def _is_allowed_write_path(path):
    try:
        resolved = os.path.realpath(os.fspath(path))
    except (TypeError, ValueError):
        # fd-based or exotic targets cannot be path-scoped here
        return True
    for root in _WRITE_ROOTS:
        if resolved == root or resolved.startswith(root + os.sep):
            return True
    return False


def _skill_hub_guard(event, args):
    if event in _BLOCKED_EVENTS:
        raise RuntimeError(
            "skill-hub sandbox: blocked audited operation '%s'" % event
        )
    if _WRITE_ROOTS and event == "open" and len(args) >= 3:
        path, mode, flags = args[0], args[1], args[2]
        if path is not None and _is_write_open(mode, flags) and not _is_allowed_write_path(path):
            # PermissionError (an OSError) so import machinery treats a denied
            # bytecode-cache write as best-effort instead of aborting imports.
            raise PermissionError(
                "skill-hub sandbox: write outside allowed roots denied: %r" % (path,)
            )


sys.addaudithook(_skill_hub_guard)
`;
