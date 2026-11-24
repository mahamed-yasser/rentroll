'use strict';
const path = require('node:path');
const { createApp, csv } = require('./core');
const L = require('./ledger');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS properties(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, address TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS units(id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id), label TEXT NOT NULL, beds INTEGER NOT NULL DEFAULT 1, rent_cents INTEGER NOT NULL CHECK(rent_cents>0), UNIQUE(property_id,label));
CREATE TABLE IF NOT EXISTS tenants(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS leases(id INTEGER PRIMARY KEY, unit_id INTEGER NOT NULL REFERENCES units(id), tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  start_date TEXT NOT NULL, end_date TEXT, rent_cents INTEGER NOT NULL CHECK(rent_cents>0), due_day INTEGER NOT NULL CHECK(due_day BETWEEN 1 AND 28),
  grace_days INTEGER NOT NULL DEFAULT 5, late_fee_cents INTEGER NOT NULL DEFAULT 0, deposit_cents INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS charges(id INTEGER PRIMARY KEY, lease_id INTEGER NOT NULL REFERENCES leases(id), kind TEXT NOT NULL CHECK(kind IN ('rent','late_fee','other')),
  period TEXT, waived INTEGER NOT NULL DEFAULT 0, ref_charge_id INTEGER REFERENCES charges(id) ON DELETE SET NULL, due_date TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0), description TEXT NOT NULL,
  UNIQUE(lease_id,kind,period));
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, lease_id INTEGER NOT NULL REFERENCES leases(id), paid_on TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0), method TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');`;

