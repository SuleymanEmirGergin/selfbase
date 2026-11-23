# Task 25bc report: Studio English-first, Turkish second, and the Task 25 Minors

Base f6d477d. Commits f6d477d..HEAD (10 code and docs commits, plus this report). Not pushed. Every change is under `studio/` or `docs/screens/`, except this report, which the controller asked for at the worktree root. No new dependency. No IP, hostname or secret was added. A scan of `studio/src` and `studio/e2e` finds no IPv4 address and no product name other than "supabase-js", which the brief allows.

| Commit | What |
|---|---|
| 0ad91c8 | feat: Studio is English-first with Turkish as the second locale. Most of the label and number Minors are fixed inline here. |
| 4a566c4 | fix: a second theme switch before the first lands toggles back. The fallback reveal uses tokens. |
| 2685e89 | fix: global shortcuts leave open sheets, the confirm dialog and the SQL editor alone |
| 7f4d458 | fix: signing out inside the undo window sends the pending delete first |
| 3bca9e2 | fix: the undo drain bar follows the count, so a pause never ends it early |
| de8e9bc | fix: the undo toast sits above the table pager |
| 9c15ad3 | fix: the focus ring keeps an outline for Windows forced colors |
| 81443c9 | fix: the paused sign-in art holds still with no torch, and sign-in stacks below 900 px (plus the hidden-tab spec) |
| 3aa29b1 | fix: the copied tick uses Bold at 12 px |
| 88f9f9f | docs: refreshed screenshots: English dark and light, Turkish sign-in and project home, sign-in at 800 px |

## Changes by area

- **i18n core:**
  - New: `src/i18n/en.ts` (source of truth, 490 keys), `src/i18n/tr.ts`, `src/i18n/index.ts`, `src/lib/locale.ts` and `src/lib/format.ts`.
  - `index.html` and `main.tsx` set `<html lang>` before the first paint, the same way the theme is applied.
- **Every screen goes through `t()`:**
  - Shell and frame: `App.tsx`, `shell.tsx`, `ui.tsx`, `auth.tsx`, `SignInPanel.tsx`, `Grid.tsx`, `api.ts`.
  - Organization area: `org/*`.
  - Project area: `project/index.tsx`, `parts.tsx`, `Home`, `Tables`, `Sql`, `Policies`, `Users`, `Files`, `Settings`, `Logs`, `Sites`.
  - Hard-coded Turkish copy is gone from components.
- **Locale switch:**
  - A language select sits in the sidebar foot, labelled "Language" / "Dil".
  - The Ctrl+K palette has a command for the other language.
  - The choice is stored in `localStorage['studio-locale']`.
  - A first visit is English whatever the browser language is. This is deliberate: English-first.
- **Formatting:**
  - Numbers, percentages, sizes, dates and relative times use Intl with `en-US` or `tr-TR`.
  - Upper and lower case use the locale (`upper()` / `lower()`), so Turkish initials keep İ/ı.
- **Undo, shortcuts, theme and polish:** see the Minors table below.

## i18n structure

- `en.ts` is a flat `as const` object with dotted keys (`'tables.range'`). `Key = keyof typeof en`.
- `tr.ts` is typed `Record<Key, string>`, so a missing or extra Turkish key fails `tsc`.
- A lib spec also checks the following:
  - Both catalogues have the same keys and the same `{param}` names.
  - No Turkish string carries an English `one|other` plural.
- **Messages:**
  - `{name}` parameters, filled by `fill()` in `lib/locale.ts`. Numbers are formatted for the locale.
  - English plurals are written `'{n} project|{n} projects'`. Turkish has no plural after a number, so it has one form.
- **`t(key, params)`** returns a string. **`rich(key, nodes, params)`** returns a Fragment with React nodes in placeholders, such as `<code>`, `<kbd>` or a link. No HTML is ever parsed from strings.
- **`has(key)`** lets run-time ids (job steps, service status) fall back to the raw id when the catalogue has no entry.
- **The locale store** is a module variable with listeners. `App` subscribes through `useLocale()` (`useSyncExternalStore`), so a switch re-renders the whole tree. Storage errors (private mode) fall back to English and never throw.
- **No i18n library was added.** The whole mechanism is about 120 lines.

## Every Minor

### task-25-review.md

