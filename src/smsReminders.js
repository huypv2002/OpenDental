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

export async function clearSmsDryRunLogs() {
  await ensureSmsReminderLogTable();
  await ensureSmsRecallLogTable();
  const [reminderResult] = await pool.execute(
    `DELETE FROM ${LOG_TABLE} WHERE Status = 'dry-run'`
  );
  const [recallResult] = await pool.execute(
    `DELETE FROM ${RECALL_LOG_TABLE} WHERE Status = 'dry-run'`
  );
  return {
    reminderDryRunDeleted: reminderResult.affectedRows ?? 0,
    recallDryRunDeleted: recallResult.affectedRows ?? 0
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
      ORDER BY ReminderLogNum DESC
      LIMIT ?
    `,
    [limit]
  );
  return { logs: rows };
}

// ===== SMS TEMPLATES TABLE & CRUD =====

const TEMPLATE_TABLE = 'luk_sms_templates';

function parseTemplateBody(body) {
  const key = String(body.templateKey ?? '').trim().toUpperCase();
  const category = ['appointment', 'recall'].includes(String(body.category ?? '').toLowerCase())
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
      Category VARCHAR(20) NOT NULL DEFAULT 'appointment',
      Country VARCHAR(5) NOT NULL DEFAULT 'US',
      TemplateText TEXT NOT NULL,
      CreatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UpdatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (TemplateId),
      UNIQUE KEY uq_template_key_category (TemplateKey, Category)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
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
  const templates = { appointment: {}, recall: {} };
  const countries = { appointment: {}, recall: {} };
  for (const row of rows) {
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
  const category = ['appointment', 'recall'].includes(String(body.category ?? '').toLowerCase())
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
  const [existing] = await pool.execute(`SELECT COUNT(*) AS cnt FROM ${TEMPLATE_TABLE}`);
  if (existing[0].cnt > 0) return { initialized: false, reason: 'templates already exist' };

  const defaults = [
    { key: 'US', category: 'appointment', country: 'US', text: "Good morning {formal_first_name}, I'm Nhan Nguyen from Luk Dental. I would like to remind you of your appointment {relative_day}, {weekday}, {date_full} at {time_lower}. Thank you and have a great day." },
    { key: 'ES', category: 'appointment', country: 'ES', text: "Buenos días {salutation}, soy Nhan Nguyen de Luk Dental. Le recuerdo su cita {relative_day_es}, {weekday}, {date_full} a las {time_lower}. Gracias y que tenga un excelente día." },
    { key: 'VI', category: 'appointment', country: 'VI', text: "Good morning {vi_salutation}, nha khoa Luk Dental xin nhắc lịch hẹn cho {vi_title} vào {relative_day_vi}. {weekday_vi}, {date_short} lúc {time_lower}. Thank you and have a great day." },
    { key: 'US', category: 'recall', country: 'US', text: "Good morning {salutation}, this is Luk Dental. Your 6-month cleaning recall is due. Please call {clinic_phone} or book online at https://lukdental.us/dental-appointment/ to schedule your appointment. Thank you and have a great day." },
    { key: 'ES', category: 'recall', country: 'ES', text: "Buenos días {salutation}, le habla Luk Dental. Ya llegó el momento de su limpieza de 6 meses. Por favor llame al {clinic_phone} o haga su cita en https://lukdental.us/dental-appointment/. Gracias y que tenga un excelente día." },
    { key: 'VI', category: 'recall', country: 'VI', text: "Good morning {vi_salutation}, nha khoa Luk Dental xin nhắc lịch cleaning 6 tháng của {vi_title} đã đến. {vi_title_cap} vui lòng gọi {clinic_phone} hoặc đặt lịch tại https://lukdental.us/dental-appointment/. Thank you and have a great day." },
  ];

  for (const t of defaults) {
    await pool.execute(
      `INSERT INTO ${TEMPLATE_TABLE} (TemplateKey, Category, Country, TemplateText) VALUES (?, ?, ?, ?)`,
      [t.key, t.category, t.country, t.text]
    );
  }
  return { initialized: true, count: defaults.length };
}
