/* Citizen online booking: confirm ID -> see bookings -> pick office, service, day, time -> reference. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const TOKEN = 'govcheckin.citizen';
  const state = { token: null, firstName: '', idType: 'OMANG', options: null, day: null, time: null };
  const session = {
    get() { try { return JSON.parse(sessionStorage.getItem(TOKEN)); } catch { return null; } },
    set(v) { try { sessionStorage.setItem(TOKEN, JSON.stringify(v)); } catch { /* memory only */ } },
    del() { try { sessionStorage.removeItem(TOKEN); } catch { /* ignore */ } },
  };

  async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => null);
    if (res.status === 401 && state.token) { signOut('Your session ended. Please confirm your ID again.'); throw new Error('expired'); }
    if (!res.ok) throw new Error((data && data.error) || 'Something went wrong. Please try again.');
    return data;
  }

  function show(id) {
    for (const s of ['s-verify', 's-home', 's-book', 's-done']) $(s).hidden = s !== id;
    window.scrollTo(0, 0);
  }
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});
  const longDay = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });

  // ---------- verify ----------
  for (const r of document.querySelectorAll('input[name=idType]')) {
    r.addEventListener('change', () => {
      state.idType = r.value;
      $('id-label').textContent = r.value === 'OMANG' ? 'Omang number' : 'Passport number';
      $('id-number').inputMode = r.value === 'OMANG' ? 'numeric' : 'text';
    });
  }
  $('verify-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('verify-error').textContent = '';
    const btn = $('verify-form').querySelector('button');
    btn.disabled = true;
    try {
      const r = await api('/api/public/verify', {
        method: 'POST',
        body: { idType: state.idType, idNumber: $('id-number').value.trim(), dateOfBirth: $('dob').value },
      });
      state.token = r.token;
      state.firstName = r.firstName;
      session.set({ token: r.token, firstName: r.firstName, idType: state.idType });
      $('id-number').value = '';
      await home();
    } catch (err) {
      $('verify-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  function signOut(message) {
    state.token = null;
    session.del();
    show('s-verify');
    $('verify-error').textContent = message || '';
  }
  $('sign-out').addEventListener('click', () => signOut());

  // ---------- my bookings ----------
  async function home() {
    $('hello').textContent = `Hello, ${state.firstName}`;
    const list = await api('/api/public/bookings');
    const box = $('my-bookings');
    box.replaceChildren();
    if (!list.length) box.append(el('div', 'empty', 'You have no upcoming appointments.'));
    for (const b of list) {
      const card = el('div', 'booking');
      card.append(el('div', 'when', `${longDay(b.date)}, ${b.time}`), el('div', 'what', b.service), el('div', 'where', b.site));
      const row = el('div', 'row');
      row.append(el('span', 'refsm', b.bookingRef));
      if (b.status === 'BOOKED') {
        const cancel = el('button', null, 'Cancel');
        cancel.type = 'button';
        cancel.addEventListener('click', async () => {
          if (!window.confirm(`Cancel your ${b.service} appointment on ${longDay(b.date)} at ${b.time}?`)) return;
          try { await api(`/api/public/bookings/${encodeURIComponent(b.bookingRef)}`, { method: 'DELETE' }); await home(); } catch (err) { if (err.message !== 'expired') window.alert(err.message); }
        });
        row.append(cancel);
      } else {
        row.append(el('span', 'muted small', 'Checked in'));
      }
      card.append(row);
      box.append(card);
    }
    show('s-home');
  }
  $('done-home').addEventListener('click', () => home());
  $('back-home').addEventListener('click', () => home());

  // ---------- book ----------
  $('new-booking').addEventListener('click', async () => {
    state.options = state.options || await api('/api/public/options');
    const o = state.options;
    $('site').replaceChildren(...o.sites.map((s) => Object.assign(el('option', null, `${s.name}`), { value: s.id })));
    $('service').replaceChildren(...o.services.map((s) => Object.assign(el('option', null, s.name), { value: s.id })));
    state.day = null;
    state.time = null;
    renderDays();
    renderSlots(null);
    updateSummary();
    $('book-error').textContent = '';
    show('s-book');
  });
  $('site').addEventListener('change', () => { state.time = null; loadSlots(); });
  $('service').addEventListener('change', () => { state.time = null; loadSlots(); });

  function renderDays() {
    const box = $('days');
    box.replaceChildren(...state.options.days.map((d) => {
      const dt = new Date(`${d}T12:00:00`);
      const b = el('button', 'day');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(d === state.day));
      b.append(
        el('div', 'dw', dt.toLocaleDateString([], { weekday: 'short' })),
        el('div', 'dn', String(dt.getDate())),
        el('div', 'dm', dt.toLocaleDateString([], { month: 'short' })),
      );
      b.addEventListener('click', () => { state.day = d; state.time = null; renderDays(); loadSlots(); });
      return b;
    }));
  }

  async function loadSlots() {
    if (!state.day) return;
    $('slots').replaceChildren(el('p', 'muted small', 'Loading free times…'));
    try {
      const q = new URLSearchParams({ siteId: $('site').value, serviceTypeId: $('service').value, date: state.day });
      const r = await api(`/api/public/slots?${q}`);
      renderSlots(r.slots);
    } catch (err) {
      if (err.message !== 'expired') $('slots').replaceChildren(el('p', 'error', err.message));
    }
    updateSummary();
  }

  function renderSlots(slots) {
    const box = $('slots');
    if (!slots) { box.replaceChildren(el('p', 'muted small', 'Pick a day to see free times.')); $('slot-note').textContent = ''; return; }
    const free = slots.filter((s) => s.available > 0).length;
    $('slot-note').textContent = slots.length ? `${free} free` : '';
    if (!slots.length) { box.replaceChildren(el('p', 'muted small', 'No times left on this day. Try another day.')); return; }
    box.replaceChildren(...slots.map((s) => {
      const b = el('button', 'slot', s.time);
      b.type = 'button';
      b.disabled = s.available === 0;
      if (s.available === 0) b.setAttribute('aria-label', `${s.time}, full`);
      b.setAttribute('aria-pressed', String(s.time === state.time));
      b.addEventListener('click', () => { state.time = s.time; renderSlots(slots); updateSummary(); });
      return b;
    }));
  }

  function updateSummary() {
    const ready = state.day && state.time;
    $('confirm').disabled = !ready;
    $('summary').hidden = !ready;
    if (ready) {
      $('summary').textContent = `${$('service').selectedOptions[0].textContent} · ${$('site').selectedOptions[0].textContent} · ${longDay(state.day)} at ${state.time}`;
    }
  }

  $('confirm').addEventListener('click', async () => {
    $('book-error').textContent = '';
    $('confirm').disabled = true;
    try {
      const b = await api('/api/public/bookings', {
        method: 'POST',
        body: { siteId: Number($('site').value), serviceTypeId: Number($('service').value), date: state.day, time: state.time },
      });
      $('done-ref').textContent = b.bookingRef;
      $('done-detail').textContent = `${b.service} · ${b.site} · ${longDay(b.date)} at ${b.time}`;
      $('done-idword').textContent = state.idType === 'OMANG' ? 'Omang' : 'passport';
      show('s-done');
    } catch (err) {
      if (err.message === 'expired') return;
      $('book-error').textContent = err.message;
      $('confirm').disabled = false;
      loadSlots(); // someone may have just taken that time
    }
  });

  // ---------- start ----------
  const saved = session.get();
  if (saved && saved.token) {
    Object.assign(state, saved);
    home().catch(() => signOut());
  } else {
    show('s-verify');
  }
})();
