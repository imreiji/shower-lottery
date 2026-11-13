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

  const entry = { id, name, choices, companions: companions.map((c) => c.name) };
  const mine = mailApplicant_(cfg, entry, slotById, replaced);
  sendMail_(cfg, email, mine.subject, mine.body);
  companions.forEach((c) => {
    const m = mailCompanion_(cfg, entry, c.name, slotById);
    sendMail_(cfg, c.email, m.subject, m.body);
  });

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
    for (const r of recipients) {
      const m = mailResult_(cfg, e, r.name, w, slotById);
      sendMail_(cfg, r.email, m.subject, m.body);
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

/* ======================= Email templates (plain text) ======================= */

const LINE_ = '━━━━━━━━━━━━━━━━━━━━';
const DASH_ = '－－－－－－－－－－－－－－－－－－－－';
const THIN_ = '────────────────────';
const WD_ = ['月', '火', '水', '木', '金', '土', '日']; // Utilities 'u': 1 = Monday

const fw_ = (s) => String(s).replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));

function header_(cfg) {
  return `${DASH_}\n＜＜　${cfg.siteName}　INFORMATION　＞＞\n${DASH_}`;
}

function footer_(cfg) {
  return `${DASH_}\n${cfg.siteName}\n${SITE_URL}\n${DASH_}`;
}

const NOTE_URL_ = '※メール文章中のURLをタップしてもページをご覧いただけない場合は、URLをコピーしてブラウザのアドレス欄に貼り付けてください。';
const NOTE_NOREPLY_ = '※このメールアドレスは配信専用となっております。本メールに返信していただきましても、ご質問・ご依頼などにはお答えできませんので、あらかじめご了承ください。';
const NOTE_CONTACT_ = '※お問合せは幹事まで直接ご連絡ください。';

function slotWhen_(cfg, s) {
  const [, m, d] = s.date.split('-').map(Number);
  const wd = WD_[Number(Utilities.formatDate(new Date(s.date + 'T12:00:00Z'), 'UTC', 'u')) - 1];
  return `${m}/${d}(${wd}) ${s.start}〜${s.end}`;
}

function choiceBlock_(cfg, slotId, rank, size, slotById, result) {
  const s = slotById[slotId];
  return `＜第${fw_(rank)}希望＞\n` +
    (result ? `　抽選結果　　：　${result}\n` : '') +
    `　利用日時　　：　${slotWhen_(cfg, s)}\n` +
    `　場所・人数　：　${s.room} ×${size}名`;
}

function summary_(cfg, e) {
  const size = 1 + e.companions.length;
  return `受付番号　　：　${e.id}\n` +
    `イベント名　：　${cfg.eventTitle}\n` +
    `会場名　　　：　${cfg.venue}\n` +
    (size > 1 ? `申込み人数　：　${size}名（申込者：${e.name}様／同行者：${e.companions.map((c) => c + '様').join('、')}）\n` : '');
}

function drawLine_(cfg) {
  return `［抽選結果発表　：　${fmtDT_(cfg, cfg.drawAt)}］`;
}

/** 申込み完了 (applicant) */
function mailApplicant_(cfg, e, slotById, replaced) {
  const size = 1 + e.companions.length;
  const subject = `【${cfg.siteName}】《必ずご確認ください》申込み完了・抽選結果発表のご案内`;
  const body = `${header_(cfg)}
＜${cfg.eventTitle}＞抽選受付
${cfg.siteName} をご利用いただきまして、誠にありがとうございます。
${e.name}様の抽選申込みを下記の内容で受付けました。
お申込み多数の場合は抽選とさせていただきます。${replaced ? '\n※同じメールアドレスでの以前のお申込みは無効になりました。' : ''}

${drawLine_(cfg)}

抽選結果は発表時刻以降、このメールアドレス宛にお送りします。
下記のページでもご確認いただけます。
${SITE_URL}?id=${e.id}#result

${LINE_}
${summary_(cfg, e)}${e.choices.map((c, i) => choiceBlock_(cfg, c, i + 1, size, slotById)).join('\n')}
${LINE_}
＜注意事項＞
※お申込み内容は、受付期間中（${fmtDT_(cfg, cfg.entryClose)}まで）のみ変更可能です。同じメールアドレスで再度お申込みいただくと、最新のお申込みのみが有効になります。受付期間終了後は、申込み内容の変更や取消しはできません。
※当選した場合、ご利用時間は厳守してください。
${NOTE_URL_}
${NOTE_NOREPLY_}
${NOTE_CONTACT_}
${footer_(cfg)}`;
  return { subject, body };
}

