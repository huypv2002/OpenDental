import crypto from 'node:crypto';
import Stripe from 'stripe';
import { config } from './config.js';
import { pool } from './db.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_ITERATIONS = 120000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = 'sha256';
const TOKEN_ISSUER = 'luk-patient-portal';
let stripeClient = null;
const ACCOUNT_PUBLIC_COLUMNS = `AccountId, PatNum, Email, FirstName, LastName, Phone, Birthdate, DriverLicense,
       MembershipPlan, StripeCustomerId, StripeSubscriptionId, MembershipPaymentStatus,
       MembershipCurrentPeriodEnd, MembershipActivatedAt, Status, CreatedAt, UpdatedAt, LastLoginAt`;
const PLAN_PUBLIC_COLUMNS = `PlanId, PlanKey, Badge, Title, PriceLabel, Content, CheckoutUrl, StripeProductId, StripePriceId,
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

function requiredAgreement(body) {
  const accepted = body.agreementAccepted === true ||
    ['1', 'true', 'yes', 'on'].includes(String(body.agreementAccepted ?? '').trim().toLowerCase());
  if (!accepted) {
    throw badRequest('Membership Terms and Privacy Policy acceptance is required.');
  }
  return true;
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

function dateKey(value) {
  if (!value) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const normalized = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

function addYearsToDateKey(raw, years) {
  const key = dateKey(raw);
  if (!key) return '';
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

function accountHasCurrentMembership(row) {
  if (!row?.MembershipPlan) return false;
  const status = String(row.MembershipPaymentStatus || '').trim().toLowerCase();
  return !status || ['active', 'trialing', 'paid', 'manual'].includes(status);
}

function accountMembershipPeriodEnd(row) {
  const periodEnd = dateKey(row?.MembershipCurrentPeriodEnd);
  if (periodEnd) return periodEnd;
  if (!accountHasCurrentMembership(row)) return null;
  const activatedAt = dateKey(row?.MembershipActivatedAt);
  if (activatedAt) return addYearsToDateKey(activatedAt, 1);
  const createdAt = dateKey(row?.CreatedAt);
  return createdAt ? addYearsToDateKey(createdAt, 1) : null;
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
    membershipCurrentPeriodEnd: accountMembershipPeriodEnd(row),
    membershipActivatedAt: row.MembershipActivatedAt || null,
    status: row.Status,
    createdAt: row.CreatedAt,
    lastLoginAt: row.LastLoginAt || null
  };
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signPortalTokenPayload(header, payload) {
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = crypto
    .createHmac('sha256', config.patientPortal.tokenSecret)
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

function issuePortalToken(row) {
  if (!config.patientPortal.tokenSecret) {
    const error = new Error('Patient portal token secret is not configured. Set PATIENT_PORTAL_TOKEN_SECRET or API_TOKEN in bridge .env.');
    error.status = 500;
    throw error;
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + config.patientPortal.tokenTtlSeconds;
  return {
    portalToken: signPortalTokenPayload(
      { alg: 'HS256', typ: 'JWT' },
      {
        iss: TOKEN_ISSUER,
        sub: String(row.AccountId),
        email: row.Email || '',
        iat: issuedAt,
        exp: expiresAt
      }
    ),
    tokenExpiresAt: new Date(expiresAt * 1000).toISOString()
  };
}

function verifyPortalToken(token) {
  if (!config.patientPortal.tokenSecret) {
    const error = new Error('Patient portal token secret is not configured. Set PATIENT_PORTAL_TOKEN_SECRET or API_TOKEN in bridge .env.');
    error.status = 500;
    throw error;
  }
  const raw = String(token || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 3) {
    const error = new Error('Patient portal session is invalid. Please sign in again.');
    error.status = 401;
    throw error;
  }
  const signingInput = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', config.patientPortal.tokenSecret).update(signingInput).digest('base64url');
  if (
    expected.length !== parts[2].length
    || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))
  ) {
    const error = new Error('Patient portal session is invalid. Please sign in again.');
    error.status = 401;
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_error) {
    const error = new Error('Patient portal session is invalid. Please sign in again.');
    error.status = 401;
    throw error;
  }
  const now = Math.floor(Date.now() / 1000);
  const accountId = Number.parseInt(payload.sub ?? '', 10);
  if (payload.iss !== TOKEN_ISSUER || !Number.isInteger(accountId) || accountId <= 0 || Number(payload.exp || 0) <= now) {
    const error = new Error('Patient portal session expired. Please sign in again.');
    error.status = 401;
    throw error;
  }
  return {
    accountId,
    email: String(payload.email || ''),
    tokenExpiresAt: new Date(Number(payload.exp) * 1000).toISOString()
  };
}

function authenticatedAccountBody(body) {
  return verifyPortalToken(requiredString(body, 'portalToken', 'Patient portal session'));
}

function publicMembershipPlan(row) {
  return {
    planId: row.PlanId,
    planKey: row.PlanKey || '',
    badge: '',
    title: row.Title || '',
    priceLabel: row.PriceLabel || '',
    content: row.Content || '',
    checkoutUrl: row.CheckoutUrl || '',
    stripeProductId: row.StripeProductId || '',
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

function stripeObjectId(value) {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return value.id ? String(value.id) : '';
}

function plainTextFromHtml(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function stripeAmountCents(cost) {
  const amount = Math.round(Number(cost || 0) * 100);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
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

function planMatches(plan, value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return [plan?.PlanKey, plan?.Title]
    .some((candidate) => String(candidate || '').trim().toLowerCase() === normalized);
}

function hasUsableMembershipStatus(account) {
  const status = String(account?.MembershipPaymentStatus || '').trim().toLowerCase();
  if (!account?.StripeSubscriptionId) {
    return Boolean(account?.MembershipPlan);
  }
  return ['active', 'trialing', 'paid', 'manual'].includes(status);
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
      badge: '',
      title: 'Annual Membership',
      priceLabel: '$150/year',
      cost: 150,
      checkoutUrl: '3YHUJ4ZLFDM5J7BM',
      displayOrder: 10,
      content: '<p><strong>Annual Membership Plan includes:</strong></p><ul><li>1 Dental Cleaning Per Year</li><li>Unlimited Diagnostic X-Rays</li><li>Unlimited Consultations</li></ul>'
    },
    {
      planKey: 'gold-annual',
      badge: '',
      title: 'Gold Membership',
      priceLabel: '$220/year',
      cost: 220,
      checkoutUrl: 'TGD4NDP3MJLQ6MM',
      displayOrder: 20,
      isFeatured: 1,
      content: '<p><strong>Annual Membership Plan includes:</strong></p><ul><li>2 Dental Cleanings Per Year</li><li>Unlimited Diagnostic X-Rays</li><li>Unlimited Consultations</li></ul>'
    },
    {
      planKey: 'vip-annual',
      badge: '',
      title: 'Diamond Membership',
      priceLabel: '$350/year',
      cost: 350,
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
      StripeProductId VARCHAR(190) NOT NULL DEFAULT '',
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
  await ensureColumn(planColumns, 'luk_membership_plans', 'StripeProductId', "VARCHAR(190) NOT NULL DEFAULT ''");
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
  const driverLicense = optionalString(body, 'driverLicense');
  const email = normalizeEmail(requiredString(body, 'email', 'Email'));
  const password = requiredString(body, 'password', 'Password');
  requiredAgreement(body);
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
    phone: optionalString(body, 'phone'),
    agreementAccepted: true,
    agreementVersion: optionalString(body, 'agreementVersion').slice(0, 50)
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

export function parsePatientAccountDeleteBody(body) {
  const accountId = Number.parseInt(body.accountId ?? body.AccountId ?? '', 10);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw badRequest('accountId is required.');
  }
  return { accountId };
}

export function parseMembershipPlanBody(body) {
  const planId = Number.parseInt(body.planId ?? body.PlanId ?? '', 10) || 0;
  const title = requiredString(body, 'title', 'Plan title').slice(0, 190);
  const planKey = normalizePlanKey(optionalString(body, 'planKey'), title);
  const badge = optionalString(body, 'badge').slice(0, 100);
  const priceLabel = optionalString(body, 'priceLabel').slice(0, 100);
  const content = optionalString(body, 'content');
  const checkoutUrl = optionalString(body, 'checkoutUrl').slice(0, 500);
  const stripeProductId = optionalString(body, 'stripeProductId').slice(0, 190);
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
    stripeProductId,
    stripePriceId,
    cost,
    displayOrder,
    isFeatured,
    isActive
  };
}

export function parsePatientPortalCheckoutBody(body) {
  const membershipPlan = requiredString(body, 'membershipPlan', 'Membership plan').slice(0, 100);
  requiredAgreement(body);
  const session = authenticatedAccountBody(body);
  return {
    accountId: session.accountId,
    membershipPlan,
    renewExisting: ['1', 'true', 'yes', 'on'].includes(String(body.renewExisting ?? '').toLowerCase()),
    agreementAccepted: true,
    agreementVersion: optionalString(body, 'agreementVersion').slice(0, 50),
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

export function parsePatientPortalAccountBody(body) {
  const session = authenticatedAccountBody(body);
  return { accountId: session.accountId };
}

export function parsePatientPortalCheckoutVerifyBody(body) {
  const session = authenticatedAccountBody(body);
  const sessionId = requiredString(body, 'sessionId', 'Stripe checkout session').slice(0, 190);
  return {
    accountId: session.accountId,
    sessionId
  };
}

export function parsePatientPortalCustomerPortalBody(body) {
  const session = authenticatedAccountBody(body);
  return {
    accountId: session.accountId,
    returnUrl: normalizeCheckoutUrl(
      optionalString(body, 'returnUrl') || config.stripe.customerPortalReturnUrl || config.stripe.successUrl,
      'returnUrl'
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
  if (!input.driverLicense) {
    const [rows] = await connection.execute(
      `SELECT
         p.PatNum, p.FName, p.LName, p.Birthdate, p.WirelessPhone, p.Email
       FROM patient p
       WHERE LOWER(p.FName) = LOWER(?)
         AND LOWER(p.LName) = LOWER(?)
         AND p.Birthdate = ?
       ORDER BY p.PatNum DESC
       LIMIT 1`,
      [input.firstName, input.lastName, input.birthdate]
    );
    return rows[0] || null;
  }

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
    const account = rows[0];
    return {
      account: publicAccount(account),
      ...issuePortalToken(account),
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
      account: publicAccount(account),
      ...issuePortalToken(account)
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

export async function getPatientAccount(input = {}) {
  await ensurePatientPortalTables();
  const accountId = Number.parseInt(input.accountId ?? input.AccountId ?? '', 10);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw badRequest('accountId is required.');
  }
  const [rows] = await pool.execute(
    `SELECT ${ACCOUNT_PUBLIC_COLUMNS}
     FROM luk_patient_accounts
     WHERE AccountId = ?
     LIMIT 1`,
    [accountId]
  );
  if (!rows.length) {
    const error = new Error('Patient account was not found.');
    error.status = 404;
    throw error;
  }
  return {
    account: publicAccount(rows[0])
  };
}

function publicMembershipProcedure(row) {
  return {
    procNum: row.ProcNum,
    status: Number(row.ProcStatus || 0),
    statusLabel: Number(row.ProcStatus || 0) === 2 ? 'Completed' : 'Treatment planned',
    date: row.ProcDate || '',
    code: row.ProcCode || '',
    description: row.Description || row.ProcCode || '',
    toothNum: row.ToothNum || '',
    surface: row.Surf || '',
    fee: Number(row.ProcFee || 0)
  };
}

function publicPaymentLedgerRow(row) {
  return {
    date: row.RowDate || '',
    type: row.RowType || '',
    code: row.ProcCode || '',
    description: row.Description || '',
    method: row.PaymentMethod || '',
    charge: Number(row.Charge || 0),
    payment: Number(row.Payment || 0),
    balance: Number(row.Balance || 0)
  };
}

export async function getPatientAccountTreatments(input = {}) {
  await ensurePatientPortalTables();
  const accountId = Number.parseInt(input.accountId ?? input.AccountId ?? '', 10);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw badRequest('accountId is required.');
  }

  const [accountRows] = await pool.execute(
    `SELECT ${ACCOUNT_PUBLIC_COLUMNS}
     FROM luk_patient_accounts
     WHERE AccountId = ?
     LIMIT 1`,
    [accountId]
  );
  if (!accountRows.length) {
    const error = new Error('Patient account was not found.');
    error.status = 404;
    throw error;
  }

  const account = publicAccount(accountRows[0]);
  if (!account.patNum) {
    const error = new Error('Link this account to an Open Dental Pat # before viewing treatment history.');
    error.status = 409;
    throw error;
  }

  const [rows] = await pool.execute(
    `SELECT
       pl.ProcNum,
       pl.ProcStatus,
       DATE_FORMAT(pl.ProcDate, '%Y-%m-%d') AS ProcDate,
       pc.ProcCode,
       COALESCE(NULLIF(pc.Descript, ''), pc.ProcCode) AS Description,
       pl.ToothNum,
       pl.Surf,
       pl.ProcFee
     FROM procedurelog pl
     INNER JOIN procedurecode pc ON pc.CodeNum = pl.CodeNum
     WHERE pl.PatNum = ?
       AND pl.ProcStatus IN (1, 2)
     ORDER BY
       CASE WHEN pl.ProcStatus = 1 THEN 0 ELSE 1 END,
       pl.ProcDate DESC,
       pl.ProcNum DESC`,
    [account.patNum]
  );

  const completed = [];
  const needed = [];
  rows.forEach((row) => {
    const procedure = publicMembershipProcedure(row);
    if (procedure.status === 2) {
      completed.push(procedure);
    } else if (procedure.status === 1) {
      needed.push(procedure);
    }
  });

  const [ledgerRows] = await pool.execute(
    `SELECT
       RowDate,
       RowType,
       ProcCode,
       Description,
       PaymentMethod,
       Charge,
       Payment
     FROM (
       SELECT
         DATE_FORMAT(pl.ProcDate, '%Y-%m-%d') AS RowDate,
         'Procedure' AS RowType,
         pc.ProcCode AS ProcCode,
         COALESCE(NULLIF(pc.Descript, ''), pc.ProcCode) AS Description,
         '' AS PaymentMethod,
         COALESCE(pl.ProcFee, 0) AS Charge,
         0 AS Payment,
         1 AS SortOrder,
         pl.ProcNum AS RowId
       FROM procedurelog pl
       INNER JOIN procedurecode pc ON pc.CodeNum = pl.CodeNum
       WHERE pl.PatNum = ?
         AND pl.ProcStatus = 2
       UNION ALL
       SELECT
         DATE_FORMAT(p.PayDate, '%Y-%m-%d') AS RowDate,
         'Payment' AS RowType,
         'Pay' AS ProcCode,
         COALESCE(NULLIF(p.PayNote, ''), 'Patient payment') AS Description,
         COALESCE(NULLIF(d.ItemName, ''), NULLIF(p.CheckNum, ''), 'Payment') AS PaymentMethod,
         0 AS Charge,
         COALESCE(SUM(ps.SplitAmt), 0) AS Payment,
         2 AS SortOrder,
         p.PayNum AS RowId
       FROM paysplit ps
       INNER JOIN payment p ON p.PayNum = ps.PayNum
       LEFT JOIN definition d ON d.DefNum = p.PayType
       WHERE ps.PatNum = ?
       GROUP BY p.PayNum, p.PayDate, p.PayNote, p.CheckNum, p.PayAmt, d.ItemName
     ) ledger
     ORDER BY RowDate ASC, SortOrder ASC, RowId ASC`,
    [account.patNum, account.patNum]
  );
  let runningBalance = 0;
  const ledger = ledgerRows.map((row) => {
    runningBalance += Number(row.Charge || 0) - Number(row.Payment || 0);
    return publicPaymentLedgerRow({ ...row, Balance: runningBalance });
  }).reverse();
  const payments = ledger
    .map(publicPaymentLedgerRow)
    .filter((row) => row.type === 'Payment');

  return {
    account,
    summary: {
      completedCount: completed.length,
      neededCount: needed.length,
      lastCompletedDate: completed[0]?.date || ''
    },
    completed,
    needed,
    payments
  };
}

export async function getPatientAccountPaymentDebug(input = {}) {
  await ensurePatientPortalTables();
  const accountId = Number.parseInt(input.accountId ?? input.AccountId ?? '', 10);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw badRequest('accountId is required.');
  }
  const [accountRows] = await pool.execute(
    `SELECT ${ACCOUNT_PUBLIC_COLUMNS}
     FROM luk_patient_accounts
     WHERE AccountId = ?
     LIMIT 1`,
    [accountId]
  );
  if (!accountRows.length) {
    const error = new Error('Patient account was not found.');
    error.status = 404;
    throw error;
  }
  const account = publicAccount(accountRows[0]);
  if (!account.patNum) {
    throw badRequest('Account is not linked to a PatNum.');
  }
  const [patientRows] = await pool.execute(
    `SELECT PatNum, FName, LName, Guarantor, EstBalance, BalTotal
     FROM patient
     WHERE PatNum = ?`,
    [account.patNum]
  );
  const [paymentRows] = await pool.execute(
    `SELECT
       p.PayNum,
       p.PatNum AS PaymentPatNum,
       DATE_FORMAT(p.PayDate, '%Y-%m-%d') AS PayDate,
       p.PayAmt,
       p.PayType,
       d.ItemName AS PaymentMethod,
       p.CheckNum,
       p.PayNote
     FROM payment p
     LEFT JOIN definition d ON d.DefNum = p.PayType
     WHERE p.PatNum = ?
     ORDER BY p.PayDate DESC, p.PayNum DESC`,
    [account.patNum]
  );
  const [splitRows] = await pool.execute(
    `SELECT
       ps.SplitNum,
       ps.PayNum,
       ps.PatNum AS SplitPatNum,
       ps.ProcNum,
       ps.SplitAmt,
       DATE_FORMAT(ps.DatePay, '%Y-%m-%d') AS DatePay,
       ps.UnearnedType,
       p.PatNum AS PaymentPatNum,
       DATE_FORMAT(p.PayDate, '%Y-%m-%d') AS PayDate,
       p.PayAmt,
       p.PayType,
       d.ItemName AS PaymentMethod,
       p.CheckNum,
       p.PayNote
     FROM paysplit ps
     LEFT JOIN payment p ON p.PayNum = ps.PayNum
     LEFT JOIN definition d ON d.DefNum = p.PayType
     WHERE ps.PatNum = ?
     ORDER BY COALESCE(p.PayDate, ps.DatePay) DESC, ps.SplitNum DESC`,
    [account.patNum]
  );
  const [ledgerPaymentRows] = await pool.execute(
    `SELECT
       DATE_FORMAT(p.PayDate, '%Y-%m-%d') AS RowDate,
       'Payment' AS RowType,
       'Pay' AS ProcCode,
       COALESCE(NULLIF(p.PayNote, ''), 'Patient payment') AS Description,
       COALESCE(NULLIF(d.ItemName, ''), NULLIF(p.CheckNum, ''), 'Payment') AS PaymentMethod,
       0 AS Charge,
       COALESCE(SUM(ps.SplitAmt), 0) AS Payment,
       p.PayNum AS RowId
     FROM paysplit ps
     INNER JOIN payment p ON p.PayNum = ps.PayNum
     LEFT JOIN definition d ON d.DefNum = p.PayType
     WHERE ps.PatNum = ?
     GROUP BY p.PayNum, p.PayDate, p.PayNote, p.CheckNum, p.PayAmt, d.ItemName
     ORDER BY RowDate DESC, RowId DESC`,
    [account.patNum]
  );
  return {
    account,
    patientRows,
    paymentRows,
    splitRows,
    ledgerPaymentRows,
    counts: {
      paymentRows: paymentRows.length,
      splitRows: splitRows.length,
      ledgerPaymentRows: ledgerPaymentRows.length
    }
  };
}

export async function deletePatientAccount(input) {
  await ensurePatientPortalTables();
  const accountId = Number.parseInt(input.accountId ?? input.AccountId ?? '', 10);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw badRequest('accountId is required.');
  }
  const [existingRows] = await pool.execute(
    `SELECT AccountId, PatNum, Email
     FROM luk_patient_accounts
     WHERE AccountId = ?
     LIMIT 1`,
    [accountId]
  );
  if (!existingRows.length) {
    const error = new Error('Patient account was not found.');
    error.status = 404;
    throw error;
  }
  await pool.execute(
    `DELETE FROM luk_patient_accounts
     WHERE AccountId = ?`,
    [accountId]
  );
  return {
    deleted: true,
    accountId,
    patNum: existingRows[0].PatNum || null,
    email: existingRows[0].Email || ''
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
  let existingPlan = null;
  if (input.planId > 0) {
    const [existingRows] = await pool.execute(
      `SELECT StripeProductId, StripePriceId
       FROM luk_membership_plans
       WHERE PlanId = ?
       LIMIT 1`,
      [input.planId]
    );
    existingPlan = existingRows[0] || null;
    if (existingPlan) {
      input.stripeProductId = input.stripeProductId || existingPlan.StripeProductId || '';
      input.stripePriceId = input.stripePriceId || existingPlan.StripePriceId || '';
    }
  }

  if (input.planId > 0) {
    const [result] = await pool.execute(
      `UPDATE luk_membership_plans
       SET PlanKey = ?, Badge = ?, Title = ?, PriceLabel = ?, Content = ?, CheckoutUrl = ?, StripeProductId = ?, StripePriceId = ?, Cost = ?,
           IsFeatured = ?, IsActive = ?, DisplayOrder = ?
       WHERE PlanId = ?`,
      [
        input.planKey,
        input.badge,
        input.title,
        input.priceLabel,
        input.content,
        input.checkoutUrl,
        input.stripeProductId,
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
        (PlanKey, Badge, Title, PriceLabel, Content, CheckoutUrl, StripeProductId, StripePriceId, Cost, IsFeatured, IsActive, DisplayOrder)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.planKey,
        input.badge,
        input.title,
        input.priceLabel,
        input.content,
        input.checkoutUrl,
        input.stripeProductId,
        input.stripePriceId,
        input.cost,
        input.isFeatured,
        input.isActive,
        input.displayOrder
      ]
    );
    input.planId = result.insertId;
  }

  const [savedRows] = await pool.execute(
    `SELECT ${PLAN_PUBLIC_COLUMNS}
     FROM luk_membership_plans
     WHERE PlanId = ?
     LIMIT 1`,
    [input.planId]
  );
  let stripeSync = { ok: false, message: 'Stripe sync was not attempted.' };
  if (savedRows[0]) {
    try {
      stripeSync = await syncMembershipPlanWithStripe(savedRows[0]);
    } catch (error) {
      stripeSync = {
        ok: false,
        message: error.message || 'Stripe sync failed.'
      };
    }
  }

  const [rows] = await pool.execute(
    `SELECT ${PLAN_PUBLIC_COLUMNS}
     FROM luk_membership_plans
     WHERE PlanId = ?
     LIMIT 1`,
    [input.planId]
  );
  return {
    plan: publicMembershipPlan(rows[0]),
    stripeSync
  };
}

async function syncMembershipPlanWithStripe(row) {
  if (!config.stripe.secretKey) {
    return {
      ok: false,
      message: 'Stripe secret key is not configured. Save again after adding STRIPE_SECRET_KEY to bridge .env.'
    };
  }

  const amount = stripeAmountCents(row.Cost);
  if (!amount) {
    return {
      ok: false,
      message: 'Plan cost must be greater than 0 before Stripe can create a yearly subscription price.'
    };
  }

  const client = stripe();
  const metadata = {
    lukMembershipPlanId: String(row.PlanId),
    planKey: row.PlanKey || ''
  };
  const active = Boolean(row.IsActive);
  const productPayload = {
    name: row.Title || row.PlanKey || `LUK Dental Membership ${row.PlanId}`,
    description: plainTextFromHtml(row.Content),
    active,
    metadata
  };
  let productId = row.StripeProductId || '';
  if (productId) {
    try {
      await client.products.update(productId, productPayload);
    } catch (error) {
      if (error && error.statusCode === 404) {
        productId = '';
      } else {
        throw error;
      }
    }
  }
  if (!productId) {
    const product = await client.products.create(productPayload);
    productId = product.id;
  }

  let priceId = row.StripePriceId || '';
  let keepExistingPrice = false;
  if (priceId) {
    try {
      const currentPrice = await client.prices.retrieve(priceId);
      const currentProductId = stripeObjectId(currentPrice.product);
      keepExistingPrice = currentPrice
        && currentPrice.unit_amount === amount
        && currentPrice.currency === 'usd'
        && currentProductId === productId
        && currentPrice.recurring
        && currentPrice.recurring.interval === 'year';
      if (keepExistingPrice) {
        await client.prices.update(priceId, {
          active,
          nickname: row.Title || row.PlanKey || undefined,
          metadata
        });
      }
    } catch (error) {
      if (error && error.statusCode !== 404) {
        throw error;
      }
      keepExistingPrice = false;
    }
  }

  if (!keepExistingPrice) {
    const price = await client.prices.create({
      product: productId,
      unit_amount: amount,
      currency: 'usd',
      recurring: { interval: 'year' },
      nickname: row.Title || row.PlanKey || undefined,
      metadata
    });
    if (priceId) {
      try {
        await client.prices.update(priceId, { active: false });
      } catch (_error) {}
    }
    priceId = price.id;
  }

  await pool.execute(
    `UPDATE luk_membership_plans
     SET StripeProductId = ?, StripePriceId = ?
     WHERE PlanId = ?`,
    [productId, priceId, row.PlanId]
  );

  return {
    ok: true,
    productId,
    priceId,
    message: 'Stripe product and yearly price are synced.'
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

  const now = new Date();
  const currentPeriodEnd = new Date(now);
  currentPeriodEnd.setFullYear(currentPeriodEnd.getFullYear() + 1);
  const periodEnd = currentPeriodEnd.toISOString().slice(0, 19).replace('T', ' ');
  const activatedAt = now.toISOString().slice(0, 19).replace('T', ' ');

  const [result] = await pool.execute(
    `UPDATE luk_patient_accounts
     SET MembershipPlan = ?,
         MembershipActivatedAt = COALESCE(MembershipActivatedAt, ?),
         MembershipCurrentPeriodEnd = COALESCE(MembershipCurrentPeriodEnd, ?),
         MembershipPaymentStatus = CASE
           WHEN MembershipPaymentStatus = '' OR MembershipPaymentStatus IS NULL THEN 'manual'
           ELSE MembershipPaymentStatus
         END
     WHERE AccountId = ?`,
    [input.membershipPlan, activatedAt, periodEnd, input.accountId]
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
    const error = new Error(`"${plan.Title}" is not synced with Stripe yet. Open admin Membership Plans, check the cost, and save the plan after STRIPE_SECRET_KEY is configured.`);
    error.status = 400;
    throw error;
  }
  if (!input.renewExisting && planMatches(plan, account.MembershipPlan) && hasUsableMembershipStatus(account)) {
    const error = new Error(`"${plan.Title}" is already your current membership plan.`);
    error.status = 409;
    throw error;
  }

  const metadata = {
    accountId: String(account.AccountId),
    patNum: account.PatNum ? String(account.PatNum) : '',
    planKey: plan.PlanKey,
    planTitle: plan.Title,
    agreementVersion: input.agreementVersion || ''
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
    allow_promotion_codes: true,
    adaptive_pricing: { enabled: false }
  };

  if (account.StripeCustomerId && !input.renewExisting) {
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

export async function verifyMembershipCheckoutSession(input) {
  await ensurePatientPortalTables();
  const session = await stripe().checkout.sessions.retrieve(input.sessionId);
  const sessionAccountId = Number.parseInt(session?.metadata?.accountId ?? session?.client_reference_id ?? '', 10);
  if (sessionAccountId !== input.accountId) {
    const error = new Error('Stripe checkout session does not belong to this patient portal account.');
    error.status = 403;
    throw error;
  }
  if (session.payment_status !== 'paid' && session.status !== 'complete') {
    const error = new Error('Stripe checkout is not completed yet.');
    error.status = 409;
    throw error;
  }
  await completeCheckoutSession(session);
  return getPatientAccount({ accountId: input.accountId });
}

export async function createMembershipCustomerPortalSession(input) {
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
  if (!account.StripeCustomerId) {
    const error = new Error('No Stripe customer is linked to this membership yet.');
    error.status = 400;
    throw error;
  }
  const session = await stripe().billingPortal.sessions.create({
    customer: account.StripeCustomerId,
    return_url: input.returnUrl
  });
  return {
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
  const customerId = typeof subscription === 'string' ? '' : stripeObjectId(subscription.customer);
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
        stripeObjectId(session.customer),
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
