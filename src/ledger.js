'use strict';
// Pure rent-ledger maths. Money is integer cents, dates are YYYY-MM-DD strings (UTC).
const pad = (n) => String(n).padStart(2, '0');
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const diffDays = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);

// One rent charge per calendar month from lease start up to (and including) the month of asOf. First/last months are prorated by days.
function rentCharges(lease, asOf) {
  const out = []; let [y, m] = lease.start_date.split('-').map(Number); const [ay, am] = asOf.split('-').map(Number);
  while (y * 12 + m <= ay * 12 + am) {
    const dim = daysIn(y, m), first = `${y}-${pad(m)}-01`, last = `${y}-${pad(m)}-${pad(dim)}`;
    if (lease.end_date && lease.end_date < first) break;
    const s = lease.start_date > first ? lease.start_date : first, e = lease.end_date && lease.end_date < last ? lease.end_date : last;
    const days = diffDays(s, e) + 1, amount = days === dim ? lease.rent_cents : Math.round((lease.rent_cents * days) / dim);
    let due = `${y}-${pad(m)}-${pad(Math.min(lease.due_day, dim))}`; if (due < s) due = s;
    if (amount > 0) out.push({ period: `${y}-${pad(m)}`, due_date: due, amount_cents: amount, description: days === dim ? 'Rent' : `Rent (prorated ${days}/${dim} days)` });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
// First-in-first-out allocation of all payments against charges ordered by due date.
function allocate(charges, payments) {
  let pool = payments.reduce((s, p) => s + p.amount_cents, 0);
  const rows = [...charges].sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id - b.id).map((c) => {
    const paid = Math.min(pool, c.amount_cents); pool -= paid; return { ...c, paid_cents: paid, outstanding_cents: c.amount_cents - paid };
  });
  return { rows, credit_cents: pool };
}
// Late fee is due once per rent charge when it was still unpaid at the end of the grace period.
function lateFeesDue(lease, charges, payments, asOf) {
  if (!lease.late_fee_cents) return [];
  const fees = [];
  for (const c of charges) {
    if (c.kind !== 'rent' || charges.some((f) => f.kind === 'late_fee' && f.ref_charge_id === c.id)) continue;
    const deadline = addDays(c.due_date, lease.grace_days);
    if (asOf <= deadline) continue;
    const { rows } = allocate(charges.filter((x) => x.kind !== 'late_fee' && x.due_date <= deadline), payments.filter((p) => p.paid_on <= deadline));
    const r = rows.find((x) => x.id === c.id);
    if (r && r.outstanding_cents > 0) fees.push({ ref_charge_id: c.id, due_date: addDays(deadline, 1), amount_cents: lease.late_fee_cents, description: `Late fee for ${c.period}` });
  }
  return fees;
}
const bucketOf = (daysPast) => (daysPast <= 0 ? 'current' : daysPast <= 30 ? 'd1_30' : daysPast <= 60 ? 'd31_60' : 'd61_plus');
function aging(rows, asOf) {
  const b = { current: 0, d1_30: 0, d31_60: 0, d61_plus: 0 };
  for (const r of rows) if (r.outstanding_cents > 0) b[bucketOf(diffDays(r.due_date, asOf))] += r.outstanding_cents;
  return b;
}
module.exports = { rentCharges, allocate, lateFeesDue, aging, addDays, diffDays, daysIn };
