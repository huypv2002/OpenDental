const { randomUUID } = require("node:crypto");
class SmsService {
  constructor({ store, bridge, windows, model, machine, emit, demo = false }) {
    Object.assign(this, { store, bridge, windows, model, machine, emit, demo });
    // Upgrade keys written by the first Electron build, which retained +1 prefixes.
    let migrated = false;
    for (const [key, entry] of Object.entries(store.state.ledger)) {
      const parts = key.split("|");
      if (parts.length !== 4) continue;
      parts[2] = model.digits(parts[2]);
      const canonical = parts.join("|");
      if (canonical === key) continue;
      const existing = store.state.ledger[canonical];
      if (!existing || entry.status === "sent") store.state.ledger[canonical] = entry;
      delete store.state.ledger[key];
      migrated = true;
    }
    if (migrated) store.saveState();
    this.busy = false;
    this.stopping = false;
    this.monitoring = false;
    this.recallMonitoring = false;
    this.scheduleRetry = {};
    this.monitorBusy = false;
    this.library = { templates: {}, countries: {} };
    this.smsSettings = {};
    this.activeSchedule = "";
  }
  get config() {
    return {
      ...this.store.config,
      review_link: this.smsSettings.review_link || "",
    };
  }
  get today() {
    return this.model.clinicClock(new Date(), this.config.time_zone).date;
  }
  activity(message) {
    this.emit({ type: "activity", message });
  }
  status() {
    return {
      busy: this.busy,
      monitoring: this.monitoring,
      recallMonitoring: this.recallMonitoring,
      monitorBusy: this.monitorBusy,
      pendingDraft: this.store.state.pendingDraft,
      outbox: this.store.state.outbox.length,
      mode: this.model.isFD2(this.config, this.machine) ? "fd2" : "r5",
      machine: this.machine,
      demo: this.demo,
      lastSchedule: this.store.state.lastSchedule,
      lastRecallSchedule: this.store.state.lastRecallSchedule || "",
    };
  }
  notify() {
    this.emit({ type: "status", data: this.status() });
  }
  async templates(seed = false) {
    if (seed) await this.bridge.request("GET", "/api/sms-templates/init");
    let [library, settings] = await Promise.all([
      this.bridge.request("GET", "/api/sms-templates"),
      this.bridge.request("GET", "/api/sms-settings"),
    ]);
    // Match Python's library migration for missing required template groups.
    if (!seed && (!library.templates?.appointment?.US_TODAY || this.model.CATEGORIES.some(c => !Object.keys(library.templates?.[c] || {}).length))) {
      await this.bridge.request("GET", "/api/sms-templates/init");
      library = await this.bridge.request("GET", "/api/sms-templates");
    }
    this.library = library;
    this.smsSettings = settings.settings || {};
    return { ...library, settings: this.smsSettings };
  }
  rowWithTemplate(row, category) {
    const key =
      row._TemplateKey ||
      this.model.pickTemplate(this.library.templates, row, category);
    const text = this.library.templates[category]?.[key];
    if (!text?.trim())
      throw new Error(
        `No ${category} template selected for ${this.model.patientName(row)}.`,
      );
    return {
      ...row,
      Phone: row._AllowManualPhoneTarget ? this.model.phoneFor(row) : this.model.phoneFor(row) ? `Wireless: ${this.model.phoneFor(row)}` : "",
      _TemplateKey: key,
      _TemplateText: text,
      _TemplateCountry:
        this.library.countries?.[category]?.[key] || this.model.sixMonthRecallLanguage(key) || key.slice(0, 2),
    };
  }
  async loadDailyRecall(date) {
    if (!Object.keys(this.library.templates).length) await this.templates();
    const patients = [];
    let afterPatNum = 0;
    while (true) {
      const data = await this.bridge.request("GET", "/api/sms-reminders/recall-candidates", {
        mode: "daily", date, limit: 500, afterPatNum,
      });
      if (data.contract !== "calendar-6-month-v2" || data.date !== date)
        throw new Error("Update SERVER Bridge before running daily Recall.");
      const batch = data.patients || [];
      if (batch.length && Number(batch.at(-1).PatNum) <= afterPatNum)
        throw new Error("Daily Recall patient cursor did not advance.");
      patients.push(...batch);
      if (batch.length < 500) break;
      afterPatNum = Number(batch.at(-1).PatNum);
    }
    const seen = new Set();
    return patients.filter(row => {
      const key = `${row.PatNum}|${row.LastProcDate}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).map(row => {
      const {category,key,language} = this.model.pickDailyRecallTemplate(this.library, row);
      const prepared = this.rowWithTemplate({...row, _TemplateKey:key, _TemplateCategory:category, _Kind:"recall", _DailyRecall:true, _DailyRecallDate:date}, category);
      prepared._TemplateCountry = language;
      if (this.model.hasAppointmentFields(prepared._TemplateText))
        throw new Error("Recall template requires appointment fields; choose a Recall message without appointment date/time.");
      return prepared;
    });
  }
  async load(kind, options = {}) {
    const statuses = this.config.appointment_statuses.join(",");
    if (kind === "dashboard") {
      const date =
        options.date ||
        this.model.addDays(this.today, this.config.reminder_days_ahead);
      const [data, logs] = await Promise.all([
        this.bridge.request("GET", "/api/sms-reminders/appointments", {
          date,
          statuses,
        }),
        this.bridge.request("GET", "/api/sms-reminders/logs", {
          date,
          limit: 1000,
        }),
      ]);
      return {
        rows: this.model
          .expandAppointments(
            data.appointments || [],
            logs.logs || [],
            this.today,
          )
          .map((r) => {
            const local =
              this.store.state.ledger[this.model.reminderKey(r, this.today)];
            return local && !this.model.blockedStatus(r.ReminderStatus)
              ? {
                  ...r,
                  ReminderStatus: local.status,
                  ReminderError: local.error || "",
                }
              : r;
          }),
      };
    }
    if (kind === "logs")
      return {
        rows:
          (
            await this.bridge.request("GET", "/api/sms-reminders/logs", {
              limit: 1000,
            })
          ).logs || [],
      };
    if (kind === "recall" || kind === "treatment") {
      const params =
        kind === "recall"
          ? {
              months: options.months ?? this.config.recall_months,
              codes: options.codes ?? this.config.recall_codes,
              statuses,
              limit: 500,
            }
          : {
              beforeDays: options.days ?? this.config.treatment_days,
              codes: options.codes ?? this.config.treatment_codes,
              treatmentStatuses:
                options.statuses ?? this.config.treatment_statuses,
              statuses,
              limit: 500,
            };
      return {
        rows: (
          (
            await this.bridge.request(
              "GET",
              `/api/sms-reminders/${kind}-candidates`,
              params,
            )
          ).patients || []
        ).map((r) => ({ ...r, _Kind: kind, Phone: this.model.phoneFor(r) })),
      };
    }
    let rows;
    if (kind === "holiday" && options.type === "birthday")
      rows =
        (
          await this.bridge.request(
            "GET",
            "/api/sms-reminders/birthday-candidates",
            { date: options.date || this.today, limit: 500 },
          )
        ).patients || [];
    else {
      const query = String(options.query || "").trim();
      if (kind === "patient" && !query) return { rows: [], hasMore: false };
      rows =
        (
          await this.bridge.request("GET", "/api/admin/patients", {
            q: query,
            ...(/^#\d+$/.test(query)?{patNum:query.slice(1)}:{}),
            limit: 50,
            offset: /^#\d+$/.test(query)?0:Number(options.offset || 0),
            appointmentDate: this.today,
          })
        ).patients || [];
      if (/^#\d+$/.test(query)){
        rows = rows.filter((r) => String(r.PatNum) === String(Number(query.slice(1))));
        this.activity(`Patient search ${query}: SERVER returned ${rows.length} exact match(es).`);
      }
      if (rows.some((r) => !r.AptDateTime)) {
        const data = await this.bridge.request(
          "GET",
          "/api/sms-reminders/appointments",
          { date: this.today, statuses },
        ).catch(() => ({ appointments: [] }));
        const map = new Map(
          (data.appointments || []).map((r) => [String(r.PatNum), r]),
        );
        rows = rows.map((r) =>
          r.AptDateTime || !map.has(String(r.PatNum))
            ? r
            : {
                ...r,
                AptDateTime: map.get(String(r.PatNum)).AptDateTime,
                AptNum: map.get(String(r.PatNum)).AptNum,
              },
        );
      }
    }
    return {
      rows: rows.map((r) => ({
        ...r,
        _Kind: kind,
        Phone: this.model.phoneFor(r),
        ...(kind === "holiday"
          ? {
              _CampaignType: options.type || "holiday",
              _CampaignName:
                options.type === "birthday" ? this.model.formatDate(options.date || this.today) : options.event || "",
              _HolidayName: options.type === "birthday" ? this.model.formatDate(options.date || this.today) : options.event || "",
            }
          : {}),
      })),
      hasMore: rows.length === 50 && !(kind === "holiday" && options.type === "birthday"),
    };
  }
  async exclusive(fn, scheduled = false) {
    if (this.busy)
      throw new Error("A Phone Link/Open Dental operation is already running.");
    if (this.monitorBusy && !scheduled)
      throw new Error(
        "The daily monitoring batch is running. Stop it before starting another operation.",
      );
    if (this.store.state.pendingDraft)
      throw new Error(
        "Confirm the open draft was sent, or choose Not sent, before continuing.",
      );
    this.busy = true;
    this.stopping = false;
    this.notify();
    try {
      return await fn();
    } finally {
      this.busy = false;
      this.notify();
    }
  }
  async compose(row, category = "appointment", loggable = true, testOnly = false) {
    return this.exclusive(async () => {
      if (!Object.keys(this.library.templates).length) await this.templates();
      const prepared = this.rowWithTemplate(row, category);
      if (
        !testOnly &&
        this.model.hasAppointmentFields(prepared._TemplateText) &&
        !prepared.AptDateTime
      )
        throw new Error(
          "This template needs appointment date/time. No current appointment was found.",
        );
      const phone = this.model.phoneFor(prepared);
      if (!this.model.digits(phone))
        throw new Error("This patient has no Wireless phone number.");
      const message = this.model.renderMessage(
        this.config,
        prepared,
        prepared._TemplateText,
        this.today,
      );
      await this.windows.run({
        action: "sms",
        mode: "draft",
        phone,
        message,
        fd2: !!prepared._Kind || loggable || this.model.isFD2(this.config, this.machine),
      });
      if (loggable) {
        this.store.state.pendingDraft = {
          id: randomUUID(),
          row: prepared,
          phone,
          message,
          createdAt: new Date().toISOString(),
          demo: this.demo,
        };
        this.store.saveState();
      }
      this.activity(
        `Draft ready for ${this.model.patientName(prepared)}. Send in Phone Link, then confirm here.`,
      );
      return this.store.state.pendingDraft || { phone, message };
    });
  }
  async confirmDraft(id, sent) {
    const pending = this.store.state.pendingDraft;
    if (!pending || pending.id !== id)
      throw new Error("This draft is no longer current.");
    if (sent && !pending.demo) {
      await this.writeLog(pending.row, pending.message, "sent");
      if (!pending.row._Kind || pending.row._Kind === "dashboard") {
        this.store.state.ledger[
          this.model.reminderKey(pending.row, this.today)
        ] = { status: "sent" };
      }
    }
    this.store.state.pendingDraft = null;
    this.store.saveState();
    this.activity(
      sent
        ? pending.demo
          ? "DEMO: confirmation simulated. No Bridge log changed."
          : "Staff confirmed SMS sent; saved history."
        : "Draft cancelled without a sent log.",
    );
    this.notify();
    return this.status();
  }
  async writeLog(row, message, status, error = "") {
    if (this.demo) return;
    const payload = this.model.logPayload(
      row,
      message,
      status,
      this.today,
      error,
    );
    // Persist before the HTTP request, so a Bridge outage cannot silently lose a sent result.
    if (payload.path === "/api/sms-reminders/log") {
      const identity = (body) =>
        [
          body.aptNum,
          body.reminderForDate,
          this.model.digits(body.phone),
          body.reminderOffsetDays,
        ].join("|");
      this.store.state.outbox = this.store.state.outbox.filter(
        (item) =>
          item.path !== payload.path ||
          identity(item.body) !== identity(payload.body),
      );
    }
    const item = { id: randomUUID(), ...payload };
    this.store.state.outbox.push(item);
    this.store.saveState();
    try {
      await this.bridge.request("POST", payload.path, {}, payload.body);
      this.store.state.outbox = this.store.state.outbox.filter(
        (v) => v.id !== item.id,
      );
      this.store.saveState();
    } catch (error) {
      this.activity(
        `Log is saved locally and awaits Bridge sync: ${error.message}`,
      );
    }
  }
  async syncOutbox() {
    if (this.busy || this.monitorBusy || this.store.state.pendingDraft)
      throw new Error(
        "Finish the current job or draft before synchronizing logs.",
      );
    for (const item of [...this.store.state.outbox]) {
      await this.bridge.request("POST", item.path, {}, item.body);
      this.store.state.outbox = this.store.state.outbox.filter(
        (v) => v.id !== item.id,
      );
      this.store.saveState();
    }
    this.notify();
    return this.status();
  }
  async send(rows, scheduled = false) {
    if (this.model.isFD2(this.config, this.machine))
      throw new Error(
        "FD2 uses manual drafts. Automatic sending is available on R5.",
      );
    return this.exclusive(async () => {
      if (!Object.keys(this.library.templates).length) await this.templates();
      let completed = 0,
        failed = 0,
        skipped = 0;
      for (const original of rows) {
        if (this.stopping || (scheduled && !(original._DailyRecall ? this.recallMonitoring : this.monitoring))) break;
        const dailyRecall = scheduled && original._DailyRecall === true;
        const row = this.rowWithTemplate(original, dailyRecall ? (original._TemplateCategory || "recall") : "appointment");
        const key = dailyRecall
          ? `daily-recall|${row.PatNum}|${this.model.digits(this.model.phoneFor(row))}|${row.LastProcDate}`
          : this.model.reminderKey(row, this.today);
        if (
          this.model.blockedStatus(row.ReminderStatus) ||
          this.model.blockedStatus(
            this.store.state.ledger[key]
              ?.status,
          )
        ) {
          skipped++;
          continue;
        }
        if (!this.model.digits(this.model.phoneFor(row))) {
          skipped++;
          continue;
        }
        if (!dailyRecall && !row.AptDateTime)
          throw new Error("Appointment date/time is required.");
        const message = this.model.renderMessage(
          this.config,
          row,
          row._TemplateText,
          this.today,
        );
        if (dailyRecall && !this.demo) {
          const reservation = await this.bridge.request("POST", "/api/sms-reminders/recall-claim", {}, {
            patNum: Number(row.PatNum), lastProcDate: row.LastProcDate,
            phone: this.model.phoneFor(row), wirelessPhone: row.WirelessPhone,
            runDate: row._DailyRecallDate,
          });
          if (!reservation.claimed) { skipped++; continue; }
          if (typeof reservation.token !== "string" || !reservation.token)
            throw new Error("Daily Recall reservation did not return a dispatch token.");
          row._DispatchToken = reservation.token;
        }
        // Reserve locally before touching Phone Link; crashes/uncertain sends require review.
        if (!this.demo) {
          this.store.state.ledger[key] = {
            status: "needs-review",
            error: "Send attempt started; check Phone Link before retry.",
          };
          this.store.saveState();
        }
        this.activity(`Preparing ${dailyRecall ? "6-month Recall" : "reminder"} for ${this.model.patientName(row)}.`);
        try {
          await this.windows.run({
            action: "sms",
            mode: "send",
            phone: this.model.phoneFor(row),
            message,
          });
          if (!this.demo) {
            this.store.state.ledger[key] = { status: "needs-review" };
            this.store.saveState();
            await this.writeLog(row, message, "needs-review");
          }
          completed++;
          this.activity(
            `${this.demo ? "DEMO" : "Needs review"}: ${this.model.patientName(row)}.`,
          );
        } catch (error) {
          failed++;
          this.activity(
            `Automation stopped for ${this.model.patientName(row)}: ${error.message}`,
          );
          // A keyboard/UI error can happen after Send. Keep this row blocked, never auto retry it.
          if (!this.demo)
            await this.writeLog(row, message, "needs-review", error.message);
        }
      }
      const result = { completed, failed, skipped, stopped: this.stopping };
      this.activity(
        `Batch finished: ${completed} prepared, ${failed} need inspection, ${skipped} skipped.`,
      );
      this.emit({ type: "refresh" });
      return result;
    }, scheduled);
  }
  stop() {
    this.stopping = true;
    this.monitoring = false;
    this.recallMonitoring = false;
    this.notify();
    this.activity(
      "Stop requested. The current SMS operation finishes; no next patient will start.",
    );
    return this.status();
  }
  stopMonitoring() {
    return this.stop();
  }
  async startMonitoring() {
    if (this.model.isFD2(this.config, this.machine))
      throw new Error("Monitoring runs on R5. FD2 remains in manual draft mode.");
    if (!this.config.api_token && !this.demo)
      throw new Error("Set the Bridge URL and API token first.");
    if (this.store.state.pendingDraft) throw new Error("Finish the open draft first.");
    this.monitoring = true;
    this.recallMonitoring = true;
    this.stopping = false;
    this.notify();
    this.activity("Monitoring started: daily Appointment + 6-month Recall (D1110 / D4341 / D4342), using patient-language DB templates.");
    return this.status();
  }
  async tick(now = new Date()) {
    if (this.busy || this.monitorBusy || this.store.state.pendingDraft) return;
    const clock = this.model.clinicClock(now, this.config.time_zone);
    // One schedule and Start/Stop; retain per-batch progress to avoid replay after a failure.
    for (const kind of ["appointment", "recall"]) {
      const enabled = kind === "recall" ? "recallMonitoring" : "monitoring";
      const stateKey = kind === "recall" ? "lastRecallSchedule" : "lastSchedule";
      const time = this.config.scheduled_send_time;
      const [hour, minute] = time.split(":").map(Number);
      const target = hour * 60 + minute, key = `${clock.date} ${time}`;
      if (!this[enabled] || Date.now() < (this.scheduleRetry[kind] || 0) ||
          clock.minutes < target || clock.minutes > target + 30 ||
          this.store.state[stateKey] === key) continue;
      this.monitorBusy = true;
      this.activeSchedule = kind;
      this.notify();
      try {
        if (kind === "appointment") {
          for (const offset of new Set([this.config.reminder_days_ahead, 8])) {
            if (!this[enabled]) break;
            const {rows} = await this.load("dashboard", {date:this.model.addDays(clock.date, offset)});
            if (this[enabled]) await this.send(rows, true);
          }
        } else {
          const rows = await this.loadDailyRecall(clock.date);
          this.activity(`Daily 6-month Recall: ${rows.length} patients due today.`);
          if (this[enabled]) await this.send(rows, true);
        }
        if (this[enabled]) {
          this.store.state[stateKey] = key;
          this.store.saveState();
          this.activity(`Daily ${kind} batch complete.`);
        }
      } catch (error) {
        this.activity(`${kind} monitoring error: ${error.message}`);
        this.scheduleRetry[kind] = Date.now() + 60000;
      } finally {
        this.activeSchedule = "";
        this.monitorBusy = false;
        this.notify();
      }
    }
  }
  async resetOrMark(rows, sent) {
    if (this.busy || this.monitorBusy || this.store.state.pendingDraft)
      throw new Error("Finish the current job or draft first.");
    for (const row of rows) {
      if (!this.model.digits(this.model.phoneFor(row))) continue;
      if (sent) {
        if (!["needs-review", "needs review"].includes(row.ReminderStatus) &&
            this.store.state.ledger[this.model.reminderKey(row, this.today)]?.status !== "needs-review") continue;
        const r = this.rowWithTemplate(row, "appointment");
        await this.writeLog(
          r,
          this.model.renderMessage(this.config, r, r._TemplateText, this.today),
          "sent",
        );
        if (!this.demo)
          this.store.state.ledger[this.model.reminderKey(row, this.today)] = {
            status: "sent",
          };
      } else {
        const { body } = this.model.logPayload(row, "", "", this.today);
        const key = this.model.reminderKey(row, this.today);
        if (
          this.store.state.outbox.some(
            (item) =>
              item.path === "/api/sms-reminders/log" &&
              this.model.reminderKey(
                {
                  AptNum: item.body.aptNum,
                  ReminderForDate: item.body.reminderForDate,
                  Phone: item.body.phone,
                  ReminderOffsetDays: item.body.reminderOffsetDays,
                },
                this.today,
              ) === key,
          )
        )
          throw new Error(
            "Synchronize pending logs before resetting this appointment.",
          );
        await this.bridge.request(
          "POST",
          "/api/sms-reminders/reset-log",
          {},
          body,
        );
        delete this.store.state.ledger[this.model.reminderKey(row, this.today)];
        this.store.state.lastSchedule = "";
      }
    }
    this.store.saveState();
    this.emit({ type: "refresh" });
  }
}
module.exports = { SmsService };
