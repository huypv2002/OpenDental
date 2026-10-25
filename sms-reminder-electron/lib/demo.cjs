// Synthetic demo data. This adapter never connects to a real Bridge.
class DemoBridge {
  constructor(model) {
    this.model = model;
    this.logs = [];
    this.settings = {
      review_link: "https://example.com/review",
      holiday_events: JSON.stringify(model.HOLIDAYS),
    };
    const appointment = {
      US: "Good morning {formal_first_name}, this is {clinic_name}. Your appointment is {relative_day}, {weekday}, {date_full} at {time_lower}. Call {clinic_phone} if you need help.",
      ES: "Hola {salutation}, su cita es {relative_day_es}, {date_full} a las {time_lower}. {clinic_name}",
      VI: "Chào {vi_salutation}, {clinic_name} nhắc lịch hẹn {relative_day_vi}, {weekday_vi} {date_full} lúc {time_lower}.",
      US_TODAY:
        "Hello {first_name}, your appointment today is at {time_lower}. Thank you!",
    };
    Object.assign(appointment, {
      "6M RECALL - EN":"Hello {first_name}, it is time for your six-month dental cleaning. Call {clinic_phone}.",
      "6M RECALL - ES":"Hola {first_name}, es hora de su limpieza dental. Llame al {clinic_phone}.",
      "6M RECALL - VI":"Chào {first_name}, đã đến kỳ tái khám sáu tháng. Vui lòng gọi {clinic_phone}.",
    });
    this.templates = {
      appointment,
      recall: {
        US: "Hello {first_name}, it is time for your dental cleaning. Please call {clinic_phone}.",
        VI: "Chào {vi_salutation}, đã đến lúc tái khám. Vui lòng gọi {clinic_phone}.",
      },
      treatment: {
        US: "Hello {first_name}, please contact {clinic_name} about your treatment plan: {procedure_codes}.",
      },
      review_google: {
        US: "Thank you for visiting {clinic_name}, {first_name}. Share your experience: {review_link}",
      },
      holiday_birthday: {
        US_HOLIDAY:
          "Happy {holiday_name}, {first_name}! Best wishes from {clinic_name}.",
        US_BIRTHDAY:
          "Happy birthday, {first_name}! Best wishes from {clinic_name}.",
      },
    };
    this.countries = Object.fromEntries(
      Object.entries(this.templates).map(([c, list]) => [
        c,
        Object.fromEntries(Object.keys(list).map((k) => [k, this.model.sixMonthRecallLanguage(k) || k.slice(0, 2)])),
      ]),
    );
  }
  patients(date) {
    return Array.from({ length: 240 }, (_, i) => ({
      PatNum: 1000 + i,
      AptNum: 8000 + i,
      FName: ["Alex", "Taylor", "Jordan", "Sam", "Casey", "Morgan"][i % 6],
      LName: `Demo ${i + 1}`,
      WirelessPhone: `(281) 555-${String(1000 + i).padStart(4, "0")}`,
      WirelessPhoneFormatted: `(281) 555-${String(1000 + i).padStart(4, "0")}`,
      Email: `demo${i + 1}@example.com`,
      Gender: i % 2,
      Language: ["English", "Vietnamese", "Spanish"][i % 3],
      Birthdate: "1987-10-11",
      AptDateTime: `${date} ${String(9 + (Math.floor(i / 24) % 8)).padStart(2, "0")}:${i % 2 ? "30" : "00"}:00`,
      AptStatus: 1,
      OpName: "OP1",
      LastProcDate: "2026-02-01",
      LastPendingProcDate: "2026-08-01",
      LastAppointment: "2026-02-01",
      ProcedureCodes: "D1110",
      ProcedureDescriptions: "Dental cleaning",
      RecallSentCount: 0,
      TreatmentSentCount: 0,
    }));
  }
  async request(method, path, params = {}, body = {}) {
    await new Promise((r) => setTimeout(r, 90));
    if (path === "/health") return { status: "ok" };
    if (path === "/api/sms-templates/init") return {};
    if (path === "/api/sms-templates") {
      if (method === "GET")
        return { templates: this.templates, countries: this.countries };
      if (method === "DELETE") {
        delete this.templates[body.category][body.templateKey];
        delete this.countries[body.category][body.templateKey];
      } else {
        this.templates[body.category][body.templateKey] = body.templateText;
        this.countries[body.category][body.templateKey] = body.country;
      }
      return {};
    }
    if (path === "/api/sms-settings") {
      if (method === "PUT") this.settings[body.settingKey] = body.settingValue;
      return { settings: this.settings };
    }
    if (path.endsWith("/logs")) return { logs: this.logs };
    if (path.endsWith("/patient-history"))
      return {
        history: [
          {
            ActivityAt: "2026-10-10 11:00:00",
            MessageType: "appointment",
            Phone: "(281) 555-1000",
            Status: "sent",
            Message: "Synthetic history message",
            Context: "DEMO",
          },
        ],
      };
    if (path.endsWith("/patient-logs")) return { logs: [] };
    const date = params.date || this.model.clinicClock().date;
    let rows = this.patients(date);
    if (path === "/api/admin/patients" && params.q === "noappointment")
      return { patients: [{ ...rows[0], PatNum: 9997, AptNum: null, AptDateTime: "", FName: "Noappointment", LName: "Demo" }] };
    if (path === "/api/sms-reminders/recall-candidates" && params.mode === "daily") {
      const d = new Date(date + "T12:00:00Z");
      const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 6);
      const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, end));
      return {contract: "calendar-6-month-v2", date, patients: rows.slice(0, 3).map(r => ({...r, AptNum: null, AptDateTime: "", LastProcDate: d.toISOString().slice(0,10), ProcedureCodes: "D1110"}))};
    }
    if (path.endsWith("/appointments")) return { appointments: rows };
    if (params.q)
      rows = rows.filter(
        (r) =>
          this.model.matchesSearch(r, params.q) ||
          String(r.PatNum) === params.q,
      );
    if (path === "/api/admin/patients")
      rows = rows.slice(
        Number(params.offset || 0),
        Number(params.offset || 0) + Number(params.limit || 50),
      );
    if (method === "GET") return { patients: rows };
    return {};
  }
}
module.exports = { DemoBridge };
