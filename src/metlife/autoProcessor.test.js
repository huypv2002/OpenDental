import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePatient, autoPopulateProcedureFees, scanIncomingFolder } from './autoProcessor.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('resolvePatient matches PatNum in filename directly', async () => {
  const pool = {
    execute: async (sql, values) => {
      if (sql.includes('FROM patient WHERE PatNum = ?')) {
        assert.equal(values[0], 1307);
        return [[{ PatNum: 1307, FName: 'RYAN', LName: 'PHAM', ClinicNum: 0, PriProv: 1, ImageFolder: 'PhamRyan1307' }]];
      }
      return [[]];
    }
  };

  const patient = await resolvePatient(pool, {
    fileName: '1307.pdf',
    parsed: { patient: 'PHAM, RYAN' }
  });
  assert.equal(patient.PatNum, 1307);
  assert.equal(patient.LName, 'PHAM');
});

test('resolvePatient matches patient by parsed name when filename has no ID', async () => {
  const pool = {
    execute: async (sql, values) => {
      if (sql.includes('LName LIKE ? AND FName LIKE ?')) {
        return [[{ PatNum: 1307, FName: 'RYAN', LName: 'PHAM', ClinicNum: 0, PriProv: 1, ImageFolder: 'PhamRyan1307' }]];
      }
      return [[]];
    }
  };

  const patient = await resolvePatient(pool, {
    fileName: 'MetLife_EOB_Claim.pdf',
    parsed: { patient: 'PHAM, RYAN', group: '301044' }
  });
  assert.equal(patient.PatNum, 1307);
  assert.equal(patient.FName, 'RYAN');
});

test('autoPopulateProcedureFees updates 0.00 ProcFee to submitted fee from EOB', async () => {
  const executedUpdates = [];
  const conn = {
    execute: async (sql, values) => {
      if (sql.includes('SELECT procedurelog.ProcNum') || sql.includes('SELECT pl.ProcNum')) {
        return [[
          { ProcNum: 13757, ProcDate: new Date('2026-09-20'), ProcFee: '0.00', ProcCode: 'D0120', CodeNum: 1 },
          { ProcNum: 13783, ProcDate: new Date('2026-09-20'), ProcFee: '0.00', ProcCode: 'D1208', CodeNum: 2 }
        ]];
      }
      if (sql.includes('UPDATE procedurelog SET ProcFee = ? WHERE ProcNum = ?')) {
        executedUpdates.push({ type: 'procedurelog', fee: values[0], procNum: values[1] });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('UPDATE claimproc SET FeeBilled = ? WHERE ProcNum = ?')) {
        executedUpdates.push({ type: 'claimproc', fee: values[0], procNum: values[1] });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('SELECT ClaimNum FROM claim WHERE PatNum = ?')) {
        return [[{ ClaimNum: 55 }]];
      }
      if (sql.includes('UPDATE claim SET ClaimFee')) {
        executedUpdates.push({ type: 'claim', claimNum: values[1] });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('SUM(FeeBilled)')) {
        return [[{ TotalFee: '131.40' }]];
      }
      if (sql.includes('SUM(ProcFee)')) {
        return [[{ TotalCharges: '131.40' }]];
      }
      if (sql.includes('SUM(SplitAmt)')) {
        return [[{ TotalPaid: '131.40' }]];
      }
      if (sql.includes('UPDATE patient SET BalTotal')) {
        return [{ affectedRows: 1 }];
      }
      return [[]];
    }
  };

  const eobProcedures = [
    { code: 'D0120', feeCents: 9600, benefitCents: 8640, date: '2026-09-20' },
    { code: 'D1208', feeCents: 5000, benefitCents: 4500, date: '2026-09-20' }
  ];

  const updatedFees = await autoPopulateProcedureFees(conn, {
    patNum: 1307,
    eobProcedures
  });

  assert.equal(updatedFees.length, 2);
  assert.match(updatedFees[0], /D0120: \$86\.40/);
  assert.match(updatedFees[1], /D1208: \$45\.00/);

  assert.equal(executedUpdates.filter((u) => u.type === 'procedurelog').length, 2);
  assert.equal(executedUpdates.filter((u) => u.type === 'claimproc').length, 2);
});

test('scanIncomingFolder handles empty incoming folder gracefully', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'metlife-scan-empty-'));
  const pool = {
    execute: async () => [[]]
  };

  try {
    const res = await scanIncomingFolder(pool, dir);
    assert.equal(res.status, 'idle');
    assert.equal(res.count, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
