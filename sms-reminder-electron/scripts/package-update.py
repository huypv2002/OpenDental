"""Public updater artifact: NEVER includes the private R5 deployment config."""
import hashlib,json,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
folder=root/'dist/win-unpacked'
version=json.loads((root/'package.json').read_text())['version']
output=root/'dist/update-release';output.mkdir(parents=True,exist_ok=True)
archive=output/f'LUK-Dental-SMS-Electron-update-v{version}-win-x64.zip'
for required in ['LUK Dental SMS Electron.exe','resources/app.asar','resources/windows/install-update.ps1']:
 assert (folder/required).is_file(),required
# Only run on a clean pack:win output, before package-r5.py adds the private config.
for file in folder.rglob('*'):
 assert file.name.lower() not in ['sms_config.json','state.json','.env'], 'Private workstation data found. Run pack:win again.'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for file in sorted(folder.rglob('*')):
  if file.is_file():z.write(file,file.relative_to(folder))
with zipfile.ZipFile(archive) as z:assert z.testzip() is None
manifest={'version':version,'sha256':hashlib.file_digest(archive.open('rb'),'sha256').hexdigest(),'url':f'https://github.com/huypv2002/OpenDental/releases/download/sms-electron-latest/{archive.name}'}
(output/'update.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(f'Public update verified (no workstation config): {archive.name}')
