const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Store } = require("./lib/store.cjs");
const { Bridge } = require("./lib/bridge.cjs");
const { DemoBridge } = require("./lib/demo.cjs");
const { WindowsAdapter } = require("./lib/windows.cjs");
const { SmsService } = require("./lib/service.cjs");
let window, service, store, model, timer;
const pendingMonitoringArgs = [process.argv];
let monitoringArgsReady = false, drainingMonitoringArgs = false;
const demo = process.argv.includes("--demo");
app.commandLine.appendSwitch("lang", "en-US");
// Stable data location shared by development and packaged Windows builds.
const userData = path.join(app.getPath("appData"), "LUK Dental SMS Electron");
fs.mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_, args) => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    pendingMonitoringArgs.push(args);
    drainMonitoringArgs().catch((e) => service?.activity(e.message));
  });
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox("SMS startup error", error.message);
      app.quit();
    });
}
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => clearInterval(timer));
async function drainMonitoringArgs() {
  if (!monitoringArgsReady || drainingMonitoringArgs) return;
  drainingMonitoringArgs = true;
  try {
    while (pendingMonitoringArgs.length) {
      try { await applyMonitoringArgs(pendingMonitoringArgs.shift()); }
      catch (error) { service.activity(error.message); }
    }
  } finally { drainingMonitoringArgs = false; }
}
async function applyMonitoringArgs(args) {
  if (!service) return;
  if (args.includes("--stop-reminder-monitoring")) service.stopMonitoring("appointment");
  if (args.includes("--stop-recall-monitoring")) service.stopMonitoring("recall");
  if (args.includes("--start-monitoring") || args.includes("--start-reminder-monitoring")) await service.startMonitoring("appointment");
  if (args.includes("--start-recall-monitoring")) await service.startMonitoring("recall");
  service.tick().catch(e => service.activity(e.message));
}
function emit(event) {
  if (store && event.type === "activity") {
    const logFile = path.join(store.dir, "scheduler-run.log");
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) {
        fs.renameSync(logFile, `${logFile}.previous`);
      }
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${event.message}\n`, { mode: 0o600 });
    } catch { /* Activity stays visible even if Windows blocks log-file writes. */ }
  }
  if (window && !window.isDestroyed())
    window.webContents.send("sms:event", event);
}
async function start() {
  model = await import("./shared/model.mjs");
  const configDir = path.join(app.getPath("userData"), demo ? "demo" : "workstation");
  const firstLaunch = !fs.existsSync(path.join(configDir, "sms_config.json"));
  store = new Store(
    configDir,
    model.DEFAULTS,
  );
  const resourceDir = app.isPackaged
    ? path.join(process.resourcesPath, "windows")
    : path.join(__dirname, "windows");
  service = new SmsService({
    store,
    bridge: demo ? new DemoBridge(model) : new Bridge(() => store.config),
    windows: new WindowsAdapter(resourceDir, emit, demo),
    model,
    machine: process.env.COMPUTERNAME || os.hostname(),
    emit,
    demo,
  });
  // A private deployment config beside the EXE seeds only a new workstation.
  // Existing settings always win; credentials stay outside the app archive.
  const deploymentConfig = path.join(path.dirname(process.execPath), "sms_config.json");
  if (app.isPackaged && !demo && firstLaunch && fs.existsSync(deploymentConfig)) {
    saveConfig(JSON.parse(fs.readFileSync(deploymentConfig, "utf8")));
  }
  window = new BrowserWindow({
    width: 1680,
    height: 980,
    minWidth: 1050,
    minHeight: 700,
    title: "LUK Dental SMS Reminder Tool — Electron",
    backgroundColor: "#f7fbfd",
    icon: path.join(__dirname, "assets/tooth.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  window.on("close", (event) => {
    if (
      service.busy ||
      service.store.state.pendingDraft ||
      service.monitorBusy
    ) {
      const choice = dialog.showMessageBoxSync(window, {
        type: "warning",
        buttons: ["Keep open", "Quit"],
        defaultId: 0,
        cancelId: 0,
        message: "A job or draft is still open.",
        detail:
          "Quitting can interrupt an SMS attempt. Inspect Phone Link before retrying. Pending draft state is saved locally.",
      });
      if (choice === 0) event.preventDefault();
    }
  });
  ipcMain.handle("sms:call", async (event, action, payload = {}) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("Untrusted caller.");
    try {
      return { ok: true, data: await dispatch(action, payload, resourceDir) };
    } catch (error) {
      service.activity(error.message);
      return { ok: false, error: error.message };
    }
  });
  await window.loadFile(path.join(__dirname, "renderer/index.html"));
  service.activity(`Electron ${app.getVersion()} started on ${service.machine}; ${demo ? "demo" : "real SMS"} mode. Clinic zone: ${store.config.time_zone}.`);
  timer = setInterval(
    () => service.tick().catch((e) => service.activity(e.message)),
    15000,
  );
  setTimeout(() => { monitoringArgsReady = true; drainMonitoringArgs().catch(e => service.activity(e.message)); }, 2000);
  if (process.argv.includes("--smoke"))
    setTimeout(async () => {
      const result = await window.webContents.executeJavaScript(
        '({tabs:document.querySelectorAll("nav button").length,rows:document.querySelectorAll("tbody tr[data-row]").length,error:document.querySelector("#fatal")?.textContent||""})',
      );
      process.stdout.write(JSON.stringify(result) + "\n");
      const screenshot = process.argv.find((a) =>
        a.startsWith("--screenshot="),
      );
      if (screenshot)
        fs.writeFileSync(
          screenshot.slice(13),
          (await window.webContents.capturePage()).toPNG(),
        );
      app.exit(result.tabs === 10 && !result.error ? 0 : 1);
    }, 2500);
}
function publicConfig() {
  const { api_token, ...config } = store.config;
  return { ...config, api_token_present: !!api_token };
}
const schedulerFields = { enableLogin: "ENABLE_LOGIN_TIME", restart: "RESTART_TIME", startTool: "START_TOOL_TIME", lock: "LOCK_TIME" };
function schedulerBatPath() {
  return path.join(app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, "windows"), "scheduler-on.bat");
}
function readSchedulerTimes() {
  const times = { enableLogin: "08:59", restart: "09:00", startTool: "10:55", lock: "12:05", ...store.state.schedulerTimes };
  const file = schedulerBatPath();
  if (!demo && fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    for (const [key, variable] of Object.entries(schedulerFields)) {
      const match = text.match(new RegExp(`^set "${variable}=(\\d{2}:\\d{2})"`, "im"));
      if (match) times[key] = match[1];
    }
  }
  return times;
}
function saveConfig(input) {
  if (
    service.busy ||
    service.monitoring || service.recallMonitoring ||
    service.monitorBusy ||
    store.state.pendingDraft
  )
    throw new Error(
      "Stop Monitoring and finish the current job or draft before changing settings.",
    );
  const next = { ...store.config };
  for (const key of Object.keys(model.DEFAULTS))
    if (key in input) next[key] = input[key];
  if (!next.api_token || next.api_token === "••••••••")
    next.api_token = store.config.api_token;
  const url = new URL(next.bridge_url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Use an HTTP/HTTPS Bridge URL.");
  if (![next.scheduled_send_time].every(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))
    throw new Error("Send time must be HH:MM.");
  new Intl.DateTimeFormat("en", { timeZone: next.time_zone });
  if (!["auto", "r5", "fd2"].includes(next.workstation_mode))
    throw new Error("Invalid workstation mode.");
  for (const [key, min, max] of [
    ["reminder_days_ahead", 0, 30],
    ["recall_months", 1, 60],
    ["treatment_days", 0, 365],
    ["fallback_duration_minutes", 5, 240],
  ]) {
    if (
      !Number.isInteger(Number(next[key])) ||
      next[key] < min ||
      next[key] > max
    )
      throw new Error(`${key} must be between ${min} and ${max}.`);
    next[key] = Number(next[key]);
  }
  if (
    !Array.isArray(next.appointment_statuses) ||
    !next.appointment_statuses.length ||
    next.appointment_statuses.some(
      (v) => !Number.isInteger(v) || v < 1 || v > 8,
    )
  )
    throw new Error("Appointment statuses must be numbers 1–8.");
  next.dry_run = false;
  store.config = next;
  store.saveConfig();
  service.notify();
  return publicConfig();
}
async function dispatch(action, p, resources) {
  switch (action) {
    case "init":
      return {
        config: publicConfig(),
        status: service.status(),
        dataDir: store.dir,
        platform: process.platform,
        columns: store.state.columns,
        schedulerTimes: readSchedulerTimes(),
        version: app.getVersion(),
      };
    case "save-config":
      return saveConfig(p);
    case "save-filters": {
      for (const [key,min,max] of [["recall_months",1,60],["treatment_days",0,365]])
        if (key in p && (!Number.isInteger(p[key]) || p[key] < min || p[key] > max)) throw new Error(`Invalid ${key}.`);
      for (const key of ["recall_months", "recall_codes", "treatment_days", "treatment_codes", "treatment_statuses"])
        if (key in p) store.config[key] = p[key];
      store.saveConfig();
      return publicConfig();
    }
    case "scheduler-times": {
      for (const key of ["enableLogin", "restart", "startTool", "lock"])
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(p[key])) throw new Error("Scheduler times must use HH:MM.");
      store.state.schedulerTimes = Object.fromEntries(["enableLogin", "restart", "startTool", "lock"].map(k => [k, p[k]]));
      if (!demo && fs.existsSync(schedulerBatPath())) {
        let text = fs.readFileSync(schedulerBatPath(), "utf8");
        for (const [key, variable] of Object.entries(schedulerFields))
          text = text.replace(new RegExp(`^set "${variable}=\\d{2}:\\d{2}"`, "im"), `set "${variable}=${p[key]}"`);
        fs.writeFileSync(schedulerBatPath(), text);
      }
      store.saveState();
      return store.state.schedulerTimes;
    }
    case "load-scheduler-times": return readSchedulerTimes();
    case "import-config": {
      const result = await dialog.showOpenDialog(window, {
        title: "Import existing Python sms_config.json",
        properties: ["openFile"],
        filters: [{ name: "JSON config", extensions: ["json"] }],
      });
      if (result.canceled) return null;
      return saveConfig(
        JSON.parse(fs.readFileSync(result.filePaths[0], "utf8")),
      );
    }
    case "test-bridge":
      await service.bridge.request("GET", "/health");
      return { connected: true };
    case "load":
      if (
        ![
          "dashboard",
          "patient",
          "recall",
          "treatment",
          "review",
          "holiday",
          "logs",
        ].includes(p.kind)
      )
        throw new Error("Unknown tab.");
      return service.load(p.kind, p.options);
    case "templates":
      return service.templates(p.seed === true);
    case "template-write": {
      if (service.busy || service.monitorBusy || store.state.pendingDraft)
        throw new Error(
          "Finish the current job/draft before editing templates.",
        );
      if (
        !["POST", "PUT", "DELETE"].includes(p.method) ||
        !model.CATEGORIES.includes(p.category)
      )
        throw new Error("Invalid template operation.");
      if (!String(p.templateKey || "").trim())
        throw new Error("Template key is required.");
      p.templateKey = p.templateKey.trim().toUpperCase();
      if (p.method === "DELETE" && (p.templateKey === "US" || Object.keys(service.library.templates[p.category] || {}).length <= 1))
        throw new Error("The default US template and the last template must remain available.");
      if (p.method !== "DELETE" && !String(p.templateText || "").trim()) throw new Error("Template message is required.");
      if (p.method === "POST" && service.library.templates[p.category]?.[p.templateKey]) throw new Error("That template already exists.");
      if (p.method === "PUT" && p.oldKey === "US" && p.templateKey !== "US") throw new Error("Keep the default US template key. Use Add template for a new key.");
      await service.bridge.request(
        p.method,
        "/api/sms-templates",
        {},
        {
          templateKey: p.templateKey,
          category: p.category,
          country: p.country,
          templateText: p.templateText,
        },
      );
      if (p.method === "PUT" && p.oldKey && p.oldKey !== p.templateKey && service.library.templates[p.category]?.[p.oldKey])
        await service.bridge.request("DELETE", "/api/sms-templates", {}, { templateKey: p.oldKey, category: p.category });
      return service.templates();
    }
    case "sms-setting": {
      if (!["review_link", "holiday_events"].includes(p.key))
        throw new Error("Unsupported setting.");
      await service.bridge.request(
        "PUT",
        "/api/sms-settings",
        {},
        { settingKey: p.key, settingValue: p.value },
      );
      service.smsSettings[p.key] = p.value;
      return {};
    }
    case "history":
      return (
        (
          await service.bridge.request(
            "GET",
            "/api/sms-reminders/patient-history",
            { patNum: p.patNum, limit: 200 },
          )
        ).history || []
      );
    case "compose":
      return service.compose(p.row, p.category, p.loggable !== false, p.testOnly === true && p.loggable === false);
    case "confirm-draft":
      return service.confirmDraft(p.id, p.sent === true);
    case "send": {
      if (!Array.isArray(p.rows) || !p.rows.length)
        throw new Error("Select at least one appointment.");
      const response = await dialog.showMessageBox(window, {
        type: "question",
        buttons: ["Cancel", "Send real SMS"],
        defaultId: 0,
        cancelId: 0,
        message: demo
          ? "Simulate appointment sending?"
          : `Send ${p.rows.length} appointment reminders through Phone Link?`,
        detail: "Each result will require inspection before marking it sent.",
      });
      if (response.response !== 1) return { cancelled: true };
      return service.send(p.rows);
    }
    case "mark":
    case "reset": {
      const response = await dialog.showMessageBox(window, {
        type: "warning",
        buttons: [
          "Cancel",
          action === "mark" ? "Confirmed sent" : "Reset to not sent",
        ],
        defaultId: 0,
        cancelId: 0,
        message:
          action === "mark"
            ? "Confirm these messages were sent in Phone Link."
            : "Reset these reminders so they can be sent again?",
      });
      if (response.response !== 1) return { cancelled: true };
      await service.resetOrMark(p.rows, action === "mark");
      return {};
    }
    case "clear-dry-run": {
      if (service.busy || service.monitorBusy)
        throw new Error("Wait for the current job to finish.");
      const choice = await dialog.showMessageBox(window, {
        type: "warning",
        buttons: ["Cancel", "Clear dry-run logs"],
        defaultId: 0,
        cancelId: 0,
        message: "Remove dry-run logs from the Bridge?",
      });
      return choice.response === 1
        ? service.bridge.request("POST", "/api/sms-reminders/clear-dry-run")
        : {};
    }
    case "start-monitoring":
      return service.startMonitoring("appointment");
    case "start-recall-monitoring":
      return service.startMonitoring("recall");
    case "stop-appointment-monitoring":
      return service.stopMonitoring("appointment");
    case "stop-recall-monitoring":
      return service.stopMonitoring("recall");
    case "stop":
      return service.stop();
    case "sync":
      return service.syncOutbox();
    case "native": {
      if (!["open-phone", "view-patient", "snapshot"].includes(p.action))
        throw new Error("Unknown Windows operation.");
      const result = await service.exclusive(() =>
        service.windows.run({ action: p.action, patient: p.patient }),
      );
      if (p.action === "snapshot") {
        store.write("phone-link-snapshot.json", result);
        result.savedTo = path.join(store.dir, "phone-link-snapshot.json");
      }
      return result;
    }
    case "test-sms": {
      if (model.isFD2(service.config, service.machine))
        throw new Error("Use Test selected (no send) on FD2.");
      const choice = await dialog.showMessageBox(window, {
        type: "question",
        buttons: ["Cancel", "Send real test SMS"],
        defaultId: 0,
        cancelId: 0,
        message: `Send a real test SMS to ${p.phone}?`,
      });
      if (choice.response !== 1) return {};
      return service.exclusive(() =>
        service.windows.run({
          action: "sms",
          mode: "send",
          phone: String(p.phone || ""),
          message: String(p.message || ""),
        }),
      );
    }
    case "columns":
      store.state.columns[p.kind] = p.widths;
      store.saveState();
      return {};
    case "open-data":
      await shell.openPath(store.dir);
      return {};
    case "scheduler":
      return scheduler(p, resources);
    default:
      throw new Error("Unsupported app operation.");
  }
}
async function scheduler(p, resources) {
  if (demo || process.platform !== "win32" || !app.isPackaged)
    throw new Error("Scheduler setup requires the packaged Windows app.");
  if (service.busy || service.monitoring || service.recallMonitoring || store.state.pendingDraft)
    throw new Error(
      "Finish jobs and stop Monitoring before setting up Windows tasks.",
    );
  if (!["on", "off"].includes(p.mode))
    throw new Error("Invalid scheduler action.");
  if (p.mode === "on" && model.isFD2(service.config, service.machine))
    throw new Error("Configure automatic tasks on R5. FD2 uses manual drafts.");
  const config = { mode: p.mode, exe: process.execPath, autoStartReminder: p.autoStartReminder !== false };
  if (p.mode === "on") {
    for (const key of ["enableLogin", "restart", "startTool", "lock"]) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(p[key]))
        throw new Error("Scheduler times must use HH:MM.");
      config[key] = p[key];
    }
    const picked = await dialog.showOpenDialog(window, {
      title: "Select Microsoft Sysinternals Autologon64.exe",
      properties: ["openFile"],
      filters: [{ name: "Autologon", extensions: ["exe"] }],
    });
    if (picked.canceled) return { cancelled: true };
    config.autologon = picked.filePaths[0];
  }
  const choice = await dialog.showMessageBox(window, {
    type: "warning",
    buttons: ["Cancel", "Continue to Windows setup"],
    defaultId: 0,
    cancelId: 0,
    message:
      p.mode === "on"
        ? "Create daily auto-login, restart, monitoring and lock tasks?"
        : "Remove Electron scheduler tasks?",
    detail:
      "This opens an Administrator prompt. Use the real Windows password. Disable the old Python scheduler before enabling this scheduler. Times use the Windows time zone.",
  });
  if (choice.response !== 1) return { cancelled: true };
  const configPath = path.join(store.dir, "scheduler-setup.json");
  store.write("scheduler-setup.json", config);
  const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const args = `-NoProfile -ExecutionPolicy Bypass -File "${path.join(resources, "scheduler.ps1")}" -ConfigPath "${configPath}"`;
  const script = `$p=Start-Process powershell.exe -Verb RunAs -ArgumentList ${quote(args)} -Wait -PassThru; exit $p.ExitCode`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve({ configured: true })
        : reject(new Error("Windows scheduler setup failed or was cancelled.")),
    );
  });
}
