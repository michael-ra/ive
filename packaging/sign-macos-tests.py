"""Signing plan safety checks; never touches Keychain, codesign, or Apple."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sign_macos', Path(__file__).with_name('sign-macos.py'))
sign = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sign)
IDENTITY = 'Developer ID Application: AIFOREU GmbH (66Y43UAY3C)'


class SigningTests(unittest.TestCase):
    def test_requires_application_identity(self):
        self.assertEqual(sign.validate_identity(IDENTITY), '66Y43UAY3C')
        for wrong in ['-', 'Apple Development: User (66Y43UAY3C)', 'Developer ID Installer: Company (66Y43UAY3C)', 'a'*40]:
            with self.subTest(wrong=wrong), self.assertRaises(ValueError): sign.validate_identity(wrong)

    def test_same_or_existing_output_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); app = root/'IVE.app'; (app/'Contents').mkdir(parents=True)
            (app/'Contents/Info.plist').write_text('fixture')
            for output in [app, root, app/'nested']:
                with self.subTest(output=output), self.assertRaises(ValueError): sign.validate_paths(app, output)
            self.assertEqual(sign.validate_paths(app, root/'new')[1], (root/'new').resolve())

    def test_all_images_inside_out_and_outer_last(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            targets = sign.signing_targets(root, {'macho_images':[
                {'path':'Contents/MacOS/ive'}, {'path':str(sign.NODE)},
                {'path':'Contents/Resources/backend/_internal/libpython3.12.dylib'}]})
            self.assertEqual(targets[0], sign.NODE)
            self.assertEqual(targets[-1], Path('.'))
            self.assertEqual(len(targets), 4)

    def test_hardened_timestamp_no_deep_signing(self):
        command = sign.codesign_command(Path('app'), IDENTITY)
        self.assertIn('--timestamp', command); self.assertIn('runtime', command)
        self.assertNotIn('--deep', command); self.assertNotIn('--entitlements', command)
        self.assertEqual(sign.JIT_ENTITLEMENTS, {'com.apple.security.cs.allow-jit':True})

    def test_no_false_notarization_claim(self):
        text = sign.installation_notes(False)
        self.assertIn('NICHT von Apple notarisiert', text)
        self.assertNotIn('ad hoc signiert', text)
        self.assertNotIn('NICHT von Apple notarisiert', sign.installation_notes(True))

    def test_missing_or_ambiguous_identity_refused(self):
        record = '  1) '+('A'*40)+' "'+IDENTITY+'"\n'
        with patch.object(sign, 'run', return_value=record):
            self.assertEqual(sign.resolve_identity(IDENTITY), 'A'*40)
        for output in ['', record+record]:
            with patch.object(sign, 'run', return_value=output), self.assertRaises(ValueError): sign.resolve_identity(IDENTITY)

    def test_notary_rejection_never_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(sign, 'run', return_value='{"status":"Invalid"}') as run:
                with self.assertRaises(RuntimeError): sign.notary_submit(Path('IVE.zip'), 'profile', Path(directory))
                self.assertNotIn('--password', run.call_args.args[0])

    def test_node_entitlements_request_machine_readable_xml(self):
        details = SimpleNamespace(returncode=0, stdout='', stderr=(
            f'Authority={IDENTITY}\nTeamIdentifier=66Y43UAY3C\n'
            'Timestamp=Oct 11, 2026\nCodeDirectory flags=0x10000(runtime)\n'))
        xml = sign.plistlib.dumps(sign.JIT_ENTITLEMENTS).decode()
        with patch.object(sign, 'run', side_effect=['', xml]) as run, \
             patch.object(sign.subprocess, 'run', return_value=details):
            sign.verify_signature(Path('node'), IDENTITY, '66Y43UAY3C', node=True)
            self.assertIn('--xml', run.call_args.args[0])


if __name__ == '__main__': unittest.main()
