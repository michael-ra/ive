"""Host logins must retain the CLI's normal credential lookup."""
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import ive_cli_profile as profiles


class ProfileLoginTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.host = self.root / 'host'
        self.host.mkdir()
        self.profile = SimpleNamespace(id='claude', home_dir='~/.claude', config_dir_env='CLAUDE_CONFIG_DIR',
                                       config_dir_subpath='.claude', hook_decision_protocol='')
        for target, value in [('_real_home', lambda: self.host), ('get_profile', lambda _: self.profile),
                              ('IVE_CLI_PROFILES_DIR', self.root / 'managed'),
                              ('ACCOUNT_HOMES_DIR', self.root / 'accounts')]:
            patcher = patch.object(profiles, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.seed = patch.object(profiles, '_seed_cli_config').start()
        self.addCleanup(patch.stopall)
        patch.object(profiles, '_safe_symlink_dotfiles').start()
        patch.dict(os.environ, {'IVE_USE_HOST_LOGIN': '1'}).start()

    def test_host_claude_uses_terminal_login_without_rewriting_credentials(self):
        config = self.host / '.claude'
        config.mkdir()
        credential = config / '.credentials.json'
        credential.write_text('unchanged credential fixture')
        env = profiles.prepare_ive_cli_env('claude')
        self.assertEqual(env['HOME'], str(self.host))
        self.assertNotIn('CLAUDE_CONFIG_DIR', env)
        self.assertEqual(credential.read_text(), 'unchanged credential fixture')

    def test_explicit_account_remains_isolated_and_never_inherits_host_credentials(self):
        env = profiles.prepare_ive_cli_env('claude', account_id='work')
        self.assertEqual(env['HOME'], str(self.root / 'accounts/work'))
        self.assertEqual(env['CLAUDE_CONFIG_DIR'], str(self.root / 'accounts/work/.claude'))
        self.seed.assert_not_called()

    def test_host_login_opt_out_still_selects_managed_profile(self):
        with patch.dict(os.environ, {'IVE_USE_HOST_LOGIN': '0'}):
            env = profiles.prepare_ive_cli_env('claude')
        self.assertEqual(env['HOME'], str(self.root / 'managed/claude'))
        self.assertEqual(env['CLAUDE_CONFIG_DIR'], str(self.root / 'managed/claude/.claude'))
        self.seed.assert_called_once_with('claude', self.root / 'managed/claude')

    def test_other_cli_profiles_keep_their_config_environment(self):
        self.profile = SimpleNamespace(id='codex', home_dir='~/.codex', config_dir_env='CODEX_HOME',
                                       config_dir_subpath='.codex', hook_decision_protocol='')
        env = profiles.prepare_ive_cli_env('codex')
        self.assertEqual(env['CODEX_HOME'], str(self.host / '.codex'))


if __name__ == '__main__':
    unittest.main()
