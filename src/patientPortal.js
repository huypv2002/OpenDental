import crypto from 'node:crypto';
import { config } from './config.js';
import { pool } from './db.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_ITERATIONS = 120000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = 'sha256';

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function requiredString(body, key, label = key) {
  const value = String(body[key] ?? '').trim();
  if (!value) {
    throw badRequest(`${label} is required.`);
  }
  return value;
}

function optionalString(body, key) {
  return String(body[key] ?? '').trim();
}

function plainLatinName(value, label) {
  if (!/^[A-Za-z][A-Za-z '\-]*$/.test(value)) {
    throw badRequest(`${label} must use letters without accents.`);
  }
  return value;
}

function normalizeDate(value, label) {
  if (!DATE_RE.test(value)) {
    throw badRequest(`${label} must use YYYY-MM-DD format.`);
  }
  return value;
}

function normalizeEmail(value) {
  const email = value.toLowerCase();
  if (!EMAIL_RE.test(email)) {
    throw badRequest('A valid email address is required.');
  }
  return email;
}

function publicAccount(row) {
  return {
    accountId: row.AccountId,
    patNum: row.PatNum || null,
    email: row.Email,
    firstName: row.FirstName,
    lastName: row.LastName,
    phone: row.Phone || '',
    birthdate: row.Birthdate instanceof Date ? row.Birthdate.toISOString().slice(0, 10) : String(row.Birthdate || ''),
    driverLicense: row.DriverLicense || '',
    membershipPlan: row.MembershipPlan || '',
    status: row.Status,
    createdAt: row.CreatedAt,
    lastLoginAt: row.LastLoginAt || null
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST).toString('base64url');
  return `pbkdf2_${PASSWORD_DIGEST}$${PASSWORD_ITERATIONS}$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 4 || parts[0] !== `pbkdf2_${PASSWORD_DIGEST}`) {
    return false;
  }
  const iterations = Number.parseInt(parts[1], 10);
  const salt = parts[2];
  const expected = parts[3];
  if (!iterations || !salt || !expected) {
    return false;
  }
  const actual = crypto.pbkdf2Sync(password, salt, iterations, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST).toString('base64url');
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function currentDateKey() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');
}

async function tableColumnNames(tableName) {
  const [rows] = await pool.execute(`SHOW COLUMNS FROM ${tableName}`);
  return new Set(rows.map((row) => row.Field));
}

async function ensureColumn(columns, tableName, columnName, definition) {
  if (columns.has(columnName)) {
    return;
  }
  await pool.execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  columns.add(columnName);
}

export async function ensurePatientPortalTables() {
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS luk_patient_accounts (
      AccountId BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      PatNum BIGINT NULL,
      Email VARCHAR(190) NOT NULL,
      PasswordHash VARCHAR(255) NOT NULL,
      FirstName VARCHAR(100) NOT NULL DEFAULT '',
      LastName VARCHAR(100) NOT NULL DEFAULT '',
      Phone VARCHAR(30) NOT NULL DEFAULT '',
      Birthdate DATE NOT NULL,
      DriverLicense VARCHAR(190) NOT NULL DEFAULT '',
      MembershipPlan VARCHAR(100) NOT NULL DEFAULT '',
      Status ENUM('active','inactive','pending') NOT NULL DEFAULT 'active',
      CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      LastLoginAt DATETIME NULL,
      UNIQUE KEY uq_luk_patient_accounts_email (Email),
      KEY idx_luk_patient_accounts_patnum (PatNum),
      KEY idx_luk_patient_accounts_identity (LastName, FirstName, Birthdate),
      KEY idx_luk_patient_accounts_status (Status)
    )`
  );

  const columns = await tableColumnNames('luk_patient_accounts');
  await ensureColumn(columns, 'luk_patient_accounts', 'PatNum', 'BIGINT NULL');
  await ensureColumn(columns, 'luk_patient_accounts', 'Email', "VARCHAR(190) NOT NULL DEFAULT ''");
  await ensureColumn(columns, 'luk_patient_accounts', 'PasswordHash', "VARCHAR(255) NOT NULL DEFAULT ''");
  await ensureColumn(columns, 'luk_patient_accounts', 'FirstName', "VARCHAR(100) NOT NULL DEFAULT ''");
  await ensureColumn(columns, 'luk_patient_accounts', 'LastName', "VARCHAR(100) NOT NULL DEFAULT ''");
  await ensureColumn(columns, 'luk_patient_accounts', 'Phone', "VARCHAR(30) NOT NULL DEFAULT ''");
  await ensureColumn(columns, 'luk_patient_accounts', 'Birthdate', "DATE NOT NULL DEFAULT '0001-01-01'");
  await ensureColumn(columns, 'luk_patient_accounts', 'DriverLicense', "VARCHAR(190) NOT NULL DEFAULT ''");
  await ensureColumn(columns, 'luk_patient_accounts', 'MembershipPlan', "VARCHAR(100) NOT NULL DEFAULT ''");
  await ensureColumn(columns, 'luk_patient_accounts', 'Status', "ENUM('active','inactive','pending') NOT NULL DEFAULT 'active'");
  await ensureColumn(columns, 'luk_patient_accounts', 'CreatedAt', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
  await ensureColumn(columns, 'luk_patient_accounts', 'UpdatedAt', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
  await ensureColumn(columns, 'luk_patient_accounts', 'LastLoginAt', 'DATETIME NULL');
}

export function parsePatientRegisterBody(body) {
  const firstName = plainLatinName(requiredString(body, 'firstName', 'First name'), 'First name');
  const lastName = plainLatinName(requiredString(body, 'lastName', 'Last name'), 'Last name');
  const birthdate = normalizeDate(requiredString(body, 'birthdate', 'Date of birth'), 'Date of birth');
  const driverLicense = requiredString(body, 'driverLicense', 'Driver license ID or passport');
  const email = normalizeEmail(requiredString(body, 'email', 'Email'));
  const password = requiredString(body, 'password', 'Password');
  if (password.length < 8) {
    throw badRequest('Password must be at least 8 characters.');
  }

  return {
    firstName,
    lastName,
    birthdate,
    driverLicense,
    email,
    password,
    phone: optionalString(body, 'phone')
  };
}

export function parsePatientLoginBody(body) {
  return {
    email: normalizeEmail(requiredString(body, 'email', 'Email')),
    password: requiredString(body, 'password', 'Password')
  };
}

export function parsePatientAccountStatusBody(body) {
  const accountId = Number.parseInt(body.accountId ?? body.AccountId ?? '', 10);
  const status = String(body.status ?? '').trim();
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw badRequest('accountId is required.');
  }
  if (!['active', 'inactive'].includes(status)) {
    throw badRequest('status must be active or inactive.');
  }
  return { accountId, status };
}

export function parsePatientAccountMembershipBody(body) {
  const accountId = Number.parseInt(body.accountId ?? body.AccountId ?? '', 10);
  const membershipPlan = optionalString(body, 'membershipPlan').slice(0, 100);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw badRequest('accountId is required.');
  }
  return { accountId, membershipPlan };
}

