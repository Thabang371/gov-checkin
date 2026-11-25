/* Check-in station: scans ID QR codes with the webcam (jsQR) or a USB QR scanner (types like a keyboard)
   and calls the API with this device's station key. */
(() => {
  'use strict';

  const KEY_STORE = 'govcheckin.stationKey';
  const RESULT_MS = 8000;          // how long a result stays on screen
  const SERVICE_PICK_MS = 25000;   // longer when the visitor must pick a service
  const SAME_CODE_COOLDOWN = 5000; // ignore the same QR held in front of the camera
  const SCAN_EVERY_MS = 120;

  const $ = (id) => document.getElementById(id);
  const state = { key: null, mode: 'in', busy: false, lastCode: '', lastAt: 0, lastScanAt: 0, services: null, departments: null, timer: null };

  // ---------- storage (can be unavailable in some browsers) ----------
  const store = {
    get() { try { return localStorage.getItem(KEY_STORE); } catch { return null; } },
    set(v) { try { localStorage.setItem(KEY_STORE, v); } catch { /* key only lives for this session */ } },
    clear() { try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ } },
  };

  // ---------- API ----------
  async function api(path, { method = 'GET', body, key = state.key } = {}) {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-station-key': key },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------- screens ----------
  function show(id) {
    for (const s of ['setup', 'scan']) $(s).hidden = s !== id;
  }

  async function connect(key) {
    const me = await api('/api/stations/me', { key });
    state.key = key;
    store.set(key);
    $('site-name').textContent = me.siteName;
    $('station-name').textContent = `${me.stationName} · Station ${me.stationId}`;
    show('scan');
    startCamera();
    api('/api/service-types').then((s) => { state.services = s; }).catch(() => {});
    api(`/api/sites/${me.siteId}/departments`).then((d) => { state.departments = d; }).catch(() => {});
  }

  $('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('setup-error').textContent = '';
    const key = $('station-key').value.trim();
    try {
      await connect(key);
    } catch (err) {
      $('setup-error').textContent = err.status === 401 ? 'That key was not accepted. Check it and try again.' : err.message;
    }
  });

  $('reset-station').addEventListener('click', () => {
    if (!window.confirm('Disconnect this station? You will need the station key again.')) return;
    store.clear();
    location.reload();
  });

  // ---------- mode ----------
  function setMode(mode) {
    state.mode = mode;
    document.body.classList.toggle('mode-out', mode === 'out');
    for (const [id, m] of [['mode-in', 'in'], ['mode-out', 'out']]) {
      $(id).classList.toggle('active', m === mode);
      $(id).setAttribute('aria-checked', String(m === mode));
    }
    $('hint').textContent = mode === 'in'
      ? 'Hold the QR code on your ID up to the camera'
      : 'Leaving? Scan your ID to check out';
  }
  $('mode-in').addEventListener('click', () => setMode('in'));
  $('mode-out').addEventListener('click', () => setMode('out'));

  // ---------- camera ----------
  const video = $('video');
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return cameraOff('This browser cannot use a camera here. Use https or localhost.');
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      const settings = stream.getVideoTracks()[0].getSettings();
      video.parentElement.classList.toggle('rear', settings.facingMode === 'environment');
      requestAnimationFrame(tick);
    } catch (err) {
      cameraOff(err.name === 'NotAllowedError' ? 'Camera permission was refused.' : 'No camera was found.');
    }
  }

  function cameraOff(reason) {
    $('camera-off').hidden = false;
    $('camera-reason').textContent = reason;
  }

  function tick(now) {
    requestAnimationFrame(tick);
    if (state.busy || video.readyState < video.HAVE_ENOUGH_DATA || now - state.lastScanAt < SCAN_EVERY_MS) return;
    state.lastScanAt = now;
    const scale = Math.min(1, 800 / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const code = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
    if (code && code.data) handleCode(code.data);
  }

  // ---------- USB QR scanners type the code then press Enter, very fast ----------
  let buffer = '';
  let lastKeyAt = 0;
  document.addEventListener('keydown', (e) => {
    if ($('scan').hidden || e.target.tagName === 'INPUT') return;
    const now = performance.now();
    if (now - lastKeyAt > 80) buffer = ''; // a person typing is slower than a scanner
    lastKeyAt = now;
    if (e.key === 'Enter') {
      if (buffer.length > 20) handleCode(buffer);
      buffer = '';
    } else if (e.key.length === 1) {
      buffer += e.key;
    }
  });

  // ---------- scan handling ----------
  async function handleCode(text) {
    const now = Date.now();
    if (state.busy || !$('result').hidden) return;
    if (text === state.lastCode && now - state.lastAt < SAME_CODE_COOLDOWN) return;
    state.lastCode = text;
    state.lastAt = now;
    state.busy = true;
    beep(true);

    try {
      if (state.mode === 'in') {
        const r = await api('/api/checkins', { method: 'POST', body: { method: 'QR', qr: text } });
        showCheckIn(r);
      } else {
        const r = await api('/api/checkouts', { method: 'POST', body: { method: 'QR', qr: text } });
        showResult({
          tone: 'good', icon: '✓', title: 'Goodbye, thank you',
          sub: `You were inside for ${r.minutesInside} minute${r.minutesInside === 1 ? '' : 's'}.`,
        });
      }
    } catch (err) {
      if (err.status === 401) {
        store.clear();
        state.busy = false;
        show('setup');
        $('setup-error').textContent = 'This station was disconnected. Enter the station key again.';
        return;
      }
      beep(false);
      const friendly = {
        422: `That QR code is not a valid ID (${err.message}). Please see reception.`,
        404: state.mode === 'out' ? 'You are not checked in here.' : 'Not found. Please see reception.',
      };
      showResult({ tone: 'bad', icon: '!', title: 'Could not scan', sub: friendly[err.status] || err.message });
    }
  }

  function showCheckIn(r) {
    const name = shortName(r.person.fullName);
    const warnings = (r.warnings || []).map((w) => ({
      DOCUMENT_EXPIRED: 'Your document has expired. Please renew it.',
      OVER_CAPACITY: 'The building is full right now. Reception may ask you to wait outside.',
    }[w] || w));

    if (r.alreadyInside) {
      return showResult({ tone: 'good', icon: '✓', title: `You're already checked in, ${name}`, ticket: r.ticket, warnings });
    }
    if (r.needsService) {
      return showResult({
        tone: warnings.length ? 'warn' : 'good', icon: '✓', title: `Welcome, ${name}`,
        sub: 'You are checked in.', warnings, pickService: r.visit.id,
      });
    }
    showResult({
      tone: warnings.length ? 'warn' : 'good', icon: '✓', title: `Welcome, ${name}`,
      sub: r.appointment ? `Appointment ${r.appointment.bookingRef} at ${timeOf(r.appointment.scheduledFor)}: you have priority.` : 'You are checked in.',
      ticket: r.ticket, warnings,
    });
  }

  // ---------- result overlay ----------
  function showResult({ tone, icon, title, sub = '', ticket = null, warnings = [], pickService = null }) {
    const card = $('result-card');
    card.className = `card result-card ${tone}`;
    $('result-icon').textContent = icon;
    $('result-title').textContent = title;
    $('result-sub').textContent = sub;
    renderTicket(ticket);

    const list = $('warnings');
    list.replaceChildren(...warnings.map((w) => Object.assign(document.createElement('li'), { textContent: w })));

    $('services').hidden = !pickService;
    $('departments').hidden = true;
    if (pickService) renderServices(pickService);

    $('result').hidden = false;
    startCountdown(pickService ? SERVICE_PICK_MS : RESULT_MS);
  }

  function renderTicket(ticket) {
    $('ticket').hidden = !ticket;
    if (!ticket) return;
    $('ticket-no').textContent = ticket.ticketNo;
    const parts = [];
    if (ticket.service) parts.push(ticket.service);
    if (typeof ticket.peopleAhead === 'number') {
      parts.push(ticket.peopleAhead === 0 ? 'You are next' : `${ticket.peopleAhead} ahead of you`);
    }
    $('ticket-meta').textContent = parts.join(' · ');
  }

  function renderServices(visitId) {
    const box = $('service-list');
    box.replaceChildren();
    for (const s of state.services || []) {
      const b = document.createElement('button');
      b.type = 'button';
      const p = Object.assign(document.createElement('span'), { className: 'prefix', textContent: s.prefix });
      b.append(p, document.createTextNode(s.name));
      b.addEventListener('click', () => pickService(visitId, s.id, box));
      box.append(b);
    }
    if (!box.children.length) box.append(Object.assign(document.createElement('p'), { textContent: 'Please go to reception.' }));
    $('visiting').hidden = !(state.departments && state.departments.length);
    $('visiting').onclick = () => showDepartments(visitId);
  }

  // Walk-in visitor: no ticket, just say which office. Name and ID were already logged by the scan.
  function showDepartments(visitId) {
    $('services').hidden = true;
    $('departments').hidden = false;
    const box = $('department-list');
    box.replaceChildren(...state.departments.map((d) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = d.name;
      b.addEventListener('click', () => pickDepartment(visitId, d, box));
      return b;
    }));
    $('back-to-services').onclick = () => { $('departments').hidden = true; $('services').hidden = false; };
    startCountdown(SERVICE_PICK_MS);
  }

  async function pickDepartment(visitId, dept, box) {
    for (const b of box.querySelectorAll('button')) b.disabled = true;
    try {
      await api(`/api/visits/${visitId}/purpose`, { method: 'POST', body: { departmentId: dept.id } });
      $('departments').hidden = true;
      $('result-sub').textContent = `You're signed in. Please go to ${dept.name}. Scan out when you leave.`;
      beep(true);
      startCountdown(RESULT_MS);
    } catch (err) {
      $('result-sub').textContent = err.message;
      for (const b of box.querySelectorAll('button')) b.disabled = false;
    }
  }

  async function pickService(visitId, serviceTypeId, box) {
    for (const b of box.querySelectorAll('button')) b.disabled = true;
    try {
      const t = await api(`/api/visits/${visitId}/ticket`, { method: 'POST', body: { serviceTypeId } });
      $('services').hidden = true;
      $('result-sub').textContent = 'Please wait for your number to be called.';
      renderTicket(t);
      beep(true);
      startCountdown(RESULT_MS);
    } catch (err) {
      $('result-sub').textContent = err.message;
      for (const b of box.querySelectorAll('button')) b.disabled = false;
    }
  }

  function startCountdown(ms) {
    clearTimeout(state.timer);
    const bar = $('countdown-bar');
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(1)';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bar.style.transition = `transform ${ms}ms linear`;
      bar.style.transform = 'scaleX(0)';
    }));
    state.timer = setTimeout(closeResult, ms);
  }

  function closeResult() {
    clearTimeout(state.timer);
    $('result').hidden = true;
    state.busy = false;
  }
  $('done').addEventListener('click', closeResult);

  // ---------- helpers ----------
  // Privacy on a public screen: first name + surname initial only
  function shortName(full) {
    const parts = String(full || '').trim().split(/\s+/);
    if (parts.length < 2) return parts[0] || '';
    return `${parts[0]} ${parts[parts.length - 1][0]}.`;
  }

  function timeOf(iso) {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  let audioCtx = null;
  function beep(ok) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = ok ? 880 : 220;
      g.gain.value = 0.08;
      o.connect(g).connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + (ok ? 0.12 : 0.35));
    } catch { /* sound is optional */ }
  }

  // ---------- start ----------
  setMode('in');
  const saved = store.get();
  if (saved) {
    connect(saved).catch(() => { show('setup'); $('station-key').value = saved; });
  } else {
    show('setup');
  }
})();
