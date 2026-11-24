'use strict';
const { h, api, toast, money, fmtDate, badge, formModal, confirmBox, table, kpi, toolbar, btn, download, mountApp } = UI;
const STATE = { occupied: ['Occupied', 'ok'], vacant: ['Vacant', 'warn'], ending: ['Ending soon', 'info'] };
const toCents = (x) => Math.round(Number(x) * 100);
const dueBadge = (c) => c > 0 ? badge(money(c), 'bad') : badge('Paid up', 'ok');

async function dashboard(el) {
  const d = await api('GET', '/api/dashboard'); const a = d.aging;
  const total = Object.values(a).reduce((x, y) => x + y, 0) || 1;
  el.append(h('div', { class: 'grid g4' },
    kpi('Occupancy', d.occupancy_pct + '%', d.occupied + ' of ' + d.units + ' units'), kpi('Monthly rent roll', money(d.monthly_rent_cents), 'active leases'),
    kpi('Collected this month', money(d.collected_this_month_cents), 'billed ' + money(d.billed_this_month_cents)), kpi('Overdue balance', money(d.balance_due_cents), d.late.length + ' leases', d.balance_due_cents ? 'bad' : 'ok')));
  const bucket = (label, k) => h('li', {}, h('div', { style: 'flex:1' }, h('div', { class: 'row spread' }, label, h('b', {}, money(a[k]))), h('div', { class: 'bar' }, h('i', { style: 'width:' + Math.round((a[k] / total) * 100) + '%' }))));
  el.append(h('div', { class: 'grid g2', style: 'margin-top:14px' },
    h('div', { class: 'card' }, h('h2', {}, 'Who owes rent'), d.late.length ? h('ul', { class: 'list' }, d.late.map((l) => h('li', {}, h('a', { href: '#/leases/' + l.lease_id }, l.tenant_name + ' · ' + l.unit), h('b', {}, money(l.balance_due_cents))))) : h('p', { class: 'muted' }, 'Everyone is paid up.'),
      d.ending_soon.length ? [h('h2', { style: 'margin-top:14px' }, 'Leases ending within 60 days'), h('ul', { class: 'list' }, d.ending_soon.map((l) => h('li', {}, h('a', { href: '#/leases/' + l.lease_id }, l.tenant_name + ' · ' + l.unit), fmtDate(l.end_date))))] : null),
    h('div', { class: 'card' }, h('h2', {}, 'Overdue by age'), h('ul', { class: 'list' }, bucket('Not yet due', 'current'), bucket('1 to 30 days late', 'd1_30'), bucket('31 to 60 days', 'd31_60'), bucket('Over 60 days', 'd61_plus')),
      h('p', { class: 'muted small' }, 'As of ' + fmtDate(d.as_of)))));
}

async function units(el) {
  const { units: rows } = await api('GET', '/api/units'); const { properties } = await api('GET', '/api/properties');
  el.append(toolbar(h('span', { class: 'grow muted' }, rows.length + ' units'),
    btn('Add property', async () => { if (await formModal({ title: 'Add property', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'address', label: 'Address', required: true }], onSubmit: (v) => api('POST', '/api/properties', v) })) location.reload(); }),
    btn('Add unit', async () => {
      if (await formModal({ title: 'Add unit', fields: [{ name: 'property_id', label: 'Property', type: 'select', options: properties.map((p) => [p.id, p.name]) }, { name: 'label', label: 'Unit', required: true }, { name: 'beds', label: 'Bedrooms', type: 'number', min: 0 }, { name: 'rent', label: 'Monthly rent', type: 'number', step: '0.01', required: true }],
        values: { beds: 1 }, onSubmit: (v) => api('POST', '/api/units', { property_id: Number(v.property_id), label: v.label, beds: v.beds, rent_cents: toCents(v.rent) }) })) location.reload();
    }, 'primary')));
  el.append(table([
    { label: 'Unit', render: (u) => h('div', {}, h('b', {}, u.property_name + ' ' + u.label), h('div', { class: 'muted small' }, u.beds + ' bed')) },
    { label: 'Status', render: (u) => badge(STATE[u.state][0], STATE[u.state][1]) }, { label: 'Tenant', render: (u) => u.lease ? h('a', { href: '#/leases/' + u.lease.id }, u.lease.tenant_name) : h('span', { class: 'muted' }, '-') },
    { label: 'Rent', class: 'r', render: (u) => money(u.lease ? u.lease.rent_cents : u.rent_cents) }, { label: 'Lease ends', render: (u) => u.lease && u.lease.end_date ? fmtDate(u.lease.end_date) : '' },
    { label: 'Balance', class: 'r', render: (u) => u.lease ? dueBadge(u.lease.balance_due_cents) : '' }], rows));
}

