"""``java_bootstrap_project`` — minimal Maven or Gradle setup for a Java folder that has no build file yet.

Without a build file the Java language server has no classpath beyond the JDK, so any third-party import
(JavaFX, Gson, …) shows as an error. This tool writes the smallest build that declares those dependencies,
keeping the existing source layout. Every file goes through the same staging (or Auto-apply direct) path as
``stage_create_file`` / ``apply_workspace_full_file``. Nothing touches PATH, JAVA_HOME, ``~/.m2/settings.xml``
or ``~/.gradle``.

Maven gets the script-only Maven Wrapper (``mvnw`` / ``mvnw.cmd``, no jar). Gradle's ``gradlew`` cannot run
without the binary ``gradle-wrapper.jar``, so only ``gradle/wrapper/gradle-wrapper.properties`` is written: it
pins the Gradle version the Java language server imports with, and ``gradle wrapper`` can add the scripts later.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Literal
from xml.sax.saxutils import escape as _xml_escape

from langchain_core.tools import tool

from clara_coder_backend.session.state import (
    current_session_id,
    direct_workspace_edits_active,
    get_session,
    mutation_tools_blocked_reason,
)
from clara_coder_backend.tools.edit import apply_workspace_full_file
from clara_coder_backend.tools.staging_edit import stage_create_file
from clara_coder_backend.tools.tool_conventions import describe
from clara_coder_backend.tools.workspace import get_active_workspace_root, normalize_relative_path

logger = logging.getLogger('clara.java_bootstrap')

JAVA_BOOTSTRAP_PROJECT_NAME = 'java_bootstrap_project'

# Checked against Maven Central, the Gradle plugin portal and services.gradle.org on 2026-10-18.
MAVEN_VERSION = '3.10.0'
MAVEN_WRAPPER_VERSION = '3.3.4'
JAVAFX_MAVEN_PLUGIN_VERSION = '0.0.8'
JAVAFX_GRADLE_PLUGIN_VERSION = '0.1.0'
GRADLE_VERSION = '9.8.1'
GRADLE_DISTRIBUTION_SHA256 = 'dce76f55f8e251a3a1f130eb120f30b3d271de2b76c9b0729d316b5a1b6dc01f'

BUILD_FILE_NAMES = (
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
)
STANDARD_SOURCE_DIR = 'src/main/java'
DEFAULT_JAVA_RELEASE = 21

# Resource globs used when the sources sit directly in the project folder (``source_dir='.'``), where
# "everything that is not .java" would also sweep up the build files and scripts themselves.
_ROOT_RESOURCE_INCLUDES = (
    '**/*.fxml', '**/*.css', '**/*.properties', '**/*.json', '**/*.xml', '**/*.txt',
    '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.svg', '**/*.ico',
    '**/*.ttf', '**/*.otf', '**/*.wav', '**/*.mp3',
)
_ROOT_EXCLUDES = ('pom.xml', 'target/**', 'build/**', '.gradle/**', '.mvn/**', 'gradle/**')
_SKIP_SCAN_DIRS = frozenset({'.git', '.gradle', '.idea', '.mvn', '.vscode', 'build', 'node_modules', 'out', 'target'})

_TEMPLATES_DIR = Path(__file__).resolve().parent / 'java_bootstrap_templates'

_IDENT = r'[A-Za-z_$][A-Za-z0-9_$]*'
_MAIN_CLASS_RE = re.compile(rf'^{_IDENT}(\.{_IDENT})*$')
_COORD_PART_RE = re.compile(r'^[A-Za-z0-9_.\-]+$')
_VERSION_RE = re.compile(r'^[A-Za-z0-9_.\-+]+$')
_SOURCE_DIR_RE = re.compile(r'^[A-Za-z0-9_.\- /]+$')

__all__ = [
    'JAVA_BOOTSTRAP_PROJECT_NAME',
    'java_bootstrap_project',
    'find_build_file_above',
    'plan_bootstrap_files',
]


@dataclass(frozen=True)
class Dependency:
    group: str
    artifact: str
    version: str

    @property
    def is_javafx(self) -> bool:
        return self.group == 'org.openjfx' and self.artifact.startswith('javafx-')

    @property
    def javafx_module(self) -> str:
        """``javafx-controls`` → ``javafx.controls`` (the javafx Gradle plugin's module names)."""
        return self.artifact.replace('-', '.')

    def notation(self) -> str:
        return f'{self.group}:{self.artifact}:{self.version}'


@dataclass(frozen=True)
class PlannedFile:
    relative_path: str
    content: str
    newline: Literal['lf', 'crlf']
    executable: bool = False


def parse_dependency(coordinate: str) -> Dependency:
    parts = [p.strip() for p in str(coordinate or '').split(':')]
    if len(parts) != 3 or not all(parts):
        raise ValueError(f'dependency `{coordinate}` must be `group:artifact:version`.')
    group, artifact, version = parts
    if not _COORD_PART_RE.match(group) or not _COORD_PART_RE.match(artifact) or not _VERSION_RE.match(version):
        raise ValueError(f'dependency `{coordinate}` has characters outside a Maven coordinate.')
    return Dependency(group, artifact, version)


def find_build_file_above(root: Path, folder: Path) -> Path | None:
    """First Maven/Gradle build file in ``folder`` or any ancestor up to (and including) ``root``."""
    current = folder
    while True:
        for name in BUILD_FILE_NAMES:
            candidate = current / name
            if candidate.is_file():
                return candidate
        if current == root or root not in current.parents:
            return None
        current = current.parent


def _detect_source_dir(folder: Path, main_class: str) -> str:
    """Source root that keeps the current layout: where ``main_class``'s file lives, else src/main/java or src."""
    parts = main_class.split('.')
    file_name = f'{parts[-1]}.java'
    package_parts = parts[:-1]
    if folder.is_dir():
        for dirpath, dirnames, filenames in os.walk(folder):
            dirnames[:] = sorted(d for d in dirnames if d not in _SKIP_SCAN_DIRS)
            if file_name not in filenames:
                continue
            rel_parts = Path(dirpath).relative_to(folder).parts
            if package_parts and tuple(rel_parts[-len(package_parts):]) != tuple(package_parts):
                continue
            root_parts = rel_parts[: len(rel_parts) - len(package_parts)]
            return '/'.join(root_parts) or '.'
    if (folder / STANDARD_SOURCE_DIR).is_dir():
        return STANDARD_SOURCE_DIR
    src = folder / 'src'
    if src.is_dir() and any(src.rglob('*.java')):
        return 'src'
    return STANDARD_SOURCE_DIR


def _normalize_source_dir(raw: str) -> str:
    cleaned = raw.strip().replace('\\', '/').strip('/')
    if not cleaned or cleaned == '.':
        return '.'
    if not _SOURCE_DIR_RE.match(cleaned) or any(part in ('', '..') for part in cleaned.split('/')):
        raise ValueError(f'`source_dir` `{raw}` must be a plain relative folder inside the project folder.')
    return '/'.join(p for p in cleaned.split('/') if p != '.')


def _project_name(folder: Path) -> str:
    name = re.sub(r'[^a-z0-9]+', '-', folder.name.lower()).strip('-')
    return name or 'app'


def _group_id(main_class: str) -> str:
    package = main_class.rpartition('.')[0]
    return package or 'com.example'


def _read_template(name: str) -> str:
    return (_TEMPLATES_DIR / name).read_text(encoding='utf-8').replace('\r\n', '\n')


# --- Maven -----------------------------------------------------------------------------------------------


def render_pom(
    *,
    group_id: str,
    artifact_id: str,
    main_class: str,
    dependencies: list[Dependency],
    java_release: int,
    source_dir: str,
) -> str:
    x = _xml_escape
    has_javafx = any(d.is_javafx for d in dependencies)
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<project xmlns="http://maven.apache.org/POM/4.0.0"',
        '         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
        '         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">',
        '  <modelVersion>4.0.0</modelVersion>',
        '',
        f'  <groupId>{x(group_id)}</groupId>',
        f'  <artifactId>{x(artifact_id)}</artifactId>',
        '  <version>1.0-SNAPSHOT</version>',
        '',
        '  <properties>',
        f'    <maven.compiler.release>{java_release}</maven.compiler.release>',
        '    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>',
        '    <project.reporting.outputEncoding>UTF-8</project.reporting.outputEncoding>',
    ]
    if not has_javafx:
        # Lets `mvnw compile exec:java` find the entry point without pinning exec-maven-plugin.
        lines.append(f'    <exec.mainClass>{x(main_class)}</exec.mainClass>')
    lines.append('  </properties>')

    if dependencies:
        lines += ['', '  <dependencies>']
        for dep in dependencies:
            lines += [
                '    <dependency>',
                f'      <groupId>{x(dep.group)}</groupId>',
                f'      <artifactId>{x(dep.artifact)}</artifactId>',
                f'      <version>{x(dep.version)}</version>',
                '    </dependency>',
            ]
        lines.append('  </dependencies>')

    build: list[str] = []
    if source_dir != STANDARD_SOURCE_DIR:
        build += [
            f'    <sourceDirectory>{x(source_dir)}</sourceDirectory>',
            '    <resources>',
            '      <resource>',
            f'        <directory>{x(source_dir)}</directory>',
        ]
        if source_dir == '.':
            build.append('        <includes>')
            build += [f'          <include>{g}</include>' for g in _ROOT_RESOURCE_INCLUDES]
            build.append('        </includes>')
            build.append('        <excludes>')
            build += [f'          <exclude>{g}</exclude>' for g in _ROOT_EXCLUDES]
            build.append('        </excludes>')
        else:
            build += [
                '        <excludes>',
                '          <exclude>**/*.java</exclude>',
                '        </excludes>',
            ]
        build += ['      </resource>', '    </resources>']
    if has_javafx:
        build += [
            '    <plugins>',
            '      <plugin>',
            '        <groupId>org.openjfx</groupId>',
            '        <artifactId>javafx-maven-plugin</artifactId>',
            f'        <version>{JAVAFX_MAVEN_PLUGIN_VERSION}</version>',
            '        <configuration>',
            f'          <mainClass>{x(main_class)}</mainClass>',
            '        </configuration>',
            '      </plugin>',
            '    </plugins>',
        ]
    if build:
        lines += ['', '  <build>', *build, '  </build>']
    lines += ['</project>', '']
    return '\n'.join(lines)