| Minor | Status |
|---|---|
| Undo, in-app navigation | Already fine: the toast host is global, so the DELETE is sent. |
| Undo, tab close or reload | **Not fixed, wording only.** The toast now says "Deleting row…" / "Satır siliniyor…", not "deleted", so it no longer claims a delete that never happens. Committing on `pagehide` would need a keepalive request carrying the session token outside `api.ts`. I judged that riskier than the gap. |
| Undo, sign-out inside the window | **Fixed** (7f4d458). `flush()` in `lib/undo.ts` and `flushUndo()` in `ui.tsx`. `App.signOut` sends the pending delete before logout. Spec: "signing out inside the undo window sends the delete first…" (failed before the fix, passes now). |
| Undo, table left and reopened inside the window | **Fixed** (0ad91c8). A module-level pending-delete store in `Tables.tsx` keeps the row hidden across a remount until the delete lands or is undone. Spec: "a row deleted, then the table left and opened again…". It is committed in 7f4d458, after the code, so it passed on its first run. |
| Global shortcuts ignore context | **Fixed** (2685e89). Shortcuts are skipped when `e.defaultPrevented` or a `dialog[open]` / `.drawer` is open. Ctrl+Shift+L is skipped inside `.cm-editor`, because CodeMirror does not preventDefault on an empty selection. Spec: "global shortcuts leave an open sheet and the editor alone". |
| Theme double press; hex colours in `theme.ts` | **Fixed** (4a566c4). A pending target makes the second press toggle back. The overlay takes its colour from `data-theme` and `var(--panel)`, not from hex. Spec: "two quick theme switches land back on the first theme". Both keydowns are dispatched in one task: sequential presses passed even without the fix. |
| Focus ring in forced colors | **Fixed** (9c15ad3). The ring rule uses `outline: 2px solid transparent; outline-offset: 2px`. Spec: "the keyboard focus ring survives Windows forced colors" (failed with `none 3px`, passes now). |
| "Forgot password" between the fields in tab order | **Fixed** (0ad91c8). It now follows the password field. The focus-order spec reads labels: Password, Show characters, Forgot password, Sign in. |
| Invitation footer on the invite page and "Not found" | **Fixed** (0ad91c8). It shows on sign-in only. |
| Dead Assistant pill in SQL | **Fixed** (0ad91c8). The `.ask` pill and its CSS are removed. |
| "Memory" on the project card is the limit | **Fixed**: "Memory limit" / "Bellek sınırı". |
| MiB/1024 labelled GB | **Fixed**: GiB. |
| Job steps show the raw id in bold | **Fixed**: the step in words, with the raw id small and mono beside it. |
| "Süzgeç" vs "Filtrele" | **No longer applies.** Both places use one key: Filter / Filtrele. |
| tr-TR numbers inconsistent | **Fixed**: every number goes through `nf()`. Specs and screenshot selectors use the formatted form (`2.336 MiB`, `412 / 1.024 MiB`, `2,336 MiB` in English). |
| Initials with `toUpperCase()` | **Fixed**: `upper()` uses the current locale. |
| `<li role="none">` new-project card; label mismatch | **Fixed**: a plain `<li>` whose accessible name equals the visible text. The card-count spec is 4. |
| Bold icons at 10, 13 and 14 px | **Fixed**: every Bold icon is 12 px now. The last ones were the SQL sparkle (0ad91c8) and the copied tick (3aa29b1). |
| Project status dropped from the sidebar | **Fixed**: a status dot in the project switcher, with a title and screen-reader text. |
| 9c3e44f fails a spec until d755fc7 | **No longer applies.** Those commits are already in the base (f6d477d), so they cannot be reordered from this branch. |
| Undo toast covers the pager | **Fixed** (de8e9bc). `body:has(.pager) .toasts { bottom: 76px }`. Spec: "the undo toast sits above the table pager" (failed before, passes now). |

### task-25-rereview-1.md (Minors 4, 5, 8, 9, 10)

