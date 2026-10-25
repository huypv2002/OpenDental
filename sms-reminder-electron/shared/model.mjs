export const TABS = [
  "Dashboard",
  "Patient",
  "Monitoring",
  "Recall",
  "Treatment",
  "Review Google",
  "Holiday & Birthday",
  "Templates",
  "Settings",
  "Logs",
];
export const CATEGORIES = [
  "appointment",
  "recall",
  "treatment",
  "review_google",
  "holiday_birthday",
];
export const HOLIDAYS = [
  "New Year's Day",
  "Martin Luther King Jr. Day",
  "Valentine's Day",
  "Presidents' Day",
  "Easter",
  "Mother's Day",
  "Memorial Day",
  "Father's Day",
  "Independence Day",
  "Labor Day",
  "Halloween",
  "Veterans Day",
  "Thanksgiving",
  "Christmas",
  "New Year Promotion",
];
export const DEFAULTS = {
  bridge_url: "http://127.0.0.1:3008",
  api_token: "",
  clinic_name: "LUK Dental",
  clinic_phone: "281-760-1357",
  reminder_days_ahead: 1,
  scheduled_send_time: "11:00",
  appointment_statuses: [1],
  fallback_duration_minutes: 30,
  recall_months: 6,
  recall_codes: "D1110,D1120,D4341,D4342",
  treatment_days: 21,
  treatment_codes: "",
  treatment_statuses: "1",
  time_zone: "America/Chicago",
  workstation_mode: "auto",
  dry_run: false,
  scheduler_enabled: true,
};
export const digits = (value) => {
  const text = String(value ?? "").replace(/\D/g, "");
  return text.length === 11 && text.startsWith("1") ? text.slice(1) : text;
};
export function formatPhone(value) {
  const number = digits(value);
  return number.length === 10 ? `(${number.slice(0,3)}) ${number.slice(3,6)}-${number.slice(6)}` : String(value || "").trim();
}
export const patientName = (row) =>
  [row.FName, row.LName].filter(Boolean).join(" ").trim() ||
  `Patient #${row.PatNum || ""}`;
export function clinicClock(now = new Date(), zone = "America/Chicago") {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}
export const addDays = (day, days) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + Number(days) * 86400000)
    .toISOString()
    .slice(0, 10);
export const fd2Machine = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .startsWith("fd2");
export const isFD2 = (config, name) =>
  config.workstation_mode === "fd2" ||
  (config.workstation_mode === "auto" && fd2Machine(name));
export function phoneFor(row) {
  if (row._AllowManualPhoneTarget) return formatPhone(row.Phone || "");
  for (const value of [row.WirelessPhoneFormatted, row.WirelessPhone, row.PhoneTargets?.find((t) => /^wireless/i.test(t.source))?.phone])
    if (digits(value).length === 10) return formatPhone(value);
  return "";
}
export function offsetFor(row, today = clinicClock().date) {
  const explicit = row._ReminderOffsetDays ?? row.ReminderOffsetDays;
  if (explicit != null && Number.isFinite(Number(explicit)))
    return Math.max(0, Number(explicit));
  return row.AptDateTime
    ? Math.max(
        0,
        Math.round(
          (Date.parse(String(row.AptDateTime).slice(0, 10)) -
            Date.parse(today)) /
            86400000,
        ),
      )
    : 1;
}
export function reminderKey(row, today) {
  return [
    row.AptNum,
    String(row.ReminderForDate || row.AptDateTime).slice(0, 10),
    digits(row.Phone || phoneFor(row)),
    offsetFor(row, today),
  ].join("|");
}
export const blockedStatus = (status) =>
  ["sent", "dry-run", "needs-review", "needs review"].includes(status);
