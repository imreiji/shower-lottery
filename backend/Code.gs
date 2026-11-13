/**
 * SHOWER LOT — Google Apps Script backend
 *
 *  - Stores entries (incl. email) in a private Google Sheet
 *  - Sends a confirmation email on apply
 *  - Sends 当選 / 落選 emails at drawAt (same deterministic draw as the website)
 *  - Serves the public entry list (NO emails) to the GitHub Pages site
 *
 * Setup: see README.md → "メール機能（Google Apps Script）".
 */

// ▼ Your GitHub Pages URL (with trailing slash). config.json is read from here,
//   so the website and the backend always share one config.
const SITE_URL = 'https://imreiji.github.io/shower-lottery/';

const SHEET_NAME = 'entries';
const HEADERS = ['id', 'name', 'email', 'choices', 'submittedAt', 'status', 'companions'];

/* ======================= HTTP ======================= */

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'entries';
  if (action === 'entries') return json_({ ok: true, entries: publicEntries_() });
  return json_({ ok: false, error: 'unknown action' });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (_) { return json_({ ok: false, error: '不正なリクエストです' }); }
  if (body.action !== 'apply') return json_({ ok: false, error: 'unknown action' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return json_(apply_(body));
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'サーバーエラーが発生しました' });
  } finally {
    lock.releaseLock();
  }
}

function apply_(b) {
  const cfg = config_();
  const now = new Date();
  if (now < new Date(cfg.entryOpen)) return { ok: false, error: '受付開始前です' };
  if (now > new Date(cfg.entryClose)) return { ok: false, error: '受付期間は終了しました' };

  const name = String(b.name || '').trim().slice(0, 24);
  const email = String(b.email || '').trim().toLowerCase();
  if (!name) return { ok: false, error: 'お名前を入力してください' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return { ok: false, error: 'メールアドレスが正しくありません' };

  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const companions = (Array.isArray(b.companions) ? b.companions : []).slice(0, cfg.maxCompanions || 0)
    .map((c) => ({ name: String((c && c.name) || '').trim().slice(0, 24), email: String((c && c.email) || '').trim().toLowerCase() }));
  for (const c of companions) {
    if (!c.name) return { ok: false, error: '同行者のお名前を入力してください' };
    if (!EMAIL.test(c.email) || c.email.length > 120) return { ok: false, error: `同行者（${c.name}）のメールアドレスが正しくありません` };
  }
  const party = [email, ...companions.map((c) => c.email)];
  if (new Set(party).size !== party.length) return { ok: false, error: '同じメールアドレスが重複しています' };

  const slots = expandSlots(cfg.schedule);
  const slotById = Object.fromEntries(slots.map((s) => [s.id, s]));
  const n = 1 + companions.length;
  const choices = [...new Set(Array.isArray(b.choices) ? b.choices : [])].filter((c) => slotById[c]).slice(0, cfg.maxChoices);
  if (!choices.length) return { ok: false, error: '希望枠を選択してください' };

  const sh = sheet_();
  const rows = sh.getDataRange().getValues();
  const used = new Set(rows.slice(1).map((r) => r[0]));
  // The same 代表者 re-applying replaces their entry; anyone else already in an active entry is a conflict.
  const toReplace = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][5] !== 'active') continue;
    const rowApplicant = String(rows[i][2]).toLowerCase();
    if (rowApplicant === email) { toReplace.push(i + 1); continue; }
    const rowParty = [rowApplicant, ...JSON.parse(rows[i][6] || '[]').map((c) => String(c.email).toLowerCase())];
    const clash = party.find((p) => rowParty.includes(p));
    if (clash) return { ok: false, error: `${clash} は既に別の申込み（${rows[i][1]} さま）に含まれています` };
  }
  toReplace.forEach((r) => sh.getRange(r, 6).setValue('replaced'));
  const replaced = toReplace.length > 0;

  let id;
  do { id = newId_(); } while (used.has(id));
  sh.appendRow([id, name, email, JSON.stringify(choices), now.toISOString(), 'active', JSON.stringify(companions)]);

  const lines = choices.map((c, i) => `  第${i + 1}希望：${partyLabel_(c, n, slotById)}`).join('\n');
  const partyText = companions.length ? `\n代表者：${name}\n同行者：${companions.map((c) => c.name).join('、')}（${n}名で1枠）` : '';
  const body = (to) => `${to} さま

${to === name ? '以下の内容で抽選申込みを受け付けました。' : `${name} さまの抽選申込みに、同行者として登録されました。`}${replaced && to === name ? '\n※同じメールアドレスの以前の申込みは無効になりました。' : ''}

■ ${cfg.eventTitle}
受付番号：${id}${partyText}
${lines}

抽選結果発表：${fmtDT_(cfg, cfg.drawAt)}
結果はこのメールアドレス宛にお送りします。サイトでもご確認いただけます。
${SITE_URL}?id=${id}#result

※本メールは送信専用です。`;
  const subject = `【${cfg.siteName}】抽選申込み受付完了のお知らせ（${id}）`;
  sendMail_(cfg, email, subject, body(name));
  companions.forEach((c) => sendMail_(cfg, c.email, subject, body(c.name)));

  return { ok: true, id };
}

