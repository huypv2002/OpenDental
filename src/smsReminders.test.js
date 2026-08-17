import test from 'node:test';
import assert from 'node:assert/strict';

import { pool } from './db.js';
import { getSmsPatientHistory, getSmsReminderAppointments, isRecallOperatory } from './smsReminders.js';

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