| Minor | Status |
|---|---|
| 4: two columns again from 761 to 900 px, with a cramped form | **Fixed** (81443c9). Sign-in stacks below 900 px, and `NARROW` in `SignInPanel.tsx` follows, so there is no video there either. Spec: "at tablet width (800 px) sign-in stacks…" (failed before, passes now). Screenshot: `sign-in-800-dark.png`. |
| 5: after a pause the drain bar could hit zero a second early | **Fixed** (3bca9e2). The bar is driven by the count, not by a CSS clock. While held it shows `left/5`. While running it moves toward `(left-1)/5` with a 1 s linear transition. Spec: "the undo drain bar follows the count…" (failed before, passes now). |
| 8: two undo toasts at once | **Not changed, no spec.** It is reachable: delete a second row inside the first window. When the second toast closes after the first is gone, focus falls to `#content`. That is safe and keeps keyboard users in the page, so I left it. |
| 9: focus-order spec keyed on the input type; fixed 5.6 s waits | **Fixed**. The focus spec reads labels (aria-label or label text). The undo specs use `page.clock` (`install` / `runFor`) instead of real waits. |
| 10: "siz" outside the sign-in pages; invitation footer | **Fixed**. The whole Turkish catalogue uses "sen". The footer: see above. |

### task-25-rereview-2.md (all five)

| Minor | Status |
|---|---|
| 1: torch glow on a still panel | **Fixed** (81443c9). `.a-panel.still .torch { display: none }`. Asserted in "the video toggle is reachable by keyboard…" (failed before, passes now). |
| 2: hidden-tab ticker stop has no spec | **Fixed** (81443c9). Spec: "a hidden tab stops the sample pipeline; showing it again starts it". It passes. I checked that it fails with the `!visible` guard removed, then restored the guard. |
| 3: toggle icon `fill` at 14 px | **Fixed** (0ad91c8). It is `bold` at 12 px. |
| 4: art jumps when paused | **Fixed** (81443c9). `animation-play-state: paused` instead of `animation: none`, so the drift holds where it is. Asserted in the toggle spec. |
| 5: reduced motion switched on while the toggle has focus | **Left as is**, as the reviewer suggested. Focus falls to `body` in that rare case. |

## Tests

All from `studio/`:

- `npx tsc --noEmit -p .`: no errors.
- `npm run build`: built. Vite warns that the main chunk is 530 kB, over its 500 kB hint. I did not check whether the base build already warned.
- `STUDIO_E2E_PORT=5293 npx playwright test`: **69 passed, 60 skipped, 0 failed** (3.4 min).
  - The skips are the live-stack specs and the opt-in screenshot specs.
  - The run includes `lib.spec.ts` (7/7) and the new `i18n.spec.ts` (3/3).
  - One `[vite] console.error` "Failed to fetch dynamically imported module" in the log is the chunk-failure spec doing its job.
- `STUDIO_SHOTS=1 STUDIO_E2E_PORT=5293 npx playwright test e2e/screens.spec.ts`: **59 passed**.
  - Written to `docs/screens/studio-v3/`: English dark and light for every screen and state.
  - Turkish: `sign-in-tr-{dark,light}` and `project-home-tr-{dark,light}`.
  - `sign-in-800-dark`, `sign-in-phone-dark` and `sign-in-video-dark`.
- Baseline before the task: 54 passed, 55 skipped.
- New specs:
  - `i18n.spec.ts`: English first visit; switch, reload and numbers; palette switch.
  - lib: locale, `fill()`, catalogue parity, undo `flush`.
  - ux: double theme switch, shortcuts with a sheet or the editor, remount stays hidden, sign-out flush, drain bar, toast above the pager, forced-colors ring, 800 px stack, hidden tab.
- Language of the existing specs:
  - shell, project and ux keep their Turkish selectors and run in Turkish through `beforeEach`. This exercises the second locale broadly.
  - The screenshot spec runs in English.

## turkce-dogal pass on `tr.ts`

The skill was run on the Turkish catalogue before it was committed. Register: UI micro copy, "sen" voice.

- `lint.py --count` went from 13 hits (11 semicolons and 2 en dashes, 0.65 per 100 words) to 0.
- **Ranges:** `tables.range` and `users.range` use a hyphen instead of an en dash.
- **Semicolons:** sentences split or rebuilt in these keys:
  - `invite.otherAccount`, `reset.lead`, `import.oneOnly` ("İkisinden yalnızca birini ver: …"), `import.saved`, `import.keysHint`
  - `members.inviteLink`, `newProject.creating` ("Hazır olunca proje sayfası açılacak."), `project.chunkFailed`, `project.pauseMsg`, `paused.whenResumed`
  - `tables.viewOnly`, `rls.disableMsg` ("RLS’i kapatırsan…"), `rls.noRls`, `files.cap`, `backups.exportHint`, `logs.fallback`, `sites.text`
