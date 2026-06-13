import { pool } from './db.js';
import { config } from './config.js';

const LOG_TABLE = 'luk_sms_reminder_log';
const RECALL_LOG_TABLE = 'luk_sms_recall_log';
const CAMPAIGN_LOG_TABLE = 'luk_sms_campaign_log';
const TREATMENT_LOG_TABLE = 'luk_sms_treatment_log';
const SMS_SETTINGS_TABLE = 'luk_sms_settings';

function parseDate(value) {
  const text = String(value ?? '').trim();
  const mdy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  }
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return text;
  }
  const error = new Error('date must use YYYY-MM-DD or MM/DD/YYYY.');
  error.status = 400;
  throw error;
}

function parseLimit(value, fallback = 200) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, 500));
}

function parseMonths(value, fallback = 6) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, 60));
}

function parseDays(value, fallback = 21) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, 365));
}

function parseStatuses(value) {
  if (!value) return config.booking.busyAptStatuses?.length ? config.booking.busyAptStatuses : [1];
  const statuses = String(value)
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isInteger(item));
  return statuses.length ? statuses : [1];
}

function digitsOnly(value) {
  const digits = String(value ?? '').replace(/\D+/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function formatUsPhone(value) {
  const digits = digitsOnly(value);
  if (digits.length !== 10) return String(value ?? '').trim();
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function parseProcedureCodes(value) {
  const defaults = ['D1110', 'D1120', 'D4341', 'D4342'];
  const codes = String(value ?? '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  return codes.length ? codes : defaults;
}

function parseOptionalProcedureCodes(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function patternMinutes(pattern, fallback) {
  const minutes = String(pattern ?? '').length * 5;
  return minutes > 0 ? minutes : fallback;
}

export async function ensureSmsReminderLogTable(connection = pool) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS ${LOG_TABLE} (
      ReminderLogNum BIGINT NOT NULL AUTO_INCREMENT,
      AptNum BIGINT NOT NULL,
      PatNum BIGINT NOT NULL,
      Phone VARCHAR(30) NOT NULL,
      ReminderForDate DATE NOT NULL,
      ReminderOffsetDays INT NOT NULL DEFAULT 1,
      Message TEXT NOT NULL,
      Status VARCHAR(30) NOT NULL,
      SentAt DATETIME NULL,
      ErrorMessage TEXT NULL,
      CreatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (ReminderLogNum),
      UNIQUE KEY uq_luk_sms_reminder (AptNum, ReminderForDate, Phone, ReminderOffsetDays)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  const [columns] = await connection.execute(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = 'ReminderOffsetDays'
    `,
    [LOG_TABLE]
  );
  if (!columns.length) {
    await connection.execute(`ALTER TABLE ${LOG_TABLE} ADD COLUMN ReminderOffsetDays INT NOT NULL DEFAULT 1 AFTER ReminderForDate`);
  }
  const [indexes] = await connection.execute(
    `
      SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS Columns
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = 'uq_luk_sms_reminder'
    `,
    [LOG_TABLE]
  );
  if (indexes?.[0]?.Columns !== 'AptNum,ReminderForDate,Phone,ReminderOffsetDays') {
    try {
      await connection.execute(`ALTER TABLE ${LOG_TABLE} DROP INDEX uq_luk_sms_reminder`);
    } catch (_error) {
      // Fresh installs already have the desired phone-aware unique key.
    }
    await connection.execute(`ALTER TABLE ${LOG_TABLE} ADD UNIQUE KEY uq_luk_sms_reminder (AptNum, ReminderForDate, Phone, ReminderOffsetDays)`);
  }
}

export async function ensureSmsRecallLogTable(connection = pool) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS ${RECALL_LOG_TABLE} (
      RecallLogNum BIGINT NOT NULL AUTO_INCREMENT,
      PatNum BIGINT NOT NULL,
      Phone VARCHAR(30) NOT NULL,
      ProcedureCodes VARCHAR(255) NOT NULL DEFAULT '',
      LastProcDate DATE NULL,
      Message TEXT NOT NULL,
      Status VARCHAR(30) NOT NULL,
      SentAt DATETIME NULL,
      ErrorMessage TEXT NULL,
      CreatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (RecallLogNum),
      KEY idx_luk_sms_recall_patient (PatNum, Phone),
      KEY idx_luk_sms_recall_sent (SentAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function ensureSmsCampaignLogTable(connection = pool) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS ${CAMPAIGN_LOG_TABLE} (
      CampaignLogNum BIGINT NOT NULL AUTO_INCREMENT,
      CampaignType VARCHAR(40) NOT NULL DEFAULT '',
      CampaignName VARCHAR(255) NOT NULL DEFAULT '',
      PatNum BIGINT NOT NULL DEFAULT 0,
      Phone VARCHAR(30) NOT NULL,
      TemplateKey VARCHAR(50) NOT NULL DEFAULT '',
      Message TEXT NOT NULL,
      Status VARCHAR(30) NOT NULL,
      SentAt DATETIME NULL,
      ErrorMessage TEXT NULL,
      CreatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (CampaignLogNum),
      KEY idx_luk_sms_campaign_patient (PatNum, Phone),
      KEY idx_luk_sms_campaign_sent (SentAt),
      KEY idx_luk_sms_campaign_type (CampaignType, CampaignName)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function ensureSmsTreatmentLogTable(connection = pool) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS ${TREATMENT_LOG_TABLE} (
      TreatmentLogNum BIGINT NOT NULL AUTO_INCREMENT,
      PatNum BIGINT NOT NULL,
      Phone VARCHAR(30) NOT NULL,
      ProcedureCodes VARCHAR(255) NOT NULL DEFAULT '',
      LastPendingProcDate DATE NULL,
      Message TEXT NOT NULL,
      Status VARCHAR(30) NOT NULL,
      SentAt DATETIME NULL,
      ErrorMessage TEXT NULL,
      CreatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (TreatmentLogNum),
      KEY idx_luk_sms_treatment_patient (PatNum, Phone),
      KEY idx_luk_sms_treatment_sent (SentAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function getSmsReminderAppointments(query) {
  const targetDate = parseDate(query.date);
  const statuses = parseStatuses(query.statuses);
  const placeholders = statuses.map(() => '?').join(',');
  await ensureSmsReminderLogTable();

  const [rows] = await pool.execute(
    `
      SELECT
        a.AptNum,
        a.PatNum,
        DATE_FORMAT(a.AptDateTime, '%Y-%m-%d %H:%i:%s') AS AptDateTime,
        a.Pattern,
        a.AptStatus,
        a.ProcDescript,
        p.FName,
        p.LName,
        p.WirelessPhone,
        p.HmPhone,
        p.WkPhone,
        p.Email,
        p.Language,
        p.Gender,
        DATE_FORMAT(p.Birthdate, '%Y-%m-%d') AS Birthdate
      FROM appointment a
      INNER JOIN patient p ON p.PatNum = a.PatNum
      WHERE a.AptDateTime >= ?
        AND a.AptDateTime < DATE_ADD(?, INTERVAL 1 DAY)
        AND a.AptStatus IN (${placeholders})
      ORDER BY a.AptDateTime, p.LName, p.FName
    `,
    [`${targetDate} 00:00:00`, `${targetDate} 00:00:00`, ...statuses]
  );

  return {
    date: targetDate,
    appointments: rows.map((row) => {
      const phone = formatUsPhone(row.WirelessPhone || row.HmPhone || row.WkPhone || '');
      return {
        ...row,
        WirelessPhoneFormatted: formatUsPhone(row.WirelessPhone || ''),
        WorkPhoneFormatted: formatUsPhone(row.WkPhone || ''),
        HomePhoneFormatted: formatUsPhone(row.HmPhone || ''),
        Phone: phone,
        DurationMinutes: patternMinutes(row.Pattern, config.booking.fallbackDurationMinutes)
      };
    })
  };
}

export async function getSmsBirthdayCandidates(query = {}) {
  const targetDate = query.date ? parseDate(query.date) : new Date().toISOString().slice(0, 10);
  const limit = parseLimit(query.limit, 300);
  const [rows] = await pool.execute(
    `
      SELECT
        p.PatNum,
        p.FName,
        p.LName,
        p.WirelessPhone,
        p.HmPhone,
        p.WkPhone,
        p.Email,
        p.Language,
        p.Gender,
        DATE_FORMAT(p.Birthdate, '%Y-%m-%d') AS Birthdate,
        DATE_FORMAT(MAX(a.AptDateTime), '%Y-%m-%d %H:%i:%s') AS LastAppointment
      FROM patient p
      LEFT JOIN appointment a ON a.PatNum = p.PatNum
      WHERE p.PatStatus = 0
        AND p.Birthdate IS NOT NULL
        AND p.Birthdate > '1900-01-01'
        AND MONTH(p.Birthdate) = MONTH(?)
        AND DAYOFMONTH(p.Birthdate) = DAYOFMONTH(?)
      GROUP BY
        p.PatNum,
        p.FName,
        p.LName,
        p.WirelessPhone,
        p.HmPhone,
        p.WkPhone,
        p.Email,
        p.Language,
        p.Gender,
        p.Birthdate
      ORDER BY p.LName, p.FName
      LIMIT ?
    `,
    [targetDate, targetDate, limit]
  );

  return {
    date: targetDate,
    patients: rows.map((row) => ({
      ...row,
      WirelessPhoneFormatted: formatUsPhone(row.WirelessPhone || ''),
      WorkPhoneFormatted: formatUsPhone(row.WkPhone || ''),
      HomePhoneFormatted: formatUsPhone(row.HmPhone || ''),
      Phone: formatUsPhone(row.WirelessPhone || row.HmPhone || row.WkPhone || '')
    }))
  };
}

export async function getSmsRecallCandidates(query = {}) {
  await ensureSmsRecallLogTable();
  const months = parseMonths(query.months, 6);
  const codes = parseProcedureCodes(query.codes);
  const statuses = parseStatuses(query.statuses);
  const codePlaceholders = codes.map(() => '?').join(',');
  const statusPlaceholders = statuses.map(() => '?').join(',');
  const limit = parseLimit(query.limit, 250);

  const [rows] = await pool.execute(
    `
      SELECT
        p.PatNum,
        p.FName,
        p.LName,
        p.WirelessPhone,
        p.HmPhone,
        p.WkPhone,
        p.Email,
        p.Language,
        p.Gender,
        DATE_FORMAT(p.Birthdate, '%Y-%m-%d') AS Birthdate,
        DATE_FORMAT(MAX(pl.ProcDate), '%Y-%m-%d') AS LastProcDate,
        GROUP_CONCAT(DISTINCT pc.ProcCode ORDER BY pc.ProcCode SEPARATOR ', ') AS ProcedureCodes,
        COALESCE(rl.RecallSentCount, 0) AS RecallSentCount,
        DATE_FORMAT(rl.LastRecallSentAt, '%Y-%m-%d %H:%i:%s') AS LastRecallSentAt
      FROM procedurelog pl
      INNER JOIN procedurecode pc ON pc.CodeNum = pl.CodeNum
      INNER JOIN patient p ON p.PatNum = pl.PatNum
      LEFT JOIN (
        SELECT
          PatNum,
          COUNT(*) AS RecallSentCount,
          MAX(SentAt) AS LastRecallSentAt
        FROM ${RECALL_LOG_TABLE}
        WHERE Status = 'sent'
        GROUP BY PatNum
      ) rl ON rl.PatNum = p.PatNum
      WHERE pc.ProcCode IN (${codePlaceholders})
        AND pl.ProcStatus = 2
        AND p.PatStatus = 0
      GROUP BY
        p.PatNum,
        p.FName,
        p.LName,
        p.WirelessPhone,
        p.HmPhone,
        p.WkPhone,
        p.Email,
        p.Language,
        p.Gender,
        p.Birthdate,
        rl.RecallSentCount,
        rl.LastRecallSentAt
      HAVING MAX(pl.ProcDate) <= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
        AND NOT EXISTS (
          SELECT 1
          FROM appointment a
          WHERE a.PatNum = p.PatNum
            AND a.AptStatus IN (${statusPlaceholders})
            AND a.AptDateTime >= NOW()
        )
      ORDER BY MAX(pl.ProcDate), p.LName, p.FName
      LIMIT ?
    `,
    [...codes, months, ...statuses, limit]
  );

  return {
    months,
    codes,
    patients: rows.map((row) => ({
      ...row,
      WirelessPhoneFormatted: formatUsPhone(row.WirelessPhone || ''),
      WorkPhoneFormatted: formatUsPhone(row.WkPhone || ''),
      HomePhoneFormatted: formatUsPhone(row.HmPhone || ''),
      Phone: formatUsPhone(row.WirelessPhone || row.HmPhone || row.WkPhone || '')
    }))
  };
}

export async function getSmsTreatmentCandidates(query = {}) {
  await ensureSmsTreatmentLogTable();
  const beforeDays = parseDays(query.beforeDays ?? query.days, 21);
  const codes = parseOptionalProcedureCodes(query.codes);
  const statuses = parseStatuses(query.statuses);
  const treatmentStatuses = parseStatuses(query.treatmentStatuses || '1');
  const statusPlaceholders = statuses.map(() => '?').join(',');
  const treatmentStatusPlaceholders = treatmentStatuses.map(() => '?').join(',');
  const limit = parseLimit(query.limit, 250);
  const params = [...treatmentStatuses];
  let codeFilter = '';
  if (codes.length) {
    codeFilter = `AND pc.ProcCode IN (${codes.map(() => '?').join(',')})`;
    params.push(...codes);
  }

  const [rows] = await pool.execute(
    `
      SELECT
        p.PatNum,
        p.FName,
        p.LName,
        p.WirelessPhone,
        p.HmPhone,
        p.WkPhone,
        p.Email,
        p.Language,
        p.Gender,
        DATE_FORMAT(p.Birthdate, '%Y-%m-%d') AS Birthdate,
        DATE_FORMAT(MAX(pl.ProcDate), '%Y-%m-%d') AS LastPendingProcDate,
        GROUP_CONCAT(DISTINCT pc.ProcCode ORDER BY pc.ProcCode SEPARATOR ', ') AS ProcedureCodes,
        GROUP_CONCAT(DISTINCT COALESCE(NULLIF(pc.Descript, ''), pc.ProcCode) ORDER BY pc.ProcCode SEPARATOR ', ') AS ProcedureDescriptions,
        COALESCE(tl.TreatmentSentCount, 0) AS TreatmentSentCount,
        DATE_FORMAT(tl.LastTreatmentSentAt, '%Y-%m-%d %H:%i:%s') AS LastTreatmentSentAt
      FROM procedurelog pl
      INNER JOIN procedurecode pc ON pc.CodeNum = pl.CodeNum
      INNER JOIN patient p ON p.PatNum = pl.PatNum
      LEFT JOIN (
        SELECT
          PatNum,
          COUNT(*) AS TreatmentSentCount,
          MAX(SentAt) AS LastTreatmentSentAt
        FROM ${TREATMENT_LOG_TABLE}
        WHERE Status = 'sent'
        GROUP BY PatNum
      ) tl ON tl.PatNum = p.PatNum
      WHERE pl.ProcStatus IN (${treatmentStatusPlaceholders})
        ${codeFilter}
        AND p.PatStatus = 0
        AND pl.ProcDate IS NOT NULL
        AND pl.ProcDate > '1900-01-01'
      GROUP BY
        p.PatNum,
        p.FName,
        p.LName,
        p.WirelessPhone,
        p.HmPhone,
        p.WkPhone,
        p.Email,
        p.Language,
        p.Gender,
        p.Birthdate,
        tl.TreatmentSentCount,
        tl.LastTreatmentSentAt
      HAVING MAX(pl.ProcDate) <= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        AND NOT EXISTS (
          SELECT 1
          FROM appointment a
          WHERE a.PatNum = p.PatNum
            AND a.AptStatus IN (${statusPlaceholders})
            AND a.AptDateTime >= NOW()
        )
      ORDER BY MAX(pl.ProcDate), p.LName, p.FName
      LIMIT ?
    `,
    [...params, beforeDays, ...statuses, limit]
  );

  return {
    beforeDays,
    codes,
    treatmentStatuses,
    patients: rows.map((row) => ({
      ...row,
      LastProcDate: row.LastPendingProcDate,
      WirelessPhoneFormatted: formatUsPhone(row.WirelessPhone || ''),
      WorkPhoneFormatted: formatUsPhone(row.WkPhone || ''),
      HomePhoneFormatted: formatUsPhone(row.HmPhone || ''),
      Phone: formatUsPhone(row.WirelessPhone || row.HmPhone || row.WkPhone || '')
    }))
  };
}

export async function logSmsRecallResult(body) {
  await ensureSmsRecallLogTable();
  const patNum = Number.parseInt(String(body.patNum ?? ''), 10);
  const phone = String(body.phone ?? '').trim();
  const procedureCodes = String(body.procedureCodes ?? '').trim();
  const lastProcDate = body.lastProcDate ? parseDate(body.lastProcDate) : null;
  const message = String(body.message ?? '');
  const status = String(body.status ?? '').trim();
  const errorMessage = String(body.errorMessage ?? '');

  if (!Number.isInteger(patNum) || !phone || !status) {
    const error = new Error('patNum, phone, and status are required.');
    error.status = 400;
    throw error;
  }

  const sentAt = ['sent', 'dry-run'].includes(status) ? new Date() : null;
  await pool.execute(
    `
      INSERT INTO ${RECALL_LOG_TABLE}
        (PatNum, Phone, ProcedureCodes, LastProcDate, Message, Status, SentAt, ErrorMessage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [patNum, phone, procedureCodes, lastProcDate, message, status, sentAt, errorMessage]
  );

  return { patNum, phone, status };
}

export async function logSmsTreatmentResult(body) {
  await ensureSmsTreatmentLogTable();
  const patNum = Number.parseInt(String(body.patNum ?? ''), 10);
  const phone = String(body.phone ?? '').trim();
  const procedureCodes = String(body.procedureCodes ?? '').trim();
  const lastPendingProcDate = body.lastPendingProcDate || body.lastProcDate ? parseDate(body.lastPendingProcDate || body.lastProcDate) : null;
  const message = String(body.message ?? '');
  const status = String(body.status ?? '').trim();
  const errorMessage = String(body.errorMessage ?? '');

  if (!Number.isInteger(patNum) || !phone || !status) {
    const error = new Error('patNum, phone, and status are required.');
    error.status = 400;
    throw error;
  }

  const sentAt = ['sent', 'dry-run'].includes(status) ? new Date() : null;
  await pool.execute(
    `
      INSERT INTO ${TREATMENT_LOG_TABLE}
        (PatNum, Phone, ProcedureCodes, LastPendingProcDate, Message, Status, SentAt, ErrorMessage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [patNum, phone, procedureCodes, lastPendingProcDate, message, status, sentAt, errorMessage]
  );

  return { patNum, phone, status };
}

export async function logSmsCampaignResult(body) {
  await ensureSmsCampaignLogTable();
  const patNum = Number.parseInt(String(body.patNum ?? '0'), 10) || 0;
  const phone = String(body.phone ?? '').trim();
  const campaignType = String(body.campaignType ?? '').trim();
  const campaignName = String(body.campaignName ?? '').trim();
  const templateKey = String(body.templateKey ?? '').trim();
  const message = String(body.message ?? '');
  const status = String(body.status ?? '').trim();
  const errorMessage = String(body.errorMessage ?? '');

  if (!phone || !status) {
    const error = new Error('phone and status are required.');
    error.status = 400;
    throw error;
  }

  const sentAt = ['sent', 'dry-run'].includes(status) ? new Date() : null;
  await pool.execute(
    `
      INSERT INTO ${CAMPAIGN_LOG_TABLE}
        (CampaignType, CampaignName, PatNum, Phone, TemplateKey, Message, Status, SentAt, ErrorMessage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [campaignType, campaignName, patNum, phone, templateKey, message, status, sentAt, errorMessage]
  );

  return { patNum, phone, campaignType, campaignName, status };
}

export async function clearSmsDryRunLogs() {
  await ensureSmsReminderLogTable();
  await ensureSmsRecallLogTable();
  await ensureSmsTreatmentLogTable();
  const [reminderResult] = await pool.execute(
    `DELETE FROM ${LOG_TABLE} WHERE Status = 'dry-run'`
  );
  const [recallResult] = await pool.execute(
    `DELETE FROM ${RECALL_LOG_TABLE} WHERE Status = 'dry-run'`
  );
  const [treatmentResult] = await pool.execute(
    `DELETE FROM ${TREATMENT_LOG_TABLE} WHERE Status = 'dry-run'`
  );
  return {
    reminderDryRunDeleted: reminderResult.affectedRows ?? 0,
    recallDryRunDeleted: recallResult.affectedRows ?? 0,
    treatmentDryRunDeleted: treatmentResult.affectedRows ?? 0
  };
}

export async function resetSmsReminderLog(body) {
  await ensureSmsReminderLogTable();
  const aptNum = Number.parseInt(String(body.aptNum ?? ''), 10);
  const reminderForDate = parseDate(body.reminderForDate);
  const reminderOffsetDays = Math.max(0, Number.parseInt(String(body.reminderOffsetDays ?? '1'), 10) || 1);
  const phone = String(body.phone ?? '').trim();

  if (!Number.isInteger(aptNum) || !phone) {
    const error = new Error('aptNum, reminderForDate, and phone are required.');
    error.status = 400;
    throw error;
  }

  const [result] = await pool.execute(
    `
      DELETE FROM ${LOG_TABLE}
      WHERE AptNum = ?
        AND ReminderForDate = ?
        AND ReminderOffsetDays = ?
        AND Phone = ?
    `,
    [aptNum, reminderForDate, reminderOffsetDays, phone]
  );

  return {
    aptNum,
    reminderForDate,
    reminderOffsetDays,
    phone,
    deleted: result.affectedRows ?? 0
  };
}

export async function logSmsReminderResult(body) {
  await ensureSmsReminderLogTable();
  const aptNum = Number.parseInt(String(body.aptNum ?? ''), 10);
  const patNum = Number.parseInt(String(body.patNum ?? ''), 10);
  const reminderForDate = parseDate(body.reminderForDate);
  const reminderOffsetDays = Math.max(0, Number.parseInt(String(body.reminderOffsetDays ?? '1'), 10) || 1);
  const phone = String(body.phone ?? '').trim();
  const message = String(body.message ?? '');
  const status = String(body.status ?? '').trim();
  const errorMessage = String(body.errorMessage ?? '');

  if (!Number.isInteger(aptNum) || !Number.isInteger(patNum) || !status) {
    const error = new Error('aptNum, patNum, reminderForDate, and status are required.');
    error.status = 400;
    throw error;
  }

  const sentAt = ['sent', 'dry-run'].includes(status) ? new Date() : null;
  await pool.execute(
    `
      INSERT INTO ${LOG_TABLE}
        (AptNum, PatNum, Phone, ReminderForDate, ReminderOffsetDays, Message, Status, SentAt, ErrorMessage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        Phone = VALUES(Phone),
        Message = VALUES(Message),
        Status = VALUES(Status),
        SentAt = VALUES(SentAt),
        ErrorMessage = VALUES(ErrorMessage)
    `,
    [aptNum, patNum, phone, reminderForDate, reminderOffsetDays, message, status, sentAt, errorMessage]
  );

  return { aptNum, patNum, reminderForDate, reminderOffsetDays, status };
}

export async function getSmsReminderLogs(query = {}) {
  const limit = parseLimit(query.limit);
  const params = [];
  const where = [];
  if (query.date) {
    where.push('ReminderForDate = ?');
    params.push(parseDate(query.date));
  }
  await ensureSmsReminderLogTable();
  const [rows] = await pool.execute(
    `
      SELECT
        ReminderLogNum,
        AptNum,
        PatNum,
        Phone,
        DATE_FORMAT(ReminderForDate, '%Y-%m-%d') AS ReminderForDate,
        ReminderOffsetDays,
        Status,
        DATE_FORMAT(SentAt, '%Y-%m-%d %H:%i:%s') AS SentAt,
        ErrorMessage,
        DATE_FORMAT(CreatedAt, '%Y-%m-%d %H:%i:%s') AS CreatedAt
      FROM ${LOG_TABLE}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ReminderLogNum DESC
      LIMIT ?
    `,
    [...params, limit]
  );
  return { logs: rows };
}

// ===== SMS TEMPLATES TABLE & CRUD =====

const TEMPLATE_TABLE = 'luk_sms_templates';
const DEFAULT_REVIEW_LINK = 'https://g.page/r/CUSTOM_REVIEW_LINK/review';
const DEFAULT_SMS_SETTINGS = {
  clinic_name: 'LUK Dental',
  clinic_phone: '281-760-1357',
  reminder_days_ahead: '1',
  scheduled_send_time: '11:00',
  appointment_statuses: '1',
  recall_codes: 'D1110,D1120,D4341,D4342',
  recall_months: '6',
  treatment_days: '21',
  treatment_codes: '',
  treatment_statuses: '1',
  review_link: DEFAULT_REVIEW_LINK,
  holiday_events: ''
};
const SUPPORTED_SMS_SETTINGS = new Set(Object.keys(DEFAULT_SMS_SETTINGS));

const DEFAULT_SMS_TEMPLATE_ROWS = [
  { key: 'US', category: 'appointment', country: 'US', text: "Good morning {formal_first_name}, I'm Nhan Nguyen from Luk Dental. I would like to remind you of your appointment {relative_day}, {weekday}, {date_full} at {time_lower}. Thank you and have a great day." },
  { key: 'ES', category: 'appointment', country: 'ES', text: "Buenos días {formal_first_name}, soy Nhan Nguyen de Luk Dental. Le recuerdo su cita {relative_day_es}, {weekday}, {date_full} a las {time_lower}. Gracias y que tenga un excelente día." },
  { key: 'VI', category: 'appointment', country: 'VI', text: "Good morning {vi_salutation}, nha khoa Luk Dental xin nhắc lịch hẹn cho {vi_title} vào {relative_day_vi}. {weekday_vi}, {date_short} lúc {time_lower}. Thank you and have a great day." },
  { key: 'US', category: 'recall', country: 'US', text: "Good morning {salutation}, this is Luk Dental. Your 6-month cleaning recall is due. Please call {clinic_phone} or book online at https://lukdental.us/dental-appointment/ to schedule your appointment. Thank you and have a great day." },
  { key: 'ES', category: 'recall', country: 'ES', text: "Buenos días {salutation}, le habla Luk Dental. Ya llegó el momento de su limpieza de 6 meses. Por favor llame al {clinic_phone} o haga su cita en https://lukdental.us/dental-appointment/. Gracias y que tenga un excelente día." },
  { key: 'VI', category: 'recall', country: 'VI', text: "Good morning {vi_salutation}, nha khoa Luk Dental xin nhắc lịch cleaning 6 tháng của {vi_title} đã đến. {vi_title_cap} vui lòng gọi {clinic_phone} hoặc đặt lịch tại https://lukdental.us/dental-appointment/. Thank you and have a great day." },
  { key: 'US', category: 'treatment', country: 'US', text: "Good morning {salutation}, this is Luk Dental. Our records show you still have pending dental treatment ({procedure_codes}). Please call {clinic_phone} or book online at https://lukdental.us/dental-appointment/ so we can help you continue your care. Thank you and have a great day." },
  { key: 'ES', category: 'treatment', country: 'ES', text: "Buenos días {salutation}, le habla Luk Dental. Según nuestros registros, todavía tiene tratamiento dental pendiente ({procedure_codes}). Por favor llame al {clinic_phone} o haga su cita en https://lukdental.us/dental-appointment/ para continuar su cuidado. Gracias y que tenga un excelente día." },
  { key: 'VI', category: 'treatment', country: 'VI', text: "Good morning {vi_salutation}, nha khoa Luk Dental xin nhắc {vi_title} hiện còn điều trị răng cần hoàn tất ({procedure_codes}). {vi_title_cap} vui lòng gọi {clinic_phone} hoặc đặt lịch tại https://lukdental.us/dental-appointment/ để tiếp tục điều trị. Thank you and have a great day." },
  { key: 'US', category: 'review_google', country: 'US', text: "Hi {first_name}, thank you for visiting Luk Dental. If you had a good experience, would you mind leaving us a Google review? Your feedback helps our clinic and other patients. {review_link} Thank you." },
  { key: 'ES', category: 'review_google', country: 'ES', text: "Hola {first_name}, gracias por visitar Luk Dental. Si tuvo una buena experiencia, ¿podría dejarnos una reseña en Google? Sus comentarios ayudan a nuestra clínica y a otros pacientes. {review_link} Gracias." },
  { key: 'VI', category: 'review_google', country: 'VI', text: "Good morning {vi_salutation}, cảm ơn {vi_title} đã đến nha khoa Luk Dental. Nếu {vi_title} hài lòng với dịch vụ, nhờ {vi_title} để lại review Google giúp phòng khám nhé. {review_link} Thank you." },
  { key: 'US_HOLIDAY', category: 'holiday_birthday', country: 'US', text: "Hi {first_name}, Luk Dental wishes you and your family a happy {holiday_name}. We are offering a holiday dental care promotion. Please call {clinic_phone} or book online at https://lukdental.us/dental-appointment/ if you would like to schedule a visit. Thank you." },
  { key: 'ES_HOLIDAY', category: 'holiday_birthday', country: 'ES', text: "Hola {first_name}, Luk Dental le desea a usted y a su familia un feliz {holiday_name}. Tenemos una promoción especial para cuidado dental. Llame al {clinic_phone} o haga su cita en https://lukdental.us/dental-appointment/. Gracias." },
  { key: 'VI_HOLIDAY', category: 'holiday_birthday', country: 'VI', text: "Good morning {vi_salutation}, nha khoa Luk Dental kính chúc {vi_title} và gia đình một dịp {holiday_name} vui vẻ. Phòng khám đang có chương trình ưu đãi chăm sóc răng miệng. {vi_title_cap} vui lòng gọi {clinic_phone} hoặc đặt lịch tại https://lukdental.us/dental-appointment/. Thank you." },
  { key: 'US_BIRTHDAY', category: 'holiday_birthday', country: 'US', text: "Happy birthday {first_name}! Luk Dental wishes you a healthy and happy year ahead. If you would like to schedule a dental checkup, please call {clinic_phone} or book online at https://lukdental.us/dental-appointment/. Thank you." },
  { key: 'ES_BIRTHDAY', category: 'holiday_birthday', country: 'ES', text: "¡Feliz cumpleaños {first_name}! Luk Dental le desea mucha salud y felicidad. Si desea programar una revisión dental, llame al {clinic_phone} o haga su cita en https://lukdental.us/dental-appointment/. Gracias." },
  { key: 'VI_BIRTHDAY', category: 'holiday_birthday', country: 'VI', text: "Happy birthday {vi_salutation}! Nha khoa Luk Dental kính chúc {vi_title} thật nhiều sức khỏe và niềm vui. Nếu {vi_title} muốn đặt lịch kiểm tra răng miệng, vui lòng gọi {clinic_phone} hoặc đặt lịch tại https://lukdental.us/dental-appointment/. Thank you." },
];

function isManagedAppointmentTemplateVariant(key, text) {
  const normalizedKey = String(key ?? '').trim().toUpperCase();
  const normalizedText = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalizedKey === 'US') {
    return normalizedText.includes('luk dental')
      && normalizedText.includes('appointment')
      && (
        normalizedText.includes('i just remind')
        || normalizedText.includes('i send a notification')
        || normalizedText.includes('i would like to remind for')
        || normalizedText.includes('remind for your appointment')
        || normalizedText.includes('{salutation}')
        || normalizedText.includes('{first_name}')
        || normalizedText.includes('tommorrow')
        || normalizedText.includes('appointment today')
        || normalizedText.includes('appointment tomorrow')
      );
  }
  if (normalizedKey === 'ES') {
    return normalizedText.includes('luk dental')
      && normalizedText.includes('cita')
      && (
        normalizedText.includes('{salutation}')
        || normalizedText.includes('{first_name}')
        || normalizedText.includes('de mañana')
        || normalizedText.includes('envío una notificación')
      );
  }
  return false;
}

function shouldUpdateManagedTemplate(row, defaultRow) {
  // Never overwrite a template that already exists in the database.
  // Clinic-edited templates must remain the source of truth.
  return false;
}

function parseTemplateBody(body) {
  const key = String(body.templateKey ?? '').trim().toUpperCase();
  const category = ['appointment', 'recall', 'treatment', 'review_google', 'holiday_birthday'].includes(String(body.category ?? '').toLowerCase())
    ? String(body.category ?? '').toLowerCase()
    : 'appointment';
  const country = String(body.country ?? 'US').toUpperCase().slice(0, 5);
  const templateText = String(body.templateText ?? '').trim();
  return { key, category, country, templateText };
}

export async function ensureSmsTemplatesTable(connection = pool) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS ${TEMPLATE_TABLE} (
      TemplateId BIGINT NOT NULL AUTO_INCREMENT,
      TemplateKey VARCHAR(50) NOT NULL,
      Category VARCHAR(30) NOT NULL DEFAULT 'appointment',
      Country VARCHAR(5) NOT NULL DEFAULT 'US',
      TemplateText TEXT NOT NULL,
      CreatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UpdatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (TemplateId),
      UNIQUE KEY uq_template_key_category (TemplateKey, Category)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function ensureSmsSettingsTable(connection = pool) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS ${SMS_SETTINGS_TABLE} (
      SettingKey VARCHAR(100) NOT NULL,
      SettingValue TEXT NOT NULL,
      UpdatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (SettingKey)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  for (const [key, value] of Object.entries(DEFAULT_SMS_SETTINGS)) {
    await connection.execute(
      `INSERT IGNORE INTO ${SMS_SETTINGS_TABLE} (SettingKey, SettingValue) VALUES (?, ?)`,
      [key, value]
    );
  }
}

export async function getSmsSettings() {
  await ensureSmsSettingsTable();
  const [rows] = await pool.execute(`SELECT SettingKey, SettingValue FROM ${SMS_SETTINGS_TABLE}`);
  const settings = {};
  for (const row of rows) {
    settings[row.SettingKey] = row.SettingValue;
  }
  return { settings };
}

export async function saveSmsSetting(body) {
  await ensureSmsSettingsTable();
  const key = String(body.settingKey ?? '').trim();
  const value = String(body.settingValue ?? '').trim();
  if (!key) {
    const error = new Error('settingKey is required.');
    error.status = 400;
    throw error;
  }
  if (!SUPPORTED_SMS_SETTINGS.has(key)) {
    const error = new Error('Unsupported SMS setting.');
    error.status = 400;
    throw error;
  }
  await pool.execute(
    `INSERT INTO ${SMS_SETTINGS_TABLE} (SettingKey, SettingValue)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE SettingValue = VALUES(SettingValue)`,
    [key, value]
  );
  return { settingKey: key, settingValue: value };
}

export async function getSmsTemplates(query = {}) {
  await ensureSmsTemplatesTable();
  let sql = `SELECT TemplateKey, Category, Country, TemplateText FROM ${TEMPLATE_TABLE}`;
  const params = [];
  if (query.category) {
    sql += ' WHERE Category = ?';
    params.push(query.category);
  }
  sql += ' ORDER BY Category, TemplateKey';
  const [rows] = await pool.execute(sql, params);
  const templates = { appointment: {}, recall: {}, treatment: {}, review_google: {}, holiday_birthday: {} };
  const countries = { appointment: {}, recall: {}, treatment: {}, review_google: {}, holiday_birthday: {} };
  for (const row of rows) {
    if (!templates[row.Category]) {
      templates[row.Category] = {};
      countries[row.Category] = {};
    }
    templates[row.Category][row.TemplateKey] = row.TemplateText;
    countries[row.Category][row.TemplateKey] = row.Country;
  }
  return { templates, countries };
}

export async function addSmsTemplate(body) {
  await ensureSmsTemplatesTable();
  const { key, category, country, templateText } = parseTemplateBody(body);
  if (!key || !templateText) {
    const error = new Error('templateKey and templateText are required.');
    error.status = 400;
    throw error;
  }
  await pool.execute(
    `INSERT INTO ${TEMPLATE_TABLE} (TemplateKey, Category, Country, TemplateText) VALUES (?, ?, ?, ?)`,
    [key, category, country, templateText]
  );
  return { templateKey: key, category, country };
}

export async function saveSmsTemplate(body) {
  await ensureSmsTemplatesTable();
  const { key, category, country, templateText } = parseTemplateBody(body);
  if (!key || !templateText) {
    const error = new Error('templateKey and templateText are required.');
    error.status = 400;
    throw error;
  }
  const [result] = await pool.execute(
    `INSERT INTO ${TEMPLATE_TABLE} (TemplateKey, Category, Country, TemplateText)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE Country = VALUES(Country), TemplateText = VALUES(TemplateText)`,
    [key, category, country, templateText]
  );
  return { templateKey: key, category, country, updated: result.affectedRows > 0 };
}

export async function deleteSmsTemplate(body) {
  await ensureSmsTemplatesTable();
  const key = String(body.templateKey ?? '').trim().toUpperCase();
  const category = ['appointment', 'recall', 'treatment', 'review_google', 'holiday_birthday'].includes(String(body.category ?? '').toLowerCase())
    ? String(body.category ?? '').toLowerCase()
    : 'appointment';
  if (!key) {
    const error = new Error('templateKey is required.');
    error.status = 400;
    throw error;
  }
  const [result] = await pool.execute(
    `DELETE FROM ${TEMPLATE_TABLE} WHERE TemplateKey = ? AND Category = ?`,
    [key, category]
  );
  return { templateKey: key, category, deleted: result.affectedRows > 0 };
}

export async function initDefaultSmsTemplates() {
  await ensureSmsTemplatesTable();
  let inserted = 0;
  let migrated = 0;
  for (const t of DEFAULT_SMS_TEMPLATE_ROWS) {
    const [rows] = await pool.execute(
      `SELECT TemplateKey, Category, Country, TemplateText FROM ${TEMPLATE_TABLE} WHERE TemplateKey = ? AND Category = ? LIMIT 1`,
      [t.key, t.category]
    );
    const existing = rows[0];
    if (!existing) {
      await pool.execute(
        `INSERT INTO ${TEMPLATE_TABLE} (TemplateKey, Category, Country, TemplateText) VALUES (?, ?, ?, ?)`,
        [t.key, t.category, t.country, t.text]
      );
      inserted += 1;
    } else if (shouldUpdateManagedTemplate(existing, t)) {
      await pool.execute(
        `UPDATE ${TEMPLATE_TABLE} SET Country = ?, TemplateText = ? WHERE TemplateKey = ? AND Category = ?`,
        [t.country, t.text, t.key, t.category]
      );
      migrated += 1;
    }
  }
  return {
    initialized: inserted > 0 || migrated > 0,
    count: inserted + migrated,
    inserted,
    migrated,
    reason: inserted || migrated ? 'templates inserted or migrated' : 'templates already exist',
  };
}
