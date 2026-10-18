#!/usr/bin/env python3
"""Install only the read-only native messaging host for a user-selected extension ID."""
import json
import base64
import hashlib
import os
from pathlib import Path
import re
import shutil
import sys
if len(sys.argv)>2:
    raise SystemExit('Usage: python3 install-chrome.py [EXTENSION_ID]')
if len(sys.argv)==2:
    extension_id=sys.argv[1]
else:
    manifest=json.loads((Path(__file__).parent/'chrome/manifest.json').read_text())
    digest=hashlib.sha256(base64.b64decode(manifest['key'])).digest()[:16]
    extension_id=''.join(chr(97+n) for byte in digest for n in (byte>>4,byte&15))
if not re.fullmatch('[a-p]{32}',extension_id): raise SystemExit('Invalid extension ID')
root=Path.home()/'.local/share/balance-situate'
root.mkdir(mode=0o700,parents=True,exist_ok=True)
os.chmod(root,0o700)
host=root/'native-host.py'
shutil.copyfile(Path(__file__).with_name('native-host.py'),host)
os.chmod(host,0o700)
manifest={'name':'app.balance.situate','description':'Read-only Balance Situate status','path':str(host),'type':'stdio','allowed_origins':['chrome-extension://'+extension_id+'/']}
folder=Path.home()/'Library/Application Support/Google/Chrome/NativeMessagingHosts'
folder.mkdir(parents=True,exist_ok=True)
path=folder/'app.balance.situate.json'
path.write_text(json.dumps(manifest,indent=2)+'\n');os.chmod(path,0o600)
print('Installed. Open Balance, enable Situate, then reload the extension.')
