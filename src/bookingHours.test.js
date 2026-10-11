import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDateHours, bookingHoursForDate } from './bookingHours.js';
import { getAvailableSlots, getAvailableSlotsRange, parseSlotQuery, parseSlotRangeQuery } from './slots.js';
import { assertSlotStillAvailable } from './bookings.js';
import { pool } from './db.js';

const date = '2099-10-17'; // Saturday, safely in the future.
const hours = { [date]: { open: '09:00', close: '11:00' } };

test('exceptions are restricted to exact dates; weekly schedule remains intact', () => {
  assert.equal(bookingHoursForDate(date), null);
  assert.deepEqual(bookingHoursForDate(date, parseDateHours(hours)), { openTime: '09:00', closeTime: '11:00' });
  assert.equal(bookingHoursForDate('2099-10-24', parseDateHours(hours)), null);
  assert.equal(bookingHoursForDate('2099-10-14'), null); // Wednesday
  assert.deepEqual(bookingHoursForDate('2099-10-12'), { openTime: '14:00', closeTime: '17:30' });
});

test('invalid date, clock values, reversed hours and malformed input are rejected', () => {
  for (const value of ['{', [], { '2099-02-30': { open: '09:00', close: '11:00' } },
    { [date]: { open: '24:00', close: '25:00' } }, { [date]: { open: '12:00', close: '09:00' } }]) {
    assert.throws(() => parseDateHours(value), { status: 400 });
  }
});

test('single/range availability and final validation preserve appointment and blockout conflicts', async () => {
  const original = pool.execute;
  pool.execute = async (sql) => {
    if (sql.includes('FROM appointment')) return [[{ AptNum: 1, AptDateTime: `${date} 09:00:00`, Pattern: 'XXXXXX' }]];
    if (sql.includes('FROM schedule')) return [[{ ScheduleNum: 2, SchedDate: date, StartTime: '10:00:00', StopTime: '10:30:00' }]];
    throw new Error(`Unexpected test DB query: ${sql}`);
  };
  try {
    const common = { durationOverride: '30', duration: '30', interval: '30', dateHours: JSON.stringify(hours) };
    const single = await getAvailableSlots(parseSlotQuery({ ...common, date }));
    assert.deepEqual(single.slots.map((slot) => slot.time), ['09:30', '10:30']);
    const range = await getAvailableSlotsRange(parseSlotRangeQuery({ ...common, startDate: date, days: '8' }));
    assert.deepEqual(range.dates[date].slots, single.slots);
    assert.deepEqual(range.dates['2099-10-24'].slots, []);
    await assertSlotStillAvailable({ date, time: '09:30', durationMinutes: 30, dateHours: hours });
    await assert.rejects(assertSlotStillAvailable({ date, time: '09:00', durationMinutes: 30, dateHours: hours }), { status: 409 });
    await assert.rejects(assertSlotStillAvailable({ date, time: '09:30', durationMinutes: 30 }), { status: 409 });
  } finally {
    pool.execute = original;
    await pool.end();
  }
});