async function leases(el, args) {
  if (args[0]) return leaseDetail(el, args[0]);
  const [{ leases: rows }, { units: us }, { tenants }] = await Promise.all([api('GET', '/api/leases'), api('GET', '/api/units'), api('GET', '/api/tenants')]);
  el.append(toolbar(h('span', { class: 'grow' }), btn('Run billing', async () => { const r = await api('POST', '/api/billing/run'); toast(`Billing run: ${r.rent_charges_created} rent charges, ${r.late_fees_created} late fees`); location.reload(); }),
    btn('New lease', async () => {
      const r = await formModal({ title: 'New lease', fields: [
        { name: 'unit_id', label: 'Unit', type: 'select', options: us.map((u) => [u.id, u.property_name + ' ' + u.label + ' (' + money(u.rent_cents) + ')']) }, { name: 'tenant_id', label: 'Tenant', type: 'select', options: tenants.map((t) => [t.id, t.name]) },
        { name: 'start_date', label: 'Start date', type: 'date', required: true }, { name: 'end_date', label: 'End date (optional)', type: 'date' },
        { name: 'rent', label: 'Monthly rent (blank = unit rent)', type: 'number', step: '0.01' }, { name: 'due_day', label: 'Rent due day (1-28)', type: 'number', min: 1, max: 28 },
        { name: 'late_fee', label: 'Late fee', type: 'number', step: '0.01' }, { name: 'grace_days', label: 'Grace days', type: 'number', min: 0 }, { name: 'deposit', label: 'Deposit', type: 'number', step: '0.01' }],
        values: { due_day: 1, grace_days: 5, late_fee: 0, deposit: 0 }, submit: 'Create lease',
        onSubmit: (v) => api('POST', '/api/leases', { unit_id: Number(v.unit_id), tenant_id: Number(v.tenant_id), start_date: v.start_date, end_date: v.end_date || null, rent_cents: v.rent ? toCents(v.rent) : undefined, due_day: v.due_day, late_fee_cents: toCents(v.late_fee || 0), grace_days: v.grace_days, deposit_cents: toCents(v.deposit || 0) }) });
      if (r) { toast('Lease created and first rent billed'); location.reload(); }
    }, 'primary')));
  el.append(table([{ label: 'Tenant', key: 'tenant_name' }, { label: 'Unit', render: (l) => l.property_name + ' ' + l.unit_label }, { label: 'Term', render: (l) => fmtDate(l.start_date) + ' to ' + (l.end_date ? fmtDate(l.end_date) : 'ongoing') },
    { label: 'Rent', class: 'r', render: (l) => money(l.rent_cents) }, { label: 'Status', render: (l) => badge(l.status, l.status === 'active' ? 'ok' : '') }, { label: 'Balance', class: 'r', render: (l) => dueBadge(l.balance_due_cents) }], rows, { onRow: (l) => { location.hash = '#/leases/' + l.id; } }));
}

