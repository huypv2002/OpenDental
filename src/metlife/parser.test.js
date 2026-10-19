import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cents, money, isoDate, linesOf, parseMetlife } from './parser.js';

test('parser helper functions: cents, money, isoDate, linesOf', () => {
  assert.equal(cents('$439.20'), 43920);
  assert.equal(money(43920), '439.20');
  assert.equal(isoDate('09/20/2026'), '2026-09-20');
  assert.equal(isoDate('99/99/2026'), null);

  const items = [
    { str: 'Item 2', x: 50, y: 10 },
    { str: 'Item 1', x: 10, y: 10 },
    { str: 'Line 2', x: 10, y: 30 }
  ];
  const lines = linesOf(items);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'Item 1 Item 2');
  assert.equal(lines[1].text, 'Line 2');
});

test('parseMetlife rejects non-matching document', () => {
  const result = parseMetlife({
    sha256: 'deadbeef',
    pages: [{ page: 1, width: 600, height: 800, lines: [{ text: 'Random Invoice' }], items: [] }]
  });
  assert.equal(result.template, null);
  assert.ok(result.errors.length > 0);
});
