/** Self-contained operations dashboard served by the runtime. */
export function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>always-on · Operations</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #131516;
    --rail: #191c1d;
    --panel: #1b1e20;
    --inset: #151819;
    --line: #303536;
    --ink: #f1f1ed;
    --muted: #a5aeac;
    --soft: #cbd0ce;
    --accent: #ddf69b;
    --ok: #9cddb7;
    --warn: #ffce85;
    --danger: #ffa4a0;
    --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    --sans: "Geist", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 var(--sans); }
  a { color: inherit; }
  [hidden] { display: none !important; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
  .shell { display: grid; grid-template-columns: 216px minmax(0, 1fr); min-height: 100vh; }
  .rail { background: var(--rail); border-right: 1px solid var(--line); padding: 28px 16px; }
  .rail-inner { position: sticky; top: 28px; }
  .brand { display: flex; align-items: center; gap: 11px; margin: 0 8px 38px; font-size: 16px; font-weight: 690; letter-spacing: -.025em; }
  .brand-mark { position: relative; display: inline-grid; width: 32px; height: 32px; place-items: center; border: 1px solid #536441; border-radius: 9px; color: var(--accent); background: #283424; }
  .brand-mark::before, .brand-mark::after { content: ""; position: absolute; border: 1px solid currentColor; border-radius: 3px; width: 11px; height: 11px; transform: rotate(45deg); }
  .brand-mark::before { translate: -3px 0; }
  .brand-mark::after { translate: 3px 0; }
  .nav { display: grid; gap: 4px; }
  .nav a { display: flex; align-items: center; gap: 12px; min-height: 42px; padding: 8px 12px; border: 1px solid transparent; border-radius: 8px; color: var(--muted); text-decoration: none; font-weight: 560; }
  .nav a:hover, .nav a[aria-current] { color: var(--ink); background: #24292a; border-color: #363c3c; }
  .nav a[aria-current] .nav-icon { color: var(--accent); }
  .nav-icon { color: #87928e; width: 18px; text-align: center; font: 16px/1 var(--mono); }
  .workspace { padding: 0 38px 48px; width: 100%; max-width: 1600px; margin: auto; align-self: start; }
  .topbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 76px; border-bottom: 1px solid var(--line); }
  .section-label { color: var(--soft); font-weight: 600; font-size: 13px; }
  .top-actions, .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .hero { padding: 30px 0 25px; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: end; gap: 12px 24px; }
  h1 { margin: 0; font-size: clamp(32px, 4.2vw, 51px); font-weight: 650; line-height: 1.06; letter-spacing: -.055em; }
  #subtitle { color: var(--muted); margin: 9px 0 0; overflow-wrap: anywhere; }
  .status-stack { display: grid; justify-items: end; gap: 7px; }
  .status { display: inline-flex; align-items: center; gap: 7px; padding: 5px 10px; border: 1px solid var(--line); border-radius: 99px; color: var(--soft); font-size: 12px; font-weight: 630; white-space: nowrap; }
  .status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .status.live { background: #212f28; color: var(--ok); border-color: #375244; }
  .status.paused { background: #392722; color: var(--warn); border-color: #664833; }
  .updated { color: var(--muted); font: 11px/1.4 var(--mono); }
  .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
  .stat { position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 16px 13px; min-width: 0; }
  .stat.attention { border-color: #5e513d; background: #252320; }
  .stat-label { display: block; color: var(--soft); font-size: 12px; font-weight: 550; }
  .stat-value { display: block; margin: 6px 0 1px; color: var(--ink); font: 560 clamp(25px, 3vw, 34px)/1.25 var(--mono); letter-spacing: -.07em; }
  .stat.attention .stat-value { color: var(--warn); }
  .stat-detail { display: block; color: var(--muted); font-size: 12px; }
  .layout { display: grid; grid-template-columns: minmax(0, 1.75fr) minmax(270px, 1fr); gap: 16px; margin-top: 20px; align-items: start; }
  .stack { display: grid; gap: 16px; min-width: 0; align-content: start; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; min-width: 0; scroll-margin-top: 18px; }
  .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 17px; }
  .panel-head h2 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -.025em; }
  .panel-body { padding: 0 17px 17px; }
  .panel-note { margin: 0 0 12px; color: var(--muted); font-size: 12px; }
  .count { color: var(--warn); border: 1px solid #594b35; background: #312b21; border-radius: 22px; padding: 1px 8px; font: 12px/1.6 var(--mono); }
  .approval-list { display: grid; gap: 9px; }
  .approval { padding: 12px; background: var(--inset); border: 1px solid var(--line); border-radius: 8px; }
  .approval-top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: start; gap: 8px; }
  .approval-name { font-weight: 650; overflow-wrap: anywhere; }
  .approval-meta { color: var(--muted); margin-top: 3px; overflow-wrap: anywhere; }
  .approval details { margin-top: 9px; color: var(--soft); }
  summary { cursor: pointer; width: fit-content; font-size: 12px; font-weight: 580; }
  pre { max-height: 180px; overflow: auto; padding: 10px; background: #101213; border: 1px solid var(--line); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .table-scroll { overflow-x: auto; border-radius: 0 0 12px 12px; }
  table { width: 100%; border-collapse: collapse; text-align: left; font-size: 12px; }
  th, td { padding: 10px 12px; border-top: 1px solid var(--line); vertical-align: top; }
  th:first-child, td:first-child { padding-left: 17px; }
  th:last-child, td:last-child { padding-right: 17px; }
  th { color: var(--muted); background: #1f2324; font-size: 11px; font-weight: 620; white-space: nowrap; }
  td { overflow-wrap: anywhere; }
  tbody tr:hover { background: #222627; }
  .mono { font-family: var(--mono); font-size: 11px; }
  .nowrap { white-space: nowrap; }
  .muted { color: var(--muted); }
  .pill { display: inline-block; border-radius: 99px; padding: 2px 7px; border: 1px solid var(--line); color: var(--soft); background: #25292b; font-size: 11px; font-weight: 560; white-space: nowrap; }
  .pill.ok { color: var(--ok); background: #233027; border-color: #384b3f; }
  .pill.warn { color: var(--warn); background: #322b22; border-color: #554731; }
  .pill.danger { color: var(--danger); background: #382829; border-color: #593a39; }
  button { border: 1px solid #3b4242; background: #252a2b; color: var(--ink); min-height: 36px; border-radius: 7px; padding: 6px 11px; font: 610 12px/1.3 var(--sans); cursor: pointer; }
  button:hover { background: #33393a; }
  button.primary { background: var(--accent); color: #1c240f; border-color: var(--accent); }
  button.primary:hover { background: #edffbb; }
  button.danger { color: var(--danger); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  input, textarea { background: var(--inset); color: var(--ink); border: 1px solid #384141; border-radius: 7px; width: 100%; min-width: 0; padding: 9px 10px; font: 12px/1.5 var(--mono); }
  input::placeholder { color: #969e9c; }
  textarea { min-height: 137px; resize: vertical; }
  .secret-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
  .form-actions { margin-top: 9px; }
  .empty { margin: 0; padding: 14px 17px; color: var(--muted); border-top: 1px solid var(--line); font-size: 12px; }
  .panel-body .empty { padding: 12px; border: 1px dashed var(--line); border-radius: 7px; }
  .flash { position: fixed; z-index: 2; right: 20px; bottom: 20px; max-width: min(420px, calc(100vw - 40px)); padding: 11px 14px; border: 1px solid #46604c; border-radius: 9px; background: #222d25; color: var(--ink); box-shadow: 0 12px 28px #0006; overflow-wrap: anywhere; }
  .flash.error { border-color: #894947; background: #3a2727; }
  @media (max-width: 1100px) {
    .shell { grid-template-columns: 174px minmax(0, 1fr); }
    .workspace { padding-inline: 24px; }
    .layout { grid-template-columns: minmax(0, 1.45fr) minmax(245px, 1fr); }
  }
  @media (max-width: 880px) {
    .shell { display: block; }
    .rail { border-right: 0; border-bottom: 1px solid var(--line); padding: 13px 16px 9px; }
    .rail-inner { position: static; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 18px; }
    .brand { margin: 0; }
    .nav { display: flex; flex-wrap: wrap; gap: 2px; }
    .nav a { min-height: 35px; padding: 4px 8px; gap: 5px; font-size: 12px; }
    .nav-icon { width: 14px; font-size: 13px; }
  }
  @media (max-width: 670px) {
    .workspace { padding: 0 14px 28px; }
    .layout { grid-template-columns: minmax(0, 1fr); gap: 14px; }
    .stack { display: contents; }
    #operator-panel { order: -2; }
    #approval-panel { order: -1; }
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .stat { padding: 12px; }
    .topbar { min-height: 56px; }
    .hero { padding: 21px 0 17px; }
    .status-stack { justify-items: start; }
  }
</style>
</head>
<body>
<div class="shell">
  <aside class="rail">
    <div class="rail-inner">
      <div class="brand"><span class="brand-mark" aria-hidden="true"></span>always-on</div>
      <nav class="nav" aria-label="Dashboard sections">
        <a href="#overview" aria-current="location"><span class="nav-icon" aria-hidden="true">◫</span>Overview</a>
        <a href="#approval-panel"><span class="nav-icon" aria-hidden="true">◇</span>Approvals</a>
        <a href="#inbox-panel"><span class="nav-icon" aria-hidden="true">↓</span>Inbox</a>
        <a href="#run-panel"><span class="nav-icon" aria-hidden="true">↯</span>Runs</a>
        <a href="#delivery-panel"><span class="nav-icon" aria-hidden="true">↗</span>Outbox</a>
        <a href="#timer-panel"><span class="nav-icon" aria-hidden="true">◷</span>Timers</a>
      </nav>
    </div>
  </aside>
  <main class="workspace" id="overview">
    <div class="topbar">
      <span class="section-label">Operations</span>
      <div class="top-actions">
        <button id="refreshBtn" type="button">Refresh</button>
        <button id="stopBtn" class="danger" type="button" disabled>Stop runtime</button>
        <button id="resumeBtn" class="primary" type="button" hidden>Resume runtime</button>
      </div>
    </div>
    <header class="hero">
      <div>
        <h1>Runtime overview</h1>
        <p id="subtitle">Enter the operator secret to view live activity.</p>
      </div>
      <div class="status-stack">
        <span id="runtimeStatus" class="status">Locked</span>
        <span id="updatedAt" class="updated" hidden></span>
      </div>
    </header>
    <div id="flash" class="flash" role="status" aria-live="polite" hidden></div>
    <section class="stats" id="stats" aria-label="Runtime metrics">
      <div class="stat"><span class="stat-label">Inbox backlog</span><strong class="stat-value" id="pendingEvents">—</strong><span class="stat-detail" id="eventDetail">Running and dead events</span></div>
      <div class="stat" id="approvalStat"><span class="stat-label">Pending approvals</span><strong class="stat-value" id="pendingApprovals">—</strong><span class="stat-detail">Awaiting operator decision</span></div>
      <div class="stat"><span class="stat-label">Outbox backlog</span><strong class="stat-value" id="outboxPending">—</strong><span class="stat-detail" id="outboxDetail">Messages in flight</span></div>
      <div class="stat"><span class="stat-label">Runs today</span><strong class="stat-value" id="runsToday">—</strong><span class="stat-detail" id="runDetail">Quiet runs · UTC day</span></div>
    </section>
    <div class="layout">
      <div class="stack">
        <section class="panel" id="approval-panel" aria-labelledby="approval-title">
          <div class="panel-head"><h2 id="approval-title">Approvals</h2><span id="approvalCount" class="count" hidden></span></div>
          <div class="panel-body approval-list" id="approvals"><p class="empty">Unlock the dashboard to review requests.</p></div>
        </section>
        <section class="panel" id="inbox-panel" aria-labelledby="inbox-title">
          <div class="panel-head"><h2 id="inbox-title">Recent events</h2></div>
          <div id="events"><p class="empty">Unlock to view inbox activity.</p></div>
        </section>
        <section class="panel" id="run-panel" aria-labelledby="run-title">
          <div class="panel-head"><h2 id="run-title">Recent runs</h2></div>
          <div id="runs"><p class="empty">Unlock to view run history.</p></div>
        </section>
      </div>
      <div class="stack">
        <section class="panel" id="operator-panel" aria-labelledby="operator-title">
          <div class="panel-head"><h2 id="operator-title">Operator access</h2><span id="accessStatus" class="pill">Locked</span></div>
          <div class="panel-body">
            <form id="accessForm">
              <label class="panel-note" for="secret">Operator secret</label>
              <div class="secret-row">
                <input id="secret" type="password" placeholder="APPROVAL_SECRET" autocomplete="off" required>
                <button id="unlockBtn" class="primary" type="submit">Unlock</button>
              </div>
            </form>
            <button id="lockBtn" type="button" hidden>Lock dashboard</button>
          </div>
        </section>
        <section class="panel" aria-labelledby="ingest-title">
          <div class="panel-head"><h2 id="ingest-title">Ingest event</h2></div>
          <form id="ingestForm" class="panel-body">
            <label class="panel-note" for="ingestBody">Event payload as JSON</label>
            <textarea id="ingestBody" spellcheck="false" required>{
  "source": "ui",
  "sessionKey": "ui-thread",
  "payload": { "text": "Hello from the dashboard" }
}</textarea>
            <div class="row form-actions"><button id="ingestBtn" type="submit" class="primary">Send to inbox</button></div>
          </form>
        </section>
        <section class="panel" id="delivery-panel" aria-labelledby="delivery-title">
          <div class="panel-head"><h2 id="delivery-title">Outbox</h2></div>
          <div id="outbox"><p class="empty">Unlock to view delivery status.</p></div>
        </section>
        <section class="panel" id="timer-panel" aria-labelledby="timer-title">
          <div class="panel-head"><h2 id="timer-title">Active timers</h2></div>
          <div id="timers"><p class="empty">Unlock to view scheduled work.</p></div>
        </section>
      </div>
    </div>
  </main>
</div>
<script>
const byId = id => document.getElementById(id);
const secretInput = byId('secret');
const panels = ['approvals', 'events', 'runs', 'outbox', 'timers'];
const initialPanels = new Map(panels.map(id => [id, byId(id).innerHTML]));
const renderedPanels = new Map();
const metricIds = ['pendingEvents', 'pendingApprovals', 'outboxPending', 'runsToday', 'eventDetail', 'outboxDetail', 'runDetail'];
const initialMetrics = new Map(metricIds.map(id => [id, byId(id).textContent]));
let operatorSecret = sessionStorage.getItem('aoa_secret') || '';
let loadRequest;
let flashTimeout;
let runtimeStopped = false;
let controlPending = false;
let approvalSignature;

function flash(message, ok = true) {
  const notice = byId('flash');
  notice.textContent = message;
  notice.classList.toggle('error', !ok);
  notice.hidden = false;
  clearTimeout(flashTimeout);
  flashTimeout = setTimeout(() => { notice.hidden = true; }, 4500);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function pill(value) {
  const status = String(value || '');
  const tone = ['done', 'sent', 'executed_approval', 'active', 'notified'].includes(status) ? 'ok'
    : ['pending', 'running', 'sending', 'deferred', 'approved'].includes(status) ? 'warn'
    : ['failed', 'failed_approval', 'dead', 'denied', 'expired', 'error'].includes(status) ? 'danger' : '';
  return '<span class="pill ' + tone + '">' + escapeHtml(status.replaceAll('_', ' ')) + '</span>';
}

function dateCell(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return '<time class="mono muted nowrap" datetime="' + escapeHtml(value) + '">' +
    escapeHtml(date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) + '</time>';
}

function table(id, heading, headers, rows, empty) {
  const markup = rows.length
    ? '<div class="table-scroll" role="region" aria-labelledby="' + heading + '" tabindex="0"><table><thead><tr>' +
      headers.map(header => '<th scope="col">' + header + '</th>').join('') +
      '</tr></thead><tbody>' +
      rows.map(row => '<tr>' + row.map(cell => '<td>' + cell + '</td>').join('') + '</tr>').join('') +
      '</tbody></table></div>'
    : '<p class="empty">' + empty + '</p>';
  updatePanel(id, markup);
}

function updatePanel(id, markup) {
  if (renderedPanels.get(id) === markup) return;
  byId(id).innerHTML = markup;
  renderedPanels.set(id, markup);
}

function setRuntimeStatus(label, tone = '') {
  const status = byId('runtimeStatus');
  status.className = 'status' + (tone ? ' ' + tone : '');
  status.textContent = label;
}

function setAccess(unlocked) {
  byId('accessForm').hidden = unlocked;
  byId('lockBtn').hidden = !unlocked;
  byId('accessStatus').textContent = unlocked ? 'Unlocked' : 'Locked';
  byId('accessStatus').classList.toggle('ok', unlocked);
  byId('stopBtn').hidden = unlocked && runtimeStopped;
  byId('stopBtn').disabled = !unlocked || controlPending;
  byId('resumeBtn').hidden = !unlocked || !runtimeStopped;
  byId('resumeBtn').disabled = controlPending;
}

function lock() {
  loadRequest?.abort();
  operatorSecret = '';
  sessionStorage.removeItem('aoa_secret');
  secretInput.value = '';
  setAccess(false);
  setRuntimeStatus('Locked');
  byId('subtitle').textContent = 'Enter the operator secret to view live activity.';
  byId('updatedAt').hidden = true;
  byId('approvalCount').hidden = true;
  approvalSignature = undefined;
  byId('approvalStat').classList.remove('attention');
  for (const [id, value] of initialPanels) updatePanel(id, value);
  for (const [id, value] of initialMetrics) byId(id).textContent = value;
}

function renderApprovals(requests) {
  const pending = requests.filter(item => item.status === 'pending');
  const signature = JSON.stringify(pending);
  if (signature === approvalSignature) return;
  approvalSignature = signature;
  const container = byId('approvals');
  const openIds = new Set(Array.from(container.querySelectorAll('details[open]'), entry => entry.dataset.request));
  const count = byId('approvalCount');
  count.textContent = pending.length;
  count.hidden = pending.length === 0;
  const markup = pending.length ? pending.map(item => {
    let args = item.arguments_json || '';
    try { args = JSON.stringify(JSON.parse(args), null, 2); } catch {}
    const id = escapeHtml(item.id);
    return '<article class="approval"><div class="approval-top"><div><div class="approval-name">' +
      escapeHtml(item.tool_name) + '</div><div class="approval-meta mono">' +
      escapeHtml(item.session_key) + ' · ' + escapeHtml(item.id.slice(0, 8)) +
      '</div></div><div class="row"><button type="button" class="danger" data-deny="' + id +
      '">Deny</button><button type="button" class="primary" data-approve="' + id +
      '">Approve</button></div></div><details data-request="' + id + '"' +
      (openIds.has(item.id) ? ' open' : '') +
      '><summary>Review arguments</summary><pre>' + escapeHtml(args) +
      '</pre><p class="panel-note">Expires ' + dateCell(item.expires_at) + '</p></details></article>';
  }).join('') : '<p class="empty">No approvals waiting for a decision.</p>';
  updatePanel('approvals', markup);
}

function render(data) {
  const metrics = data.metrics;
  runtimeStopped = metrics.stopped;
  setAccess(true);
  setRuntimeStatus(runtimeStopped ? 'Stopped' : 'Running', runtimeStopped ? 'paused' : 'live');
  byId('subtitle').textContent = data.brain === 'mock' ? 'Mock model' : data.brain + ' · ' + data.model;
  const stamp = byId('updatedAt');
  stamp.textContent = 'Updated ' + new Date(data.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  stamp.hidden = false;

  byId('pendingEvents').textContent = metrics.events.pending || 0;
  byId('eventDetail').textContent = (metrics.events.running || 0) + ' running · ' + (metrics.events.dead || 0) + ' dead';
  byId('pendingApprovals').textContent = metrics.deferredPending;
  byId('approvalStat').classList.toggle('attention', metrics.deferredPending > 0);
  byId('outboxPending').textContent = metrics.outboxPending;
  byId('outboxDetail').textContent = metrics.outboxSending + ' sending';
  byId('runsToday').textContent = metrics.runsToday;
  byId('runDetail').textContent = Math.round((data.silence.silenceRate || 0) * 100) + '% quiet · UTC day';

  renderApprovals(data.deferred || []);
  table('events', 'inbox-title', ['ID', 'Source', 'Status', 'Created'],
    (data.events || []).map(item => [
      '<span class="mono muted">#' + escapeHtml(item.id) + '</span>',
      escapeHtml(item.source) + '<br><span class="mono muted">' + escapeHtml(item.source_id) + '</span>',
      pill(item.status), dateCell(item.created_at),
    ]), 'No events in the inbox.');
  table('runs', 'run-title', ['Outcome', 'Session', 'Details', 'Created'],
    (data.runs || []).map(item => [
      pill(item.outcome), '<span class="mono">' + escapeHtml(item.session_key) + '</span>',
      escapeHtml((item.silence_reason || '').slice(0, 60)), dateCell(item.created_at),
    ]), 'No runs recorded.');
  table('outbox', 'delivery-title', ['Channel', 'Status', 'Message'],
    (data.outbox || []).map(item => [escapeHtml(item.channel), pill(item.status), escapeHtml(item.body)]),
    'No messages in the outbox.');
  table('timers', 'timer-title', ['Kind', 'Due', 'Session'],
    (data.timers || []).map(item => [
      pill(item.kind), dateCell(item.due_at), '<span class="mono">' + escapeHtml(item.session_key) + '</span>',
    ]), 'No timers scheduled.');
}

async function load({ notify = false } = {}) {
  if (!operatorSecret) {
    if (notify) secretInput.focus();
    return;
  }
  loadRequest?.abort();
  const request = new AbortController();
  loadRequest = request;
  try {
    const res = await fetch('/api/dashboard', {
      headers: { 'x-approval-secret': operatorSecret }, signal: request.signal,
    });
    if (request.signal.aborted) return;
    if (res.status === 401) {
      lock();
      flash('Operator secret was rejected.', false);
      secretInput.focus();
      return;
    }
    if (!res.ok) throw new Error('Dashboard request failed (' + res.status + ').');
    const data = await res.json();
    if (request.signal.aborted) return;
    const focusWasInForm = byId('accessForm').contains(document.activeElement);
    sessionStorage.setItem('aoa_secret', operatorSecret);
    secretInput.value = '';
    render(data);
    if (focusWasInForm) byId('lockBtn').focus();
  } catch (error) {
    if (!request.signal.aborted) {
      setRuntimeStatus('Unavailable', 'paused');
      if (notify) flash(error.message || 'Could not reach the runtime.', false);
    }
  } finally {
    if (loadRequest === request) loadRequest = undefined;
  }
}

async function post(path, data) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-approval-secret': operatorSecret },
    body: JSON.stringify(data),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Request failed (' + res.status + ').');
  return body;
}

async function runAction(button, action) {
  button.disabled = true;
  try { await action(); }
  catch (error) { flash(error.message || 'Could not complete the request.', false); }
  finally { button.disabled = false; }
}

byId('approvals').addEventListener('click', event => {
  const button = event.target.closest('button[data-approve], button[data-deny]');
  if (!button || !operatorSecret) return;
  const request = button.dataset.approve || button.dataset.deny;
  const decision = button.dataset.approve ? 'approved' : 'denied';
  void runAction(button, async () => {
    await post('/events/approval', { deferredId: request, decision });
    flash(decision === 'approved' ? 'Action approved.' : 'Action denied.');
    await load();
  });
});

async function setStopped(stop, button) {
  if (!operatorSecret || controlPending) return;
  controlPending = true;
  try {
    await runAction(button, async () => {
      await post('/api/control/stop', { stop });
      flash(stop ? 'Runtime stopped.' : 'Runtime resumed.');
      await load();
    });
  } finally {
    controlPending = false;
    if (operatorSecret) setAccess(true);
  }
}

function refresh() {
  const entered = secretInput.value.trim();
  if (entered) operatorSecret = entered;
  void load({ notify: true });
}

byId('accessForm').onsubmit = event => {
  event.preventDefault();
  refresh();
};
byId('refreshBtn').onclick = refresh;
byId('lockBtn').onclick = () => { lock(); secretInput.focus(); };
byId('stopBtn').onclick = event => setStopped(true, event.currentTarget);
byId('resumeBtn').onclick = event => setStopped(false, event.currentTarget);
byId('ingestForm').onsubmit = event => {
  event.preventDefault();
  let data;
  try {
    data = JSON.parse(byId('ingestBody').value);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
  } catch {
    flash('Enter a valid JSON object.', false);
    return;
  }
  if (!data.sourceId && !data.id) data.sourceId = 'ui-' + Date.now();
  void runAction(byId('ingestBtn'), async () => {
    const response = await post('/events', data);
    flash(response.inserted ? 'Event #' + response.eventId + ' added to the inbox.' : 'Event already exists.');
    await load();
  });
};

function markSection() {
  const active = location.hash || '#overview';
  for (const link of document.querySelectorAll('.nav a')) {
    if (link.hash === active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
addEventListener('hashchange', markSection);
markSection();

void load({ notify: true });
setInterval(() => {
  if (!document.hidden && !loadRequest) void load();
}, 4000);
</script>
</body>
</html>`;
}
