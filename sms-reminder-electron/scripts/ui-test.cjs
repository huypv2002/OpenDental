const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
async function run() {
  fs.mkdirSync(path.join(__dirname, "../test-results"), { recursive: true });
  const application = await electron.launch({
    args: [path.join(__dirname, ".."), "--demo"],
    timeout: 30000,
  });
  const page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    // A second scheduled EXE can arrive while the first instance is still loading.
    await application.evaluate(({app}) => app.emit("second-instance", {}, ["--start-recall-monitoring"]));
    await page.waitForFunction(() => document.getElementById("monitor-state")?.textContent === "Running");
    await application.evaluate(({app}) => app.emit("second-instance", {}, ["--stop-recall-monitoring"]));
    await page.waitForFunction(() => document.getElementById("monitor-state").textContent === "Stopped");
    await page.waitForSelector("#stat-0");
    await page.waitForFunction(
      () => document.getElementById("stat-0").textContent === "240",
    );
    assert.equal(await page.locator("nav button").count(), 10);
    assert.ok(
      (await page.locator("#table-dashboard tbody tr[data-row]").count()) < 70,
      "Dashboard should virtualize a 240-row list.",
    );
    const flagInfo=await page.locator("#table-dashboard .row-template").first().evaluate(el=>({appearance:getComputedStyle(el).appearance,selectedFlags:el.querySelectorAll("selectedcontent img.flag").length,flags:[...el.querySelectorAll("option img.flag")].map(img=>({src:img.getAttribute("src"),loaded:img.complete&&img.naturalWidth>0}))}));
    assert.equal(flagInfo.appearance,"base-select");assert.equal(flagInfo.selectedFlags,1);
    assert.ok(flagInfo.flags.length>=3&&flagInfo.flags.every(f=>f.loaded),"All template flag images must load.");
    await page
      .locator("#table-dashboard tbody input[data-select]")
      .first()
      .check();
    await page.click("#preview-dashboard");
    await page.waitForSelector("#modal[open]");
    assert.match(await page.locator("#modal pre").first().innerText(), /appointment/);
    await page.click('[data-modal-result="close"]');
    await page.fill("#search-dashboard", "#1007");
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#table-dashboard tr[data-row]").length === 1,
    );
    assert.match(await page.locator("#table-dashboard").innerText(), /1007/);
    await page.fill("#search-dashboard", "");
    await page.waitForFunction(() =>
      document.getElementById("count-dashboard").textContent.startsWith("240"),
    );
    await page.evaluate(
      () => (document.getElementById("scroll-dashboard").scrollTop = 6000),
    );
    await page.waitForTimeout(150);
    assert.ok(
      (await page.locator("#table-dashboard tr[data-row]").count()) < 70,
    );
    await page.screenshot({
      path: path.join(__dirname, "../test-results/dashboard.png"),
    });
    for (const name of [
      "Patient",
      "Monitoring",
      "Recall",
      "Treatment",
      "Review Google",
      "Holiday & Birthday",
      "Templates",
      "Settings",
      "Logs",
    ]) {
      await page.getByRole("button", { name, exact: true }).first().click();
      await page.waitForTimeout(180);
      assert.equal(await page.locator(".page:visible").count(), 1);
    }
    await page
      .getByRole("button", { name: "Patient", exact: true })
      .first()
      .click();
    // Exercise renderer -> IPC -> service search with synthetic PatNum 70.
    await application.evaluate(async()=>{
      const require=process.mainModule.require.bind(process.mainModule);
      const {DemoBridge}=require('./lib/demo.cjs');
      const original=DemoBridge.prototype.request;
      DemoBridge.prototype.request=async function(method,route,params,...rest){
        if(route==='/api/admin/patients'&&params.q==='#70')return {patients:[{PatNum:70,FName:'Exact',LName:'Patient',WirelessPhone:'2815550070',Language:'English',AptDateTime:'2026-10-12 09:30:00'}]};
        if(route==='/api/admin/patients'&&params.q==='#77777')throw Error('Synthetic Bridge search failure');
        return original.call(this,method,route,params,...rest);
      };
    });
    await page.fill('#search-patient','#70');
    await page.click('#refresh-patient');
    await page.waitForFunction(()=>document.querySelectorAll('#table-patient tr[data-row]').length===1&&document.getElementById('table-patient').textContent.includes('Exact'));
    assert.match(await page.locator('#table-patient').innerText(),/70/);
    await page.fill('#search-patient','#77777');await page.press('#search-patient','Enter');
    await page.waitForFunction(()=>document.getElementById('table-patient').textContent.includes('Search failed: Synthetic Bridge search failure'));
    await page.fill('#search-patient','#0');await page.click('#refresh-patient');
    await page.waitForFunction(()=>document.getElementById('table-patient').textContent.includes('SERVER returned no patient matching #0'));
    await page.fill("#search-patient", "#1007");
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#table-patient tr[data-row]").length === 1,
    );
    await page.locator("#table-patient input[data-select]").first().check();
    await page.locator('#table-patient [data-row-action="history"]').first().click();
    await page.waitForSelector("#modal[open]");assert.match(await page.locator("#modal").innerText(),/Synthetic history/);
    await page.click('[data-modal-result="close"]');
    await page.locator('#table-patient [data-row-action="view"]').first().click();
    await page.waitForFunction(()=>document.getElementById("status-text").textContent.includes("view-patient simulated"));
    await page.click("#compose-patient");
    await page.waitForSelector("#modal[open]");
    assert.match(await page.locator("#modal").innerText(), /Confirm SMS sent/);
    await page.click('[data-modal-result="not-sent"]');
    await page.waitForSelector("#modal", { state: "hidden" });
    await page
      .getByRole("button", { name: "Templates", exact: true })
      .first()
      .click();
    await page.selectOption("#template-category", "recall");
    assert.match(await page.inputValue("#template-text"), /cleaning/);
    // Source parity regression: Python Test creates a draft even without appointment context.
    await page.getByRole("button",{name:"Patient",exact:true}).first().click();
    await page.fill("#search-patient","noappointment");
    await page.waitForFunction(()=>document.getElementById("table-patient").textContent.includes("9997"));
    await page.locator("#table-patient input[data-select]").first().check();
    await page.click("#compose-patient");await page.waitForSelector("#modal[open]");
    assert.match(await page.locator("#modal").innerText(),/appointment not found/i);
    await page.click('[data-modal-result="close"]');
    await page.click("#test-patient");await page.waitForSelector("#modal[open]");
    await page.click('[data-modal-result="yes"]');
    await page.waitForFunction(()=>document.getElementById("toast").textContent.includes("No SMS sent"));
    const statusAfterTest=await page.evaluate(async()=> (await window.sms.call("init")).data.status);
    assert.equal(statusAfterTest.pendingDraft,null);
    await page.screenshot({path:path.join(__dirname,"../test-results/patient-flags.png")});
    await page.getByRole("button",{name:"Review Google",exact:true}).first().click();
    await page.waitForSelector("#table-review input[data-select]");
    await page.locator("#table-review input[data-select]").first().check();
    await page.click("#compose-review");
    await page.waitForFunction(()=>document.getElementById("toast").textContent.includes("Review draft ready"));
    const reviewStatus=await page.evaluate(async()=> (await window.sms.call("init")).data.status);
    assert.equal(reviewStatus.pendingDraft,null);
    // Template create, rename, delete, default protection; fake Bridge only.
    await page.getByRole("button",{name:"Templates",exact:true}).first().click();
    await page.selectOption("#template-category","appointment");
    await page.click("#new-template");await page.fill("#template-key","vi_demo_extra");
    await page.selectOption("#template-country","VI");await page.fill("#template-text","Hello {first_name} — demo");
    await page.click("#add-template");await page.waitForFunction(()=>document.getElementById("template-select").value==="VI_DEMO_EXTRA");
    await page.fill("#template-key","VI_DEMO_RENAMED");await page.click("#save-template");
    await page.waitForFunction(()=>document.getElementById("template-select").value==="VI_DEMO_RENAMED");
    assert.equal(await page.locator('#template-select option[value="VI_DEMO_EXTRA"]').count(),0);
    await page.click("#delete-template");await page.click('[data-modal-result="yes"]');
    await page.waitForFunction(()=>!document.querySelector('#template-select option[value="VI_DEMO_RENAMED"]'));
    const cannotDeleteUS=await page.evaluate(()=>window.sms.call("template-write",{method:"DELETE",category:"appointment",templateKey:"US"}));
    assert.equal(cannotDeleteUS.ok,false);assert.match(cannotDeleteUS.error,/default US/);
    // Manual categories retain the same Next/Not sent confirmations.
    for (const [tab,kind] of [["Recall","recall"],["Treatment","treatment"],["Holiday & Birthday","holiday"]]) {
      await page.getByRole("button",{name:tab,exact:true}).first().click();
      await page.waitForSelector(`#table-${kind} input[data-select]`);
      await page.click(`#templates-${kind}`);await page.waitForSelector("#modal[open]");
      assert.equal(await page.inputValue("#template-category"),kind==="holiday"?"holiday_birthday":kind);
      assert.equal(await page.isDisabled("#template-category"),true);
      // Nested confirmation must return to the template popup without losing its editor.
      await page.click("#delete-template");await page.waitForSelector('[data-modal-result="cancel"]');
      await page.click('[data-modal-result="cancel"]');
      assert.equal(await page.locator("#modal #template-country").count(),1);
      await page.click('[data-modal-result="close"]');await page.waitForSelector("#modal",{state:"hidden"});
      await page.locator(`#table-${kind} input[data-select]`).first().check();
      await page.click(`#compose-${kind}`);await page.waitForSelector("#modal[open]");
      assert.match(await page.locator("#modal").innerText(),/Confirm SMS sent/);
      await page.click('[data-modal-result="not-sent"]');await page.waitForSelector("#modal",{state:"hidden"});
    }
    await page.getByRole("button",{name:"Holiday & Birthday",exact:true}).first().click();
    await page.selectOption("#campaign-type","birthday");await page.waitForSelector("#table-holiday input[data-select]");
    assert.equal(await page.isDisabled("#add-holiday"),true);
    await page.fill("#birthday-date","2026-10-15");
    await page.waitForFunction(()=>document.getElementById("table-holiday").textContent.includes("10/15/2026"));
    await page.click("#add-custom");await page.fill("#custom-FName","Custom Demo");await page.fill("#custom-Phone","2815550199");
    await page.click('[data-modal-result="save"]');await page.fill("#search-holiday","Custom Demo");
    await page.waitForFunction(()=>document.querySelectorAll("#table-holiday tr[data-row]").length===1);
    await page.locator("#table-holiday input[data-select]").check();await page.click("#remove-holiday");
    await page.waitForFunction(()=>document.querySelectorAll("#table-holiday tr[data-row]").length===0);
    // Scheduler controls must really reach main process, not silently return early.
    await page.getByRole("button",{name:"Monitoring",exact:true}).first().click();
    assert.match(await page.locator("#page-monitoring").innerText(), /6-month Recall.*D1110.*D4341.*D4342/);
    assert.match(await page.locator("#page-monitoring").innerText().catch(()=>page.locator("body").innerText()), /Recall/);
    await page.fill("#scheduler-lock","12:17");await page.click("#save-scheduler-times");
    await page.waitForFunction(()=>document.getElementById("toast").textContent.includes("times saved"));
    await page.fill("#scheduler-lock","13:00");await page.click("#reload-scheduler-times");
    await page.waitForFunction(()=>document.getElementById("scheduler-lock").value==="12:17");
    await page.click("#scheduler-on");
    await page.waitForFunction(()=>document.getElementById("toast").textContent.includes("packaged Windows app"));
    await page.fill("#scheduler-lock","12:05");await page.click("#save-scheduler-times");
    await page.click("#start-monitoring");
    await page.waitForFunction(
      () => document.getElementById("monitor-state").textContent === "Running",
    );
    await page.getByRole("button",{name:"Monitoring",exact:true}).first().click();
    await page.click("#stop-monitoring");
    await page.waitForFunction(
      () => document.getElementById("monitor-state").textContent === "Stopped",
    );
    assert.equal(await page.locator("#start-recall-monitoring").count(),0);
    assert.equal(await page.locator("#setting-recall_send_time").count(),0);
    await page.screenshot({
      path: path.join(__dirname, "../test-results/monitoring.png"),
    });
    assert.deepEqual(errors, []);
    console.log(
      "Electron UI: 10 tabs, SVG flags, virtualization, patient no-appointment test/fill distinction, template CRUD/default protection, manual categories, birthdays/custom recipients, scheduler controls and monitoring passed.",
    );
  } finally {
    await application.close();
  }
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
