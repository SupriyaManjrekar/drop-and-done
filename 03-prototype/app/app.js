// Drop & Done: conversation layer + claim card + approver inbox.
// AI extracts, engine.js decides. This file only orchestrates and renders.
const $ = (s, r = document) => r.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The sample pack is dated Sep 2026. Pin "today" for it so date checks (stale, future) never drift
// as the calendar moves on. Bills read live from the user's own files use the real date.
const DEMO_TODAY = new Date(2026, 8, 30); // 30 Sep 2026, local midnight

const S = {
  aiEnabled: false, lines: [], pending: [], view: { groups: [], totals: null },
  asked: 0, qTotal: 0, qLabel: null, pendingQ: null, startedAt: null, readyAt: null, readyAnnounced: false,
  processing: false, progress: null, submitting: false, submitted: null, priorKeys: {}, seq: 0,
  today: null, fallbackUsed: false,
};

// ------------------------------------------------------------------ icons + small view helpers
const ic = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
const CAT_ICON = { Lodging: 'bed', Airfare: 'plane', Rail: 'train', 'Local conveyance': 'car', Meals: 'utensils', 'Client entertainment': 'glass', Fuel: 'fuel', Telecom: 'phone', Other: 'receipt' };
const FLAG_ICON = { block: 'alert', risk: 'flag', warn: 'alert', info: 'info', good: 'check-circle' };
const STATUS_META = {
  COMPLETE: { label: 'Complete', icon: 'check-circle' },
  NEEDS_INFO: { label: 'Needs info', icon: 'alert' },
  QUESTIONABLE: { label: 'Questionable', icon: 'flag' },
  EXCLUDED: { label: 'Excluded', icon: 'ban' },
};
const CLAIM_META = {
  DRAFT: { cls: 's-NEEDS_INFO', label: 'Draft' }, READY: { cls: 's-COMPLETE', label: 'Ready' }, READING: { cls: 's-READING', label: 'Reading' },
  SUBMITTED: { cls: 's-SUBMITTED', label: 'Submitted' }, APPROVED: { cls: 's-APPROVED', label: 'Approved' },
  PAID: { cls: 's-PAID', label: 'Paid' }, REJECTED: { cls: 's-REJECTED', label: 'Sent back' },
};
const statusChip = (s) => `<span class="chip s-${s}">${ic(STATUS_META[s].icon)}${STATUS_META[s].label}</span>`;
const claimChip = (s, prefix = '') => { const m = CLAIM_META[s] || { cls: '', label: s }; return `<span class="chip ${m.cls}">${prefix}${m.label}</span>`; };
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const longDay = (d) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const SOURCE = {
  claude: { cls: 'src-live', icon: 'sparkle', label: 'Read by AI (live)' },
  demo: { cls: 'src-demo', icon: 'package', label: 'Pre-computed demo extraction' },
  fallback: { cls: 'src-fail', icon: 'alert', label: 'Live call failed: showing pre-computed data' },
};

// ------------------------------------------------------------------ chat primitives
function now() { return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); }
function scrollChat() { const m = $('#msgs'); m.scrollTop = m.scrollHeight; }
function addMsg(html, who = 'bot', extra = '') {
  const el = document.createElement('div');
  el.className = `msg ${who} ${extra}`.trim();
  el.innerHTML = `${html}<div class="meta">${now()}</div>`;
  $('#msgs').appendChild(el);
  scrollChat();
  if ($('#employee').hidden) $('#empDot').hidden = false;
  return el;
}
async function botSays(html, delay = 450, extra = '') {
  const t = addMsg('<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>', 'bot', extra);
  await sleep(delay);
  t.innerHTML = `${html}<div class="meta">${now()}</div>`;
  scrollChat();
  return t;
}
// Options are bound to handlers; once one is chosen the whole set is locked (unless keep: true).
function withOptions(el, opts) {
  const box = document.createElement('div');
  box.className = 'opts';
  for (const o of opts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'opt' + (o.primary ? ' primary' : '');
    b.innerHTML = (o.icon ? ic(o.icon) : '') + `<span>${esc(o.label)}</span>`;
    b.onclick = () => {
      if (o.keep) return o.run(b);
      box.querySelectorAll('button').forEach((x) => (x.disabled = true));
      b.classList.add('chosen');
      o.run(b);
    };
    box.appendChild(b);
  }
  el.insertBefore(box, el.querySelector('.meta'));
  scrollChat();
}
const alertBox = (level, icon, html) => `<div class="alert ${level}">${ic(icon)}<div>${html}</div></div>`;

// ------------------------------------------------------------------ init
async function init() {
  const E = POLICY.employee;
  $('#who').textContent = `${E.name} · ${E.grade} · ${E.costCentre}`;
  try { S.aiEnabled = (await (await fetch('/api/config')).json()).aiEnabled; } catch { S.aiEnabled = false; }
  updateMode();
  updateAsOf();
  await refreshPriorClaims();
  renderClaim();
  welcome();
  wireInputs();
  setTimeout(prewarmSamples, 300);
}

function updateMode() {
  const m = $('#mode');
  const state = !S.aiEnabled ? 'demo' : S.fallbackUsed ? 'warn' : 'live';
  m.className = 'mode ' + state;
  m.innerHTML = {
    demo: `${ic('package')}Demo mode<span class="lg"> · pre-computed AI</span>`,
    live: `${ic('sparkle')}AI-powered<span class="lg"> · live</span>`,
    warn: `${ic('alert')}Live AI · fallback used`,
  }[state];
  m.title = {
    demo: 'The sample pack replays pre-computed extraction. Enable live AI on the server to read your own bills.',
    live: 'Bills are read by AI in real time',
    warn: 'At least one live call failed and pre-computed sample data was used instead. See the chat for details.',
  }[state];
}

// "Today" is pinned when every bill on the claim comes from the sample pack (always the case in demo mode).
function datePinned(lines = claimLines()) { return lines.length ? lines.every((l) => l.isSample) : !S.aiEnabled; }
function claimToday(lines) { return datePinned(lines) ? new Date(DEMO_TODAY) : new Date(); }
function updateAsOf() {
  const el = $('#asOf');
  el.hidden = !datePinned();
  el.innerHTML = `${ic('calendar')}<span class="lg">Demo date pinned: </span>${longDay(DEMO_TODAY)}`;
  el.title = 'The sample bills are dated Sep 2026, so the demo treats 30 Sep 2026 as today. That keeps the date checks (too old, future-dated) stable whenever you run it. Bills you upload in live mode are checked against the real date.';
}

