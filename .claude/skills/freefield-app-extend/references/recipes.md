# Recipes: common changes to the field app, with the real files

Every path below exists in this repository (checked when this skill was written). Line numbers drift, so search for the named symbol. The most reliable check that you found every spot is `pnpm typecheck`: many lists are typed `Record<…>` and fail to compile when an entry is missing. Tests find elements by their visible text and `data-testid`, so a text change usually means a test change.

## Contents
1. [Rename the app, change the icon, splash or colours](#1-rename-the-app-change-the-icon-splash-or-colours)
2. [Change UI text](#2-change-ui-text)
3. [Show or edit on the tablet a task field the web already has](#3-a-task-field-the-web-already-has)
4. [A brand-new synced task field (web plus app)](#4-a-brand-new-synced-task-field)
5. [Add an item to the More screen, or a setting](#5-add-an-item-to-the-more-screen-or-a-setting)
6. [Add a tool to the 3D toolbar](#6-add-a-tool-to-the-3d-toolbar)
7. [Add a notification category](#7-add-a-notification-category)
8. [Change the PDF report or the CSV export](#8-change-the-pdf-report-or-the-csv-export)

---

## 1. Rename the app, change the icon, splash or colours

Four separate things; do only what is asked.

**The name under the icon.** Edit `appName` in `company.config.json` (up to 30 characters, no `< > & " ' \`). Gradle turns it into the Android label (`resValue` in `apps/mobile/android/app/build.gradle`) and `capacitor.config.ts` reads it. It is safe to change on an app already on tablets. **Do not touch `applicationId`.**

**The name inside the app.** The words "FreeField Field" appear as plain text in:
- `apps/mobile/src/shell/AppShell.tsx` (the header when no project name is available),
- `apps/mobile/src/pages/SignInPage.tsx` (the sign-in title; `e2e/app.spec.ts` asserts this heading, so update the spec with it),
- `apps/mobile/index.html` (`<title>`),
- the PDF report: `apps/mobile/src/tasks/export/reportPdf.ts` (`creator`, the page footer), `reportModel.ts` and `useExportEnv.ts` (fallback project name), `pdfWriter.ts` (PDF producer),
- `apps/mobile/src/diagnostics/exportLogs.ts` (share title) and `apps/mobile/src/tasks/camera.ts` (the camera-permission message).
Search with `git grep -n "FreeField"` under `apps/mobile/src`. Tests in `reportPdf.test.ts` and `reportModel.test.ts` may pin these strings.

**The icon.** An Android adaptive icon is a **foreground picture on a background colour**, so the artwork needs a safe margin (keep the logo inside the central two thirds).
- Foreground, 5 PNGs: `apps/mobile/android/app/src/main/res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher_foreground.png`, at 108, 162, 216, 324 and 432 px square, transparent background.
- Background colour: `apps/mobile/android/app/src/main/res/values/ic_launcher_background.xml` (`ic_launcher_background`).
- Old-style icons (Android 7 and below, and the round variant), 5 sizes each of `ic_launcher.png` and `ic_launcher_round.png` in the same `mipmap-*` folders, at 48, 72, 96, 144 and 192 px.
- The wiring is `mipmap-anydpi-v26/ic_launcher.xml` and `ic_launcher_round.xml`; leave them. `drawable-v24/ic_launcher_foreground.xml` is an unused leftover.
- If you have one square 1024 px logo, produce the sizes with an image tool and show the user the result in an emulator or on a tablet before shipping. Ask for the logo file; never invent one.
- The status-bar glyph of notifications is `drawable/ic_stat_ff.xml` (a white silhouette vector).

**The splash screen.** `apps/mobile/android/app/src/main/res/drawable/splash.png` (480x320) plus the `drawable-port-*` and `drawable-land-*` copies (for example `drawable-port-xxhdpi/splash.png` is 960x1600). The theme `AppTheme.NoActionBarLaunch` in `values/styles.xml` shows it on the app background colour (`@color/ff_bg_app`). Replace all the copies with the company's picture, same sizes.

**The colours.** The app is **light theme only** and every colour resolves to a web `--ff-*` token. The web tokens file (`vendor/free-field/apps/settings/src/styles/tokens.css`) is read-only here, so override from the app side, additively:
1. Create `apps/mobile/src/brand.css` with `:root { --ff-blue-active: #xxxxxx; }` (the accent, used by buttons and links; `--accent` follows it). Other tokens work the same way (`--ff-bg-app`, `--ff-text-primary`, and so on).
2. Import it in `apps/mobile/src/main.tsx` right after `import "./styles.css";`.
3. Android window colours: `apps/mobile/android/app/src/main/res/values/ff_colors.xml` (`ff_bg_app`, `ff_bg_canvas`, `ff_blue_active`) must hold the same values. `apps/mobile/capacitor.config.ts` reads the notification tint from the vendored `tokens.css`; change `accent` there if the notification colour must follow.
4. `apps/mobile/src/theme.test.ts` compares `ff_colors.xml` with the web tokens and fails on a mismatch; teach it about the override by parsing `brand.css` after `tokens.css` (`const ff = parseVars(tokensCss + brandCss)`). The same file checks text contrast (4.5:1, WCAG AA): keep white-on-accent at 4.5:1 or more, and check the new accent by hand because the test only sees the files it parses.
5. The test also forbids hand-written hex colours in `styles.css`, `tasks/tasks.css` and `model/model.css`: put colours in `brand.css` as tokens, never inline.
Rebuild, install and show the user a Tasks screen and the 3D view: colours also appear in 3D pins and annotation drawings (`apps/mobile/src/theme.ts` `cssVar(...)`).

## 2. Change UI text

All screen text is inline English in the components; there is no translation system. Find the string with `git grep -n "<the words>" apps/mobile/src`, edit it, then fix the tests that quote it (`git grep -n "<the words>" apps/mobile/src e2e`). Where the words come from:
- Tab names: `TABS` in `apps/mobile/src/shell/AppShell.tsx`.
- Settings and diagnostics: `apps/mobile/src/pages/MorePage.tsx`.
- Notification labels: `CATEGORY_LABELS` in `apps/mobile/src/notifications/settings.ts`.
- Tools menu: `ITEMS` in `apps/mobile/src/model/ToolsMenu.tsx`.
- Sign-in: `apps/mobile/src/pages/SignInPage.tsx`.
- Export format names: `FORMAT_LABELS` in `apps/mobile/src/tasks/export/exportRun.ts`.
- Status, priority and verb labels come from the **web packages** (`STATUS_LABELS`, `PRIORITY_LABELS`, `VERB_LABELS` in `@ff/tasks` and `@ff/tasks-react`); changing them changes the website too, so that is a web-repo change.
Keep `data-testid` and `aria-label` values as they are unless a test is updated with them. A full Spanish version of the app is a separate project (hundreds of strings, plus the web-owned labels above); propose it as its own plan, ideally upstream.

## 3. A task field the web already has

Example: show and edit the free-text location note (`locationText`) of a task on the tablet. The web's `EditableTaskFields` (`vendor/free-field/packages/ff-tasks/src/taskFields.ts`) holds the fields an editor may change; the tablet's list is the `MobileEditable` pick in `apps/mobile/src/tasks/edits.ts`, which today leaves `locationText` out. Because the field exists, the schema, the rules and the outbox payload already support it: **no web change, no rules deploy.**

1. `apps/mobile/src/tasks/edits.ts`: add the key to the `MobileEditable` pick (the `before` object right below already reads `locationText`).
2. A row component in `apps/mobile/src/tasks/Extras.tsx` modelled on `PriorityRow` (a `<dt>`/`<dd>` pair that edits through the `onEdit` callback, with 44 px choices inside a `Sheet` from `tasks/ui.tsx`).
3. Show it in `apps/mobile/src/tasks/Detail.tsx` next to the other `<dt>` rows (it already calls `buildTaskEdit` and `engine.enqueue`).
4. On the New task screen, `apps/mobile/src/tasks/Form.tsx` and `createExtras.ts` (extras are saved per draft and sent as one follow-up edit after the create).
5. A list column or chip, only if asked: `apps/mobile/src/tasks/ListPane.tsx`.
6. Tests beside the files: `extras.test.tsx` (it covers `buildTaskEdit`), `createExtras.test.ts`, and the parity test `parity.test.tsx`.
The write must stay `buildTaskEdit` then `engine.enqueue`, so it works offline.

## 4. A brand-new synced task field

Example: "Subcontractor responsible". This is a **two-repository change** and the order matters. Demo mode has no security rules, so it will appear to work everywhere until the tablet talks to the real project.

**Step 1, the web repository (via its `freefield-extend` skill; its recipe 1 lists every file):**
- the field in `packages/ff-firestore/src/schema/task.ts` and the allowlist `hasOnlyTaskKeys()` in `packages/ff-firestore/firestore.rules` (without it **every tablet write that carries the field is rejected**, and the outbox shows the row as failed),
- `EditableTaskFields`, `diffTaskFields` and `buildEditPatch` in `packages/ff-tasks/src/taskFields.ts`, and `merge.ts`,
- a rules test in `packages/ff-firestore/__tests__/rules-tasks.test.ts`,
- and its own screens, table and exports (web-owned).
**Step 2, deploy the rules and the website** with the web repository's `freefield-deploy` skill: **rules first, website last**. Ask before deploying anything.
**Step 3, bump the submodule here:** in `vendor/free-field`, check out the web commit that has the field (`git -C vendor/free-field fetch && git -C vendor/free-field checkout <commit>`), commit the changed submodule pointer in this repo, and `pnpm install`.
**Step 4, the tablet:** exactly recipe 3 (`edits.ts`, `Extras.tsx`, `Detail.tsx`, `Form.tsx` and `createExtras.ts`, tests).
**Step 5, ship the app**, with `freefield-app-deploy`, and tell the user that tablets on the old app version will not show the new field and must be updated.

If the user wants the field **only on the tablet** and not synced, do not do this recipe: keep it in `localStorage` (a small wrapper like `apps/mobile/src/notifications/settings.ts`), say plainly that other devices and the website will not see it, and that it disappears on sign-out.

## 5. Add an item to the More screen, or a setting

`apps/mobile/src/pages/MorePage.tsx` is a list of `<h3>` sections each with a `<ul className="list">` of `<li><button className="row">` rows (or a `<Link className="row">` to a route). To add a row: copy one, keep `data-testid`s unique, 44 px rows come from the `row` class in `styles.css`. A new **screen**: add a page under `apps/mobile/src/pages/`, then a `<Route path="/<name>" …>` in `apps/mobile/src/App.tsx` (inside the `AppShell` route, near `/offline`). A new **bottom tab** instead: add to `TABS` in `apps/mobile/src/shell/AppShell.tsx` (five tabs already fill a phone's bar; the More screen is usually the right home).
A **setting** stored on the device: a small module with a typed default, a parse function that tolerates bad data, `localStorage` under a key starting `ffm` (so the sign-out wipe removes it), and a `useSyncExternalStore` hook; copy `apps/mobile/src/notifications/settings.ts` and its `settings.test.ts`. A setting that must follow the user across devices is a synced field: recipe 4.
Tests: `MorePage` has e2e coverage in `e2e/app.spec.ts` and `e2e/qa-ui.spec.ts`.

## 6. Add a tool to the 3D toolbar

The toolbar has fixed groups in `apps/mobile/src/model/toolbarLayout.ts` (`TOOLBAR_GROUPS`: view, modes, tools) and icons in `toolbarIcons.tsx`. Most new tools belong **inside the Tools menu**, not as a new toolbar button, so the 3D view stays clear:
1. `apps/mobile/src/model/ToolsMenu.tsx`: add the id to the `ToolPanel` type and an entry in `ITEMS` (label and hint).
2. `apps/mobile/src/model/ModelView.tsx`: render the panel when `panel === "<id>"` (see how `section`, `tree`, `search`, `views` are rendered near the end of the file) and let `openPanel` / `closePanels` manage it.
3. The panel component in its own file, like `SectionPanel.tsx` or `TreePanel.tsx`, with pure logic in a separate `*.ts` file and a unit test. Controls at least 44 px, usable in both orientations (the toolbar is a rail in landscape and a bar in portrait: `toolbarLayout()`).
4. Use the engine through `@ff/viewer-react` / `@ff/viewer` only. **Do not import `three` directly outside the viewer packages**, and never create a second viewer: one at a time, for memory.
5. A genuinely new toolbar button: add the id to `ToolbarItem` and `TOOLBAR_GROUPS`, its enabled and on states to `toolbarState()`, an icon in `toolbarIcons.tsx`, and the button in `CameraToolbar.tsx`; `toolbarLayout.test.ts` pins the layout.
6. Verify in the emulator (e2e `e2e/model.spec.ts`) or on a tablet: the engine only runs in a real WebView.
If the engine itself must learn something new (a new section-plane mode, a new filter), that lives in the web packages (`@ff/viewer`, `@ff/viewer-react`): a web-repo change, then bump the submodule.

## 7. Add a notification category

Notifications are raised **on the device when the app syncs** (there is no server push; see "What the app does not have" in `SKILL.md`). Categories are listed explicitly in several places:
1. `apps/mobile/src/notifications/settings.ts`: add the key to `NotifySettings`, `DEFAULT_SETTINGS`, `CATEGORY_LABELS`, **and** to the object returned by `parseSettings` (it names every key; a missing one is silently dropped).
2. `apps/mobile/src/notifications/events.ts`: add an `EventKind` if needed and emit the event in `deriveEvents` (or `deadlines` in `engine.ts`) with `category: "<key>"`, a stable dedupe `id`, and the `line`, `headline` and `body` texts. Never notify the author of their own action; follow what the existing branches do.
3. `apps/mobile/src/notifications/engine.ts`: events go to Android channel `tasks` or `deadlines`; add a channel only if the user needs separate sound or importance settings, and create it in `platform.ts`.
4. The More screen needs no change: `NotificationSettings.tsx` renders every key of `CATEGORY_LABELS`.
5. Tests: `settings.test.ts`, `events.test.ts`, `engine.test.ts`; e2e `e2e/notifications.spec.ts`.
The data an event needs must already be on the device (tasks and their timeline). A category that needs data nobody has synced needs the web side first.

## 8. Change the PDF report or the CSV export

**The PDF report is app-owned.** Content and order are decided in `apps/mobile/src/tasks/export/reportModel.ts` (plain data, unit-tested in `reportModel.test.ts`) and drawn by `reportPdf.ts` (layout) on the small PDF writer `pdfWriter.ts`. To add a field to the field grid or reorder blocks, change `reportModel.ts` (and its test) first, then the drawing code. Photos per task and limits: `REPORT_PHOTO_SIDE`, `REPORT_IMAGE_BUDGET` in `exportRun.ts`; the picker is `ExportSheet.tsx`. Run an export on the emulator and open the PDF to check the layout before shipping.

**The CSV and BCF are web-owned.** The tablet calls `buildCsv` from `@ff/tasks-react` (`vendor/free-field/packages/ff-tasks-react/src/exportTasks.ts`, with the columns in `tableColumns.ts`) and `exportBcf` from `@ff/tasks` (`packages/ff-tasks/src/bcf/`). Changing the columns means a change in the web repository (its recipe 3 covers table and CSV columns), then a submodule bump. The tablet side only wires the formats: `FORMAT_LABELS` and `runExport` in `exportRun.ts`.