export function parsePatientAccountPasswordBody(body) {
  const accountId = Number.parseInt(body.accountId ?? body.AccountId ?? '', 10);
  const password = requiredString(body, 'password', 'Password');
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw badRequest('accountId is required.');
  }
  if (password.length < 8) {
    throw badRequest('Password must be at least 8 characters.');
  }
  return { accountId, password };
}

export function parsePatientAccountLinkBody(body) {
  const accountId = Number.parseInt(body.accountId ?? body.AccountId ?? '', 10);
  const patNum = Number.parseInt(body.patNum ?? body.PatNum ?? '', 10);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw badRequest('accountId is required.');
  }
  if (!Number.isInteger(patNum) || patNum <= 0) {
    throw badRequest('PatNum is required.');
  }
  return { accountId, patNum };
}

async function findMatchingPatient(connection, input) {
  const driverLike = `%${String(input.driverLicense).replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
  const [rows] = await connection.execute(
    `SELECT
       p.PatNum, p.FName, p.LName, p.Birthdate, p.WirelessPhone, p.Email
     FROM patient p
     LEFT JOIN patfield pf
       ON pf.PatNum = p.PatNum
      AND pf.FieldName = 'Driver License ID'
     WHERE LOWER(p.FName) = LOWER(?)
       AND LOWER(p.LName) = LOWER(?)
       AND p.Birthdate = ?
       AND (
         pf.FieldValue = ?
         OR EXISTS (
           SELECT 1
           FROM appointment a
           LEFT JOIN apptfield af
             ON af.AptNum = a.AptNum
            AND af.FieldName = 'Driver License ID'
           WHERE a.PatNum = p.PatNum
             AND (
               af.FieldValue = ?
               OR a.Note LIKE ? ESCAPE '\\\\'
             )
           LIMIT 1
         )
       )
     ORDER BY p.PatNum DESC
     LIMIT 1`,
    [input.firstName, input.lastName, input.birthdate, input.driverLicense, input.driverLicense, driverLike]
  );
  return rows[0] || null;
}

async function createPortalPatient(connection, input) {
  const [patientResult] = await connection.execute(
    `INSERT INTO patient
      (LName, FName, WirelessPhone, Email, Birthdate, PatStatus, Gender, Position, PriProv, SecProv, BillingType, FeeSched)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, 0, 0, 0)`,
    [
      input.lastName,
      input.firstName,
      input.phone,
      input.email,
      input.birthdate,
      Number.parseInt(config.booking.providerNum, 10) || 0
    ]
  );
  const patNum = patientResult.insertId;
  await connection.execute('UPDATE patient SET Guarantor = ? WHERE PatNum = ?', [patNum, patNum]);
  if (input.driverLicense) {
    await connection.execute(
      `INSERT INTO patfield
        (PatNum, FieldName, FieldValue, SecUserNumEntry, SecDateEntry)
       VALUES (?, 'Driver License ID', ?, 0, ?)`,
      [patNum, input.driverLicense, currentDateKey()]
    );
  }
  return {
    PatNum: patNum,
    FName: input.firstName,
    LName: input.lastName,
    created: true
  };
}

export async function registerPatientAccount(input) {
  if (!config.writesEnabled) {
    const error = new Error('Open Dental write mode is disabled. Set ENABLE_OPEN_DENTAL_WRITES=true after testing on clone DB.');
    error.status = 501;
    throw error;
  }

  await ensurePatientPortalTables();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existingRows] = await connection.execute(
      `SELECT AccountId
       FROM luk_patient_accounts
       WHERE Email = ?
       LIMIT 1`,
      [input.email]
    );
    if (existingRows.length) {
      throw badRequest('An account already exists for this email address.');
    }

    let patient = await findMatchingPatient(connection, input);
    if (!patient) {
      patient = await createPortalPatient(connection, input);
    }
    const patNum = patient?.PatNum || null;
    const passwordHash = hashPassword(input.password);

    const [result] = await connection.execute(
      `INSERT INTO luk_patient_accounts
        (PatNum, Email, PasswordHash, FirstName, LastName, Phone, Birthdate, DriverLicense, Status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        patNum,
        input.email,
        passwordHash,
        input.firstName,
        input.lastName,
        input.phone,
        input.birthdate,
        input.driverLicense
      ]
    );

    const [rows] = await connection.execute(
      `SELECT AccountId, PatNum, Email, FirstName, LastName, Phone, Birthdate, DriverLicense, MembershipPlan, Status, CreatedAt, LastLoginAt
       FROM luk_patient_accounts
       WHERE AccountId = ?
       LIMIT 1`,
      [result.insertId]
    );

    await connection.commit();
    return {
      account: publicAccount(rows[0]),
      linkedPatient: patient ? {
        patNum: patient.PatNum,
        firstName: patient.FName,
        lastName: patient.LName,
        created: Boolean(patient.created)
      } : null
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function loginPatientAccount(input) {
  await ensurePatientPortalTables();
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      `SELECT AccountId, PatNum, Email, PasswordHash, FirstName, LastName, Phone, Birthdate, DriverLicense, MembershipPlan, Status, CreatedAt, LastLoginAt
       FROM luk_patient_accounts
       WHERE Email = ?
       LIMIT 1`,
      [input.email]
    );
    const account = rows[0];
    if (!account || account.Status !== 'active' || !verifyPassword(input.password, account.PasswordHash)) {
      const error = new Error('Invalid email or password.');
      error.status = 401;
      throw error;
    }

    await connection.execute(
      `UPDATE luk_patient_accounts
       SET LastLoginAt = NOW()
       WHERE AccountId = ?`,
      [account.AccountId]
    );
    account.LastLoginAt = new Date();

    return {
      account: publicAccount(account)
    };
  } finally {
    connection.release();
  }
}

