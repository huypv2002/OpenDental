import test from 'node:test';
import assert from 'node:assert/strict';

import { pool } from './db.js';
import { getSmsPatientHistory, getSmsRecallCandidates, getSmsRecallHistoryByVisitDate, getSmsReminderAppointments, isRecallOperatory } from './smsReminders.js';

test('recall operatory is excluded by exact name or abbreviation', () => {
  assert.equal(isRecallOperatory({ OpName: 'RECALL' }), true);
  assert.equal(isRecallOperatory({ OpName: '  recall  ' }), true);
  assert.equal(isRecallOperatory({ OperatoryAbbrev: 'Recall' }), true);
});

test('normal operatories remain eligible for appointment reminders', () => {
  assert.equal(isRecallOperatory({ OpName: 'DR. AN TRINH', OperatoryAbbrev: 'OP1' }), false);
  assert.equal(isRecallOperatory({ OpName: 'WALK-IN', OperatoryAbbrev: 'OP2' }), false);
  assert.equal(isRecallOperatory({ OpName: 'Operatory 3', OperatoryAbbrev: 'OP3' }), false);
});

test('appointment feed keeps only Wireless phone and excludes recall defensively', async () => {
  const originalExecute = pool.execute;
  pool.execute = async (sql) => {
    const statement = String(sql).replace(/\s+/g, ' ').trim();
    if (statement.includes('INFORMATION_SCHEMA.COLUMNS')) {
      return [[{ COLUMN_NAME: 'ReminderOffsetDays' }], []];
    }
    if (statement.includes('INFORMATION_SCHEMA.STATISTICS')) {
      return [[{ Columns: 'AptNum,ReminderForDate,Phone,ReminderOffsetDays' }], []];
    }
    if (statement.startsWith('CREATE TABLE IF NOT EXISTS')) {
      return [{ affectedRows: 0 }, []];
    }
    if (statement.includes('FROM appointment a')) {
      assert.match(statement, /OpName, ''\)\)\) <> 'RECALL'/);
      assert.match(statement, /Abbrev, ''\)\)\) <> 'RECALL'/);
      return [[
        {
          AptNum: 1,
          PatNum: 93,
          OpName: 'DR. AN TRINH',
          OperatoryAbbrev: 'OP1',
          WirelessPhone: '',
          HmPhone: '(281) 222-2222',
          WkPhone: '(281) 333-3333',
          Pattern: 'XX',
        },
        {
          AptNum: 2,
          PatNum: 795,
          OpName: 'RECALL',
          OperatoryAbbrev: 'REC',
          WirelessPhone: '(281) 111-1111',
          Pattern: 'XX',
        },
      ], []];
    }
    throw new Error(`Unexpected SQL in test: ${statement}`);
  };

  try {
    const result = await getSmsReminderAppointments({ date: '2026-08-18', statuses: '1' });
    assert.equal(result.appointments.length, 1);
    assert.equal(result.appointments[0].PatNum, 93);
    assert.equal(result.appointments[0].Phone, '');
    assert.equal(result.appointments[0].WorkPhoneFormatted, '(281) 333-3333');
  } finally {
    pool.execute = originalExecute;
  }
});

test('recall lookup returns procedure rows independently of follow-up eligibility', async () => {
  const originalExecute = pool.execute;
  pool.execute = async (sql, params) => {
    const statement = String(sql).replace(/\s+/g, ' ').trim();
    if (statement.startsWith('CREATE TABLE IF NOT EXISTS')) return [{ affectedRows: 0 }];
    const row = { PatNum: 70, FName: 'Example', LastProcDate: '2026-05-07', ProcedureCodes: 'D1110' };
    if (params[1] === 70) {
      assert.match(statement, /pl.ProcStatus = 2 AND p.PatNum = \?/);
      assert.match(statement, /rl.LastRecallSentAt, pl.ProcDate ORDER BY MAX\(pl.ProcDate\) DESC, p.LName, p.FName LIMIT 1/);
      return [[row]];
    }
    if (params[1] === '2026-05-07') {
      assert.match(statement, /pl.ProcStatus = 2 AND pl.ProcDate = \?/);
      assert.doesNotMatch(statement, /NOT EXISTS|LIMIT/);
      return [[row, { ...row, PatNum: 71 }, { ...row, PatNum: 72 }]];
    }
    assert.match(statement, /AND p.PatStatus = 0.*HAVING MAX\(pl.ProcDate\).*NOT EXISTS.*a.AptDateTime >= NOW\(\)/);
    assert.deepEqual(params, ['D1110', 6, 1, 250]);
    return [[{ ...row, PatNum: 72 }]];
  };
  try {
    const byPatient = await getSmsRecallCandidates({ mode: 'lookup', codes: 'D1110', patNum: 70 });
    assert.equal(byPatient.contract, 'recall-patient-lookup-v1');
    assert.equal(byPatient.patients[0].LastProcDate, '2026-05-07');
    const byDate = await getSmsRecallCandidates({ mode: 'lookup', codes: 'D1110', serviceDate: '2026-05-07' });
    assert.deepEqual(byDate.patients.map((row) => row.PatNum), [70, 71, 72]);
    const followUp = await getSmsRecallCandidates({ codes: 'D1110', statuses: '1' });
    assert.deepEqual(followUp.patients.map((row) => row.PatNum), [72]);
    await assert.rejects(getSmsRecallCandidates({ mode: 'lookup', patNum: 70, serviceDate: '2026-05-07' }), { status: 400 });
  } finally {
    pool.execute = originalExecute;
  }
});