- **Kept on purpose:**
  - Loanwords common in the field: policy, bucket, RLS, ref, env.
  - "Banla", the "sn" abbreviation, and colon labels.
  - Placeholders and keys are untouched.

## Concerns

1. **0ad91c8 is large.** It moves every screen to `t()` and updates the specs that match the copy in the same commit. It is green only with those spec updates, so it bisects cleanly but cannot be split further without red commits.
2. **Sign-out flush is fire-and-forget.** The DELETE is started before logout, but logout does not wait for it. In practice the request leaves first and carries the still-valid token; the spec checks the order of the requests. A server that handles logout before the DELETE could still reject it.
3. **First second of the drain bar.** If the toast is not held when it appears, the first second does not animate: the bar starts at 4/5, not at 5/5. A keyboard delete focuses Undo, so it starts held. A pointer delete in the sheet moves focus to the toast too, so I did not see it in practice.
4. **No video from 761 to 900 px.** The breakpoint move to 900 px means landscape tablets in that range now get the still only. The stacked 300 px band makes the video add little there.
5. **Locale detection.** The browser language is not read: a first visit is always English, as the brief says. Turkish users switch once, and the choice persists.

## Fix round 1

This round answers `task-25bc-review.md`: 1 Important and 8 Minor findings. The commits are 017eeb9..82a8377, plus this report update. Each code fix has a spec. Every spec except the KiB one in `lib.spec` was run and seen failing before its fix landed.

| Finding | Commit | What changed | Spec |
|---|---|---|---|
| Important: role options built at module load | e256cbc | `roleOptions()` is a function called at render. A grep for other module-level `t()` and catalogue reads found nothing else. The remaining hits are functions or default parameters, which run per call. | i18n: "a switch on Members also changes the role options in the invite form" |
| 1: sign-out does not wait for the DELETE | 9647283 | `commit` returns the delete's promise. `flushUndo()` returns `Promise.allSettled` over the pending windows. `signOut` awaits `Promise.race([flushUndo(), 3 s])` before `POST /logout`. | ux: "sign-out waits for the server to answer the pending delete…" holds the DELETE response for 1.5 s and expects `delete, deleted, logout` (the server answered first). "…waits at most 3 seconds" holds it for 20 s: no logout before 3 s on the page clock, logout after. |
| 2: raw English server errors | 40e3dcc | `errMsg` maps control's codes to `apiErr.<code>` in both catalogues (19 codes). An unknown code gives `apiErr.other` with the code in a `<code>` span (`errText()` in ErrorBox, error toasts and the auth and job error boxes). Four codes keep the server's words because the message is the detail: `validation_failed`, `query_failed`, `invalid_env_file` and `invalid_secrets`. Only a snake_case `error` counts as a code, because core's admin API puts sentences there. | i18n: "server errors read in the chosen language…": a known code, an unknown code in mono, and a detail code. |
| 3: both catalogues in the main chunk | 2c17cef | `tr.ts` loads with `import()`. `main.tsx` awaits the stored locale's catalogue before `createRoot`, so there is no flash. `setLocale` loads before it switches. `tr: Messages` still makes `tsc` enforce parity. | i18n: "an English visit does not download the Turkish catalogue; switching loads it" |
| 4: KB label on 1024 units; raw SQL duration | 04167b5 | `fmtSize` prints B, KiB, MiB, GiB or TiB. A value that would round to 1024 moves up a unit (1,048,575 B → "1.0 MiB"). The SQL duration goes through `nf`. | lib: fmtSize cases. i18n: "on the SQL screen a switch…" (1,234 ms → 1.234 ms). |
| 5: SQL editor label fixed at mount | 04167b5 | The label is set on `contentDOM` in an effect keyed on the locale, not through `contentAttributes`. `@codemirror/state` is not a direct dependency, so I avoided a Compartment. | Same SQL spec: the textbox name changes from "SQL query" to "SQL sorgusu". |
| 6: "Wave 6" in user copy | 8f3c73f | The chip is "COMING SOON" / "YAKINDA". The text starts "Coming soon: …" / "Yakında …". | Screenshots `project-sites-*` |
| 7: Turkish calques | 8f3c73f | Reworked, then the whole `tr.ts` went through turkce-dogal again (see below). | Existing shell spec selectors updated for the two aria-labels |
| 8: no language switch when signed out | 6918adb | `LangSelect` is exported from `shell.tsx` and shown in the sign-in, invitation and reset footer, next to the host. | i18n: "the signed-out screens have their own language switch" |

