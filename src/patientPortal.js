import crypto from 'node:crypto';
import Stripe from 'stripe';
import { config } from './config.js';
import { pool } from './db.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_ITERATIONS = 120000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = 'sha256';
let stripeClient = null;
const ACCOUNT_PUBLIC_COLUMNS = `AccountId, PatNum, Email, FirstName, LastName, Phone, Birthdate, DriverLicense,
       MembershipPlan, StripeCustomerId, StripeSubscriptionId, MembershipPaymentStatus,
       MembershipCurrentPeriodEnd, MembershipActivatedAt, Status, CreatedAt, UpdatedAt, LastLoginAt`;
const PLAN_PUBLIC_COLUMNS = `PlanId, PlanKey, Badge, Title, PriceLabel, Content, CheckoutUrl, StripePriceId,
       Cost, IsFeatured, IsActive, DisplayOrder, CreatedAt, UpdatedAt`;

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
    stripeCustomerId: row.StripeCustomerId || '',
    stripeSubscriptionId: row.StripeSubscriptionId || '',
    membershipPaymentStatus: row.MembershipPaymentStatus || '',
    membershipCurrentPeriodEnd: row.MembershipCurrentPeriodEnd || null,
    membershipActivatedAt: row.MembershipActivatedAt || null,
    status: row.Status,
    createdAt: row.CreatedAt,
    lastLoginAt: row.LastLoginAt || null
  };
}

function publicMembershipPlan(row) {
  return {
    planId: row.PlanId,
    planKey: row.PlanKey || '',
    badge: row.Badge || '',
    title: row.Title || '',
    priceLabel: row.PriceLabel || '',
    content: row.Content || '',
    checkoutUrl: row.CheckoutUrl || '',
    stripePriceId: row.StripePriceId || '',
    cost: Number(row.Cost || 0),
    isFeatured: Boolean(row.IsFeatured),
    isActive: Boolean(row.IsActive),
    displayOrder: Number(row.DisplayOrder || 0),
    createdAt: row.CreatedAt,
    updatedAt: row.UpdatedAt
  };
}

function stripe() {
  if (!config.stripe.secretKey) {
    const error = new Error('Stripe is not configured. Add STRIPE_SECRET_KEY to the bridge .env file.');
    error.status = 500;
    throw error;
  }
  if (!stripeClient) {
    stripeClient = new Stripe(config.stripe.secretKey, {
      apiVersion: '2026-02-25.clover'
    });
  }
  return stripeClient;
}

function normalizeCheckoutUrl(value, label) {
  const url = requiredString({ value }, 'value', label);
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Invalid protocol.');
    }
    return parsed.toString();
  } catch (_error) {
    throw badRequest(`${label} must be a valid website URL.`);
  }
}

