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
    closeTime: process.env.CLOSE_TIME ?? '18:00',
    slotIntervalMinutes: intEnv('SLOT_INTERVAL_MINUTES', 30, 5),
    fallbackDurationMinutes: intEnv('FALLBACK_DURATION_MINUTES', 30, 5),
    activeWeekdays: csvIntsEnv('ACTIVE_WEEKDAYS', '0,1,2,3,4,5,6'),
    busyAptStatuses: csvIntsEnv('BUSY_APT_STATUSES', '1')
  },
  writesEnabled: (process.env.ENABLE_OPEN_DENTAL_WRITES ?? 'false').toLowerCase() === 'true',
  corsOrigins: csvStringsEnv('CORS_ORIGINS', 'https://lukdental.us')
};