export async function listPatientAccounts(query = {}) {
  await ensurePatientPortalTables();
  const limit = Math.max(1, Math.min(500, Number.parseInt(query.limit ?? '100', 10) || 100));
  const search = String(query.q ?? '').trim();
  const values = [];
  let where = '';
  if (search) {
    where = `WHERE
      Email LIKE ?
      OR FirstName LIKE ?
      OR LastName LIKE ?
      OR Phone LIKE ?
      OR DriverLicense LIKE ?
      OR MembershipPlan LIKE ?
      OR CAST(PatNum AS CHAR) LIKE ?`;
    const like = `%${search}%`;
    values.push(like, like, like, like, like, like, like);
  }

  const [rows] = await pool.execute(
    `SELECT AccountId, PatNum, Email, FirstName, LastName, Phone, Birthdate, DriverLicense, MembershipPlan, Status, CreatedAt, UpdatedAt, LastLoginAt
     FROM luk_patient_accounts
     ${where}
     ORDER BY CreatedAt DESC, AccountId DESC
     LIMIT ${limit}`,
    values
  );
  return {
    accounts: rows.map(publicAccount)
  };
}

export async function updatePatientAccountStatus(input) {
  await ensurePatientPortalTables();
  const [result] = await pool.execute(
    `UPDATE luk_patient_accounts
     SET Status = ?
     WHERE AccountId = ?`,
    [input.status, input.accountId]
  );
  if (result.affectedRows < 1) {
    const error = new Error('Patient account was not found.');
    error.status = 404;
    throw error;
  }
  const [rows] = await pool.execute(
    `SELECT AccountId, PatNum, Email, FirstName, LastName, Phone, Birthdate, DriverLicense, MembershipPlan, Status, CreatedAt, UpdatedAt, LastLoginAt
     FROM luk_patient_accounts
     WHERE AccountId = ?
     LIMIT 1`,
    [input.accountId]
  );
  return {
    account: publicAccount(rows[0])
  };
}

