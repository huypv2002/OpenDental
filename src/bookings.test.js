import test from 'node:test';
import assert from 'node:assert/strict';
import { createBooking, parseBookingBody } from './bookings.js';
import { config } from './config.js';
import { pool } from './db.js';

const date = '2099-10-17';
const originalPatient = {
  PatNum: 135, FName: 'BICH NGAN', LName: 'DO ',
  Birthdate: '1990-01-02', WirelessPhone: '(202)555-0111', HmPhone: '', WkPhone: ''
};

function harness(t, { patients = [originalPatient], appointments = [] } = {}) {
  const statements = [];
  const events = [];
  const input = parseBookingBody({
    date, time: '09:00', dateHours: { [date]: { open: '09:00', close: '11:00' } },
    firstName: 'Ngan', lastName: 'Do', birthdate: '1990-01-02', phone: '(202) 555-0111',
    durationMinutes: 30
  });
  const connection = {
    async beginTransaction() { events.push('begin'); },
    async commit() { events.push('commit'); },
    async rollback() { events.push('rollback'); },
    release() { events.push('release'); },
    async execute(sql, values) {
      statements.push({ sql, values });
      if (sql.includes('FROM patient p')) {
        assert.deepEqual(values, [input.birthdate]);
        return [patients.filter((p) => p.Birthdate === values[0]).sort((a, b) => a.PatNum - b.PatNum)];
      }
      if (sql.includes('FROM appointment a')) {
        assert.deepEqual(values, [`${date} 00:00:00`, '2099-10-18 00:00:00', input.birthdate]);
        return [appointments];
      }
      if (sql.includes('SELECT PatFieldNum')) return [[]];
      if (sql.includes('INSERT INTO patient')) return [{ insertId: 2000 }];
      if (sql.includes('INSERT INTO appointment')) return [{ insertId: 5000 }];
      if (sql.includes('UPDATE patient SET Guarantor') || sql.includes('INSERT INTO patfield') || sql.includes('INSERT INTO apptfield')) return [{ affectedRows: 1 }];
      throw new Error(`Unexpected transaction query: ${sql}`);
    }
  };
  t.mock.method(pool, 'getConnection', async () => connection);
  t.mock.method(pool, 'execute', async (sql) => {
    if (sql.includes('FROM appointment') || sql.includes('FROM schedule')) return [[]];
    throw new Error(`Unexpected availability query: ${sql}`);
  });
  const writesEnabled = config.writesEnabled;
  config.writesEnabled = true;
  t.after(() => { config.writesEnabled = writesEnabled; });
  return { input, statements, events };
}

test('shortened or incorrect name reuses the oldest DOB/phone match without changing the chart', async (t) => {
  const h = harness(t, { patients: [
    { ...originalPatient, PatNum: 1340, FName: 'Ngan', LName: 'Do' }, originalPatient
  ] });
  h.input.firstName = 'Wrong';
  h.input.lastName = 'Name';
  const result = await createBooking(h.input);
  assert.equal(result.patNum, 135);
  assert.equal(result.reusedPatient, true);
  assert.equal(h.statements.some(({ sql }) => /(?:INSERT INTO|UPDATE) patient\b/.test(sql)), false);
  const appointment = h.statements.find(({ sql }) => sql.includes('INSERT INTO appointment'));
  assert.equal(appointment.values[0], 135);
  assert.equal(appointment.values[5], 0); // IsNewPatient
  assert.match(appointment.values[7], /Name: Wrong Name/); // Preserve submitted name in the note.
  assert.deepEqual(h.events, ['begin', 'commit', 'release']);
});

for (const field of ['WirelessPhone', 'HmPhone', 'WkPhone']) {
  test(`matches formatted US phone with country prefix in ${field}`, async (t) => {
    const h = harness(t, { patients: [{ ...originalPatient, WirelessPhone: '', [field]: '+1 202.555.0111' }] });
    assert.equal((await createBooking(h.input)).patNum, 135);
  });
}

test('the same full name and DOB/phone also reuse the existing chart', async (t) => {
  const h = harness(t);
  h.input.firstName = originalPatient.FName;
  h.input.lastName = originalPatient.LName.trim();
  h.input.driverLicense = 'NEW-LICENSE';
  const result = await createBooking(h.input);
  assert.equal(result.patNum, 135);
  assert.equal(result.reusedPatient, true);
});

test('skip earlier charts with a different phone even when their DOB and name match', async (t) => {
  const h = harness(t, { patients: [
    { ...originalPatient, PatNum: 100, WirelessPhone: '(202) 555-0222' }, originalPatient
  ] });
  assert.equal((await createBooking(h.input)).patNum, 135);
});

for (const changed of ['phone', 'birthdate']) {
  test(`a different ${changed} creates a new chart even with the same full name and license`, async (t) => {
    const h = harness(t);
    h.input.firstName = originalPatient.FName;
    h.input.lastName = originalPatient.LName.trim();
    h.input.driverLicense = 'TEST-LICENSE';
    h.input[changed] = changed === 'phone' ? '(202) 555-0222' : '1990-01-03';
    const result = await createBooking(h.input);
    assert.equal(result.patNum, 2000);
    assert.equal(result.reusedPatient, false);
    assert.equal(h.statements.filter(({ sql }) => sql.includes('INSERT INTO patient')).length, 1);
    assert.equal(h.statements.find(({ sql }) => sql.includes('INSERT INTO appointment')).values[5], 1);
  });
}

test('same-day duplicate prevention also matches shortened names on historical duplicate charts', async (t) => {
  const h = harness(t, { appointments: [{ AptNum: 4186, PatNum: 1340, WirelessPhone: '+1 (202) 555-0111' }] });
  await assert.rejects(createBooking(h.input), { status: 409 });
  assert.equal(h.statements.some(({ sql }) => /INSERT|UPDATE/.test(sql)), false);
  assert.deepEqual(h.events, ['begin', 'rollback', 'release']);
});

test('another patient with the same DOB but different phone does not block booking', async (t) => {
  const h = harness(t, { appointments: [{ AptNum: 6000, WirelessPhone: '(202) 555-0222' }] });
  assert.equal((await createBooking(h.input)).patNum, 135);
});

test('missing or invalid stored phones do not match and do not prevent creation', async (t) => {
  const h = harness(t, { patients: [{ ...originalPatient, WirelessPhone: null, HmPhone: '', WkPhone: '555-0111' }] });
  assert.equal((await createBooking(h.input)).reusedPatient, false);
});
