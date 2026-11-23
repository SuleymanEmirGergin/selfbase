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