def render_maven_wrapper_properties() -> str:
    return (
        f'wrapperVersion={MAVEN_WRAPPER_VERSION}\n'
        'distributionType=only-script\n'
        'distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/'
        f'{MAVEN_VERSION}/apache-maven-{MAVEN_VERSION}-bin.zip\n'
    )


# --- Gradle ----------------------------------------------------------------------------------------------


def render_settings_gradle(project_name: str) -> str:
    return f'rootProject.name = "{project_name}"\n'


def _kotlin_list(values: tuple[str, ...] | list[str]) -> str:
    return ', '.join(f'"{v}"' for v in values)


def render_build_gradle(
    *,
    main_class: str,
    dependencies: list[Dependency],
    java_release: int,
    source_dir: str,
) -> str:
    javafx = [d for d in dependencies if d.is_javafx]
    others = [d for d in dependencies if not d.is_javafx]
    lines = ['plugins {', '    application']
    if javafx:
        lines.append(f'    id("org.openjfx.javafxplugin") version "{JAVAFX_GRADLE_PLUGIN_VERSION}"')
    lines += ['}', '', 'repositories {', '    mavenCentral()', '}', '']
    if others:
        lines.append('dependencies {')
        lines += [f'    implementation("{d.notation()}")' for d in others]
        lines += ['}', '']
    if javafx:
        modules = list(dict.fromkeys(d.javafx_module for d in javafx))
        lines += [
            'javafx {',
            f'    version = "{javafx[0].version}"',
            f'    modules = listOf({_kotlin_list(modules)})',
            '}',
            '',
        ]
    if source_dir != STANDARD_SOURCE_DIR:
        lines += [
            'sourceSets {',
            '    main {',
            f'        java.setSrcDirs(listOf("{source_dir}"))',
            f'        resources.setSrcDirs(listOf("{source_dir}"))',
        ]
        if source_dir == '.':
            lines += [
                f'        java.exclude({_kotlin_list(_ROOT_EXCLUDES)})',
                f'        resources.include({_kotlin_list(_ROOT_RESOURCE_INCLUDES)})',
                f'        resources.exclude({_kotlin_list(_ROOT_EXCLUDES)})',
            ]
        else:
            lines.append('        resources.exclude("**/*.java")')
        lines += ['    }', '}', '']
    lines += [
        'application {',
        f'    mainClass = "{main_class}"',
        '}',
        '',
        'tasks.withType<JavaCompile>().configureEach {',
        f'    options.release = {java_release}',
        '    options.encoding = "UTF-8"',
        '}',
        '',
    ]
    return '\n'.join(lines)


