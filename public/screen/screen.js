/* Waiting-area screen: big "Now calling" number, recent calls, and how many wait per service.
   Uses a station key. Shows ticket numbers and desks only. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const KEY = 'govcheckin.screenKey';
  const SPEAK = 'govcheckin.screenSpeak';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* session only */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const state = { key: null, siteId: null, speak: true, lastTop: null, timer: null };

  async function api(path, key = state.key) {
    const res = await fetch(path, { headers: { 'x-station-key': key }, cache: 'no-store' });
    const data = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error((data && data.error) || `Error ${res.status}`); e.status = res.status; throw e; }
    return data;
  }

  $('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('setup-error').textContent = '';
    try {
      await begin($('key').value.trim(), $('speak').checked);
      warmUpVoice(); // browsers only allow speech after a click
    } catch (err) {
      $('setup-error').textContent = err.status === 401 ? 'That key was not accepted.' : err.message;
    }
  });

  async function begin(key, speak) {
    const me = await api('/api/stations/me', key);
    state.key = key;
    state.siteId = me.siteId;
    state.speak = speak;
    store.set(KEY, key);
    store.set(SPEAK, speak ? '1' : '0');
    $('site').textContent = me.siteName;
    $('setup').hidden = true;
    $('board').hidden = false;
    window.liveStream(`/api/sites/${me.siteId}/events`, { 'x-station-key': key }, onEvent, onStatus);
    await refresh();
  }

  function onStatus(s) {
    const el = $('status');
    el.className = `status ${s === 'live' ? '' : 'off'}`;
    el.textContent = s === 'live' ? '● Live' : s === 'unauthorized' ? 'Screen key revoked' : 'Reconnecting…';
    if (s === 'unauthorized') { store.del(KEY); setTimeout(() => location.reload(), 3000); }
  }

  function onEvent(evt) {
    if (evt.type === 'called') announce(evt.ticketNo, evt.desk);
    clearTimeout(state.timer);
    state.timer = setTimeout(refresh, 250);
  }

  async function refresh() {
    try {
      const d = await api('/api/display');
      const [top, ...rest] = d.called;
      $('now-ticket').textContent = top ? top.ticketNo : '–';
      $('now-desk').textContent = top ? `Please go to ${top.desk}` : 'Please wait for your number';
      if (!rest.length) $('recent').replaceChildren(Object.assign(document.createElement('li'), { className: 'done', textContent: 'No other numbers yet' }));
      else $('recent').replaceChildren(...rest.slice(0, 6).map((c) => {
        const li = document.createElement('li');
        if (c.status === 'DONE' || c.status === 'SKIPPED') li.className = 'done';
        const t = Object.assign(document.createElement('span'), { className: 't', textContent: c.ticketNo });
        const desk = Object.assign(document.createElement('span'), { className: 'd', textContent: c.desk || '' });
        li.append(t, desk);
        return li;
      }));
      $('waiting').replaceChildren(...d.waiting.map((w) => {
        const chip = Object.assign(document.createElement('span'), { className: 'chip' });
        chip.append(Object.assign(document.createElement('b'), { textContent: w.prefix }), `${w.service}: ${w.count} waiting`);
        return chip;
      }));
    } catch (err) {
      if (err.status === 401) onStatus('unauthorized');
    }
  }

  function announce(ticketNo, desk) {
    const now = $('now');
    now.classList.remove('flash');
    void now.offsetWidth; // restart the animation
    now.classList.add('flash');
    chime();
    if (!state.speak || !('speechSynthesis' in window)) return;
    // "B 0 0 7" is clearer than "B seven" in a noisy room
    const spoken = `Ticket ${ticketNo.split('').join(' ')}, please go to ${desk || 'the counter'}`;
    setTimeout(() => {
      try {
        const u = new SpeechSynthesisUtterance(spoken);
        u.rate = 0.9;
        window.speechSynthesis.speak(u);
      } catch { /* speech is optional */ }
    }, 700);
  }

  let audio = null;
  function chime() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      [660, 880].forEach((f, i) => {
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, audio.currentTime + i * 0.25);
        g.gain.exponentialRampToValueAtTime(0.15, audio.currentTime + i * 0.25 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + i * 0.25 + 0.5);
        o.connect(g).connect(audio.destination);
        o.start(audio.currentTime + i * 0.25);
        o.stop(audio.currentTime + i * 0.25 + 0.55);
      });
    } catch { /* sound is optional */ }
  }
  function warmUpVoice() {
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); } catch { /* ignore */ }
  }

  function clock() {
    $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  clock();
  setInterval(clock, 10000);
  setInterval(refresh, 60000); // safety net in case an event is missed

  const saved = store.get(KEY);
  if (saved) {
    // Audio needs one click after a reload; the board still works silently until then
    document.addEventListener('click', warmUpVoice, { once: true });
    begin(saved, store.get(SPEAK) !== '0').catch(() => { $('setup').hidden = false; $('key').value = saved; });
  } else {
    $('setup').hidden = false;
  }
})();
