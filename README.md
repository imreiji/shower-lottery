# SHOWER LOT — シャワー利用枠 抽選サイト

A static (GitHub Pages) front end and a free Google Apps Script backend. Applicants pick up to 3 slots, enter their email, and can add 同行者 (companions) for a 連番 (group) application. They get a confirmation email right away and a 当選/落選 email at draw time.

```
index.html / style.css / app.js   ← GitHub Pages site
config.json                       ← event, schedule, dates (single source of truth)
entries.json                      ← demo data, used only while apiUrl is empty
backend/Code.gs                   ← Apps Script: stores entries, sends emails
```

## 1. Publish the site (GitHub Pages)

1. Create a repo (e.g. `shower-lottery`) and push these files.
2. Go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, and select `main` / `(root)`.
3. The site appears at `https://<you>.github.io/shower-lottery/`.

It runs in **demo mode** until step 2 is done: it reads `entries.json`, and no applications are saved and no emails are sent.

## 2. Email features (Google Apps Script)

1. Open <https://script.google.com> and create a **New project**. Paste the contents of `backend/Code.gs` into it.
2. Set `SITE_URL` at the top to your Pages URL (with the trailing `/`).
3. Click **Deploy → New deployment → Web app** and set:
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Approve the permissions (Sheets, Gmail send, external fetch, triggers).
5. Copy the Web app URL (`https://script.google.com/macros/s/…/exec`) into `apiUrl` in `config.json`, then push.
6. In the editor, choose **`setupTrigger`** and click **Run**. This creates the private Google Sheet (`SHOWER LOT entries` in your Drive) and schedules the result emails for `drawAt`.

To see the four emails (applicant, 同行者, 当選, 落選) without sending anything, run **`previewEmails`** and open the log.

If you change `drawAt` later, run `setupTrigger` again. If you change Code.gs, open **Deploy → Manage deployments**, edit the deployment, and pick **New version**; the URL stays the same.

### What happens
| When | What |
|---|---|
| Apply | The entry is saved to the Sheet and a confirmation email is sent with the 受付番号 and chosen slots. Re-applying with the same email replaces the old entry. Gmail addresses count as one person however they're written (`a.b+x@gmail.com` = `ab@gmail.com`). |
| `drawAt` | `sendResults` runs: the same draw as the website, then a 当選 or 落選 email to each applicant. Each person is emailed only once; rerunning is safe. |
| Anytime | The site shows the public list (name, slots, 受付番号). **Emails are never exposed.** |

**Gmail quota:** about 100 emails/day on a personal account (1,500 on Workspace). Each applicant uses 2 (confirmation + result). If the quota runs out, run `sendResults` again the next day and it continues from where it stopped.

## 同行者 (group applications)

- The 代表者 (applicant) can add up to `maxCompanions` companions (default 3, so groups of up to 4). Each needs a name and email.
- **The whole group shares the one slot it wins.** Slot `capacity` counts groups, not people: `capacity: 1` means one group (1–4 people) per slot.
- The group is drawn as one entry and wins or loses together. Everyone in it gets the confirmation and result emails.
- An email address can be in only one active entry. Gmail dot and `+tag` variants count as the same address, and older rows saved before this rule are collapsed to the person's latest entry when the list is read (the Sheet isn't changed). Someone already listed as a companion can't apply separately (the backend rejects it).
- The public results show the group as 「代表者（同行：A・B）」.

## Config (`config.json`)

- `entryOpen` / `entryClose` / `drawAt`: ISO times with an offset (`+09:00`).
- `schedule`: blocks expanded into slots, e.g. `{ "date","room","from","to","every": 15,"capacity": 1 }`. `capacity` is the number of groups per slot. `to` may be `24:00`; for slots after midnight add a second block dated the next day starting at `00:00`.
- `maxChoices`: number of 希望 per applicant.
- `maxCompanions`: max 同行者 per entry (`0` turns companions off).
- `seed`: optional extra randomness. Announce it before `drawAt` if you want. When empty, `drawAt` is used.
- `showDemand`: shows the 第1希望 count and 倍率 per slot before the draw.
- `publicResults`: shows the full winner table after the draw.

## The draw

The draw is deterministic and verifiable. Entries are shuffled with a PRNG seeded by `seed|sorted entry IDs`, and slots are filled 第1希望 → 第2希望 → 第3希望. The browser and Apps Script run identical code (`expandSlots`, `cleanEntries`, `runDraw`, and so on), so the emails always match what the site shows. If you edit one copy, edit the other too.

## Previewing phases locally

```
python3 -m http.server
open "http://localhost:8000/?now=2026-11-13T12:00:00%2B09:00"   # 受付中
open "http://localhost:8000/?now=2026-11-13T19:45:00%2B09:00"   # 受付終了（抽選待ち）
open "http://localhost:8000/?now=2026-11-13T21:00:00%2B09:00"   # 結果発表
```
Add `&id=SL-XXXXXX` to prefill the result lookup.
