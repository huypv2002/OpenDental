import nodemailer from 'nodemailer';
import { config } from './config.js';

let transporter;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function emailIsConfigured() {
  return Boolean(
    config.email.enabled &&
    config.email.smtp.host &&
    config.email.smtp.user &&
    config.email.smtp.password &&
    config.email.from
  );
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.email.smtp.host,
      port: config.email.smtp.port,
      secure: config.email.smtp.secure,
      auth: {
        user: config.email.smtp.user,
        pass: config.email.smtp.password
      }
    });
  }
  return transporter;
}

function appointmentLabel(booking) {
  const endText = booking.endsAt ? ` - ${booking.endsAt}` : '';
  return `${booking.date} ${booking.time}${endText}`;
}

function buildAdminEmail(booking, result) {
  const fullName = `${booking.firstName} ${booking.lastName}`.trim();
  const rows = [
    ['Name', fullName],
    ['Cell', booking.phone],
    ['Email', booking.email || ''],
    ['DOB', booking.birthdate === '0001-01-01' ? '' : booking.birthdate],
    ['Appointment', appointmentLabel(booking)],
    ['Patient #', result.patNum],
    ['Appointment #', result.aptNum],
    ['Note', booking.note || '']
  ];

  const text = [
    'New website booking received.',
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`)
  ].join('\n');

  const htmlRows = rows
    .map(([label, value]) => (
      `<tr><th align="left" style="padding:6px 12px 6px 0;">${escapeHtml(label)}</th><td style="padding:6px 0;">${escapeHtml(value)}</td></tr>`
    ))
    .join('');

  return {
    subject: `New website booking: ${fullName} - ${booking.date} ${booking.time}`,
    text,
    html: `<p>New website booking received.</p><table>${htmlRows}</table>`
  };
}

function buildCustomerEmail(booking) {
  const fullName = `${booking.firstName} ${booking.lastName}`.trim();
  const appointment = appointmentLabel(booking);
  const clinicName = config.email.clinicName;
  const text = [
    `Hi ${fullName},`,
    '',
    `We received your appointment request for ${appointment}.`,
    `${clinicName} will contact you if any additional information is needed.`,
    '',
    `Thank you,`,
    clinicName
  ].join('\n');

  const html = [
    `<p>Hi ${escapeHtml(fullName)},</p>`,
    `<p>We received your appointment request for <strong>${escapeHtml(appointment)}</strong>.</p>`,
    `<p>${escapeHtml(clinicName)} will contact you if any additional information is needed.</p>`,
    `<p>Thank you,<br>${escapeHtml(clinicName)}</p>`
  ].join('');

  return {
    subject: `${clinicName} appointment request received`,
    text,
    html
  };
}

export async function sendBookingEmails(booking, result) {
  if (!config.email.enabled) {
    return { enabled: false, sent: [] };
  }

  if (!emailIsConfigured()) {
    const error = new Error('SMTP email is enabled but SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and EMAIL_FROM are required.');
    error.status = 500;
    throw error;
  }

  const sent = [];
  const mailer = getTransporter();

  if (config.email.adminEmails.length) {
    const adminEmail = buildAdminEmail(booking, result);
    await mailer.sendMail({
      from: config.email.from,
      to: config.email.adminEmails,
      replyTo: booking.email || config.email.replyTo || undefined,
      ...adminEmail
    });
    sent.push('admin');
  }

  if (config.email.sendCustomerEmail && booking.email) {
    const customerEmail = buildCustomerEmail(booking);
    await mailer.sendMail({
      from: config.email.from,
      to: booking.email,
      replyTo: config.email.replyTo || undefined,
      ...customerEmail
    });
    sent.push('customer');
  }

  return { enabled: true, sent };
}
