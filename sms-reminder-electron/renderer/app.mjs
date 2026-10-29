import {
  TABS,
  CATEGORIES,
  HOLIDAYS,
  clinicClock,
  addDays,
  patientName,
  phoneFor,
  pickTemplate,
  renderMessage,
  formatDate,
  formatTime,
  matchesSearch,
  blockedStatus,
  hasAppointmentFields,
} from "../shared/model.mjs";
const $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function flag(country) {
  const file = { US: "us", VI: "vn", VN: "vn", ES: "es" }[String(country).toUpperCase()];
  return file ? `<img class="flag" src="../assets/flags/${file}.svg" alt="${escape(country)} flag">` : "";
}
function flagOptions(entries, selected) {
  return `<button type="button"><selectedcontent></selectedcontent></button>${entries.map(([key, country, label]) => `<option value="${escape(key)}" ${key === selected ? "selected" : ""}>${flag(country)}<span>${escape(label || key)}</span></option>`).join("")}`;
}
const S = {
  config: {},
  status: {},
  library: { templates: {}, countries: {}, settings: {} },
  tab: "dashboard",
  rows: {},
  selection: {},
  filters: {},
  templates: {},
  columns: {},
  seq: {},
  activity: [],
  offset: 0,
  hasMore: false,
  batch: [],
  batchCategory: "",
  batchIndex: 0,
  loading: {},
  loadErrors: {},
  loadedQueries: {},
};
const kinds = [
  "dashboard",
  "patient",
  "monitoring",
  "recall",
  "treatment",
  "review",
  "holiday",
  "templates",
  "settings",
  "logs",
];
const categoryFor = (kind) =>
  ({
    dashboard: "appointment",
    patient: "appointment",
    recall: "recall",
    treatment: "treatment",
    review: "review_google",
    holiday: "holiday_birthday",
  })[kind] || "appointment";
const today = () =>
  clinicClock(new Date(), S.config.time_zone || "America/Chicago").date;
const rowID = (row) =>
  `${row.AptNum || ""}:${row.PatNum || ""}:${row._CustomId || ""}:${phoneFor(row)}`;
