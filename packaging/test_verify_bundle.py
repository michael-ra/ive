"""Isolated tests: synthetic Mach-O headers and mocked Apple tool output."""
import importlib.util
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('verify_bundle', Path(__file__).with_name('verify-bundle.py'))
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


def thin(cpu=guard.ARM64, kind=6, subtype=0):
    return b'\xcf\xfa\xed\xfe' + struct.pack('<III', cpu, subtype, kind) + bytes(16)


def load_commands(minimum='11.0', dependency='@rpath/libpython3.12.dylib', platform='1'):
    return f'''image:
Load command 0
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform {platform}
    minos {minimum}
      sdk 15.0
Load command 1
      cmd LC_LOAD_DYLIB
  cmdsize 80
     name {dependency} (offset 24)
Load command 2
      cmd LC_RPATH
  cmdsize 40
     path @loader_path/../Frameworks (offset 12)
'''


class BundleGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def inspect(self, output=None, **kwargs):
        result = subprocess.CompletedProcess([], 0, output or load_commands(), '')
        with patch.object(guard.subprocess, 'run', return_value=result) as tool:
            report = guard.inspect_bundle(self.root, otool='/usr/bin/otool', **kwargs)
        return report, tool

    def codes(self, report):
        return [item['code'] for item in report['violations']]

    def test_valid_runtime_checks_arm64_and_uses_argument_list(self):
        self.write('Contents/MacOS/IVE weird $(name)', thin(kind=2))
        report, tool = self.inspect()
        self.assertTrue(report['passed'], report)
        self.assertEqual(report['macho_images'][0]['architectures'], ['arm64'])
        self.assertEqual(tool.call_args.args[0][:4], ['/usr/bin/otool', '-arch', 'arm64', '-l'])
        self.assertEqual(tool.call_args.args[0][4], str((self.root/'Contents/MacOS/IVE weird $(name)').resolve()))

    def test_valid_universal_with_arm64_slice(self):
        x86, arm = thin(0x01000007), thin()
        data = b'\xca\xfe\xba\xbe' + struct.pack('>I', 2)
        data += struct.pack('>IIIII', 0x01000007, 0, 48, len(x86), 0)
        data += struct.pack('>IIIII', guard.ARM64, 0, 80, len(arm), 0)
        path = self.write('universal', data+x86+arm)
        self.assertEqual(len(guard.macho_slices(path)), 2)
        self.assertTrue(self.inspect()[0]['passed'])

    def test_x86_only_rejected_even_if_extension_is_not_dylib(self):
        self.write('extension.so', thin(0x01000007))
        report, tool = self.inspect()
        self.assertIn('arm64_missing', self.codes(report))
        tool.assert_not_called()

    def test_arm64e_not_generic_arm64(self):
        self.write('executable', thin(subtype=2))
        self.assertIn('arm64_missing', self.codes(self.inspect()[0]))

    def test_newer_macos_rejected_and_override_honored(self):
        self.write('node', thin(kind=2))
        self.assertIn('minimum_macos_too_new', self.codes(self.inspect(load_commands('14.0'))[0]))
        self.assertTrue(self.inspect(load_commands('14.0'), max_macos='14.0')[0]['passed'])
        self.assertTrue(self.inspect(load_commands('13.5'))[0]['passed'])

    def test_old_macos_command_supported(self):
        self.write('lib', thin())
        output = 'cmd LC_VERSION_MIN_MACOSX\nversion 10.15\nsdk 13.0\n'
        self.assertTrue(self.inspect(output)[0]['passed'])

    def test_missing_os_floor_and_non_macos_rejected(self):
        self.write('lib', thin())
        self.assertIn('minimum_macos_missing', self.codes(self.inspect('cmd LC_UUID\n')[0]))
        self.assertIn('unsupported_platform', self.codes(self.inspect(load_commands(platform='2'))[0]))

    def test_external_build_machine_dependencies_rejected(self):
        self.write('lib', thin())
        for dependency in ['/opt/homebrew/lib/libx.dylib', '/Users/person/libx.dylib',
                           '/Library/Frameworks/Python.framework/Python', '/usr/local/lib/libx.dylib']:
            with self.subTest(dependency=dependency):
                self.assertIn('external_loader_path', self.codes(self.inspect(load_commands(dependency=dependency))[0]))

    def test_expected_system_and_bundle_dependencies_allowed(self):
        for dependency in ['/usr/lib/libSystem.B.dylib', '/System/Library/Frameworks/AppKit.framework/AppKit',
                           '@rpath/libx.dylib', '@loader_path/libx.dylib', '@executable_path/../libx.dylib',
                           '@loader_path', '@executable_path']:
            with self.subTest(dependency=dependency):
                self.assertFalse(guard.unsafe_loader_path(dependency))

    def test_rpath_external_and_weak_dependency_are_inspected(self):
        self.write('lib', thin())
        output = load_commands().replace('@loader_path/../Frameworks', '/Users/builder/lib')
        self.assertIn('external_loader_path', self.codes(self.inspect(output)[0]))
        output = load_commands(dependency='/opt/homebrew/lib/libx.dylib').replace('LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB')
        self.assertIn('external_loader_path', self.codes(self.inspect(output)[0]))

    def test_prohibited_state_and_private_keys(self):
        self.write('app', thin(kind=2))
        names = ['commander.db', 'state.sqlite3', '.env', '.env.production',
                 'accounts/credentials.json', '.claude/settings.json', 'id_ed25519']
        for name in names:
            self.write(name, b'fixture')
        self.write('client.pem', b'-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----')
        report, _ = self.inspect()
        self.assertEqual(self.codes(report).count('bundled_private_state'), len(names)+1)

    def test_legitimate_runtime_files_are_not_secret_heuristics(self):
        self.write('app', thin())
        self.write('certifi/cacert.pem', b'-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----')
        self.write('keyring/credentials.py', b'TOKEN = "documentation"')
        self.write('example/.env.example', b'EXAMPLE=placeholder')
        self.write('asyncio/sslproto.py', b'-----BEGIN PRIVATE KEY-----')
        self.assertTrue(self.inspect()[0]['passed'])

    def test_java_class_magic_is_not_macho(self):
        path = self.write('Example.class', b'\xca\xfe\xba\xbe\x00\x00\x00\x41' + bytes(100))
        self.assertEqual(guard.macho_slices(path), [])

    def test_non_runtime_object_not_claimed_as_loaded_image(self):
        self.write('lib', thin())
        self.write('module.o', thin(kind=1))
        report, _ = self.inspect()
        self.assertTrue(report['passed'])
        self.assertEqual(report['ignored_macho_objects'], ['module.o'])

    def test_symlinks_outside_bundle_and_broken_links_rejected(self):
        self.write('lib', thin())
        (self.root/'outside').symlink_to(self.root.parent)
        (self.root/'broken').symlink_to(self.root/'absent')
        report, _ = self.inspect()
        self.assertIn('external_symlink', self.codes(report))
        self.assertIn('broken_symlink', self.codes(report))

    def test_internal_symlink_resolves_without_duplicate_inspection(self):
        self.write('Versions/A/Python', thin())
        (self.root/'Python').symlink_to('Versions/A/Python')
        report, tool = self.inspect()
        self.assertTrue(report['passed'])
        self.assertEqual(tool.call_count, 1)

    def test_tool_failure_fails_closed(self):
        self.write('lib', thin())
        with patch.object(guard.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'bad')):
            report = guard.inspect_bundle(self.root, otool='/usr/bin/otool')
        self.assertIn('load_command_inspection_failed', self.codes(report))

    def test_directory_without_runtime_is_not_success(self):
        self.write('README', b'not an app')
        self.assertIn('runtime_images_missing', self.codes(self.inspect()[0]))


if __name__ == '__main__':
    unittest.main()