/* ======================= Result emails ======================= */

/** Runs from the time trigger at drawAt (or by hand). Sends each applicant their result once. */
function sendResults() {
  const cfg = config_();
  if (new Date() < new Date(cfg.drawAt)) { console.log('Not drawAt yet'); return; }
  const props = PropertiesService.getScriptProperties();
  const sent = JSON.parse(props.getProperty('resultsSent') || '{}');

  const all = activeRows_();
  const slots = expandSlots(cfg.schedule);
  const slotById = Object.fromEntries(slots.map((s) => [s.id, s]));
  const entries = cleanEntries(all, cfg, slots, slotById);
  const draw = runDraw(entries, cfg, slots, slotById);
  const rowById = Object.fromEntries(all.map((r) => [r.id, r]));

  let n = 0;
  for (const e of entries) {
    if (sent[e.id]) continue;
    const row = rowById[e.id];
    const recipients = [{ name: row.name, email: row.email }, ...row.companionsFull];
    if (MailApp.getRemainingDailyQuota() < recipients.length) { console.warn('Mail quota exhausted — run sendResults again tomorrow.'); break; }
    const w = draw.won[e.id];
    const size = 1 + e.companions.length;
    const partyText = size > 1 ? `\n代表者：${e.name}\n同行者：${e.companions.join('、')}（${size}名で1枠）` : '';
    const subject = `【${cfg.siteName}】抽選結果のお知らせ（${w ? '当選' : '落選'}）`;
    for (const r of recipients) {
      const body = w
        ? `${r.name} さま

厳正なる抽選の結果、以下の枠に【当選】されました。

■ ${cfg.eventTitle}
受付番号：${e.id}${partyText}
ご利用枠：${partyLabel_(w.slotId, size, slotById)}（第${w.rank}希望）

時間厳守でご利用ください。
${SITE_URL}?id=${e.id}#result`
        : `${r.name} さま

厳正なる抽選の結果、誠に残念ながらご希望の枠はご用意できませんでした。
空き枠については幹事にご相談ください。

■ ${cfg.eventTitle}
受付番号：${e.id}${partyText}
${SITE_URL}?id=${e.id}#result`;
      sendMail_(cfg, r.email, subject, body + '\n\n※本メールは送信専用です。');
    }
    sent[e.id] = true; n++;
    props.setProperty('resultsSent', JSON.stringify(sent));
  }
  console.log(`Sent results for ${n} entries (${Object.keys(sent).length}/${entries.length} total).`);
}

/** Run once from the editor after deploying: schedules sendResults() at drawAt. */
function setupTrigger() {
  ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'sendResults').forEach((t) => ScriptApp.deleteTrigger(t));
  const at = new Date(config_().drawAt);
  ScriptApp.newTrigger('sendResults').timeBased().at(at).create();
  sheet_();
  console.log('sendResults scheduled at ' + at.toISOString());
}

