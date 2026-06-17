import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { pool, closePool } from './db.js';
import { requireApiToken } from './auth.js';
import { getChatbotModels, proxyChatbotCompletion } from './chatbotProxy.js';
import {
  listAuditPatients,
  listAuditTrailEntries,
  saveAuditTrailEntries
} from './auditTrail.js';
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
import {
  deleteAdminAccount,
  listAdminAccounts,
  loginAdminAccount,
  saveAdminAccount
} from './adminAuth.js';
import { createBooking, parseBookingBody } from './bookings.js';
import { sendBookingEmails } from './email.js';
import { saveBookingFiles } from './files.js';
import {
  deletePatientAccount,
  deleteMembershipPlan,
  ensurePatientPortalTables,
  cancelMembershipAutoRenewal,
  createMembershipCheckoutSession,
  createMembershipCustomerPortalSession,
  getPatientAccount,
  getPatientAccountPaymentDebug,
  getPatientAccountTreatments,
  handleStripeWebhook,
  linkPatientAccount,
  listMembershipPlans,
  listPatientAccounts,
  loginPatientAccount,
  parseMembershipPlanBody,
  parseMembershipPlanDeleteBody,
  parsePatientPortalAccountBody,
  parsePatientPortalCheckoutBody,
  parsePatientPortalCheckoutVerifyBody,
  parsePatientPortalCancelRenewalBody,
  parsePatientPortalCustomerPortalBody,
  parsePatientPortalPasswordChangeBody,
  parsePatientAccountLinkBody,
  parsePatientAccountDeleteBody,
  parsePatientAccountMembershipBody,
  parsePatientAccountPasswordBody,
  parsePatientAccountStatusBody,
  parsePatientLoginBody,
  parsePatientRegisterBody,
  registerPatientAccount,
  saveMembershipPlan,
  changePatientPortalPassword,
  updatePatientAccountMembership,
  updatePatientAccountPassword,
  updatePatientAccountStatus,
  verifyMembershipCheckoutSession
} from './patientPortal.js';
import { exportAppointmentReport, parseAppointmentReportBody } from './reports.js';
import {
  addSmsTemplate,
  deleteSmsTemplate,
  ensureSmsCampaignLogTable,
  ensureSmsPatientLogTable,
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
  getSmsPatientLogs,
  logSmsCampaignResult,
  logSmsPatientResult,
  logSmsRecallResult,
  logSmsReminderResult,
  logSmsTreatmentResult,
  resetSmsReminderLog,
  resetSmsPatientLog
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

function batchError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function batchId(value, index) {
  return String(value ?? `request-${index + 1}`)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || `request-${index + 1}`;
}

function batchSurface(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function smsStatusSummary(logs = []) {
  return logs.reduce((summary, log) => {
    const status = String(log.Status ?? log.status ?? '').trim().toLowerCase();
    if (['sent', 'success'].includes(status)) {
      summary.sent += 1;
    } else if (['failed', 'error'].includes(status)) {
      summary.failed += 1;
    } else if (['dry-run', 'dry_run', 'preview'].includes(status)) {
      summary.dryRun += 1;
    } else {
      summary.other += 1;
    }
    return summary;
  }, { sent: 0, failed: 0, dryRun: 0, other: 0 });
}

async function bridgeHealthPayload() {
  const [rows] = await pool.execute('SELECT 1 AS ok');
  const db = rows[0]?.ok === 1;
  return {
    ok: true,
    db,
    message: db ? 'Connected to Open Dental database' : 'Bridge responded, database status unclear'
  };
}

async function adminSummaryPayload(params = {}) {
  const dates = params.dates && typeof params.dates === 'object' ? params.dates : {};
  const today = String(dates.today ?? '').trim();
  const tomorrow = String(dates.tomorrow ?? '').trim();
  const eightDay = String(dates.eightDay ?? '').trim();
  const statuses = String(params.statuses ?? config.booking.busyAptStatuses.join(','));
  if (!today || !tomorrow || !eightDay) {
    throw batchError('summary dates are required.');
  }

  const [
    health,
    todayData,
    tomorrowData,
    eightDayData,
    logsData
  ] = await Promise.all([
    bridgeHealthPayload(),
    getSmsReminderAppointments({ date: today, statuses }),
    getSmsReminderAppointments({ date: tomorrow, statuses }),
    getSmsReminderAppointments({ date: eightDay, statuses }),
    getSmsReminderLogs({ limit: 100 })
  ]);
  const recentLogs = Array.isArray(logsData.logs) ? logsData.logs : [];

  return {
    bridge: health,
    dates: { today, tomorrow, eightDay },
    counts: {
      today: Array.isArray(todayData.appointments) ? todayData.appointments.length : 0,
      tomorrow: Array.isArray(tomorrowData.appointments) ? tomorrowData.appointments.length : 0,
      eightDay: Array.isArray(eightDayData.appointments) ? eightDayData.appointments.length : 0
    },
    smsStatus: smsStatusSummary(recentLogs),
    recentLogs: recentLogs.slice(0, 8)
  };
}

async function adminBatchPayload(surface, params = {}) {
  switch (surface) {
    case 'summary':
      return adminSummaryPayload(params);
    case 'schedule':
    case 'sms-targets':
      return listAdminAppointments({
        date: params.date,
        q: params.query ?? params.q ?? '',
        statuses: params.statuses ?? config.booking.busyAptStatuses.join(','),
        limit: params.limit ?? 300
      });
    case 'patient-appointments':
    case 'patientappointments':
      return listAdminAppointments({
        patNum: params.patNum,
        statuses: params.statuses ?? '0,1,2,3,4,5,6,7,8',
        limit: params.limit ?? 75
      });
    case 'patients':
      return listAdminPatients({
        q: params.query ?? params.q ?? '',
        limit: params.limit ?? 150
      });
    case 'accounts':
      return listPatientAccounts({
        q: params.q ?? '',
        limit: params.limit ?? 200
      });
    case 'treatments':
      return getPatientAccountTreatments({ accountId: params.accountId });
    case 'membership-plans':
    case 'membershipplans':
      return listMembershipPlans({ includeInactive: params.includeInactive ?? 1 });
    case 'sms-logs':
    case 'smslogs':
      return getSmsReminderLogs({ date: params.date, limit: params.limit ?? 100 });
    case 'admin-accounts':
    case 'adminaccounts':
      return listAdminAccounts();
    default:
      throw batchError(`Unsupported admin batch surface: ${surface}`);
  }
}

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

app.post('/api/admin/batch', requireApiToken, async (req, res, next) => {
  try {
    const requests = Array.isArray(req.body?.requests) ? req.body.requests.slice(0, 12) : [];
    if (!requests.length) {
      throw batchError('requests must be a non-empty array.');
    }
    const entries = await Promise.all(requests.map(async (request, index) => {
      const id = batchId(request?.id, index);
      const surface = batchSurface(request?.surface);
      const params = request?.params && typeof request.params === 'object' ? request.params : {};
      if (!surface) {
        return [id, { ok: false, surface, message: 'surface is required.' }];
      }
      try {
        return [id, {
          ok: true,
          surface,
          data: await adminBatchPayload(surface, params)
        }];
      } catch (error) {
        return [id, {
          ok: false,
          surface,
          message: error.message || 'Admin batch request failed.'
        }];
      }
    }));
    res.json({
      ok: true,
      data: {
        generatedAt: new Date().toISOString(),
        items: Object.fromEntries(entries)
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/auth/login', requireApiToken, async (req, res, next) => {
  try {
    res.json({ ok: true, data: await loginAdminAccount(req.body ?? {}) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/auth/accounts', requireApiToken, async (_req, res, next) => {
  try {
    res.json({ ok: true, data: await listAdminAccounts() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/auth/accounts/save', requireApiToken, async (req, res, next) => {
  try {
    res.json({ ok: true, data: await saveAdminAccount(req.body ?? {}) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/auth/accounts/delete', requireApiToken, async (req, res, next) => {
  try {
    res.json({ ok: true, data: await deleteAdminAccount(req.body ?? {}) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/reference', requireApiToken, async (_req, res, next) => {
  try {
    res.json({ ok: true, data: await getReferenceData() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/chatbot/v1/models', requireApiToken, async (_req, res, next) => {
  try {
    res.json(await getChatbotModels());
  } catch (error) {
    next(error);
  }
});

app.post('/api/chatbot/v1/chat/completions', requireApiToken, async (req, res, next) => {
  try {
    res.json(await proxyChatbotCompletion(req.body ?? {}));
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

app.get('/api/patient-portal/accounts/:accountId', requireApiToken, async (req, res, next) => {
  try {
    const data = await getPatientAccount({ accountId: req.params.accountId });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.get('/api/patient-portal/accounts/:accountId/treatments', requireApiToken, async (req, res, next) => {
  try {
    const data = await getPatientAccountTreatments({ accountId: req.params.accountId });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.get('/api/patient-portal/accounts/:accountId/payment-debug', requireApiToken, async (req, res, next) => {
  try {
    const data = await getPatientAccountPaymentDebug({ accountId: req.params.accountId });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/patient-portal/account', requireApiToken, async (req, res, next) => {
  try {
    const body = parsePatientPortalAccountBody(req.body ?? {});
    const data = await getPatientAccount(body);
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

app.post('/api/patient-portal/stripe/checkout-session/verify', requireApiToken, async (req, res, next) => {
  try {
    const body = parsePatientPortalCheckoutVerifyBody(req.body ?? {});
    const data = await verifyMembershipCheckoutSession(body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/patient-portal/stripe/customer-portal', requireApiToken, async (req, res, next) => {
  try {
    const body = parsePatientPortalCustomerPortalBody(req.body ?? {});
    const data = await createMembershipCustomerPortalSession(body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/patient-portal/membership/cancel-renewal', requireApiToken, async (req, res, next) => {
  try {
    const body = parsePatientPortalCancelRenewalBody(req.body ?? {});
    const data = await cancelMembershipAutoRenewal(body);
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

app.post('/api/patient-portal/accounts/delete', requireApiToken, async (req, res, next) => {
  try {
    const body = parsePatientAccountDeleteBody(req.body ?? {});
    const data = await deletePatientAccount(body);
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

app.post('/api/patient-portal/password/change', requireApiToken, async (req, res, next) => {
  try {
    const body = parsePatientPortalPasswordChangeBody(req.body ?? {});
    const data = await changePatientPortalPassword(body);
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

app.get('/api/sms-reminders/patient-logs', requireApiToken, async (req, res, next) => {
  try {
    const data = await getSmsPatientLogs(req.query);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sms-reminders/patient-log', requireApiToken, async (req, res, next) => {
  try {
    const data = await logSmsPatientResult(req.body ?? {});
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

app.post('/api/sms-reminders/reset-patient-log', requireApiToken, async (req, res, next) => {
  try {
    const data = await resetSmsPatientLog(req.body ?? {});
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

app.get('/api/audit-trail/patients', requireApiToken, async (req, res, next) => {
  try {
    res.json({ ok: true, data: await listAuditPatients(req.query) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/audit-trail/entries', requireApiToken, async (req, res, next) => {
  try {
    res.json({ ok: true, data: await listAuditTrailEntries(req.query) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/audit-trail/entries/save', requireApiToken, async (req, res, next) => {
  try {
    res.json({ ok: true, data: await saveAuditTrailEntries(req.body ?? {}) });
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
ensurePatientPortalTables().then(() => ensureSmsTemplatesTable()).then(() => ensureSmsSettingsTable()).then(() => ensureSmsCampaignLogTable()).then(() => ensureSmsTreatmentLogTable()).then(() => ensureSmsPatientLogTable()).then(() => initDefaultSmsTemplates()).then((init) => {
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
