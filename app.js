/* Shower slot lottery — static, deterministic, GitHub Pages friendly. */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ?now=2026-11-20T00:00:00+09:00 lets you preview any phase.
  const params = new URLSearchParams(location.search);
  const now = () => (params.get('now') ? new Date(params.get('now')) : new Date());

  let CFG, ENTRIES, SLOTS, SLOT_BY_ID, DRAW;

  /* ---------------- data ---------------- */
  async function fetchJSON(path) {
    const r = await fetch(path + (path.includes('?') ? '&' : '?') + 'v=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(path + ' ' + r.status);
    return r.json();
  }

  function expandSlots(schedule) {
    const out = [];
    const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const toHHMM = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    for (const b of schedule) {
      for (let m = toMin(b.from); m + b.every <= toMin(b.to); m += b.every) {
        const start = toHHMM(m);
        const id = b.date.slice(5).replace('-', '') + '-' + b.room + '-' + start.replace(':', '');
        out.push({ id, date: b.date, room: b.room, start, end: toHHMM(m + b.every), capacity: b.capacity || 1 });
      }
    }
    return out;
  }

  // Normalise entries: drop unknown slots, de-dupe choices and ids.
  // (One-entry-per-email is enforced by the backend, which never exposes emails.)
  // Keep this function identical to cleanEntries() in backend/Code.gs.
  function cleanEntries(raw) {
    const byId = new Map();
    for (const e of raw) {
      if (!e || !e.id || !e.name || !Array.isArray(e.choices)) continue;
      const choices = [...new Set(e.choices)].filter((c) => SLOT_BY_ID[c]).slice(0, CFG.maxChoices);
      if (!choices.length) continue;
      byId.set(e.id, { id: e.id, name: String(e.name), choices, submittedAt: e.submittedAt });
    }
    return [...byId.values()];
  }

  /* ---------------- deterministic lottery ---------------- */
  function hash32(str) { // cyrb53 folded to 32 bits
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h1 ^ h2) >>> 0;
  }
  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function runDraw(entries) {
    const ids = entries.map((e) => e.id).sort();
    const seedText = (CFG.seed || CFG.drawAt) + '|' + ids.join(',');
    const rnd = mulberry32(hash32(seedText));

    const order = [...entries].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    const left = Object.fromEntries(SLOTS.map((s) => [s.id, s.capacity]));
    const won = {}; // entryId -> { slotId, rank }
    for (let rank = 0; rank < CFG.maxChoices; rank++) {
      for (const e of order) {
        if (won[e.id]) continue;
        const c = e.choices[rank];
        if (c && left[c] > 0) { left[c]--; won[e.id] = { slotId: c, rank: rank + 1 }; }
      }
    }
    const winnersBySlot = {};
    for (const e of entries) if (won[e.id]) (winnersBySlot[won[e.id].slotId] ||= []).push(e.name);
    return { won, left, winnersBySlot, order: order.map((e) => e.id), seedText, seedHash: hash32(seedText).toString(16).padStart(8, '0') };
  }

  /* ---------------- formatting ---------------- */
  const fmtDT = (iso) => {
    const d = new Date(iso);
    const p = new Intl.DateTimeFormat('ja-JP', { timeZone: CFG.timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
    const g = (t) => p.find((x) => x.type === t)?.value;
    return `${g('year')}/${g('month')}/${g('day')}(${g('weekday')}) ${g('hour')}:${g('minute')}`;
  };
  const fmtDate = (ymd) => {
    const d = new Date(ymd + 'T12:00:00Z');
    const wd = new Intl.DateTimeFormat('ja-JP', { weekday: 'short', timeZone: 'UTC' }).format(d);
    const [, m, dd] = ymd.split('-').map(Number);
    return `${m}/${dd}(${wd})`;
  };
  const slotLabel = (s) => `${fmtDate(s.date)} ${s.start}〜${s.end}　${s.room}`;

  function phase() {
    const t = now();
    if (t < new Date(CFG.entryOpen)) return 'before';
    if (t <= new Date(CFG.entryClose)) return 'open';
    if (t < new Date(CFG.drawAt)) return 'closed';
    return 'result';
  }
  const PHASE_CHIP = {
    before: ['受付前', 'is-before'],
    open: ['受付中', 'is-open'],
    closed: ['受付終了', 'is-closed'],
    result: ['抽選結果発表中', 'is-result'],
  };

  /* ---------------- render ---------------- */
  function renderHeader() {
    document.title = `${CFG.eventTitle} 抽選受付`;
    $('#siteName').textContent = CFG.siteName;
    $('#footerName').textContent = CFG.siteName;
    $('#year').textContent = new Date().getFullYear();
    $('#crumbTitle').textContent = CFG.eventTitle;
    $('#eventTitle').textContent = CFG.eventTitle;
    $('#eventSub').textContent = CFG.eventSubtitle || '';
    const dates = [...new Set(SLOTS.map((s) => s.date))].sort();
    $('#infoDates').textContent = dates.map(fmtDate).join(' / ');
    $('#infoVenue').textContent = CFG.venue;
    const rooms = [...new Set(SLOTS.map((s) => s.room))];
    const cap = SLOTS.reduce((a, s) => a + s.capacity, 0);
    $('#infoSlots').textContent = `全${SLOTS.length}枠（定員計${cap}名・${rooms.join(' / ')}）`;
    $('#periodText').textContent = `${fmtDT(CFG.entryOpen)} 〜 ${fmtDT(CFG.entryClose)}`;
    $('#drawText').textContent = fmtDT(CFG.drawAt);
    $('#drawText2').textContent = fmtDT(CFG.drawAt);
    $('#maxChoicesText').textContent = CFG.maxChoices;
    $('#entryCount').textContent = ENTRIES.length;
    $('#rulesList').innerHTML = (CFG.rules || []).map((r) => `<li>${esc(r)}</li>`).join('');
  }

  function renderPhase() {
    const ph = phase();
    const [label, cls] = PHASE_CHIP[ph];
    for (const el of [$('#statusChip'), $('#statusChip2')]) { el.textContent = label; el.className = 'chip ' + cls; }

    const btn = $('#applyBtn');
    btn.disabled = ph !== 'open';
    btn.textContent = { before: '受付開始前', open: '申込む', closed: '受付終了', result: '受付終了' }[ph];

    const cd = $('#countdown');
    const target = ph === 'before' ? CFG.entryOpen : ph === 'open' ? CFG.entryClose : ph === 'closed' ? CFG.drawAt : null;
    if (target) {
      const ms = new Date(target) - now();
      const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
      const what = { before: '受付開始', open: '受付終了', closed: '抽選結果発表' }[ph];
      cd.textContent = `${what}まで あと ${d > 0 ? d + '日 ' : ''}${h}時間 ${m}分`;
    } else cd.textContent = '';

    $('#resultPending').hidden = ph === 'result';
    $('#resultOpen').hidden = ph !== 'result';
    $('#publicResults').hidden = !(ph === 'result' && CFG.publicResults);
    return ph;
  }

  function groupSlots() {
    const g = new Map();
    for (const s of SLOTS) {
      const k = s.date + '|' + s.room;
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(s);
    }
    return g;
  }

  function renderSlots(ph) {
    const firstDemand = {};
    for (const e of ENTRIES) firstDemand[e.choices[0]] = (firstDemand[e.choices[0]] || 0) + 1;

    $('#slotsNote').textContent = ph === 'result'
      ? '抽選後の割り当て状況です。点線の枠は空き枠です（幹事にご相談ください）。'
      : CFG.showDemand ? '各枠の第1希望の申込数を表示しています。ピンク枠は定員を超える申込みがある枠です。' : '';

    let html = '';
    for (const [k, list] of groupSlots()) {
      const [date, room] = k.split('|');
      html += `<div class="slot-group"><div class="slot-group-head"><span>${esc(fmtDate(date))}　${esc(room)}</span><small>${list.length}枠</small></div><div class="slot-list">`;
      for (const s of list) {
        let cls = '', meta = `定員${s.capacity}`;
        if (ph === 'result') {
          const w = DRAW.winnersBySlot[s.id] || [];
          if (w.length) { cls = 'is-won'; meta = w.map(esc).join('、'); } else { cls = 'is-free'; meta = '空き'; }
        } else if (CFG.showDemand) {
          const n = firstDemand[s.id] || 0;
          meta = `第1希望 ${n}件`;
          if (n > s.capacity) { cls = 'is-hot'; meta += `（${(n / s.capacity).toFixed(1)}倍）`; }
        }
        html += `<div class="slot ${cls}"><span class="slot-time">${s.start}〜${s.end}</span><span class="slot-meta">${meta}</span></div>`;
      }
      html += '</div></div>';
    }
    $('#slotGrid').innerHTML = html;
  }

  function renderResults() {
    $('#seedNote').textContent = `抽選シード: ${CFG.seed || CFG.drawAt}（申込み${ENTRIES.length}件・ハッシュ ${DRAW.seedHash}）。シードと申込み一覧が同じなら、誰が計算しても同じ結果になります。`;
    let rows = '';
    for (const s of SLOTS) {
      const w = DRAW.winnersBySlot[s.id];
      rows += `<tr><td class="t">${esc(fmtDate(s.date))} ${s.start}〜${s.end}</td><td>${esc(s.room)}</td>${w ? `<td>${w.map(esc).join('、')}</td>` : '<td class="empty">空き</td>'}</tr>`;
    }
    $('#resultTable').innerHTML = `<table class="rtable"><thead><tr><th>時間</th><th>場所</th><th>当選者</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function lookup(q) {
    q = q.trim();
    const box = $('#lookupResult');
    if (!q) { box.innerHTML = ''; return; }
    const e = ENTRIES.find((x) => x.id.toUpperCase() === q.toUpperCase()) || ENTRIES.find((x) => x.name.trim().toLowerCase() === q.toLowerCase());
    if (!e) {
      box.innerHTML = `<div class="result-card"><p class="r-label">該当する申込みが見つかりません</p><p class="hint">受付番号・お名前をご確認ください。送信されていない申込みは抽選の対象外です。</p></div>`;
      return;
    }
    const w = DRAW.won[e.id];
    if (w) {
      const s = SLOT_BY_ID[w.slotId];
      box.innerHTML = `<div class="result-card is-win"><p class="r-label">${esc(e.name)} さま（${esc(e.id)}）</p><p class="r-status">当選</p><p class="r-slot">${esc(slotLabel(s))}</p><span class="r-rank">第${w.rank}希望</span></div>`;
    } else {
      box.innerHTML = `<div class="result-card is-lose"><p class="r-label">${esc(e.name)} さま（${esc(e.id)}）</p><p class="r-status">落選</p><p class="hint">誠に残念ながら、ご希望の枠はご用意できませんでした。空き枠については幹事にご相談ください。</p></div>`;
    }
  }

  /* ---------------- apply flow ---------------- */
  let draft = null;

  function buildChoiceFields() {
    const groups = groupSlots();
    const options = ['<option value="">選択してください</option>'];
    for (const [k, list] of groups) {
      const [date, room] = k.split('|');
      options.push(`<optgroup label="${esc(fmtDate(date) + '　' + room)}">` +
        list.map((s) => `<option value="${s.id}">${s.start}〜${s.end}（${esc(room)}）</option>`).join('') + '</optgroup>');
    }
    let html = '';
    for (let i = 0; i < CFG.maxChoices; i++) {
      html += `<div class="field"><label for="fChoice${i}">第${i + 1}希望${i === 0 ? '<em class="req">必須</em>' : '<em class="opt">任意</em>'}</label><select id="fChoice${i}" data-choice>${options.join('')}</select></div>`;
    }
    $('#choiceFields').innerHTML = html;
  }

  function setStep(n) {
    $$('#stepper li').forEach((li, i) => { li.className = i + 1 === n ? 'is-active' : i + 1 < n ? 'is-done' : ''; });
    ['#step1', '#step2', '#step3'].forEach((id, i) => { $(id).hidden = i + 1 !== n; });
    $('#apply').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openApply(ev) {
    ev?.preventDefault();
    if (phase() !== 'open') { location.hash = '#top'; return; }
    $('#apply').hidden = false;
    setStep(1);
  }

  function makeId() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const b = crypto.getRandomValues(new Uint8Array(6));
    return 'SL-' + [...b].map((x) => A[x % A.length]).join('');
  }

  function onStep1(ev) {
    ev.preventDefault();
    const err = $('#step1Error');
    const name = $('#fName').value.trim();
    const email = $('#fEmail').value.trim();
    const choices = $$('[data-choice]').map((s) => s.value);
    if (!name) return (err.textContent = 'お名前を入力してください。');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return (err.textContent = 'メールアドレスを正しく入力してください。');
    if (!choices[0]) return (err.textContent = '第1希望を選択してください。');
    const picked = choices.filter(Boolean);
    if (new Set(picked).size !== picked.length) return (err.textContent = '同じ枠が複数の希望に選ばれています。');
    const gap = choices.findIndex((c, i) => !c && choices.slice(i + 1).some(Boolean));
    if (gap !== -1) return (err.textContent = `第${gap + 1}希望を空けずに、上から順に選択してください。`);
    if (!$('#fAgree').checked) return (err.textContent = '注意事項への同意が必要です。');
    err.textContent = '';
    draft = { name, email, choices: picked };
    $('#confirmTable').innerHTML =
      `<tr><th>お名前</th><td>${esc(name)}</td></tr>` +
      `<tr><th>メールアドレス</th><td>${esc(email)}</td></tr>` +
      picked.map((c, i) => `<tr><th>第${i + 1}希望</th><td>${esc(slotLabel(SLOT_BY_ID[c]))}</td></tr>`).join('');
    setStep(2);
  }

  async function onConfirm() {
    const btn = $('#confirmBtn');
    btn.disabled = true; btn.textContent = '送信中…';
    let id, msg;
    try {
      if (CFG.apiUrl) {
        // text/plain keeps this a "simple" request, so Apps Script needs no CORS preflight.
        const r = await fetch(CFG.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'apply', ...draft }) });
        const res = await r.json();
        if (!res.ok) throw new Error(res.error || '送信に失敗しました');
        id = res.id;
        msg = `<strong>${esc(draft.email)}</strong> に確認メールを送信しました。届かない場合は迷惑メールフォルダをご確認ください。抽選結果も同じアドレスにお送りします。`;
      } else {
        id = makeId();
        msg = '<strong>デモモードです。</strong>config.json の apiUrl が未設定のため、申込みは保存されず、メールも送信されません。';
      }
    } catch (e) {
      btn.disabled = false; btn.textContent = '申込みを確定する';
      $('#step2').insertAdjacentHTML('afterbegin', `<div class="alert alert-error">${esc(e.message)}　時間をおいて再度お試しください。</div>`);
      return;
    }
    btn.disabled = false; btn.textContent = '申込みを確定する';
    $('#ticketNo').textContent = id;
    $('#doneMsg').innerHTML = msg;
    try { localStorage.setItem('showerlot:last', id); } catch (_) {}
    setStep(3);
  }

  /* ---------------- boot ---------------- */
  async function boot() {
    try {
      CFG = await fetchJSON('config.json');
      ENTRIES = CFG.apiUrl
        ? (await fetchJSON(CFG.apiUrl + (CFG.apiUrl.includes('?') ? '&' : '?') + 'action=entries')).entries
        : await fetchJSON('entries.json');
    } catch (e) {
      const el = $('#loadError');
      el.hidden = false;
      el.textContent = 'config.json / entries.json を読み込めませんでした。GitHub Pages、またはローカルサーバー（python3 -m http.server）経由で開いてください。';
      return;
    }
    SLOTS = expandSlots(CFG.schedule);
    SLOT_BY_ID = Object.fromEntries(SLOTS.map((s) => [s.id, s]));
    ENTRIES = cleanEntries(ENTRIES);
    DRAW = runDraw(ENTRIES);

    renderHeader();
    buildChoiceFields();
    const ph = renderPhase();
    renderSlots(ph);
    if (ph === 'result') {
      renderResults();
      let last = null; try { last = localStorage.getItem('showerlot:last'); } catch (_) {}
      const q = params.get('id') || last;
      if (q) { $('#lookupInput').value = q; lookup(q); }
    }

    $$('[data-open-apply]').forEach((b) => b.addEventListener('click', openApply));
    $$('[data-close-apply]').forEach((b) => b.addEventListener('click', () => { $('#apply').hidden = true; location.hash = '#top'; }));
    $('#step1').addEventListener('submit', onStep1);
    $('#backBtn').addEventListener('click', () => setStep(1));
    $('#confirmBtn').addEventListener('click', onConfirm);
    $('#lookupForm').addEventListener('submit', (e) => { e.preventDefault(); lookup($('#lookupInput').value); });

    setInterval(() => {
      if (renderPhase() !== ph) location.reload();
    }, 30000);
  }

  boot();
})();