export function expandAppointments(rows, logs, today) {
  const map = new Map(logs.map((log) => [reminderKey(log, today), log]));
  return rows
    .filter(
      (r) =>
        ![r.OpName, r.OperatoryAbbrev].some(
          (v) =>
            String(v || "")
              .trim()
              .toUpperCase() === "RECALL",
        ),
    )
    .map((row) => {
      const r = {
        ...row,
        Phone: phoneFor(row),
        _ReminderOffsetDays: offsetFor(row, today),
      };
      const log = map.get(reminderKey(r, today));
      return {
        ...r,
        ReminderStatus: log?.Status || "",
        ReminderLastSentAt: log?.Status === "sent" ? log.SentAt || "" : "",
        ReminderSentAt: log?.SentAt || "",
        ReminderError: log?.ErrorMessage || "",
        ReminderSentCount: log?.Status === "sent" ? 1 : 0,
      };
    });
}
export function sixMonthRecallLanguage(key) {
  const suffix = /^6MRECALL(EN|US|ES|VI)$/.exec(String(key).toUpperCase().replace(/[\s_-]+/g, ""))?.[1];
  return suffix === "EN" ? "US" : suffix || "";
}
export function pickDailyRecallTemplate(library, row) {
  const language = pickTemplate({recall:{US:"",ES:"",VI:""}},row,"recall");
  // These are existing DB template keys, including the appointment category
  // used by the clinic. Never substitute an ordinary appointment/Recall message.
  for (const category of ["appointment", "recall"]) {
    const keys = Object.keys(library.templates?.[category] || {}).filter(k => sixMonthRecallLanguage(k) === language);
    if (keys.length > 1) throw new Error(`Multiple ${language} 6M RECALL templates in ${category}; select one unique DB template.`);
    if (keys.length === 1) {
      const key=keys[0];
      if (!library.templates[category][key]?.trim()) throw new Error(`Empty ${language} 6M RECALL template.`);
      return {category,key,language};
    }
  }
  throw new Error(`Missing ${language} 6M RECALL template in DB; daily Recall has not sent.`);
}
export function pickTemplate(templates, row, category = "appointment") {
  const keys = Object.keys(templates[category] || {}).filter(k => category !== "appointment" || !sixMonthRecallLanguage(k));
  const language = String(row.Language || "").toLowerCase();
  const prefix = /vietnam|tiếng việt|tieng viet|^(vi|vn|vie)$/.test(language)
    ? "VI"
    : /spanish|español|espanol|^(es|spa)$/.test(language)
      ? "ES"
      : "US";
  const campaign =
    category === "holiday_birthday"
      ? `${prefix}_${row._CampaignType === "birthday" ? "BIRTHDAY" : "HOLIDAY"}`
      : "";
  return (
    keys.find((k) => k.toUpperCase() === campaign) ||
    keys.find((k) => k.toUpperCase() === prefix) ||
    keys.sort().find((k) => k.toUpperCase().startsWith(`${prefix}_`) || k.toUpperCase().startsWith(`${prefix}-`)) ||
    keys.find((k) => k === "US") ||
    keys[0] ||
    ""
  );
}
export function hasAppointmentFields(text) {
  return /\{(date|date_full|date_short|weekday|weekday_vi|relative_day|relative_day_es|relative_day_vi|time|time_lower)\}/.test(
    text || "",
  );
}
export function formatDate(value, short = false) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[2]}/${match[3]}${short ? "" : `/${match[1]}`}` : "";
}
export function formatTime(value) {
  const m = String(value || "").match(/[T ](\d{2}):(\d{2})/);
  if (!m) return "";
  return `${Number(m[1]) % 12 || 12}:${m[2]} ${Number(m[1]) < 12 ? "AM" : "PM"}`;
}
export function renderMessage(
  config,
  row,
  template,
  today = clinicClock(undefined, config.time_zone).date,
) {
  const first = String(row.FName || "").trim() || "there";
  const last = String(row.LName || "").trim();
  const gender = String(row.Gender ?? "").toLowerCase();
  const male = ["0", "male", "m"].includes(gender),
    female = ["1", "female", "f"].includes(gender);
  const birth = String(row.Birthdate || "").slice(0, 10);
  let age = "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(birth))
    age =
      Number(today.slice(0, 4)) -
      Number(birth.slice(0, 4)) -
      (today.slice(5) < birth.slice(5) ? 1 : 0);
  const title =
    age !== "" && age <= 25
      ? "em"
      : age !== "" && age <= 45
        ? "bạn"
        : age !== "" && age <= 65
          ? male
            ? "anh"
            : female
              ? "chị"
              : "anh/chị"
          : male
            ? "chú"
            : female
              ? "cô"
              : "cô/chú";
  const country = String(row._TemplateCountry || row._TemplateKey || "US")
    .slice(0, 2)
    .toUpperCase();
  const apt = row.AptDateTime || "",
    day = String(apt).slice(0, 10);
  const weekdayIndex = /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? new Date(`${day}T12:00:00Z`).getUTCDay()
    : -1;
  const offset = offsetFor(row, today);
  const relative =
    offset === 0
      ? ["today", "de hoy", "hôm nay"]
      : offset === 1
        ? ["tomorrow", "de mañana", "ngày mai"]
        : [`in ${offset} days`, `en ${offset} días`, `${offset} ngày nữa`];
  const formal = male ? `Mr. ${first}` : female ? `Ms. ${first}` : first;
  const values = {
    clinic_name: config.clinic_name,
    clinic_phone: config.clinic_phone,
    review_link: config.review_link || "",
    holiday_name: row._HolidayName || row._CampaignName || "",
    campaign_name: row._CampaignName || "",
    user_name:
      row.Username ||
      row.UserName ||
      row.PortalUsername ||
      row.PortalUserName ||
      row.user_name ||
      row.Email ||
      "",
    email: row.Email || row.email || "",
    password: row.Password || row.PortalPassword || row._Password || "",
    first_name: first,
    last_name: last,
    patient_name: patientName(row),
    formal_first_name: formal,
    salutation: ["VI", "VN"].includes(country)
      ? `${title} ${first}`
      : male
        ? `Mr. ${last || first}`
        : female
          ? `Ms. ${last || first}`
          : first,
    vi_title: title,
    vi_title_cap: title.charAt(0).toUpperCase() + title.slice(1),
    vi_salutation: `${title} ${first}`,
    age: age || "",
    date: formatDate(apt),
    date_full: formatDate(apt),
    date_short: formatDate(apt, true),
    weekday:
      [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ][weekdayIndex] || "",
    weekday_vi:
      ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"][
        weekdayIndex
      ] || "",
    relative_day: relative[0],
    relative_day_es: relative[1],
    relative_day_vi: relative[2],
    time: formatTime(apt),
    time_lower: formatTime(apt).toLowerCase(),
    phone: row.Phone || phoneFor(row),
    apt_num: row.AptNum || "",
    pat_num: row.PatNum || "",
    last_proc_date: formatDate(row.LastProcDate || row.LastPendingProcDate),
    last_pending_proc_date: formatDate(
      row.LastPendingProcDate || row.LastProcDate,
    ),
    procedure_codes: row.ProcedureCodes || "",
    procedure_descriptions: row.ProcedureDescriptions || "",
  };
  return String(template || "")
    .replace(/\{\{/g, "\u0001")
    .replace(/\}\}/g, "\u0002")
    .replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (all, key) =>
      key in values ? String(values[key]) : all,
    )
    .replace(
      /\{(password|default|custom)_([^{}\n]+)\}/gi,
      (_, key, value) => value,
    )
    .replace(/\u0001/g, "{")
    .replace(/\u0002/g, "}");
}
export function matchesSearch(row, query) {
  if (/^#\d+$/.test(query.trim()))
    return String(row.PatNum) === query.trim().slice(1);
  return Object.entries(row)
    .filter(([k, v]) => !k.startsWith("_") && typeof v !== "object")
    .map(([, v]) => String(v ?? ""))
    .join(" ")
    .toLowerCase()
    .includes(query.toLowerCase());
}
export function logPayload(row, message, status, today, error = "") {
  const common = {
    patNum: Number(row.PatNum || 0),
    phone: phoneFor(row),
    message,
    status,
    errorMessage: error,
  };
  switch (row._Kind) {
    case "patient":
      return {
        path: "/api/sms-reminders/patient-log",
        body: { ...common, templateKey: row._TemplateKey },
      };
    case "recall":
      return {
        path: "/api/sms-reminders/recall-log",
        body: {
          ...common,
          procedureCodes: row.ProcedureCodes || "",
          lastProcDate: row.LastProcDate || "",
          ...(row._DispatchToken ? {dailyRecall: true, dispatchToken: row._DispatchToken} : {}),
        },
      };
    case "treatment":
      return {
        path: "/api/sms-reminders/treatment-log",
        body: {
          ...common,
          procedureCodes: row.ProcedureCodes || "",
          lastPendingProcDate:
            row.LastPendingProcDate || row.LastProcDate || "",
        },
      };
    case "holiday":
      return {
        path: "/api/sms-reminders/campaign-log",
        body: {
          ...common,
          campaignType: row._CampaignType,
          campaignName: row._CampaignName,
          templateKey: row._TemplateKey,
        },
      };
    default:
      return {
        path: "/api/sms-reminders/log",
        body: {
          ...common,
          aptNum: Number(row.AptNum),
          reminderForDate: String(row.AptDateTime).slice(0, 10),
          reminderOffsetDays: offsetFor(row, today),
        },
      };
  }
}
