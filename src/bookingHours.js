// Date exceptions are supplied only by authenticated WordPress/Bridge requests.
export function parseDateHours(value) {
  if (value == null || value === '') return {};
  try {
    const entries = typeof value === 'string' ? JSON.parse(value) : value;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length > 366) throw new Error();
    const result = Object.create(null);
    for (const [date, hours] of Object.entries(entries)) {
      const parsed = new Date(`${date}T12:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error();
      if (!hours || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hours.open) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hours.close) || hours.open >= hours.close) throw new Error();
      result[date] = { open: hours.open, close: hours.close };
    }
    return result;
  } catch {
    const error = new Error('Invalid date-specific booking hours.');
    error.status = 400;
    throw error;
  }
}

export function bookingHoursForDate(date, dateHours = {}) {
  if (Object.hasOwn(dateHours, date)) {
    return { openTime: dateHours[date].open, closeTime: dateHours[date].close };
  }
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (weekday === 1) return { openTime: '14:00', closeTime: '17:30' };
  if ([0, 2, 4, 5].includes(weekday)) return { openTime: '09:00', closeTime: '17:30' };
  return null;
}
