import { pool } from './db.js';
import { config } from './config.js';

const SECURITY_LOG_TABLE = 'securitylog';

function bad(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function intValue(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function text(value) {
  return String(value ?? '').trim();
}

function requireWrites() {
  if (!config.writesEnabled) {
    throw bad('Open Dental write mode is disabled. Set ENABLE_OPEN_DENTAL_WRITES=true after testing on clone DB.', 501);
  }
}

function escapeLike(value) {
  return text(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

function parseLimit(value, fallback = 100) {
  const parsed = intValue(value, fallback);
  return Math.max(1, Math.min(parsed, 500));
}

function mysqlDateTime(value, fallbackNow = false) {
  const raw = text(value);
  if (!raw) {
    if (!fallbackNow) return null;
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
  }
  const normalized = raw.replace('T', ' ').slice(0, 19);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(normalized)) {
    throw bad('LogDateTime must use YYYY-MM-DD HH:mm:ss format.');
  }
  return normalized.length === 16 ? `${normalized}:00` : normalized;
}

async function tableColumnNames(tableName) {
  const [rows] = await pool.execute(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
    `,
    [tableName]
  );
  return new Set(rows.map((row) => row.COLUMN_NAME));
}

function securitySelectColumns(columns) {
  return [
    'SecurityLogNum',
    columns.has('LogDateTime') ? "DATE_FORMAT(LogDateTime, '%Y-%m-%d %H:%i:%s') AS LogDateTime" : "'' AS LogDateTime",
    columns.has('PermType') ? 'PermType' : '0 AS PermType',
    columns.has('UserNum') ? 'UserNum' : '0 AS UserNum',
    columns.has('PatNum') ? 'PatNum' : '0 AS PatNum',
    columns.has('FKey') ? 'FKey' : '0 AS FKey',
    columns.has('LogText') ? 'LogText' : "'' AS LogText",
    columns.has('CompName') ? 'CompName' : "'' AS CompName",
    columns.has('DateTPrevious') ? "DATE_FORMAT(DateTPrevious, '%Y-%m-%d %H:%i:%s') AS DateTPrevious" : "'' AS DateTPrevious"
  ];
}

export async function listAuditPatients(query = {}) {
  const q = text(query.q);
  const limit = parseLimit(query.limit, 100);
  const values = [];
  let where = '';
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where = `
      WHERE p.FName LIKE ? ESCAPE '\\\\'
         OR p.LName LIKE ? ESCAPE '\\\\'
         OR p.WirelessPhone LIKE ? ESCAPE '\\\\'
         OR p.HmPhone LIKE ? ESCAPE '\\\\'
         OR p.WkPhone LIKE ? ESCAPE '\\\\'
         OR p.Email LIKE ? ESCAPE '\\\\'
         OR CAST(p.PatNum AS CHAR) LIKE ? ESCAPE '\\\\'
    `;
    values.push(like, like, like, like, like, like, like);
  }
  values.push(limit);
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
        DATE_FORMAT(p.Birthdate, '%Y-%m-%d') AS Birthdate,
        p.PatStatus
      FROM patient p
      ${where}
      ORDER BY p.PatNum DESC
      LIMIT ?
    `,
    values
  );
  return {
    patients: rows.map((row) => ({
      ...row,
      PatientName: `${row.FName || ''} ${row.LName || ''}`.trim(),
      Phone: row.WirelessPhone || row.HmPhone || row.WkPhone || ''
    }))
  };
}

export async function listAuditTrailEntries(query = {}) {
  const patNum = intValue(query.patNum);
  if (!patNum) throw bad('patNum is required.');

  const limit = parseLimit(query.limit, 300);
  const columns = await tableColumnNames(SECURITY_LOG_TABLE);
  if (!columns.has('SecurityLogNum')) {
    throw bad('Open Dental securitylog table was not found or is missing SecurityLogNum.', 500);
  }
  if (!columns.has('PatNum')) {
    throw bad('Open Dental securitylog table is missing PatNum.', 500);
  }
  const orderBy = columns.has('LogDateTime')
    ? 'LogDateTime DESC, SecurityLogNum DESC'
    : 'SecurityLogNum DESC';

  const [rows] = await pool.execute(
    `
      SELECT ${securitySelectColumns(columns).join(', ')}
      FROM ${SECURITY_LOG_TABLE}
      WHERE PatNum = ?
      ORDER BY ${orderBy}
      LIMIT ?
    `,
    [patNum, limit]
  );
  return { entries: rows };
}

function parseAuditEntry(row = {}) {
  return {
    securityLogNum: intValue(row.securityLogNum ?? row.SecurityLogNum),
    logDateTime: mysqlDateTime(row.logDateTime ?? row.LogDateTime, true),
    permType: intValue(row.permType ?? row.PermType),
    userNum: intValue(row.userNum ?? row.UserNum),
    fKey: intValue(row.fKey ?? row.FKey),
    logText: text(row.logText ?? row.LogText),
    compName: text(row.compName ?? row.CompName),
    dateTPrevious: mysqlDateTime(row.dateTPrevious ?? row.DateTPrevious, false)
  };
}

export async function saveAuditTrailEntries(body = {}) {
  requireWrites();
  const patNum = intValue(body.patNum ?? body.PatNum);
  if (!patNum) throw bad('patNum is required.');

  const entries = Array.isArray(body.entries) ? body.entries : [];
  const deleteIds = Array.isArray(body.deleteIds) ? body.deleteIds.map((item) => intValue(item)).filter(Boolean) : [];
  const columns = await tableColumnNames(SECURITY_LOG_TABLE);
  if (!columns.has('SecurityLogNum') || !columns.has('PatNum')) {
    throw bad('Open Dental securitylog table is not compatible with this tool.', 500);
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    for (const securityLogNum of deleteIds) {
      await connection.execute(`DELETE FROM ${SECURITY_LOG_TABLE} WHERE SecurityLogNum = ? AND PatNum = ?`, [securityLogNum, patNum]);
    }

    let created = 0;
    let updated = 0;
    for (const raw of entries) {
      const entry = parseAuditEntry(raw);
      if (!entry.logText) continue;

      const writable = {
        LogDateTime: entry.logDateTime,
        PermType: entry.permType,
        UserNum: entry.userNum,
        PatNum: patNum,
        FKey: entry.fKey,
        LogText: entry.logText,
        CompName: entry.compName,
        DateTPrevious: entry.dateTPrevious
      };
      const fieldNames = Object.keys(writable).filter((key) => columns.has(key) && writable[key] !== null);
      const values = fieldNames.map((key) => writable[key]);

      if (entry.securityLogNum) {
        const assignments = fieldNames.filter((key) => key !== 'PatNum').map((key) => `${key} = ?`);
        const assignmentValues = fieldNames.filter((key) => key !== 'PatNum').map((key) => writable[key]);
        const [result] = await connection.execute(
          `UPDATE ${SECURITY_LOG_TABLE} SET ${assignments.join(', ')} WHERE SecurityLogNum = ? AND PatNum = ?`,
          [...assignmentValues, entry.securityLogNum, patNum]
        );
        if (!result.affectedRows) throw bad(`Audit entry ${entry.securityLogNum} was not found.`, 404);
        updated += 1;
        continue;
      }

      const placeholders = fieldNames.map(() => '?').join(', ');
      await connection.execute(
        `INSERT INTO ${SECURITY_LOG_TABLE} (${fieldNames.join(', ')}) VALUES (${placeholders})`,
        values
      );
      created += 1;
    }

    await connection.commit();
    return { patNum, created, updated, deleted: deleteIds.length };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
