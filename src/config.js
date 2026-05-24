import dotenv from 'dotenv';

dotenv.config();

function intEnv(name, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw ?? '', 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function csvIntsEnv(name, fallback) {
  const raw = process.env[name] ?? fallback;
  return raw
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value));
}

function csvStringsEnv(name, fallback = '') {
  const raw = process.env[name] ?? fallback;
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

const patientFileStorageDir = process.env.PATIENT_FILE_STORAGE_DIR ?? 'G:\\Online Patient Information';

export const config = {
  port: intEnv('PORT', 3008, 1, 65535),
  apiToken: process.env.API_TOKEN ?? '',
  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: intEnv('DB_PORT', 3306, 1, 65535),
    database: process.env.DB_NAME ?? 'opendental_test',
    user: process.env.DB_USER ?? 'luk2468',
    password: process.env.DB_PASSWORD ?? 'luk2468',
    waitForConnections: true,
    connectionLimit: intEnv('DB_POOL_LIMIT', 5, 1, 50),
    connectTimeout: intEnv('DB_CONNECT_TIMEOUT_MS', 5000, 1000, 60000),
    namedPlaceholders: true
  },
  booking: {
    providerNum: intEnv('DEFAULT_PROVIDER_NUM', 1, 0),
    operatoryNum: intEnv('DEFAULT_OPERATORY_NUM', 1, 0),
    appointmentTypeNum: intEnv('DEFAULT_APPOINTMENT_TYPE_NUM', 1, 0),
    openTime: process.env.OPEN_TIME ?? '09:00',
    closeTime: process.env.CLOSE_TIME ?? '17:30',
    slotIntervalMinutes: intEnv('SLOT_INTERVAL_MINUTES', 30, 5),
    fallbackDurationMinutes: intEnv('FALLBACK_DURATION_MINUTES', 30, 5),
    activeWeekdays: csvIntsEnv('ACTIVE_WEEKDAYS', '0,1,2,3,4,5,6'),
    busyAptStatuses: csvIntsEnv('BUSY_APT_STATUSES', '1')
  },
  writesEnabled: (process.env.ENABLE_OPEN_DENTAL_WRITES ?? 'false').toLowerCase() === 'true',
  corsOrigins: csvStringsEnv('CORS_ORIGINS', 'https://lukdental.us'),
  email: {
    enabled: (process.env.SEND_EMAILS ?? 'false').toLowerCase() === 'true',
    smtp: {
      host: process.env.SMTP_HOST ?? '',
      port: intEnv('SMTP_PORT', 587, 1, 65535),
      secure: (process.env.SMTP_SECURE ?? '').toLowerCase() === 'true',
      user: process.env.SMTP_USER ?? '',
      password: process.env.SMTP_PASSWORD ?? ''
    },
    from: process.env.EMAIL_FROM ?? '',
    adminEmails: csvStringsEnv('ADMIN_EMAILS', process.env.ADMIN_EMAIL ?? ''),
    sendCustomerEmail: (process.env.SEND_CUSTOMER_EMAIL ?? 'true').toLowerCase() === 'true',
    clinicName: process.env.CLINIC_NAME ?? 'Luk Dental',
    replyTo: process.env.EMAIL_REPLY_TO ?? process.env.ADMIN_EMAIL ?? ''
  },
  fileStorage: {
    enabled: (process.env.PATIENT_FILE_STORAGE_ENABLED ?? 'true').toLowerCase() === 'true',
    dir: patientFileStorageDir,
    maxFiles: intEnv('MAX_BOOKING_FILES', 5, 0, 20),
    maxFileBytes: intEnv('MAX_BOOKING_FILE_MB', 10, 1, 100) * 1024 * 1024
  },
  reportStorage: {
    enabled: (process.env.REPORT_STORAGE_ENABLED ?? 'true').toLowerCase() === 'true',
    dir: process.env.REPORT_STORAGE_DIR ?? 'G:\\Open Dental Report'
  }
};
