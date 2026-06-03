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
import {
  deleteAdminAppointment,
  listAdminAppointments,
  listAdminPatients,
  saveAdminAppointment,
  saveAdminPatient
} from './admin.js';
import { createBooking, parseBookingBody } from './bookings.js';
import { sendBookingEmails } from './email.js';
import { saveBookingFiles } from './files.js';
import {
  deleteMembershipPlan,
  ensurePatientPortalTables,
  createMembershipCheckoutSession,
  handleStripeWebhook,
  linkPatientAccount,
  listMembershipPlans,
  listPatientAccounts,
  loginPatientAccount,
  parseMembershipPlanBody,
  parseMembershipPlanDeleteBody,
  parsePatientPortalCheckoutBody,
  parsePatientAccountLinkBody,
  parsePatientAccountMembershipBody,
  parsePatientAccountPasswordBody,
  parsePatientAccountStatusBody,
  parsePatientLoginBody,
  parsePatientRegisterBody,
  registerPatientAccount,
  saveMembershipPlan,
  updatePatientAccountMembership,
  updatePatientAccountPassword,
  updatePatientAccountStatus
} from './patientPortal.js';
import { exportAppointmentReport, parseAppointmentReportBody } from './reports.js';
import {
  addSmsTemplate,
  deleteSmsTemplate,
  ensureSmsCampaignLogTable,
  ensureSmsSettingsTable,
  ensureSmsTemplatesTable,
  ensureSmsTreatmentLogTable,
  getSmsBirthdayCandidates,
  getSmsSettings,
  getSmsTemplates,
  getSmsTreatmentCandidates,
  initDefaultSmsTemplates,
  saveSmsTemplate,
  saveSmsSetting,
  clearSmsDryRunLogs,
  getSmsRecallCandidates,
  getSmsReminderAppointments,
  getSmsReminderLogs,
  logSmsCampaignResult,
  logSmsRecallResult,
  logSmsReminderResult,
  logSmsTreatmentResult,
  resetSmsReminderLog
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
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    const data = await handleStripeWebhook(req.body, req.headers['stripe-signature']);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});
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

app.post('/api/patient-portal/register', requireApiToken, async (req, res, next) => {
  try {
    const body = parsePatientRegisterBody(req.body ?? {});
    const data = await registerPatientAccount(body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/patient-portal/login', requireApiToken, async (req, res, next) => {
  try {
    const body = parsePatientLoginBody(req.body ?? {});
    const data = await loginPatientAccount(body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.get('/api/patient-portal/accounts', requireApiToken, async (req, res, next) => {
  try {
    const data = await listPatientAccounts(req.query);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.get('/api/patient-portal/membership-plans', requireApiToken, async (req, res, next) => {
  try {
    const data = await listMembershipPlans(req.query);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/patient-portal/membership-plans', requireApiToken, async (req, res, next) => {
  try {
    const body = parseMembershipPlanBody(req.body ?? {});
    const data = await saveMembershipPlan(body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/patient-portal/membership-plans/delete', requireApiToken, async (req, res, next) => {
  try {
    const body = parseMembershipPlanDeleteBody(req.body ?? {});
    const data = await deleteMembershipPlan(body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/patient-portal/accounts/status', requireApiToken, async (req, res, next) => {
  try {
    const body = parsePatientAccountStatusBody(req.body ?? {});
    const data = await updatePatientAccountStatus(body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/patient-portal/accounts/membership', requireApiToken, async (req, res, next) => {
  try {
    const body = parsePatientAccountMembershipBody(req.body ?? {});
    const data = await updatePatientAccountMembership(body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/patient-portal/stripe/checkout-session', requireApiToken, async (req, res, next) => {
  try {
    const body = parsePatientPortalCheckoutBody(req.body ?? {});
    const data = await createMembershipCheckoutSession(body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/patient-portal/accounts/link', requireApiToken, async (req, res, next) => {
  try {
    const body = parsePatientAccountLinkBody(req.body ?? {});
    const data = await linkPatientAccount(body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/patient-portal/accounts/password', requireApiToken, async (req, res, next) => {
  try {
    const body = parsePatientAccountPasswordBody(req.body ?? {});
    const data = await updatePatientAccountPassword(body);
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

app.get('/api/sms-reminders/treatment-candidates', requireApiToken, async (req, res, next) => {
  try {
    const data = await getSmsTreatmentCandidates(req.query);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sms-reminders/treatment-log', requireApiToken, async (req, res, next) => {
  try {
    const data = await logSmsTreatmentResult(req.body ?? {});
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.get('/api/sms-reminders/birthday-candidates', requireApiToken, async (req, res, next) => {
  try {
    const data = await getSmsBirthdayCandidates(req.query);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sms-reminders/campaign-log', requireApiToken, async (req, res, next) => {
  try {
    const data = await logSmsCampaignResult(req.body ?? {});
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

app.post('/api/sms-reminders/reset-log', requireApiToken, async (req, res, next) => {
  try {
    const data = await resetSmsReminderLog(req.body ?? {});
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.get('/api/sms-templates', requireApiToken, async (req, res, next) => {
  try {
    const data = await getSmsTemplates(req.query);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.get('/api/sms-templates/init', requireApiToken, async (_req, res, next) => {
  try {
    const data = await initDefaultSmsTemplates();
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sms-templates', requireApiToken, async (req, res, next) => {
  try {
    const data = await addSmsTemplate(req.body ?? {});
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.put('/api/sms-templates', requireApiToken, async (req, res, next) => {
  try {
    const data = await saveSmsTemplate(req.body ?? {});
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/sms-templates', requireApiToken, async (req, res, next) => {
  try {
    const data = await deleteSmsTemplate(req.body ?? {});
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.get('/api/sms-settings', requireApiToken, async (_req, res, next) => {
  try {
    const data = await getSmsSettings();
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.put('/api/sms-settings', requireApiToken, async (req, res, next) => {
  try {
    const data = await saveSmsSetting(req.body ?? {});
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

app.get('/api/admin/appointments', requireApiToken, async (req, res, next) => {
  try {
    res.json({ ok: true, data: await listAdminAppointments(req.query) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/appointments/save', requireApiToken, async (req, res, next) => {
  try {
    res.json({ ok: true, data: await saveAdminAppointment(req.body ?? {}) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/appointments/delete', requireApiToken, async (req, res, next) => {
  try {
    res.json({ ok: true, data: await deleteAdminAppointment(req.body ?? {}) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/patients', requireApiToken, async (req, res, next) => {
  try {
    res.json({ ok: true, data: await listAdminPatients(req.query) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/patients/save', requireApiToken, async (req, res, next) => {
  try {
    res.json({ ok: true, data: await saveAdminPatient(req.body ?? {}) });
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

// Auto-create SMS template/settings tables and seed defaults on startup
ensurePatientPortalTables().then(() => ensureSmsTemplatesTable()).then(() => ensureSmsSettingsTable()).then(() => ensureSmsCampaignLogTable()).then(() => ensureSmsTreatmentLogTable()).then(() => initDefaultSmsTemplates()).then((init) => {
  if (init.initialized) {
    console.log(`SMS templates: seeded ${init.count} default templates.`);
  } else {
    console.log(`SMS templates: table ready (${init.reason}).`);
  }
}).catch((error) => {
  console.warn(`SMS templates init skipped: ${error.message}`);
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