let toastTimer, modalResolve;
const modalStack = [];
async function api(action, payload = {}) {
  const response = await window.sms.call(action, payload);
  if (!response.ok) throw new Error(response.error);
  return response.data;
}
function toast(message, error = false) {
  $("toast").textContent = message;
  $("toast").classList.toggle("error", error);
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => ($("toast").hidden = true),
    error ? 9000 : 5000,
  );
  $("status-text").textContent = message;
}
function handle(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      toast(error.message, true);
    }
  };
}
function on(id, fn, event = "click") {
  $(id)?.addEventListener(event, handle(fn));
}
function btn(id, text, primary = false, extra = "") {
  return `<button id="${id}" class="${primary ? "primary" : ""}" ${extra}>${text}</button>`;
}
function hero(eyebrow, title, subtitle, badge = false) {
  return `<div class="hero"><div class="grow"><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${subtitle}</p></div>${badge ? '<span id="send-badge" class="badge">REAL SMS</span>' : ""}</div>`;
}
function tableShell(kind) {
  return `<div class="card table-card"><div class="table-scroll" id="scroll-${kind}" tabindex="0"><table id="table-${kind}"></table><div class="loading" id="loading-${kind}" hidden>Loading…</div></div><div class="table-footer"><span id="count-${kind}" class="grow">0 rows</span>${kind === "patient" || kind === "holiday" || kind === "review" ? btn(`more-${kind}`, "Load more", false, "hidden") : ""}</div></div>`;
}
function search(kind, placeholder = "Patient, phone, email, patient #…") {
  return `<div class="card search"><label for="search-${kind}">Search</label><input type="search" id="search-${kind}" placeholder="${placeholder}"></div>`;
}
function genericActions(kind, refresh, label = "Fill selected draft") {
  return `${btn(`refresh-${kind}`, refresh)}${btn(`templates-${kind}`, `${kind === "holiday" ? "Campaign" : kind === "review" ? "Review" : kind[0].toUpperCase() + kind.slice(1)} templates`)}<span class="grow"></span>${btn(`preview-${kind}`, "Preview selected")}${btn(`compose-${kind}`, label, true, "data-send")}`;
}
function build() {
  $("tabs").innerHTML = TABS.map(
    (label, i) =>
      `<button data-tab="${kinds[i]}" class="${i === 0 ? "active" : ""}">${label}</button>`,
  ).join("");
  const pages = {
    dashboard: `${hero("LUK DENTAL", "SMS appointment reminders", "Review tomorrow's Open Dental appointments from the bridge, send reminder texts, and keep an audit log.", true)}<div class="banner" id="draft-banner" hidden></div><div class="stats">${["Appointments loaded", "Pending reminders", "Already sent", "Missing phone"].map((v, i) => `<div class="stat"><b id="stat-${i}">0</b><span>${v}</span></div>`).join("")}</div><div class="card toolbar"><label for="appointment-date">Reminder date</label><input id="appointment-date" type="date">${btn("refresh-dashboard", "Load appointments")}${btn("preview-dashboard", "Preview selected")}<span class="grow"></span>${btn("open-phone", "Open Phone Link")}${btn("test-sms", "Send test SMS", false, "data-send")}${btn("clear-dry-run", "Clear dry-run")}${btn("reset-dashboard", "Reset not sent")}${btn("mark-dashboard", "Mark sent")}${btn("test-dashboard", "Test selected (no send)", false, "data-send")}${btn("send-dashboard", "Send selected", true, "data-send")}${btn("send-all", "Send all not sent", true, "data-send")}</div>${search("dashboard", "Patient, phone, email, appointment #…")}${tableShell("dashboard")}`,
    patient: `${hero("PATIENT SMS", "Manual patient messages", "Search any patient, choose a template, then fill a draft in Phone Link for staff to send.")}<div class="card toolbar"><label for="search-patient">Patient search</label><input type="search" id="search-patient" class="grow" placeholder="Patient, phone, email, #patient number…">${btn("refresh-patient", "Search")}${btn("preview-patient", "Preview selected")}${btn("test-patient", "Test selected (no send)", false, "data-send")}${btn("fd2-patient", "Create FD2 draft", false, "data-send")}${btn("compose-patient", "Fill selected draft", true, "data-send")}</div>${tableShell("patient")}`,
    monitoring: `${hero("DAILY AUTOMATION", "SMS monitoring", "One daily schedule sends Appointment reminders and 6-month Recall for D1110 / D4341 / D4342, using patient-language DB templates.")}<div class="two-col"><div class="card"><h2 class="section-title">Daily Appointment + 6-month Recall monitoring</h2><div class="monitor-row"><span>Status</span><span class="monitor-state" id="monitor-state">Stopped</span><span>Workstation</span><span id="monitor-machine"></span><span>Reminder dates</span><span id="monitor-dates"></span><span>Send time</span><span id="monitor-time"></span><span>Behavior</span><span class="muted">Send pending reminders sequentially within 30 minutes after the configured time. Sent and needs-review records are skipped.</span></div><div class="toolbar">${btn("stop-monitoring", "Stop Monitoring")}${btn("start-monitoring", "Start Monitoring", true)}${btn("sync-logs", "Sync pending logs")}</div><div class="info" style="margin-top:16px">Stop finishes the current SMS operation and prevents the next patient from starting. Windows must remain signed in, paired with Phone Link, and unlocked while sending.</div></div><div class="card"><h2 class="section-title">Windows scheduler</h2><div class="scheduler-grid"><label>Enable auto-login<input type="time" id="scheduler-enable" value="08:59"></label><label>Restart Windows<input type="time" id="scheduler-restart" value="09:00"></label><label>Open tool<input type="time" id="scheduler-start" value="10:55"></label><label>Lock Windows<input type="time" id="scheduler-lock" value="12:05"></label></div><p class="muted">Task times follow the Windows time zone. Disable the old Python scheduler before enabling Electron tasks.</p><div class="toolbar">${btn("reload-scheduler-times", "Reload BAT times")}${btn("save-scheduler-times", "Save BAT times")}${btn("scheduler-off", "Disable scheduler")}<label><input type="checkbox" id="scheduler-auto-monitor" checked> Auto start Appointment + 6M Recall monitoring</label>${btn("scheduler-on", "Set up Windows scheduler", true)}</div></div></div><div class="card grow"><h2 class="section-title">Activity</h2><div id="activity" class="activity">Ready.</div></div>`,
    recall: `${hero("RECALL SMS", "Recall follow-up", "Find patients due for recall, preview a template and fill drafts one by one.")}<div class="card toolbar"><label>Recall after</label><input type="number" id="recall-months" min="1" max="60"><span>months</span><label>Procedure codes</label><input id="recall-codes" style="width:230px">${genericActions("recall", "Refresh recall list", "Fill selected template")}</div>${search("recall", "Patient, phone, email, code, patient #…")}${tableShell("recall")}`,
    treatment: `${hero("TREATMENT", "Pending treatment SMS", "Find planned procedures before the miss window, with no future appointment.")}<div class="card"><div class="toolbar"><label>Procedure date before</label><input type="number" id="treatment-days" min="0" max="365"><span>days</span><label>Procedure codes</label><input id="treatment-codes" class="grow" placeholder="Optional, e.g. D3310,D2392. Blank = all planned codes"><label>Proc status</label><input id="treatment-statuses" style="width:80px"></div><div class="toolbar">${genericActions("treatment", "Refresh treatment list")}</div></div>${search("treatment", "Patient, phone, email, pending code, patient #…")}${tableShell("treatment")}`,
    review: `${hero("GOOGLE REVIEW", "Google review requests", "Fill a review request in Phone Link. Review messages are manual and excluded from monitoring.")}<div class="card"><div class="toolbar"><label>Review link</label><input id="review-link" class="grow" placeholder="Google review URL">${btn("save-review-link", "Save review link")}</div><div class="toolbar"><input type="search" id="search-review" class="grow" placeholder="Patient, phone, email, #patient number…">${genericActions("review", "Refresh patients", "Fill selected template")}</div></div>${tableShell("review")}`,
    holiday: `${hero("HOLIDAY & BIRTHDAY", "Holiday promotion and birthday SMS", "Build a custom patient list, review the message, then fill drafts for manual sending.")}<div class="card"><div class="toolbar"><label>Campaign</label><select id="campaign-type"><option value="holiday">Holiday promotion</option><option value="birthday">Birthday</option></select><label>Holiday</label><select id="holiday-event"></select>${btn("add-holiday", "Add holiday")}${btn("edit-holiday", "Edit holiday")}${btn("delete-holiday", "Delete holiday")}</div><div class="toolbar"><label>Send date</label><input id="birthday-date" type="date"><label>Patient filter</label><input type="search" id="search-holiday" class="grow" placeholder="Patient, phone, email, #patient number…">${btn("refresh-holiday", "Refresh patients")}</div><div class="toolbar">${btn("add-custom", "Add custom")}${btn("edit-custom", "Edit selected")}${btn("remove-holiday", "Remove selected")}${btn("templates-holiday", "Templates")}<span class="grow"></span>${btn("preview-holiday", "Preview selected")}${btn("compose-holiday", "Fill selected draft", true, "data-send")}${btn("compose-all-holiday", "Fill all in list", false, "data-send")}</div></div>${tableShell("holiday")}`,
    templates: `${hero("MESSAGE LIBRARY", "SMS templates", "Manage shared country/language templates. Each patient can choose a template before sending.")}<div class="card template-card"><div class="form"><label>Category</label><select id="template-category">${CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join("")}</select><label>Edit template</label><select id="template-select"></select><label>Template key</label><input id="template-key"><label>Country flag</label><select id="template-country"><option value="US">US — English</option><option value="VI">VI — Vietnamese</option><option value="ES">ES — Spanish</option></select><label>Default template</label><input value="US" disabled><label>Message</label><textarea id="template-text"></textarea></div><p class="template-helper">Placeholders: {formal_first_name}, {salutation}, {vi_title}, {vi_salutation}, {first_name}, {last_name}, {patient_name}, {user_name}, {email}, {password}, {age}, {relative_day}, {relative_day_es}, {relative_day_vi}, {weekday}, {weekday_vi}, {date}, {date_full}, {date_short}, {time}, {time_lower}, {clinic_name}, {clinic_phone}, {phone}, {apt_num}, {pat_num}, {review_link}, {holiday_name}, {procedure_codes}, {last_proc_date}. Custom defaults: {custom_your text}.</p><div class="settings-actions">${btn("reload-templates", "Reload from Bridge")}${btn("seed-templates", "Seed defaults")}${btn("new-template", "New template")}${btn("delete-template", "Delete template")}${btn("add-template", "Add template")}${btn("save-template", "Save template", true)}</div></div>`,
    settings: `${hero("WORKSTATION SETTINGS", "Settings", "Configure this workstation. Templates and the review link remain shared on the Bridge.")}<div class="two-col"><div class="card"><h2 class="section-title">Bridge connection</h2><div class="form"><label>Bridge URL</label><input id="setting-bridge_url" placeholder="http://SERVER:3008"><label>API token</label><input id="setting-api_token" type="password" autocomplete="off" placeholder="Enter Bridge API token"><label>Clinic name</label><input id="setting-clinic_name"><label>Clinic phone</label><input id="setting-clinic_phone"><label>Google review link</label><input id="setting-review-link"></div><div class="settings-actions">${btn("import-config", "Import config")}${btn("test-bridge", "Test bridge connection")}</div></div><div class="card"><h2 class="section-title">Reminder schedule</h2><div class="form"><label>Days ahead</label><input id="setting-reminder_days_ahead" type="number" min="0" max="30"><label>Send time</label><input id="setting-scheduled_send_time" type="time"><label>Clinic time zone</label><input id="setting-time_zone" placeholder="America/Chicago"><label>Appointment statuses</label><input id="setting-appointment_statuses" placeholder="1"><label>Fallback duration</label><input id="setting-fallback_duration_minutes" type="number" min="5" max="240"><label>Workstation mode</label><select id="setting-workstation_mode"><option value="auto">Auto-detect R5 / FD2</option><option value="r5">R5 — automated reminders</option><option value="fd2">FD2 — manual drafts</option></select><label>Send mode</label><span>REAL SMS. Use “Test selected (no send)” to prepare a draft.</span></div></div></div><div class="card"><div class="toolbar"><span id="data-location" class="muted grow"></span>${btn("check-updates", "Check for updates")}${btn("open-data", "Open settings folder")}${btn("snapshot", "Phone Link UI snapshot")}${btn("save-settings", "Save settings", true)}</div></div>`,
    logs: `${hero("SMS HISTORY", "Reminder logs", "Shared Bridge records for appointment reminders. Patient history combines all SMS categories.")}<div class="card toolbar">${btn("refresh-logs", "Refresh logs")}${btn("sync-logs-tab", "Sync pending logs")}<span class="grow"></span><input id="search-logs" class="grow" type="search" placeholder="Status, phone, appointment, patient #…"></div>${tableShell("logs")}`,
  };
  $("pages").innerHTML = kinds
    .map(
      (kind) =>
        `<section id="page-${kind}" class="page" ${kind === "dashboard" ? "" : "hidden"}>${pages[kind]}</section>`,
    )
    .join("");
  $("tabs").addEventListener(
    "click",
    handle((event) => {
      const button = event.target.closest("[data-tab]");
      if (button) activate(button.dataset.tab);
    }),
  );
  for (const kind of [
    "dashboard",
    "patient",
    "recall",
    "treatment",
    "review",
    "holiday",
    "logs",
  ]) {
    S.rows[kind] = [];
    S.selection[kind] = new Set();
    S.filters[kind] = "";
    S.templates[kind] = new Map();
    let scheduled = false;
    $(`scroll-${kind}`).addEventListener("scroll", () => {
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(() => {
          renderTable(kind);
          scheduled = false;
        });
      }
    });
    $(`table-${kind}`).addEventListener(
      "click",
      handle((event) => tableClick(kind, event)),
    );
    $(`table-${kind}`).addEventListener(
      "change",
      handle((event) => tableChange(kind, event)),
    );
    $(`table-${kind}`).addEventListener("pointerdown", (event) =>
      resizeColumn(kind, event),
    );
    on(`refresh-${kind}`, () => load(kind));
    on(`search-${kind}`, () => load(kind), "search");
    $(`search-${kind}`)?.addEventListener("keydown", event => { if (event.key === "Enter") handle(() => load(kind))(); });
    let debounce;
    on(
      `search-${kind}`,
      () => {
        clearTimeout(debounce);
        debounce = setTimeout(
          handle(() => {
            if (["patient", "review", "holiday"].includes(kind)) {
              if (kind === "holiday" && $("campaign-type").value === "birthday") { S.filters.holiday = $("search-holiday").value; renderTable("holiday"); return; }
              return load(kind);
            }
            S.filters[kind] = $(`search-${kind}`).value;
            $(`scroll-${kind}`).scrollTop = 0;
            renderTable(kind);
          }),
          kind === "patient" ? 420 : 180,
        );
      },
      "input",
    );
    on(`more-${kind}`, () => load(kind, true));
    on(`preview-${kind}`, () => preview(kind));
    on(`templates-${kind}`, () => openTemplateManager(kind));
    on(`compose-${kind}`, () => draftBatch(kind));
    renderTable(kind);
  }
}
function activate(kind) {
  S.tab = kind;
  for (const page of document.querySelectorAll(".page"))
    page.hidden = page.id !== `page-${kind}`;
  for (const button of $("tabs").children)
    button.classList.toggle("active", button.dataset.tab === kind);
  if (
    ["recall", "treatment", "review", "holiday", "logs"].includes(kind) &&
    !S.rows[kind].length &&
    !S.loading[kind] &&
    (S.config.api_token_present || S.status.demo)
  )
    load(kind).catch((e) => toast(e.message, true));
  if (kind === "monitoring") renderActivity();
}
function columnDefinitions(kind) {
  const cols = {
    dashboard: [
      ["Status", "apt-status", 110],
      ["Time", "time", 100],
      ["Patient", "name", 170],
      ["Phone", "phone", 180],
      ["Email", "Email", 170],
      ["Apt #", "AptNum", 75],
      ["Pat #", "PatNum", 75],
      ["Reminder", "ReminderStatus", 100],
      ["Sent", "ReminderSentCount", 55],
      ["Last sent", "ReminderLastSentAt", 135],
      ["Template", "template", 200],
      ["View", "view", 75],
    ],
    patient: [
      ["Patient", "name", 230],
      ["Phone", "phone", 230],
      ["Email", "Email", 260],
      ["Pat #", "PatNum", 80],
      ["Template", "template", 250],
      ["Logs", "history", 85],
      ["View", "view", 85],
    ],
    recall: [
      ["Last code visit", "LastProcDate", 125],
      ["Patient", "name", 190],
      ["Phone", "phone", 180],
      ["Email", "Email", 180],
      ["Language", "Language", 100],
      ["Codes", "ProcedureCodes", 140],
      ["Sent", "RecallSentCount", 65],
      ["Last sent", "LastRecallSentAt", 135],
      ["Pat #", "PatNum", 75],
      ["Template", "template", 200],
      ["Logs", "history", 80],
      ["View", "view", 75],
    ],
    treatment: [
      ["Procedure date", "LastPendingProcDate", 130],
      ["Patient", "name", 180],
      ["Phone", "phone", 180],
      ["Email", "Email", 180],
      ["Language", "Language", 100],
      ["Pending codes", "ProcedureCodes", 160],
      ["Sent", "TreatmentSentCount", 65],
      ["Last sent", "LastTreatmentSentAt", 135],
      ["Pat #", "PatNum", 75],
      ["Template", "template", 220],
      ["View", "view", 75],
    ],
    review: [
      ["Patient", "name", 220],
      ["Phone", "phone", 220],
      ["Email", "Email", 250],
      ["Language", "Language", 100],
      ["Last visit", "LastAppointment", 130],
      ["Pat #", "PatNum", 75],
      ["Template", "template", 240],
      ["View", "view", 85],
    ],
    holiday: [
      ["Patient", "name", 210],
      ["Phone", "phone", 200],
      ["Email", "Email", 220],
      ["Language", "Language", 100],
      ["Birthdate", "Birthdate", 110],
      ["Pat #", "PatNum", 75],
      ["Campaign", "_CampaignName", 160],
      ["Template", "template", 220],
      ["View", "view", 85],
    ],
    logs: [
      ["ID", "ReminderLogNum", 75],
      ["Apt #", "AptNum", 85],
      ["Pat #", "PatNum", 85],
      ["Phone", "Phone", 190],
      ["Date", "ReminderForDate", 135],
      ["Status", "Status", 130],
      ["Sent at", "SentAt", 180],
      ["Error", "ErrorMessage", 460],
    ],
  };
  return cols[kind];
}
function visibleRows(kind) {
  return S.rows[kind].filter((r) => matchesSearch(r, S.filters[kind] || ""));
}
function prepared(kind, row) {
  const category = categoryFor(kind),
    key =
      S.templates[kind].get(rowID(row)) ||
      pickTemplate(S.library.templates, row, category);
  return {
    ...row,
    Phone: row._AllowManualPhoneTarget ? phoneFor(row) : phoneFor(row) ? `Wireless: ${phoneFor(row)}` : "",
    _TemplateKey: key,
    _TemplateText: S.library.templates[category]?.[key] || "",
    _TemplateCountry: S.library.countries[category]?.[key] || key.slice(0, 2),
    ...(kind === "dashboard" ? {} : { _Kind: kind }),
  };
}
function selected(kind) {
  return visibleRows(kind)
    .filter((row) => S.selection[kind].has(rowID(row)))
    .map((row) => prepared(kind, row));
}
function cell(kind, row, key) {
  if (key === "name") return escape(patientName(row));
  if (key === "phone") return escape(phoneFor(row) ? row._AllowManualPhoneTarget ? phoneFor(row) : `Wireless: ${phoneFor(row)}` : "Wireless missing");
  if (key === "time") return escape(formatTime(row.AptDateTime));
  if (key === "apt-status")
    return escape(
      {
        1: "Scheduled",
        2: "Complete",
        3: "UnschedList",
        4: "ASAP",
        5: "Broken",
        6: "Planned",
        7: "PtNote",
        8: "PtNoteCompleted",
      }[row.AptStatus] ||
        row.AptStatus ||
        "",
    );
  if (key === "status" || key === "ReminderStatus") {
    const status = row.ReminderStatus || "not sent";
    return `<span class="tag ${status === "sent" ? "sent" : blockedStatus(status) ? "review" : status === "failed" ? "failed" : ""}">${escape(status)}</span>`;
  }
  if (key === "template") {
    const category = categoryFor(kind),
      current = prepared(kind, row)._TemplateKey;
    return `<select class="row-template flag-select" data-template aria-label="Patient template">${flagOptions(Object.keys(S.library.templates[category] || {}).map(k => [k, S.library.countries[category]?.[k] || k.slice(0, 2), ({US:"US - English",VI:"Vietnamese",ES:"Spanish"})[k] || k]), current)}</select>`;
  }
  if (key === "view" || key === "history")
    return `<button class="small" data-row-action="${key}">${key === "view" ? "View" : "Logs"}</button>`;
  const value = row[key] ?? "";
  return escape(/(Date|Birthdate|Appointment)$/.test(key) ? formatDate(value) : value);
}
function renderTable(kind) {
  const scroll = $(`scroll-${kind}`),
    table = $(`table-${kind}`),
    rows = visibleRows(kind),
    cols = columnDefinitions(kind),
    widths = S.columns[kind] || {};
  const start = Math.max(0, Math.floor((scroll.scrollTop - 38) / 38) - 8),
    count = Math.ceil((scroll.clientHeight || 500) / 38) + 16,
    end = Math.min(rows.length, start + count);
  const allSelected =
    rows.length > 0 && rows.every((r) => S.selection[kind].has(rowID(r)));
  const totalWidth =
    42 + cols.reduce((total, c, i) => total + Number(widths[i] || c[2]), 0);
  table.style.minWidth = `${totalWidth}px`;
  table.innerHTML = `<colgroup><col style="width:42px">${cols.map((c, i) => `<col style="width:${Number(widths[i] || c[2])}px">`).join("")}</colgroup><thead><tr><th><input type="checkbox" data-all ${allSelected ? "checked" : ""} aria-label="Select all visible rows"></th>${cols.map((c, i) => `<th>${c[0]}<span class="resize" data-column="${i}"></span></th>`).join("")}</tr></thead><tbody>${start > 0 ? `<tr class="viewport-spacer"><td colspan="${cols.length + 1}" style="height:${start * 38}px"></td></tr>` : ""}${rows
    .slice(start, end)
    .map(
      (row, i) =>
        `<tr data-row="${start + i}" class="${S.selection[kind].has(rowID(row)) ? "selected" : ""}"><td><input type="checkbox" data-select ${S.selection[kind].has(rowID(row)) ? "checked" : ""} aria-label="Select ${escape(patientName(row))}"></td>${cols.map(([, key]) => `<td title="${escape(key === "name" ? patientName(row) : key === "phone" ? phoneFor(row) : row[key] || "")}">${cell(kind, row, key)}</td>`).join("")}</tr>`,
    )
    .join(
      "",
    )}${end < rows.length ? `<tr class="viewport-spacer"><td colspan="${cols.length + 1}" style="height:${(rows.length - end) * 38}px"></td></tr>` : ""}</tbody>`;
  if (!rows.length)
    table.querySelector("tbody").innerHTML =
      `<tr><td colspan="${cols.length + 1}" class="empty">${S.loading[kind] ? "Loading…" : S.loadErrors[kind] ? `Search failed: ${escape(S.loadErrors[kind])}` : kind === "patient" ? S.loadedQueries[kind] ? `SERVER returned no patient matching ${escape(S.loadedQueries[kind])}. Check the Patient Number and Bridge connection in Settings.` : "Search for a patient to load results." : "No records loaded. Refresh the list or check Bridge settings."}</td></tr>`;
  $(`count-${kind}`).textContent =
    `${rows.length} row${rows.length === 1 ? "" : "s"} · ${selected(kind).length} selected${S.loading[kind] ? " · Loading…" : ""}`;
  if (kind === "dashboard") {
    const values = [
      rows.length,
      rows.filter((r) => !blockedStatus(r.ReminderStatus)).length,
      rows.filter((r) => r.ReminderStatus === "sent").length,
      rows.filter((r) => !phoneFor(r)).length,
    ];
    values.forEach((value, i) => ($(`stat-${i}`).textContent = value));
  }
}
async function tableClick(kind, event) {
  const tr = event.target.closest("[data-row]");
  if (!tr) return;
  const row = visibleRows(kind)[Number(tr.dataset.row)];
  if (!row) return;
  const action = event.target.closest("[data-row-action]")?.dataset.rowAction;
  if (action === "view")
    return api("native", {
      action: "view-patient",
      patient: {
        FName: row.FName,
        LName: row.LName,
        Birthdate: row.Birthdate,
        PatNum: row.PatNum,
      },
    });
  if (action === "history") return history(row);
  if (event.target.closest("input,select,button")) return;
  const id = rowID(row);
  if (!(event.ctrlKey || event.metaKey || event.shiftKey))
    S.selection[kind].clear();
  S.selection[kind].add(id);
  renderTable(kind);
}
function tableChange(kind, event) {
  if (event.target.matches("[data-all]")) {
    for (const row of visibleRows(kind)) {
      event.target.checked
        ? S.selection[kind].add(rowID(row))
        : S.selection[kind].delete(rowID(row));
    }
    renderTable(kind);
    return;
  }
  const tr = event.target.closest("[data-row]"),
    row = visibleRows(kind)[Number(tr?.dataset.row)];
  if (!row) return;
  if (event.target.matches("[data-select]")) {
    event.target.checked
      ? S.selection[kind].add(rowID(row))
      : S.selection[kind].delete(rowID(row));
    renderTable(kind);
  }
  if (event.target.matches("[data-template]"))
    S.templates[kind].set(rowID(row), event.target.value);
}
function resizeColumn(kind, event) {
  const grip = event.target.closest("[data-column]");
  if (!grip) return;
  const column = Number(grip.dataset.column),
    start = event.clientX,
    width = grip.parentElement.offsetWidth;
  event.preventDefault();
  const widths = (S.columns[kind] ||= {});
  const move = (e) => {
    widths[column] = Math.max(60, width + e.clientX - start);
    renderTable(kind);
  };
  const up = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    api("columns", { kind, widths }).catch((e) => toast(e.message, true));
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up, { once: true });
}
async function load(kind, append = false) {
  if (kind === "monitoring" || kind === "settings" || kind === "templates")
    return;
  const seq = (S.seq[kind] = (S.seq[kind] || 0) + 1);
  S.loading[kind] = true;
  S.loadErrors[kind] = "";
  $(`loading-${kind}`).hidden = false;
  renderTable(kind);
  const options = {};
  if (kind === "dashboard") options.date = $("appointment-date").value;
  if (kind === "recall")
    Object.assign(options, {
      months: Number($("recall-months").value),
      codes: $("recall-codes").value,
    });
  if (kind === "treatment")
    Object.assign(options, {
      days: Number($("treatment-days").value),
      codes: $("treatment-codes").value,
      statuses: $("treatment-statuses").value,
    });
  if (["patient", "review", "holiday"].includes(kind))
    Object.assign(options, {
      query: $(`search-${kind}`).value,
      offset: append ? S.rows[kind].filter(r => !r._CustomId).length : 0,
    });
  if (kind === "holiday")
    Object.assign(options, {
      type: $("campaign-type").value,
      date: $("birthday-date").value,
      event: $("holiday-event").value,
    });
  try {
    if (["recall", "treatment"].includes(kind)) {
      const filters = kind === "recall" ? {recall_months:options.months,recall_codes:options.codes || "D1110,D1120,D4341,D4342"} : {treatment_days:options.days,treatment_codes:options.codes,treatment_statuses:options.statuses || "1"};
      S.config = await api("save-filters", filters);
      if (kind === "recall") options.codes=filters.recall_codes;
      else options.statuses=filters.treatment_statuses;
    }
    const result = await api("load", { kind, options });
    if (seq !== S.seq[kind]) return;
    const custom =
      kind === "holiday" ? S.rows.holiday.filter((r) => r._CustomId).map(r => ({ ...r, _CampaignType:options.type, _CampaignName:options.type === "birthday" ? formatDate(options.date) : options.event, _HolidayName:options.type === "birthday" ? formatDate(options.date) : options.event })) : [];
    S.loadedQueries[kind] = String(options.query || "").trim();
    S.rows[kind] = append
      ? [...S.rows[kind], ...result.rows]
      : [...result.rows, ...custom];
    if (!append) S.selection[kind].clear();
    const more = $(`more-${kind}`);
    if (more) more.hidden = !result.hasMore;
    $("status-text").textContent =
      `Loaded ${S.rows[kind].length} ${kind} records.`;
  } catch(error){
    if(seq === S.seq[kind]){S.loadErrors[kind]=error.message;S.rows[kind]=[];}
    throw error;
  } finally {
    if (seq === S.seq[kind]) {
      S.loading[kind] = false;
      $(`loading-${kind}`).hidden = true;
      renderTable(kind);
    }
  }
}
function modal(html) {
  if ($("modal").open) {
    const content = document.createDocumentFragment();
    while ($("modal-content").firstChild) content.append($("modal-content").firstChild);
    modalStack.push({ content, resolve: modalResolve });
    $("modal").close();
  }
  $("modal-content").innerHTML = html;
  $("modal").showModal();
  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}