function welcome() {
  const first = POLICY.employee.name.split(' ')[0];
  const el = addMsg(`<p>Hi ${esc(first)}, I'm your reimbursement assistant.</p>
    <p>Drop all your bills here in one go: photos, PDFs, UPI screenshots, even handwritten slips. I'll read them, group them into trips, check policy and get a claim <b>ready to submit</b>. I'll only ask what I can't work out myself.</p>
    ${S.aiEnabled ? '' : alertBox('note', 'package', `<b>Demo mode.</b> The sample pack uses pre-computed extraction, and today is pinned to ${longDay(DEMO_TODAY)} so the sample dates stay valid. Enable live AI on the server to read your own bills.`)}
    <p class="hint">You can also type <b>policy</b>, <b>status</b>, <b>submit</b> or <b>start over</b> at any time.</p>`);
  withOptions(el, [
    { label: 'Try the sample pack (12 bills, 2 trips)', icon: 'package', primary: true, keep: true, run: useSamples },
    { label: 'Upload my bills', icon: 'clip', keep: true, run: () => $('#fileInput').click() },
  ]);
}

// Sample bills are rendered once in the background so the demo starts instantly.
let samplesReady = null;
const prewarmSamples = () => (samplesReady = samplesReady || loadSampleFiles());

async function useSamples() {
  if (S.processing || S.loadingSamples) return;
  S.loadingSamples = true;
  let settled = false;
  const p = prewarmSamples().finally(() => (settled = true));
  await sleep(150);
  const note = settled ? null : addMsg('<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span> Fetching the sample pack…');
  try { const files = await p; note?.remove(); handleFiles(files); }
  catch (e) { note?.remove(); botSays(alertBox('risk', 'alert', `Couldn't build the sample pack (${esc(e.message)}). Reload the page and try again.`)); }
  finally { S.loadingSamples = false; }
}

function wireInputs() {
  $('#fileInput').onchange = (e) => { handleFiles([...e.target.files]); e.target.value = ''; };
  $('#attachBtn').onclick = () => $('#fileInput').click();
  const chat = $('.chat');
  let depth = 0;
  chat.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; chat.classList.add('dragging'); });
  chat.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; chat.classList.remove('dragging'); } });
  chat.addEventListener('dragover', (e) => e.preventDefault());
  chat.addEventListener('drop', (e) => { e.preventDefault(); depth = 0; chat.classList.remove('dragging'); handleFiles([...e.dataTransfer.files]); });
  addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])]; if (f.length) handleFiles(f); });
  $('#composer').onsubmit = (e) => { e.preventDefault(); const t = $('#text').value.trim(); if (t) { $('#text').value = ''; onText(t); } };
  document.querySelectorAll('.cmd').forEach((b) => (b.onclick = () => { onText(b.dataset.cmd, true); $('#text').focus(); }));

  const tabs = [...document.querySelectorAll('.tab')];
  tabs.forEach((t, i) => {
    t.onclick = () => switchView(t.dataset.view);
    t.onkeydown = (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      switchView(next.dataset.view); next.focus();
    };
  });
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
  addEventListener('keydown', (e) => {
    if ($('#modal').hidden) return;
    if (e.key === 'Escape') closeModal();
    if (e.key === 'Tab') trapFocus(e);
  });
  setInterval(tick, 500);
}

function tick() {
  const t = $('#timer');
  if (!S.startedAt) { t.hidden = true; return; }
  t.hidden = false;
  const end = S.readyAt || Date.now();
  const sec = Math.round((end - S.startedAt) / 1000);
  t.innerHTML = `${ic(S.readyAt ? 'check' : 'clock')}<b>${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}</b><span>${S.readyAt ? 'pile to ready' : 'to ready'}</span>`;
  t.classList.toggle('done', !!S.readyAt);
}

// ------------------------------------------------------------------ ingest pipeline
async function sha256(buf) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function b64(buf) {
  let s = ''; const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
async function downscale(file, max = 1800) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', 0.88).split(',')[1];
}

async function prepDoc(file) {
  const buf = await file.arrayBuffer();
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isImg = /^image\/(jpeg|png|webp|gif)$/.test(file.type);
  if (!isPdf && !isImg) throw new Error('Unsupported file type. Use JPG, PNG, WEBP or PDF.');
  const doc = { id: 'L' + ++S.seq, fileName: file.name, hash: await sha256(buf), isPdf, sample: file._sampleExtraction || null };
  doc.previewUrl = isImg ? URL.createObjectURL(file) : null;
  if (isPdf) { doc.mediaType = 'application/pdf'; doc.base64 = b64(buf); }
  else { doc.mediaType = 'image/jpeg'; doc.file = file; }
  return doc;
}

