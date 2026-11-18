/** Minimal ops dashboard — single HTML document, no build step. */
export function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>always-on agents</title>
<style>
  :root {
    --bg: #f3efe6;
    --ink: #1c1915;
    --muted: #6b645a;
    --line: #d9d0c3;
    --panel: #fffdf8;
    --accent: #0f5c4c;
    --warn: #8a4b12;
    --danger: #8f1d1d;
    --ok: #0f5c4c;
    --mono: "IBM Plex Mono", "SFMono-Regular", ui-monospace, Menlo, monospace;
    --sans: "IBM Plex Sans", "Segoe UI", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #141210;
      --ink: #f2ebe1;
      --muted: #a79c8e;
      --line: #2d2924;
      --panel: #1b1814;
      --accent: #6fcfba;
      --warn: #e0a35a;
      --danger: #f07178;
      --ok: #6fcfba;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: var(--sans);
    background: var(--bg);
    color: var(--ink);
    line-height: 1.45;
  }
  header {
    padding: 28px 28px 12px;
    border-bottom: 1px solid var(--line);
  }
  header h1 {
    margin: 0;
    font-size: 28px;
    letter-spacing: -0.03em;
    font-weight: 600;
  }
  header p {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 14px;
  }
  main {
    padding: 20px 28px 48px;
    display: grid;
    gap: 18px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }
  .stat {
    background: var(--panel);
    border: 1px solid var(--line);
    padding: 14px 16px;
    min-width: 120px;
    flex: 1;
  }
  .stat .label {
    display: block;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .stat .value {
    font-family: var(--mono);
    font-size: 22px;
    margin-top: 4px;
  }
  .panel {
    background: var(--panel);
    border: 1px solid var(--line);
    padding: 14px 16px;
  }
  .panel h2 {
    margin: 0 0 10px;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
    font-weight: 600;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th, td {
    text-align: left;
    padding: 7px 8px;
    border-top: 1px solid var(--line);
    vertical-align: top;
  }
  th {
    color: var(--muted);
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .mono { font-family: var(--mono); font-size: 12px; }
  .pill {
    display: inline-block;
    padding: 2px 8px;
    border: 1px solid var(--line);
    font-size: 11px;
    font-family: var(--mono);
  }
  .pill.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); }
  .pill.warn { color: var(--warn); }
  .pill.danger { color: var(--danger); }
  button, .btn {
    appearance: none;
    border: 1px solid var(--line);
    background: var(--panel);
    color: var(--ink);
    padding: 8px 12px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  button.primary {
    background: var(--accent);
    color: #fffdf8;
    border-color: var(--accent);
  }
  button.danger {
    color: var(--danger);
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  input, textarea {
    width: 100%;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--ink);
    padding: 8px 10px;
    font: inherit;
    font-family: var(--mono);
    font-size: 12px;
  }
  textarea { min-height: 72px; resize: vertical; }
  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px;
  }
  @media (max-width: 900px) {
    .grid2 { grid-template-columns: 1fr; }
    header, main { padding-left: 16px; padding-right: 16px; }
  }
  .empty { color: var(--muted); font-size: 13px; padding: 8px 0; }
  .flash {
    padding: 10px 12px;
    border: 1px solid var(--line);
    font-size: 13px;
    display: none;
  }
  .flash.show { display: block; }
</style>
</head>
<body>
<header>
  <div class="row" style="justify-content:space-between;align-items:flex-start">
    <div>
      <h1>always-on</h1>
      <p id="subtitle">ops console · polling…</p>
    </div>
    <div class="row">
      <button id="refreshBtn" type="button">Refresh</button>
      <button id="stopBtn" class="danger" type="button">STOP</button>
      <button id="resumeBtn" class="primary" type="button">Resume</button>
    </div>
  </div>
</header>
<main>
  <div id="flash" class="flash"></div>
  <section class="row" id="stats"></section>

  <section class="panel">
    <h2>Operator secret</h2>
    <p style="margin:0 0 8px;color:var(--muted);font-size:13px">
      Used for STOP/resume and approvals. Stored only in this browser tab.
    </p>
    <input id="secret" type="password" placeholder="APPROVAL_SECRET" autocomplete="off" />
  </section>

  <div class="grid2">
    <section class="panel">
      <h2>Pending approvals</h2>
      <div id="approvals"></div>
    </section>
    <section class="panel">
      <h2>Ingest event</h2>
      <textarea id="ingestBody">{
  "source": "ui",
  "sourceId": "ui-1",
  "sessionKey": "ui-thread",
  "payload": { "text": "hello from the dashboard" }
}</textarea>
      <div class="row" style="margin-top:10px">
        <button id="ingestBtn" class="primary" type="button">Send to inbox</button>
      </div>
    </section>
  </div>

  <div class="grid2">
    <section class="panel">
      <h2>Recent events</h2>
      <div id="events"></div>
    </section>
    <section class="panel">
      <h2>Recent runs</h2>
      <div id="runs"></div>
    </section>
  </div>

  <div class="grid2">
    <section class="panel">
      <h2>Outbox</h2>
      <div id="outbox"></div>
    </section>
    <section class="panel">
      <h2>Active timers</h2>
      <div id="timers"></div>
    </section>
  </div>
</main>
<script>
const secretInput = document.getElementById('secret');
secretInput.value = sessionStorage.getItem('aoa_secret') || '';
secretInput.addEventListener('change', () => {
  sessionStorage.setItem('aoa_secret', secretInput.value);
});

function secret() { return secretInput.value.trim(); }

function flash(msg, ok=true) {
  const el = document.getElementById('flash');
  el.textContent = msg;
  el.classList.add('show');
  el.style.borderColor = ok ? 'var(--ok)' : 'var(--danger)';
  setTimeout(() => el.classList.remove('show'), 4000);
}

function pill(status) {
  const s = String(status || '');
  let cls = 'pill';
  if (['done','sent','executed','open'].includes(s)) cls += ' ok';
  else if (['pending','running','sending','approved','active'].includes(s)) cls += ' warn';
  else if (['failed','dead','denied','expired','stopped'].includes(s)) cls += ' danger';
  return '<span class="' + cls + '">' + escapeHtml(s) + '</span>';
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;');
}

function table(headers, rows) {
  if (!rows.length) return '<div class="empty">Nothing here</div>';
  return '<table><thead><tr>' +
    headers.map(h => '<th>' + h + '</th>').join('') +
    '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') +
    '</tbody></table>';
}

