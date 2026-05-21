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

function dateTimeStart(value) {
  return `${value} 00:00:00`;
}

function nextDateTimeStart(value) {
  return `${dateKey(addDays(parseDate(value), 1))} 00:00:00`;
}

function mysqlDateToYmd(value) {
  if (value instanceof Date) {
    return dateKey(value);
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
    excludeAptNum: Number.parseInt(query.excludeAptNum ?? '', 10) || 0,
    busyAptStatuses: parseCsvIntsParam(query.busyStatuses, config.booking.busyAptStatuses)
  };
}

export function parseSlotRangeQuery(query) {
  const startDate = parseDateInput(String(query.startDate ?? query.start ?? ''));
  const days = Number.parseInt(query.days ?? '7', 10);
  const durationOverrideMinutes = Number.parseInt(query.durationOverride ?? query.durationMinutes ?? '', 10);
  return {
    startDate,
    days: Number.isInteger(days) ? Math.max(1, Math.min(35, days)) : 7,
    providerNum: Number.parseInt(query.providerNum ?? config.booking.providerNum, 10),
    operatoryNum: Number.parseInt(query.operatoryNum ?? config.booking.operatoryNum, 10),
    appointmentTypeNum: Number.parseInt(query.appointmentTypeNum ?? config.booking.appointmentTypeNum, 10),
    slotIntervalMinutes: Number.parseInt(query.interval ?? config.booking.slotIntervalMinutes, 10),
    fallbackDurationMinutes: Number.parseInt(query.duration ?? config.booking.fallbackDurationMinutes, 10),
    durationOverrideMinutes: Number.isInteger(durationOverrideMinutes) ? durationOverrideMinutes : 0,
    excludeAptNum: Number.parseInt(query.excludeAptNum ?? '', 10) || 0,
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
  const excludeClause = params.excludeAptNum ? ' AND AptNum <> ?' : '';
  const values = [dateTimeStart(params.date), nextDateTimeStart(params.date), params.operatoryNum, ...params.busyAptStatuses];
  if (params.excludeAptNum) {
    values.push(params.excludeAptNum);
  }
  const [rows] = await pool.execute(
    `SELECT AptNum, AptDateTime, Pattern
     FROM appointment
     WHERE AptDateTime >= ?
       AND AptDateTime < ?
       AND Op = ?
       AND AptStatus IN (${placeholders})
       ${excludeClause}
     ORDER BY AptDateTime`,
    values
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

async function busyAppointmentRangesByDate(params, dates) {
  const rangesByDate = Object.fromEntries(dates.map((date) => [date, []]));
  if (!params.busyAptStatuses.length || !dates.length) return rangesByDate;

  const placeholders = params.busyAptStatuses.map(() => '?').join(',');
  const excludeClause = params.excludeAptNum ? ' AND AptNum <> ?' : '';
  const values = [
    dateTimeStart(dates[0]),
    nextDateTimeStart(dates[dates.length - 1]),
    params.operatoryNum,
    ...params.busyAptStatuses
  ];
  if (params.excludeAptNum) {
    values.push(params.excludeAptNum);
  }

  const [rows] = await pool.execute(
    `SELECT AptNum, AptDateTime, Pattern
     FROM appointment
     WHERE AptDateTime >= ?
       AND AptDateTime < ?
       AND Op = ?
       AND AptStatus IN (${placeholders})
       ${excludeClause}
     ORDER BY AptDateTime`,
    values
  );

  rows.forEach((row) => {
    const startDate = row.AptDateTime instanceof Date ? row.AptDateTime : new Date(row.AptDateTime);
    const date = dateKey(startDate);
    if (!rangesByDate[date]) return;
    const start = (startDate.getHours() * 60) + startDate.getMinutes();
    const duration = patternToMinutes(row.Pattern, params.fallbackDurationMinutes);
    rangesByDate[date].push({
      source: 'appointment',
      id: row.AptNum,
      start,
      end: start + duration
    });
  });

  return rangesByDate;
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

async function blockoutRangesByDate(params, dates) {
  const rangesByDate = Object.fromEntries(dates.map((date) => [date, []]));
  if (!dates.length) return rangesByDate;

  const [rows] = await pool.execute(
    `SELECT s.ScheduleNum, s.SchedDate, s.StartTime, s.StopTime
     FROM schedule s
     LEFT JOIN scheduleop so ON so.ScheduleNum = s.ScheduleNum
     WHERE s.SchedDate BETWEEN ? AND ?
       AND s.SchedType = 2
       AND (so.OperatoryNum = ? OR so.OperatoryNum IS NULL)
     ORDER BY s.SchedDate, s.StartTime`,
    [dates[0], dates[dates.length - 1], params.operatoryNum]
  );

  rows.forEach((row) => {
    const date = mysqlDateToYmd(row.SchedDate);
    if (!rangesByDate[date]) return;
    const range = {
      source: 'blockout',
      id: row.ScheduleNum,
      date,
      start: timeToMinutes(row.StartTime),
      end: timeToMinutes(row.StopTime)
    };
    if (range.end > range.start) {
      rangesByDate[date].push(range);
    }
  });

  return rangesByDate;
}

function normalizeSlotParams(input) {
  return {
    ...input,
    providerNum: Number.isInteger(input.providerNum) ? input.providerNum : config.booking.providerNum,
    operatoryNum: Number.isInteger(input.operatoryNum) ? input.operatoryNum : config.booking.operatoryNum,
    appointmentTypeNum: Number.isInteger(input.appointmentTypeNum) ? input.appointmentTypeNum : config.booking.appointmentTypeNum,
    slotIntervalMinutes: Math.max(5, input.slotIntervalMinutes || config.booking.slotIntervalMinutes),
    fallbackDurationMinutes: Math.max(5, input.fallbackDurationMinutes || config.booking.fallbackDurationMinutes),
    durationOverrideMinutes: Math.max(0, input.durationOverrideMinutes || 0),
    excludeAptNum: Math.max(0, input.excludeAptNum || 0),
    busyAptStatuses: Array.isArray(input.busyAptStatuses) ? input.busyAptStatuses : config.booking.busyAptStatuses
  };
}

function slotsForDate(params, date, duration, blocked) {
  const weekday = new Date(`${date}T12:00:00`).getDay();
  if (!config.booking.activeWeekdays.includes(weekday)) {
    return {
      date,
      providerNum: params.providerNum,
      operatoryNum: params.operatoryNum,
      appointmentTypeNum: params.appointmentTypeNum,
      durationMinutes: duration,
      blocked,
      slots: []
    };
  }

  const businessHours = bookingHoursForDate(date);
  if (!businessHours) {
    return {
      date,
      providerNum: params.providerNum,
      operatoryNum: params.operatoryNum,
      appointmentTypeNum: params.appointmentTypeNum,
      durationMinutes: duration,
      blocked,
      slots: []
    };
  }

  const open = timeToMinutes(businessHours.openTime);
  const close = timeToMinutes(businessHours.closeTime);
  const slots = [];

  for (let start = open; start + duration <= close; start += params.slotIntervalMinutes) {
    const end = start + duration;
    if (overlaps(start, end, blocked)) continue;

    slots.push({
      date,
      time: minutesToTime(start),
      endsAt: minutesToTime(end),
      durationMinutes: duration,
      providerNum: params.providerNum,
      operatoryNum: params.operatoryNum,
      appointmentTypeNum: params.appointmentTypeNum
    });
  }

  return {
    date,
    providerNum: params.providerNum,
    operatoryNum: params.operatoryNum,
    appointmentTypeNum: params.appointmentTypeNum,
    durationMinutes: duration,
    blocked,
    slots
  };
}

export async function getAvailableSlots(input) {
  const params = normalizeSlotParams(input);
  const duration = params.durationOverrideMinutes || await appointmentDurationMinutes(params.appointmentTypeNum, params.fallbackDurationMinutes);
  const [appointments, blockouts] = await Promise.all([
    busyAppointmentRanges(params),
    blockoutRanges(params)
  ]);
  const blocked = [...appointments, ...blockouts];
  return slotsForDate(params, params.date, duration, blocked);
}

export async function getAvailableSlotsRange(input) {
  const params = normalizeSlotParams(input);
  const start = parseDate(params.startDate);
  const dates = [];
  for (let index = 0; index < params.days; index += 1) {
    dates.push(dateKey(addDays(start, index)));
  }

  const duration = params.durationOverrideMinutes || await appointmentDurationMinutes(params.appointmentTypeNum, params.fallbackDurationMinutes);
  const [appointmentsByDate, blockoutsByDate] = await Promise.all([
    busyAppointmentRangesByDate(params, dates),
    blockoutRangesByDate(params, dates)
  ]);

  return {
    startDate: params.startDate,
    days: params.days,
    providerNum: params.providerNum,
    operatoryNum: params.operatoryNum,
    appointmentTypeNum: params.appointmentTypeNum,
    durationMinutes: duration,
    dates: Object.fromEntries(dates.map((date) => {
      const blocked = [
        ...(appointmentsByDate[date] || []),
        ...(blockoutsByDate[date] || [])
      ];
      return [date, slotsForDate(params, date, duration, blocked)];
    }))
  };
}