function closeModal(value) {
  $("modal").close();
  const resolve = modalResolve;
  modalResolve = null;
  resolve?.(value);
  const parent = modalStack.pop();
  if (parent) {
    $("modal-content").replaceChildren(parent.content);
    modalResolve = parent.resolve;
    $("modal").showModal();
  }
}
$("modal").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeModal(null);
});
$("modal").addEventListener("click", (event) => {
  const button = event.target.closest("[data-modal-result]");
  if (button) closeModal(button.dataset.modalResult);
});
async function question(title, text, accept = "Continue") {
  return (
    (await modal(
      `<h2>${escape(title)}</h2><p>${escape(text)}</p><div class="actions"><button data-modal-result="cancel">Cancel</button><button class="primary" data-modal-result="yes">${escape(accept)}</button></div>`,
    )) === "yes"
  );
}
async function preview(kind) {
  const rows = selected(kind);
  if (!rows.length) throw new Error("Select a patient first.");
  const row = rows[0],
    message = renderMessage(
      { ...S.config, review_link: S.library.settings.review_link },
      row,
      row._TemplateText,
      today(),
    );
  await modal(
    `<h2>SMS preview</h2><p>${escape(patientName(row))} · ${escape(phoneFor(row))}<br>Template: ${flag(row._TemplateCountry)}${escape(row._TemplateKey)}</p>${!row.AptDateTime && hasAppointmentFields(row._TemplateText) ? '<p class="context-warning">No active appointment today. Date/time fields are empty. Use a template without appointment fields for a manual message.</p>' : ''}<pre>${escape(message)}</pre>${kind === "dashboard" ? `<div class="two-col"><div><h3>Default template</h3><pre>${escape(S.library.templates.appointment?.US || "")}</pre></div><div><h3>Activity</h3><pre>${escape(S.activity.slice(-200).join("\n"))}</pre></div></div>` : ""}<div class="actions"><button data-modal-result="close">Close</button></div>`,
  );
}
async function history(row) {
  const records = await api("history", { patNum: row.PatNum });
  await modal(
    `<h2>SMS history · ${escape(patientName(row))}</h2><div class="dialog-table"><table><thead><tr>${["Date/time", "Type", "Phone", "Status", "Message", "Details"].map((s) => `<th>${s}</th>`).join("")}</tr></thead><tbody>${records.map((r) => `<tr>${[r.ActivityAt || r.SentAt || r.CreatedAt, r.MessageType, r.Phone, r.Status, r.Message, r.Context || r.ErrorMessage].map((s) => `<td>${escape(s)}</td>`).join("")}</tr>`).join("") || '<tr><td colspan="6">No SMS history.</td></tr>'}</tbody></table></div><div class="actions"><button data-modal-result="close">Close</button></div>`,
  );
}
async function refreshTemplates(seed = false) {
  S.library = await api("templates", { seed });
  $("review-link").value = S.library.settings.review_link || "";
  $("setting-review-link").value = S.library.settings.review_link || "";
  renderHolidayEvents();
  renderTemplateEditor();
  for (const kind of [
    "dashboard",
    "patient",
    "recall",
    "treatment",
    "review",
    "holiday",
  ])
    renderTable(kind);
}
function renderTemplateEditor() {
  const category = $("template-category").value,
    keys = Object.keys(S.library.templates[category] || {}),
    old = $("template-select").value;
  $("template-select").classList.add("flag-select");
  $("template-select").innerHTML = flagOptions(keys.map(k => [k, S.library.countries[category]?.[k] || k.slice(0,2)]), old);
  $("template-country").classList.add("flag-select");
  $("template-country").innerHTML = flagOptions([["US","US","US — English"],["VI","VI","VI — Vietnamese"],["ES","ES","ES — Spanish"]], "US");
  if (keys.includes(old)) $("template-select").value = old;
  populateTemplate();
}
async function openTemplateManager(kind) {
  const editor = $("page-templates").querySelector(".template-card");
  const parent = editor.parentElement, next = editor.nextSibling, previous = $("template-category").value;
  const promise = modal(`<h2>${escape(kind === "review" ? "Google review" : kind === "holiday" ? "Holiday & Birthday" : kind[0].toUpperCase()+kind.slice(1))} templates</h2><div id="template-popup"></div><div class="actions"><button data-modal-result="close">Close</button></div>`);
  $("template-popup").append(editor);
  $("template-category").value = categoryFor(kind);
  $("template-category").disabled = true;
  renderTemplateEditor();
  try { await promise; }
  finally {
    parent.insertBefore(editor, next);
    $("template-category").disabled = false;
    $("template-category").value = previous;
    renderTemplateEditor();
  }
}
function populateTemplate() {
  const category = $("template-category").value,
    key = $("template-select").value;
  $("template-key").value = key;
  $("template-country").value = S.library.countries[category]?.[key] || "US";
  $("template-text").value = S.library.templates[category]?.[key] || "";
}
async function writeTemplate(method) {
  const targetKey = $("template-key").value.trim().toUpperCase();
  if (
    method === "DELETE" &&
    !(await question(
      "Delete template?",
      `Remove ${$("template-key").value} from the shared Bridge?`,
      "Delete",
    ))
  )
    return;
  S.library = await api("template-write", {
    method,
    category: $("template-category").value,
    templateKey: $("template-key").value.trim().toUpperCase(),
    oldKey: $("template-select").value,
    country: $("template-country").value,
    templateText: $("template-text").value,
  });
  renderTemplateEditor();
  for (const kind of [
    "dashboard",
    "patient",
    "recall",
    "treatment",
    "review",
    "holiday",
  ])
    renderTable(kind);
  for (const kind of ["dashboard","patient","recall","treatment","review","holiday"]) {
    const category=categoryFor(kind);
    for (const [id,key] of S.templates[kind]) if (!S.library.templates[category]?.[key]) S.templates[kind].delete(id);
    renderTable(kind);
  }
  if (method !== "DELETE") { $("template-select").value = targetKey; populateTemplate(); }
  toast("Template library updated.");
}
function renderHolidayEvents(selectedEvent) {
  let events;
  try {
    events = JSON.parse(S.library.settings.holiday_events);
  } catch {
    events = HOLIDAYS;
  }
  if (!Array.isArray(events) || !events.length) events = HOLIDAYS;
  const previous = selectedEvent || $("holiday-event").value;
  $("holiday-event").innerHTML = events
    .map((e) => `<option>${escape(e)}</option>`)
    .join("");
  if (events.includes(previous)) $("holiday-event").value = previous;
}
async function editHoliday(mode) {
  const current = $("holiday-event").value;
  let value = "";
  if (mode !== "delete") {
    const promise = modal(
      `<h2>${mode === "add" ? "Add" : "Edit"} holiday</h2><input id="holiday-value" value="${mode === "edit" ? escape(current) : ""}" style="width:100%"><div class="actions"><button data-modal-result="cancel">Cancel</button><button class="primary" data-modal-result="save">Save</button></div>`,
    );
    if ((await promise) !== "save") return;
    value = $("holiday-value").value.trim();
    if (!value) throw new Error("Holiday name is required.");
  } else if (
    !(await question("Delete holiday?", `Remove ${current}?`, "Delete"))
  )
    return;
  const events = Array.from($("holiday-event").options).map((o) => o.value);
  const next =
    mode === "add"
      ? [...new Set([...events, value])]
      : mode === "edit"
        ? events.map((e) => (e === current ? value : e))
        : events.filter((e) => e !== current);
  await api("sms-setting", {
    key: "holiday_events",
    value: JSON.stringify(next),
  });
  S.library.settings.holiday_events = JSON.stringify(next);
  renderHolidayEvents(value);
  toast("Holiday list saved.");
}
async function customRecipient(edit = false) {
  const row = edit ? selected("holiday")[0] : {};
  if (edit && !row) throw new Error("Select one recipient.");
  const fields = [
    ["FName", "First name"],
    ["LName", "Last name"],
    ["Phone", "Phone"],
    ["Email", "Email"],
    ["Language", "Language"],
    ["Birthdate", "Birthdate"],
    ["PatNum", "Patient #"],
  ];
  const promise = modal(
    `<h2>${edit ? "Edit" : "Add custom"} recipient</h2><div class="form">${fields.map(([key, label]) => `<label>${label}</label><input id="custom-${key}" value="${escape(row[key] || "")}" ${key === "Birthdate" ? 'type="date"' : ""}>`).join("")}</div><div class="actions"><button data-modal-result="cancel">Cancel</button><button class="primary" data-modal-result="save">Save recipient</button></div>`,
  );
  if ((await promise) !== "save") return;
  const value = Object.fromEntries(
    fields.map(([key]) => [key, $(`custom-${key}`).value.trim()]),
  );
  if (!value.Phone.replace(/\D/g, ""))
    throw new Error("A valid phone number is required.");
  const next = {
    ...row,
    ...value,
    _Kind: "holiday",
    _AllowManualPhoneTarget: true,
    _CustomId: row._CustomId || crypto.randomUUID(),
    _CampaignType: $("campaign-type").value,
    _CampaignName:
      $("campaign-type").value === "birthday"
        ? formatDate($("birthday-date").value)
        : $("holiday-event").value,
    _HolidayName: $("campaign-type").value === "birthday" ? formatDate($("birthday-date").value) : $("holiday-event").value,
  };
  if (edit)
    S.rows.holiday[S.rows.holiday.findIndex((r) => rowID(r) === rowID(row))] =
      next;
  else S.rows.holiday.push(next);
  S.selection.holiday.clear();
  renderTable("holiday");
}
async function draftBatch(kind, all = false) {
  const rows = all
    ? visibleRows(kind).map((r) => prepared(kind, r))
    : selected(kind);
  if (!rows.length) throw new Error("Select at least one patient.");
  const missingContext = rows.find(r => hasAppointmentFields(r._TemplateText) && !r.AptDateTime);
  if (missingContext) {
    const result = await modal(`<h2>Today's appointment not found</h2><p>${escape(patientName(missingContext))} has no active appointment today. This template needs appointment date/time, so no SMS draft was created.</p><p>Choose a template without appointment date/time fields for a general message. To test the pasted layout only, use “Test selected (no send)”.</p><div class="actions"><button data-modal-result="close">Close</button><button data-modal-result="templates">Manage templates</button></div>`);
    if (result === "templates") await openTemplateManager(kind);
    return;
  }
  if (kind === "review") {
    for (let i=0; i<rows.length; i++) {
      await api("compose", { row:rows[i],category:"review_google",loggable:false });
      if (i < rows.length-1 && !(await question("Review draft ready", "Send this review request manually in Phone Link. Continue to the next patient only after finishing this draft. No sent log is written for Review Google.", "Next draft"))) break;
    }
    toast("Review draft ready. Send manually in Phone Link.");
    return;
  }
  if (
    kind === "recall" &&
    rows.some((r) => Number(r.RecallSentCount) >= 2) &&
    !(await question(
      "Recall already sent",
      "At least one patient already has two or more recall SMS messages logged. Continue filling drafts?",
    ))
  )
    return;
  S.batch = rows;
  S.batchCategory = categoryFor(kind);
  S.batchKind = kind;
  S.batchIndex = 0;
  await nextDraft();
}
async function nextDraft() {
  if (S.batchIndex >= S.batch.length) {
    S.batch = [];
    toast("Draft batch complete.");
    await load(S.batchKind);
    return;
  }
  const row = S.batch[S.batchIndex];
  const pending = await api("compose", {
    row,
    category: S.batchCategory,
    loggable: true,
  });
  S.status.pendingDraft = pending;
  updateStatus();
  await resolveDraft(pending);
}
async function resolveDraft(pending = S.status.pendingDraft) {
  if (!pending) return;
  const answer = await modal(
    `<h2>Confirm SMS sent${S.batch.length ? ` · ${S.batchIndex + 1}/${S.batch.length}` : ""}</h2><p>Draft for <b>${escape(patientName(pending.row))}</b> at <b>${escape(pending.phone)}</b> is open in Phone Link.</p><p>Press Send in Phone Link first. Then choose “Sent - save log”. Choose “Not sent” to stop without recording a sent message.</p><pre>${escape(pending.message)}</pre><div class="actions"><button data-modal-result="not-sent">Not sent</button><button class="primary" data-modal-result="sent">Sent - save log</button></div>`,
  );
  if (answer === null) {
    toast("Draft remains open. Use Resume draft confirmation on Dashboard.");
    return;
  }
  S.status = await api("confirm-draft", {
    id: pending.id,
    sent: answer === "sent",
  });
  updateStatus();
  if (answer === "sent" && S.batch.length) {
    S.batchIndex++;
    await nextDraft();
  } else {
    S.batch = [];
    if (S.batchKind) await load(S.batchKind);
  }
}
function fillSettings() {
  for (const key of Object.keys(S.config)) {
    const input = $(`setting-${key}`);
    if (input)
      input.value = Array.isArray(S.config[key])
        ? S.config[key].join(",")
        : S.config[key];
  }
  $("setting-api_token").placeholder = S.config.api_token_present
    ? "Saved token — leave blank to keep it"
    : "Enter Bridge API token";
  $("setting-api_token").value = "";
  $("recall-months").value = S.config.recall_months;
  $("recall-codes").value = S.config.recall_codes;
  $("treatment-days").value = S.config.treatment_days;
  $("treatment-codes").value = S.config.treatment_codes;
  $("treatment-statuses").value = S.config.treatment_statuses;
}
async function saveSettings() {
  const input = Object.fromEntries(
    Array.from(document.querySelectorAll('[id^="setting-"]'))
      .filter((e) => !e.disabled)
      .map((e) => [e.id.slice(8), e.value]),
  );
  input.appointment_statuses = input.appointment_statuses
    .split(",")
    .map((v) => Number(v.trim()));
  Object.assign(input, {
    recall_months: Number($("recall-months").value),
    recall_codes: $("recall-codes").value,
    treatment_days: Number($("treatment-days").value),
    treatment_codes: $("treatment-codes").value,
    treatment_statuses: $("treatment-statuses").value,
  });
  S.config = await api("save-config", input);
  const reviewLink = $("setting-review-link").value.trim();
  if (reviewLink !== (S.library.settings.review_link || "")) { await api("sms-setting", {key:"review_link",value:reviewLink}); S.library.settings.review_link=reviewLink; }
  await saveSchedulerTimes();
  fillSettings();
  updateStatus();
  toast("Workstation settings saved.");
  if (S.config.api_token_present) {
    await refreshTemplates();
    await load("dashboard");
  }
}
function updateStatus() {
  $("workstation").textContent =
    `${S.status.machine || ""} · ${S.status.mode === "fd2" ? "FD2 · Drafts" : "R5 · Reminders"}${S.status.demo ? " · DEMO" : ""}`;
  $("send-badge").textContent = S.status.demo
    ? "DEMO · NO SEND"
    : S.status.mode === "fd2"
      ? "MANUAL DRAFTS"
      : "REAL SMS";
  $("send-badge").classList.toggle("demo", S.status.demo);
  $("monitor-state").textContent = S.status.monitoring ? "Running" : "Stopped";
  $("monitor-state").classList.toggle("running", S.status.monitoring);
  $("monitor-machine").textContent =
    `${S.status.machine || ""} (${S.status.mode || ""})`;
  $("monitor-dates").textContent = [
    ...new Set([Number(S.config.reminder_days_ahead ?? 1), 8]),
  ]
    .map(
      (offset) =>
        `${formatDate(addDays(today(), offset))} (${offset} days ahead)`,
    )
    .join(", ");
  $("monitor-time").textContent =
    `${S.config.scheduled_send_time || "11:00"} · ${S.config.time_zone || "America/Chicago"}`;
  $("start-monitoring").disabled =
    S.status.monitoring ||
    S.status.mode === "fd2" ||
    S.status.busy ||
    S.status.monitorBusy ||
    !!S.status.pendingDraft;
  $("stop-monitoring").disabled = !S.status.monitoring && !S.status.busy;
  for (const button of document.querySelectorAll("[data-send]"))
    button.disabled =
      S.status.busy || !!S.status.pendingDraft || S.status.monitorBusy;
  for (const id of ["send-dashboard", "send-all", "test-sms"])
    if (S.status.mode === "fd2") $(id).disabled = true;
  const banner = $("draft-banner");
  banner.hidden = !S.status.pendingDraft;
  if (S.status.pendingDraft) {
    banner.innerHTML =
      'A draft is awaiting staff confirmation. <button id="resume-draft">Resume draft confirmation</button>';
    on("resume-draft", () => resolveDraft());
  }
  for (const id of ["sync-logs", "sync-logs-tab"])
    $(id).textContent =
      `Sync pending logs${S.status.outbox ? ` (${S.status.outbox})` : ""}`;
}
function renderActivity() {
  const element = $("activity"),
    bottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 50;
  element.textContent = S.activity.join("\n") || "Ready.";
  if (bottom) element.scrollTop = element.scrollHeight;
}
async function saveSchedulerTimes() {
  return api("scheduler-times", { enableLogin: $("scheduler-enable").value, restart: $("scheduler-restart").value, startTool: $("scheduler-start").value, lock: $("scheduler-lock").value });
}
function wire() {
  on("appointment-date", () => load("dashboard"), "change");
  on("open-phone", () => api("native", { action: "open-phone" }));
  on("send-dashboard", async () => {
    const rows = selected("dashboard");
    if (!rows.length) throw new Error("Select at least one appointment.");
    await api("send", { rows });
    await load("dashboard");
  });
  on("send-all", async () => {
    const rows = S.rows.dashboard
      .filter((r) => !blockedStatus(r.ReminderStatus))
      .map((r) => prepared("dashboard", r));
    if (!rows.length) throw new Error("No pending reminders.");
    await api("send", { rows });
    await load("dashboard");
  });
  for (const kind of ["dashboard", "patient"])
    on(`test-${kind}`, async () => {
      const rows = selected(kind);
      if (rows.length !== 1)
        throw new Error("Select exactly one patient to test.");
      if (!rows[0].AptDateTime && hasAppointmentFields(rows[0]._TemplateText) &&
          !(await question("No active appointment today", "This is a no-send test. Appointment date/time fields will be empty. Continue preparing the draft?", "Prepare test draft"))) return;
      await api("compose", {
        row: rows[0],
        category: "appointment",
        loggable: false,
        testOnly: true,
      });
      toast("Draft prepared. No SMS sent and no log written.");
    });
  for (const action of ["mark", "reset"])
    on(`${action}-dashboard`, async () => {
      const rows = selected("dashboard");
      if (!rows.length) throw new Error("Select at least one appointment.");
      await api(action, { rows });
      await load("dashboard");
    });
  on("clear-dry-run", async () => {
    await api("clear-dry-run");
    await load("dashboard");
  });
  on("start-monitoring", async () => {
    S.status = await api("start-monitoring");
    updateStatus();
    $("appointment-date").value=addDays(today(), S.config.reminder_days_ahead);
    activate("dashboard");
    await load("dashboard");
  });
  on("stop-monitoring", async () => {
    S.status = await api("stop-appointment-monitoring");
    updateStatus();
  });
  for (const id of ["sync-logs", "sync-logs-tab"])
    on(id, async () => {
      S.status = await api("sync");
      updateStatus();
      toast("Pending logs synchronized.");
    });
  on("reload-scheduler-times", async () => { const times=await api("load-scheduler-times"); for (const [key,id] of [["enableLogin","enable"],["restart","restart"],["startTool","start"],["lock","lock"]]) $(`scheduler-${id}`).value=times[key]; toast("Scheduler BAT times reloaded."); });
  on("save-scheduler-times", () => saveSchedulerTimes().then(() => toast("Scheduler times saved. Run setup to apply Windows tasks.")));
  on("scheduler-on", async () => {
    await saveSchedulerTimes();
    return api("scheduler", {
      mode: "on",
      enableLogin: $("scheduler-enable").value,
      restart: $("scheduler-restart").value,
      startTool: $("scheduler-start").value,
      lock: $("scheduler-lock").value,
      autoStartReminder: $("scheduler-auto-monitor").checked,
    }).then(result => toast(result.cancelled ? "Scheduler setup cancelled." : "Windows scheduler setup finished."));
  });
  on("scheduler-off", () =>
    api("scheduler", { mode: "off" }).then(() =>
      toast("Electron scheduler disabled."),
    ),
  );
  on("template-category", () => renderTemplateEditor(), "change");
  on("template-select", () => populateTemplate(), "change");
  on("reload-templates", () => refreshTemplates());
  on("seed-templates", async () => {
    if (
      await question(
        "Seed defaults",
        "Initialize/update managed templates on the shared Bridge?",
      )
    )
      await refreshTemplates(true);
  });
  on("new-template", () => {
    $("template-key").value = "";
    $("template-text").value = S.library.templates[$("template-category").value]?.US || "";
    $("template-key").focus();
  });
  on("add-template", () => writeTemplate("POST"));
  on("save-template", () => writeTemplate("PUT"));
  on("delete-template", () => writeTemplate("DELETE"));
  on("save-settings", () => saveSettings());
  on("test-bridge", async () => {
    await saveSettings();
    await api("test-bridge");
    toast("Connected to the Open Dental Bridge.");
  });
  on("import-config", async () => {
    const config = await api("import-config");
    if (config) {
      S.config = config;
      fillSettings();
      updateStatus();
      await refreshTemplates();
      await load("dashboard");
      toast("Imported workstation settings.");
    }
  });
  on("check-updates", async () => toast((await api("check-updates")).message));
  on("open-data", () => api("open-data"));
  on("snapshot", async () => {
    const result = await api("native", { action: "snapshot" });
    await modal(
      `<h2>Phone Link UI snapshot</h2><pre>${escape(JSON.stringify(result.elements, null, 2))}</pre><div class="actions"><button data-modal-result="close">Close</button></div>`,
    );
  });
  on("save-review-link", async () => {
    const value = $("review-link").value.trim();
    await api("sms-setting", { key: "review_link", value });
    S.library.settings.review_link = value;
    $("setting-review-link").value = value;
    toast("Shared review link saved.");
  });
  for (const mode of ["add", "edit", "delete"])
    on(`${mode}-holiday`, () => editHoliday(mode));
  on("add-custom", () => customRecipient());
  on("edit-custom", () => customRecipient(true));
  on("remove-holiday", () => {
    S.rows.holiday = S.rows.holiday.filter(
      (r) => !S.selection.holiday.has(rowID(r)),
    );
    S.selection.holiday.clear();
    renderTable("holiday");
  });
  on("fd2-patient", () => draftBatch("patient"));
  on("compose-all-holiday", () => draftBatch("holiday", true));
  on(
    "campaign-type",
    () => {
      const birthday = $("campaign-type").value === "birthday";
      $("holiday-event").disabled = birthday;
      for (const row of S.rows.holiday) {
        row._CampaignType = birthday ? "birthday" : "holiday";
        row._CampaignName = birthday ? formatDate($("birthday-date").value) : $("holiday-event").value;
        row._HolidayName = row._CampaignName;
      }
      for (const id of ["add-holiday","edit-holiday","delete-holiday"]) $(id).disabled=birthday;
      $("search-holiday").placeholder=birthday ? "Optional patient filter after birthday load…" : "Patient, phone, email, #patient number…";
      S.filters.holiday=birthday ? $("search-holiday").value : "";
      S.templates.holiday.clear();
      load("holiday");
    },
    "change",
  );
  on(
    "holiday-event",
    () => {
      for (const row of S.rows.holiday) {
        row._CampaignName = $("holiday-event").value;
        row._HolidayName = $("holiday-event").value;
      }
      renderTable("holiday");
    },
    "change",
  );
  on("birthday-date", () => load("holiday"), "change");
  let filterTimer;
  for (const [kind, ids] of [
    ["recall", ["recall-months", "recall-codes"]],
    ["treatment", ["treatment-days", "treatment-codes", "treatment-statuses"]],
  ])
    for (const id of ids)
      on(
        id,
        () => {
          clearTimeout(filterTimer);
          filterTimer = setTimeout(
            handle(() => load(kind)),
            420,
          );
        },
        "input",
      );
  on("test-sms", async () => {
    const promise = modal(
      '<h2>Send a real test SMS</h2><div class="form"><label>Phone</label><input id="test-phone"><label>Message</label><textarea id="test-message">LUK Dental SMS test.</textarea></div><div class="actions"><button data-modal-result="cancel">Cancel</button><button class="primary" data-modal-result="send">Send test SMS</button></div>',
    );
    if ((await promise) === "send") {
      await api("test-sms", {
        phone: $("test-phone").value,
        message: $("test-message").value,
      });
      toast("Test send attempted. Inspect Phone Link.");
    }
  });
}
async function start() {
  build();
  wire();
  const initial = await api("init");
  S.config = initial.config;
  S.status = initial.status;
  S.columns = initial.columns || {};
  for (const [key,id] of [["enableLogin","enable"],["restart","restart"],["startTool","start"],["lock","lock"]]) if (initial.schedulerTimes?.[key]) $(`scheduler-${id}`).value=initial.schedulerTimes[key];
  $("data-location").textContent = `Settings: ${initial.dataDir}`;
  $("appointment-date").value = addDays(today(), S.config.reminder_days_ahead);
  $("birthday-date").value = today();
  fillSettings();
  updateStatus();
  window.sms.subscribe((event) => {
    if (event.type === "activity") {
      S.activity.push(
        `[${clinicClock(undefined, S.config.time_zone).time}] ${event.message}`,
      );
      S.activity = S.activity.slice(-500);
      if (S.tab === "monitoring") renderActivity();
      $("status-text").textContent = event.message;
    }
    if (event.type === "status") {
      S.status = event.data;
      updateStatus();
    }
    if (event.type === "refresh")
      load("dashboard").catch((e) => toast(e.message, true));
  });
  if (S.config.api_token_present || S.status.demo) {
    await refreshTemplates();
    await load("dashboard");
  } else {
    renderHolidayEvents();
    toast(
      "Open Settings to import the existing config or enter the Bridge connection.",
    );
  }
}
start().catch((error) => {
  const p = document.createElement("p");
  p.id = "fatal";
  p.textContent = error.message;
  $("pages").prepend(p);
  toast(error.message, true);
});
