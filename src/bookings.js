import { config } from './config.js';
import { pool } from './db.js';
import { getAvailableSlots } from './slots.js';

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

function optionalString(body, key) {
  return String(body[key] ?? '').trim();
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

function dateTime(date, time) {
  return `${date} ${time}:00`;
}

function dateKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function parseDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
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
  const time = `${String(hour).padStart(2, '0')}:${parts.minute}:${parts.second}`;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    dateTime: `${parts.year}-${parts.month}-${parts.day} ${time}`
  };
}

function formatUsDate(date) {
  if (!DATE_RE.test(date)) return date;
  const [year, month, day] = date.split('-');
  return `${month}/${day}/${year}`;
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

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}

export async function appointmentPattern(connection, appointmentTypeNum, fallbackDurationMinutes) {
  if (fallbackDurationMinutes > 0) {
    const blocks = Math.max(1, Math.ceil(fallbackDurationMinutes / 5));
    return 'X'.repeat(blocks);
  }

  const [rows] = await connection.execute(
    'SELECT Pattern FROM appointmenttype WHERE AppointmentTypeNum = ? LIMIT 1',
    [appointmentTypeNum]
  );
  const pattern = String(rows[0]?.Pattern ?? '');
  if (pattern) return pattern;

  const blocks = Math.max(1, Math.ceil(fallbackDurationMinutes / 5));
  return 'X'.repeat(blocks);
}

function bookingHoursForDate(date) {
  const weekday = new Date(`${date}T12:00:00`).getDay();
  if (weekday === 1) {
    return { openTime: '14:00', closeTime: '18:00' };
  }
  if ([0, 2, 4, 5].includes(weekday)) {
    return { openTime: '09:00', closeTime: '18:00' };
  }
  return null;
}

export async function assertSlotStillAvailable(input) {
  const hours = bookingHoursForDate(input.date);
  if (!hours) {
    const error = new Error('Selected appointment date is outside online booking hours.');
    error.status = 409;
    throw error;
  }

  const availability = await getAvailableSlots({
    date: input.date,
    providerNum: input.providerNum,
    operatoryNum: input.operatoryNum,
    appointmentTypeNum: input.appointmentTypeNum,
    openTime: hours.openTime,
    closeTime: hours.closeTime,
    slotIntervalMinutes: config.booking.slotIntervalMinutes,
    fallbackDurationMinutes: input.durationMinutes,
    durationOverrideMinutes: input.durationMinutes,
    excludeAptNum: input.excludeAptNum || 0,
    busyAptStatuses: config.booking.busyAptStatuses
  });
  const available = availability.slots.some((slot) => slot.time === input.time);
  if (!available) {
    const error = new Error('Selected appointment time is no longer available.');
    error.status = 409;
    throw error;
  }
}

async function assertNoSameDayPatientBooking(connection, input) {
  const nextDate = dateKey(addDays(parseDate(input.date), 1));
  const values = [
    `${input.date} 00:00:00`,
    `${nextDate} 00:00:00`,
    input.firstName,
    input.lastName,
    phoneDigits(input.phone),
    input.birthdate
  ];
  let licenseClause = '';

  if (input.driverLicense) {
    licenseClause = `
       AND (
         a.Note LIKE ? ESCAPE '\\\\'
         OR af.FieldValue = ?
         OR pf.FieldValue = ?
       )`;
    values.push(`%${escapeLike(input.driverLicense)}%`, input.driverLicense, input.driverLicense);
  }

  const [rows] = await connection.execute(
    `SELECT a.AptNum, a.AptDateTime
     FROM appointment a
     INNER JOIN patient p ON p.PatNum = a.PatNum
     LEFT JOIN apptfield af
       ON af.AptNum = a.AptNum
      AND af.FieldName = 'Driver License ID'
     LEFT JOIN patfield pf
       ON pf.PatNum = p.PatNum
      AND pf.FieldName = 'Driver License ID'
     WHERE a.AptStatus = 1
       AND a.AptDateTime >= ?
       AND a.AptDateTime < ?
       AND LOWER(p.FName) = LOWER(?)
       AND LOWER(p.LName) = LOWER(?)
       AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(p.WirelessPhone, '(', ''), ')', ''), '-', ''), ' ', ''), '.', '') = ?
       AND p.Birthdate = ?
       AND a.Note LIKE '%ONLINE PT%'
       ${licenseClause}
     ORDER BY a.AptDateTime
     LIMIT 1`,
    values
  );

  if (rows.length) {
    const error = new Error('This patient already has an active online appointment on this date.');
    error.status = 409;
    throw error;
  }
}

async function findExistingOnlinePatient(connection, input) {
  const [rows] = await connection.execute(
    `SELECT
       p.PatNum, p.FName, p.LName, p.WirelessPhone, p.Email, p.Birthdate, p.Address, p.City, p.State
     FROM patient p
     LEFT JOIN patfield pf
       ON pf.PatNum = p.PatNum
      AND pf.FieldName = 'Driver License ID'
     WHERE LOWER(p.FName) = LOWER(?)
       AND LOWER(p.LName) = LOWER(?)
       AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(p.WirelessPhone, '(', ''), ')', ''), '-', ''), ' ', ''), '.', '') = ?
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
             AND a.Note LIKE '%ONLINE PT%'
             AND (
               a.Note LIKE ? ESCAPE '\\\\'
               OR af.FieldValue = ?
             )
           LIMIT 1
         )
       )
     ORDER BY p.PatNum
     LIMIT 1`,
    [
      input.firstName,
      input.lastName,
      phoneDigits(input.phone),
      input.birthdate,
      input.driverLicense,
      `%${escapeLike(input.driverLicense)}%`,
      input.driverLicense
    ]
  );

  return rows[0] || null;
}

