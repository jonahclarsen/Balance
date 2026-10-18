import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import runpy
import base64
import hashlib

ROOT=Path(__file__).resolve().parent
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/file);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
host=module('host','native-host.py')
sync=module('sync','sync-frank.py')
class HostTests(unittest.TestCase):
    def test_private_status_only_and_file_guards(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'status.json'
            path.write_text(json.dumps({'version':1,'modes':[],'secret':'SYNTHETIC_PRIVATE'}));path.chmod(0o600)
            self.assertNotIn('secret',host.read_status(path))
            path.chmod(0o644)
            with self.assertRaises(ValueError):host.read_status(path)
            path.chmod(0o600);link=Path(root)/'link';link.symlink_to(path)
            with self.assertRaises(OSError):host.read_status(link)
            path.write_text(' '*512001)
            with self.assertRaises(ValueError):host.read_status(path)
    def test_frank_exports_only_numeric_thread_ids(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'sessions.json'
            path.write_text(json.dumps({'123456789012345678':{'sessionId':'SYNTHETIC_PRIVATE','prompt':'NEVER_TRANSFER'},'not-a-thread':{}}))
            result=subprocess.run([sys.executable,'-c',sync.REMOTE,str(path)],capture_output=True,text=True,check=True)
            self.assertEqual(sync.validate(json.loads(result.stdout)),{'version':1,'threads':['123456789012345678']})
            self.assertNotIn('PRIVATE',result.stdout)
            path.write_text(result.stdout);path.chmod(0o600)
            self.assertEqual(host.with_frank({'version':1},path)['frankThreads'],['123456789012345678'])
            path.chmod(0o644);self.assertNotIn('frankThreads',host.with_frank({'version':1},path))
    def test_installer_uses_bundled_public_identity_in_a_private_host(self):
        with tempfile.TemporaryDirectory() as root:
            base=Path(root)
            with patch.object(Path,'home',return_value=base), patch.object(sys,'argv',['install-chrome.py']):
                runpy.run_path(str(ROOT/'install-chrome.py'),run_name='__main__')
            value=json.loads((base/'Library/Application Support/Google/Chrome/NativeMessagingHosts/app.balance.situate.json').read_text())
            key=json.loads((ROOT/'chrome/manifest.json').read_text())['key']
            digest=hashlib.sha256(base64.b64decode(key)).digest()[:16]
            identity=''.join(chr(97+n) for byte in digest for n in (byte>>4,byte&15))
            self.assertEqual(value['allowed_origins'],['chrome-extension://'+identity+'/'])
            self.assertEqual((base/'.local/share/balance-situate/native-host.py').stat().st_mode & 0o777,0o700)
    def test_invalid_ids_and_requests_rejected(self):
        for threads in [['bad'],['1; exit'],[{}]]:
            with self.assertRaises(ValueError):sync.validate({'version':1,'threads':threads})
        message=json.dumps({'type':'grant','mode':'touch-grass'}).encode()
        result=subprocess.run([sys.executable,str(ROOT/'native-host.py')],input=struct.pack('=I',len(message))+message,capture_output=True,check=True)
        self.assertIn('error',json.loads(result.stdout[4:]))
        result=subprocess.run([sys.executable,str(ROOT/'native-host.py')],input=struct.pack('=I',1025),capture_output=True,check=True)
        self.assertEqual(result.stdout,b'')
if __name__=='__main__':unittest.main()
