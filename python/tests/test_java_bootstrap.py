"""``java_bootstrap_project``: staged Maven/Gradle build files for a Java folder with no build file."""

from __future__ import annotations

from pathlib import Path

import pytest

from clara_coder_backend.domain import SessionState
from clara_coder_backend.hitl.tool_registry import worker_tools_and_map
from clara_coder_backend.llm.prompt_blocks import edit_semantics_block
from clara_coder_backend.tools.java_bootstrap import (
    GRADLE_VERSION,
    JAVA_BOOTSTRAP_PROJECT_NAME,
    JAVAFX_GRADLE_PLUGIN_VERSION,
    JAVAFX_MAVEN_PLUGIN_VERSION,
    MAVEN_VERSION,
    MAVEN_WRAPPER_VERSION,
    java_bootstrap_project,
)


def _loose_journal_app(ws: Path) -> None:
    pkg = ws / 'src' / 'journal'
    pkg.mkdir(parents=True)
    (pkg / 'JournalApp.java').write_text('package journal;\n\npublic class JournalApp {}\n', encoding='utf-8')
    (pkg / 'journal.css').write_text('.root {}\n', encoding='utf-8')


def _run(**kwargs: object) -> str:
    return java_bootstrap_project.invoke(kwargs)


def test_maven_bootstrap_stages_pom_and_script_only_wrapper(staging_env) -> None:
    ws = staging_env.workspace
    _loose_journal_app(ws)

    out = _run(
        build_tool='maven',
        main_class='journal.JournalApp',
        dependencies=['com.google.code.gson:gson:2.13.2'],
    )

    assert not out.startswith('Tool error'), out
    assert 'source dir `src`' in out
    paths = {'pom.xml', '.mvn/wrapper/maven-wrapper.properties', 'mvnw', 'mvnw.cmd'}
    assert paths <= set(staging_env.session.pending_edit_stagings)
    for rel in paths:
        assert (ws / rel).is_file(), rel

    pom = (ws / 'pom.xml').read_text(encoding='utf-8')
    assert '<maven.compiler.release>21</maven.compiler.release>' in pom
    assert '<project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>' in pom
    assert '<sourceDirectory>src</sourceDirectory>' in pom
    assert '<directory>src</directory>' in pom
    assert '<exclude>**/*.java</exclude>' in pom
    assert '<groupId>com.google.code.gson</groupId>' in pom
    assert '<version>2.13.2</version>' in pom
    assert '<exec.mainClass>journal.JournalApp</exec.mainClass>' in pom
    assert '<groupId>journal</groupId>' in pom
    assert 'javafx-maven-plugin' not in pom

    props = (ws / '.mvn/wrapper/maven-wrapper.properties').read_text(encoding='utf-8')
    assert 'distributionType=only-script' in props
    assert f'wrapperVersion={MAVEN_WRAPPER_VERSION}' in props
    assert f'apache-maven-{MAVEN_VERSION}-bin.zip' in props
    assert not list(ws.rglob('*.jar'))

    mvnw = (ws / 'mvnw').read_bytes()
    assert mvnw.startswith(b'#!/bin/sh')
    assert b'\r\n' not in mvnw
    assert f'version {MAVEN_WRAPPER_VERSION}'.encode() in mvnw
    assert b'\r\n' in (ws / 'mvnw.cmd').read_bytes()

    # Existing sources are left where they are.
    assert (ws / 'src/journal/JournalApp.java').is_file()
    assert not (ws / 'src/main').exists()


def test_gradle_bootstrap_stages_kotlin_dsl_without_wrapper_jar(staging_env) -> None:
    ws = staging_env.workspace
    _loose_journal_app(ws)

    out = _run(
        build_tool='gradle',
        main_class='journal.JournalApp',
        dependencies=['com.google.code.gson:gson:2.13.2'],
        java_release=17,
    )

    assert not out.startswith('Tool error'), out
    assert 'Gradle wrapper scripts not generated' in out
    assert f'gradle wrapper --gradle-version {GRADLE_VERSION}' in out
    paths = {'settings.gradle.kts', 'build.gradle.kts', 'gradle/wrapper/gradle-wrapper.properties'}
    assert paths <= set(staging_env.session.pending_edit_stagings)
    assert not (ws / 'gradlew').exists()
    assert not (ws / 'gradlew.bat').exists()
    assert not list(ws.rglob('*.jar'))

    settings = (ws / 'settings.gradle.kts').read_text(encoding='utf-8')
    assert settings == f'rootProject.name = "{ws.name.lower()}"\n'

    build = (ws / 'build.gradle.kts').read_text(encoding='utf-8')
    assert 'application' in build
    assert 'mainClass = "journal.JournalApp"' in build
    assert 'mavenCentral()' in build
    assert 'implementation("com.google.code.gson:gson:2.13.2")' in build
    assert 'options.release = 17' in build
    assert 'java.setSrcDirs(listOf("src"))' in build
    assert 'resources.exclude("**/*.java")' in build
    assert 'javafx' not in build

    props = (ws / 'gradle/wrapper/gradle-wrapper.properties').read_text(encoding='utf-8')
    assert f'gradle-{GRADLE_VERSION}-bin.zip' in props
    assert 'distributionSha256Sum=' in props