def render_gradle_wrapper_properties() -> str:
    return (
        'distributionBase=GRADLE_USER_HOME\n'
        'distributionPath=wrapper/dists\n'
        f'distributionSha256Sum={GRADLE_DISTRIBUTION_SHA256}\n'
        f'distributionUrl=https\\://services.gradle.org/distributions/gradle-{GRADLE_VERSION}-bin.zip\n'
        'networkTimeout=10000\n'
        'validateDistributionUrl=true\n'
        'zipStoreBase=GRADLE_USER_HOME\n'
        'zipStorePath=wrapper/dists\n'
    )


# --- Planning + writing ----------------------------------------------------------------------------------


def plan_bootstrap_files(
    *,
    build_tool: str,
    folder_rel: str,
    project_name: str,
    main_class: str,
    dependencies: list[Dependency],
    java_release: int,
    source_dir: str,
) -> list[PlannedFile]:
    prefix = '' if folder_rel in ('', '.') else f'{folder_rel}/'
    if build_tool == 'maven':
        return [
            PlannedFile(
                f'{prefix}pom.xml',
                render_pom(
                    group_id=_group_id(main_class),
                    artifact_id=project_name,
                    main_class=main_class,
                    dependencies=dependencies,
                    java_release=java_release,
                    source_dir=source_dir,
                ),
                'lf',
            ),
            PlannedFile(f'{prefix}.mvn/wrapper/maven-wrapper.properties', render_maven_wrapper_properties(), 'lf'),
            PlannedFile(f'{prefix}mvnw', _read_template('mvnw'), 'lf', executable=True),
            PlannedFile(f'{prefix}mvnw.cmd', _read_template('mvnw.cmd'), 'crlf'),
        ]
    return [
        PlannedFile(f'{prefix}settings.gradle.kts', render_settings_gradle(project_name), 'lf'),
        PlannedFile(
            f'{prefix}build.gradle.kts',
            render_build_gradle(
                main_class=main_class,
                dependencies=dependencies,
                java_release=java_release,
                source_dir=source_dir,
            ),
            'lf',
        ),
        PlannedFile(f'{prefix}gradle/wrapper/gradle-wrapper.properties', render_gradle_wrapper_properties(), 'lf'),
    ]


