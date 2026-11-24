'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const L = require('../src/ledger');
const lease = { start_date: '2026-01-01', end_date: null, rent_cents: 100000, due_day: 1, grace_days: 5, late_fee_cents: 5000 };

test('rentCharges: full months, one per month, up to asOf month', () => {
  const c = L.rentCharges(lease, '2026-03-15'); assert.deepEqual(c.map((x) => x.period), ['2026-01', '2026-02', '2026-03']);
  assert.ok(c.every((x) => x.amount_cents === 100000)); assert.equal(c[1].due_date, '2026-02-01');
});
test('rentCharges: prorates the first and last month by days', () => {
  const c = L.rentCharges({ ...lease, start_date: '2026-06-15', end_date: '2026-08-10' }, '2026-12-01');
  assert.deepEqual(c.map((x) => x.period), ['2026-06', '2026-07', '2026-08']);
  assert.equal(c[0].amount_cents, Math.round(100000 * 16 / 30)); assert.equal(c[0].due_date, '2026-06-15'); assert.match(c[0].description, /prorated 16\/30/);
  assert.equal(c[2].amount_cents, Math.round(100000 * 10 / 31));
  assert.equal(L.rentCharges({ ...lease, due_day: 28 }, '2026-02-10')[1].due_date, '2026-02-28');
  assert.equal(L.rentCharges({ ...lease, start_date: '2026-05-01' }, '2026-04-30').length, 0);
});
test('allocate pays oldest charges first and tracks credit', () => {
  const ch = [{ id: 2, due_date: '2026-02-01', amount_cents: 100 }, { id: 1, due_date: '2026-01-01', amount_cents: 100 }, { id: 3, due_date: '2026-03-01', amount_cents: 100 }];
  const a = L.allocate(ch, [{ amount_cents: 150 }]);
  assert.deepEqual(a.rows.map((r) => [r.id, r.paid_cents, r.outstanding_cents]), [[1, 100, 0], [2, 50, 50], [3, 0, 100]]); assert.equal(a.credit_cents, 0);
  assert.equal(L.allocate(ch, [{ amount_cents: 500 }]).credit_cents, 200);
});
test('lateFeesDue: only when unpaid at the end of grace, once per charge', () => {
  const rent = { id: 1, kind: 'rent', period: '2026-01', due_date: '2026-01-01', amount_cents: 100000 };
  assert.equal(L.lateFeesDue(lease, [rent], [], '2026-01-06').length, 0); // still inside grace (deadline Jan 6)
  const f = L.lateFeesDue(lease, [rent], [], '2026-01-07'); assert.equal(f.length, 1); assert.equal(f[0].amount_cents, 5000); assert.equal(f[0].due_date, '2026-01-07');
  assert.equal(L.lateFeesDue(lease, [rent], [{ paid_on: '2026-01-06', amount_cents: 100000 }], '2026-02-20').length, 0); // paid on last grace day
  assert.equal(L.lateFeesDue(lease, [rent], [{ paid_on: '2026-01-09', amount_cents: 100000 }], '2026-02-20').length, 1); // paid late: fee still owed
  assert.equal(L.lateFeesDue(lease, [rent, { id: 9, kind: 'late_fee', ref_charge_id: 1 }], [], '2026-02-20').length, 0); // already charged
  assert.equal(L.lateFeesDue({ ...lease, late_fee_cents: 0 }, [rent], [], '2026-02-20').length, 0);
  // a partly paid month still triggers it, and later payments for the next month don't hide it
  assert.equal(L.lateFeesDue(lease, [rent], [{ paid_on: '2026-01-03', amount_cents: 60000 }], '2026-01-20').length, 1);
});
test('aging buckets', () => {
  const rows = [{ due_date: '2026-11-25', outstanding_cents: 1 }, { due_date: '2026-11-10', outstanding_cents: 10 }, { due_date: '2026-10-10', outstanding_cents: 100 }, { due_date: '2026-08-01', outstanding_cents: 1000 }, { due_date: '2026-01-01', outstanding_cents: 0 }];
  assert.deepEqual(L.aging(rows, '2026-11-24'), { current: 1, d1_30: 10, d31_60: 100, d61_plus: 1000 });
});
