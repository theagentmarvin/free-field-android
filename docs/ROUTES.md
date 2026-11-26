# Routes owned by the Tasks tab

Hash routing (`#/tasks/...`). Tablet (>= 840dp) shows list + detail side by side; phones show one screen at a time. Same URLs either way.

| Route | Screen |
|---|---|
| `/tasks` | list (folders Mine / Open / In review / Closed / Drafts); tablet auto-selects the first task |
| `/tasks/:taskId` | detail: fields, location chips, photos, status actions, timeline, comment box |
| `/tasks/:taskId/edit` | edit title, description, type, deadline, assignee, storey (one `edit`/`assign` outbox action) |
| `/tasks/new` | the dedicated New task screen (draft autosave). Full screen: no header, tabs or task list, in both orientations. Close keeps the draft and returns to the origin (plan, 3D view or list); Save returns to the plan or the 3D view of the building (`/model/:id?task=<new id>`) showing the new pin, from the list it opens the new task |

Implementation: `apps/mobile/src/pages/TasksPage.tsx` and `apps/mobile/src/tasks/`. Anchor helpers live in `apps/mobile/src/tasks/anchor.ts` (`buildNewTaskPath`, `parseNewTaskParams`, `planLink`, `modelLink`); import them instead of hand-building URLs.

## `/tasks/new` query parameters

| Param | Meaning |
|---|---|
| `anchor` | where the task is pinned (grammar below), URL-encoded |
| `building` | `buildingId` to pre-select |
| `storey` | storey name to pre-fill |
| `draft` | resume a saved draft by id (wins over `anchor`; the draft keeps its own location) |

### `anchor` grammar

```
anchor   := "pdf:" pdfFileId "/" page "/" u "," v "/" calibId
          | "bim:" [elements] ["@" x "," y "," z] ["~" camera]
elements := modelId "." expressId ( "+" modelId "." expressId )*
camera   := px "," py "," pz "," tx "," ty "," tz "," fov "," ortho     (ortho is 0 or 1)
```

The plan viewer's long-press uses a second, equivalent form that is also accepted:

```
anchor := "plan~" pdfFileId "~" planVersionId "~" page "~" u "~" v          (see plans/anchor.ts)
```

The form resolves the plan's latest calibration and building from the device database (sentinel calibId `uncalibrated` when the plan has none) and, after creating the task, returns to `/plans/:pdfFileId`.

- ids (`pdfFileId`, `calibId`, `modelId`) match `[A-Za-z0-9_-]+`; `page` is an integer >= 1; `u`,`v` are the normalized plan coordinates (0..1) of the pin; `expressId` is a non-negative integer; other numbers are plain decimals.
- a `bim` anchor must carry at least one element or a world point.
- a plan without a calibration still needs a `calibId` (the task schema requires one): pass any stable id, for example `uncalibrated`.
- an invalid anchor is ignored (the form opens unpinned); it never crashes.

Examples (before URL-encoding):

```
/tasks/new?anchor=pdf:3f2a-11/2/0.25,0.75/c-9&building=b1&storey=Level%202
/tasks/new?anchor=bim:m-1.4821+m-1.77@12.5,3,-4.25~10,8,10,12.5,3,-4.25,60,0
```

Build links in code:

```ts
import { buildNewTaskPath } from "../tasks/anchor";
navigate(buildNewTaskPath({ anchor: { kind: "pdf", pdfFileId, page, uv: [u, v], calibId }, buildingId, storey }));
```

The anchor becomes the task's `location` (`pdf` or `bim` block) exactly as the web compose sheet writes it.

## Links out of the Tasks tab

The detail screen shows a location chip that links to:

- `/plans/:pdfFileId?task=<taskId>&page=<n>` for plan pins
- `/model/:buildingId?task=<taskId>` for model pins (`/model?task=<taskId>` when the task has no building)

Viewers should read `task` to focus the pin. Until those routes exist the app's catch-all redirects to `/tasks`, so the links never crash.

## Routes owned by the Model tab

| Route | Screen |
|---|---|
| `/model` | redirects to `/model/:buildingId` (the `task`'s building, else the last used one, else the first) |
| `/model/:buildingId` | 3D view of the building's downloaded `.frag` (demo mode: the bundled sample); building picker on top |
| `/model/:buildingId?task=<id>` | same, and once loaded flies to that task's 3D pin (its stored camera when it shows the pin, else a close-up) and marks it focused |

- A building whose `.frag` is not on the device shows "Make available offline" linking to `/offline`; the viewer never downloads.
- Long-press an element (or a point on the model) -> "New task here" -> `/tasks/new?anchor=bim:<fileId>.<localId>@x,y,z~px,py,pz,tx,ty,tz,fov,0&building=<id>[&storey=<name>]`. `expressId` in the anchor is the fragments `localId`; the element's IFC GUID is shown in the properties sheet only (the task schema has no field for it). Helpers: `apps/mobile/src/model/anchor.ts` (`buildBimAnchor`, `newTaskPathForModel`, `pinsForBuilding`); the grammar itself is unchanged.
- Pins: every task with `location.bim.worldPoint` in the building (queued creates included, drawn half-alpha). Tapping a pin opens `/tasks/:taskId`.

## Routes owned by the Link view

| Route | Screen |
|---|---|
| `/linkview/:buildingId` | calibrated plan and 3D view side by side (landscape) or stacked (portrait); a camera marker on the plan is the first-person 3D camera |
| `/linkview/:buildingId?plan=<pdfFileId>&storey=<name>&x=<m>&z=<m>&b=<deg>` | same, on that plan / calibrated storey, the walker starting at world (x, z) looking along world bearing `b` (degrees, atan2(dz, dx)) |

- All parameters are optional; an unknown or uncalibrated `plan` falls back to a calibrated one with a note. A building without any calibrated plan shows an explanation.
- Entries: "Plan + 3D" in the plan viewer bar (an uncalibrated plan explains instead of navigating) and in the model bar (a picker of calibrated plans). Build links with `linkviewPath` / `parseLinkview` (`apps/mobile/src/linkview/route.ts`).
- The URL follows the walker (replace, debounced) so Back returns to the same place.
- `/tasks/new` accepts `back=/linkview/...`: a plan long-press made in the Link view returns Cancel and Save there (only that in-app path is accepted; `tasks/origin.ts`).
- Gestures: tap the plan moves the camera; drag the marker dot to move; drag the handle at the wedge tip to turn; long press on the plan = New task here; walk and look in the 3D pane move and turn the marker.

## Select mode, bulk actions and export (no new routes)

These are overlays on `/tasks` and `/tasks/:taskId`, not routes: the list's **Select** button (or a long-press on a row) turns on select mode (checkboxes, select all visible, a bottom bar with Status / Assignee / Deadline / Priority / Type / Export); **Export** on the list (current view, or the selection when select mode has one) and on the task detail (that task) opens the export dialog (PDF report, CSV, BCF 2.1, BCF 3.0). Design and tests: `docs/spikes/task-bulk-export.md`.