function build({ dbFile, clock = () => new Date(), publicDir = path.join(__dirname, '..', 'public') } = {}) {
  const today = () => clock().toISOString().slice(0, 10);
  const app = createApp({ dbFile, publicDir, schema: SCHEMA, appName: 'RentRoll', seed: (db) => require('./seed')(db, today(), (d, asOf) => runBilling(d, (f) => f(), asOf)),
    routes(add, { db, tx, v, bad, HttpError }) {
      const leaseRow = (id) => { const l = db.prepare(`SELECT l.*, u.label AS unit_label, p.name AS property_name, t.name AS tenant_name FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=u.property_id JOIN tenants t ON t.id=l.tenant_id WHERE l.id=?`).get(id); if (!l) throw new HttpError(404, 'Lease not found'); return l; };
      const ledger = (leaseId, asOf = today()) => {
        const charges = db.prepare('SELECT * FROM charges WHERE lease_id=? ORDER BY due_date,id').all(leaseId), payments = db.prepare('SELECT * FROM payments WHERE lease_id=? ORDER BY paid_on,id').all(leaseId);
        const { rows: live, credit_cents } = L.allocate(charges.filter((c) => !c.waived), payments);
        const rows = [...live, ...charges.filter((c) => c.waived).map((c) => ({ ...c, paid_cents: 0, outstanding_cents: 0 }))].sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id - b.id);
        const owed = rows.filter((r) => r.due_date <= asOf).reduce((s, r) => s + r.outstanding_cents, 0);
        return { charges: rows, payments, credit_cents, balance_due_cents: owed, aging: L.aging(rows, asOf) };
      };
      const status = (l, asOf) => (l.start_date > asOf ? 'upcoming' : l.end_date && l.end_date < asOf ? 'ended' : 'active');

      add('POST', '/api/billing/run', () => runBilling(db, tx, today()));
      add('GET', '/api/properties', () => ({ properties: db.prepare('SELECT * FROM properties ORDER BY name').all() }));
      add('POST', '/api/properties', ({ body }) => { const r = db.prepare('INSERT INTO properties(name,address) VALUES(?,?)').run(v.str(body.name, 'Name'), v.str(body.address, 'Address')); return { id: Number(r.lastInsertRowid) }; });
      add('POST', '/api/units', ({ body }) => {
        const r = db.prepare('INSERT INTO units(property_id,label,beds,rent_cents) VALUES(?,?,?,?)').run(v.int(body.property_id, 'Property', { min: 1 }), v.str(body.label, 'Unit', { max: 30 }), v.int(body.beds, 'Bedrooms', { max: 12 }), v.int(body.rent_cents, 'Rent', { min: 1 }));
        return { id: Number(r.lastInsertRowid) };
      });
      add('PATCH', '/api/units/:id', ({ params, body }) => { db.prepare('UPDATE units SET rent_cents=? WHERE id=?').run(v.int(body.rent_cents, 'Rent', { min: 1 }), Number(params.id)); return { ok: true }; });
      add('GET', '/api/tenants', () => ({ tenants: db.prepare('SELECT * FROM tenants ORDER BY name').all() }));
      add('POST', '/api/tenants', ({ body }) => {
        const email = v.str(body.email, 'Email'); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Email looks invalid');
        const r = db.prepare('INSERT INTO tenants(name,email,phone) VALUES(?,?,?)').run(v.str(body.name, 'Name'), email, v.str(body.phone, 'Phone', { required: false, max: 30 })); return { id: Number(r.lastInsertRowid) };
      });
      add('GET', '/api/units', () => {
        const asOf = today();
        const units = db.prepare(`SELECT u.*, p.name AS property_name FROM units u JOIN properties p ON p.id=u.property_id ORDER BY p.name,u.label`).all().map((u) => {
          const ls = db.prepare('SELECT id FROM leases WHERE unit_id=? ORDER BY start_date DESC').all(u.id).map((x) => leaseRow(x.id));
          const cur = ls.find((l) => status(l, asOf) === 'active');
          let state = 'vacant'; if (cur) state = cur.end_date && L.diffDays(asOf, cur.end_date) <= 60 ? 'ending' : 'occupied';
          return { ...u, state, lease: cur ? { id: cur.id, tenant_name: cur.tenant_name, end_date: cur.end_date, rent_cents: cur.rent_cents, balance_due_cents: ledger(cur.id, asOf).balance_due_cents } : null };
        });
        return { units };
      });
      add('GET', '/api/leases', () => {
        const asOf = today();
        return { leases: db.prepare('SELECT id FROM leases ORDER BY start_date DESC, id DESC').all().map((x) => { const l = leaseRow(x.id); return { ...l, status: status(l, asOf), balance_due_cents: ledger(l.id, asOf).balance_due_cents }; }) };
      });
      add('POST', '/api/leases', ({ body }) => tx(() => {
        const unit = db.prepare('SELECT * FROM units WHERE id=?').get(v.int(body.unit_id, 'Unit', { min: 1 })); if (!unit) throw bad('Unknown unit');
        if (!db.prepare('SELECT 1 FROM tenants WHERE id=?').get(v.int(body.tenant_id, 'Tenant', { min: 1 }))) throw bad('Unknown tenant');
        const start = v.date(body.start_date, 'Start date'), end = v.date(body.end_date, 'End date', { required: false });
        if (end && end <= start) throw bad('End date must be after the start date');
        const clash = db.prepare('SELECT id FROM leases WHERE unit_id=? AND start_date<=? AND (end_date IS NULL OR end_date>=?)').get(unit.id, end || '9999-12-31', start);
        if (clash) throw bad('This unit already has a lease overlapping those dates');
        const r = db.prepare(`INSERT INTO leases(unit_id,tenant_id,start_date,end_date,rent_cents,due_day,grace_days,late_fee_cents,deposit_cents) VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(unit.id, body.tenant_id, start, end, v.int(body.rent_cents ?? unit.rent_cents, 'Rent', { min: 1 }), v.int(body.due_day ?? 1, 'Due day', { min: 1, max: 28 }), v.int(body.grace_days ?? 5, 'Grace days', { max: 60 }), v.int(body.late_fee_cents ?? 0, 'Late fee'), v.int(body.deposit_cents ?? 0, 'Deposit'));
        runBilling(db, (f) => f(), today(), true); return { id: Number(r.lastInsertRowid) };
      }));
      add('GET', '/api/leases/:id', ({ params }) => { const l = leaseRow(Number(params.id)); return { lease: { ...l, status: status(l, today()) }, ...ledger(l.id), as_of: today() }; });
      add('POST', '/api/leases/:id/end', ({ params, body }) => tx(() => {
        const l = leaseRow(Number(params.id)); const end = v.date(body.end_date, 'Move-out date');
        if (end < l.start_date) throw bad('Move-out date is before the lease starts');
        if (db.prepare("SELECT 1 FROM charges WHERE lease_id=? AND kind='rent' AND period>?").get(l.id, end.slice(0, 7))) throw bad('Rent is already billed after that date');
        db.prepare('UPDATE leases SET end_date=? WHERE id=?').run(end, l.id);
        // re-prorate the final month if it was already billed in full
        const last = db.prepare("SELECT * FROM charges WHERE lease_id=? AND kind='rent' AND period=?").get(l.id, end.slice(0, 7));
        const want = L.rentCharges({ ...l, end_date: end }, end).find((c) => c.period === end.slice(0, 7));
        if (last && want && want.amount_cents !== last.amount_cents) db.prepare('UPDATE charges SET amount_cents=?, description=? WHERE id=?').run(want.amount_cents, want.description, last.id);
        return { ok: true };
      }));
      add('POST', '/api/leases/:id/payments', ({ params, body }) => {
        const l = leaseRow(Number(params.id)); const paid_on = v.date(body.paid_on, 'Date');
        if (paid_on > today()) throw bad('Payment date cannot be in the future');
        const r = db.prepare('INSERT INTO payments(lease_id,paid_on,amount_cents,method,note) VALUES(?,?,?,?,?)').run(l.id, paid_on, v.int(body.amount_cents, 'Amount', { min: 1 }), v.oneOf(body.method, ['bank', 'cash', 'card', 'cheque'], 'Method'), v.str(body.note, 'Note', { required: false }));
        return { id: Number(r.lastInsertRowid) };
      });
      add('DELETE', '/api/payments/:id', ({ params }) => { db.prepare('DELETE FROM payments WHERE id=?').run(Number(params.id)); return { ok: true }; });
      add('POST', '/api/leases/:id/charges', ({ params, body }) => {
        const l = leaseRow(Number(params.id));
        db.prepare("INSERT INTO charges(lease_id,kind,due_date,amount_cents,description) VALUES(?, 'other',?,?,?)").run(l.id, v.date(body.due_date, 'Due date'), v.int(body.amount_cents, 'Amount', { min: 1 }), v.str(body.description, 'Description', { max: 120 })); return { ok: true };
      });
      add('POST', '/api/charges/:id/waive', ({ params }) => { // late fees and one-off charges can be waived (kept on the ledger, marked waived); rent cannot
        const c = db.prepare('SELECT * FROM charges WHERE id=?').get(Number(params.id)); if (!c) throw new HttpError(404, 'Charge not found');
        if (c.kind === 'rent') throw bad('Rent charges cannot be waived'); db.prepare('UPDATE charges SET waived=1 WHERE id=?').run(c.id); return { ok: true };
      });
      add('GET', '/api/dashboard', () => {
        const asOf = today(), month = asOf.slice(0, 7);
        const units = db.prepare('SELECT id FROM units').all().length;
        const act = db.prepare('SELECT id FROM leases').all().map((x) => leaseRow(x.id)).filter((l) => status(l, asOf) === 'active');
        const ag = { current: 0, d1_30: 0, d31_60: 0, d61_plus: 0 }; let owed = 0; const late = [];
        for (const l of act) { const lg = ledger(l.id, asOf); for (const k in ag) ag[k] += lg.aging[k]; owed += lg.balance_due_cents; if (lg.balance_due_cents > 0) late.push({ lease_id: l.id, tenant_name: l.tenant_name, unit: l.property_name + ' ' + l.unit_label, balance_due_cents: lg.balance_due_cents }); }
        const billed = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM charges WHERE substr(due_date,1,7)=?').get(month).s;
        const collected = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM payments WHERE substr(paid_on,1,7)=?').get(month).s;
        return { as_of: asOf, units, occupied: act.length, occupancy_pct: units ? Math.round((act.length / units) * 100) : 0, monthly_rent_cents: act.reduce((s, l) => s + l.rent_cents, 0),
          billed_this_month_cents: billed, collected_this_month_cents: collected, balance_due_cents: owed, aging: ag, late: late.sort((a, b) => b.balance_due_cents - a.balance_due_cents),
          ending_soon: act.filter((l) => l.end_date && L.diffDays(asOf, l.end_date) <= 60).map((l) => ({ lease_id: l.id, tenant_name: l.tenant_name, unit: l.property_name + ' ' + l.unit_label, end_date: l.end_date })) };
      });
      add('GET', '/api/leases/:id/ledger.csv', ({ params }) => {
        const l = ledger(Number(params.id)); const lines = [...l.charges.map((c) => [c.due_date, 'Charge', c.description, c.amount_cents / 100, c.outstanding_cents / 100]), ...l.payments.map((p) => [p.paid_on, 'Payment', p.method + (p.note ? ' - ' + p.note : ''), -p.amount_cents / 100, ''])].sort((a, b) => a[0].localeCompare(b[0]));
        return csv([['Date', 'Type', 'Description', 'Amount', 'Outstanding'], ...lines]);
      });
    } });
  // Billing at startup so a long-stopped server catches up.
  runBilling(app.db, (fn) => { app.db.exec('BEGIN'); try { const r = fn(); app.db.exec('COMMIT'); return r; } catch (e) { app.db.exec('ROLLBACK'); throw e; } }, today(), true);
  return app;
}
// Idempotent: creates missing monthly rent charges and late fees as of the given date.
function runBilling(db, tx, asOf, quiet) {
  return tx(() => {
    let rent = 0, fees = 0;
    for (const l of db.prepare('SELECT * FROM leases').all()) {
      for (const c of L.rentCharges(l, asOf)) {
        const r = db.prepare("INSERT OR IGNORE INTO charges(lease_id,kind,period,due_date,amount_cents,description) VALUES(?, 'rent',?,?,?,?)").run(l.id, c.period, c.due_date, c.amount_cents, c.description);
        rent += Number(r.changes);
      }
      const charges = db.prepare('SELECT * FROM charges WHERE lease_id=?').all(l.id), payments = db.prepare('SELECT * FROM payments WHERE lease_id=?').all(l.id);
      for (const f of L.lateFeesDue(l, charges, payments, asOf)) {
        db.prepare("INSERT INTO charges(lease_id,kind,ref_charge_id,due_date,amount_cents,description) VALUES(?, 'late_fee',?,?,?,?)").run(l.id, f.ref_charge_id, f.due_date, f.amount_cents, f.description); fees++;
      }
    }
    return { rent_charges_created: rent, late_fees_created: fees, as_of: asOf };
  });
}
module.exports = { build, runBilling };
