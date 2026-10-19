"""Classpath settings for loose Java folders (no Maven/Gradle/Eclipse project).

JDT LS imports such a folder as an "invisible project" and guesses its source folder
from whichever file it sees first; that guess sticks and is often wrong (``src/journal``
for ``src/journal/Entry.java`` declaring ``package journal;``). Clara infers source folders
from ``package`` declarations instead and sends them as ``java.project.sourcePaths``.

An optional ``.clara/java.json`` in the loose folder overrides the inference and adds
libraries, an output folder and JDK runtimes::

    {
      "sourcePaths": ["src"],
      "referencedLibraries": ["lib/**/*.jar", "C:/libs/javafx/*.jar"],
      "outputPath": "out",
      "runtimes": [{"name": "JavaSE-21", "path": "C:/jdk-21", "default": true}]
    }

None of this is sent for build-tool or Eclipse projects, and nothing is written to disk.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from clara_coder_backend.lsp.java_project_root import JavaProjectLayout

logger = logging.getLogger('clara.lsp.java_loose_folder')

__all__ = [
    'LooseJavaConfig',
    'infer_source_root',
    'java_loose_settings',
    'load_loose_java_config',
    'parse_java_package',
    'resolve_nested_roots',
    'scan_loose_source_roots',
    'source_root_for_file',
]

#: Bounded scan so huge workspaces never stall a didOpen.
_MAX_SCANNED_JAVA_FILES = 400
_MAX_SCAN_DEPTH = 16
#: ``package`` must precede every type; a header this size always contains it.
_HEADER_BYTES = 8192

_SKIP_SCAN_DIRS = frozenset(
    {
        'node_modules',
        'dist',
        'build',
        'target',
        'out',
        'bin',
        'venv',
        '__pycache__',
    }
)

_BLOCK_COMMENT_RE = re.compile(r'/\*.*?\*/', re.DOTALL)
_LINE_COMMENT_RE = re.compile(r'//[^\n]*')
_PACKAGE_RE = re.compile(
    r'\s*(?:@[\w.$]+(?:\s*\([^)]*\))?\s*)*'
    r'package\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*;'
)

_RUNTIME_KEYS = frozenset({'name', 'path', 'default', 'sources', 'javadoc'})


def parse_java_package(source: str) -> str:
    """Return the dotted ``package`` name declared by ``source`` ('' for the default package)."""

    head = source[:_HEADER_BYTES].lstrip('\ufeff')
    head = _BLOCK_COMMENT_RE.sub(' ', head)
    head = _LINE_COMMENT_RE.sub(' ', head)
    m = _PACKAGE_RE.match(head)
    if not m:
        return ''
    return re.sub(r'\s+', '', m.group(1))


def infer_source_root(file_dir_parts: tuple[str, ...], package: str) -> tuple[str, ...]:
    """Strip the package path off the end of a file's folder.

    ``('src', 'journal')`` + ``journal`` → ``('src',)``. When the folder does not end in
    the package path the file is misplaced; keep its own folder so JDT LS reports the
    package mismatch instead of Clara hiding it.
    """

    pkg_parts = tuple(p for p in package.split('.') if p)
    if not pkg_parts:
        return file_dir_parts
    n = len(pkg_parts)
    if len(file_dir_parts) >= n and file_dir_parts[-n:] == pkg_parts:
        return file_dir_parts[:-n]
    return file_dir_parts


def _read_header(path: Path) -> str:
    try:
        with path.open('rb') as fh:
            raw = fh.read(_HEADER_BYTES)
    except OSError:
        return ''
    return raw.decode('utf-8', errors='replace')


def _as_rel_posix(parts: tuple[str, ...]) -> str:
    return '/'.join(parts) if parts else '.'


def source_root_for_file(project_root: Path, file_path: Path, text: str | None = None) -> str | None:
    """Relative posix source folder (``'.'`` for the root) for one ``.java`` file, or None."""

    try:
        rel = file_path.resolve().relative_to(project_root.resolve())
    except (OSError, ValueError):
        return None
    source = text if text is not None else _read_header(file_path)
    return _as_rel_posix(infer_source_root(rel.parent.parts, parse_java_package(source)))


def _nests(a: str, b: str) -> bool:
    if a == b or a == '.' or b == '.':
        return True
    return a.startswith(f'{b}/') or b.startswith(f'{a}/')


def resolve_nested_roots(counts: dict[str, int]) -> list[str]:
    """Eclipse rejects nested source folders; keep the side of each nesting that holds more files.

    A stray default-package file at the root must not turn the whole folder into one
    source root (that would re-package every file under ``src``), and one misplaced file
    in ``src/journal`` must not split ``src``. Ties go to the deeper, more specific root.
    """

    ordered = sorted(counts, key=lambda r: (-counts[r], -r.count('/') - (0 if r == '.' else 1), r))
    kept: list[str] = []
    for root in ordered:
        if any(_nests(root, k) for k in kept):
            continue
        kept.append(root)
    return sorted(kept)


def scan_loose_source_roots(
    project_root: Path,
    *,
    known_file_roots: dict[str, str] | None = None,
) -> list[str]:
    """Infer source folders from ``package`` declarations of ``.java`` files under ``project_root``.

    ``known_file_roots`` maps a file's project-relative posix path to the root computed
    from its in-memory text (synced but possibly unsaved or staged); it replaces the disk
    read for that file and is counted even when the file is not on disk yet.
    """

    project_root = project_root.resolve()
    known = dict(known_file_roots or {})
    counts: dict[str, int] = {}
    seen = 0
    truncated = False
    for dirpath, dirnames, filenames in os.walk(project_root):
        d = Path(dirpath)
        rel_dir = () if d == project_root else d.relative_to(project_root).parts
        if len(rel_dir) >= _MAX_SCAN_DEPTH:
            dirnames[:] = []
        dirnames[:] = sorted(x for x in dirnames if x not in _SKIP_SCAN_DIRS and not x.startswith('.'))
        for name in sorted(filenames):
            if not name.endswith('.java'):
                continue
            rel_file = '/'.join((*rel_dir, name))
            root = known.pop(rel_file, None) or source_root_for_file(project_root, d / name)
            if root is not None:
                counts[root] = counts.get(root, 0) + 1
            seen += 1
            if seen >= _MAX_SCANNED_JAVA_FILES:
                truncated = True
                break
        if truncated:
            logger.info('java loose scan stopped at %s files under %s', seen, project_root)
            break
    for root in known.values():
        counts[root] = counts.get(root, 0) + 1
    return resolve_nested_roots(counts)


@dataclass(frozen=True)
class LooseJavaConfig:
    """Validated ``.clara/java.json``; every field is optional."""

    source_paths: tuple[str, ...] | None = None
    referenced_libraries: list[str] | dict[str, Any] | None = None
    output_path: str | None = None
    runtimes: tuple[dict[str, Any], ...] | None = None


def _str_list(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    out = [v.strip() for v in value if isinstance(v, str) and v.strip()]
    return out if len(out) == len(value) else None


def _referenced_libraries(value: Any) -> list[str] | dict[str, Any] | None:
    as_list = _str_list(value)
    if as_list is not None:
        return as_list
    if not isinstance(value, dict):
        return None
    include = _str_list(value.get('include'))
    if include is None:
        return None
    out: dict[str, Any] = {'include': include}
    if 'exclude' in value:
        exclude = _str_list(value.get('exclude'))
        if exclude is None:
            return None
        out['exclude'] = exclude
    if 'sources' in value:
        sources = value.get('sources')
        if not isinstance(sources, dict) or not all(
            isinstance(k, str) and isinstance(v, str) for k, v in sources.items()
        ):
            return None
        out['sources'] = dict(sources)
    return out


def _runtimes(value: Any) -> tuple[dict[str, Any], ...] | None:
    if not isinstance(value, list):
        return None
    out: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            return None
        name, path = item.get('name'), item.get('path')
        if not isinstance(name, str) or not isinstance(path, str) or not name or not path:
            return None
        out.append({k: v for k, v in item.items() if k in _RUNTIME_KEYS})
    return tuple(out)


def load_loose_java_config(path: Path | None) -> LooseJavaConfig:
    """Parse ``.clara/java.json``; invalid fields are logged and ignored, never fatal."""

    if path is None or not path.is_file():
        return LooseJavaConfig()
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        logger.warning('java loose config unreadable path=%s err=%s', path, exc)
        return LooseJavaConfig()
    if not isinstance(data, dict):
        logger.warning('java loose config must be a JSON object path=%s', path)
        return LooseJavaConfig()

    def checked(key: str, parsed: Any) -> Any:
        if key in data and parsed is None:
            logger.warning('java loose config: ignoring invalid `%s` in %s', key, path)
        return parsed

    source_paths = checked('sourcePaths', _str_list(data.get('sourcePaths')) if 'sourcePaths' in data else None)
    raw_output = data.get('outputPath')
    output = raw_output.strip() if isinstance(raw_output, str) and raw_output.strip() else None
    return LooseJavaConfig(
        source_paths=tuple(source_paths) if source_paths else None,
        referenced_libraries=checked(
            'referencedLibraries',
            _referenced_libraries(data.get('referencedLibraries')) if 'referencedLibraries' in data else None,
        ),
        output_path=checked('outputPath', output) if 'outputPath' in data else None,
        runtimes=checked('runtimes', _runtimes(data.get('runtimes')) if 'runtimes' in data else None),
    )


def java_loose_settings(
    layout: JavaProjectLayout,
    config: LooseJavaConfig,
    source_paths: list[str] | tuple[str, ...],
) -> dict[str, Any]:
    """``settings.java`` fragment for a loose folder (empty for any other layout)."""

    if not layout.is_loose:
        return {}
    project: dict[str, Any] = {}
    paths = list(config.source_paths) if config.source_paths else list(source_paths)
    if paths:
        project['sourcePaths'] = paths
    if config.referenced_libraries is not None:
        project['referencedLibraries'] = config.referenced_libraries
    if config.output_path:
        project['outputPath'] = config.output_path
    out: dict[str, Any] = {}
    if project:
        out['project'] = project
    if config.runtimes:
        out['configuration'] = {'runtimes': [dict(r) for r in config.runtimes]}
    return out