### turkce-dogal, second pass on the whole `tr.ts`

- Register: UI micro copy, "sen", localisation mode.
- `lint.py --count` over all 510 values (1,552 words): 0 hits before and after. The pass caught no mechanical issues, only calques.
- Reviewer's strings:
  - `tokens.meta`: "Belirteçle yönetim API’sine ({v1}) ve CLI’ye senin rollerinle erişilir."
  - `files.downloadOf` / `files.deleteOf`: "{name} dosyasını indir" / "{name} dosyasını sil"
  - `rls.disableBtn`: "RLS’i kapat"
  - `rls.noRls`: "Bu bir {kind}. RLS açılamaz, policy de eklenemez."
  - `tables.blankDefault`: "Boş bırakırsan varsayılan değer kullanılır." In English, "Leave empty to use the default".
  - `sites.chip` / `sites.text`: see Minor 6.
- Found in the second pass:

  | Key | Before | After | Why |
  |---|---|---|---|
  | `common.created` | Oluşturma | Oluşturulma | Column header for a date |
  | `auth.signInLead` | Studio’ya devam etmek için oturum aç | Studio’yu kullanmak için giriş yap | Calque of "continue to" |
  | `members.roleOf` | Rol: {email} | {email} için rol | Colon label read aloud |
  | `members.removeOf` | Çıkar: {email} | {email} üyesini çıkar | Colon label read aloud |
  | `capacity.certNote` | Her yeni adres bir sertifika ister | Her yeni adres için bir sertifika gerekir | Calque of "needs" |
  | `apiErr.admin_forbidden` | … çağrısını … | Proje bu yönetim isteğini reddetti. | "çağrı" is a calque of "call" |
  | `apiErr.payload_too_large` | Gönderilemeyecek kadar büyük. | Gönderilen veri çok büyük. | It had no subject |
  | `apiErr.no_template_version` | Projenin yükseltilecek bir şablon sürümü yok. | Projenin şablon sürümü bilinmiyor, bu yüzden güncellenemiyor. | Says what is wrong |

- Kept on purpose:
  - `common.deleteOf` "Sil: {name}" and `domains.removeOf` "Kaldır: {host}". They read well enough as action labels.
  - `users.markedConfirmed` keeps "olarak", which marks a real status here.

### Commands and output (from `studio/`)

```
$ npx tsc --noEmit -p .
TypeScript: No errors found

$ npm run build
dist/assets/index-BncPhUZz.css   55.67 kB │ gzip:  12.27 kB
dist/assets/tr-CXU4Xh41.js       21.59 kB │ gzip:   7.82 kB
dist/assets/Sql-C8LDYWuF.js     430.93 kB │ gzip: 140.06 kB
dist/assets/index-CaWKf4FO.js   512.41 kB │ gzip: 142.34 kB
✓ built
(Vite still warns: the main chunk is over 500 kB)

$ STUDIO_E2E_PORT=5293 npx playwright test
136 tests: 76 passed, 60 skipped, 0 failed (3.9 min)

$ STUDIO_SHOTS=1 STUDIO_E2E_PORT=5293 npx playwright test e2e/screens.spec.ts
59 passed (1.9 min)
```

- Main chunk: 530.3 kB before this round, 512.4 kB now (142.3 kB gzip). Turkish is a separate 21.6 kB chunk.
- The chunk is still over Vite's 500 kB hint. The English catalogue and the 19 new error strings stay in the main chunk. Getting under 500 kB would need a split elsewhere, which this round did not attempt.
- 18 screenshots changed (commit 82a8377):
  - invite, reset and sign-in in every variant: the language switch.
  - `project-sites-*`: "Coming soon".
  - `project-tables-*`, `project-users-light`, `org-audit-light` and `org-import-dark`: rendering noise from the run, with no visible change I could see.

### Concerns after fix round 1

