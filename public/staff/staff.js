/* Staff dashboard: officers call and serve tickets; reception sees who is inside and checks people out.
   Updates live from the server's event stream. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SERVERS = ['OFFICER', 'SITE_ADMIN', 'NATIONAL_ADMIN'];
  const FRONT_DESK = ['RECEPTION', 'SITE_ADMIN', 'NATIONAL_ADMIN'];
  const ROLE_LABEL = { RECEPTION: 'Reception', OFFICER: 'Officer', SITE_ADMIN: 'Site admin', NATIONAL_ADMIN: 'National admin' };
  const LONG_WAIT_MIN = 30;

  const state = { token: null, user: null, siteId: null, deskId: null, desks: [], queue: null, inside: null, stopLive: null, refreshTimer: null, busy: false };

  // ---------- storage ----------
  const session = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* memory only */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const local = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  // ---------- API ----------
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && state.token) { signOut('Your session ended. Please sign in again.'); }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------- small DOM helper ----------
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  const minutesSince = (iso) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const idText = (t) => `${t.idType === 'OMANG' ? 'Omang' : t.idType === 'PASSPORT' ? 'Passport' : 'Permit'} ••${t.idLast4}`;

  // ---------- sign in / out ----------
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    const btn = e.submitter || $('login-form').querySelector('button');
    btn.disabled = true;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sign-in failed');
      state.token = data.token;
      session.set('govcheckin.token', data.token);
      $('password').value = '';
      await start();
    } catch (err) {
      $('login-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $('logout').addEventListener('click', () => signOut());

  function signOut(message) {
    if (state.stopLive) state.stopLive();
    state.stopLive = null;
    state.token = null;
    session.del('govcheckin.token');
    $('app').hidden = true;
    $('login').hidden = false;
    $('login-error').textContent = message || '';
  }

  // ---------- start ----------
  async function start() {
    state.user = await api('/api/auth/me');
    const u = state.user;
    $('user-name').textContent = u.fullName;
    $('user-role').textContent = ROLE_LABEL[u.role] || u.role;

    const sites = await api('/api/sites');
    const remembered = Number(local.get('govcheckin.site'));
    state.siteId = u.siteId || (sites.find((s) => s.id === remembered) || sites[0]).id;
    if (u.role === 'NATIONAL_ADMIN' && sites.length > 1) {
      const sel = $('site-select');
      sel.replaceChildren(...sites.map((s) => h('option', { value: s.id, selected: s.id === state.siteId }, s.name)));
      sel.hidden = false;
      $('site-name').hidden = true;
      sel.onchange = () => { state.siteId = Number(sel.value); local.set('govcheckin.site', sel.value); switchSite(); };
    } else {
      $('site-name').textContent = sites.find((s) => s.id === state.siteId)?.name || '';
    }

    const canServe = SERVERS.includes(u.role);
    const canSeeInside = FRONT_DESK.includes(u.role);
    $('desk-panel').hidden = !canServe;
    $('inside-panel').hidden = !canSeeInside;
    document.querySelector('.grid').classList.toggle('no-desk', !canServe);

    $('login').hidden = true;
    $('app').hidden = false;
    await switchSite();
    clearInterval(state.tick);
    state.tick = setInterval(renderQueue, 30000); // keep "waiting N min" fresh
  }

  async function switchSite() {
    if (state.stopLive) state.stopLive();
    state.deskId = null;
    if (SERVERS.includes(state.user.role)) await loadDesks();
    state.stopLive = window.liveStream(
      `/api/sites/${state.siteId}/events`,
      { authorization: `Bearer ${state.token}` },
      onLiveEvent,
      setLive,
    );
    await refresh();
  }

  function setLive(status) {
    const el = $('live');
    el.className = `live ${status === 'live' ? 'on' : 'off'}`;
    $('live-text').textContent = status === 'live' ? 'Live' : status === 'unauthorized' ? 'Signed out' : 'Reconnecting';
    if (status === 'unauthorized') signOut('Your session ended. Please sign in again.');
  }

  function onLiveEvent(evt) {
    if (evt.type === 'checkin' && state.queue) state.flashNext = true;
    // Many events can arrive together (a busy morning); refresh at most every 300 ms
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(refresh, 300);
  }

  // ---------- data ----------
  async function loadDesks() {
    state.desks = await api(`/api/sites/${state.siteId}/desks`);
    const sel = $('desk-select');
    const saved = Number(local.get(`govcheckin.desk.${state.user.id}.${state.siteId}`));
    state.deskId = (state.desks.find((d) => d.id === saved) || state.desks[0] || {}).id ?? null;
    sel.replaceChildren(...state.desks.map((d) => h('option', { value: d.id, selected: d.id === state.deskId }, d.name)));
    sel.onchange = () => {
      state.deskId = Number(sel.value);
      local.set(`govcheckin.desk.${state.user.id}.${state.siteId}`, sel.value);
      deskMsg('');
      renderDesk();
    };
  }

  async function refresh() {
    try {
      const jobs = [api(`/api/sites/${state.siteId}/queue`)];
      if (FRONT_DESK.includes(state.user.role)) jobs.push(api(`/api/sites/${state.siteId}/occupancy`));
      const [queue, inside] = await Promise.all(jobs);
      const before = new Set((state.queue?.tickets || []).map((t) => t.id));
      state.queue = queue;
      state.inside = inside || null;
      state.newIds = new Set(queue.tickets.filter((t) => before.size && !before.has(t.id)).map((t) => t.id));
      renderStats();
      renderQueue();
      renderDesk();
      renderInside();
    } catch (err) {
      if (err.status !== 401) toast(err.message);
    }
  }

  // ---------- render ----------
  function renderStats() {
    const s = state.queue.stats;
    $('s-inside').textContent = s.inside;
    $('s-waiting').textContent = s.waiting;
    $('s-served').textContent = s.servedToday;
    $('s-wait').textContent = s.avgWaitMin == null ? '–' : `${s.avgWaitMin} min`;
  }

  function renderQueue() {
    if (!state.queue) return;
    const tickets = state.queue.tickets;
    const serving = tickets.filter((t) => t.status !== 'WAITING');
    const waiting = tickets.filter((t) => t.status === 'WAITING');
    $('queue-count').textContent = `${waiting.length} waiting`;

    $('serving-rows').replaceChildren(
      ...(serving.length ? serving.map((t) => h('tr', { class: t.deskId === state.deskId ? 'mine' : null },
        h('td', {}, h('span', { class: 'tno' }, t.ticketNo)),
        h('td', {}, t.service),
        h('td', {}, t.fullName),
        h('td', {}, t.desk || ''),
        h('td', {}, h('span', { class: `badge ${t.status.toLowerCase()}` }, t.status === 'CALLED' ? 'Called' : 'Serving')),
      )) : [h('tr', { class: 'empty' }, h('td', { colspan: 5 }, 'Nobody is at a desk right now'))]),
    );

    $('waiting-rows').replaceChildren(
      ...(waiting.length ? waiting.map((t) => {
        const mins = minutesSince(t.issuedAt);
        return h('tr', { class: state.newIds?.has(t.id) ? 'flash' : null },
          h('td', {}, h('span', { class: 'tno' }, t.ticketNo), t.priority ? h('span', { class: 'badge appt', title: t.bookingRef || '' }, 'Appt') : null),
          h('td', {}, t.service),
          h('td', {}, t.fullName),
          h('td', { class: `num ${mins >= LONG_WAIT_MIN ? 'long' : ''}` }, `${mins} min`),
        );
      }) : [h('tr', { class: 'empty' }, h('td', { colspan: 4 }, 'Nobody is waiting'))]),
    );
  }

  function myTicket() {
    return state.queue?.tickets.find((t) => t.deskId === state.deskId && (t.status === 'CALLED' || t.status === 'SERVING'));
  }

  function renderDesk() {
    if ($('desk-panel').hidden || !state.queue) return;
    const body = $('desk-body');
    const desk = state.desks.find((d) => d.id === state.deskId);
    if (!desk) { body.replaceChildren(h('p', { class: 'muted' }, 'No desks at this site.')); return; }
    const t = myTicket();
    if (!t) {
      const forDesk = state.queue.tickets.filter((x) => x.status === 'WAITING' && (!desk.serviceTypeId || x.serviceTypeId === desk.serviceTypeId)).length;
      body.replaceChildren(h('div', { class: 'idle' },
        h('p', {}, desk.service ? `This desk serves: ${desk.service}` : 'This desk serves any service'),
        h('button', { class: 'btn go big', type: 'button', disabled: forDesk === 0 || state.busy, onclick: callNext }, 'Call next'),
        h('p', { class: 'small' }, forDesk === 0 ? 'Nobody waiting for this desk' : `${forDesk} waiting for this desk`),
      ));
      return;
    }
    const actions = t.status === 'CALLED'
      ? [
        h('button', { class: 'btn good wide', type: 'button', onclick: () => setStatus(t, 'SERVING') }, 'Start serving'),
        h('button', { class: 'btn', type: 'button', onclick: () => recall(t) }, 'Call again'),
        h('button', { class: 'btn danger', type: 'button', onclick: () => setStatus(t, 'SKIPPED') }, "Didn't come"),
      ]
      : [h('button', { class: 'btn good wide big', type: 'button', onclick: () => setStatus(t, 'DONE') }, 'Done')];
    body.replaceChildren(h('div', { class: 'current' },
      h('div', { class: 'label' }, 'Now at your desk'),
      h('div', { class: 'ticket' }, t.ticketNo),
      h('div', { class: 'person' }, t.fullName),
      h('div', { class: 'meta' }, `${idText(t)} · ${t.service}${t.bookingRef ? ` · ${t.bookingRef}` : ''}`),
      h('div', { class: 'meta' }, `Waited ${Math.max(0, Math.round((new Date(t.calledAt) - new Date(t.issuedAt)) / 60000))} min`),
      h('span', { class: `state ${t.status.toLowerCase()}` }, t.status === 'CALLED' ? 'Called, on the way' : 'Serving'),
      h('div', { class: 'actions' }, actions),
    ));
  }

  function renderInside() {
    if ($('inside-panel').hidden || !state.inside) return;
    const people = state.inside.people;
    $('inside-count').textContent = `${people.length} ${people.length === 1 ? 'person' : 'people'}`;
    $('inside-rows').replaceChildren(
      ...(people.length ? people.map((p) => h('tr', {},
        h('td', {}, p.fullName),
        h('td', { class: 'muted' }, idText(p)),
        h('td', {}, time(p.checkedInAt)),
        h('td', {}, p.ticket ? h('span', { class: `tno${['DONE', 'SKIPPED'].includes(p.ticket.status) ? ' finished' : ''}`, title: p.ticket.status }, p.ticket.ticketNo, ['DONE', 'SKIPPED'].includes(p.ticket.status) ? ' ✓' : '') : h('span', { class: 'muted' }, '–')),
        h('td', { class: 'num' }, h('button', { class: 'btn small', type: 'button', onclick: () => checkOut(p) }, 'Check out')),
      )) : [h('tr', { class: 'empty' }, h('td', { colspan: 5 }, 'Nobody is inside'))]),
    );
  }

  // ---------- actions ----------
  function deskMsg(text, isErr = false) {
    const m = $('desk-msg');
    m.textContent = text;
    m.className = `desk-msg${isErr ? ' err' : ''}`;
  }

  async function act(fn, okText) {
    if (state.busy) return;
    state.busy = true;
    deskMsg('');
    try {
      const out = await fn();
      if (okText) deskMsg(typeof okText === 'function' ? okText(out) : okText);
      await refresh();
    } catch (err) {
      deskMsg(err.message, true);
      await refresh();
    } finally {
      state.busy = false;
      renderDesk();
    }
  }

  const callNext = () => act(
    () => api(`/api/desks/${state.deskId}/call-next`, { method: 'POST' }),
    (r) => (r.ticket ? `Called ${r.ticket.ticketNo}` : r.message),
  );
  const setStatus = (t, status) => act(
    () => api(`/api/tickets/${t.id}`, { method: 'PATCH', body: { status } }),
    { SERVING: `Serving ${t.ticketNo}`, DONE: `${t.ticketNo} done`, SKIPPED: `${t.ticketNo} marked as didn't come` }[status],
  );
  const recall = (t) => act(() => api(`/api/tickets/${t.id}/recall`, { method: 'POST' }), `Called ${t.ticketNo} again`);

  async function checkOut(p) {
    if (!window.confirm(`Check out ${p.fullName}?`)) return;
    try {
      await api('/api/checkouts', { method: 'POST', body: { visitId: p.visitId } });
      toast(`${p.fullName} checked out`);
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------- boot ----------
  const saved = session.get('govcheckin.token');
  if (saved) {
    state.token = saved;
    start().catch(() => signOut());
  } else {
    $('login').hidden = false;
  }
})();
