"""Cloud signing adapter tests: synthetic files/mocked tools, no account use."""
import importlib.util
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cloud_signing', Path(__file__).with_name('sign-macos-cloud.py'))
cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)
TEAM = '66Y43UAY3C'
IDENTITY = f'Developer ID Application: AIFOREU GmbH ({TEAM})'


class CloudSigningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.app = self.root/'IVE.app'
        (self.app/'Contents').mkdir(parents=True)
        (self.app/'Contents/Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier':'com.ive.desktop','CFBundleShortVersionString':'1.0.0','CFBundleVersion':'1.0.0'}))

    def test_options_match_accepted_archive_export(self):
        options = cloud.export_options(TEAM)
        self.assertEqual(options['signingStyle'], 'automatic')
        self.assertEqual(options['method'], 'developer-id')
        self.assertEqual(options['destination'], 'export')
        self.assertNotIn('signingCertificate', options)
        self.assertNotIn('provisioningProfiles', options)

    def test_archive_has_only_top_level_application_metadata(self):
        info = cloud.archive_metadata(self.app, TEAM)
        self.assertEqual(info['ArchiveVersion'], 2)
        self.assertEqual(info['ApplicationProperties']['ApplicationPath'], 'Applications/IVE.app')
        self.assertEqual(info['ApplicationProperties']['SigningIdentity'], '-')
        self.assertEqual(info['ApplicationProperties']['Team'], TEAM)
        plistlib.dumps(info)

    def test_existing_or_containing_paths_refused(self):
        for target in [self.app, self.root, self.app/'output']:
            with self.subTest(target=target), self.assertRaises(ValueError): cloud.SIGN.validate_paths(self.app, target)

    def test_team_input_cannot_inject_requirement(self):
        for wrong in ['66y43uay3c', TEAM+'\n', '" or true', '', TEAM+'1']:
            with self.subTest(wrong=wrong), self.assertRaises(ValueError): cloud.validate_team(wrong)

    def test_adhoc_is_hardened_and_never_requests_timestamp(self):
        command = cloud.adhoc_command(Path('node'), Path('node.plist'))
        self.assertIn('--timestamp=none', command); self.assertIn('runtime', command)
        self.assertNotIn('--deep', command)
        self.assertEqual(command[command.index('--sign')+1], '-')

    def test_export_uses_existing_account_without_credentials(self):
        command = cloud.export_command(Path('a.xcarchive'), Path('output'), Path('options.plist'))
        self.assertIn('-allowProvisioningUpdates', command)
        self.assertNotIn('-authenticationKeyPath', command)
        self.assertEqual(command[0], '/usr/bin/xcodebuild')

    def test_missing_runtime_in_export_fails_closed(self):
        with patch.object(cloud.SIGN.GUARD, 'inspect_bundle', return_value={'passed':True,'macho_images':[]}):
            with self.assertRaisesRegex(RuntimeError, 'inventory'):
                cloud.verify_export(self.app, ['Contents/MacOS/ive'], TEAM)

    def test_every_runtime_and_outer_app_verified_with_apple_anchor(self):
        paths = ['Contents/MacOS/ive', str(cloud.SIGN.NODE), 'Contents/Resources/backend/_internal/libpython3.12.dylib']
        audit = {'passed':True,'macho_images':[{'path':p} for p in paths]}
        details = subprocess.CompletedProcess([],0,'',f'Authority={IDENTITY}\nTeamIdentifier={TEAM}\n')
        with patch.object(cloud.SIGN.GUARD,'inspect_bundle',return_value=audit), \
             patch.object(cloud.subprocess,'run',return_value=details), \
             patch.object(cloud.SIGN,'verify_signature') as verify, patch.object(cloud.SIGN,'run') as run:
            result = cloud.verify_export(self.app, paths, TEAM)
        self.assertEqual(len(result),4); self.assertEqual(verify.call_count,4)
        self.assertEqual(sum(bool(call.kwargs['node']) for call in verify.call_args_list),1)
        requirements = [c.args[0] for c in run.call_args_list if '-R' in c.args[0]]
        self.assertEqual(len(requirements),4)
        self.assertTrue(all(c[c.index('-R')+1].startswith('=anchor apple generic') for c in requirements))

    def test_adhoc_export_is_not_success(self):
        audit={'passed':True,'macho_images':[{'path':'Contents/MacOS/ive'}]}
        with patch.object(cloud.SIGN.GUARD,'inspect_bundle',return_value=audit), \
             patch.object(cloud.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'','Signature=adhoc\n')):
            with self.assertRaisesRegex(RuntimeError,'did not Developer-ID-sign'):
                cloud.verify_export(self.app,['Contents/MacOS/ive'],TEAM)

    def test_export_failure_writes_honest_report_without_success(self):
        output=self.root/'new'; report={'completed':False,'signed':False,'notarized':False}
        with patch.object(cloud.SIGN,'run'), \
             patch.object(cloud.subprocess,'run',return_value=subprocess.CompletedProcess([],70)):
            with self.assertRaisesRegex(RuntimeError,'exit 70'):
                cloud.perform_export(self.app,output,TEAM,{'macho_images':[]},[],report)
        self.assertFalse(report['signed']); self.assertFalse(report['completed'])
        self.assertEqual(report['xcode_exit_code'],70)
        self.assertTrue((output/'cloud-signing-report.json').is_file())


if __name__ == '__main__': unittest.main()
