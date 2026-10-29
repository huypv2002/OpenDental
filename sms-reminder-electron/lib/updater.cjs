const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const MANIFEST_URL = 'https://github.com/huypv2002/OpenDental/releases/download/sms-electron-latest/update.json';
const DOWNLOAD_PREFIX = 'https://github.com/huypv2002/OpenDental/releases/download/sms-electron-latest/';
function versionParts(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid update version.');
  return version.split('.').map(Number);
}
function isNewer(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function validateManifest(data) {
  versionParts(data.version);
  if (!/^[a-f0-9]{64}$/.test(data.sha256) ||
      data.url !== `${DOWNLOAD_PREFIX}LUK-Dental-SMS-Electron-update-v${data.version}-win-x64.zip`)
    throw new Error('Invalid SMS update manifest.');
  return { version: data.version, sha256: data.sha256, url: data.url };
}
function canInstall(status) {
  return !status.busy && !status.monitorBusy && !status.pendingDraft;
}
async function checkUpdate(current, fetchImpl = fetch) {
  const response = await fetchImpl(MANIFEST_URL, { signal: AbortSignal.timeout(20000), cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Update server HTTP ${response.status}.`);
  const data = validateManifest(await response.json());
  return isNewer(data.version, current) ? data : null;
}
async function downloadUpdate(manifest, dir, fetchImpl = fetch) {
  manifest = validateManifest(manifest);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `update-${manifest.version}.zip`);
  const temp = `${file}.download`;
  try {
    const response = await fetchImpl(manifest.url, { signal: AbortSignal.timeout(300000) });
    if (!response.ok || !response.body) throw new Error(`Update download HTTP ${response.status}.`);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > 500 * 1024 * 1024) return callback(new Error('Update is too large.'));
        hash.update(chunk); callback(null, chunk);
      },
    }), fs.createWriteStream(temp, { mode: 0o600 }));
    if (hash.digest('hex') !== manifest.sha256) throw new Error('Update checksum mismatch. No files were changed.');
    fs.renameSync(temp, file);
    return file;
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}
module.exports = { MANIFEST_URL, isNewer, validateManifest, canInstall, checkUpdate, downloadUpdate };
