"""Registry wiring for split workspace edit tools."""

import unittest

from nemo_backend.domain import RuntimeToolsConfig
from nemo_backend.edit_tool import edit_tools_for_strict
from nemo_backend.state import runtime_config
from nemo_backend.tool_registry import hitl_diff_pause_tools, manager_tools_and_map, worker_tools_and_map


class TestEditToolsRegistry(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_tools = runtime_config.tools

    def tearDown(self) -> None:
        runtime_config.tools = self._saved_tools

    def test_standard_includes_three_tools(self) -> None:
        runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False)
        names = [t.name for t in edit_tools_for_strict(False)]
        self.assertEqual(
            names,
            [
                'apply_workspace_full_file',
                'replace_workspace_line_range',
                'replace_workspace_snippet',
            ],
        )
        tools, m = worker_tools_and_map(True)
        bound_edit = [t.name for t in tools if t.name in names]
        self.assertEqual(bound_edit, names)
        self.assertEqual(hitl_diff_pause_tools(), frozenset(names))

    def test_strict_omits_snippet_tool(self) -> None:
        runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=True)
        names = [t.name for t in edit_tools_for_strict(True)]
        self.assertEqual(
            names,
            ['apply_workspace_full_file', 'replace_workspace_line_range'],
        )
        self.assertEqual(hitl_diff_pause_tools(), frozenset(names))
        self.assertNotIn('replace_workspace_snippet', hitl_diff_pause_tools())

    def test_manager_worker_split(self) -> None:
        runtime_config.tools = RuntimeToolsConfig(edit_tools_strict=False)
        read_names = {'get_workspace_snapshot', 'list_workspace_directory', 'read_workspace_file', 'search_workspace'}
        edit_names = {t.name for t in edit_tools_for_strict(False)}

        mgr_on, mgr_map_on = manager_tools_and_map(True)
        self.assertEqual(read_names | {'delegate_workspace_task'}, {t.name for t in mgr_on})
        self.assertEqual(mgr_map_on.keys(), {t.name for t in mgr_on})

        mgr_off, mgr_map_off = manager_tools_and_map(False)
        self.assertEqual(read_names, {t.name for t in mgr_off})
        self.assertNotIn('delegate_workspace_task', mgr_map_off)

        w_on, w_map_on = worker_tools_and_map(True)
        self.assertEqual(read_names | edit_names, {t.name for t in w_on})
        self.assertNotIn('delegate_workspace_task', w_map_on)

        w_off, w_map_off = worker_tools_and_map(False)
        self.assertEqual(read_names, {t.name for t in w_off})
        self.assertNotIn('delegate_workspace_task', w_map_off)


if __name__ == '__main__':
    unittest.main()
