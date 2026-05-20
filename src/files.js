import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.pdf']);
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function sanitizePathPart(value, fallback) {
  const cleaned = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._ -]/g, '')
    .replace(/\s+/g, '')
    .replace(/^\.+/, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function formatDobForFolder(birthdate) {
  if (!DATE_RE.test(String(birthdate ?? ''))) return 'NoDOB';
  const [year, month, day] = birthdate.split('-');
  return `${month}${day}${year}`;
}

async function uniqueDirectory(baseDir, requestedName, aptNum) {
  const preferred = path.join(baseDir, requestedName);
  try {
    await fs.mkdir(preferred, { recursive: false });
    return preferred;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const fallback = path.join(baseDir, `${requestedName}-${sanitizePathPart(aptNum, 'booking')}`);
  await fs.mkdir(fallback, { recursive: true });
  return fallback;
}

function validateFile(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext) || !ALLOWED_MIME_TYPES.has(file.mimetype)) {
    throw badRequest('Only JPG, PNG, and PDF files are allowed.');
  }
  if (!file.size || file.size > config.fileStorage.maxFileBytes) {
    throw badRequest('Each uploaded file must be within the allowed size limit.');
  }
}

async function writeUniqueFile(folder, file, index) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const base = sanitizePathPart(path.basename(file.originalname || `file-${index + 1}`, ext), `file-${index + 1}`);
  let fileName = `${base}${ext}`;
  let destination = path.join(folder, fileName);

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await fs.writeFile(destination, file.buffer, { flag: 'wx' });
      return {
        originalName: file.originalname,
        fileName,
        size: file.size
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      fileName = `${base}-${attempt}${ext}`;
      destination = path.join(folder, fileName);
    }
  }

  throw new Error(`Unable to create unique filename for ${file.originalname}.`);
}

export async function saveBookingFiles(input, files) {
  if (!config.fileStorage.enabled) {
    return { enabled: false, saved: [] };
  }
  if (!Array.isArray(files) || files.length === 0) {
    return { enabled: true, saved: [] };
  }
  if (files.length > config.fileStorage.maxFiles) {
    throw badRequest(`Please upload no more than ${config.fileStorage.maxFiles} files.`);
  }

  for (const file of files) {
    validateFile(file);
  }

  const firstName = sanitizePathPart(input.firstName, 'Patient');
  const lastName = sanitizePathPart(input.lastName, 'Patient');
  const folderName = `${firstName}${lastName}${formatDobForFolder(input.birthdate)}`;

  await fs.mkdir(config.fileStorage.dir, { recursive: true });
  const folder = await uniqueDirectory(config.fileStorage.dir, folderName, input.aptNum);
  const saved = [];
  for (const [index, file] of files.entries()) {
    saved.push(await writeUniqueFile(folder, file, index));
  }

  return {
    enabled: true,
    folder,
    saved
  };
}