async function extract(doc) {
  if (S.aiEnabled) {
    if (!doc.base64) doc.base64 = await downscale(doc.file);
    try { return { x: await aiExtract(doc), via: 'claude' }; }
    catch (e) { if (doc.sample) return { x: doc.sample, via: 'fallback', err: e.message }; throw e; }
  }
  if (doc.sample) { await sleep(350 + Math.random() * 900); return { x: doc.sample, via: 'demo' }; }
  throw new Error('Live AI is off, so only the sample pack can be read. Enable live AI on the server to read your own bills.');
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

// Lines on the claim, including ones still arriving from the current batch (kept in file order).
function claimLines() { return S.processing ? S.lines.concat(S.pending.filter(Boolean)) : S.lines; }

async function handleFiles(files) {
  if (!files.length) return;
  if (S.processing) { botSays('I\'m still reading the last batch. Drop these again in a moment.'); return; }
  if (S.submitted) resetClaim(true);
  S.processing = true;
  S.pending = [];
  S.progress = { done: 0, total: files.length };
  if (!S.startedAt) S.startedAt = Date.now();
  S.readyAt = null; S.readyAnnounced = false;
  renderClaim();

  const thumbs = files.map((f) => /^image\//.test(f.type) ? `<img src="${URL.createObjectURL(f)}" alt="">` : `<div class="pdf">${ic('file')}PDF</div>`).join('');
  addMsg(`<div class="thumbs">${thumbs}</div>${plural(files.length, 'file')}`, 'me');

  const prog = await botSays(`Got ${files.length}. Reading them now${S.aiEnabled ? ' with AI' : ''}…<ul class="prog">${files.map((f, k) => `<li id="p${k}"><span class="spin" aria-hidden="true"></span><span class="n">${esc(f.name)}</span></li>`).join('')}</ul>`, 300);
  const errors = [], fallbacks = [];
  await pool(files, 4, async (file, k) => {
    const li = prog.querySelector('#p' + k);
    try {
      const doc = await prepDoc(file);
      const { x, via, err } = await extract(doc);
      doc.extraction = x;
      const line = buildLine(doc);
      line.via = via;
      line.viaErr = err || null;
      line.isSample = !!doc.sample;
      S.pending[k] = line;
      if (via === 'fallback') fallbacks.push(`${file.name}: ${err}`);
      li.className = via === 'fallback' ? 'fb' : 'ok';
      li.innerHTML = `${ic(via === 'fallback' ? 'alert' : 'check')}<span class="n">${esc(file.name)}</span><small>${esc(line.vendor || '')}${line.total != null ? ' · ' + inr(line.total) : ''}${via === 'fallback' ? ' · pre-computed' : ''}</small>`;
    } catch (e) {
      errors.push(`${file.name}: ${e.message}`);
      li.className = 'err';
      li.innerHTML = `${ic('alert')}<span class="n">${esc(file.name)}</span><small>couldn't read</small>`;
    }
    S.progress.done++;
    recompute();
  });
  S.lines.push(...S.pending.filter(Boolean));
  S.pending = [];
  S.processing = false;
  S.progress = null;
  recompute();

  if (errors.length) await botSays(alertBox('warn', 'alert', `<b>I couldn't read ${plural(errors.length, 'file')}.</b> The rest are on the claim.<ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`));
  if (fallbacks.length) {
    S.fallbackUsed = true;
    updateMode();
    await botSays(alertBox('risk', 'alert', `<b>Live AI failed on ${fallbacks.length} of ${plural(files.length, 'file')}.</b> I used the pre-computed sample data for ${fallbacks.length === 1 ? 'it' : 'them'} instead, so ${fallbacks.length === 1 ? 'that line was' : 'those lines were'} <b>not</b> read live by the AI. They are tagged <i>pre-computed</i> in the claim card.<ul>${fallbacks.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>Check the server window and the API key, then drop the files again for a live read.`));
  }
  if (S.lines.length) { await summarise(); askNext(); }
}

function recompute() {
  const lines = claimLines();
  S.today = claimToday(lines);
  S.view = evaluate(lines, { priorKeys: S.priorKeys, today: S.today });
  if (!S.processing) {
    if (S.view.totals.ready && !S.readyAt) S.readyAt = Date.now();
    if (!S.view.totals.ready) S.readyAt = null;
  }
  renderClaim();
  updateAsOf();
}

// ------------------------------------------------------------------ conversation
const hl = (level, icon, html) => `<div class="hl ${level}">${ic(icon)}<span>${html}</span></div>`;

async function summarise() {
  const { groups, totals: t } = S.view;
  const trips = groups.filter((g) => g.id !== 'gx');
  const L = S.lines;
  const dups = L.filter((l) => l.flags.some((f) => f.code === 'duplicate'));
  const gstLost = L.filter((l) => l.flags.some((f) => f.code === 'gst_lost'));
  const alcohol = L.filter((l) => l.flags.some((f) => f.code === 'alcohol'));
  const risky = L.filter((l) => l.status === STATUS.QUESTIONABLE);
  const read = L.filter((l) => l.isReceipt).length;
  const qs = planQuestions(L, groups);

  let h = `<p>Read ${plural(read, 'bill')}. I found <b>${plural(trips.length, 'trip')}</b> and <b>${inr(t.billed)}</b> in spend.</p><ul class="trips">`;
  for (const g of trips) h += `<li>${ic('pin')}<span><b>${esc(g.name)}</b> · ${g.range} · ${plural(g.lines.length, 'bill')} · ${inr(g.claimable)}</span></li>`;
  h += '</ul>';
  for (const l of dups) h += hl('risk', 'flag', `<b>${esc(l.fileName)}</b> is the same ${esc(l.vendor)} ride as <b>${esc(l.dupOf.line.fileName)}</b>, just a different photo. I left it out.`);
  for (const l of alcohol) h += hl('info', 'glass', `Took ${inr(l.items.filter((i) => i.is_alcohol).reduce((s, i) => s + i.amount, 0))} of alcohol off ${esc(l.vendor)}, as it isn't reimbursable.`);
  for (const l of gstLost) h += hl('warn', 'alert', `${esc(l.vendor)}'s invoice doesn't have the company GSTIN, so <b>${inr(l.tax)}</b> of GST credit would be lost.`);
  for (const l of risky.filter((l) => !l.flags.some((f) => f.code === 'duplicate'))) h += hl('risk', 'flag', `${esc(l.vendor)}: ${esc(l.flags.find((f) => f.level === 'risk').text)}`);
  const ok = L.filter((l) => l.status === STATUS.COMPLETE).length;
  h += `<p class="sum-foot">${ok} of ${L.length} lines are complete. ${qs.length ? `I need <b>${plural(Math.min(qs.length, POLICY.maxQuestions), 'quick answer')}</b> and you're done.` : 'Nothing to ask.'}</p>`;
  const el = await botSays(h, 700);
  if (gstLost.length) withOptions(el, [{ label: 'Draft GST invoice request', icon: 'mail', keep: true, run: () => draftGstEmail(gstLost[0]) }]);
}

async function askNext() {
  const qs = planQuestions(S.lines, S.view.groups);
  if (!qs.length) return announceReady();
  if (S.asked >= POLICY.maxQuestions) {
    await botSays(`That's enough questions from me. ${qs.length} small thing${qs.length > 1 ? 's are' : ' is'} left; tap <b>Fix</b> on the highlighted line${qs.length > 1 ? 's' : ''} in the claim card when you're ready.`);
    return;
  }
  S.asked++;
  ask(qs[0], true);
}

// Question header: numbered questions count towards the cap; a follow-up (attendees) is shown as part
// of its parent question; Fix-button questions are labelled separately and don't count.
function qHead(n, of, suffix = '') {
  const dots = Array.from({ length: of }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
  return `<div class="qnum"><span class="qdots" aria-hidden="true">${dots}</span>Question ${n} of ${of}${suffix}</div>`;
}
async function ask(q, counted, followUpOf) {
  S.pendingQ = q;
  const left = planQuestions(S.lines, S.view.groups).length;
  let head;
  if (counted) { S.qTotal = Math.min(S.asked + left - 1, POLICY.maxQuestions); S.qLabel = { n: S.asked, of: S.qTotal }; head = qHead(S.asked, S.qTotal); }
  else if (followUpOf) head = qHead(followUpOf.n, followUpOf.of, ', continued');
  else { S.qLabel = null; head = `<div class="qnum fix">${ic('pencil')}Fixing a line</div>`; }
  const el = await botSays(head + q.text, 500, followUpOf ? 'q followup' : 'q');
  S.pendingEl = el;
  withOptions(el, q.options.map((o) => ({ label: o.label, run: () => answer(q, o.answer, o.label, o.followUp) })));
  $('#text').placeholder = q.input ? q.input.placeholder : 'Tap an option above, or type';
  if (q.input) $('#text').focus();
}

async function answer(q, ans, label, followUp) {
  const line = S.lines.find((l) => l.id === q.lineId);
  if (!line) return;
  S.pendingQ = null;
  $('#text').placeholder = 'Drop bills here, or type a message';
  if (label) addMsg(esc(label), 'me');
  Object.assign(line.answers, ans);
  const before = line.claimable;
  recompute();

  if (followUp === 'attendees') {
    return ask({ lineId: line.id, code: 'attendees_missing', text: 'Great. Who attended? Give names and companies, separated by commas.', options: [],
      input: { key: 'attendees', placeholder: 'e.g. Rahul Mehta (Zenith Pharma), Priya Nair (Zenith Pharma)' } }, false, S.qLabel);
  }
  let ack = 'Done.';
  if (ans.exclude) ack = `Okay, I've left out ${esc(line.vendor || line.fileName)}.`;
  else if (ans.date) ack = `Got it: ${fmtDay(ans.date)}. It's now under <b>${esc(S.view.groups.find((g) => g.id === line.groupId)?.name || 'your trip')}</b>.`;
  else if (ans.attendees) ack = `Logged as client entertainment with ${ans.attendees.length + 1} people. Claimable: <b>${inr(line.claimable)}</b> (alcohol removed).`;
  else if (ans.mealType === 'solo') ack = `Capped at ${inr(line.claimable)}, the solo meal limit.`;
  else if (ans.arith === 'items') ack = `Using ${inr(line.claimable)}. I've still sent this bill to finance because it shows signs of editing.`;
  else if (ans.arith === 'printed') ack = `Okay. I've flagged it for finance to check the printed total.`;
  else if (ans.amount != null) ack = `Amount set to ${inr(ans.amount)}.`;
  else if (before !== line.claimable) ack = `Updated to ${inr(line.claimable)}.`;
  await botSays(ack, 350);
  askNext();
}

function parseDate(t) {
  const m = t.match(/(\d{1,2})[\s/\-.]*([a-z]{3,}|\d{1,2})?[\s/\-.]*(\d{2,4})?/i);
  if (!m) return null;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const ref = S.lines.find((l) => l.effDate)?.effDate || isoDay(S.today || new Date());
  let mo = m[2] ? (isNaN(m[2]) ? months.indexOf(m[2].slice(0, 3).toLowerCase()) + 1 : +m[2]) : +ref.slice(5, 7);
  let y = m[3] ? +m[3] : +ref.slice(0, 4); if (y < 100) y += 2000;
  const d = +m[1];
  if (!mo || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// isCommand: sent from a quick-command chip, so never treat it as the answer to an open question.
function onText(t, isCommand) {
  addMsg(esc(t), 'me');
  const q = S.pendingQ;
  if (q && q.input && !isCommand) {
    const k = q.input.key;
    let ans = null;
    if (k === 'date') { const d = parseDate(t); if (d) ans = { date: d }; }
    if (k === 'amount') { const n = parseFloat(t.replace(/[^\d.]/g, '')); if (n > 0) ans = { amount: n }; }
    if (k === 'attendees') { const a = t.split(/,|;| and /).map((s) => s.trim()).filter(Boolean); if (a.length) ans = { attendees: a }; }
    if (!ans) return botSays(`Sorry, I didn't get that. ${esc(q.input.placeholder)}`);
    S.pendingEl?.querySelectorAll('.opt').forEach((x) => (x.disabled = true));
    return answer(q, ans, null);
  }
  if (/^\s*(help|\?|commands)\s*$|what can you do/i.test(t)) {
    return botSays(`Here's what I understand:<ul class="cmd-list">
      <li><b>Drop or paste bills</b> anywhere in the chat, or use the paperclip</li>
      <li><b>sample</b>: load the 12-bill sample pack</li>
      <li><b>policy</b>: your caps and limits</li>
      <li><b>status</b>: summary of the current claim</li>
      <li><b>submit</b>: send the claim once it's ready</li>
      <li><b>start over</b>: clear the claim</li></ul>
      In the claim card, click any line to see the bill and every check. Use <b>Fix</b>, <b>Exclude</b> or <b>Not a duplicate</b> on a line to correct me.`);
  }
  if (/sample/i.test(t)) { useSamples(); return; }
  if (/submit|send it|file it/i.test(t)) return S.view.totals?.ready ? submitClaim() : botSays('Not ready yet. Answer the open question, or tap <b>Fix</b> on the lines marked <b>Needs info</b>.');
  if (/status|summary|where/i.test(t)) return S.lines.length ? summarise() : botSays('No bills yet. Drop some here to get started.');
  if (/new claim|start over|reset/i.test(t)) { resetClaim(); return botSays('Fresh start. Drop the next pile of bills.'); }
  if (/policy|limit|allowed|cap/i.test(t)) {
    const c = POLICY.caps;
    return botSays(`Your policy (grade ${esc(POLICY.employee.grade)}, ${esc(POLICY.version)}):<ul><li>Hotel: ${inr(c.hotelPerNight.metro)}/night in metros, ${inr(c.hotelPerNight.other)} elsewhere</li><li>Meals: ${inr(c.mealPerPerson)} per person; client entertainment ${inr(c.entertainmentPerHead)} per head</li><li>Cab: ${inr(c.cabPerRide)} per ride</li><li>No invoice: UPI or handwritten proof up to ${inr(c.noInvoiceMax)}</li><li>Alcohol isn't reimbursable · claim within ${POLICY.submissionWindowDays} days</li></ul>`);
  }
  botSays('I can read bills, check your policy, or submit the claim. Try dropping files, or type <b>help</b> to see everything I understand.');
}

async function announceReady() {
  if (S.readyAnnounced || !S.view.totals?.ready || S.submitted) return;
  S.readyAnnounced = true;
  const t = S.view.totals;
  const sec = Math.round(((S.readyAt || Date.now()) - S.startedAt) / 1000);
  const n = S.lines.length - t.counts.EXCLUDED;
  const el = await botSays(`<div class="ready">${ic('check-circle')}<div><b>Claim ready</b><br>${n} lines · <b>${inr(t.claimable)}</b> claimable${t.counts.QUESTIONABLE ? ` · ${t.counts.QUESTIONABLE} flagged for finance review` : ''}
    <div class="sub">Pile to ready in ${Math.floor(sec / 60)}m ${sec % 60}s, with ${plural(S.asked, 'question')} asked.</div></div></div>`, 500);
  withOptions(el, [
    { label: `Submit claim · ${inr(t.claimable)}`, icon: 'send', primary: true, run: submitClaim },
    { label: 'Review lines', icon: 'arrow', keep: true, run: () => { $('#claim').scrollTo({ top: 0, behavior: smooth() }); $('#claim h2')?.focus(); } },
  ]);
}
const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

async function draftGstEmail(l) {
  const body = `To: accounts@${(l.vendor || 'vendor').toLowerCase().replace(/[^a-z]/g, '')}.example\nSubject: Request for revised tax invoice: ${l.invoiceNo || ''}\n\nDear Team,\n\nPlease re-issue invoice ${l.invoiceNo || ''} dated ${fmtDay(l.effDate)} for ${POLICY.employee.name}'s stay in the name of:\n\n  ${POLICY.company.name}\n  GSTIN: ${POLICY.company.gstin}\n\nThis lets us claim input tax credit of ${inr(l.tax)}.\n\nThank you,\n${POLICY.employee.name}`;
  const el = await botSays(`Here's a draft for ${esc(l.vendor || 'the vendor')}. I haven't sent anything:<div class="email">${esc(body)}</div>`);
  withOptions(el, [{ label: 'Copy to clipboard', icon: 'copy', keep: true, run: (b) => {
    const done = (msg) => { b.querySelector('span').textContent = msg; };
    if (!navigator.clipboard) return done('Copy not available here: select the text instead');
    navigator.clipboard.writeText(body).then(() => done('Copied'), () => done('Copy failed: select the text instead'));
  } }]);
}

// ------------------------------------------------------------------ submit to mock finance system
async function submitClaim() {
  if (S.submitted || S.submitting || !S.view.totals?.ready) return;
  S.submitting = true; renderClaim();
  const t = S.view.totals;
  const metrics = { filesProcessed: S.lines.length, questionsAsked: S.asked, timeToReadySec: Math.round(((S.readyAt || Date.now()) - S.startedAt) / 1000), extraction: S.aiEnabled ? 'claude-live' : 'demo' };
  const payload = buildSubmission(S.lines, S.view.groups, t, metrics);
  payload.copilot = copilotSummary(payload);
  try {
    const res = await fetch('/api/claims', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    S.submitted = await res.json();
  } catch (e) {
    S.submitting = false; renderClaim();
    return botSays(alertBox('risk', 'alert', `Couldn't reach the reimbursement system (${esc(e.message)}). Nothing was lost: your claim is still here. Check that the server window is open, then press <b>Submit</b> again.`));
  }
  S.submitting = false;
  addMsg('Submit claim', 'me');
  await refreshPriorClaims();
  renderClaim();
  const el = await botSays(`Submitted. <b>${esc(S.submitted.id)}</b> is with <b>${esc(POLICY.employee.manager)}</b> for approval.<br>The approver gets a short summary, so they only need to look at what's flagged.`);
  withOptions(el, [
    { label: 'See the approver view', icon: 'inbox', keep: true, run: () => switchView('approver') },
    { label: 'New claim', icon: 'plus', keep: true, run: () => { resetClaim(); botSays('Fresh start. Drop the next pile of bills.'); } },
  ]);
}

function resetClaim(silent) {
  Object.assign(S, { lines: [], pending: [], view: { groups: [], totals: null }, asked: 0, qTotal: 0, qLabel: null, pendingQ: null, startedAt: null, readyAt: null, readyAnnounced: false, submitted: null, submitting: false });
  renderClaim();
  updateAsOf();
  if (!silent) $('#text').placeholder = 'Drop bills here, or type a message';
}

// Re-open a claim the approver sent back. Its keys no longer count as "already claimed"
// (refreshPriorClaims skips REJECTED claims), so the same bills can be submitted again.
async function reopenClaim() {
  if (!S.submitted || S.submitted.status !== 'REJECTED') return;
  await refreshPriorClaims();
  S.submitted = null; S.readyAnnounced = false;
  switchView('employee');
  recompute();
  await botSays('Claim reopened with your answers kept. Click any line to check its evidence, use <b>Exclude</b>, <b>Include again</b> or <b>Fix</b> to change it, then submit again. It will get a new claim number.');
  announceReady();
}

async function refreshPriorClaims() {
  try {
    const list = await (await fetch('/api/claims')).json();
    S.priorKeys = {};
    for (const c of list) {
      if (c.status === 'REJECTED') continue; // sent back: not a live claim, so its bills may be claimed again
      for (const tr of c.claim.trips || []) for (const l of tr.lines) if (l.txnKey && l.status !== 'EXCLUDED') S.priorKeys[l.txnKey] = c.id;
    }
    const pending = list.filter((c) => c.status === 'SUBMITTED').length;
    $('#apprCount').hidden = !pending; $('#apprCount').textContent = pending;
    return list;
  } catch { return null; }
}

// ------------------------------------------------------------------ claim card
function renderClaim() {
  const box = $('#claim');
  const lines = claimLines();
  const { groups, totals: t } = S.view;
  if (!lines.length || !t) {
    if (S.processing) {
      const p = S.progress || { done: 0, total: 0 };
      box.innerHTML = `<div class="c-head"><div class="c-top"><h2 tabindex="-1">Expense claim</h2>${claimChip('READING')}</div>
        <div class="sub">Reading ${p.done} of ${plural(p.total, 'bill')}…</div></div>
        <div class="c-body" aria-busy="true">${'<div class="skel"><i></i><div><b></b><b></b></div></div>'.repeat(Math.min(p.total || 3, 5))}</div>`;
      return;
    }
    box.innerHTML = `<div class="c-head"><h2 tabindex="-1">Your claim</h2><div class="sub">Builds itself as I read your bills</div></div>
      <div class="empty">
        <div class="empty-ic">${ic('receipt')}</div>
        <p class="empty-t">No bills yet</p>
        <ol class="steps">
          <li>${ic('upload')}<span><b>Drop</b> photos, PDFs or screenshots into the chat</span></li>
          <li>${ic('help')}<span><b>Answer</b> up to ${POLICY.maxQuestions} quick questions</span></li>
          <li>${ic('send')}<span><b>Submit</b> a policy-checked claim</span></li>
        </ol>
        <p class="empty-legend">Each bill lands here as ${statusChip('COMPLETE')} ${statusChip('NEEDS_INFO')} ${statusChip('QUESTIONABLE')} or ${statusChip('EXCLUDED')}</p>
        <button type="button" class="btn primary" id="emptySample">${ic('package')}Try the sample pack</button>
      </div>`;
    $('#emptySample').onclick = useSamples;
    return;
  }
  const c = t.counts, n = lines.length;
  const seg = (k) => (c[k] ? `<i class="m-${k}" style="width:${(c[k] / n) * 100}%"></i>` : '');
  const status = S.processing ? 'READING' : S.submitted ? S.submitted.status : t.ready ? 'READY' : 'DRAFT';
  const fallbackN = lines.filter((l) => l.via === 'fallback').length;
  const adjusted = t.billed - t.claimable;
  let h = `<div class="c-head">
    <div class="c-top"><h2 tabindex="-1">Expense claim</h2>${claimChip(status, S.submitted ? `${esc(S.submitted.id)} · ` : '')}</div>
    <div class="sub">${esc(POLICY.employee.name)} · ${esc(POLICY.employee.costCentre)} · approver ${esc(POLICY.employee.manager)} · policy ${esc(POLICY.version)}${datePinned(lines) ? ` · checked as of ${longDay(DEMO_TODAY)} (demo)` : ''}</div>
    ${fallbackN ? `<div class="banner risk">${ic('alert')}<span><b>${plural(fallbackN, 'line')} not read live.</b> The AI call failed, so ${fallbackN === 1 ? 'it uses' : 'they use'} pre-computed sample data.</span></div>` : ''}
    <div class="c-total"><div><span class="lbl">Claimable</span><b class="num">${inr(t.claimable)}</b></div>
      <div class="c-side"><span>of ${inr(t.billed)} billed</span>${adjusted >= 1 ? `<span>${inr(adjusted)} taken off by policy</span>` : ''}${t.excluded >= 1 ? `<span>${inr(t.excluded)} left out</span>` : ''}</div></div>
    <div class="meter" role="img" aria-label="${c.COMPLETE} complete, ${c.NEEDS_INFO} need info, ${c.QUESTIONABLE} questionable, ${c.EXCLUDED} excluded">${seg('COMPLETE')}${seg('QUESTIONABLE')}${seg('NEEDS_INFO')}${seg('EXCLUDED')}</div>
    <div class="statusbar">
      ${['COMPLETE', 'NEEDS_INFO', 'QUESTIONABLE', 'EXCLUDED'].map((k) => `<span class="legend ${c[k] ? '' : 'zero'}"><i class="m-${k}"></i><b>${c[k]}</b> ${STATUS_META[k].label.toLowerCase()}</span>`).join('')}
    </div></div><div class="c-body">`;
  for (const g of groups) {
    h += `<section class="group" aria-label="${esc(g.name)}"><div class="g-head"><span class="g-name">${ic(g.id === 'gx' ? 'calendar' : 'pin')}${esc(g.name)}</span>
      <span class="g-meta">${g.range ? g.range + ' · ' : ''}${plural(g.lines.length, 'bill')}<b class="num">${inr(g.claimable)}</b></span></div>`;
    for (const l of g.lines) h += lineHtml(l);
    h += '</section>';
  }
  const rejected = S.submitted?.status === 'REJECTED';
  const btnLabel = S.processing ? `Reading bills… ${S.progress ? `${S.progress.done}/${S.progress.total}` : ''}`
    : S.submitting ? 'Submitting…'
    : rejected ? `${ic('undo')}Sent back: reopen to edit and resubmit`
    : S.submitted ? `${ic('check')}Submitted · ${CLAIM_META[S.submitted.status]?.label || S.submitted.status}`
    : t.ready ? `${ic('send')}Submit claim · ${inr(t.claimable)}`
    : `${plural(c.NEEDS_INFO, 'line')} need${c.NEEDS_INFO === 1 ? 's' : ''} info before submitting`;
  const enabled = rejected || (t.ready && !S.submitted && !S.processing && !S.submitting);
  const gstLine = lines.find((l) => l.flags.some((f) => f.code === 'gst_lost'));
  h += `</div><div class="c-foot">
    <div class="gst"><span>GST credit captured <b class="num good">${inr(t.gstEligible)}</b></span>
      <span>GST credit at risk <b class="num ${t.gstLost ? 'warn' : ''}">${inr(t.gstLost)}</b>${gstLine && !S.processing ? `<button type="button" class="link" id="gstDraft">${ic('mail')}Draft request</button>` : ''}</span></div>
    <button type="button" class="submit ${S.submitted && !rejected ? 'done' : ''} ${rejected ? 'reopen' : ''}" id="submitBtn" ${enabled ? '' : 'disabled'}>${btnLabel}</button></div>`;
  box.innerHTML = h;
  $('#submitBtn').onclick = rejected ? reopenClaim : submitClaim;
  if (gstLine && $('#gstDraft')) $('#gstDraft').onclick = () => { switchView('employee'); draftGstEmail(gstLine); };
  box.querySelectorAll('.line').forEach((el) => (el.onclick = (e) => { if (!e.target.closest('[data-act]')) openEvidence(el.dataset.id); }));
  box.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => lineAction(b.dataset.id, b.dataset.act)));
}

function lineHtml(l) {
  const icon = CAT_ICON[l.category] || 'receipt';
  const thumb = l.previewUrl ? `style="background-image:url('${l.previewUrl}')"` : '';
  const amt = l.billed == null ? '<span class="na">amount?</span>' : l.claimable != null && Math.round(l.claimable) !== Math.round(l.billed) ? `${inr(l.claimable)}<s>${inr(l.billed)}</s>` : inr(l.billed);
  const visible = l.flags.filter((f) => f.level !== 'good' || l.status === STATUS.COMPLETE);
  const shown = visible.slice(0, 3);
  const acts = [];
  if (!S.submitted && !S.processing) {
    if (l.status === STATUS.NEEDS_INFO) acts.push(`<button type="button" class="mini fix" data-act="fix" data-id="${l.id}">${ic('pencil')}Fix</button>`);
    if (l.dupOf) acts.push(`<button type="button" class="mini" data-act="notdup" data-id="${l.id}">${ic('undo')}Not a duplicate</button>`);
    else if (l.answers.exclude) acts.push(`<button type="button" class="mini" data-act="include" data-id="${l.id}">${ic('plus')}Include again</button>`);
    else if (l.isReceipt) acts.push(`<button type="button" class="mini" data-act="exclude" data-id="${l.id}">${ic('ban')}Exclude</button>`);
    if (l.flags.some((f) => f.code === 'gst_lost')) acts.push(`<button type="button" class="mini" data-act="gst" data-id="${l.id}">${ic('mail')}Draft GST request</button>`);
  }
  const src = l.via === 'fallback' ? `<span class="tag risk">${ic('alert')}pre-computed</span>` : l.via === 'claude' ? `<span class="tag live">${ic('sparkle')}live</span>` : '';
  return `<div class="line ${l.status}" data-id="${l.id}">
    <div class="ic" ${thumb}>${l.previewUrl ? '' : ic(icon)}</div>
    <div class="main"><button type="button" class="v" aria-label="${esc(l.vendor || l.fileName)}: open the bill and its checks">${ic(icon, 'cat')}<span>${esc(l.vendor || l.fileName)}</span></button>
      <div class="d">${l.effDate ? fmtDay(l.effDate) : '<span class="na">date?</span>'} · ${esc(l.category)}${l.city ? ' · ' + esc(l.city) : ''}${src}</div></div>
    <div class="amt num">${amt}${statusChip(l.status)}</div>
    ${shown.length ? `<ul class="flags">${shown.map((f) => `<li class="flag ${f.level}">${ic(FLAG_ICON[f.level])}<span>${esc(f.text)}</span></li>`).join('')}${visible.length > 3 ? `<li class="flag more">+${visible.length - 3} more in the evidence view</li>` : ''}</ul>` : ''}
    ${acts.length ? `<div class="acts">${acts.join('')}</div>` : ''}
  </div>`;
}

function lineAction(id, act) {
  const l = S.lines.find((x) => x.id === id);
  if (!l) return;
  if (act === 'fix') {
    const q = planQuestions(S.lines, S.view.groups).find((q) => q.lineId === id);
    if (q) ask(q, false);
    $('#text').focus();
    return;
  }
  if (act === 'gst') return draftGstEmail(l);
  if (act === 'notdup') l.answers.notDuplicate = true;
  if (act === 'exclude') l.answers.exclude = true;
  if (act === 'include') delete l.answers.exclude;
  recompute();
  // Keep keyboard focus on the same line after the card re-renders.
  $(`#claim .line[data-id="${id}"] .v`)?.focus();
  if (S.view.totals.ready) announceReady(); else S.readyAnnounced = false;
}

// ------------------------------------------------------------------ evidence view
let lastFocus = null;
function openEvidence(id) {
  const l = claimLines().find((x) => x.id === id);
  if (!l) return;
  const row = (label, val, conf) => {
    const low = conf != null && conf < POLICY.autoFillConfidence;
    const bar = conf != null ? `<span class="cbar" aria-hidden="true"><i style="width:${conf * 100}%" class="${conf >= 0.85 ? 'hi' : conf >= 0.6 ? 'mid' : 'lo'}"></i></span><small class="num">${Math.round(conf * 100)}%</small>` : '';
    return `<tr class="${low ? 'low' : ''}"><th scope="row">${label}</th><td class="conf">${bar}</td><td><b>${val == null || val === '' ? '<span class="na">missing</span>' : esc(val)}</b>${low && val != null ? '<small class="lowtag">low confidence</small>' : ''}</td></tr>`;
  };
  const items = l.items.length ? `<h3>Line items</h3><table class="items">${l.items.map((i) => `<tr><td>${esc(i.description)}${i.is_alcohol ? ` <span class="tag warn">${ic('glass')}alcohol</span>` : ''}</td><td class="num">${inr(i.amount)}</td></tr>`).join('')}</table>` : '';
  const src = SOURCE[l.via] || SOURCE.demo;
  const srcNote = l.via === 'claude' ? `AI extraction · strict JSON with a confidence per field`
    : l.via === 'fallback' ? `This is not a live read. Error: ${esc(l.viaErr || 'unknown')}`
    : 'Same JSON shape the live model returns. The policy checks below run for real.';
  lastFocus = document.activeElement;
  $('#sheet').innerHTML = `
    <div class="pv">${l.previewUrl ? `<img src="${l.previewUrl}" alt="The bill as uploaded: ${esc(l.fileName)}">` : `<div class="pv-file">${ic('file')}<span>${esc(l.fileName)}</span></div>`}</div>
    <div class="info">
      <div class="ev-top"><h2 id="evTitle">${esc(l.vendor || l.fileName)}</h2><button type="button" class="close" id="evClose" aria-label="Close the evidence view">${ic('x')}</button></div>
      <div class="src ${src.cls}">${ic(src.icon)}<div><b>${src.label}</b><small>${srcNote}</small></div></div>
      <div class="ev-meta">${statusChip(l.status)}<span>${esc(l.fileName)}</span></div>
      <table class="fields">
        ${row('Vendor', l.vendor, l.conf.vendor)}
        ${row('Date', l.effDate || l.date, l.answers.date ? 1 : l.conf.date)}
        ${row('Total', l.total != null ? inr(l.total) : null, l.conf.total)}
        ${row('GST', l.tax != null ? inr(l.tax) : null, l.tax != null ? l.conf.tax : null)}
        ${row('Category', l.category, null)}
        ${row('City', l.city, l.conf.city)}
        ${l.vendorGstin ? row('Vendor GSTIN', `${l.vendorGstin} ${isValidGstin(l.vendorGstin) ? '(checksum ok)' : '(checksum fails)'}`, l.conf.vendorGstin) : ''}
        ${['Lodging', 'Airfare'].includes(l.category) ? row('Bill-to GSTIN', l.buyerGstin, l.conf.buyerGstin) : ''}
        ${l.invoiceNo ? row('Invoice / ref', l.invoiceNo, null) : ''}
        ${l.routeFrom ? row('Route', `${l.routeFrom} → ${l.routeTo || ''}`, null) : ''}
        ${row('Claimable', inr(l.claimable), null)}
      </table>
      ${items}
      <h3>Checks</h3>
      <ul class="checks">${l.flags.map((f) => `<li class="flag ${f.level}">${ic(FLAG_ICON[f.level])}<span>${esc(f.text)}${f.clause ? `<small class="clause">${esc(f.clause)}</small>` : ''}</span></li>`).join('') || `<li class="flag good">${ic('check-circle')}<span>All checks passed</span></li>`}</ul>
      ${l.notes ? `<p class="ai-note">${ic('sparkle')}<span>AI note: ${esc(l.notes)}</span></p>` : ''}
    </div>`;
  $('#modal').hidden = false;
  $('#evClose').onclick = closeModal;
  $('#evClose').focus();
}
function closeModal() {
  if ($('#modal').hidden) return;
  $('#modal').hidden = true;
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}
function trapFocus(e) {
  const f = [...$('#sheet').querySelectorAll('button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')];
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  else if (!$('#sheet').contains(document.activeElement)) { e.preventDefault(); first.focus(); }
}

// ------------------------------------------------------------------ approver inbox
function switchView(v) {
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.view === v;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', on);
    t.tabIndex = on ? 0 : -1;
  });
  $('#employee').hidden = v !== 'employee';
  $('#approver').hidden = v !== 'approver';
  if (v === 'employee') { $('#empDot').hidden = true; scrollChat(); }
  if (v === 'approver') renderApprover();
}

const EXTRACTION_LABEL = { 'claude-live': 'AI (live)', demo: 'pre-computed demo' };

async function renderApprover() {
  const box = $('#apprList');
  const all = await refreshPriorClaims();
  if (all === null) {
    box.innerHTML = `<div class="acard state">${ic('alert')}<p><b>Can't reach the mock reimbursement system.</b> Check that the server window (run.bat) is still open, then reload.</p><button type="button" class="btn" id="apprRetry">${ic('refresh')}Try again</button></div>`;
    $('#apprRetry').onclick = renderApprover;
    return;
  }
  const list = all.slice().reverse();
  if (!list.length) {
    box.innerHTML = `<div class="acard state">${ic('inbox')}<p><b>No claims waiting.</b> Submit one from the Employee tab and it shows up here with its summary.</p><button type="button" class="btn" id="apprGo">${ic('chat')}Go to the Employee tab</button></div>`;
    $('#apprGo').onclick = () => switchView('employee');
    return;
  }
  box.innerHTML = list.map((c) => {
    const k = c.claim, cp = k.copilot || copilotSummary(k);
    const flagged = k.trips.flatMap((t) => t.lines).filter((l) => l.flags.some((f) => ['risk', 'warn'].includes(f.level)) && l.status !== 'EXCLUDED');
    const m = k.metrics || {};
    const sec = m.timeToReadySec || 0;
    const lvl = (l) => (l.flags.some((f) => f.level === 'risk') ? 'risk' : 'warn');
    return `<article class="acard" aria-labelledby="h-${esc(c.id)}">
      <header class="a-top">
        <div class="a-id"><h2 id="h-${esc(c.id)}">${esc(c.id)}<span>${esc(k.employee.name)}</span></h2>
          <div class="a-meta">Submitted ${esc(new Date(c.submittedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))} · ${plural(k.trips.length, 'group')} · policy ${esc(k.policyVersion || '')}</div></div>
        <div class="a-amt"><b class="num">${inr(k.totals.claimable)}</b><span>claimable${k.totals.gstLost ? ` · ${inr(k.totals.gstLost)} GST credit lost` : ''}</span></div>
        ${claimChip(c.status)}
      </header>
      <div class="copilot"><div class="cp-h">${ic('sparkle')}<b>Copilot summary</b><span class="chip risk-${cp.risk}">${cp.risk} risk</span></div>
        <p>${esc(cp.text)}</p><small>Written by rules from the policy checks, so every sentence traces to a line below.</small></div>
      ${flagged.length ? `<table class="attn"><caption>Needs your attention</caption><thead><tr><th scope="col">Bill</th><th scope="col" class="r">Amount</th><th scope="col">Why</th></tr></thead><tbody>${flagged.map((l) => `<tr class="${lvl(l)}"><td>${ic(lvl(l) === 'risk' ? 'flag' : 'alert')}<span><b>${esc(l.vendor)}</b><small>${fmtDay(l.date)}</small></span></td><td class="r num">${inr(l.billed)}</td><td>${l.flags.filter((f) => ['risk', 'warn'].includes(f.level)).map((f) => `<div>${esc(f.text)}${f.clause ? ` <small class="clause">${esc(f.clause)}</small>` : ''}</div>`).join('')}</td></tr>`).join('')}</tbody></table>` : `<p class="allclear">${ic('shield')}Nothing flagged. Every line is within policy.</p>`}
      <div class="a-foot">
        <div class="a-metrics">${ic('clock')}Prepared in ${Math.floor(sec / 60)}m ${sec % 60}s · ${plural(m.filesProcessed || 0, 'file')} · ${plural(m.questionsAsked || 0, 'question')} asked · extraction: ${esc(EXTRACTION_LABEL[m.extraction] || m.extraction || 'n/a')}</div>
        <div class="btns">
          ${c.status === 'SUBMITTED' ? `<button type="button" class="btn no" data-d="REJECTED" data-id="${esc(c.id)}">${ic('undo')}Send back</button><button type="button" class="btn ok" data-d="APPROVED" data-id="${esc(c.id)}">${ic('check')}Approve</button>` : ''}
          ${c.status === 'APPROVED' ? `<button type="button" class="btn pay" data-d="PAID" data-id="${esc(c.id)}">${ic('cash')}Finance: mark paid</button>` : ''}
          ${c.status === 'REJECTED' ? '<span class="a-note">Sent back to the employee to fix and resubmit.</span>' : ''}
          ${c.status === 'PAID' ? `<span class="a-note good">${ic('check-circle')}Paid. Closed.</span>` : ''}
        </div>
      </div>
      <p class="a-err" role="alert"></p>
    </article>`;
  }).join('');
  box.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => decide(b.dataset.id, b.dataset.d, b)));
}

