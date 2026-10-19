"""Loose Java folder source-root inference and ``.clara/java.json`` parsing."""

from __future__ import annotations

import json
from pathlib import Path

from clara_coder_backend.lsp.java_loose_folder import (
    LooseJavaConfig,
    infer_source_root,
    java_loose_settings,
    load_loose_java_config,
    parse_java_package,
    resolve_nested_roots,
    scan_loose_source_roots,
)
from clara_coder_backend.lsp.java_project_root import (
    JAVA_LAYOUT_LOOSE,
    JAVA_LAYOUT_MAVEN,
    JavaProjectLayout,
)


def _java(path: Path, package: str = '', body: str = 'class X {}\n') -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = f'package {package};\n\n' if package else ''
    path.write_text(header + body, encoding='utf-8')


def test_parse_java_package_variants() -> None:
    assert parse_java_package('package journal;\nclass A {}') == 'journal'
    assert parse_java_package('/* license\n package nope; */\n// x\npackage com.acme.app;') == 'com.acme.app'
    assert parse_java_package('\ufeff@Deprecated\n@Foo(bar = 1) package a . b ;') == 'a.b'
    assert parse_java_package('import java.util.List;\nclass A {}') == ''
    assert parse_java_package('class A { String s = "package x;"; }') == ''


def test_infer_source_root_strips_matching_package_only() -> None:
    assert infer_source_root(('src', 'journal'), 'journal') == ('src',)
    assert infer_source_root(('app', 'com', 'acme'), 'com.acme') == ('app',)
    assert infer_source_root(('src',), '') == ('src',)
    # Misplaced file: keep its folder so JDT LS reports the mismatch.
    assert infer_source_root(('src',), 'journal') == ('src',)


def test_scan_finds_src_for_package_folder(tmp_path: Path) -> None:
    for name in ('Entry', 'EntryStore', 'JournalApp'):
        _java(tmp_path / 'src' / 'journal' / f'{name}.java', 'journal')
    # Compiled output and hidden folders are never scanned.
    _java(tmp_path / 'out' / 'journal' / 'Stale.java', 'other')
    _java(tmp_path / '.clara' / 'Hidden.java', 'zzz')
    assert scan_loose_source_roots(tmp_path) == ['src']


def test_scan_majority_wins_over_stray_root_file(tmp_path: Path) -> None:
    for name in ('A', 'B', 'C'):
        _java(tmp_path / 'src' / 'journal' / f'{name}.java', 'journal')
    _java(tmp_path / 'Scratch.java')
    assert scan_loose_source_roots(tmp_path) == ['src']


def test_scan_keeps_independent_roots(tmp_path: Path) -> None:
    _java(tmp_path / 'src' / 'app' / 'Main.java', 'app')
    _java(tmp_path / 'test' / 'app' / 'MainTest.java', 'app')
    assert scan_loose_source_roots(tmp_path) == ['src', 'test']


def test_scan_uses_known_text_for_unsaved_files(tmp_path: Path) -> None:
    # On disk the file has no package yet; the synced text says `journal`.
    _java(tmp_path / 'src' / 'journal' / 'Entry.java')
    known = {'src/journal/Entry.java': 'src', 'src/journal/New.java': 'src'}
    assert scan_loose_source_roots(tmp_path, known_file_roots=known) == ['src']


def test_resolve_nested_roots_tie_prefers_deeper() -> None:
    assert resolve_nested_roots({'.': 1, 'src': 1}) == ['src']
    assert resolve_nested_roots({'.': 5, 'src': 1}) == ['.']


def test_load_loose_java_config_valid(tmp_path: Path) -> None:
    cfg = tmp_path / 'java.json'
    cfg.write_text(
        json.dumps(
            {
                'sourcePaths': ['src'],
                'referencedLibraries': {'include': ['lib/**/*.jar'], 'exclude': ['lib/old.jar']},
                'outputPath': 'out',
                'runtimes': [{'name': 'JavaSE-21', 'path': 'C:/jdk-21', 'default': True, 'junk': 1}],
            }
        ),
        encoding='utf-8',
    )
    config = load_loose_java_config(cfg)
    assert config.source_paths == ('src',)
    assert config.referenced_libraries == {'include': ['lib/**/*.jar'], 'exclude': ['lib/old.jar']}
    assert config.output_path == 'out'
    assert config.runtimes == ({'name': 'JavaSE-21', 'path': 'C:/jdk-21', 'default': True},)


def test_load_loose_java_config_ignores_invalid_fields(tmp_path: Path) -> None:
    cfg = tmp_path / 'java.json'
    cfg.write_text(
        json.dumps({'sourcePaths': 'src', 'referencedLibraries': ['a.jar', 3], 'runtimes': [{'name': 'x'}]}),
        encoding='utf-8',
    )
    assert load_loose_java_config(cfg) == LooseJavaConfig()
    cfg.write_text('{not json', encoding='utf-8')
    assert load_loose_java_config(cfg) == LooseJavaConfig()
    assert load_loose_java_config(tmp_path / 'missing.json') == LooseJavaConfig()


def test_java_loose_settings_only_for_loose_layout(tmp_path: Path) -> None:
    config = LooseJavaConfig(referenced_libraries=['lib/*.jar'], runtimes=({'name': 'JavaSE-21', 'path': 'x'},))
    loose = JavaProjectLayout(kind=JAVA_LAYOUT_LOOSE, root=tmp_path)
    assert java_loose_settings(loose, config, ['src']) == {
        'project': {'sourcePaths': ['src'], 'referencedLibraries': ['lib/*.jar']},
        'configuration': {'runtimes': [{'name': 'JavaSE-21', 'path': 'x'}]},
    }
    maven = JavaProjectLayout(kind=JAVA_LAYOUT_MAVEN, root=tmp_path)
    assert java_loose_settings(maven, config, ['src']) == {}


def test_config_source_paths_override_inference(tmp_path: Path) -> None:
    loose = JavaProjectLayout(kind=JAVA_LAYOUT_LOOSE, root=tmp_path)
    settings = java_loose_settings(loose, LooseJavaConfig(source_paths=('code',)), ['src'])
    assert settings['project']['sourcePaths'] == ['code']
