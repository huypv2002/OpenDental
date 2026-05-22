import { config } from './config.js';
import { pool } from './db.js';
import { appointmentPattern, assertSlotStillAvailable } from './bookings.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const CLINIC_TIME_ZONE = 'America/Chicago';

function requiredString(body, key) {
  const value = String(body[key] ?? '').trim();
  if (!value) {
    const error = new Error(`${key} is required.`);
    error.status = 400;
    throw error;
  }
  return value;
}

function plainLatinName(body, key) {
  const value = requiredString(body, key);
  if (!/^[A-Za-z][A-Za-z '\-]*$/.test(value)) {
    const error = new Error(`${key} must use letters without accents.`);
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

function phoneDigits(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
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

function clinicNowParts() {
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: CLINIC_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date()).forEach((part) => {
    parts[part.type] = part.value;
  });

  let hour = Number.parseInt(parts.hour ?? '0', 10);
  if (hour === 24) hour = 0;
  return {
    dateTime: `${parts.year}-${parts.month}-${parts.day} ${String(hour).padStart(2, '0')}:${parts.minute}:${parts.second}`,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${String(hour).padStart(2, '0')}:${parts.minute}`
  };
}

function appointmentIsBeforeClinicNow(value, clinicNow) {
  const parts = mysqlDateTimeToParts(value);
  return `${parts.date} ${parts.time}:00` < clinicNow.dateTime;
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
    firstName: plainLatinName(body, 'firstName'),
    lastName: plainLatinName(body, 'lastName'),
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

export function parseCancelAppointmentBody(body) {
  return {
    ...parseIdentity(body),
    aptNum: Number.parseInt(body.aptNum ?? '', 10) || 0
  };
}

function addMinutesToTime(time, minutesToAdd) {
  const [hours, minutes] = String(time).split(':').map(Number);
  const total = (hours * 60) + minutes + minutesToAdd;
  const nextHours = Math.floor(total / 60) % 24;
  const nextMinutes = total % 60;
  return `${String(nextHours).padStart(2, '0')}:${String(nextMinutes).padStart(2, '0')}`;
}

async function findMatchingAppointment(connection, input) {
  const clinicNow = clinicNowParts();
  const [rows] = await connection.execute(
    `SELECT
       a.AptNum, a.PatNum, a.AptDateTime, a.Pattern, a.Op, a.ProvNum, a.AppointmentTypeNum, a.Note,
       p.FName, p.LName, p.WirelessPhone, p.Birthdate, p.Email
     FROM appointment a
     INNER JOIN patient p ON p.PatNum = a.PatNum
     LEFT JOIN apptfield af
       ON af.AptNum = a.AptNum
      AND af.FieldName = 'Driver License ID'
     LEFT JOIN patfield pf
       ON pf.PatNum = p.PatNum
      AND pf.FieldName = 'Driver License ID'
     WHERE LOWER(p.FName) = LOWER(?)
       AND LOWER(p.LName) = LOWER(?)
       AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(p.WirelessPhone, '(', ''), ')', ''), '-', ''), ' ', ''), '.', '') = ?
       AND p.Birthdate = ?
       AND a.AptStatus = 1
       AND a.AptDateTime >= ?
       AND a.Note LIKE '%ONLINE PT%'
       AND (
         a.Note LIKE ? ESCAPE '\\\\'
         OR af.FieldValue = ?
         OR pf.FieldValue = ?
       )
     ORDER BY a.AptDateTime
     LIMIT 5`,
    [
      input.firstName,
      input.lastName,
      phoneDigits(input.phone),
      input.birthdate,
      clinicNow.dateTime,
      `%${escapeLike(input.driverLicense)}%`,
      input.driverLicense,
      input.driverLicense
    ]
  );

  if (!rows.length) {
    const [diagnosticRows] = await connection.execute(
      `SELECT
         a.AptNum, a.AptStatus, a.AptDateTime
       FROM appointment a
       INNER JOIN patient p ON p.PatNum = a.PatNum
       LEFT JOIN apptfield af
         ON af.AptNum = a.AptNum
        AND af.FieldName = 'Driver License ID'
       LEFT JOIN patfield pf
         ON pf.PatNum = p.PatNum
        AND pf.FieldName = 'Driver License ID'
       WHERE LOWER(p.FName) = LOWER(?)
         AND LOWER(p.LName) = LOWER(?)
         AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(p.WirelessPhone, '(', ''), ')', ''), '-', ''), ' ', ''), '.', '') = ?
         AND p.Birthdate = ?
         AND a.Note LIKE '%ONLINE PT%'
         AND (
           a.Note LIKE ? ESCAPE '\\\\'
           OR af.FieldValue = ?
           OR pf.FieldValue = ?
         )
       ORDER BY a.AptDateTime DESC
       LIMIT 1`,
      [
        input.firstName,
        input.lastName,
        phoneDigits(input.phone),
        input.birthdate,
        `%${escapeLike(input.driverLicense)}%`,
        input.driverLicense,
        input.driverLicense
      ]
    );

    if (diagnosticRows.length) {
      const diagnostic = diagnosticRows[0];
      if (Number(diagnostic.AptStatus) !== 1) {
        const error = new Error('A matching online appointment was found, but it is no longer active and cannot be changed online.');
        error.status = 409;
        throw error;
      }
      if (appointmentIsBeforeClinicNow(diagnostic.AptDateTime, clinicNow)) {
        const error = new Error('A matching online appointment was found, but it is in the past and cannot be changed online.');
        error.status = 409;
        throw error;
      }
    }

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
    email: row.Email || '',
    birthdate: mysqlDateToYmd(row.Birthdate),
    date: parts.date,
    time: parts.time,
    durationMinutes: patternToMinutes(row.Pattern, config.booking.fallbackDurationMinutes),
    providerNum: row.ProvNum,
    operatoryNum: row.Op,
    appointmentTypeNum: row.AppointmentTypeNum || config.booking.appointmentTypeNum
  };
}

async function findMatchingAppointmentsForCancel(connection, input) {
  const clinicNow = clinicNowParts();
  const [rows] = await connection.execute(
    `SELECT
       a.AptNum, a.PatNum, a.AptDateTime, a.Pattern, a.Op, a.ProvNum, a.AppointmentTypeNum, a.Note,
       p.FName, p.LName, p.WirelessPhone, p.Birthdate, p.Email
     FROM appointment a
     INNER JOIN patient p ON p.PatNum = a.PatNum
     LEFT JOIN apptfield af
       ON af.AptNum = a.AptNum
      AND af.FieldName = 'Driver License ID'
     LEFT JOIN patfield pf
       ON pf.PatNum = p.PatNum
      AND pf.FieldName = 'Driver License ID'
     WHERE LOWER(p.FName) = LOWER(?)
       AND LOWER(p.LName) = LOWER(?)
       AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(p.WirelessPhone, '(', ''), ')', ''), '-', ''), ' ', ''), '.', '') = ?
       AND p.Birthdate = ?
       AND a.AptStatus = 1
       AND a.AptDateTime >= ?
       AND a.Note LIKE '%ONLINE PT%'
       AND (
         a.Note LIKE ? ESCAPE '\\\\'
         OR af.FieldValue = ?
         OR pf.FieldValue = ?
       )
     ORDER BY a.AptDateTime
     LIMIT 25`,
    [
      input.firstName,
      input.lastName,
      phoneDigits(input.phone),
      input.birthdate,
      clinicNow.dateTime,
      `%${escapeLike(input.driverLicense)}%`,
      input.driverLicense,
      input.driverLicense
    ]
  );

  return rows.map((row) => {
    const parts = mysqlDateTimeToParts(row.AptDateTime);
    const durationMinutes = patternToMinutes(row.Pattern, config.booking.fallbackDurationMinutes);
    return {
      aptNum: row.AptNum,
      patNum: row.PatNum,
      firstName: row.FName,
      lastName: row.LName,
      phone: row.WirelessPhone,
      email: row.Email || '',
      birthdate: mysqlDateToYmd(row.Birthdate),
      date: parts.date,
      time: parts.time,
      endsAt: addMinutesToTime(parts.time, durationMinutes),
      durationMinutes,
      providerNum: row.ProvNum,
      operatoryNum: row.Op,
      appointmentTypeNum: row.AppointmentTypeNum || config.booking.appointmentTypeNum
    };
  });
}

export async function verifyAppointmentForChange(input) {
  const connection = await pool.getConnection();
  try {
    return await findMatchingAppointment(connection, input);
  } finally {
    connection.release();
  }
}

export async function verifyAppointmentsForCancel(input) {
  const connection = await pool.getConnection();
  try {
    const appointments = await findMatchingAppointmentsForCancel(connection, input);
    if (!appointments.length) {
      const error = new Error('No matching active online appointments were found for those details.');
      error.status = 404;
      throw error;
    }
    return { appointments };
  } finally {
    connection.release();
  }
}

export async function cancelAppointment(input) {
  if (!config.writesEnabled) {
    const error = new Error('Open Dental write mode is disabled. Set ENABLE_OPEN_DENTAL_WRITES=true after testing on clone DB.');
    error.status = 501;
    throw error;
  }
  if (!input.aptNum) {
    const error = new Error('aptNum is required.');
    error.status = 400;
    throw error;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const appointments = await findMatchingAppointmentsForCancel(connection, input);
    const appointment = appointments.find((item) => Number(item.aptNum) === Number(input.aptNum));
    if (!appointment) {
      const error = new Error('The selected appointment no longer matches the verified patient details.');
      error.status = 409;
      throw error;
    }

    const auditNote = `Online appointment canceled from website on ${clinicNowParts().dateTime} Houston time.`;
    await connection.execute(
      `UPDATE appointment
       SET AptStatus = 5,
           Note = CONCAT(COALESCE(Note, ''), '\n', ?)
       WHERE AptNum = ?`,
      [auditNote, appointment.aptNum]
    );

    await connection.commit();
    return appointment;
  } catch (error) {
    await connection.rollback();
    throw error;
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
    const auditNote = `Online appointment changed from ${appointment.date} ${appointment.time} to ${input.date} ${input.time} on ${clinicNowParts().dateTime} Houston time.`;

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
      firstName: appointment.firstName,
      lastName: appointment.lastName,
      phone: appointment.phone,
      email: appointment.email || '',
      birthdate: appointment.birthdate,
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
