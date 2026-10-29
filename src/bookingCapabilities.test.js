import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('capabilities route uses the response envelope required by WordPress', () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.get('/api/booking-capabilities'");
  const end = source.indexOf('\n});', start) + '\n});'.length;
  let handler;
  const auth = () => {};
  vm.runInNewContext(source.slice(start, end), { requireApiToken: auth, app: { get(path, middleware, callback) {
    assert.equal(path, '/api/booking-capabilities');
    assert.equal(middleware, auth);
    handler = callback;
  } } });
  let payload;
  handler({}, { json(value) { payload = JSON.parse(JSON.stringify(value)); } });
  assert.deepEqual(payload, { ok: true, data: { dateHours: true } });
});
