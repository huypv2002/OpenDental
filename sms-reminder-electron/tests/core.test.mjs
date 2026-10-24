import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as model from "../shared/model.mjs";
import serviceModule from "../lib/service.cjs";
import bridgeModule from "../lib/bridge.cjs";
import storeModule from "../lib/store.cjs";
const { SmsService } = serviceModule,
  { Bridge } = bridgeModule,
  { Store } = storeModule;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const row = (id = 1, extra = {}) => ({
  AptNum: id,
  PatNum: id + 100,
  FName: "Alex",
  LName: "Demo",
  WirelessPhone: "(281) 555-1000",
  AptDateTime: "2026-10-12 09:30:00",
  Gender: 0,
  Language: "English",
  ...extra,
});
function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luk-electron-test-"));
  const store = new Store(dir, {
    ...model.DEFAULTS,
    api_token: "test-only-token",
    ...options.config,
  });
  const events = [],
    native = [],
    requests = [];
  const bridge = {
    async request(method, route, params, body) {
      requests.push({ method, route, params, body });
      if (options.request) return options.request(method, route, params, body);
      return {};
    },
  };
  const windows = {
    async run(payload) {
      native.push(payload);
      if (options.native) return options.native(payload);
      return { ok: true };
    },
  };
  const service = new SmsService({
    store,
    bridge,
    windows,
    model,
    machine: options.machine || "R5",
    emit: (e) => events.push(e),
    demo: options.demo || false,
  });
  service.library = {
    templates: {
      appointment: {
        US: "Hello {first_name}, {relative_day} at {time_lower}.",
      },
      recall: { US: "Recall {first_name}" },
      treatment: { US: "Treatment {first_name}" },
      holiday_birthday: { US_HOLIDAY: "Happy {holiday_name}" },
      review_google: { US: "Review {review_link}" },
    },
    countries: {},
  };
  return {
    service,
    store,
    events,
    native,
    requests,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
async function using(options, fn) {
  const f = fixture(options);
  try {
    await fn(f);
  } finally {
    f.cleanup();
  }
}
test("clinic clock follows Houston DST instead of the Mac/Windows host zone", () => {
  assert.deepEqual(model.clinicClock(new Date("2026-07-10T16:00:00Z")), {
    date: "2026-07-10",
    time: "11:00",
    minutes: 660,
  });
  assert.equal(
    model.clinicClock(new Date("2026-12-10T17:00:00Z")).time,
    "11:00",
  );
});
test("dates cross month/year boundaries without DST drift", () => {
  assert.equal(model.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(model.addDays("2026-03-07", 8), "2026-03-15");
});
test("Wireless only: work and home numbers do not become SMS targets", () => {
  assert.equal(
    model.phoneFor({ HmPhone: "123", WkPhone: "456", Phone: "456" }),
    "",
  );
  assert.equal(
    model.phoneFor({ _AllowManualPhoneTarget: true, Phone: "789" }),
    "789",
  );
});
test("language and campaign templates preserve US/VI/ES choices", () => {
  const templates = {
    appointment: { US: "", VI: "", ES: "" },
    holiday_birthday: { VI_BIRTHDAY: "", VI_HOLIDAY: "" },
  };
  assert.equal(model.pickTemplate(templates, { Language: "Vietnamese" }), "VI");
  assert.equal(model.pickTemplate(templates, { Language: "español" }), "ES");
  assert.equal(
    model.pickTemplate(
      templates,
      { Language: "Vietnamese", _CampaignType: "birthday" },
      "holiday_birthday",
    ),
    "VI_BIRTHDAY",
  );
});
test("template values preserve original English/Vietnamese date and salutation semantics", () => {
  const r = row(1, {
    Birthdate: "1980-01-01",
    _TemplateCountry: "VI",
    _ReminderOffsetDays: 1,
  });
  assert.equal(
    model.renderMessage(
      model.DEFAULTS,
      r,
      "{formal_first_name}|{vi_salutation}|{weekday_vi}|{date_full}|{time_lower}|{relative_day}",
      "2026-10-11",
    ),
    "Mr. Alex|anh Alex|Thứ 2|10/12/2026|9:30 am|tomorrow",
  );
});
test("unknown placeholders and escaped braces survive; explicit custom defaults render", () => {
  assert.equal(
    model.renderMessage(
      model.DEFAULTS,
      row(),
      "{unknown} {{first_name}} {custom_hello} {password_default-value}",
      "2026-10-11",
    ),
    "{unknown} {first_name} hello default-value",
  );
});
test("patient # search is exact and appointment context requirements are recognized", () => {
  assert.equal(model.matchesSearch(row(), "#101"), true);
  assert.equal(model.matchesSearch(row(), "#10"), false);
  assert.equal(model.hasAppointmentFields("at {time_lower}"), true);
});
test("reminder logs distinguish 1-day and 8-day sends", () => {
  const r = row(1, { _ReminderOffsetDays: 1 }),
    logs = [
      {
        AptNum: 1,
        ReminderForDate: "2026-10-12",
        Phone: "2815551000",
        ReminderOffsetDays: 8,
        Status: "sent",
      },
    ];
  assert.equal(
    model.expandAppointments([r], logs, "2026-10-11")[0].ReminderStatus,
    "",
  );
  logs[0].ReminderOffsetDays = 1;
  assert.equal(
    model.expandAppointments([r], logs, "2026-10-11")[0].ReminderStatus,
    "sent",
  );
});
test("recall operatory exclusion is defensive even if Bridge feed contains it", () => {
  assert.equal(
    model.expandAppointments([row(1, { OpName: " recall " })], [], "2026-10-11")
      .length,
    0,
  );
});
test("R5 sends sequentially, persists needs-review, and skips later stale repeats", () =>
  using({}, async (f) => {
    await f.service.send([row(1), row(2)]);
    assert.equal(f.native.length, 2);
    assert.equal(f.requests.filter((r) => r.route.endsWith("/log")).length, 2);
    assert.equal(f.requests[0].body.status, "needs-review");
    await f.service.send([row(1)]);
    assert.equal(f.native.length, 2);
  }));
test("sent and needs-review rows never auto-send", () =>
  using({}, async (f) => {
    await f.service.send([
      row(1, { ReminderStatus: "sent" }),
      row(2, { ReminderStatus: "needs-review" }),
    ]);
    assert.equal(f.native.length, 0);
  }));
test("FD2 cannot use the automated R5 send or monitoring paths", () =>
  using({ machine: "FD2-FrontDesk" }, async (f) => {
    await assert.rejects(f.service.send([row()]), /FD2/);
    await assert.rejects(f.service.startMonitoring(), /R5/);
    assert.equal(f.native.length, 0);
  }));
test("no-send draft creates no Bridge log until staff confirms", () =>
  using({}, async (f) => {
    const draft = await f.service.compose(row(), "appointment");
    assert.equal(f.native[0].mode, "draft");
    assert.equal(f.requests.length, 0);
    await f.service.confirmDraft(draft.id, true);
    assert.equal(f.requests[0].body.status, "sent");
    assert.equal(f.store.state.pendingDraft, null);
  }));
test("Not sent and failed compose leave no sent log", () =>
  using({}, async (f) => {
    const draft = await f.service.compose(row());
    await f.service.confirmDraft(draft.id, false);
    assert.equal(f.requests.length, 0);
  }));
test("draft with missing datetime cannot use appointment placeholders", () =>
  using({}, async (f) => {
    await assert.rejects(
      f.service.compose(row(1, { AptDateTime: "" })),
      /date\/time/,
    );
    assert.equal(f.native.length, 0);
  }));
test("pending draft blocks another job and survives app restart", () =>
  using({}, async (f) => {
    await f.service.compose(row());
    await assert.rejects(f.service.send([row(2)]), /open draft/);
    const restarted = new Store(f.store.dir, model.DEFAULTS);
    assert.ok(restarted.state.pendingDraft?.id);
  }));
test("Bridge outage stores an outbox and keeps successful UI attempts blocked", () =>
  using(
    {
      request: () => {
        throw new Error("offline");
      },
    },
    async (f) => {
      await f.service.send([row()]);
      assert.equal(f.store.state.outbox.length, 1);
      assert.equal(f.store.state.outbox[0].body.status, "needs-review");
      await f.service.send([row()]);
      assert.equal(f.native.length, 1);
    },
  ));
test("uncertain UI errors require review and do not re-send on the next check", () =>
  using(
    {
      native: () => {
        throw new Error("focus lost after Enter");
      },
    },
    async (f) => {
      await f.service.send([row()]);
      await f.service.send([row()]);
      assert.equal(f.native.length, 1);
      assert.equal(f.requests[0].body.status, "needs-review");
    },
  ));
test("marking an offline reminder sent supersedes its pending needs-review log", () =>
  using(
    {
      request: () => {
        throw new Error("offline");
      },
    },
    async (f) => {
      await f.service.send([row()]);
      await f.service.resetOrMark([row()], true);
      assert.equal(f.store.state.outbox.length, 1);
      assert.equal(f.store.state.outbox[0].body.status, "sent");
    },
  ));
test("reset cannot race an unsynchronized reminder log", () =>
  using(
    {
      request: () => {
        throw new Error("offline");
      },
    },
    async (f) => {
      await f.service.send([row()]);
      await assert.rejects(
        f.service.resetOrMark([row()], false),
        /Synchronize/,
      );
    },
  ));
test("concurrent jobs cannot steal Phone Link from a daily batch", () =>
  using({}, async (f) => {
    f.service.monitorBusy = true;
    await assert.rejects(f.service.compose(row()), /monitoring batch/);
    assert.equal(f.native.length, 0);
  }));
test("Stop finishes one operation and prevents the next patient", () =>
  using({}, async (f) => {
    f.service.windows.run = async (payload) => {
      f.native.push(payload);
      f.service.stop();
      return { ok: true };
    };
    const result = await f.service.send([row(1), row(2)]);
    assert.equal(f.native.length, 1);
    assert.equal(result.stopped, true);
  }));
test("monitoring runs configured and 8-day dates once, and ignores late startup", () =>
  using({}, async (f) => {
    const dates = [];
    f.service.load = async (_, options) => {
      dates.push(options.date);
      return { rows: [] };
    };
    const recallDates=[];
    f.service.loadDailyRecall=async date=>{recallDates.push(date);return [];};
    await f.service.startMonitoring();
    await f.service.tick(new Date("2026-10-11T16:00:00Z"));
    await f.service.tick(new Date("2026-10-11T16:10:00Z"));
    assert.deepEqual(dates, ["2026-10-12", "2026-10-19"]);
    assert.deepEqual(recallDates,[]);
    assert.equal(f.store.state.lastSchedule,"2026-10-11 11:00");
    f.store.state.lastSchedule = "";
    await f.service.tick(new Date("2026-10-11T16:31:00Z"));
    assert.equal(dates.length, 2);
  }));
test("demo confirmations cannot change production Bridge logs", () =>
  using({ demo: true }, async (f) => {
    const draft = await f.service.compose(row());
    await f.service.confirmDraft(draft.id, true);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.store.state.ledger, {});
  }));
test("Bridge attaches Bearer auth and rejects arbitrary paths and redirects", async () => {
  const requests = [];
  const bridge = new Bridge(
    () => ({ ...model.DEFAULTS, api_token: "test" }),
    async (url, options) => {
      requests.push({ url: String(url), options });
      return { ok: true, json: async () => ({ ok: true, data: {} }) };
    },
  );
  await bridge.request("GET", "/api/sms-reminders/logs", {
    date: "2026-10-11",
  });
  assert.equal(requests[0].options.headers.Authorization, "Bearer test");
  assert.equal(requests[0].options.redirect, "error");
  await assert.rejects(
    bridge.request("GET", "https://other.example"),
    /Unsupported/,
  );
});
test("Python no-send test permits missing datetime and never creates a sent log", () =>
  using({}, async f => {
    const result=await f.service.compose(row(1,{_Kind:"patient",AptDateTime:""}),"appointment",false,true);
    assert.ok(result.message); assert.equal(f.native.length,1);
    assert.equal(f.native[0].mode,"draft"); assert.equal(f.native[0].fd2,true);
    assert.equal(f.requests.length,0); assert.equal(f.store.state.pendingDraft,null);
  }));
test("normal manual fill still requires appointment fields, including unlogged review drafts", () =>
  using({}, async f => {
    await assert.rejects(f.service.compose(row(1,{AptDateTime:""}),"appointment",false),/date\/time/);
    assert.equal(f.native.length,0);
  }));
test("Mark sent affects only review attempts; resetting clears the completed schedule", () =>
  using({}, async f => {
    await f.service.resetOrMark([row()],true);assert.equal(f.requests.length,0);
    await f.service.resetOrMark([row(1,{ReminderStatus:"needs review"})],true);
    assert.equal(f.requests[0].body.status,"sent");
    f.store.state.lastSchedule="completed";
    await f.service.resetOrMark([row()],false);assert.equal(f.store.state.lastSchedule,"");
  }));
test("Python phone normalization strips US country prefix and rejects malformed wireless numbers", () => {
  assert.equal(model.digits("+1 (281) 555-0101"),"2815550101");
  assert.equal(model.phoneFor({WirelessPhone:"+1 (281) 555-0101"}),"(281) 555-0101");
  assert.equal(model.phoneFor({WirelessPhone:"281932002",HmPhone:"2815550101"}),"");
  assert.equal(model.phoneFor({_AllowManualPhoneTarget:true,Phone:"281932002"}),"281932002");
});
test("Patient search remains available when fallback appointment feed fails", () =>
  using({request:async (_method,route) => {if(route==="/api/admin/patients")return {patients:[row(1,{AptDateTime:""})]};throw Error("appointment feed down");}},async f=>{
    const data=await f.service.load("patient",{query:"Alex"});assert.equal(data.rows.length,1);
    assert.equal(data.rows[0].AptDateTime,"");
  }));
test("Birthday campaign uses the selected date for campaign and holiday placeholders", () =>
  using({request:async()=>({patients:[row()]})},async f=>{
    const data=await f.service.load("holiday",{type:"birthday",date:"2026-10-15"});
    assert.equal(data.rows[0]._CampaignName,"10/15/2026");assert.equal(data.rows[0]._HolidayName,"10/15/2026");
  }));
test("Each manual category records the same Bridge route after staff confirmation", () =>
  using({},async f=>{
    for(const [kind,category,route] of [["patient","appointment","patient-log"],["recall","recall","recall-log"],["treatment","treatment","treatment-log"],["holiday","holiday_birthday","campaign-log"]]){
      f.service.library.templates[category]={US:"Hello {first_name}"};
      const draft=await f.service.compose(row(1,{_Kind:kind,_TemplateKey:"US",_CampaignType:"holiday",_CampaignName:"Demo"}),category);
      await f.service.confirmDraft(draft.id,true);
      assert.equal(f.requests.at(-1).route,"/api/sms-reminders/"+route);assert.equal(f.requests.at(-1).body.status,"sent");
    }
  }));
test("daily Recall loads exact-date contract, all pages, and language templates with no appointment dependency",()=>using({
  request:async(method,route,params)=>{
    assert.equal(route,"/api/sms-reminders/recall-candidates");assert.equal(params.mode,"daily");
    return {contract:"calendar-6-month-v2",date:params.date,patients:params.afterPatNum?[
      row(501,{PatNum:501,Language:"Vietnamese",AptDateTime:"",LastProcDate:"2026-04-23"})
    ]:Array.from({length:500},(_,i)=>row(i+1,{PatNum:i+1,Language:i%2?"Spanish":"English",AptDateTime:"",LastProcDate:"2026-04-23"}))};
  }
},async f=>{
  f.service.library.templates.recall={US:"EN {first_name}",ES:"ES {first_name}",VI:"VI {first_name}"};
  const rows=await f.service.loadDailyRecall("2026-10-23");assert.equal(rows.length,501);
  assert.deepEqual([rows[0]._TemplateKey,rows[1]._TemplateKey,rows.at(-1)._TemplateKey],["US","ES","VI"]);
  assert.deepEqual(f.requests.map(r=>r.params.afterPatNum),[0,500]);
  assert.ok(rows.every(r=>r._Kind==="recall"&&r._DailyRecallDate==="2026-10-23"));
}));
test("old Bridge and missing-language Recall templates block automatic sending",()=>using({request:async()=>({patients:[]})},async f=>{
  await assert.rejects(f.service.loadDailyRecall("2026-10-23"),/Update SERVER/);assert.equal(f.native.length,0);
  f.service.bridge.request=async()=>({contract:"calendar-6-month-v2",date:"2026-10-23",patients:[row(1,{Language:"Spanish",LastProcDate:"2026-04-23"})]});
  await assert.rejects(f.service.loadDailyRecall("2026-10-23"),/Missing ES/);assert.equal(f.native.length,0);
  f.service.library.templates.recall.ES="Cita {date_full}";
  await assert.rejects(f.service.loadDailyRecall("2026-10-23"),/appointment fields/);
}));
test("daily Recall reserves before Phone Link, logs Recall token and reuses local/server duplicate guards",()=>using({
 request:async(method,route)=>route.endsWith("recall-claim")?{claimed:true,token:"dispatch-test"}:{}
},async f=>{
 const target=row(1,{_Kind:"recall",_DailyRecall:true,_DailyRecallDate:"2026-10-23",LastProcDate:"2026-04-23",AptNum:null,AptDateTime:""});
 f.service.recallMonitoring=true;
 const result=await f.service.send([target],true);assert.equal(result.completed,1);assert.equal(f.native.length,1);
 assert.equal(f.native[0].message,"Recall Alex");
 assert.equal(f.requests[0].route,"/api/sms-reminders/recall-claim");
 assert.equal(f.requests[1].route,"/api/sms-reminders/recall-log");
 assert.equal(f.requests[1].body.dispatchToken,"dispatch-test");assert.equal(f.requests[1].body.dailyRecall,true);
 assert.equal(f.requests[1].body.status,"needs-review");
 assert.ok(f.requests.every(r=>r.route!=="/api/sms-reminders/log"));
 assert.equal((await f.service.send([target],true)).skipped,1);assert.equal(f.native.length,1);
 f.store.state.ledger={};f.service.bridge.request=async()=>({claimed:false});
 assert.equal((await f.service.send([target],true)).skipped,1);assert.equal(f.native.length,1);
}));
test("uncertain daily Recall stays blocked and failed log sync retries only the log",()=>using({
 request:async(method,route)=>{if(route.endsWith("recall-claim"))return {claimed:true,token:"dispatch-test"};throw Error("Bridge offline");},
 native:async()=>{throw Error("Uncertain send");}
},async f=>{
 const target=row(1,{_Kind:"recall",_DailyRecall:true,_DailyRecallDate:"2026-10-23",LastProcDate:"2026-04-23",AptDateTime:""});
 f.service.recallMonitoring=true;assert.equal((await f.service.send([target],true)).failed,1);
 assert.equal(f.store.state.outbox.length,1);assert.equal(f.store.state.outbox[0].body.dailyRecall,true);
 assert.equal((await f.service.send([target],true)).skipped,1);assert.equal(f.native.length,1);
 f.service.bridge.request=async()=>({});await f.service.syncOutbox();assert.equal(f.store.state.outbox.length,0);assert.equal(f.native.length,1);
}));
test("Appointment and Recall run only when separately enabled and persist independent completion",()=>using({
 request:async(method,route,params)=>{
  if(route.endsWith("recall-candidates"))return {contract:"calendar-6-month-v2",date:params.date,patients:[row(1,{AptDateTime:"",LastProcDate:"2026-04-23"})]};
  if(route.endsWith("recall-claim"))return {claimed:true,token:"dispatch-test"};
  return {appointments:[],logs:[]};
 }
},async f=>{
 await f.service.startMonitoring();await f.service.tick(new Date("2026-10-23T16:00:00Z"));
 assert.equal(f.store.state.lastSchedule,"2026-10-23 11:00");assert.equal(f.native.length,0);
 assert.equal(f.requests.some(r=>r.route.endsWith("recall-candidates")),false);
 await f.service.startMonitoring("recall");
 await f.service.tick(new Date("2026-10-23T16:05:00Z"));
 assert.equal(f.store.state.lastRecallSchedule,"2026-10-23 11:00");assert.equal(f.native.length,1);
 assert.deepEqual(f.requests.filter(r=>r.route.endsWith("appointments")).map(r=>r.params.date),["2026-10-24","2026-10-31"]);
 await f.service.tick(new Date("2026-10-23T16:10:00Z"));assert.equal(f.native.length,1);
}));
test("Recall-only monitoring never loads appointments and respects its own send time",()=>using({config:{recall_send_time:"12:00"}},async f=>{
 const calls=[];f.service.load=async()=>{throw Error("Appointment must not run");};
 f.service.loadDailyRecall=async date=>{calls.push(date);return [];};
 await f.service.startMonitoring("recall");
 await f.service.tick(new Date("2026-10-23T16:00:00Z"));assert.deepEqual(calls,[]);
 await f.service.tick(new Date("2026-10-23T17:00:00Z"));
 assert.deepEqual(calls,["2026-10-23"]);assert.equal(f.store.state.lastSchedule,"");
 assert.equal(f.store.state.lastRecallSchedule,"2026-10-23 12:00");
 await f.service.tick(new Date("2026-10-23T17:01:00Z"));assert.equal(calls.length,1);
}));
test("Stopping one monitoring stream leaves the other enabled",()=>using({},async f=>{
 await f.service.startMonitoring();await f.service.startMonitoring("recall");
 f.service.stopMonitoring("appointment");assert.equal(f.service.monitoring,false);assert.equal(f.service.recallMonitoring,true);
 await f.service.startMonitoring();f.service.stopMonitoring("recall");assert.equal(f.service.monitoring,true);assert.equal(f.service.recallMonitoring,false);
 f.service.stop();assert.equal(f.service.monitoring,false);assert.equal(f.service.recallMonitoring,false);
}));
test("Appointment failure does not block Recall or its completion state",()=>using({},async f=>{
 f.service.load=async()=>{throw Error("appointment feed down");};
 let recall=0;f.service.loadDailyRecall=async()=>{recall++;return [];};
 await f.service.startMonitoring();await f.service.startMonitoring("recall");
 await f.service.tick(new Date("2026-10-23T16:00:00Z"));
 assert.equal(recall,1);assert.equal(f.store.state.lastSchedule,"");assert.equal(f.store.state.lastRecallSchedule,"2026-10-23 11:00");
 assert.ok(f.service.scheduleRetry.appointment);assert.equal(f.service.scheduleRetry.recall,undefined);
}));
test("Stop Recall during an active send finishes only that patient and leaves Appointment running",()=>using({},async f=>{
 await f.service.startMonitoring();await f.service.startMonitoring("recall");
 f.service.demo=true;f.service.library.templates.recall={US:"Hello {first_name}"};
 f.service.windows.run=async payload=>{f.native.push(payload);f.service.stopMonitoring("recall");return {};};
 const rows=[1,2].map(n=>row(n,{_DailyRecall:true,_Kind:"recall",_TemplateKey:"US",LastProcDate:"2026-04-23",AptDateTime:""}));
 const result=await f.service.send(rows,true);
 assert.equal(result.completed,1);assert.equal(f.native.length,1);assert.equal(f.service.monitoring,true);assert.equal(f.service.recallMonitoring,false);
}));
export default cases;
