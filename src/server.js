import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { pool, closePool } from './db.js';
import { requireApiToken } from './auth.js';
import {
  cancelAppointment,
  changeAppointment,
  parseCancelAppointmentBody,
  parseChangeAppointmentBody,
  parseVerifyChangeAppointmentBody,
  parseVerifyAppointmentBody,
  verifyAppointmentForChange,
  verifyAppointmentsForCancel
} from './appointments.js';
import { createBooking, parseBookingBody } from './bookings.js';
import { sendBookingEmails } from './email.js';
import { saveBookingFiles } from './files.js';
import { exportAppointmentReport, parseAppointmentReportBody } from './reports.js';
import {
  clearSmsDryRunLogs,
  getSmsRecallCandidates,
  getSmsReminderAppointments,
  getSmsReminderLogs,
  logSmsRecallResult,
  logSmsReminderResult
} from './smsReminders.js';
import { getAvailableSlots, getAvailableSlotsRange, getReferenceData, parseSlotQuery, parseSlotRangeQuery } from './slots.js';

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: config.fileStorage.maxFiles,
    fileSize: config.fileStorage.maxFileBytes
  }
});

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || config.corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin is not allowed by CORS.'));
  }
}));

app.get('/health', async (_req, res) => {
  try {
    const [rows] = await pool.execute('SELECT 1 AS ok');
    res.json({ ok: true, db: rows[0]?.ok === 1 });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/reference', requireApiToken, async (_req, res, next) => {
  try {
    res.json({ ok: true, data: await getReferenceData() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/slots', requireApiToken, async (req, res, next) => {
  try {
    const query = parseSlotQuery(req.query);
    const data = await getAvailableSlots(query);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.get('/api/slots/range', requireApiToken, async (req, res, next) => {
  try {
    const query = parseSlotRangeQuery(req.query);
    const data = await getAvailableSlotsRange(query);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/bookings', requireApiToken, async (req, res, next) => {
  try {
    const body = parseBookingBody(req.body ?? {});
    const data = await createBooking(body);
    let email = { enabled: config.email.enabled, sent: [] };
    try {
      email = await sendBookingEmails(body, data);
    } catch (error) {
      console.warn(`Booking ${data.aptNum} was created, but email failed: ${error.message}`);
      email = {
        enabled: config.email.enabled,
        sent: [],
        error: error.message
      };
    }
    data.email = email;
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/bookings/:aptNum/files', requireApiToken, upload.any(), async (req, res, next) => {
  try {
    const input = {
      aptNum: req.params.aptNum,
      firstName: String(req.body.firstName ?? '').trim(),
      lastName: String(req.body.lastName ?? '').trim(),
      birthdate: String(req.body.birthdate ?? '').trim()
    };
    if (!input.firstName || !input.lastName) {
      const error = new Error('firstName and lastName are required.');
      error.status = 400;
      throw error;
    }

    const data = await saveBookingFiles(input, req.files ?? []);
    if (data.folder) {
      console.log(`Stored ${data.saved.length} booking file(s) for appointment ${input.aptNum} at ${data.folder}`);
    } else {
      console.log(`Received ${req.files?.length ?? 0} booking file(s) for appointment ${input.aptNum}; no files were stored.`);
    }
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/appointments/verify-change', requireApiToken, async (req, res, next) => {
  try {
    const body = parseVerifyChangeAppointmentBody(req.body ?? {});
    const data = await verifyAppointmentForChange(body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/appointments/change', requireApiToken, async (req, res, next) => {
  try {
    const body = parseChangeAppointmentBody(req.body ?? {});
    const data = await changeAppointment(body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/appointments/verify-cancel', requireApiToken, async (req, res, next) => {
  try {
    const body = parseVerifyAppointmentBody(req.body ?? {});
    const data = await verifyAppointmentsForCancel(body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/appointments/cancel', requireApiToken, async (req, res, next) => {
  try {
    const body = parseCancelAppointmentBody(req.body ?? {});
    const data = await cancelAppointment(body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/reports/appointments/export', requireApiToken, async (req, res, next) => {
  try {
    const body = parseAppointmentReportBody(req.body ?? {});
    const data = await exportAppointmentReport(body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.get('/api/sms-reminders/appointments', requireApiToken, async (req, res, next) => {
  try {
    const data = await getSmsReminderAppointments(req.query);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.get('/api/sms-reminders/recall-candidates', requireApiToken, async (req, res, next) => {
  try {
    const data = await getSmsRecallCandidates(req.query);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sms-reminders/recall-log', requireApiToken, async (req, res, next) => {
  try {
    const data = await logSmsRecallResult(req.body ?? {});
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sms-reminders/log', requireApiToken, async (req, res, next) => {
  try {
    const data = await logSmsReminderResult(req.body ?? {});
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sms-reminders/clear-dry-run', requireApiToken, async (_req, res, next) => {
  try {
    const data = await clearSmsDryRunLogs();
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.get('/api/sms-reminders/logs', requireApiToken, async (req, res, next) => {
  try {
    const data = await getSmsReminderLogs(req.query);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({
    ok: false,
    error: error.message || 'Internal server error.'
  });
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Open Dental bridge listening on http://0.0.0.0:${config.port}`);
});

async function shutdown() {
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
