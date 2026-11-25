/* Live updates over Server-Sent Events, read with fetch so we can send auth headers.
   Reconnects automatically; after every (re)connect it fires onEvent({type:'resync'}) so the page refreshes. */
window.liveStream = function liveStream(url, headers, onEvent, onStatus = () => {}) {
  let stopped = false;
  let ctrl = null;

  async function run() {
    let delay = 1000;
    while (!stopped) {
      ctrl = new AbortController();
      try {
        const res = await fetch(url, { headers, signal: ctrl.signal, cache: 'no-store' });
        if (res.status === 401) { onStatus('unauthorized'); return; }
        if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
        onStatus('live');
        delay = 1000;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(block);
            const data = /^data: (.+)$/m.exec(block);
            if (!ev) continue;
            if (ev[1] === 'ready') onEvent({ type: 'resync' });
            if (ev[1] === 'change') {
              try { onEvent(JSON.parse(data ? data[1] : '{}')); } catch { /* ignore bad event */ }
            }
          }
        }
      } catch (err) {
        if (stopped) return;
      }
      onStatus('reconnecting');
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15000);
    }
  }
  run();
  return () => { stopped = true; if (ctrl) ctrl.abort(); };
};