def test_standard_layout_needs_no_source_overrides(staging_env) -> None:
    ws = staging_env.workspace
    (ws / 'src/main/java/app').mkdir(parents=True)
    (ws / 'src/main/java/app/Main.java').write_text('package app;\nclass Main {}\n', encoding='utf-8')

    assert not _run(build_tool='maven', main_class='app.Main', folder='').startswith('Tool error')
    pom = (ws / 'pom.xml').read_text(encoding='utf-8')
    assert '<sourceDirectory>' not in pom
    assert '<resources>' not in pom


def test_new_folder_defaults_to_standard_layout(staging_env) -> None:
    ws = staging_env.workspace

    out = _run(build_tool='gradle', main_class='demo.App', folder='tools/demo')

    assert not out.startswith('Tool error'), out
    assert 'source dir `src/main/java`' in out
    build = (ws / 'tools/demo/build.gradle.kts').read_text(encoding='utf-8')
    assert 'sourceSets' not in build
    assert 'dependencies {' not in build
    assert (ws / 'tools/demo/settings.gradle.kts').read_text(encoding='utf-8') == 'rootProject.name = "demo"\n'


def test_explicit_source_dir_overrides_detection(staging_env) -> None:
    ws = staging_env.workspace
    _loose_journal_app(ws)

    out = _run(build_tool='maven', main_class='journal.JournalApp', source_dir='src/main/java')

    assert not out.startswith('Tool error'), out
    assert '<sourceDirectory>' not in (ws / 'pom.xml').read_text(encoding='utf-8')


@pytest.mark.parametrize(
    ('build_file', 'folder'),
    [
        ('build.gradle', ''),
        ('pom.xml', 'apps/journal'),
        ('settings.gradle.kts', 'apps/journal'),
        ('apps/build.gradle.kts', 'apps/journal'),
    ],
)
def test_refuses_when_folder_or_ancestor_has_build_file(staging_env, build_file: str, folder: str) -> None:
    ws = staging_env.workspace
    (ws / 'apps/journal').mkdir(parents=True)
    (ws / build_file).write_text('// existing\n', encoding='utf-8')
    before = sorted(p.relative_to(ws).as_posix() for p in ws.rglob('*'))

    out = _run(build_tool='maven', main_class='journal.JournalApp', folder=folder)

    assert out.startswith('Tool error')
    assert build_file in out
    assert 'nothing was written' in out
    assert staging_env.session.pending_edit_stagings == {}
    assert sorted(p.relative_to(ws).as_posix() for p in ws.rglob('*')) == before


def test_build_file_in_sibling_folder_does_not_block(staging_env) -> None:
    ws = staging_env.workspace
    (ws / 'other').mkdir()
    (ws / 'other/pom.xml').write_text('<project/>\n', encoding='utf-8')

    out = _run(build_tool='gradle', main_class='app.Main', folder='journal')

    assert not out.startswith('Tool error'), out
    assert (ws / 'journal/build.gradle.kts').is_file()


def test_refuses_when_wrapper_file_already_exists(staging_env) -> None:
    ws = staging_env.workspace
    (ws / 'mvnw').write_text('#!/bin/sh\n', encoding='utf-8')

    out = _run(build_tool='maven', main_class='app.Main')

    assert out.startswith('Tool error')
    assert '`mvnw`' in out
    assert not (ws / 'pom.xml').exists()
    assert staging_env.session.pending_edit_stagings == {}