function mysqlDateTimeFromEpoch(value) {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function addQueryParam(url, key, value) {
  const parsed = new URL(url);
  parsed.searchParams.set(key, value);
  return parsed.toString();
}

function normalizePlanKey(value, fallback = '') {
  const source = String(value || fallback || '').trim().toLowerCase();
  return source
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || `plan-${Date.now()}`;
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

async function ensureMembershipPlanDefaults() {
  const [rows] = await pool.execute('SELECT COUNT(*) AS total FROM luk_membership_plans');
  if (Number(rows[0]?.total || 0) > 0) {
    return;
  }

  const defaults = [
    {
      planKey: 'annual',
      badge: 'Annual',
      title: 'Annual Membership Plan',
      priceLabel: '$140/year',
      cost: 140,
      checkoutUrl: '3YHUJ4ZLFDM5J7BM',
      displayOrder: 10,
      content: '<p><strong>Annual Membership Plan includes:</strong></p><ul><li>1 Dental Cleaning Per Year</li><li>Unlimited Diagnostic X-Rays</li><li>Unlimited Consultations</li></ul>'
    },
    {
      planKey: 'gold-annual',
      badge: 'Gold',
      title: 'Gold Annual Membership Plan',
      priceLabel: '$190/year',
      cost: 190,
      checkoutUrl: 'TGD4NDP3MJLQ6MM',
      displayOrder: 20,
      isFeatured: 1,
      content: '<p><strong>Annual Membership Plan includes:</strong></p><ul><li>2 Dental Cleanings Per Year</li><li>Unlimited Diagnostic X-Rays</li><li>Unlimited Consultations</li></ul>'
    },
    {
      planKey: 'vip-annual',
      badge: 'VIP',
      title: 'VIP Annual Membership Plan',
      priceLabel: '$240/year',
      cost: 240,
      checkoutUrl: 'TGD4NDP3MJLQ6MM',
      displayOrder: 30,
      content: '<p><strong>Annual Membership Plan includes:</strong></p><ul><li>3 Dental Cleanings Per Year</li><li>Unlimited Diagnostic X-Rays</li><li>Unlimited Consultations</li></ul>'
    }
  ];

  for (const plan of defaults) {
    await pool.execute(
      `INSERT INTO luk_membership_plans
        (PlanKey, Badge, Title, PriceLabel, Content, CheckoutUrl, Cost, IsFeatured, IsActive, DisplayOrder)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        plan.planKey,
        plan.badge,
        plan.title,
        plan.priceLabel,
        plan.content,
        plan.checkoutUrl,
        plan.cost,
        plan.isFeatured ? 1 : 0,
        plan.displayOrder
      ]
    );
  }
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
      StripeCustomerId VARCHAR(190) NOT NULL DEFAULT '',
      StripeSubscriptionId VARCHAR(190) NOT NULL DEFAULT '',
      MembershipPaymentStatus VARCHAR(50) NOT NULL DEFAULT '',
      MembershipCurrentPeriodEnd DATETIME NULL,
      MembershipActivatedAt DATETIME NULL,
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
  await ensureColumn(columns, 'luk_patient_accounts', 'StripeCustomerId', "VARCHAR(190) NOT NULL DEFAULT ''");
  await ensureColumn(columns, 'luk_patient_accounts', 'StripeSubscriptionId', "VARCHAR(190) NOT NULL DEFAULT ''");
  await ensureColumn(columns, 'luk_patient_accounts', 'MembershipPaymentStatus', "VARCHAR(50) NOT NULL DEFAULT ''");
  await ensureColumn(columns, 'luk_patient_accounts', 'MembershipCurrentPeriodEnd', 'DATETIME NULL');
  await ensureColumn(columns, 'luk_patient_accounts', 'MembershipActivatedAt', 'DATETIME NULL');
  await ensureColumn(columns, 'luk_patient_accounts', 'Status', "ENUM('active','inactive','pending') NOT NULL DEFAULT 'active'");
  await ensureColumn(columns, 'luk_patient_accounts', 'CreatedAt', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
  await ensureColumn(columns, 'luk_patient_accounts', 'UpdatedAt', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
  await ensureColumn(columns, 'luk_patient_accounts', 'LastLoginAt', 'DATETIME NULL');

  await pool.execute(
    `CREATE TABLE IF NOT EXISTS luk_membership_plans (
      PlanId BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      PlanKey VARCHAR(100) NOT NULL,
      Badge VARCHAR(100) NOT NULL DEFAULT '',
      Title VARCHAR(190) NOT NULL DEFAULT '',
      PriceLabel VARCHAR(100) NOT NULL DEFAULT '',
      Content TEXT NULL,
      CheckoutUrl VARCHAR(500) NOT NULL DEFAULT '',
      StripePriceId VARCHAR(190) NOT NULL DEFAULT '',
      Cost DECIMAL(10,2) NOT NULL DEFAULT 0,
      IsFeatured TINYINT(1) NOT NULL DEFAULT 0,
      IsActive TINYINT(1) NOT NULL DEFAULT 1,
      DisplayOrder INT NOT NULL DEFAULT 0,
      CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_luk_membership_plans_key (PlanKey),
      KEY idx_luk_membership_plans_active_order (IsActive, DisplayOrder)
    )`
  );

  const planColumns = await tableColumnNames('luk_membership_plans');
  await ensureColumn(planColumns, 'luk_membership_plans', 'PlanKey', "VARCHAR(100) NOT NULL DEFAULT ''");
  await ensureColumn(planColumns, 'luk_membership_plans', 'Badge', "VARCHAR(100) NOT NULL DEFAULT ''");
  await ensureColumn(planColumns, 'luk_membership_plans', 'Title', "VARCHAR(190) NOT NULL DEFAULT ''");
  await ensureColumn(planColumns, 'luk_membership_plans', 'PriceLabel', "VARCHAR(100) NOT NULL DEFAULT ''");
  await ensureColumn(planColumns, 'luk_membership_plans', 'Content', 'TEXT NULL');
  await ensureColumn(planColumns, 'luk_membership_plans', 'CheckoutUrl', "VARCHAR(500) NOT NULL DEFAULT ''");
  await ensureColumn(planColumns, 'luk_membership_plans', 'StripePriceId', "VARCHAR(190) NOT NULL DEFAULT ''");
  await ensureColumn(planColumns, 'luk_membership_plans', 'Cost', 'DECIMAL(10,2) NOT NULL DEFAULT 0');
  await ensureColumn(planColumns, 'luk_membership_plans', 'IsFeatured', 'TINYINT(1) NOT NULL DEFAULT 0');
  await ensureColumn(planColumns, 'luk_membership_plans', 'IsActive', 'TINYINT(1) NOT NULL DEFAULT 1');
  await ensureColumn(planColumns, 'luk_membership_plans', 'DisplayOrder', 'INT NOT NULL DEFAULT 0');
  await ensureColumn(planColumns, 'luk_membership_plans', 'CreatedAt', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
  await ensureColumn(planColumns, 'luk_membership_plans', 'UpdatedAt', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
  await ensureMembershipPlanDefaults();
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

export function parseMembershipPlanBody(body) {
  const planId = Number.parseInt(body.planId ?? body.PlanId ?? '', 10) || 0;
  const title = requiredString(body, 'title', 'Plan title').slice(0, 190);
  const planKey = normalizePlanKey(optionalString(body, 'planKey'), title);
  const badge = optionalString(body, 'badge').slice(0, 100);
  const priceLabel = optionalString(body, 'priceLabel').slice(0, 100);
  const content = optionalString(body, 'content');
  const checkoutUrl = optionalString(body, 'checkoutUrl').slice(0, 500);
  const stripePriceId = optionalString(body, 'stripePriceId').slice(0, 190);
  const cost = Number.parseFloat(body.cost ?? '0') || 0;
  const displayOrder = Number.parseInt(body.displayOrder ?? '0', 10) || 0;
  const isFeatured = ['1', 'true', 'yes', 'on'].includes(String(body.isFeatured ?? '').toLowerCase()) ? 1 : 0;
  const isActive = ['0', 'false', 'no', 'off'].includes(String(body.isActive ?? '').toLowerCase()) ? 0 : 1;
  return {
    planId,
    planKey,
    badge,
    title,
    priceLabel,
    content,
    checkoutUrl,
    stripePriceId,
    cost,
    displayOrder,
    isFeatured,
    isActive
  };
}

export function parsePatientPortalCheckoutBody(body) {
  const accountId = Number.parseInt(body.accountId ?? body.AccountId ?? '', 10);
  const membershipPlan = requiredString(body, 'membershipPlan', 'Membership plan').slice(0, 100);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw badRequest('accountId is required.');
  }
  return {
    accountId,
    membershipPlan,
    successUrl: normalizeCheckoutUrl(
      optionalString(body, 'successUrl') || config.stripe.successUrl,
      'successUrl'
    ),
    cancelUrl: normalizeCheckoutUrl(
      optionalString(body, 'cancelUrl') || config.stripe.cancelUrl || optionalString(body, 'successUrl') || config.stripe.successUrl,
      'cancelUrl'
    )
  };
}

export function parseMembershipPlanDeleteBody(body) {
  const planId = Number.parseInt(body.planId ?? body.PlanId ?? '', 10);
  if (!Number.isInteger(planId) || planId <= 0) {
    throw badRequest('planId is required.');
  }
  return { planId };
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
      `SELECT ${ACCOUNT_PUBLIC_COLUMNS}
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
      `SELECT ${ACCOUNT_PUBLIC_COLUMNS}, PasswordHash
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
    `SELECT ${ACCOUNT_PUBLIC_COLUMNS}
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

export async function listMembershipPlans(query = {}) {
  await ensurePatientPortalTables();
  const includeInactive = ['1', 'true', 'yes'].includes(String(query.includeInactive ?? '').toLowerCase());
  const where = includeInactive ? '' : 'WHERE IsActive = 1';
  const [rows] = await pool.execute(
    `SELECT ${PLAN_PUBLIC_COLUMNS}
     FROM luk_membership_plans
     ${where}
     ORDER BY DisplayOrder ASC, PlanId ASC`
  );
  return {
    plans: rows.map(publicMembershipPlan)
  };
}

export async function saveMembershipPlan(input) {
  await ensurePatientPortalTables();
  if (input.planId > 0) {
    const [result] = await pool.execute(
      `UPDATE luk_membership_plans
       SET PlanKey = ?, Badge = ?, Title = ?, PriceLabel = ?, Content = ?, CheckoutUrl = ?, StripePriceId = ?, Cost = ?,
           IsFeatured = ?, IsActive = ?, DisplayOrder = ?
       WHERE PlanId = ?`,
      [
        input.planKey,
        input.badge,
        input.title,
        input.priceLabel,
        input.content,
        input.checkoutUrl,
        input.stripePriceId,
        input.cost,
        input.isFeatured,
        input.isActive,
        input.displayOrder,
        input.planId
      ]
    );
    if (result.affectedRows < 1) {
      const error = new Error('Membership plan was not found.');
      error.status = 404;
      throw error;
    }
  } else {
    const [result] = await pool.execute(
      `INSERT INTO luk_membership_plans
        (PlanKey, Badge, Title, PriceLabel, Content, CheckoutUrl, StripePriceId, Cost, IsFeatured, IsActive, DisplayOrder)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.planKey,
        input.badge,
        input.title,
        input.priceLabel,
        input.content,
        input.checkoutUrl,
        input.stripePriceId,
        input.cost,
        input.isFeatured,
        input.isActive,
        input.displayOrder
      ]
    );
    input.planId = result.insertId;
  }

  const [rows] = await pool.execute(
    `SELECT ${PLAN_PUBLIC_COLUMNS}
     FROM luk_membership_plans
     WHERE PlanId = ?
     LIMIT 1`,
    [input.planId]
  );
  return {
    plan: publicMembershipPlan(rows[0])
  };
}

export async function deleteMembershipPlan(input) {
  await ensurePatientPortalTables();
  const [result] = await pool.execute(
    `DELETE FROM luk_membership_plans
     WHERE PlanId = ?`,
    [input.planId]
  );
  if (result.affectedRows < 1) {
    const error = new Error('Membership plan was not found.');
    error.status = 404;
    throw error;
  }
  return { ok: true };
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
    `SELECT ${ACCOUNT_PUBLIC_COLUMNS}
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
    `SELECT ${ACCOUNT_PUBLIC_COLUMNS}
     FROM luk_patient_accounts
     WHERE AccountId = ?
     LIMIT 1`,
    [input.accountId]
  );
  return {
    account: publicAccount(rows[0])
  };
}

export async function createMembershipCheckoutSession(input) {
  await ensurePatientPortalTables();
  const [accountRows] = await pool.execute(
    `SELECT ${ACCOUNT_PUBLIC_COLUMNS}
     FROM luk_patient_accounts
     WHERE AccountId = ?
     LIMIT 1`,
    [input.accountId]
  );
  const account = accountRows[0];
  if (!account || account.Status !== 'active') {
    const error = new Error('Patient account was not found or is inactive.');
    error.status = 404;
    throw error;
  }

  const [planRows] = await pool.execute(
    `SELECT ${PLAN_PUBLIC_COLUMNS}
     FROM luk_membership_plans
     WHERE IsActive = 1
       AND (PlanKey = ? OR Title = ?)
     ORDER BY DisplayOrder ASC, PlanId ASC
     LIMIT 1`,
    [input.membershipPlan, input.membershipPlan]
  );
  const plan = planRows[0];
  if (!plan) {
    const error = new Error('Membership plan was not found.');
    error.status = 404;
    throw error;
  }
  if (!plan.StripePriceId) {
    const error = new Error(`Stripe Price ID is missing for "${plan.Title}". Add a yearly Stripe price to this plan in admin.`);
    error.status = 400;
    throw error;
  }

  const metadata = {
    accountId: String(account.AccountId),
    patNum: account.PatNum ? String(account.PatNum) : '',
    planKey: plan.PlanKey,
    planTitle: plan.Title
  };
  const successBase = addQueryParam(input.successUrl, 'stripe', 'success');
  const successUrl = `${successBase}${successBase.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = addQueryParam(input.cancelUrl, 'stripe', 'cancel');
  const sessionPayload = {
    mode: 'subscription',
    line_items: [
      {
        price: plan.StripePriceId,
        quantity: 1
      }
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: String(account.AccountId),
    metadata,
    subscription_data: { metadata },
    allow_promotion_codes: true
  };

  if (account.StripeCustomerId) {
    sessionPayload.customer = account.StripeCustomerId;
  } else {
    sessionPayload.customer_email = account.Email;
  }

  const session = await stripe().checkout.sessions.create(sessionPayload);
  return {
    sessionId: session.id,
    url: session.url
  };
}

async function updateSubscriptionStatusBySubscription(subscription, fallbackMetadata = {}) {
  const subscriptionId = typeof subscription === 'string' ? subscription : subscription?.id;
  if (!subscriptionId) {
    return false;
  }
  const status = typeof subscription === 'string' ? '' : String(subscription.status || '');
  const periodEnd = typeof subscription === 'string' ? null : mysqlDateTimeFromEpoch(subscription.current_period_end);
  const customerId = typeof subscription === 'string' ? '' : String(subscription.customer || '');
  const metadata = typeof subscription === 'string' ? fallbackMetadata : (subscription.metadata || fallbackMetadata || {});
  const accountId = Number.parseInt(metadata.accountId ?? '', 10);
  const planKey = String(metadata.planKey || '').slice(0, 100);

  const values = [
    customerId,
    subscriptionId,
    status || 'active',
    periodEnd
  ];
  let where = 'StripeSubscriptionId = ?';
  let whereValue = subscriptionId;
  if (Number.isInteger(accountId) && accountId > 0) {
    where = 'AccountId = ?';
    whereValue = accountId;
  }
  values.push(whereValue);

  await pool.execute(
    `UPDATE luk_patient_accounts
     SET StripeCustomerId = COALESCE(NULLIF(?, ''), StripeCustomerId),
         StripeSubscriptionId = ?,
         MembershipPaymentStatus = ?,
         MembershipCurrentPeriodEnd = ?,
         MembershipActivatedAt = COALESCE(MembershipActivatedAt, NOW())
     WHERE ${where}`,
    values
  );

  if (planKey && Number.isInteger(accountId) && accountId > 0 && status !== 'canceled') {
    await pool.execute(
      `UPDATE luk_patient_accounts
       SET MembershipPlan = ?
       WHERE AccountId = ?`,
      [planKey, accountId]
    );
  }
  return true;
}

async function completeCheckoutSession(session) {
  const accountId = Number.parseInt(session?.metadata?.accountId ?? session?.client_reference_id ?? '', 10);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return false;
  }
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  let subscription = null;
  if (subscriptionId) {
    subscription = await stripe().subscriptions.retrieve(subscriptionId);
  }
  if (subscription) {
    await updateSubscriptionStatusBySubscription(subscription, session.metadata || {});
  } else {
    await pool.execute(
      `UPDATE luk_patient_accounts
       SET StripeCustomerId = ?,
           StripeSubscriptionId = ?,
           MembershipPlan = ?,
           MembershipPaymentStatus = ?,
           MembershipActivatedAt = COALESCE(MembershipActivatedAt, NOW())
       WHERE AccountId = ?`,
      [
        String(session.customer || ''),
        subscriptionId || '',
        String(session.metadata?.planKey || '').slice(0, 100),
        String(session.payment_status || 'paid').slice(0, 50),
        accountId
      ]
    );
  }
  return true;
}

export async function handleStripeWebhook(rawBody, signature) {
  if (!config.stripe.webhookSecret) {
    const error = new Error('Stripe webhook secret is not configured. Add STRIPE_WEBHOOK_SECRET to the bridge .env file.');
    error.status = 500;
    throw error;
  }
  let event;
  try {
    event = stripe().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
  } catch (error) {
    const wrapped = new Error(`Stripe webhook signature verification failed: ${error.message}`);
    wrapped.status = 400;
    throw wrapped;
  }

  if (event.type === 'checkout.session.completed') {
    await completeCheckoutSession(event.data.object);
  } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    await updateSubscriptionStatusBySubscription(event.data.object);
  } else if (event.type === 'invoice.payment_failed') {
    const subscriptionId = event.data.object?.subscription;
    if (subscriptionId) {
      await pool.execute(
        `UPDATE luk_patient_accounts
         SET MembershipPaymentStatus = 'past_due'
         WHERE StripeSubscriptionId = ?`,
        [subscriptionId]
      );
    }
  }

  return {
    received: true,
    type: event.type
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
      `SELECT ${ACCOUNT_PUBLIC_COLUMNS}
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
