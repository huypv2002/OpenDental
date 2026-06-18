import { config } from './config.js';
import { pool } from './db.js';
import { appointmentPattern, assertSlotStillAvailable } from './bookings.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

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

function dateValue(value, field = 'date') {
  const raw = text(value);
  if (!DATE_RE.test(raw)) throw bad(`${field} must use YYYY-MM-DD format.`);
  return raw;
}

function timeValue(value, field = 'time') {
  const raw = text(value);
  if (!TIME_RE.test(raw)) throw bad(`${field} must use HH:mm format.`);
  return raw;
}

function normalizePhone(value) {
  const raw = text(value);
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  const normalized = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return normalized.length === 10 ? `(${normalized.slice(0, 3)}) ${normalized.slice(3, 6)}-${normalized.slice(6)}` : raw;
}

function mysqlDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? '').slice(0, 10);
}

function mysqlDateTime(value) {
  if (!value) return '';
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    const h = String(value.getHours()).padStart(2, '0');
    const min = String(value.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}:00`;
  }
  return String(value).slice(0, 19).replace('T', ' ');
}

function requireWrites() {
  if (!config.writesEnabled) {
    throw bad('Open Dental write mode is disabled. Set ENABLE_OPEN_DENTAL_WRITES=true after testing on clone DB.', 501);
  }
}

function parsePatient(body = {}) {
  return {
    patNum: intValue(body.patNum),
    firstName: text(body.firstName),
    lastName: text(body.lastName),
    phone: normalizePhone(body.phone),
    email: text(body.email),
    birthdate: body.birthdate ? dateValue(body.birthdate, 'birthdate') : '0001-01-01',
    address: text(body.address),
    city: text(body.city),
    state: text(body.state),
    zip: text(body.zip),
    language: text(body.language)
  };
}

function parseAppointment(body = {}) {
  return {
    aptNum: intValue(body.aptNum),
    patNum: intValue(body.patNum),
    date: dateValue(body.date),
    time: timeValue(body.time),
    note: text(body.note),
    procDescript: text(body.procDescript || body.procedure),
    status: intValue(body.status, 1),
    providerNum: intValue(body.providerNum, config.booking.providerNum),
    operatoryNum: intValue(body.operatoryNum, config.booking.operatoryNum),
    appointmentTypeNum: intValue(body.appointmentTypeNum, config.booking.appointmentTypeNum),
    durationMinutes: Math.max(5, intValue(body.durationMinutes, config.booking.fallbackDurationMinutes))
  };
}

export async function listAdminAppointments(query = {}) {
  const date = query.date ? dateValue(query.date) : '';
  const patNum = intValue(query.patNum);
  const q = text(query.q || query.query);
  const limit = Math.max(1, Math.min(intValue(query.limit, 100), 300));
  const statuses = text(query.statuses || config.booking.busyAptStatuses.join(','))
    .split(',')
    .map((item) => intValue(item, NaN))
    .filter(Number.isInteger);
  const where = [];
  const values = [];
  if (date) {
    where.push('a.AptDateTime >= ? AND a.AptDateTime < DATE_ADD(?, INTERVAL 1 DAY)');
    values.push(`${date} 00:00:00`, `${date} 00:00:00`);
  }
  if (patNum) {
    where.push('a.PatNum = ?');
    values.push(patNum);
  }
  if (statuses.length) {
    where.push(`a.AptStatus IN (${statuses.map(() => '?').join(',')})`);
    values.push(...statuses);
  }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push(`(
      p.FName LIKE ? ESCAPE '\\\\'
      OR p.LName LIKE ? ESCAPE '\\\\'
      OR p.WirelessPhone LIKE ? ESCAPE '\\\\'
      OR p.Email LIKE ? ESCAPE '\\\\'
      OR a.ProcDescript LIKE ? ESCAPE '\\\\'
      OR CAST(a.AptNum AS CHAR) LIKE ? ESCAPE '\\\\'
      OR CAST(a.PatNum AS CHAR) LIKE ? ESCAPE '\\\\'
    )`);
    values.push(like, like, like, like, like, like, like);
  }
  values.push(limit);
  const [rows] = await pool.execute(
    `
      SELECT
        a.AptNum, a.PatNum, DATE_FORMAT(a.AptDateTime, '%Y-%m-%d %H:%i:%s') AS AptDateTime,
        a.Pattern, a.AptStatus, a.ProcDescript, a.Note, a.Op, a.ProvNum, a.AppointmentTypeNum,
        p.FName, p.LName, p.WirelessPhone, p.HmPhone, p.WkPhone, p.Email,
        DATE_FORMAT(p.Birthdate, '%Y-%m-%d') AS Birthdate, p.Language
      FROM appointment a
      INNER JOIN patient p ON p.PatNum = a.PatNum
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${patNum ? 'a.AptDateTime DESC' : 'a.AptDateTime, p.LName, p.FName'}
      LIMIT ?
    `,
    values
  );
  return { date, appointments: rows.map((row) => ({ ...row, Phone: normalizePhone(row.WirelessPhone || row.HmPhone || row.WkPhone || '') })) };
}

export async function listAdminPatients(query = {}) {
  const q = text(query.q || query.query);
  const limit = Math.max(1, Math.min(intValue(query.limit, 100), 300));
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const values = q ? [like, like, like, like, like, limit] : [limit];
  const where = q
    ? `WHERE p.FName LIKE ? ESCAPE '\\\\' OR p.LName LIKE ? ESCAPE '\\\\' OR p.WirelessPhone LIKE ? ESCAPE '\\\\' OR p.Email LIKE ? ESCAPE '\\\\' OR pa.Username LIKE ? ESCAPE '\\\\'`
    : '';
  const [rows] = await pool.execute(
    `
      SELECT
        p.PatNum, p.FName, p.LName, p.WirelessPhone, p.HmPhone, p.WkPhone, p.Email, p.Gender,
        DATE_FORMAT(p.Birthdate, '%Y-%m-%d') AS Birthdate, p.Address, p.City, p.State, p.Zip, p.Language, p.PatStatus,
        MAX(pa.Username) AS PortalUsername,
        DATE_FORMAT(MAX(a.AptDateTime), '%Y-%m-%d %H:%i:%s') AS LastAppointment
      FROM patient p
      LEFT JOIN luk_patient_accounts pa ON pa.PatNum = p.PatNum
      LEFT JOIN appointment a ON a.PatNum = p.PatNum
      ${where}
      GROUP BY p.PatNum
      ORDER BY p.PatNum DESC
      LIMIT ?
    `,
    values
  );
  return { patients: rows.map((row) => ({ ...row, Phone: normalizePhone(row.WirelessPhone || row.HmPhone || row.WkPhone || '') })) };
}

export async function saveAdminPatient(body = {}) {
  requireWrites();
  const input = parsePatient(body);
  if (!input.firstName && !input.lastName) throw bad('Patient firstName or lastName is required.');

  if (input.patNum) {
    const [result] = await pool.execute(
      `UPDATE patient
       SET FName = ?, LName = ?, WirelessPhone = ?, Email = ?, Birthdate = ?, Address = ?, City = ?, State = ?, Zip = ?, Language = ?
       WHERE PatNum = ?`,
      [input.firstName, input.lastName, input.phone, input.email, input.birthdate, input.address, input.city, input.state, input.zip, input.language, input.patNum]
    );
    if (!result.affectedRows) throw bad('Patient was not found.', 404);
    return { patNum: input.patNum, updated: true };
  }

  const [result] = await pool.execute(
    `INSERT INTO patient
      (LName, FName, WirelessPhone, Email, Birthdate, Address, City, State, Zip, PatStatus, Gender, Position, PriProv, SecProv, BillingType, FeeSched, Language)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 0, 0, 0, ?)`,
    [input.lastName, input.firstName, input.phone, input.email, input.birthdate, input.address, input.city, input.state, input.zip, config.booking.providerNum, input.language]
  );
  await pool.execute('UPDATE patient SET Guarantor = ? WHERE PatNum = ?', [result.insertId, result.insertId]);
  return { patNum: result.insertId, created: true };
}

export async function saveAdminAppointment(body = {}) {
  requireWrites();
  const input = parseAppointment(body);
  if (!input.patNum) throw bad('patNum is required.');
  const dateTime = `${input.date} ${input.time}:00`;
  const pattern = await appointmentPattern(pool, input.appointmentTypeNum, input.durationMinutes);

  if (input.aptNum) {
    await assertSlotStillAvailable({ ...input, excludeAptNum: input.aptNum });
    const [result] = await pool.execute(
      `UPDATE appointment
       SET AptDateTime = ?, Pattern = ?, AptStatus = ?, Op = ?, ProvNum = ?, AppointmentTypeNum = ?, ProcDescript = ?, Note = ?
       WHERE AptNum = ?`,
      [dateTime, pattern, input.status, input.operatoryNum, input.providerNum, input.appointmentTypeNum, input.procDescript, input.note, input.aptNum]
    );
    if (!result.affectedRows) throw bad('Appointment was not found.', 404);
    return { aptNum: input.aptNum, updated: true };
  }

  await assertSlotStillAvailable(input);
  const [result] = await pool.execute(
    `INSERT INTO appointment
      (PatNum, AptStatus, Pattern, Confirmed, TimeLocked, Op, ProvNum, ProvHyg, AptDateTime, IsNewPatient, ProcDescript, Note, ClinicNum, AppointmentTypeNum, SecUserNumEntry, SecDateTEntry)
     VALUES (?, ?, ?, 0, 0, ?, ?, 0, ?, 0, ?, ?, 0, ?, 0, NOW())`,
    [input.patNum, input.status, pattern, input.operatoryNum, input.providerNum, dateTime, input.procDescript, input.note, input.appointmentTypeNum]
  );
  return { aptNum: result.insertId, created: true };
}

export async function deleteAdminAppointment(body = {}) {
  requireWrites();
  const aptNum = intValue(body.aptNum);
  if (!aptNum) throw bad('aptNum is required.');
  await pool.execute('DELETE FROM apptfield WHERE AptNum = ?', [aptNum]);
  const [result] = await pool.execute('DELETE FROM appointment WHERE AptNum = ?', [aptNum]);
  if (!result.affectedRows) throw bad('Appointment was not found.', 404);
  return { aptNum, deleted: true };
}
