import { config } from './config.js';
import { pool } from './db.js';
import { getAvailableSlots } from './slots.js';

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

function optionalString(body, key) {
  return String(body[key] ?? '').trim();
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

export function parseBookingBody(body) {
  const date = normalizeDate(requiredString(body, 'date'), 'date');
  const time = normalizeTime(requiredString(body, 'time'), 'time');
  const birthdateRaw = optionalString(body, 'birthdate');

  return {
    date,
    time,
    endsAt: optionalString(body, 'endsAt'),
    firstName: requiredString(body, 'firstName'),
    lastName: requiredString(body, 'lastName'),
    phone: normalizeUsPhone(requiredString(body, 'phone')),
    email: optionalString(body, 'email'),
    birthdate: birthdateRaw && DATE_RE.test(birthdateRaw) ? birthdateRaw : '0001-01-01',
    address: optionalString(body, 'address'),
    city: optionalString(body, 'city'),
    state: optionalString(body, 'state'),
    note: optionalString(body, 'note'),
    providerNum: Number.parseInt(body.providerNum ?? config.booking.providerNum, 10),
    operatoryNum: Number.parseInt(body.operatoryNum ?? config.booking.operatoryNum, 10),
    appointmentTypeNum: Number.parseInt(body.appointmentTypeNum ?? config.booking.appointmentTypeNum, 10),
    durationMinutes: Math.max(60, Number.parseInt(body.durationMinutes ?? config.booking.fallbackDurationMinutes, 10) || 60)
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
    const patNum = patientResult.insertId;
    await connection.execute('UPDATE patient SET Guarantor = ? WHERE PatNum = ?', [patNum, patNum]);

    const pattern = await appointmentPattern(connection, input.appointmentTypeNum, input.durationMinutes);
    const noteParts = [
      'ONLINE PT',
      'Created from website booking bridge.',
      `Name: ${input.firstName} ${input.lastName}`,
      input.phone ? `Cell: ${input.phone}` : '',
      input.email ? `Email: ${input.email}` : '',
      input.birthdate !== '0001-01-01' ? `DOB: ${formatUsDate(input.birthdate)}` : '',
      input.note ? `Note:\n${input.note}` : ''
    ].filter(Boolean);

    const [appointmentResult] = await connection.execute(
      `INSERT INTO appointment
        (PatNum, AptStatus, Pattern, Confirmed, TimeLocked, Op, ProvNum, ProvHyg, AptDateTime, IsNewPatient, ProcDescript, Note, ClinicNum, AppointmentTypeNum, SecUserNumEntry, SecDateTEntry)
       VALUES (?, 1, ?, 0, 0, ?, ?, 0, ?, 1, ?, ?, 0, ?, 0, NOW())`,
      [
        patNum,
        pattern,
        input.operatoryNum,
        input.providerNum,
        dateTime(input.date, input.time),
        'Website Booking - New Patient',
        noteParts.join('\n'),
        input.appointmentTypeNum
      ]
    );

    await connection.commit();
    return {
      patNum,
      aptNum: appointmentResult.insertId,
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
