'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { start } = require('./testkit'); const { build } = require('../src/app');
let day = '2026-11-24'; const clock = () => new Date(day + 'T12:00:00Z');
const mk = (o) => build({ ...o, clock });

test('login required; seeded dashboard is consistent', async () => {
  const s = await start(mk);
  assert.equal((await s.anon('GET', '/api/dashboard')).status, 401);
  const d = (await s.call('GET', '/api/dashboard')).data;
  assert.equal(d.units, 8); assert.equal(d.occupied, 5); assert.equal(d.occupancy_pct, 63);
  const sum = Object.values(d.aging).reduce((a, b) => a + b, 0);
  assert.ok(d.balance_due_cents > 0 && d.balance_due_cents <= sum);
  assert.deepEqual(d.late.map((x) => x.tenant_name).sort(), ['Ben Ortiz', 'Chloe Martin', 'Emma Schulz']);
  assert.equal(d.ending_soon.length, 1);
  await s.close();
});
test('overdue tenant: rent, late fees and balance add up; payment clears oldest first', async () => {
  const s = await start(mk);
  const leases = (await s.call('GET', '/api/leases')).data.leases; const ben = leases.find((l) => l.tenant_name === 'Ben Ortiz');
  let g = (await s.call('GET', '/api/leases/' + ben.id)).data;
  const unpaid = g.charges.filter((c) => c.outstanding_cents > 0);
    assert.equal(unpaid.filter((c) => c.kind === 'late_fee').length, 2);
  assert.equal(g.balance_due_cents, 2 * 138000 + 2 * 7500);
  // pay exactly the Oct rent + Oct fee
  const r = await s.call('POST', `/api/leases/${ben.id}/payments`, { paid_on: '2026-11-24', amount_cents: 138000 + 7500, method: 'bank' }); assert.equal(r.status, 200);
  g = (await s.call('GET', '/api/leases/' + ben.id)).data; assert.equal(g.balance_due_cents, 138000 + 7500);
  assert.equal((await s.call('POST', `/api/leases/${ben.id}/payments`, { paid_on: '2027-01-01', amount_cents: 1, method: 'bank' })).status, 400);
  assert.equal((await s.call('POST', `/api/leases/${ben.id}/payments`, { paid_on: '2026-11-24', amount_cents: 0, method: 'bank' })).status, 400);
  assert.equal((await s.call('POST', `/api/leases/${ben.id}/payments`, { paid_on: '2026-11-24', amount_cents: 5, method: 'crypto' })).status, 400);
  await s.close();
});
test('billing is idempotent; moving the date forward bills the next month and a late fee once', async () => {
  day = '2026-11-24'; const s = await start(mk);
  const again = (await s.call('POST', '/api/billing/run')).data; assert.equal(again.rent_charges_created, 0); assert.equal(again.late_fees_created, 0);
  day = '2026-12-08'; const adv = (await s.call('POST', '/api/billing/run')).data;
  assert.equal(adv.rent_charges_created, 5); // five active leases get December rent
  assert.ok(adv.late_fees_created >= 3); // Ben, Chloe, Emma are still unpaid past grace for Dec? (Dec 1 + 5 grace = Dec 6)
  assert.equal((await s.call('POST', '/api/billing/run')).data.late_fees_created, 0);
  day = '2026-11-24'; await s.close();
});
test('waiving a late fee removes it from the balance and billing does not recreate it', async () => {
  day = '2026-11-24'; const s = await start(mk);
  const chloe = (await s.call('GET', '/api/leases')).data.leases.find((l) => l.tenant_name === 'Chloe Martin');
  let g = (await s.call('GET', '/api/leases/' + chloe.id)).data; const fee = g.charges.find((c) => c.kind === 'late_fee' && c.outstanding_cents > 0); assert.ok(fee);
  const before = g.balance_due_cents; assert.equal((await s.call('POST', `/api/charges/${fee.id}/waive`)).status, 200);
  await s.call('POST', '/api/billing/run'); g = (await s.call('GET', '/api/leases/' + chloe.id)).data;
  assert.equal(g.balance_due_cents, before - fee.amount_cents); assert.equal(g.charges.filter((c) => c.kind === 'late_fee').length, 1);
  const rent = g.charges.find((c) => c.kind === 'rent'); assert.equal((await s.call('POST', `/api/charges/${rent.id}/waive`)).status, 400);
  await s.close();
});
test('new lease: overlap is refused, proration applied, move-out re-prorates the last month', async () => {
  day = '2026-11-24'; const s = await start(mk);
  const units = (await s.call('GET', '/api/units')).data.units; const vacant = units.find((u) => u.state === 'vacant'); assert.ok(vacant);
  const tid = (await s.call('POST', '/api/tenants', { name: 'Gina Lopez', email: 'gina@x.example' })).data.id;
  assert.equal((await s.call('POST', '/api/tenants', { name: 'X', email: 'nope' })).status, 400);
  const bad = await s.call('POST', '/api/leases', { unit_id: vacant.id, tenant_id: tid, start_date: '2026-11-10', end_date: '2026-11-01' }); assert.equal(bad.status, 400);
  const ok = await s.call('POST', '/api/leases', { unit_id: vacant.id, tenant_id: tid, start_date: '2026-11-10', due_day: 1, late_fee_cents: 5000 }); assert.equal(ok.status, 200);
  const g = (await s.call('GET', '/api/leases/' + ok.data.id)).data; assert.equal(g.charges.filter((c) => c.kind === 'rent').length, 1); assert.equal(g.charges.find((c) => c.kind === 'rent').amount_cents, Math.round(vacant.rent_cents * 21 / 30));
  assert.equal((await s.call('POST', '/api/leases', { unit_id: vacant.id, tenant_id: tid, start_date: '2026-11-20' })).status, 400); // overlap
  assert.equal((await s.call('POST', `/api/leases/${ok.data.id}/end`, { end_date: '2026-11-20' })).status, 200);
  assert.equal((await s.call('GET', '/api/leases/' + ok.data.id)).data.charges.find((c) => c.kind === 'rent').amount_cents, Math.round(vacant.rent_cents * 11 / 30));
  await s.close();
});
test('ledger CSV, persistence across restart', async () => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-')), 'x.db');
  let s = await start((o) => mk({ ...o, dbFile })); const id = (await s.call('GET', '/api/leases')).data.leases[0].id;
  const csv = await s.call('GET', `/api/leases/${id}/ledger.csv`, null, true); assert.match(csv.text, /^Date,Type,Description,Amount,Outstanding/);
  await s.call('POST', `/api/leases/${id}/charges`, { due_date: '2026-11-24', amount_cents: 2500, description: 'Parking permit' }); await s.close();
  s = await start((o) => mk({ ...o, dbFile })); const g = (await s.call('GET', '/api/leases/' + id)).data;
  assert.ok(g.charges.some((c) => c.description === 'Parking permit')); await s.close();
});
