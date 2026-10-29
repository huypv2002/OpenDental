import { bookingHoursForDate, parseDateHours } from './bookingHours.js';
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

function optionalPlainLatinName(body, key) {
  const value = String(body[key] ?? '').trim();
  if (value && !/^[A-Za-z][A-Za-z '\-]*$/.test(value)) {
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

// Online booking identity is DOB + phone. Names may be shortened or mistyped.
function hasMatchingBookingPhone(patient, phone) {
  const expected = phoneDigits(phone);
  return expected.length === 10 && ['WirelessPhone', 'HmPhone', 'WkPhone']
    .some((field) => phoneDigits(patient[field]) === expected);
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


export async function assertSlotStillAvailable(input) {
  const hours = bookingHoursForDate(input.date, parseDateHours(input.dateHours));
  if (!hours) {
    const error = new Error('Selected appointment date is outside online booking hours.');
    error.status = 409;
    throw error;
  }

  const availability = await getAvailableSlots({
    date: input.date,
    dateHours: parseDateHours(input.dateHours),
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
  const [rows] = await connection.execute(
    `SELECT a.AptNum, a.AptDateTime, p.WirelessPhone, p.HmPhone, p.WkPhone
     FROM appointment a
     INNER JOIN patient p ON p.PatNum = a.PatNum
     WHERE a.AptStatus = 1
       AND a.AptDateTime >= ?
       AND a.AptDateTime < ?
       AND p.Birthdate = ?
       AND a.Note LIKE '%ONLINE PT%'`,
    [`${input.date} 00:00:00`, `${nextDate} 00:00:00`, input.birthdate]
  );

  // Include all matching charts, including duplicates created before this rule.
  if (rows.some((row) => hasMatchingBookingPhone(row, input.phone))) {
    const error = new Error('This patient already has an active online appointment on this date.');
    error.status = 409;
    throw error;
  }
}

export async function findExistingOnlinePatient(connection, input) {
  const [rows] = await connection.execute(
    `SELECT
       p.PatNum, p.FName, p.LName, p.WirelessPhone, p.HmPhone, p.WkPhone,
       p.Email, p.Birthdate, p.Address, p.City, p.State, p.Zip
     FROM patient p
     WHERE p.Birthdate = ?
     ORDER BY p.PatNum`,
    [input.birthdate]
  );

  // Normalize phone formatting in JS, including an optional US +1 prefix.
  // Prefer the oldest chart when historical duplicates already exist.
  return rows.find((row) => hasMatchingBookingPhone(row, input.phone)) || null;
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
    dateHours: parseDateHours(body.dateHours),
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
    zip: optionalString(body, 'zip'),
    driverLicense: optionalString(body, 'driverLicense'),
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
          (LName, FName, WirelessPhone, Email, Birthdate, Address, City, State, Zip, PatStatus, Gender, Position, PriProv, SecProv, BillingType, FeeSched)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 0, 0, 0)`,
        [
          input.lastName,
          input.firstName,
          input.phone,
          input.email,
          input.birthdate,
          input.address,
          input.city,
          input.state,
          input.zip,
          input.providerNum
        ]
      );
      patNum = patientResult.insertId;
      await connection.execute('UPDATE patient SET Guarantor = ? WHERE PatNum = ?', [patNum, patNum]);
      await ensureDriverLicensePatField(connection, patNum, input, clinicNow.date);
    }

    const pattern = await appointmentPattern(connection, input.appointmentTypeNum, input.durationMinutes);
    const noteParts = [
      'ONLINE PT',
      'Created from website Luk Dental booking.',
      `Name: ${input.firstName} ${input.lastName}`,
      input.phone ? `Cell: ${input.phone}` : '',
      input.email ? `Email: ${input.email}` : '',
      input.birthdate !== '0001-01-01' ? `DOB: ${formatUsDate(input.birthdate)}` : '',
      input.zip ? `Zip: ${input.zip}` : '',
      input.note ? `Note:\n${input.note}` : ''
    ].filter(Boolean);

    const [appointmentResult] = await connection.execute(
      `INSERT INTO appointment
        (PatNum, AptStatus, Pattern, Confirmed, TimeLocked, Op, ProvNum, ProvHyg, AptDateTime, IsNewPatient, ProcDescript, Note, ClinicNum, AppointmentTypeNum, SecUserNumEntry, SecDateTEntry)
       VALUES (?, 1, ?, 0, 0, ?, ?, 0, ?, ?, ?, ?, 0, ?, 0, ?)`,
      [
        patNum,
        pattern,
        input.operatoryNum,
        input.providerNum,
        dateTime(input.date, input.time),
        isReturningPatient ? 0 : 1,
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