def _write_planned_file(planned: PlannedFile, *, direct: bool) -> str:
    payload: dict[str, Any] = {
        'relative_path': planned.relative_path,
        'new_content': planned.content,
        'encoding': 'utf-8',
        'newline': planned.newline,
    }
    if direct:
        return str(apply_workspace_full_file.invoke(payload))
    return str(stage_create_file.invoke(payload))


def _mark_executable(path: Path) -> None:
    if os.name == 'nt' or not path.is_file():
        return
    try:
        path.chmod(path.stat().st_mode | 0o111)
    except OSError as exc:
        logger.info('could not chmod +x %s: %s', path, exc)


def _next_steps(build_tool: str, folder_rel: str, javafx: bool) -> str:
    where = f' in `{folder_rel}`' if folder_rel not in ('', '.') else ''
    if build_tool == 'maven':
        run = '`mvnw javafx:run`' if javafx else '`mvnw compile exec:java`'
        return (
            f'Build with `mvnw package` (Windows: `mvnw.cmd`){where}; run with {run}. The wrapper downloads '
            f'Maven {MAVEN_VERSION} into `~/.m2/wrapper` on first use and needs only a JDK (JAVA_HOME or `java` '
            'on PATH, which are left as they are).'
        )
    run = '`gradle run`'
    return (
        f'**Gradle wrapper scripts not generated:** `gradlew` needs the binary `gradle-wrapper.jar`, which this '
        f'tool does not ship. `gradle/wrapper/gradle-wrapper.properties` pins Gradle {GRADLE_VERSION}, so the Java '
        f'language server imports with that version and downloads it itself. To add `gradlew`, the user can run '
        f'`gradle wrapper --gradle-version {GRADLE_VERSION}`{where} once with any installed Gradle; until then '
        f'build with an installed `gradle build` / {run}. Tell the user this rather than hand-writing `gradlew`.'
    )