test('visit date history includes every logged recall attempt, including needs-review', async () => {
  const originalExecute = pool.execute;
  const history = [
    { LogNum: 3, PatNum: 73, Status: 'needs-review', SentAt: null },
    { LogNum: 2, PatNum: 72, Status: 'sent' },
    { LogNum: 1, PatNum: 71, Status: 'needs-review', SentAt: null },
  ];
  pool.execute = async (sql, params) => {
    const statement = String(sql).replace(/\s+/g, ' ').trim();
    if (statement.startsWith('CREATE TABLE IF NOT EXISTS')) return [{ affectedRows: 0 }];
    assert.match(statement, /FROM luk_sms_recall_log WHERE LastProcDate = \? ORDER BY RecallLogNum DESC$/);
    assert.deepEqual(params, ['2026-05-07']);
    return [history];
  };
  try {
    await assert.rejects(getSmsRecallHistoryByVisitDate({ serviceDate: '2026-02-30' }), { status: 400 });
    assert.deepEqual(await getSmsRecallHistoryByVisitDate({ serviceDate: '2026-05-07' }), {
      serviceDate: '2026-05-07',
      history,
    });
  } finally {
    pool.execute = originalExecute;
  }
});

test('patient history combines all SMS log sources in newest-first order', async () => {
  const originalExecute = pool.execute;
  const selectedTables = [];
  pool.execute = async (sql, params = []) => {
    const statement = String(sql).replace(/\s+/g, ' ').trim();
    if (statement.includes('INFORMATION_SCHEMA.COLUMNS')) {
      return [[{ COLUMN_NAME: 'ReminderOffsetDays' }], []];
    }
    if (statement.includes('INFORMATION_SCHEMA.STATISTICS')) {
      return [[{ Columns: 'AptNum,ReminderForDate,Phone,ReminderOffsetDays' }], []];
    }
    if (statement.startsWith('CREATE TABLE IF NOT EXISTS')) {
      return [{ affectedRows: 0 }, []];
    }
    const sources = [
      ['luk_sms_reminder_log', 'appointment', '2026-08-17 08:00:00'],
      ['luk_sms_recall_log', 'recall', '2026-08-17 12:05:00'],
      ['luk_sms_treatment_log', 'treatment', '2026-08-16 09:00:00'],
      ['luk_sms_patient_log', 'patient', '2026-08-15 09:00:00'],
      ['luk_sms_campaign_log', 'campaign', '2026-08-14 09:00:00'],
    ];
    const source = sources.find(([table]) => statement.includes(`FROM ${table}`));
    if (source) {
      const [, messageType, createdAt] = source;
      selectedTables.push(messageType);
      assert.deepEqual(params, [795, 20]);
      return [[{
        LogNum: selectedTables.length,
        MessageType: messageType,
        PatNum: 795,
        Phone: '(281) 111-1111',
        Message: `${messageType} message`,
        Status: 'sent',
        SentAt: messageType === 'recall' ? createdAt : null,
        CreatedAt: createdAt,
        ErrorMessage: '',
        Context: messageType,
      }], []];
    }
    throw new Error(`Unexpected SQL in test: ${statement}`);
  };

  try {
    const result = await getSmsPatientHistory({ patNum: '795', limit: '20' });
    assert.equal(result.patNum, 795);
    assert.deepEqual(selectedTables.sort(), ['appointment', 'campaign', 'patient', 'recall', 'treatment']);
    assert.deepEqual(result.history.map((row) => row.MessageType), [
      'recall',
      'appointment',
      'treatment',
      'patient',
      'campaign',
    ]);
    assert.equal(result.history[0].ActivityAt, '2026-08-17 12:05:00');
  } finally {
    pool.execute = originalExecute;
  }
});