1. **Bundle size.** The main chunk is still 12 kB over the hint (see above).
2. **Turkish catalogue fails to load.** If the chunk does not load at start-up, the app still renders, falling back to English strings. `<html lang>` and number formatting would still be Turkish in that state.
3. **The 3 s cap on sign-out.** A DELETE slower than 3 s is still racing logout when it ends. That is the bound the coordinator asked for.
4. **A delete committed by its timer just before sign-out** is not awaited: its toast has already closed, so it is no longer in `flushUndo`. Only windows still open at sign-out are waited for.
5. **Lost detail in mapped errors.** Mapped codes drop the server's specific English sentence. One example: `weak_password` loses the minimum length, and the invite form does not show the minimum elsewhere. Detail codes keep their messages.

## Fix round 2

This round answers `task-25bc-rereview-1.md`: 1 Important and 5 Minors, handled as the coordinator directed. The commits are eaa79d1..539a298, plus this report update. Each code fix has a spec, and each spec was seen failing before its fix.

| Finding | Commit | What changed | Spec |
|---|---|---|---|
| Important: the generic line replaced user-written refusals | d7bee04 | A code gets catalogue copy only when nothing is lost (see below). Every other code shows the server's own message with its code beside it in mono (`… (`hostname_taken`)`). `query_failed` keeps the bare database error. There is no generic line any more; `apiErr.other` is removed. The `org/projects.tsx` comment is corrected. Control is unchanged. | i18n "server errors: …" covers: `project_busy` gets copy; `hostname_taken` and an unknown code keep the server's words with the code; a `forbidden` with a non-standard message keeps the server's words; `weak_password` carries the minimum. "a full server refuses a new project…" checks that the Turkish `insufficient_memory` copy shows 412 and 1.024 MiB. "the reset screen shows the auth server rate limit in its own words" checks that `over_email_send_rate_limit` keeps the server's message and code. |
| M1: two auth error boxes without `errText` | d7bee04 | The accept-while-signed-in and reset-request boxes use `errText`, and so does the "schemas failed" line in Tables. | The reset rate-limit spec above (it checks the `<code>`). |
| M2: Turkish chunk fails or stalls | 08fd2b7 | `startLocale()` races the stored catalogue against 2 s. On failure or timeout the session is English throughout: `current = 'en'` and `lang = 'en'`, so `nf`, `fmtDate`, `upper` and `lower` follow. The choice is not saved, so the next visit tries again. `LangSelect` and the palette command go through `pickLocale`, which catches the failure and toasts "Could not load that language. Try again." / "Bu dil yüklenemedi. Yeniden dene." | i18n has three specs. "…fails to load starts the session wholly in English" aborts the chunk and checks the English heading, `lang="en"`, "2,336 MiB" and that `tr` is still stored. "…stalls holds the first paint about 2 seconds" uses a request that is never answered and expects the English page within 4 s. "picking Türkçe when its catalogue cannot load…" covers the select and the palette, which both toast and stay English. |
| M3 spec on dev and build | 08fd2b7 | `TR_CHUNK` matches the pathname: `/src/i18n/tr.ts` on the dev server, `/assets/tr-<hash>.js` in the build. `STUDIO_E2E_PREVIEW=1` runs the specs against `vite build && vite preview`. | `STUDIO_E2E_PREVIEW=1 STUDIO_E2E_PORT=5294 npx playwright test e2e/i18n.spec.ts`: 13 passed. The dev server run also passes. |
| M3 (rereview): second sign-out click; a delete its timer already sent | f00f5e8 | `ui.tsx` keeps an `inflight` set of committed requests, whether committed by the timer or by a flush, and removes each one when it settles. `flushUndo()` flushes the open windows, then awaits `inflight`. `signOut` ignores re-entry while it waits (`leaving` ref), so logout is sent once. | ux "a second sign-out click while the delete is out still waits, and logs out once": `delete, deleted, logout` with a single logout. ux "a delete its own timer sent just before sign-out is waited for too". |
| M4: `weak_password` minimum | d7bee04 | Control's message is matched (`Password should be at least (?<n>\d+) characters.`), so the copy "The password needs at least {n} characters." / "Şifre en az {n} karakter olmalı." keeps the number. `weak_passphrase` works the same way. Core's reset-path message does not match, so it is shown as sent with its code and still states the minimum. Control was not changed, as instructed. | Part of the i18n "server errors" spec |
| M5: copy leftovers | 7f44ed1 | `tokens.meta` (tr) reads "…CLI’ye kendi rollerinle erişirsin." and `tables.blankDefault` (en) now ends with a period. | Copy only |

