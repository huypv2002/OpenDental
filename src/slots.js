import { pool } from './db.js';
import { config } from './config.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateInput(value) {
  if (!DATE_RE.test(value ?? '')) {
    const error = new Error('date must use YYYY-MM-DD format.');
    error.status = 400;
    throw error;
  }
  return value;
}

function mysqlDateToYmd(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value).slice(0, 5).split(':').map(Number);
  return (hours * 60) + minutes;
}

function minutesToTime(value) {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function patternToMinutes(pattern, fallback) {
  const minutes = String(pattern ?? '').length * 5;
  return minutes > 0 ? minutes : fallback;
}

function overlaps(start, end, ranges) {
  return ranges.some((range) => start < range.end && end > range.start);
}

function parseCsvIntsParam(raw, fallback) {
  if (!raw) return fallback;
  return String(raw)
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value));
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

export function parseSlotQuery(query) {
  const date = parseDateInput(String(query.date ?? ''));
  const durationOverrideMinutes = Number.parseInt(query.durationOverride ?? query.durationMinutes ?? '', 10);
  return {
    date,
    providerNum: Number.parseInt(query.providerNum ?? config.booking.providerNum, 10),
    operatoryNum: Number.parseInt(query.operatoryNum ?? config.booking.operatoryNum, 10),
    appointmentTypeNum: Number.parseInt(query.appointmentTypeNum ?? config.booking.appointmentTypeNum, 10),
    openTime: String(query.openTime ?? config.booking.openTime),
    closeTime: String(query.closeTime ?? config.booking.closeTime),
    slotIntervalMinutes: Number.parseInt(query.interval ?? config.booking.slotIntervalMinutes, 10),
    fallbackDurationMinutes: Number.parseInt(query.duration ?? config.booking.fallbackDurationMinutes, 10),
    durationOverrideMinutes: Number.isInteger(durationOverrideMinutes) ? durationOverrideMinutes : 0,
    busyAptStatuses: parseCsvIntsParam(query.busyStatuses, config.booking.busyAptStatuses)
  };
}

export async function getReferenceData() {
  const [providers] = await pool.execute(
    `SELECT ProvNum, Abbr, LName, FName, IsHidden, ProvStatus
     FROM provider
     ORDER BY ItemOrder, ProvNum`
  );
  const [operatories] = await pool.execute(
    `SELECT OperatoryNum, OpName, Abbrev, ProvDentist, ProvHygienist, IsHidden, IsWebSched, IsNewPatAppt
     FROM operatory
     ORDER BY ItemOrder, OperatoryNum`
  );
  const [appointmentTypes] = await pool.execute(
    `SELECT AppointmentTypeNum, AppointmentTypeName, IsHidden, Pattern, CodeStr, BlockoutTypes
     FROM appointmenttype
     ORDER BY ItemOrder, AppointmentTypeNum`
  );

  return { providers, operatories, appointmentTypes };
}

async function appointmentDurationMinutes(appointmentTypeNum, fallbackDurationMinutes) {
  const [rows] = await pool.execute(
    `SELECT Pattern
     FROM appointmenttype
     WHERE AppointmentTypeNum = ?
     LIMIT 1`,
    [appointmentTypeNum]
  );

  return patternToMinutes(rows[0]?.Pattern, fallbackDurationMinutes);
}

async function busyAppointmentRanges(params) {
  if (!params.busyAptStatuses.length) return [];

  const placeholders = params.busyAptStatuses.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT AptNum, AptDateTime, Pattern
     FROM appointment
     WHERE DATE(AptDateTime) = ?
       AND Op = ?
       AND AptStatus IN (${placeholders})
     ORDER BY AptDateTime`,
    [params.date, params.operatoryNum, ...params.busyAptStatuses]
  );

  return rows.map((row) => {
    const startDate = row.AptDateTime instanceof Date ? row.AptDateTime : new Date(row.AptDateTime);
    const start = (startDate.getHours() * 60) + startDate.getMinutes();
    const duration = patternToMinutes(row.Pattern, params.fallbackDurationMinutes);
    return {
      source: 'appointment',
      id: row.AptNum,
      start,
      end: start + duration
    };
  });
}

async function blockoutRanges(params) {
  const [rows] = await pool.execute(
    `SELECT s.ScheduleNum, s.SchedDate, s.StartTime, s.StopTime
     FROM schedule s
     LEFT JOIN scheduleop so ON so.ScheduleNum = s.ScheduleNum
     WHERE s.SchedDate = ?
       AND s.SchedType = 2
       AND (so.OperatoryNum = ? OR so.OperatoryNum IS NULL)
     ORDER BY s.StartTime`,
    [params.date, params.operatoryNum]
  );

  return rows
    .map((row) => ({
      source: 'blockout',
      id: row.ScheduleNum,
      date: mysqlDateToYmd(row.SchedDate),
      start: timeToMinutes(row.StartTime),
      end: timeToMinutes(row.StopTime)
    }))
    .filter((range) => range.end > range.start);
}

export async function getAvailableSlots(input) {
  const params = {
    ...input,
    providerNum: Number.isInteger(input.providerNum) ? input.providerNum : config.booking.providerNum,
    operatoryNum: Number.isInteger(input.operatoryNum) ? input.operatoryNum : config.booking.operatoryNum,
    appointmentTypeNum: Number.isInteger(input.appointmentTypeNum) ? input.appointmentTypeNum : config.booking.appointmentTypeNum,
    slotIntervalMinutes: Math.max(5, input.slotIntervalMinutes || config.booking.slotIntervalMinutes),
    fallbackDurationMinutes: Math.max(5, input.fallbackDurationMinutes || config.booking.fallbackDurationMinutes),
    durationOverrideMinutes: Math.max(0, input.durationOverrideMinutes || 0)
  };

  const weekday = new Date(`${params.date}T12:00:00`).getDay();
  if (!config.booking.activeWeekdays.includes(weekday)) {
    return {
      date: params.date,
      providerNum: params.providerNum,
      operatoryNum: params.operatoryNum,
      slots: []
    };
  }

  const businessHours = bookingHoursForDate(params.date);
  if (!businessHours) {
    return {
      date: params.date,
      providerNum: params.providerNum,
      operatoryNum: params.operatoryNum,
      appointmentTypeNum: params.appointmentTypeNum,
      durationMinutes: params.durationOverrideMinutes || params.fallbackDurationMinutes,
      blocked: [],
      slots: []
    };
  }
  params.openTime = businessHours.openTime;
  params.closeTime = businessHours.closeTime;

  const duration = params.durationOverrideMinutes || await appointmentDurationMinutes(params.appointmentTypeNum, params.fallbackDurationMinutes);
  const [appointments, blockouts] = await Promise.all([
    busyAppointmentRanges(params),
    blockoutRanges(params)
  ]);
  const blocked = [...appointments, ...blockouts];
  const open = timeToMinutes(params.openTime);
  const close = timeToMinutes(params.closeTime);
  const slots = [];

  for (let start = open; start + duration <= close; start += params.slotIntervalMinutes) {
    const end = start + duration;
    if (overlaps(start, end, blocked)) continue;

    slots.push({
      date: params.date,
      time: minutesToTime(start),
      endsAt: minutesToTime(end),
      durationMinutes: duration,
      providerNum: params.providerNum,
      operatoryNum: params.operatoryNum,
      appointmentTypeNum: params.appointmentTypeNum
    });
  }

  return {
    date: params.date,
    providerNum: params.providerNum,
    operatoryNum: params.operatoryNum,
    appointmentTypeNum: params.appointmentTypeNum,
    durationMinutes: duration,
    blocked,
    slots
  };
}