export async function updatePatientAccountMembership(input) {
  await ensurePatientPortalTables();
  const [result] = await pool.execute(
    `UPDATE luk_patient_accounts
     SET MembershipPlan = ?
     WHERE AccountId = ?`,
    [input.membershipPlan, input.accountId]
  );
  if (result.affectedRows < 1) {
    const error = new Error('Patient account was not found.');
    error.status = 404;
    throw error;
  }
  const [rows] = await pool.execute(
    `SELECT AccountId, PatNum, Email, FirstName, LastName, Phone, Birthdate, DriverLicense, MembershipPlan, Status, CreatedAt, UpdatedAt, LastLoginAt
     FROM luk_patient_accounts
     WHERE AccountId = ?
     LIMIT 1`,
    [input.accountId]
  );
  return {
    account: publicAccount(rows[0])
  };
}

export async function linkPatientAccount(input) {
  await ensurePatientPortalTables();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [patientRows] = await connection.execute(
      `SELECT PatNum
       FROM patient
       WHERE PatNum = ?
       LIMIT 1`,
      [input.patNum]
    );
    if (!patientRows.length) {
      const error = new Error('Open Dental patient was not found for that PatNum.');
      error.status = 404;
      throw error;
    }

    const [result] = await connection.execute(
      `UPDATE luk_patient_accounts
       SET PatNum = ?
       WHERE AccountId = ?`,
      [input.patNum, input.accountId]
    );
    if (result.affectedRows < 1) {
      const error = new Error('Patient account was not found.');
      error.status = 404;
      throw error;
    }

    const [rows] = await connection.execute(
      `SELECT AccountId, PatNum, Email, FirstName, LastName, Phone, Birthdate, DriverLicense, MembershipPlan, Status, CreatedAt, UpdatedAt, LastLoginAt
       FROM luk_patient_accounts
       WHERE AccountId = ?
       LIMIT 1`,
      [input.accountId]
    );

    await connection.commit();
    return {
      account: publicAccount(rows[0])
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function updatePatientAccountPassword(input) {
  await ensurePatientPortalTables();
  const [result] = await pool.execute(
    `UPDATE luk_patient_accounts
     SET PasswordHash = ?
     WHERE AccountId = ?`,
    [hashPassword(input.password), input.accountId]
  );
  if (result.affectedRows < 1) {
    const error = new Error('Patient account was not found.');
    error.status = 404;
    throw error;
  }
  return { ok: true };
}