def _bootstrap(
    build_tool: str,
    main_class: str,
    dependencies: list[str] | None,
    java_release: int,
    source_dir: str,
    folder: str,
) -> str:
    blocked = mutation_tools_blocked_reason()
    if blocked:
        return blocked

    tool_kind = (build_tool or '').strip().lower()
    if tool_kind not in ('gradle', 'maven'):
        return (
            'Tool error: `build_tool` must be "gradle" or "maven". If the project gives no hint, ask the user '
            'which one they want before calling this tool.'
        )
    main_class = (main_class or '').strip()
    if not _MAIN_CLASS_RE.match(main_class):
        return f'Tool error: `main_class` `{main_class}` must be a fully qualified class name like `app.Main`.'
    try:
        release = int(java_release)
    except (TypeError, ValueError):
        return f'Tool error: `java_release` `{java_release}` must be a whole number such as 21.'
    if release < 8:
        return f'Tool error: `java_release` {release} is below 8.'
    try:
        deps = [parse_dependency(c) for c in (dependencies or []) if str(c or '').strip()]
    except ValueError as exc:
        return f'Tool error: {exc}'
    javafx_versions = {d.version for d in deps if d.is_javafx}
    if len(javafx_versions) > 1:
        return (
            'Tool error: JavaFX dependencies must share one version; got '
            f'{", ".join(sorted(javafx_versions))}.'
        )

    try:
        root = get_active_workspace_root()
        folder_path = normalize_relative_path(root, folder or '.')
    except ValueError as exc:
        return f'Tool error: {exc}'
    if folder_path.exists() and not folder_path.is_dir():
        return f'Tool error: `{folder}` is a file, not a folder.'
    folder_rel = folder_path.relative_to(root).as_posix()

    existing = find_build_file_above(root, folder_path)
    if existing is not None:
        rel = existing.relative_to(root).as_posix()
        return (
            f'Tool error: `{rel}` already exists, so this folder is already a Maven/Gradle project and its build '
            'tool owns the classpath. Add dependencies to that build file instead; nothing was written.'
        )

    try:
        src = _normalize_source_dir(source_dir) if (source_dir or '').strip() else _detect_source_dir(
            folder_path, main_class
        )
    except ValueError as exc:
        return f'Tool error: {exc}'
    try:
        normalize_relative_path(root, f'{folder_rel}/{src}')
    except ValueError as exc:
        return f'Tool error: {exc}'

    planned = plan_bootstrap_files(
        build_tool=tool_kind,
        folder_rel=folder_rel,
        project_name=_project_name(folder_path),
        main_class=main_class,
        dependencies=deps,
        java_release=release,
        source_dir=src,
    )
    clashes = [p.relative_path for p in planned if (root / p.relative_path).exists()]
    if clashes:
        return (
            f'Tool error: {", ".join(f"`{c}`" for c in clashes)} already exist; nothing was written. '
            'Remove or rename them first if they are leftovers.'
        )

    sid = (current_session_id.get() or '').strip()
    session = get_session(sid) if sid else None
    direct = bool(session and session.worker_apply_mode and direct_workspace_edits_active(session, apply_mode=True))

    written: list[str] = []
    notes: list[str] = []
    for item in planned:
        result = _write_planned_file(item, direct=direct)
        if result.lower().startswith('tool error'):
            done = ', '.join(f'`{p}`' for p in written) or 'none'
            undo = (
                ' Call `discard_staged_edits` on those paths to restore them.'
                if written and not direct else ''
            )
            return f'Tool error while writing `{item.relative_path}`: {result}\nAlready written: {done}.{undo}'
        if 'wait_for_write' in result:
            notes.append(f'`{item.relative_path}`: {result.strip()}')
        if item.executable:
            _mark_executable(root / item.relative_path)
        written.append(item.relative_path)

    has_javafx = bool(javafx_versions)
    tool_label = 'Maven' if tool_kind == 'maven' else 'Gradle'
    summary = [
        f'{tool_label} project set up in `{folder_rel or "."}` (source dir `{src}`, Java release {release}, '
        f'{len(deps)} dependenc{"y" if len(deps) == 1 else "ies"}'
        f'{", JavaFX plugin" if has_javafx else ""}).',
        'Files: ' + ', '.join(f'`{p}`' for p in written) + '.',
    ]
    if direct:
        summary.append('Written directly to disk (Auto-apply).')
    else:
        summary.append(
            'All files are staged drafts (already on disk, journaled). Review them, then keep them together with '
            '`transfer_staged_file_to_workspace` (`relative_paths` batch) or restore with `discard_staged_edits`.'
        )
    summary.append(_next_steps(tool_kind, folder_rel, has_javafx))
    summary.append(
        'The Java language server re-imports the folder as a build project once the build file is on disk; then '
        'check `lsp_get_diagnostics` on a source file.'
    )
    summary += notes
    return '\n'.join(summary)


