import { pool } from './db.js';
import { config } from './config.js';

const LOG_TABLE = 'luk_sms_reminder_log';

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
      UNIQUE KEY uq_luk_sms_reminder (AptNum, ReminderForDate)
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
        DATE_FORMAT(p.Birthdate, '%Y-%m-%d') AS Birthdate,
        COALESCE(l.Status, '') AS ReminderStatus,
        DATE_FORMAT(l.SentAt, '%Y-%m-%d %H:%i:%s') AS ReminderSentAt,
        l.ErrorMessage AS ReminderError
      FROM appointment a
      INNER JOIN patient p ON p.PatNum = a.PatNum
      LEFT JOIN ${LOG_TABLE} l
        ON l.AptNum = a.AptNum
       AND l.ReminderForDate = DATE(a.AptDateTime)
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
        Phone: phone,
        DurationMinutes: patternMinutes(row.Pattern, config.booking.fallbackDurationMinutes)
      };
    })
  };
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
