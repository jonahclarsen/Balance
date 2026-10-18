#!/usr/bin/env python3
"""Install only the read-only native messaging host for a user-selected extension ID."""
import json
import os
from pathlib import Path
import re
import shutil
import sys
if len(sys.argv)!=2 or not re.fullmatch('[a-p]{32}',sys.argv[1]):
    raise SystemExit('Usage: python3 install-chrome.py EXTENSION_ID (from chrome://extensions)')
root=Path.home()/'.local/share/balance-situate'
root.mkdir(mode=0o700,parents=True,exist_ok=True)
host=root/'native-host.py'
shutil.copyfile(Path(__file__).with_name('native-host.py'),host)
os.chmod(host,0o700)
manifest={'name':'app.balance.situate','description':'Read-only Balance Situate status','path':str(host),'type':'stdio','allowed_origins':['chrome-extension://'+sys.argv[1]+'/']}
folder=Path.home()/'Library/Application Support/Google/Chrome/NativeMessagingHosts'
folder.mkdir(parents=True,exist_ok=True)
path=folder/'app.balance.situate.json'
path.write_text(json.dumps(manifest,indent=2)+'\n');os.chmod(path,0o600)
print('Installed. Open Balance, enable Situate, then reload the extension.')