def test_javafx_maven_adds_plugin_with_main_class(staging_env) -> None:
    ws = staging_env.workspace
    _loose_journal_app(ws)

    out = _run(
        build_tool='maven',
        main_class='journal.JournalApp',
        dependencies=['org.openjfx:javafx-controls:21.0.8', 'org.openjfx:javafx-fxml:21.0.8'],
    )

    assert not out.startswith('Tool error'), out
    assert 'JavaFX plugin' in out
    assert '`mvnw javafx:run`' in out
    pom = (ws / 'pom.xml').read_text(encoding='utf-8')
    assert '<artifactId>javafx-controls</artifactId>' in pom
    assert '<artifactId>javafx-fxml</artifactId>' in pom
    assert '<artifactId>javafx-maven-plugin</artifactId>' in pom
    assert f'<version>{JAVAFX_MAVEN_PLUGIN_VERSION}</version>' in pom
    assert '<mainClass>journal.JournalApp</mainClass>' in pom
    assert 'exec.mainClass' not in pom
    # No hard-coded jar paths anywhere.
    assert '.gradle' not in pom and '.m2' not in pom


def test_javafx_gradle_uses_plugin_modules_instead_of_dependencies(staging_env) -> None:
    ws = staging_env.workspace
    _loose_journal_app(ws)

    out = _run(
        build_tool='gradle',
        main_class='journal.JournalApp',
        dependencies=[
            'org.openjfx:javafx-controls:21.0.8',
            'org.openjfx:javafx-fxml:21.0.8',
            'com.google.code.gson:gson:2.13.2',
        ],
    )

    assert not out.startswith('Tool error'), out
    build = (ws / 'build.gradle.kts').read_text(encoding='utf-8')
    assert f'id("org.openjfx.javafxplugin") version "{JAVAFX_GRADLE_PLUGIN_VERSION}"' in build
    assert 'version = "21.0.8"' in build
    assert 'modules = listOf("javafx.controls", "javafx.fxml")' in build
    assert 'implementation("com.google.code.gson:gson:2.13.2")' in build
    assert 'implementation("org.openjfx' not in build


def test_javafx_versions_must_match(staging_env) -> None:
    out = _run(
        build_tool='gradle',
        main_class='app.Main',
        dependencies=['org.openjfx:javafx-controls:21.0.8', 'org.openjfx:javafx-fxml:22'],
    )
    assert out.startswith('Tool error')
    assert not (staging_env.workspace / 'build.gradle.kts').exists()


@pytest.mark.parametrize(
    'kwargs',
    [
        {'build_tool': 'ant', 'main_class': 'app.Main'},
        {'build_tool': 'maven', 'main_class': 'app.Main;'},
        {'build_tool': 'maven', 'main_class': 'app.Main', 'dependencies': ['gson']},
        {'build_tool': 'maven', 'main_class': 'app.Main', 'dependencies': ['a:b:<1>']},
        {'build_tool': 'maven', 'main_class': 'app.Main', 'source_dir': '../outside'},
        {'build_tool': 'maven', 'main_class': 'app.Main', 'folder': '../outside'},
    ],
)
def test_rejects_bad_arguments_without_writing(staging_env, kwargs: dict[str, object]) -> None:
    out = _run(**kwargs)
    assert out.startswith('Tool error'), out
    assert list(staging_env.workspace.iterdir()) == []


def test_editor_off_blocks_writes(staging_env) -> None:
    staging_env.session.worker_apply_mode = False
    out = _run(build_tool='maven', main_class='app.Main')
    assert out.startswith('Tool error')
    assert not (staging_env.workspace / 'pom.xml').exists()


def test_auto_apply_writes_directly(staging_env) -> None:
    staging_env.session.auto_apply_mode = True
    ws = staging_env.workspace

    out = _run(build_tool='maven', main_class='app.Main')

    assert not out.startswith('Tool error'), out
    assert 'Written directly to disk' in out
    assert (ws / 'pom.xml').is_file()
    assert (ws / 'mvnw.cmd').is_file()
    assert staging_env.session.pending_edit_stagings == {}


def test_tool_is_bound_only_in_editor_mode() -> None:
    session = SessionState()
    editor_tools, _ = worker_tools_and_map(True, session=session)
    read_only_tools, _ = worker_tools_and_map(False, session=session)
    assert JAVA_BOOTSTRAP_PROJECT_NAME in {t.name for t in editor_tools}
    assert JAVA_BOOTSTRAP_PROJECT_NAME not in {t.name for t in read_only_tools}


@pytest.mark.parametrize('direct', [False, True])
def test_edit_semantics_tells_model_to_bootstrap_java_builds(direct: bool) -> None:
    block = edit_semantics_block(direct=direct)
    assert '`java_bootstrap_project`' in block
    assert 'Never hard-code jar' in block
    assert block.index('`lsp_create_java_file`') < block.index('`java_bootstrap_project`')
