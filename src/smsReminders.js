import { pool } from './db.js';
import { config } from './config.js';

const LOG_TABLE = 'luk_sms_reminder_log';
const RECALL_LOG_TABLE = 'luk_sms_recall_log';

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
      Message TEXT NOT NULL,
      Status VARCHAR(30) NOT NULL,
      SentAt DATETIME NULL,
      ErrorMessage TEXT NULL,
      CreatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (ReminderLogNum),
      UNIQUE KEY uq_luk_sms_reminder (AptNum, ReminderForDate, Phone)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
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
  if (indexes?.[0]?.Columns !== 'AptNum,ReminderForDate,Phone') {
    try {
      await connection.execute(`ALTER TABLE ${LOG_TABLE} DROP INDEX uq_luk_sms_reminder`);
    } catch (_error) {
      // Fresh installs already have the desired phone-aware unique key.
    }
    await connection.execute(`ALTER TABLE ${LOG_TABLE} ADD UNIQUE KEY uq_luk_sms_reminder (AptNum, ReminderForDate, Phone)`);
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

export async function logSmsReminderResult(body) {
  await ensureSmsReminderLogTable();
  const aptNum = Number.parseInt(String(body.aptNum ?? ''), 10);
  const patNum = Number.parseInt(String(body.patNum ?? ''), 10);
  const reminderForDate = parseDate(body.reminderForDate);
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
        (AptNum, PatNum, Phone, ReminderForDate, Message, Status, SentAt, ErrorMessage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        Phone = VALUES(Phone),
        Message = VALUES(Message),
        Status = VALUES(Status),
        SentAt = VALUES(SentAt),
        ErrorMessage = VALUES(ErrorMessage)
    `,
    [aptNum, patNum, phone, reminderForDate, message, status, sentAt, errorMessage]
  );

  return { aptNum, patNum, reminderForDate, status };
}

export async function getSmsReminderLogs(query = {}) {
  const limit = parseLimit(query.limit);
  await ensureSmsReminderLogTable();
  const [rows] = await pool.execute(
    `
      SELECT
        ReminderLogNum,
        AptNum,
        PatNum,
        Phone,
        DATE_FORMAT(ReminderForDate, '%Y-%m-%d') AS ReminderForDate,
        Status,
        DATE_FORMAT(SentAt, '%Y-%m-%d %H:%i:%s') AS SentAt,
        ErrorMessage,
        DATE_FORMAT(CreatedAt, '%Y-%m-%d %H:%i:%s') AS CreatedAt
      FROM ${LOG_TABLE}
      ORDER BY ReminderLogNum DESC
      LIMIT ?
    `,
    [limit]
  );
  return { logs: rows };
}
