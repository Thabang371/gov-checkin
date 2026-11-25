/* Visitor register + daily report tabs on the staff dashboard. Charts are plain SVG, no library. */
(() => {
  'use strict';
  const app = () => window.staffApp;
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const BAR = '#2f6fa8'; // single-series colour (validated: contrast and lightness pass on white)
  const view = { regDate: null, repDate: null, register: null };

  const todayLocal = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // ---------- Visitor register ----------
  async function loadRegister({ quiet } = {}) {
    const { api, state, toast } = app();
    const isAdmin = ['SITE_ADMIN', 'NATIONAL_ADMIN'].includes(state.user.role);
    const dateInput = $('reg-date');
    if (!view.regDate) view.regDate = todayLocal();
    dateInput.value = view.regDate;
    dateInput.max = todayLocal();
    dateInput.disabled = !isAdmin; // reception sees today only
    dateInput.title = isAdmin ? '' : 'Reception can see today only';
    try {
      view.register = await api(`/api/sites/${state.siteId}/register?date=${view.regDate}`);
      renderRegister();
    } catch (err) {
      if (!quiet) toast(err.message);
    }
  }

  function renderRegister() {
    const { h, idText, time } = app();
    const all = view.register.rows;
    const q = $('reg-search').value.trim().toLowerCase();
    const rows = q ? all.filter((r) => r.fullName.toLowerCase().includes(q) || r.idLast4.includes(q)) : all;
    const inside = all.filter((r) => r.stillInside).length;
    const visitors = all.filter((r) => r.kind === 'visitor').length;
    $('reg-summary').textContent =
      `${all.length} ${all.length === 1 ? 'person' : 'people'} signed in · ${inside} still inside · ${visitors} visiting an office · no names written by hand`;
    $('reg-rows').replaceChildren(
      ...(rows.length ? rows.map((r) => h('tr', {},
        h('td', {}, time(r.checkedInAt)),
        h('td', {}, r.stillInside ? h('span', { class: 'pill inside' }, 'Inside')
          : [time(r.checkedOutAt), r.autoClosed ? h('span', { class: 'pill auto', title: 'Did not scan out; closed at end of day' }, ' auto') : null]),
        h('td', {}, r.fullName),
        h('td', { class: 'muted' }, idText(r)),
        h('td', {},
          r.kind === 'visitor' ? [h('span', { class: 'pill visitor' }, 'Visitor'), ' ', r.reason.replace(/^Visiting: /, '')]
            : r.kind === 'unknown' ? [h('span', { class: 'muted' }, 'Not given '),
              r.stillInside && view.register.date === todayLocal() ? h('button', { class: 'btn tiny', type: 'button', onclick: () => openReason(r) }, 'Add reason') : null]
              : r.reason,
          r.reasonAddedBy ? h('span', { class: 'added-by' }, `Added by ${r.reasonAddedBy}`) : null),
        h('td', {}, r.ticketNo ? h('span', { class: 'tno' }, r.ticketNo) : '–'),
        h('td', { class: 'num' }, String(r.minutesInside)),
      )) : [h('tr', { class: 'empty' }, h('td', { colspan: 7 }, q ? 'No match' : 'Nobody signed in on this day'))]),
    );
  }

  $('reg-search').addEventListener('input', () => view.register && renderRegister());
  $('reg-date').addEventListener('change', (e) => { view.regDate = e.target.value; loadRegister(); });
  $('reg-csv').addEventListener('click', () => download('csv'));
  $('reg-xlsx').addEventListener('click', () => download('xlsx'));
  async function download(format) {
    const { state, toast } = app();
    try {
      // Fetch with the login token, then hand the file to the browser
      const res = await fetch(`/api/sites/${state.siteId}/register?date=${view.regDate}&format=${format}`, {
        headers: { authorization: `Bearer ${state.token}` },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Download failed');
      const blob = await res.blob();
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob),
        download: `visitor-register-${view.regDate}.${format}`,
      });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------- Add reason (reception fills in a missing reason) ----------
  const choices = { services: null, offices: null };
  async function openReason(r) {
    const { api, state, h, toast } = app();
    try {
      choices.services = choices.services || await api('/api/service-types');
      choices.offices = await api(`/api/sites/${state.siteId}/departments`);
    } catch (err) { toast(err.message); return; }
    $('reason-who').textContent = `${r.fullName} · checked in at ${app().time(r.checkedInAt)}`;
    $('reason-error').textContent = '';
    $('reason-host').value = '';
    const pick = async (fn) => {
      for (const b of document.querySelectorAll('#reason-dialog .choice-grid button')) b.disabled = true;
      try {
        await fn();
        closeReason();
        await loadRegister();
      } catch (err) {
        $('reason-error').textContent = err.message;
        for (const b of document.querySelectorAll('#reason-dialog .choice-grid button')) b.disabled = false;
      }
    };
    $('reason-services').replaceChildren(...choices.services.map((s) => h('button', { type: 'button', onclick: () => pick(async () => {
      const t = await api(`/api/visits/${r.visitId}/ticket`, { method: 'POST', body: { serviceTypeId: s.id } });
      toast(`${r.fullName} queued: ticket ${t.ticketNo}`);
    }) }, h('span', { class: 'prefix' }, s.prefix), s.name)));
    $('reason-offices').replaceChildren(...choices.offices.map((d) => h('button', { type: 'button', onclick: () => pick(async () => {
      await api(`/api/visits/${r.visitId}/purpose`, { method: 'POST', body: { departmentId: d.id, hostName: $('reason-host').value.trim() || undefined } });
      toast(`${r.fullName}: visiting ${d.name}`);
    }) }, d.name)));
    $('reason-dialog').hidden = false;
  }
  function closeReason() { $('reason-dialog').hidden = true; }
  $('reason-cancel').addEventListener('click', closeReason);
  $('reason-dialog').addEventListener('click', (e) => { if (e.target.id === 'reason-dialog') closeReason(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('reason-dialog').hidden) closeReason(); });

  // ---------- Daily report ----------
  async function loadReport() {
    const { api, state, toast } = app();
    if (!view.repDate) view.repDate = todayLocal();
    $('rep-date').value = view.repDate;
    $('rep-date').max = todayLocal();
    try {
      const r = await api(`/api/sites/${state.siteId}/report?date=${view.repDate}`);
      renderReport(r);
    } catch (err) {
      toast(err.message);
    }
  }
  $('rep-date').addEventListener('change', (e) => { view.repDate = e.target.value; loadReport(); });
  $('rep-print').addEventListener('click', () => window.print());

  const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;
  const shortDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
  const longDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const min = (v) => (v == null ? '–' : `${v} min`);

  function renderReport(r) {
    const { h } = app();
    const t = r.totals;
    $('rep-subtitle').textContent = `${r.site} · ${longDate(r.date)}`;
    const kpi = (label, value, note) => h('div', { class: 'stat' },
      h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), note ? h('div', { class: 'stat-note' }, note) : null);
    $('rep-kpis').replaceChildren(
      kpi('Visits', String(t.visits), `${t.serviceVisits} for a service · ${t.visitorVisits} visiting an office${t.reasonNotGiven ? ` · ${t.reasonNotGiven} no reason given` : ''}`),
      kpi('Served', String(t.served), `${t.skipped} didn't come when called${t.openTickets ? ` · ${t.openTickets} still open` : ''}`),
      kpi('Average wait', min(t.avgWaitMin), t.p90WaitMin == null ? '' : `9 in 10 people waited ${t.p90WaitMin} min or less`),
      kpi('Waited over 30 min', String(t.waitsOver30), t.ticketsIssued ? `${Math.round((t.waitsOver30 / t.ticketsIssued) * 100)}% of tickets` : ''),
    );

    // Check-ins by hour: fill the opening hours so quiet hours show as zero, not missing
    const hours = [];
    for (let hr = 7; hr <= 17; hr++) {
      const found = r.byHour.find((x) => x.hour === hr);
      hours.push({ label: hourLabel(hr), value: found ? found.checkins : 0, tip: found ? `${found.checkins} check-ins · avg wait ${min(found.avgWaitMin)}` : '0 check-ins' });
    }
    const peakIdx = r.peakHour ? hours.findIndex((x) => x.label === hourLabel(r.peakHour.hour)) : -1;
    $('rep-peak').textContent = r.peakHour ? `Busiest: ${hourLabel(r.peakHour.hour)}–${hourLabel(r.peakHour.hour + 1)}` : '';
    barChart($('chart-hours'), hours, { labelIndex: peakIdx, unit: 'check-ins' });

    const trend = r.trend.map((d) => ({ label: shortDate(d.date), value: d.visits, tip: `${longDate(d.date)}: ${d.visits} visits`, date: d.date }));
    barChart($('chart-trend'), trend, { labelIndex: trend.length - 1, unit: 'visits', labelEvery: 2 });
    const waits = r.trend.map((d) => ({ label: shortDate(d.date), value: d.avgWaitMin, tip: `${longDate(d.date)}: ${d.avgWaitMin == null ? 'no tickets' : `avg wait ${d.avgWaitMin} min`}` }));
    lineChart($('chart-wait'), waits, { unit: 'min', labelEvery: 2 });

    const a = r.appointments;
    const kv = (k, v) => h('div', { class: 'kv' }, h('span', {}, k), h('b', {}, String(v)));
    $('rep-appts').replaceChildren(
      kv('Booked for this day', a.booked),
      kv('Served', a.served),
      kv("Didn't turn up", a.noShow),
      ...(a.checkedIn ? [kv('Checked in, not finished', a.checkedIn)] : []),
      ...(a.pending ? [kv('Still to come', a.pending)] : []),
    );
    $('rep-depts').replaceChildren(
      ...(r.byDepartment.length ? r.byDepartment.map((d) => kv(d.department, d.visits)) : [h('p', { class: 'muted small' }, 'No walk-in visitors')]),
    );
    $('rep-services').replaceChildren(
      ...(r.byService.length ? r.byService.map((s) => h('tr', {},
        h('td', {}, h('span', { class: 'tno' }, s.prefix), ' ', s.service),
        h('td', { class: 'num' }, String(s.tickets)),
        h('td', { class: 'num' }, String(s.served)),
        h('td', { class: 'num' }, String(s.skipped)),
        h('td', { class: 'num' }, min(s.avgWaitMin)),
        h('td', { class: `num ${s.maxWaitMin >= 30 ? 'long' : ''}` }, min(s.maxWaitMin)),
        h('td', { class: 'num' }, min(s.avgServiceMin)),
      )) : [h('tr', { class: 'empty' }, h('td', { colspan: 7 }, 'No tickets on this day'))]),
    );
  }

  // ---------- tiny SVG charts ----------
  function svgEl(tag, attrs) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }
  function niceMax(v) {
    if (v <= 5) return 5;
    const step = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= v) return m * step;
    return v;
  }
  function frame(container, data, W = 600, H = 220) {
    container.replaceChildren();
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
    const pad = { l: 34, r: 8, t: 22, b: 26 };
    const vals = data.map((d) => d.value ?? 0);
    const top = niceMax(Math.max(1, ...vals));
    const y = (v) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
    // recessive gridlines + y labels (0, half, top)
    for (const g of [0, top / 2, top]) {
      svg.append(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y(g), y2: y(g), stroke: '#e3e7ec', 'stroke-width': 1 }));
      const lbl = svgEl('text', { x: pad.l - 6, y: y(g) + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#5b6470' });
      lbl.textContent = Number.isInteger(g) ? g : g.toFixed(1);
      svg.append(lbl);
    }
    container.append(svg);
    return { svg, W, H, pad, y, top };
  }
  function xLabel(svg, x, H, pad, text) {
    const t = svgEl('text', { x, y: H - pad.b + 16, 'text-anchor': 'middle', 'font-size': 11, fill: '#5b6470' });
    t.textContent = text;
    svg.append(t);
  }
  function tooltip(target, html) {
    const tip = $('tooltip');
    target.addEventListener('mousemove', (e) => {
      tip.innerHTML = html; // html is built from numbers and dates only, never user text
      tip.hidden = false;
      tip.style.left = `${Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8)}px`;
      tip.style.top = `${e.clientY - tip.offsetHeight - 10}px`;
    });
    target.addEventListener('mouseleave', () => { tip.hidden = true; });
  }

  function barChart(container, data, { labelIndex = -1, labelEvery = 1 } = {}) {
    if (!data.some((d) => d.value)) { container.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'No data for this day' })); return; }
    const { svg, W, H, pad, y } = frame(container, data);
    const slot = (W - pad.l - pad.r) / data.length;
    const bw = Math.min(28, slot * 0.6);
    data.forEach((d, i) => {
      const cx = pad.l + slot * i + slot / 2;
      const v = d.value ?? 0;
      if (v > 0) {
        const x0 = cx - bw / 2, y0 = y(v), yb = y(0), r = Math.min(4, (yb - y0) / 2);
        // rounded top, flat on the baseline
        svg.append(svgEl('path', {
          d: `M${x0},${yb} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x0 + bw - r} Q${x0 + bw},${y0} ${x0 + bw},${y0 + r} V${yb} Z`,
          fill: BAR,
        }));
      }
      if (i === labelIndex && v > 0) {
        const t = svgEl('text', { x: cx, y: y(v) - 6, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: '#111418' });
        t.textContent = v;
        svg.append(t);
      }
      if ((data.length - 1 - i) % labelEvery === 0) xLabel(svg, cx, H, pad, d.label); // count from the newest so labels never collide
      // hit target: the whole column, bigger than the bar
      const hit = svgEl('rect', { x: cx - slot / 2, y: pad.t, width: slot, height: H - pad.t - pad.b, fill: 'transparent' });
      tooltip(hit, `<b>${d.label}</b><br>${d.tip}`);
      svg.append(hit);
    });
  }

  function lineChart(container, data, { labelEvery = 1 } = {}) {
    if (!data.some((d) => d.value != null)) { container.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'No data' })); return; }
    const { svg, W, H, pad, y } = frame(container, data);
    const slot = (W - pad.l - pad.r) / data.length;
    const pts = data.map((d, i) => ({ ...d, cx: pad.l + slot * i + slot / 2 }));
    // break the line on days with no tickets (Sundays) instead of drawing through them
    let path = '';
    let pen = false;
    for (const p of pts) {
      if (p.value == null) { pen = false; continue; }
      path += `${pen ? 'L' : 'M'}${p.cx},${y(p.value)} `;
      pen = true;
    }
    svg.append(svgEl('path', { d: path, fill: 'none', stroke: BAR, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    pts.forEach((p, i) => {
      if (p.value != null) svg.append(svgEl('circle', { cx: p.cx, cy: y(p.value), r: 4, fill: BAR, stroke: '#fff', 'stroke-width': 2 }));
      if ((pts.length - 1 - i) % labelEvery === 0) xLabel(svg, p.cx, H, pad, p.label);
      const hit = svgEl('rect', { x: p.cx - slot / 2, y: pad.t, width: slot, height: H - pad.t - pad.b, fill: 'transparent' });
      tooltip(hit, `<b>${p.label}</b><br>${p.tip}`);
      svg.append(hit);
    });
    const last = [...pts].reverse().find((p) => p.value != null);
    if (last) {
      const t = svgEl('text', { x: last.cx, y: y(last.value) - 10, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: '#111418' });
      t.textContent = `${last.value} min`;
      svg.append(t);
    }
  }

  window.staffViews = {
    show(name, opts) {
      if (name === 'register') return loadRegister(opts);
      if (name === 'report') return loadReport();
    },
  };
})();
