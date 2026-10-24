"""Create the private Windows deployment ZIP after pack:win and verification."""
import argparse,json,shutil,zipfile,hashlib
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--config',type=Path,required=True);args=parser.parse_args()
root=Path(__file__).resolve().parents[1]; folder=root/'dist/win-unpacked'
version=json.loads((root/'package.json').read_text())['version']
assert (folder/'LUK Dental SMS Electron.exe').is_file(), 'Run pack:win first.'
config=json.loads(args.config.read_text(encoding='utf-8-sig'));assert config.get('api_token') and config.get('bridge_url') and config.get('workstation_mode')=='r5'
(folder/'sms_config.json').write_text(json.dumps(config,indent=2));(folder/'sms_config.json').chmod(0o600)
for name in ['scheduler-on.bat','scheduler-off.bat','r5-check.bat']:
 (folder/name).write_bytes((root/'windows'/name).read_text().replace('\r\n','\n').replace('\n','\r\n').encode())
shutil.copy2(root/'windows/setup-scheduler-tasks.ps1',folder/'setup-scheduler-tasks.ps1')
for name in ['R5-HUONG-DAN.md','DOI-CHIEU-PYTHON.md']:
 shutil.copy2(root/name,folder/name)
prefix=f'LUK-Dental-SMS-Electron-R5-v{version}'
archive=root/f'dist/{prefix}-win-x64.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for file in sorted(folder.rglob('*')):
  if file.is_file(): z.write(file,Path(prefix)/file.relative_to(folder))
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None
 assert json.loads(z.read(prefix+'/sms_config.json'))==config
 for required in ['LUK Dental SMS Electron.exe','resources/app.asar','scheduler-on.bat','scheduler-off.bat','setup-scheduler-tasks.ps1','r5-check.bat','resources/windows/scheduler.ps1','resources/windows/scheduler-plan.ps1','resources/windows/scheduler-runtime.ps1']:
  assert prefix+'/'+required in z.namelist(),required
sha=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()
archive.with_suffix('.sha256').write_text(f'{sha}  {archive.name}\n');archive.chmod(0o600)
print(f'Private R5 ZIP verified: {archive.name} ({archive.stat().st_size/1024/1024:.1f} MiB)')
