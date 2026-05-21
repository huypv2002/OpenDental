import { config } from './config.js';
import { pool } from './db.js';
import { appointmentPattern, assertSlotStillAvailable } from './bookings.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function requiredString(body, key) {
  const value = String(body[key] ?? '').trim();
  if (!value) {
    const error = new Error(`${key} is required.`);
    error.status = 400;
    throw error;
  }
  return value;
}

function normalizeDate(value, key) {
  if (!DATE_RE.test(value)) {
    const error = new Error(`${key} must use YYYY-MM-DD format.`);
    error.status = 400;
    throw error;
  }
  return value;
}

function normalizeTime(value, key) {
  if (!TIME_RE.test(value)) {
    const error = new Error(`${key} must use HH:mm format.`);
    error.status = 400;
    throw error;
  }
  return value;
}

function normalizeUsPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  const normalized = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (normalized.length !== 10) {
    const error = new Error('phone must use (xxx) xxx-xxxx format.');
    error.status = 400;
    throw error;
  }
  return `(${normalized.slice(0, 3)}) ${normalized.slice(3, 6)}-${normalized.slice(6)}`;
}

function mysqlDateToYmd(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function mysqlDateTimeToParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  return {
    date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  };
}

function patternToMinutes(pattern, fallback) {
  const minutes = String(pattern ?? '').length * 5;
  return minutes > 0 ? minutes : fallback;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}

function parseIdentity(body) {
  return {
    firstName: requiredString(body, 'firstName'),
    lastName: requiredString(body, 'lastName'),
    phone: normalizeUsPhone(requiredString(body, 'phone')),
    birthdate: normalizeDate(requiredString(body, 'birthdate'), 'birthdate'),
    driverLicense: requiredString(body, 'driverLicense')
  };
}

export function parseVerifyAppointmentBody(body) {
  return parseIdentity(body);
}

export function parseChangeAppointmentBody(body) {
  return {
    ...parseIdentity(body),
    aptNum: Number.parseInt(body.aptNum ?? '', 10) || 0,
    date: normalizeDate(requiredString(body, 'date'), 'date'),
    time: normalizeTime(requiredString(body, 'time'), 'time'),
    endsAt: String(body.endsAt ?? '').trim(),
    providerNum: Number.parseInt(body.providerNum ?? config.booking.providerNum, 10),
    operatoryNum: Number.parseInt(body.operatoryNum ?? config.booking.operatoryNum, 10),
    appointmentTypeNum: Number.parseInt(body.appointmentTypeNum ?? config.booking.appointmentTypeNum, 10),
    durationMinutes: Math.max(60, Number.parseInt(body.durationMinutes ?? config.booking.fallbackDurationMinutes, 10) || 60)
  };
}

async function findMatchingAppointment(connection, input) {
  const [rows] = await connection.execute(
    `SELECT
       a.AptNum, a.PatNum, a.AptDateTime, a.Pattern, a.Op, a.ProvNum, a.AppointmentTypeNum, a.Note,
       p.FName, p.LName, p.WirelessPhone, p.Birthdate
     FROM appointment a
     INNER JOIN patient p ON p.PatNum = a.PatNum
     WHERE LOWER(p.FName) = LOWER(?)
       AND LOWER(p.LName) = LOWER(?)
       AND p.WirelessPhone = ?
       AND p.Birthdate = ?
       AND a.AptStatus = 1
       AND a.AptDateTime >= NOW()
       AND a.Note LIKE '%ONLINE PT%'
       AND a.Note LIKE ? ESCAPE '\\\\'
     ORDER BY a.AptDateTime
     LIMIT 5`,
    [
      input.firstName,
      input.lastName,
      input.phone,
      input.birthdate,
      `%${escapeLike(input.driverLicense)}%`
    ]
  );

  if (!rows.length) {
    const error = new Error('No matching active online appointment was found for those details.');
    error.status = 404;
    throw error;
  }

  const row = rows[0];
  const parts = mysqlDateTimeToParts(row.AptDateTime);
  return {
    aptNum: row.AptNum,
    patNum: row.PatNum,
    firstName: row.FName,
    lastName: row.LName,
    phone: row.WirelessPhone,
    birthdate: mysqlDateToYmd(row.Birthdate),
    date: parts.date,
    time: parts.time,
    durationMinutes: patternToMinutes(row.Pattern, config.booking.fallbackDurationMinutes),
    providerNum: row.ProvNum,
    operatoryNum: row.Op,
    appointmentTypeNum: row.AppointmentTypeNum || config.booking.appointmentTypeNum
  };
}

export async function verifyAppointmentForChange(input) {
  const connection = await pool.getConnection();
  try {
    return await findMatchingAppointment(connection, input);
  } finally {
    connection.release();
  }
}

export async function changeAppointment(input) {
  if (!config.writesEnabled) {
    const error = new Error('Open Dental write mode is disabled. Set ENABLE_OPEN_DENTAL_WRITES=true after testing on clone DB.');
    error.status = 501;
    throw error;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const appointment = await findMatchingAppointment(connection, input);

    if (input.aptNum && Number(input.aptNum) !== Number(appointment.aptNum)) {
      const error = new Error('The selected appointment no longer matches the verified patient details.');
      error.status = 409;
      throw error;
    }

    const updateInput = {
      ...input,
      providerNum: appointment.providerNum || input.providerNum,
      operatoryNum: appointment.operatoryNum || input.operatoryNum,
      appointmentTypeNum: appointment.appointmentTypeNum || input.appointmentTypeNum
    };
    await assertSlotStillAvailable(updateInput);

    const pattern = await appointmentPattern(connection, updateInput.appointmentTypeNum, updateInput.durationMinutes);
    const auditNote = `Online appointment changed from ${appointment.date} ${appointment.time} to ${input.date} ${input.time} on ${new Date().toISOString().slice(0, 19).replace('T', ' ')}.`;

    await connection.execute(
      `UPDATE appointment
       SET AptDateTime = ?,
           Pattern = ?,
           Note = CONCAT(COALESCE(Note, ''), '\n', ?)
       WHERE AptNum = ?`,
      [`${input.date} ${input.time}:00`, pattern, auditNote, appointment.aptNum]
    );

    await connection.commit();
    return {
      aptNum: appointment.aptNum,
      patNum: appointment.patNum,
      previousDate: appointment.date,
      previousTime: appointment.time,
      date: input.date,
      time: input.time,
      endsAt: input.endsAt
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
