import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { pool } from './db.js';

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
    0: 'Unknown',
    1: 'Male',
    2: 'Female',
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

export function parseAppointmentReportBody(body = {}) {
  const parsedDays = Number.parseInt(body.days ?? '15', 10);
  return {
    days: Number.isInteger(parsedDays) ? Math.max(1, Math.min(60, parsedDays)) : 15
  };
}

export async function exportAppointmentReport(input) {
  if (!config.reportStorage.enabled) {
    return { enabled: false, rows: 0 };
  }

  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const end = addDays(start, input.days - 1);
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

  const fileName = `clinic-appointments-next-${input.days}-days-${startDate}.csv`;
  const filePath = path.join(folder, fileName);
  await fs.writeFile(filePath, toCsv(headers, dataRows), 'utf8');

  return {
    enabled: true,
    days: input.days,
    startDate: startDisplay,
    endDate: endDisplay,
    folder,
    fileName,
    filePath,
    rows: rows.length
  };
}