/** 申込み完了 (companion) */
function mailCompanion_(cfg, e, toName, slotById) {
  const size = 1 + e.companions.length;
  const subject = `【${cfg.siteName}】申込み完了のご案内（同行者の方へ）`;
  const body = `${THIN_}
＜　申込み完了・抽選結果発表のご案内　＞
${THIN_}
＜${cfg.eventTitle}＞抽選受付
${cfg.siteName} をご利用いただきまして、誠にありがとうございます。
${toName}様は、${e.name}様のお申込みに同行者として登録されました。
お申込みを下記の内容にて承りましたのでご確認ください。

${drawLine_(cfg)}

${LINE_}
申込内容
${summary_(cfg, e)}${e.choices.map((c, i) => choiceBlock_(cfg, c, i + 1, size, slotById)).join('\n')}

申込者情報
氏名　　　　　：${e.name}様
${LINE_}
＜注意事項＞
※お申込みいただいた内容の変更は申込者様のみ行えます。
※抽選結果は、同行者様にもこのメールアドレス宛にお送りします。グループ全員で同じ1枠を利用し、全員が当選または落選となります。
※同行者として登録された方は、ご自身で別にお申込みいただくことはできません。
※抽選結果は発表時刻以降、下記のページでもご確認いただけます。
${SITE_URL}?id=${e.id}#result
${NOTE_URL_}
${NOTE_NOREPLY_}
${NOTE_CONTACT_}
${footer_(cfg)}`;
  return { subject, body };
}

/** 当選 / 落選 — sent to the applicant and to each companion */
function mailResult_(cfg, e, toName, w, slotById) {
  const size = 1 + e.companions.length;
  const isApplicant = toName === e.name;
  const whose = isApplicant ? `${toName}様にお申込みいただいた` : `${toName}様が同行者として登録されたお申込み（申込者：${e.name}様）の`;
  if (w) {
    const s = slotById[w.slotId];
    const members = [e.name, ...e.companions].map((x) => x + '様').join('、');
    return {
      subject: `【${cfg.siteName}】当選のご案内`,
      body: `${header_(cfg)}
${cfg.siteName} をご利用いただきまして、誠にありがとうございます。
${whose}枠を下記の内容にてご用意いたしました。
内容をご確認の上、時間厳守でご利用ください。

${LINE_}
${summary_(cfg, e)}${choiceBlock_(cfg, w.slotId, w.rank, size, slotById, '当選')}
${LINE_}
【重要】ご利用時間のご案内
　ご利用時間　：　${slotWhen_(cfg, s)}（${minutes_(s)}分）
　場所　　　　：　${s.room}
　ご利用者　　：　${members}（計${size}名）
　※次の方の枠に食い込まないよう、終了時刻までにご退室ください。
${LINE_}
＜注意事項＞
※お申込みいただいた内容の変更や取消しはできません。枠の交換・譲渡は、双方の合意の上で幹事にご連絡ください。
※抽選結果は下記のページでもご確認いただけます。
${SITE_URL}?id=${e.id}#result
${NOTE_URL_}
${NOTE_NOREPLY_}
${NOTE_CONTACT_}
${footer_(cfg)}`,
    };
  }
  return {
    subject: `【${cfg.siteName}】抽選結果のご案内`,
    body: `${header_(cfg)}
${cfg.siteName} をご利用いただきまして、誠にありがとうございます。
${isApplicant ? `${toName}様の下記申込み` : `${toName}様が同行者として登録された下記申込み（申込者：${e.name}様）`}については、抽選の結果、枠を
ご用意することができませんでした。

${summary_(cfg, e)}${LINE_}
空き枠については幹事にご相談ください。
これからも ${cfg.siteName} をよろしくお願いします。
${NOTE_NOREPLY_}
${NOTE_CONTACT_}
${footer_(cfg)}`,
  };
}

function minutes_(s) {
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  return ((toMin(s.end) - toMin(s.start)) + 1440) % 1440;
}

/** Run from the editor to see all four emails in the log (nothing is sent). */
function previewEmails() {
  const cfg = config_();
  const slots = expandSlots(cfg.schedule);
  const slotById = Object.fromEntries(slots.map((s) => [s.id, s]));
  const e = { id: 'SL-PREVIEW', name: 'たなか', companions: ['すずき'], choices: slots.slice(0, 3).map((s) => s.id) };
  const mails = [
    mailApplicant_(cfg, e, slotById, false),
    mailCompanion_(cfg, e, 'すずき', slotById),
    mailResult_(cfg, e, 'たなか', { slotId: e.choices[1], rank: 2 }, slotById),
    mailResult_(cfg, e, 'すずき', null, slotById),
  ];
  mails.forEach((m) => console.log(`件名：${m.subject}\n\n${m.body}\n`));
}

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
  const d = new Date(iso);
  const wd = WD_[Number(Utilities.formatDate(d, cfg.timeZone, 'u')) - 1];
  return `${Utilities.formatDate(d, cfg.timeZone, 'yyyy/MM/dd')}(${wd})　${Utilities.formatDate(d, cfg.timeZone, 'HH:mm')}`;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