async function load() {
  if (!secret()) return;
  const res = await fetch('/api/dashboard', { headers: { 'x-approval-secret': secret() } });
  if (!res.ok) throw new Error('dashboard ' + res.status);
  const data = await res.json();
  const m = data.metrics;
  document.getElementById('subtitle').textContent =
    (data.brain + ' · ' + data.model) +
    (m.stopped ? ' · STOPPED' : ' · running') +
    ' · ' + new Date(data.at).toLocaleTimeString();

  const pending = m.events.pending || 0;
  const running = m.events.running || 0;
  const dead = m.events.dead || 0;
  document.getElementById('stats').innerHTML = [
    ['Stopped', m.stopped ? 'yes' : 'no'],
    ['Pending', pending],
    ['Running', running],
    ['Dead', dead],
    ['Outbox', m.outboxPending],
    ['Approvals', m.deferredPending],
    ['Runs today', m.runsToday],
    ['Silence rate', Math.round((data.silence.silenceRate || 0) * 100) + '%'],
  ].map(([label, value]) =>
    '<div class="stat"><span class="label">' + label + '</span><div class="value">' + value + '</div></div>'
  ).join('');

  const pendingApprovals = (data.deferred || []).filter(d => d.status === 'pending');
  document.getElementById('approvals').innerHTML = table(
    ['Tool', 'Session', 'Expires', 'Arguments', ''],
    pendingApprovals.map(d => [
      '<span class="mono">' + escapeHtml(d.tool_name) + '</span><div class="mono" style="color:var(--muted)">' + escapeHtml(d.id.slice(0,8)) + '</div>',
      '<span class="mono">' + escapeHtml(d.session_key || '') + '</span>',
      '<span class="mono">' + escapeHtml((d.expires_at || '').replace('T',' ').slice(0,19)) + '</span>',
      '<details><summary>Review arguments</summary><pre style="white-space:pre-wrap">' +
        escapeHtml(d.arguments_json || '') + '</pre></details>',
      '<button data-approve="' + escapeHtml(d.id) + '" type="button" class="primary">Approve</button> ' +
      '<button data-deny="' + escapeHtml(d.id) + '" type="button" class="danger">Deny</button>'
    ])
  );

  document.getElementById('events').innerHTML = table(
    ['ID', 'Source', 'Status', 'When'],
    (data.events || []).map(e => [
      '<span class="mono">' + e.id + '</span>',
      '<span class="mono">' + escapeHtml(e.source) + '/' + escapeHtml(e.source_id) + '</span>',
      pill(e.status),
      '<span class="mono">' + escapeHtml((e.created_at || '').replace('T',' ').slice(0,19)) + '</span>',
    ])
  );

  document.getElementById('runs').innerHTML = table(
    ['Outcome', 'Session', 'Silence', 'When'],
    (data.runs || []).map(r => [
      pill(r.outcome),
      '<span class="mono">' + escapeHtml(r.session_key || '') + '</span>',
      '<span class="mono">' + escapeHtml((r.silence_reason || '').slice(0,60)) + '</span>',
      '<span class="mono">' + escapeHtml((r.created_at || '').replace('T',' ').slice(0,19)) + '</span>',
    ])
  );

  document.getElementById('outbox').innerHTML = table(
    ['Ch', 'Status', 'Body'],
    (data.outbox || []).map(o => [
      '<span class="mono">' + escapeHtml(o.channel) + '</span>',
      pill(o.status),
      '<span class="mono">' + escapeHtml(o.body || '') + '</span>',
    ])
  );

  document.getElementById('timers').innerHTML = table(
    ['Kind', 'Due', 'Session'],
    (data.timers || []).map(t => [
      pill(t.kind),
      '<span class="mono">' + escapeHtml((t.due_at || '').replace('T',' ').slice(0,19)) + '</span>',
      '<span class="mono">' + escapeHtml(t.session_key || '') + '</span>',
    ])
  );

  document.querySelectorAll('[data-approve]').forEach(btn => {
    btn.addEventListener('click', () => decide(btn.getAttribute('data-approve'), 'approved'));
  });
  document.querySelectorAll('[data-deny]').forEach(btn => {
    btn.addEventListener('click', () => decide(btn.getAttribute('data-deny'), 'denied'));
  });
}