async function decide(id, d, btn) {
  const card = btn?.closest('.acard');
  const btns = card ? [...card.querySelectorAll('[data-d]')] : [];
  btns.forEach((b) => (b.disabled = true));
  let c;
  try {
    const res = await fetch(`/api/claims/${id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: d }) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    c = await res.json();
  } catch (e) {
    btns.forEach((b) => (b.disabled = false));
    if (card) card.querySelector('.a-err').textContent = `Couldn't record the decision (${e.message}). Check the server and try again.`;
    return;
  }
  if (S.submitted && S.submitted.id === id) {
    S.submitted.status = c.status;
    renderClaim();
    if (c.status === 'REJECTED') notifySentBack(id);
    else {
      const msg = {
        APPROVED: `${ic('check-circle', 'good')}<span>${esc(POLICY.employee.manager)} approved <b>${esc(id)}</b>. It's gone to finance for payout.</span>`,
        PAID: `${ic('cash', 'good')}<span><b>${esc(id)}</b> is paid: ${inr(S.view.totals.claimable)} credited to your salary account.</span>`,
      }[c.status];
      if (msg) {
        const el = addMsg(`<div class="notice">${msg}</div>`);
        if (c.status === 'PAID') withOptions(el, [{ label: 'Re-run the sample pack (duplicate check)', icon: 'refresh', keep: true, run: () => { switchView('employee'); useSamples(); } }]);
      }
    }
  }
  renderApprover();
}

// Send back: tell the employee what the approver saw and give a clear path to fix and resubmit.
function notifySentBack(id) {
  const flagged = S.lines.filter((l) => l.status === STATUS.QUESTIONABLE);
  const el = addMsg(alertBox('warn', 'undo', `<b>${esc(POLICY.employee.manager)} sent ${esc(id)} back for changes.</b> Nothing has been paid.
    ${flagged.length ? `These are the lines the approver was asked to look at:<ul>${flagged.map((l) => `<li><b>${esc(l.vendor || l.fileName)}</b> · ${inr(l.billed)}: ${esc(l.flags.find((f) => f.level === 'risk')?.text || '')}</li>`).join('')}</ul>` : ''}
    Reopen the claim to fix or exclude lines and submit it again. The sent-back claim no longer counts as "already claimed", so your bills won't be flagged as duplicates.`));
  withOptions(el, [
    { label: 'Reopen and edit this claim', icon: 'pencil', primary: true, run: reopenClaim },
    { label: 'Start a new claim', icon: 'plus', run: () => { switchView('employee'); resetClaim(); botSays('Fresh start. Drop the next pile of bills.'); } },
  ]);
}

init();
