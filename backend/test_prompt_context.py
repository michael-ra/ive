from pathlib import Path
import tempfile
import unittest
from prompt_context import project_instructions, mirrored_entry_ids
from memory_sync import get_provider


class PromptContextTests(unittest.TestCase):
    def test_native_rules_are_not_injected_twice_and_distinct_rules_survive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'AGENTS.md').write_text('Keep exact project instructions.')
            (root/'CLAUDE.md').write_text('Keep exact project instructions.')
            self.assertNotIn('Keep exact project instructions.', project_instructions('claude', root))
            self.assertEqual(project_instructions('codex', root), '')
            (root/'AGENTS.md').write_text('A distinct rule for every agent.')
            self.assertIn('A distinct rule for every agent.', project_instructions('claude', root))
            self.assertEqual((root/'CLAUDE.md').read_text(), 'Keep exact project instructions.')

    def test_only_exact_mirrored_notes_are_removed_not_updated_or_global_notes(self):
        with tempfile.TemporaryDirectory() as directory:
            entries = [{'id':'1','workspace_id':'w','name':'API','type':'project','description':'Contract','content':'Never rename field foo.'},
                       {'id':'2','workspace_id':None,'name':'Global','type':'user','content':'Reply briefly.'}]
            get_provider('claude').write_memory(directory, 'Project rules.', entries=entries)
            cfg = {'cli_type':'claude','workspace_id':'w','workspace_path':directory}
            self.assertEqual(mirrored_entry_ids(cfg,entries), {'1'})
            entries[0]['content'] = 'New instruction not yet mirrored.'
            self.assertEqual(mirrored_entry_ids(cfg,entries),set())

    def test_codex_override_is_used_for_dedup(self):
        with tempfile.TemporaryDirectory() as directory:
            entry = {'id':'1','workspace_id':'w','name':'Exact','type':'project','content':'BLUE-123'}
            get_provider('codex').write_memory(directory,'base',entries=[entry])
            (Path(directory)/'AGENTS.override.md').write_text('Override without the managed note.')
            self.assertEqual(mirrored_entry_ids({'cli_type':'codex','workspace_id':'w','workspace_path':directory},[entry]),set())


if __name__ == '__main__':
    unittest.main()