@tool(JAVA_BOOTSTRAP_PROJECT_NAME, description=describe(
    'Set up a minimal dependency-managed Java project (Maven `pom.xml` + script-only Maven Wrapper, or Gradle '
    '`settings.gradle.kts` + `build.gradle.kts`) in a workspace folder that has no build file, so the Java '
    'language server can resolve third-party jars.',
    when=(
        'Java sources (existing or about to be created) need libraries beyond the JDK and neither the folder nor '
        'any parent up to the workspace root has `pom.xml`, `build.gradle(.kts)` or `settings.gradle(.kts)`. '
        'Ask the user Gradle vs Maven when nothing in the workspace hints at one.'
    ),
    not_=(
        'folders that already have a build file (refused; edit that file instead); hard-coding jar paths such as '
        '`~/.gradle/caches/...` or `~/.m2/repository/...` into scripts or build files.'
    ),
    shape=(
        '`build_tool` "gradle"|"maven"; `main_class` fully qualified (e.g. `journal.JournalApp`); `dependencies` '
        'list of `group:artifact:version` (`org.openjfx:javafx-*` adds the JavaFX plugin); `java_release` default '
        '21; `source_dir` empty keeps the current layout (e.g. `src`) instead of moving files to `src/main/java`; '
        '`folder` workspace-relative, empty = workspace root. Writes go through staging like `stage_create_file`.'
    ),
    verify='`lsp_get_diagnostics` on a `.java` file after the files are kept.',
))
def java_bootstrap_project(
    build_tool: Annotated[str, '"gradle" or "maven"'],
    main_class: Annotated[str, 'fully qualified entry point, e.g. journal.JournalApp'],
    dependencies: Annotated[list[str] | None, 'group:artifact:version coordinates'] = None,
    java_release: Annotated[int, 'javac --release value'] = DEFAULT_JAVA_RELEASE,
    source_dir: Annotated[str, 'source root relative to folder; empty = keep current layout'] = '',
    folder: Annotated[str, 'workspace-relative project folder; empty = workspace root'] = '',
) -> str:

    return _bootstrap(build_tool, main_class, dependencies, java_release, source_dir, folder)