### Which codes get catalogue copy

- **Exact message**, the one control sends:
  - Session and access: `forbidden` ("Forbidden"), `admin_forbidden`, `unauthorized` ("Unauthorized"), `not_found` ("not found").
  - Project state: `project_unreachable`, `project_busy`, `no_template_version`.
  - Organization: `last_owner`, `ambiguous_membership`, `invalid_invitation`, `account_exists`.
  - Paths and backups: `invalid_path`, `invalid_backup_dir` (the "not one of this organization's backups" message only).
- **Message with a number carried over:** `weak_password {n}` and `weak_passphrase {n}`.
- **Numbers from `details`**, which control already sends:
  - `insufficient_memory {free, needed}` from `freeMb` / `neededMb`.
  - `new_host_cap {cap, date}` from `cap` / `retryAfter`. The date is shown in the viewer's locale and time zone, not in UTC.
- **Dropped from the catalogue,** because their messages vary or carry detail: `apiErr.other`, `conflict`, `payload_too_large`, `project_not_running` and `invalid_status`.
- **Shown in the server's words with the code:** everything else, including all the hostname codes, `pool_exhausted`, the provisioner codes, core auth codes, `internal` and `http_error`.
- The `insufficient_memory` copy says "this project", not the size name (micro/small/medium) that control's message includes. The size is the one the user just picked on the same form.

### turkce-dogal

The new and changed Turkish strings were checked against the skill's rules, and `lint.py` was re-run over all of `tr.ts`: 0 hits (508 values, 1,603 words). The new strings are:
- `apiErr.insufficient_memory`, `apiErr.new_host_cap`, `apiErr.weak_password`, `apiErr.weak_passphrase` and `apiErr.account_exists`
- `shell.languageFailed`
- `tokens.meta`

Two drafts changed in this pass:
- `insufficient_memory` had two "or"s in one sentence. It is now split: "…ama bu proje {needed} MiB istiyor. Kullanmadığın bir projeyi duraklat ya da sil. Daha küçük bir boyut da seçebilirsin."
- `new_host_cap` repeated "boşal-". It now reads "…bir adres hakkı açılır. … adresini serbest bırakabilirsin."

### Commands and output (from `studio/`)

```
$ npx tsc --noEmit -p .
TypeScript: No errors found

$ npm run build
dist/assets/index-BncPhUZz.css   55.67 kB │ gzip:  12.27 kB
dist/assets/tr-BTi0rrbJ.js       21.87 kB │ gzip:   7.91 kB
dist/assets/Sql-2YMMlXqC.js     430.93 kB │ gzip: 140.06 kB
dist/assets/index-DLAUZTj9.js   514.39 kB │ gzip: 143.02 kB
✓ built (Vite still warns: main chunk over 500 kB)

$ STUDIO_E2E_PORT=5293 npx playwright test
143 tests: 83 passed, 60 skipped, 0 failed (4.2 min)

$ STUDIO_E2E_PREVIEW=1 STUDIO_E2E_PORT=5294 npx playwright test e2e/i18n.spec.ts
13 passed (against the production build)

$ STUDIO_SHOTS=1 STUDIO_E2E_PORT=5293 npx playwright test e2e/screens.spec.ts
59 passed
```

- The main chunk is 514.4 kB (143.0 kB gzip), up 2 kB from round 1 because of the error rules and the new copy.
- 14 screenshots changed (539a298). The visible change is the row sheet's placeholder. The rest is rendering noise.

### Concerns after fix round 2

1. **Brittle exact-message rules.** If control rewords one of those messages, Studio falls back to the server's words and code. That is safe, but the Turkish copy silently stops being used. A control-side `details` field or a stable message id would be sturdier. That is out of scope here, since control was not to change.
2. **English refusals in the Turkish UI.** Unmapped refusals, such as the hostname codes and `pool_exhausted`, are shown in English. This follows the instruction. Turkish copy for them needs structured fields from control (the host and so on).
3. **The 3 s sign-out cap still applies.** A request slower than that is still racing logout when the cap ends.
4. **Preview mode is not in CI.** `STUDIO_E2E_PREVIEW=1` is opt-in. Only the i18n spec was run against the build in this round, not the full suite.
5. **Bundle size.** The main chunk is still over the 500 kB hint.