async function leaseDetail(el, id) {
  const g = await api('GET', '/api/leases/' + id); const l = g.lease;
  const refresh = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const lines = [...g.charges.map((c) => ({ date: c.due_date, charge: c })), ...g.payments.map((p) => ({ date: p.paid_on, payment: p }))].sort((a, b) => a.date.localeCompare(b.date) || (a.charge ? -1 : 1));
  el.append(h('p', {}, h('a', { href: '#/leases' }, '← All leases')),
    h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('div', {}, h('h2', {}, l.tenant_name + ' · ' + l.property_name + ' ' + l.unit_label), h('div', { class: 'muted' }, fmtDate(l.start_date) + ' to ' + (l.end_date ? fmtDate(l.end_date) : 'ongoing') + ' · rent ' + money(l.rent_cents) + ' due day ' + l.due_day + ' · late fee ' + money(l.late_fee_cents) + ' after ' + l.grace_days + ' days · deposit ' + money(l.deposit_cents))),
      h('div', { class: 'row' }, badge(l.status, l.status === 'active' ? 'ok' : ''), h('div', { class: 'kpi ' + (g.balance_due_cents ? 'bad' : 'ok'), style: 'padding:6px 12px' }, h('div', { class: 'kpi-label' }, 'Balance due'), h('b', { id: 'balance' }, money(g.balance_due_cents))))),
      g.credit_cents ? h('p', { class: 'muted' }, 'Credit on account: ' + money(g.credit_cents)) : null,
      h('div', { class: 'toolbar', style: 'margin-top:10px' },
        btn('Record payment', async () => {
          const r = await formModal({ title: 'Record payment', fields: [{ name: 'amount', label: 'Amount', type: 'number', step: '0.01', required: true }, { name: 'paid_on', label: 'Date received', type: 'date', required: true }, { name: 'method', label: 'Method', type: 'select', options: [['bank', 'Bank transfer'], ['cash', 'Cash'], ['card', 'Card'], ['cheque', 'Cheque']] }, { name: 'note', label: 'Note' }],
            values: { paid_on: g.as_of, amount: (g.balance_due_cents / 100).toFixed(2) }, submit: 'Record payment', onSubmit: (v) => api('POST', `/api/leases/${id}/payments`, { amount_cents: toCents(v.amount), paid_on: v.paid_on, method: v.method, note: v.note }) });
          if (r) { toast('Payment recorded'); refresh(); }
        }, 'primary'),
        btn('Add charge', async () => { const r = await formModal({ title: 'Add one-off charge', fields: [{ name: 'description', label: 'Description', required: true, wide: true }, { name: 'amount', label: 'Amount', type: 'number', step: '0.01', required: true }, { name: 'due_date', label: 'Due date', type: 'date', required: true }], values: { due_date: g.as_of }, onSubmit: (v) => api('POST', `/api/leases/${id}/charges`, { description: v.description, amount_cents: toCents(v.amount), due_date: v.due_date }) }); if (r) refresh(); }),
        l.status === 'active' ? btn('Move out', async () => { const r = await formModal({ title: 'Move out', note: 'Sets the lease end date and prorates the final month of rent.', fields: [{ name: 'end_date', label: 'Last day', type: 'date', required: true }], values: { end_date: g.as_of }, onSubmit: (v) => api('POST', `/api/leases/${id}/end`, v) }); if (r) refresh(); }) : null,
        btn('Download ledger CSV', async () => download(`ledger-${id}.csv`, await (await fetch(`/api/leases/${id}/ledger.csv`)).text())), btn('Print statement', () => window.print()))),
    table([{ label: 'Date', render: (r) => fmtDate(r.date) }, { label: 'Description', render: (r) => r.charge ? [r.charge.description, r.charge.waived ? badge('Waived') : null] : 'Payment' + (r.payment.note ? ' · ' + r.payment.note : '') + ' (' + r.payment.method + ')' },
      { label: 'Charge', class: 'r', render: (r) => r.charge ? h('span', { class: r.charge.waived ? 'muted' : '' }, money(r.charge.amount_cents)) : '' }, { label: 'Payment', class: 'r', render: (r) => r.payment ? money(r.payment.amount_cents) : '' },
      { label: 'Outstanding', class: 'r', render: (r) => r.charge && r.charge.outstanding_cents ? badge(money(r.charge.outstanding_cents), r.charge.due_date <= g.as_of ? 'bad' : '') : '' },
      { label: '', render: (r) => r.charge && r.charge.kind !== 'rent' && !r.charge.waived ? btn('Waive', async () => { if (await confirmBox('Waive this charge?', r.charge.description + ' stays on the ledger, marked waived.', 'Waive')) { await api('POST', `/api/charges/${r.charge.id}/waive`); refresh(); } }, 'sm') : r.payment ? btn('Void', async () => { if (await confirmBox('Void this payment?', 'It will be removed and balances recalculated.', 'Void payment')) { await api('DELETE', `/api/payments/${r.payment.id}`); refresh(); } }, 'sm danger') : '' }], lines));
}

async function tenants(el) {
  const draw = async () => {
    const { tenants: rows } = await api('GET', '/api/tenants');
    el.replaceChildren(toolbar(h('span', { class: 'grow' }), btn('Add tenant', async () => { if (await formModal({ title: 'Add tenant', fields: [{ name: 'name', label: 'Full name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'phone', label: 'Phone' }], onSubmit: (v) => api('POST', '/api/tenants', v) })) draw(); }, 'primary')),
      table([{ label: 'Name', key: 'name' }, { label: 'Email', key: 'email' }, { label: 'Phone', key: 'phone' }], rows));
  };
  await draw();
}
mountApp({ title: 'RentRoll', tagline: 'Rent, leases and late fees for small landlords', accent: '#7c3aed', views: [
  { id: 'dashboard', label: 'Dashboard', render: dashboard }, { id: 'units', label: 'Units', render: units }, { id: 'leases', label: 'Leases & ledgers', render: leases }, { id: 'tenants', label: 'Tenants', render: tenants }] });
