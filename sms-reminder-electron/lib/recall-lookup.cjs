function visitFromHistory(history, codes, serviceDate) {
  const visits = new Map();
  const sent = history.filter((record) => record.MessageType === "recall" && record.Status === "sent");
  for (const record of history) {
    if (record.MessageType !== "recall") continue;
    // Older Bridge versions expose the code and visit date in Context only.
    const match = /^Recall - (.+) - last visit (\d{2})\/(\d{2})\/(\d{4})$/.exec(record.Context || "");
    if (!match) continue;
    const [, procedures, month, day, year] = match;
    const date = `${year}-${month}-${day}`;
    if (serviceDate && date !== serviceDate) continue;
    const matches = procedures.split(",").map((code) => code.trim().toUpperCase()).filter((code) => codes.has(code));
    if (!matches.length) continue;
    if (!visits.has(date)) visits.set(date, new Set());
    for (const code of matches) visits.get(date).add(code);
  }
  const lastDate = [...visits.keys()].sort().at(-1);
  if (!lastDate) return null;
  return {
    LastProcDate: lastDate,
    ProcedureCodes: [...visits.get(lastDate)].sort().join(", "),
    RecallSentCount: history.length < 500 ? sent.length : "",
    LastRecallSentAt: sent.map((record) => record.SentAt).filter(Boolean).sort().at(-1) || "",
  };
}

async function lookupLegacyRecall(bridge, { patNum, serviceDate, codes }, candidates) {
  const codeSet = new Set(codes);
  const lookupVisit = async (patient) => {
    const data = await bridge.request("GET", "/api/sms-reminders/patient-history", {
      patNum: patient.PatNum,
      limit: 500,
    });
    const visit = visitFromHistory(data.history || [], codeSet, serviceDate);
    return visit ? { ...patient, ...visit } : null;
  };

  if (patNum) {
    const candidate = candidates.find((patient) => Number(patient.PatNum) === patNum);
    if (candidate) return [candidate];
    const data = await bridge.request("GET", "/api/admin/patients", { q: `#${patNum}`, patNum, limit: 1 });
    const patient = data.patients?.find((row) => Number(row.PatNum) === patNum);
    const row = patient && await lookupVisit(patient);
    return row ? [row] : [];
  }

  const patients = new Map(
    candidates.filter((patient) => patient.LastProcDate === serviceDate)
      .map((patient) => [Number(patient.PatNum), patient]),
  );
  const data = await bridge.request("GET", "/api/admin/appointments", {
    date: serviceDate, statuses: "1,2,3,4,5,6,7,8", limit: 300,
  });
  for (const appointment of data.appointments || []) {
    const { PatNum, FName, LName, Birthdate, WirelessPhone, Email, Language } = appointment;
    const id = Number(PatNum);
    if (id > 0 && !patients.has(id))
      patients.set(id, { PatNum, FName, LName, Birthdate, WirelessPhone, Email, Language });
  }
  const result = [];
  const pending = [...patients.values()];
  for (let offset = 0; offset < pending.length; offset += 8) {
    const rows = await Promise.all(pending.slice(offset, offset + 8).map(lookupVisit));
    result.push(...rows.filter(Boolean));
  }
  return result.sort((a, b) => Number(a.PatNum) - Number(b.PatNum));
}

module.exports = { lookupLegacyRecall };