async function ensureDriverLicensePatField(connection, patNum, input, clinicDate) {
  if (!input.driverLicense) return;
  const [rows] = await connection.execute(
    `SELECT PatFieldNum
     FROM patfield
     WHERE PatNum = ?
       AND FieldName = 'Driver License ID'
     LIMIT 1`,
    [patNum]
  );
  if (rows.length) return;

  await connection.execute(
    `INSERT INTO patfield
      (PatNum, FieldName, FieldValue, SecUserNumEntry, SecDateEntry)
     VALUES (?, 'Driver License ID', ?, 0, ?)`,
    [patNum, input.driverLicense, clinicDate]
  );
}

export function parseBookingBody(body) {
  const date = normalizeDate(requiredString(body, 'date'), 'date');
  const time = normalizeTime(requiredString(body, 'time'), 'time');

  return {
    date,
    time,
    endsAt: optionalString(body, 'endsAt'),
    firstName: plainLatinName(body, 'firstName'),
    lastName: plainLatinName(body, 'lastName'),
    phone: normalizeUsPhone(requiredString(body, 'phone')),
    email: optionalString(body, 'email'),
    birthdate: normalizeDate(requiredString(body, 'birthdate'), 'birthdate'),
    address: optionalString(body, 'address'),
    city: optionalString(body, 'city'),
    state: optionalString(body, 'state'),
    driverLicense: requiredString(body, 'driverLicense'),
    note: optionalString(body, 'note'),
    providerNum: Number.parseInt(body.providerNum ?? config.booking.providerNum, 10),
    operatoryNum: Number.parseInt(body.operatoryNum ?? config.booking.operatoryNum, 10),
    appointmentTypeNum: Number.parseInt(body.appointmentTypeNum ?? config.booking.appointmentTypeNum, 10),
    durationMinutes: Math.max(5, Number.parseInt(body.durationMinutes ?? config.booking.fallbackDurationMinutes, 10) || config.booking.fallbackDurationMinutes)
  };
}

export async function createBooking(input) {
  if (!config.writesEnabled) {
    const error = new Error('Open Dental write mode is disabled. Set ENABLE_OPEN_DENTAL_WRITES=true after testing on clone DB.');
    error.status = 501;
    throw error;
  }

  await assertSlotStillAvailable(input);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await assertNoSameDayPatientBooking(connection, input);

    const clinicNow = clinicNowParts();
    const existingPatient = await findExistingOnlinePatient(connection, input);
    let patNum;
    let isReturningPatient = false;

    if (existingPatient) {
      patNum = existingPatient.PatNum;
      isReturningPatient = true;
      await ensureDriverLicensePatField(connection, patNum, input, clinicNow.date);
    } else {
      const [patientResult] = await connection.execute(
        `INSERT INTO patient
          (LName, FName, WirelessPhone, Email, Birthdate, Address, City, State, PatStatus, Gender, Position, PriProv, SecProv, BillingType, FeeSched)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 0, 0, 0)`,
        [
          input.lastName,
          input.firstName,
          input.phone,
          input.email,
          input.birthdate,
          input.address,
          input.city,
          input.state,
          input.providerNum
        ]
      );
      patNum = patientResult.insertId;
      await connection.execute('UPDATE patient SET Guarantor = ? WHERE PatNum = ?', [patNum, patNum]);
      await connection.execute(
        `INSERT INTO patfield
          (PatNum, FieldName, FieldValue, SecUserNumEntry, SecDateEntry)
         VALUES (?, 'Driver License ID', ?, 0, ?)`,
        [patNum, input.driverLicense, clinicNow.date]
      );
    }

    const pattern = await appointmentPattern(connection, input.appointmentTypeNum, input.durationMinutes);
    const noteParts = [
      'ONLINE PT',
      'Created from website Luk Dental booking.',
      `Name: ${input.firstName} ${input.lastName}`,
      input.phone ? `Cell: ${input.phone}` : '',
      input.email ? `Email: ${input.email}` : '',
      input.birthdate !== '0001-01-01' ? `DOB: ${formatUsDate(input.birthdate)}` : '',
      input.note ? `Note:\n${input.note}` : ''
    ].filter(Boolean);

    const [appointmentResult] = await connection.execute(
      `INSERT INTO appointment
        (PatNum, AptStatus, Pattern, Confirmed, TimeLocked, Op, ProvNum, ProvHyg, AptDateTime, IsNewPatient, ProcDescript, Note, ClinicNum, AppointmentTypeNum, SecUserNumEntry, SecDateTEntry)
       VALUES (?, 1, ?, 0, 0, ?, ?, 0, ?, 1, ?, ?, 0, ?, 0, ?)`,
      [
        patNum,
        pattern,
        input.operatoryNum,
        input.providerNum,
        dateTime(input.date, input.time),
        isReturningPatient ? 'Website Booking - Existing Patient' : 'Website Booking - New Patient',
        noteParts.join('\n'),
        input.appointmentTypeNum,
        clinicNow.dateTime
      ]
    );
    const aptNum = appointmentResult.insertId;
    if (input.driverLicense) {
      await connection.execute(
        `INSERT INTO apptfield
          (AptNum, FieldName, FieldValue)
         VALUES (?, 'Driver License ID', ?)`,
        [aptNum, input.driverLicense]
      );
    }

    await connection.commit();
    return {
      patNum,
      aptNum,
      reusedPatient: isReturningPatient,
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
