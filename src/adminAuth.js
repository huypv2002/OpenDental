import crypto from 'node:crypto';
import { config } from './config.js';
import { pool } from './db.js';

const PASSWORD_ITERATIONS = 120000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = 'sha256';
const ADMIN_COLUMNS = 'AdminId, Username, DisplayName, Role, IsActive, CreatedAt, UpdatedAt, LastLoginAt';

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function normalizeUsername(value) {
  const username = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._@-]{3,64}$/.test(username)) {
    throw badRequest('Username must be 3-64 characters and use letters, numbers, dot, dash, underscore, or @.');
  }
  return username;
}

function normalizeDisplayName(value, fallback) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 100) || fallback;
}

function normalizeRole(value) {
  const role = String(value ?? 'admin').trim().toLowerCase();
  return ['owner', 'admin', 'staff'].includes(role) ? role : 'admin';
}

function normalizeActive(value) {
  return value === true || ['1', 'true', 'yes', 'active', 'on'].includes(String(value ?? '').trim().toLowerCase()) ? 1 : 0;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST).toString('base64url');
  return `pbkdf2_${PASSWORD_DIGEST}$${PASSWORD_ITERATIONS}$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 4 || parts[0] !== `pbkdf2_${PASSWORD_DIGEST}`) return false;
  const iterations = Number.parseInt(parts[1], 10);
  const salt = parts[2];
  const expected = parts[3];
  if (!iterations || !salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(password, salt, iterations, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST).toString('base64url');
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function publicAdmin(row) {
  return {
    adminId: row.AdminId,
    username: row.Username,
    displayName: row.DisplayName || row.Username,
    role: row.Role || 'admin',
    isActive: Boolean(row.IsActive),
    createdAt: row.CreatedAt,
    updatedAt: row.UpdatedAt,
    lastLoginAt: row.LastLoginAt || null
  };
}

async function ensureAdminAccountsTable() {
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS luk_admin_accounts (
      AdminId BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      Username VARCHAR(100) NOT NULL,
      DisplayName VARCHAR(100) NOT NULL DEFAULT '',
      PasswordHash VARCHAR(255) NOT NULL,
      Role ENUM('owner','admin','staff') NOT NULL DEFAULT 'admin',
      IsActive TINYINT(1) NOT NULL DEFAULT 1,
      CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      LastLoginAt DATETIME NULL,
      UNIQUE KEY uq_luk_admin_accounts_username (Username),
      KEY idx_luk_admin_accounts_active (IsActive)
    )`
  );

  const [[row]] = await pool.execute('SELECT COUNT(*) AS total FROM luk_admin_accounts');
  if (Number(row?.total || 0) === 0) {
    if (!String(config.adminAuth.bootstrapUsername || '').trim()) {
      throw badRequest('ADMIN_BOOTSTRAP_USERNAME is required when admin account table is empty.');
    }
    const username = normalizeUsername(config.adminAuth.bootstrapUsername);
    const password = String(config.adminAuth.bootstrapPassword ?? '');
    if (password.length < 6) {
      throw badRequest('ADMIN_BOOTSTRAP_PASSWORD must be at least 6 characters.');
    }
    await pool.execute(
      `INSERT INTO luk_admin_accounts (Username, DisplayName, PasswordHash, Role, IsActive)
       VALUES (?, ?, ?, 'owner', 1)`,
      [username, normalizeDisplayName(config.adminAuth.bootstrapDisplayName, username), hashPassword(password)]
    );
  }
}

export async function loginAdminAccount(body = {}) {
  await ensureAdminAccountsTable();
  const username = normalizeUsername(body.username);
  const password = String(body.password ?? '');
  if (!password) throw badRequest('Password is required.');

  const [rows] = await pool.execute(
    `SELECT ${ADMIN_COLUMNS}, PasswordHash FROM luk_admin_accounts WHERE Username = ? LIMIT 1`,
    [username]
  );
  const account = rows[0] || null;
  if (!account || !account.IsActive || !verifyPassword(password, account.PasswordHash)) {
    const error = new Error('Username or password is not correct.');
    error.status = 403;
    throw error;
  }

  await pool.execute('UPDATE luk_admin_accounts SET LastLoginAt = NOW() WHERE AdminId = ?', [account.AdminId]);
  account.LastLoginAt = new Date();
  return { admin: publicAdmin(account) };
}

export async function listAdminAccounts() {
  await ensureAdminAccountsTable();
  const [rows] = await pool.execute(
    `SELECT ${ADMIN_COLUMNS} FROM luk_admin_accounts ORDER BY IsActive DESC, Role = 'owner' DESC, Username ASC`
  );
  return { accounts: rows.map(publicAdmin) };
}

export async function saveAdminAccount(body = {}) {
  await ensureAdminAccountsTable();
  const adminId = Number.parseInt(body.adminId ?? body.id ?? 0, 10) || 0;
  const username = normalizeUsername(body.username);
  const displayName = normalizeDisplayName(body.displayName, username);
  const role = normalizeRole(body.role);
  const isActive = normalizeActive(body.isActive ?? body.status ?? 1);
  const password = String(body.password ?? '');

  if (adminId > 0) {
    const [existingRows] = await pool.execute('SELECT AdminId FROM luk_admin_accounts WHERE AdminId = ? LIMIT 1', [adminId]);
    if (!existingRows.length) throw badRequest('Admin account was not found.');
    if (password) {
      if (password.length < 6) throw badRequest('Password must be at least 6 characters.');
      await pool.execute(
        `UPDATE luk_admin_accounts
         SET Username = ?, DisplayName = ?, Role = ?, IsActive = ?, PasswordHash = ?
         WHERE AdminId = ?`,
        [username, displayName, role, isActive, hashPassword(password), adminId]
      );
    } else {
      await pool.execute(
        `UPDATE luk_admin_accounts
         SET Username = ?, DisplayName = ?, Role = ?, IsActive = ?
         WHERE AdminId = ?`,
        [username, displayName, role, isActive, adminId]
      );
    }
  } else {
    if (password.length < 6) throw badRequest('Password must be at least 6 characters.');
    await pool.execute(
      `INSERT INTO luk_admin_accounts (Username, DisplayName, PasswordHash, Role, IsActive)
       VALUES (?, ?, ?, ?, ?)`,
      [username, displayName, hashPassword(password), role, isActive]
    );
  }

  const [rows] = await pool.execute(`SELECT ${ADMIN_COLUMNS} FROM luk_admin_accounts WHERE Username = ? LIMIT 1`, [username]);
  return { account: publicAdmin(rows[0]) };
}

export async function deleteAdminAccount(body = {}) {
  await ensureAdminAccountsTable();
  const adminId = Number.parseInt(body.adminId ?? body.id ?? 0, 10) || 0;
  if (adminId < 1) throw badRequest('Admin account is required.');

  const [[countRow]] = await pool.execute('SELECT COUNT(*) AS total FROM luk_admin_accounts WHERE IsActive = 1');
  const [rows] = await pool.execute('SELECT AdminId, IsActive FROM luk_admin_accounts WHERE AdminId = ? LIMIT 1', [adminId]);
  const account = rows[0] || null;
  if (!account) throw badRequest('Admin account was not found.');
  if (account.IsActive && Number(countRow?.total || 0) <= 1) {
    throw badRequest('At least one active admin account is required.');
  }
  await pool.execute('DELETE FROM luk_admin_accounts WHERE AdminId = ?', [adminId]);
  return { deleted: true, adminId };
}