async function decide(deferredId, decision) {
  if (!secret()) return flash('Set operator secret first', false);
  const res = await fetch('/events/approval', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: secret(), deferredId, decision }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return flash(body.error || ('approval failed ' + res.status), false);
  flash(decision + ' ' + deferredId.slice(0,8));
  await load();
}

async function setStopped(stop) {
  if (!secret()) return flash('Set operator secret first', false);
  const res = await fetch('/api/control/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: secret(), stop }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return flash(body.error || 'control failed', false);
  flash(stop ? 'STOP engaged' : 'Resumed');
  await load();
}

secretInput.addEventListener('change', () => load().catch(e => flash(String(e), false)));
document.getElementById('refreshBtn').onclick = () => load().catch(e => flash(String(e), false));
document.getElementById('stopBtn').onclick = () => setStopped(true);
document.getElementById('resumeBtn').onclick = () => setStopped(false);
document.getElementById('ingestBtn').onclick = async () => {
  let payload;
  try { payload = JSON.parse(document.getElementById('ingestBody').value); }
  catch { return flash('Invalid JSON', false); }
  if (!payload.sourceId) payload.sourceId = 'ui-' + Date.now();
  const res = await fetch('/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-approval-secret': secret() },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return flash(body.error || 'ingest failed', false);
  flash(body.inserted ? 'Inserted event ' + body.eventId : 'Deduped existing event');
  await load();
};

load().catch(e => flash(String(e), false));
setInterval(() => load().catch(() => {}), 4000);
</script>
</body>
</html>`;
}
