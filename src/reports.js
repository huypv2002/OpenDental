import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { pool } from './db.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REPORT_DAYS = 370;

function pad(value) {
  return String(value).padStart(2, '0');
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function ymd(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function mdy(date) {
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()}`;
}

function mdyPathParts(date) {
  return [`report-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${date.getFullYear()}`];
}

function parseDateInput(value, field) {
  const raw = String(value ?? '').trim();
  if (!DATE_RE.test(raw)) {
    const error = new Error(`${field} must use YYYY-MM-DD format.`);
    error.status = 400;
    throw error;
  }
  const [year, month, day] = raw.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
    const error = new Error(`${field} is not a valid date.`);
    error.status = 400;
    throw error;
  }
  return parsed;
}

function toDate(value) {
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateValue(value) {
  const parsed = toDate(value);
  return parsed ? mdy(parsed) : '';
}

function timeValue(value) {
  const parsed = toDate(value);
  if (!parsed) return '';
  return minutesToDisplayTime((parsed.getHours() * 60) + parsed.getMinutes());
}

function minutesToDisplayTime(value) {
  const hours24 = Math.floor(value / 60) % 24;
  const minutes = value % 60;
  const suffix = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${pad(minutes)} ${suffix}`;
}

function patternMinutes(pattern) {
  const minutes = String(pattern ?? '').length * 5;
  return minutes > 0 ? minutes : 0;
}

function endTimeValue(value, pattern) {
  const parsed = toDate(value);
  if (!parsed) return '';
  const duration = patternMinutes(pattern);
  if (!duration) return '';
  return minutesToDisplayTime((parsed.getHours() * 60) + parsed.getMinutes() + duration);
}

function statusLabel(status) {
  const labels = {
    0: 'None',
    1: 'Scheduled',
    2: 'Complete',
    3: 'UnschedList',
    4: 'ASAP',
    5: 'Broken',
    6: 'Planned',
    7: 'PtNote',
    8: 'PtNoteCompleted'
  };
  return labels[Number(status)] ?? String(status ?? '');
}

function genderLabel(gender) {
  const labels = {
    0: 'Male',
    1: 'Female',
    2: 'Unknown',
    3: 'Other'
  };
  return labels[Number(gender)] ?? String(gender ?? '');
}

function oneLine(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function patientName(row) {
  return [row.FName, row.LName].map(oneLine).filter(Boolean).join(' ');
}

function patientAddress(row) {
  return [row.Address, row.Address2].map(oneLine).filter(Boolean).join(' ');
}

function providerName(row) {
  const fullName = [row.ProviderFName, row.ProviderLName].map(oneLine).filter(Boolean).join(' ');
  return [row.ProviderAbbr, fullName].map(oneLine).filter(Boolean).join(' - ');
}

function operatoryName(row) {
  return [row.OperatoryAbbrev, row.OpName].map(oneLine).filter(Boolean).join(' - ');
}

function csvValue(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(headers, rows) {
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvValue).join(',')).join('\r\n')}\r\n`;
}

function defaultStartDate() {
  const today = new Date();
  return new Date(today.getFullYear(), today.getMonth(), today.getDate());
}

function resolveRange(body) {
  const preset = String(body.preset ?? body.range ?? '15days').trim().toLowerCase();
  const today = defaultStartDate();
  let start = body.startDate ? parseDateInput(body.startDate, 'startDate') : today;
  let end;

  if (body.endDate) {
    end = parseDateInput(body.endDate, 'endDate');
  } else if (preset === 'week') {
    if (!body.startDate) {
      start = addDays(today, -today.getDay());
    }
    end = addDays(start, 6);
  } else if (preset === 'month') {
    if (!body.startDate) {
      start = new Date(today.getFullYear(), today.getMonth(), 1);
    }
    end = addDays(new Date(start.getFullYear(), start.getMonth() + 1, start.getDate()), -1);
  } else if (preset === 'year') {
    if (!body.startDate) {
      start = new Date(today.getFullYear(), 0, 1);
    }
    end = addDays(new Date(start.getFullYear() + 1, start.getMonth(), start.getDate()), -1);
  } else {
    const parsedDays = Number.parseInt(body.days ?? '15', 10);
    const days = Number.isInteger(parsedDays) ? Math.max(1, Math.min(MAX_REPORT_DAYS, parsedDays)) : 15;
    end = addDays(start, days - 1);
  }

  if (end < start) {
    const error = new Error('endDate must be the same as or after startDate.');
    error.status = 400;
    throw error;
  }

  const days = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
  if (days > MAX_REPORT_DAYS) {
    const error = new Error(`Report range cannot exceed ${MAX_REPORT_DAYS} days.`);
    error.status = 400;
    throw error;
  }

  return { preset, start, end, days };
}

export function parseAppointmentReportBody(body = {}) {
  return resolveRange(body);
}

export async function exportAppointmentReport(input) {
  if (!config.reportStorage.enabled) {
    return { enabled: false, rows: 0 };
  }

  const { preset, start, end, days } = input;
  const startDate = ymd(start);
  const endDate = ymd(end);

  const [rows] = await pool.execute(
    `SELECT
       a.AptNum,
       a.AptDateTime,
       a.Pattern,
       a.AptStatus,
       a.ProcDescript,
       a.Note,
       a.Op,
       a.ProvNum,
       a.ClinicNum,
       a.AppointmentTypeNum,
       p.PatNum,
       p.FName,
       p.LName,
       p.Birthdate,
       p.Gender,
       p.WirelessPhone,
       p.HmPhone,
       p.WkPhone,
       p.Email,
       p.Address,
       p.Address2,
       p.City,
       p.State,
       p.Zip,
       pr.Abbr AS ProviderAbbr,
       pr.FName AS ProviderFName,
       pr.LName AS ProviderLName,
       o.OpName,
       o.Abbrev AS OperatoryAbbrev,
       at.AppointmentTypeName
     FROM appointment a
     INNER JOIN patient p ON p.PatNum = a.PatNum
     LEFT JOIN provider pr ON pr.ProvNum = a.ProvNum
     LEFT JOIN operatory o ON o.OperatoryNum = a.Op
     LEFT JOIN appointmenttype at ON at.AppointmentTypeNum = a.AppointmentTypeNum
     WHERE DATE(a.AptDateTime) BETWEEN ? AND ?
     ORDER BY a.AptDateTime, a.AptNum`,
    [startDate, endDate]
  );

  const [[patientTotals]] = await pool.execute(
    `SELECT
       COUNT(*) AS TotalPatients,
       SUM(CASE WHEN PatStatus = 0 THEN 1 ELSE 0 END) AS ActivePatients
     FROM patient`
  );
  const [[newPatientTotals]] = await pool.execute(
    `SELECT
       COUNT(*) AS NewPatients,
       SUM(CASE WHEN PatStatus = 0 THEN 1 ELSE 0 END) AS NewActivePatients
     FROM patient
     WHERE SecDateEntry BETWEEN ? AND ?`,
    [startDate, endDate]
  );
  const [[appointmentPatientTotals]] = await pool.execute(
    `SELECT
       COUNT(DISTINCT PatNum) AS PatientsWithAppointments,
       COUNT(DISTINCT CASE WHEN AptStatus = 1 THEN PatNum END) AS PatientsWithScheduledAppointments,
       COUNT(*) AS AppointmentRows
     FROM appointment
     WHERE DATE(AptDateTime) BETWEEN ? AND ?`,
    [startDate, endDate]
  );

  const headers = [
    'Report Start Date',
    'Report End Date',
    'Appointment Date',
    'Appointment Time',
    'Appointment End Time',
    'Duration Minutes',
    'Appointment Status',
    'Appointment #',
    'Patient #',
    'Patient Name',
    'DOB',
    'Gender',
    'Cell Phone',
    'Home Phone',
    'Work Phone',
    'Email',
    'Address',
    'City',
    'State',
    'Zip',
    'Provider',
    'Operatory',
    'Appointment Type',
    'Procedure Description',
    'Appointment Note'
  ];

  const startDisplay = mdy(start);
  const endDisplay = mdy(end);
  const dataRows = rows.map((row) => [
    startDisplay,
    endDisplay,
    dateValue(row.AptDateTime),
    timeValue(row.AptDateTime),
    endTimeValue(row.AptDateTime, row.Pattern),
    patternMinutes(row.Pattern),
    statusLabel(row.AptStatus),
    row.AptNum,
    row.PatNum,
    patientName(row),
    dateValue(row.Birthdate),
    genderLabel(row.Gender),
    oneLine(row.WirelessPhone),
    oneLine(row.HmPhone),
    oneLine(row.WkPhone),
    oneLine(row.Email),
    patientAddress(row),
    oneLine(row.City),
    oneLine(row.State),
    oneLine(row.Zip),
    providerName(row),
    operatoryName(row),
    oneLine(row.AppointmentTypeName),
    oneLine(row.ProcDescript),
    oneLine(row.Note)
  ]);

  const folder = path.join(config.reportStorage.dir, ...mdyPathParts(start));
  await fs.mkdir(folder, { recursive: true });

  const fileName = `clinic-appointments-${preset}-${startDate}-to-${endDate}.csv`;
  const filePath = path.join(folder, fileName);
  await fs.writeFile(filePath, toCsv(headers, dataRows), 'utf8');

  const patientSummaryHeaders = ['Metric', 'Value', 'Report Start Date', 'Report End Date', 'Notes'];
  const patientSummaryRows = [
    ['Total patient records currently in Open Dental', patientTotals.TotalPatients ?? 0, startDisplay, endDisplay, 'All rows currently present in patient table.'],
    ['Active patient records currently in Open Dental', patientTotals.ActivePatients ?? 0, startDisplay, endDisplay, 'Patients with PatStatus = 0.'],
    ['New patient records created in date range', newPatientTotals.NewPatients ?? 0, startDisplay, endDisplay, 'Based on patient.SecDateEntry.'],
    ['New active patient records created in date range', newPatientTotals.NewActivePatients ?? 0, startDisplay, endDisplay, 'Based on patient.SecDateEntry and PatStatus = 0.'],
    ['Patients with any appointment in date range', appointmentPatientTotals.PatientsWithAppointments ?? 0, startDisplay, endDisplay, 'Distinct patient count from appointment table.'],
    ['Patients with scheduled appointments in date range', appointmentPatientTotals.PatientsWithScheduledAppointments ?? 0, startDisplay, endDisplay, 'Distinct patient count where AptStatus = 1.'],
    ['Appointment rows in date range', appointmentPatientTotals.AppointmentRows ?? rows.length, startDisplay, endDisplay, 'All appointment rows in exported range.']
  ];
  const patientSummaryFileName = `clinic-patient-summary-${preset}-${startDate}-to-${endDate}.csv`;
  const patientSummaryFilePath = path.join(folder, patientSummaryFileName);
  await fs.writeFile(patientSummaryFilePath, toCsv(patientSummaryHeaders, patientSummaryRows), 'utf8');

  return {
    enabled: true,
    preset,
    days,
    startDate: startDisplay,
    endDate: endDisplay,
    folder,
    fileName,
    filePath,
    rows: rows.length,
    patientSummaryFileName,
    patientSummaryFilePath,
    patientSummary: {
      totalPatients: Number(patientTotals.TotalPatients ?? 0),
      activePatients: Number(patientTotals.ActivePatients ?? 0),
      newPatients: Number(newPatientTotals.NewPatients ?? 0),
      newActivePatients: Number(newPatientTotals.NewActivePatients ?? 0),
      patientsWithAppointments: Number(appointmentPatientTotals.PatientsWithAppointments ?? 0),
      patientsWithScheduledAppointments: Number(appointmentPatientTotals.PatientsWithScheduledAppointments ?? 0),
      appointmentRows: Number(appointmentPatientTotals.AppointmentRows ?? rows.length)
    }
  };
}