/** Clears the "already emailed" record (for testing). */
function resetSentFlags() { PropertiesService.getScriptProperties().deleteProperty('resultsSent'); }

/* ======================= Lottery (keep in sync with app.js) ======================= */

function expandSlots(schedule) {
  const out = [];
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const toHHMM = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  for (const b of schedule) {
    for (let m = toMin(b.from); m + b.every <= toMin(b.to); m += b.every) {
      const start = toHHMM(m);
      const id = b.date.slice(5).replace('-', '') + '-' + b.room + '-' + start.replace(':', '');
      out.push({ idx: out.length, id, date: b.date, room: b.room, start, end: toHHMM(m + b.every), capacity: b.capacity || 1 });
    }
  }
  return out;
}

function cleanEntries(raw, cfg, slots, slotById) {
  const byId = new Map();
  for (const e of raw) {
    if (!e || !e.id || !e.name || !Array.isArray(e.choices)) continue;
    const companions = (Array.isArray(e.companions) ? e.companions : []).map(String).slice(0, (cfg.maxCompanions || 0));
    const choices = [...new Set(e.choices)].filter((c) => slotById[c]).slice(0, cfg.maxChoices);
    if (!choices.length) continue;
    byId.set(e.id, { id: e.id, name: String(e.name), companions, choices, submittedAt: e.submittedAt });
  }
  return [...byId.values()];
}

function hash32(str) {
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

function runDraw(entries, cfg, slots, slotById) {
  const ids = entries.map((e) => e.id).sort();
  const seedText = (cfg.seed || cfg.drawAt) + '|' + ids.join(',');
  const rnd = mulberry32(hash32(seedText));
  const order = [...entries].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const left = Object.fromEntries(slots.map((s) => [s.id, s.capacity]));
  const won = {};
  for (let rank = 0; rank < cfg.maxChoices; rank++) {
    for (const e of order) {
      if (won[e.id]) continue;
      const c = e.choices[rank];
      if (c && left[c] > 0) { left[c]--; won[e.id] = { slotId: c, rank: rank + 1 }; }
    }
  }
  return { won };
}

/* ======================= helpers ======================= */

function config_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('cfg');
  if (hit) return JSON.parse(hit);
  const txt = UrlFetchApp.fetch(SITE_URL + 'config.json?v=' + Date.now()).getContentText();
  cache.put('cfg', txt, 300);
  return JSON.parse(txt);
}


function sheet_() {
  const props = PropertiesService.getScriptProperties();
  let ss;
  const id = props.getProperty('sheetId');
  if (id) ss = SpreadsheetApp.openById(id);
  else {
    ss = SpreadsheetApp.create('SHOWER LOT entries');
    props.setProperty('sheetId', ss.getId());
  }
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.getSheets()[0];
    sh.setName(SHEET_NAME);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function activeRows_() {
  return sheet_().getDataRange().getValues().slice(1)
    .filter((r) => r[5] === 'active')
    .map((r) => {
      const companionsFull = JSON.parse(r[6] || '[]');
      return { id: r[0], name: r[1], email: r[2], choices: JSON.parse(r[3] || '[]'), submittedAt: r[4], companions: companionsFull.map((c) => c.name), companionsFull };
    });
}

function publicEntries_() {
  return activeRows_().map(({ id, name, companions, choices, submittedAt }) => ({ id, name, companions, choices, submittedAt }));
}

function newId_() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = 'SL-';
  for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

function sendMail_(cfg, to, subject, body) {
  MailApp.sendEmail({ to, subject, body, name: cfg.siteName });
}

function fmtDT_(cfg, iso) {
  return Utilities.formatDate(new Date(iso), cfg.timeZone, 'yyyy/MM/dd HH:mm');
}

function partyLabel_(slotId, n, slotById) {
  const s = slotById[slotId];
  const [, m, d] = s.date.split('-').map(Number);
  return `${m}/${d} ${s.start}〜${s.end} ${s.room}` + (n > 1 ? `（${n}名）` : '');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
