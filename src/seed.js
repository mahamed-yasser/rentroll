'use strict';
const L = require('./ledger');
module.exports = function seed(db, asOf, billing) {
  const prop = (n, a) => Number(db.prepare('INSERT INTO properties(name,address) VALUES(?,?)').run(n, a).lastInsertRowid);
  const maple = prop('Maple Court', '14 Maple Street, Springfield'), harbor = prop('Harbor Lofts', '3 Dock Road, Springfield');
  const unit = (p, label, beds, rent) => Number(db.prepare('INSERT INTO units(property_id,label,beds,rent_cents) VALUES(?,?,?,?)').run(p, label, beds, rent).lastInsertRowid);
  const u = { m1a: unit(maple, '1A', 1, 145000), m1b: unit(maple, '1B', 2, 138000), m2a: unit(maple, '2A', 2, 160000), m2b: unit(maple, '2B', 1, 142000), h1: unit(harbor, 'L1', 2, 210000), h2: unit(harbor, 'L2', 2, 195000), h3: unit(harbor, 'L3', 1, 175000), h4: unit(harbor, 'L4', 3, 240000) };
  const ten = (n, e, p) => Number(db.prepare('INSERT INTO tenants(name,email,phone) VALUES(?,?,?)').run(n, e, p).lastInsertRowid);
  const t = [ten('Aisha Khan', 'aisha.khan@mail.example', '+1 555 0101'), ten('Ben Ortiz', 'ben.ortiz@mail.example', '+1 555 0102'), ten('Chloe Martin', 'chloe.m@mail.example', '+1 555 0103'),
    ten('Dmitri Volkov', 'd.volkov@mail.example', '+1 555 0104'), ten('Emma Schulz', 'emma.s@mail.example', '+1 555 0105'), ten('Farid Nasser', 'farid.n@mail.example', '+1 555 0106')];
  const lease = (unitId, tenant, start, end, rent, fee, dep) => Number(db.prepare('INSERT INTO leases(unit_id,tenant_id,start_date,end_date,rent_cents,due_day,grace_days,late_fee_cents,deposit_cents) VALUES(?,?,?,?,?,1,5,?,?)').run(unitId, tenant, start, end, rent, fee, dep).lastInsertRowid);
  // lease id, who pays which months in full (skip = months not paid)
  const defs = [
    [lease(u.m1a, t[0], '2026-01-01', null, 145000, 7500, 145000), '2026-11', []],
    [lease(u.m1b, t[1], '2026-03-01', null, 138000, 7500, 138000), '2026-11', ['2026-10', '2026-11']],
    [lease(u.m2a, t[2], '2026-06-15', null, 160000, 8000, 160000), '2026-10', []],
    [lease(u.h1, t[3], '2025-12-01', '2027-01-15', 210000, 10000, 210000), '2026-11', []],
    [lease(u.h2, t[4], '2026-09-01', null, 195000, 10000, 195000), '2026-11', ['2026-11']],
    [lease(u.h3, t[5], '2025-09-01', '2026-08-31', 175000, 0, 175000), '2026-08', []],
  ];
  for (const [id, upTo, skip] of defs) {
    const l = db.prepare('SELECT * FROM leases WHERE id=?').get(id);
    for (const c of L.rentCharges(l, asOf)) {
      if (c.period > upTo || skip.includes(c.period)) continue;
      const paidOn = c.period === '2026-11' || c.period === '2026-10' ? L.addDays(c.due_date, 1) : L.addDays(c.due_date, 2);
      db.prepare('INSERT INTO payments(lease_id,paid_on,amount_cents,method,note) VALUES(?,?,?,?,?)').run(id, paidOn, c.amount_cents, 'bank', c.period + ' rent');
    }
  }
  db.prepare('INSERT INTO payments(lease_id,paid_on,amount_cents,method,note) VALUES(?,?,?,?,?)').run(defs[4][0], '2026-11-03', 100000, 'bank', 'Part payment, rest promised Friday');
  billing(db, asOf);
  // one fee waived by the manager to show the feature in the ledger
};
