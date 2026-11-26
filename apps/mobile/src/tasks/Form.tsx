import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { requireProjectId, useProjectId, useProjectSelection } from "@ff/auth";
import {
  MAX_TITLE,
  parseDateInput,
  toDateInput,
  validateDescription,
  validateTitle,
} from "@ff/tasks";
import {
  TYPE_OPTIONS,
  buildComposeEnqueues,
  useSheetCatalog,
  draftTable,
  emptyCompose,
  quickDeadline,
  useTaskEngine,
  type ComposeFields,
  type ComposePhoto,
} from "@ff/tasks-react";
import { UNCALIBRATED_CALIB_ID } from "@ff/types";
import { withModelPoint } from "../plans/dualLocation";
import { manifestKey, parseManifest } from "../plans/manifest";
import { levelOf } from "../linkview/plans";
import { getBlobStore } from "../storage";
import { anchorToLocation, locationToAnchor, parseNewTaskParams } from "./anchor";
import { consumeRecoveredCapture, fetchWebPath, onCaptureRecovered } from "./camera";
import { deleteDraft, isWorthSaving, loadCompose, saveCompose } from "./drafts";
import { buildTaskEdit } from "./edits";
import { useBuildingNames, useRoster, useTaskDetail } from "./hooks";
import { PhotoAttach } from "./PhotoAttach";
import { parkedDraftSaved, registerCreateForm, releaseCreateForm, takeParkedDraft } from "./layoutSwitch";
import { useSingleFlight } from "./singleFlight";
import { emptyExtras, extrasEdit, forgetExtras, loadExtras, saveExtras, type CreateExtras } from "./createExtras";
import { newTaskExit } from "./origin";
import { NewTaskFrame, NewTaskCard } from "./NewTaskFrame";
import { ChecklistSection, PriorityRow, SheetsSection, WatchersSection } from "./Extras";
import { resolveSheetRefOpen } from "@ff/tasks-react";
import type { TaskView } from "@ff/tasks";
import { addPhoto, discardTaskPhotos, removePhoto } from "./photoStore";
import type { TaskLocation } from "@ff/firestore";
import { db as localDb } from "@ff/data/db/database";
import { latestCalibration, pdfPinLocation, resolveCreateBuildingId, type CalibrationLike, type TaskBuildingIndex } from "@ff/tasks-react";

const AUTOSAVE_MS = 700;

/** Create (with draft autosave) or edit a task. Never disabled while offline. */
export function TaskForm({ mode, taskId: editId }: { mode: "create" | "edit"; taskId?: string }) {
  return mode === "edit" && editId ? <EditForm taskId={editId} /> : <CreateForm />;
}

// ── shared fields UI ─────────────────────────────────────────────────────

interface FieldsProps {
  fields: ComposeFields;
  setFields(f: ComposeFields): void;
  members: { uid: string; name: string }[];
  buildingNames: Map<string, string>;
  errors: { title?: string; description?: string };
  planName?: string | null;
}

type FieldPieceProps = FieldsProps;

function useSet({ fields, setFields }: FieldsProps) {
  return (patch: Partial<ComposeFields>) => setFields({ ...fields, ...patch });
}

function TitleField(p: FieldPieceProps) {
  const set = useSet(p);
  return (
    <label className="field">
      <span>Title</span>
      <input
        className="input"
        data-testid="task-title"
        value={p.fields.title}
        maxLength={MAX_TITLE + 20}
        placeholder="What needs doing?"
        onChange={(e) => set({ title: e.target.value })}
      />
      {p.errors.title && (
        <span className="error" role="alert" data-testid="title-error">
          {p.errors.title}
        </span>
      )}
    </label>
  );
}

function DescriptionField(p: FieldPieceProps) {
  const set = useSet(p);
  return (
    <label className="field">
      <span>Description</span>
      <textarea
        className="input"
        rows={4}
        data-testid="task-description"
        value={p.fields.description}
        placeholder="Add context and acceptance criteria"
        onChange={(e) => set({ description: e.target.value })}
      />
      {p.errors.description && <span className="error">{p.errors.description}</span>}
    </label>
  );
}

function TypeField(p: FieldPieceProps) {
  const set = useSet(p);
  return (
    <div className="field">
      <span>Type</span>
      <div className="chips" role="group" aria-label="Type">
        {TYPE_OPTIONS.map((t) => (
          <button
            key={t}
            type="button"
            className={`chip${p.fields.type === t ? " is-on" : ""}`}
            aria-pressed={p.fields.type === t}
            data-testid={`type-${t}`}
            onClick={() => set({ type: p.fields.type === t ? "task" : t })}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

function AssigneeField(p: FieldPieceProps) {
  const set = useSet(p);
  return (
    <label className="field">
      <span>Assignee</span>
      <select
        className="input"
        data-testid="task-assignee"
        value={p.fields.assigneeUid ?? ""}
        onChange={(e) => {
          const m = p.members.find((x) => x.uid === e.target.value);
          set({ assigneeUid: m?.uid ?? null, assigneeName: m?.name ?? null });
        }}
      >
        <option value="">Unassigned</option>
        {p.members.map((m) => (
          <option key={m.uid} value={m.uid}>
            {m.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function DeadlineField(p: FieldPieceProps) {
  const set = useSet(p);
  return (
    <div className="field">
      <span>Deadline</span>
      <div className="row-inline">
        <input
          type="date"
          className="input"
          data-testid="task-deadline"
          value={toDateInput(p.fields.deadline)}
          onChange={(e) => set({ deadline: e.target.value ? parseDateInput(e.target.value) : null })}
        />
        {(["today", "tomorrow", "week"] as const).map((k) => (
          <button key={k} type="button" className="chip" onClick={() => set({ deadline: quickDeadline(Date.now(), k) })}>
            {k === "today" ? "Today" : k === "tomorrow" ? "Tomorrow" : "+1 week"}
          </button>
        ))}
        {p.fields.deadline !== null && (
          <button type="button" className="chip" onClick={() => set({ deadline: null })}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function BuildingField(p: FieldPieceProps) {
  const set = useSet(p);
  if (p.buildingNames.size === 0) return null;
  return (
    <label className="field">
      <span>Building</span>
      <select className="input" data-testid="task-building" value={p.fields.buildingId ?? ""} onChange={(e) => set({ buildingId: e.target.value || null })}>
        <option value="">No building</option>
        {[...p.buildingNames].map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

function StoreyField(p: FieldPieceProps) {
  const set = useSet(p);
  const storey = p.fields.location?.storeyName ?? "";
  const setStorey = (name: string) => {
    const base: TaskLocation = p.fields.location ?? { storeyName: null, bim: null, pdf: null };
    const loc = { ...base, storeyName: name || null };
    set({ location: !loc.storeyName && !loc.bim && !loc.pdf && !loc.text ? null : loc });
  };
  return (
    <label className="field">
      <span>Storey</span>
      <input className="input" data-testid="task-storey" value={storey} placeholder="e.g. Level 02" onChange={(e) => setStorey(e.target.value)} />
    </label>
  );
}

function LocationField(p: FieldPieceProps) {
  const set = useSet(p);
  const anchor = locationToAnchor(p.fields.location);
  if (!anchor) return null;
  return (
    <div className="field">
      <span>Location</span>
      <span className="loc-chip" data-testid="anchor-chip" data-kind={anchor.kind}>
        {anchor.kind === "pdf" ? `${p.planName ?? "Plan"} pin, page ${anchor.page}` : `Model pin, ${anchor.elements.length} element(s)`}
        <button
          type="button"
          className="chip-x"
          aria-label="Remove pin"
          onClick={() => set({ location: p.fields.location ? { ...p.fields.location, bim: null, pdf: null } : null })}
        >
          x
        </button>
      </span>
    </div>
  );
}

/** Edit form: the fields in one column. (The New task screen lays the same pieces out like the web compose sheet.) */
function FieldsUi(p: FieldsProps) {
  return (
    <>
      <TitleField {...p} />
      <DescriptionField {...p} />
      <TypeField {...p} />
      <AssigneeField {...p} />
      <DeadlineField {...p} />
      <BuildingField {...p} />
      <StoreyField {...p} />
      <LocationField {...p} />
    </>
  );
}

function validate(f: ComposeFields) {
  return { title: validateTitle(f.title) ?? undefined, description: validateDescription(f.description) ?? undefined };
}

// ── create ───────────────────────────────────────────────────────────────

function CreateForm() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const projectId = useProjectId();
  const engine = useTaskEngine();
  const { actor, members } = useRoster();
  const buildingNames = useBuildingNames();
  const params = useMemo(() => parseNewTaskParams(search), [search]);

  // a remount caused by rotating across the split-view breakpoint continues the same draft
  const [restoreId] = useState(() => params.draftId ?? takeParkedDraft(search.toString() ? `?${search.toString()}` : ""));
  const [taskId] = useState(() => restoreId ?? crypto.randomUUID());
  const [fields, setFieldsState] = useState<ComposeFields>(() => ({
    ...emptyCompose(),
    buildingId: params.buildingId,
    location: anchorToLocation(params.anchor, params.storey),
  }));
  const [loading, setLoading] = useState(true);
  const [planName, setPlanName] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ title?: string; description?: string }>({});
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // edits made after the last save: the indicator must not claim "saved" while they are pending
  const [unsaved, setUnsaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const exit = useMemo(() => newTaskExit(search), [search]);
  const [extras, setExtrasState] = useState<CreateExtras>(emptyExtras);
  const setExtras = useCallback(
    (next: CreateExtras) => {
      setExtrasState(next);
      saveExtras(taskId, next);
    },
    [taskId],
  );
  const catalog = useSheetCatalog(projectId ?? null);
  const { memberships } = useProjectSelection();
  const projectName = memberships?.find((m) => m.id === projectId)?.name ?? null;
  const latest = useRef(fields);
  const dirty = useRef(false);
  const done = useRef(false); // submitted or discarded: no more autosave
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>();

  const setFields = useCallback((f: ComposeFields) => {
    latest.current = f;
    dirty.current = true;
    setUnsaved(true);
    setFieldsState(f);
  }, []);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (done.current || !dirty.current || !projectId) return;
    const f = latest.current;
    if (!isWorthSaving(f)) return;
    dirty.current = false;
    await saveCompose(draftTable, taskId, projectId, f);
    setSavedAt(Date.now());
    // an edit that landed while this save was in flight is still unsaved
    if (!dirty.current) setUnsaved(false);
  }, [projectId, taskId]);

  // restore a draft (and a photo recovered after the activity was killed)
  useEffect(() => {
    let live = true;
    void (async () => {
      let base = latest.current;
      if (restoreId) {
        setExtrasState(loadExtras(restoreId));
        await parkedDraftSaved(restoreId); // a form unmounted by a layout switch may still be saving
        const d = await loadCompose(draftTable, restoreId);
        if (d) base = d;
      }
      if (!restoreId && params.anchor?.kind === "pdf") {
        // pin from the plan viewer: resolve the plan's calibration and building
        try {
          const file = await localDb.pdfFiles.get(params.anchor.pdfFileId);
          const calibs = await localDb.calibrations.where("pdfFileId").equals(params.anchor.pdfFileId).toArray();
          const calib = latestCalibration(calibs as unknown as CalibrationLike[]);
          const a = params.anchor;
          // the task schema requires a calibration id on plan pins; uncalibrated plans use a sentinel
          const loc = pdfPinLocation(a.pdfFileId, a.page, a.uv, calib ?? { id: UNCALIBRATED_CALIB_ID, storeyName: "", transformParams: { scale: 1, rotation: 0, translateX: 0, translateZ: 0 }, updatedAt: 0 }, a.planVersionId); // vendor w77 keeps the sentinel
          let location: TaskLocation = { ...loc, storeyName: params.storey ?? (loc.storeyName || null) };
          // A calibrated plan also gives the 3D point under the pin (the web's dual-location shape); an uncalibrated plan stays plan-only.
          if (calib && a.planVersionId) {
            try {
              const manifest = parseManifest(await getBlobStore().read(manifestKey(a.planVersionId)));
              const storeys = file?.buildingId ? await localDb.storeys.where("buildingId").equals(file.buildingId).toArray() : [];
              const level = levelOf(storeys, calib.storeyName);
              location = withModelPoint(location, { calibration: calib, page: manifest ? { width: manifest.pageWidth, height: manifest.pageHeight } : null, floorY: level ? level.elevation : null });
            } catch {
              /* no manifest or storeys on the device: plan-only */
            }
          }
          base = {
            ...base,
            location,
            buildingId: params.buildingId ?? file?.buildingId ?? null,
          };
          setPlanName(file?.name ?? "Plan");
          dirty.current = true;
        } catch {
          /* unresolved: keep the plain anchor location */
        }
      }
      // The building is always stamped: a restored draft with no building keeps the creation context's, then the building that
      // owns the pinned model or sheet, then the project's only building.
      if (!base.buildingId) {
        try {
          const [ifcs, pdfs, blds] = await Promise.all([localDb.ifcFiles.toArray(), localDb.pdfFiles.toArray(), localDb.buildings.toArray()]);
          const index: TaskBuildingIndex = {
            modelToBuilding: new Map(ifcs.map((f) => [f.id, f.buildingId] as const)),
            pdfToBuilding: new Map(pdfs.map((f) => [f.id, f.buildingId] as const)),
          };
          const resolved = resolveCreateBuildingId({ context: params.buildingId, location: base.location as never }, index);
          const mine = blds.filter((b) => b.projectId === projectId);
          const only = mine.length === 1 ? mine[0].id : null;
          if (resolved ?? only) {
            base = { ...base, buildingId: resolved ?? only };
            dirty.current = true;
          }
        } catch {
          /* no local building rows yet: the form's building picker still works */
        }
      }
      const rec = await consumeRecoveredCapture(taskId).catch(() => null);
      if (rec) {
        try {
          const photo = await addPhoto(taskId, await fetchWebPath(rec.webPath));
          base = { ...base, photos: [...base.photos, photo] };
          dirty.current = true;
        } catch {
          /* the cached capture is gone; the draft itself is intact */
        }
      }
      if (!live) return;
      latest.current = base;
      setFieldsState(base);
      setLoading(false);
      if (dirty.current) void flush();
    })();
    return () => {
      live = false;
    };
    // run once per mount (the page keys this component on the draft id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () =>
      onCaptureRecovered((rec) => {
        if (rec.draftId !== taskId) return;
        void consumeRecoveredCapture(taskId).then(async (r) => {
          if (!r) return;
          const photo = await addPhoto(taskId, await fetchWebPath(r.webPath));
          setFields({ ...latest.current, photos: [...latest.current.photos, photo] });
        });
      }),
    [taskId, setFields],
  );

  // debounced autosave + flush when the app goes to the background / unmounts
  useEffect(() => {
    if (loading) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
    return () => clearTimeout(timer.current);
  }, [fields, loading, flush]);
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
      const saved = flush();
      releaseCreateForm(taskId, done.current ? null : saved);
    };
  }, [flush, search, taskId]);

  useEffect(() => {
    registerCreateForm(search.toString() ? `?${search.toString()}` : "", taskId);
  }, [search, taskId]);

  const once = useSingleFlight();
  const submit = () => once(submitOnce);
  async function submitOnce() {
    const errs = validate(fields);
    setErrors(errs);
    if (errs.title || errs.description || !engine) return;
    setSubmitting(true);
    done.current = true;
    clearTimeout(timer.current);
    try {
      const pid = requireProjectId(projectId);
      const payloads = buildComposeEnqueues(fields, { projectId: pid, taskId, actor, at: Date.now() });
      for (const p of payloads) await engine.enqueue(p);
      const follow = extrasEdit(extras, { taskId, projectId: pid, title: payloads[0].title, statusTo: payloads[payloads.length - 1].statusTo, actor, at: Date.now() });
      if (follow) await engine.enqueue(follow);
      forgetExtras(taskId);
      await deleteDraft(draftTable, taskId);
      // back to where the task was started: the plan or the 3D view (showing the new pin), otherwise the new task in the list
      navigate(exit.saveTo(taskId), { replace: true });
    } catch (e) {
      done.current = false;
      setSubmitting(false);
      setErrors({ title: `Could not create the task: ${(e as Error).message}` });
    }
  }

  async function discard() {
    done.current = true;
    clearTimeout(timer.current);
    for (const p of latest.current.photos) await removePhoto(taskId, p).catch(() => undefined);
    await deleteDraft(draftTable, taskId).catch(() => undefined);
    await discardTaskPhotos(taskId).catch(() => undefined);
    forgetExtras(taskId);
    navigate(exit.cancelTo, { replace: true });
  }

  /** Close / Cancel: the draft stays (the unmount flush saves it); go back where the user came from. */
  function cancel() {
    const idx = (window.history.state as { idx?: unknown } | null)?.idx;
    if (typeof idx === "number" && idx > 0) navigate(-1);
    else navigate(exit.cancelTo, { replace: true });
  }

  if (loading) return <p className="muted pad">Loading draft...</p>;
  const pieces = { fields, setFields, members, buildingNames, errors, planName };
  const extrasView = { priority: extras.priority ?? undefined, checklist: extras.checklist, watchers: extras.watchers, sheetRefs: fields.sheetRefs ?? [] } as unknown as TaskView;
  const onExtras = (n: { priority?: CreateExtras["priority"]; checklist?: CreateExtras["checklist"]; watchers?: string[]; sheetRefs?: ComposeFields["sheetRefs"] }) => {
    if (n.sheetRefs) setFields({ ...latest.current, sheetRefs: n.sheetRefs });
    const next = { priority: n.priority ?? extras.priority, checklist: n.checklist ?? extras.checklist, watchers: n.watchers ?? extras.watchers };
    if (n.priority || n.checklist || n.watchers) setExtras(next);
  };
  const created = new Date().toLocaleDateString();
  return (
    <NewTaskFrame
      onClose={cancel}
      onSubmit={() => void submit()}
      submitting={submitting}
      onDiscard={() => void discard()}
      status={
        <span className="muted tiny" data-testid="draft-status" data-saved={savedAt && !unsaved ? "1" : "0"}>
          {unsaved ? (savedAt ? "Saving…" : "Not saved yet") : savedAt ? "Draft saved on this device" : "Not saved yet"}
        </span>
      }
    >
      <NewTaskCard title="Task data" testId="new-task-data">
        <dl className="receipt">
          <div>
            <dt>Created by</dt>
            <dd>{actor.name || "You"}</dd>
          </div>
          <div>
            <dt>Date created</dt>
            <dd>{created}</dd>
          </div>
          {projectName && (
            <div>
              <dt>Project</dt>
              <dd>{projectName}</dd>
            </div>
          )}
          <div>
            <dt>Status</dt>
            <dd>Open</dd>
          </div>
        </dl>
        <BuildingField {...pieces} />
      </NewTaskCard>
      <NewTaskCard title="Task location · 2D/3D" testId="new-task-location">
        <LocationField {...pieces} />
        {!locationToAnchor(fields.location) && <p className="muted tiny">Not pinned. Long-press a plan or an element in the 3D view to pin a task.</p>}
        <StoreyField {...pieces} />
      </NewTaskCard>
      <NewTaskCard title="Task fields" testId="new-task-fields">
        <TitleField {...pieces} />
        <DescriptionField {...pieces} />
        <TypeField {...pieces} />
        <dl className="detail-dl">
          <PriorityRow task={extrasView} editable onEdit={onExtras} />
        </dl>
        <AssigneeField {...pieces} />
        <DeadlineField {...pieces} />
        <WatchersSection task={extrasView} members={members} actorUid={actor.uid ?? null} editable onEdit={onExtras} />
        <ChecklistSection task={extrasView} editable onEdit={onExtras} />
      </NewTaskCard>
      <NewTaskCard title="Attachments" testId="new-task-attachments">
        <div className="field">
          <span>Photos</span>
          <PhotoAttach
            taskId={taskId}
            photos={fields.photos}
            onChange={(photos: ComposePhoto[]) => setFields({ ...latest.current, photos })}
            beforeCapture={async () => {
              // the draft must exist before the camera app takes over, even if empty:
              // an activity restore re-opens it by id
              if (!projectId) return;
              clearTimeout(timer.current);
              dirty.current = false;
              await saveCompose(draftTable, taskId, projectId, latest.current);
              setSavedAt(Date.now());
              if (!dirty.current) setUnsaved(false);
            }}
          />
        </div>
        <SheetsSection
          task={extrasView}
          catalog={catalog}
          editable
          onEdit={onExtras}
          onOpen={(ref) => {
            const res = resolveSheetRefOpen(ref, catalog);
            if (res.ok) navigate(`/plans/${encodeURIComponent(ref.pdfFileId)}${ref.page ? `?page=${ref.page}` : ""}`);
          }}
        />
      </NewTaskCard>
    </NewTaskFrame>
  );
}

// ── edit ─────────────────────────────────────────────────────────────────

function EditForm({ taskId }: { taskId: string }) {
  const navigate = useNavigate();
  const projectId = useProjectId();
  const engine = useTaskEngine();
  const { actor, members } = useRoster();
  const buildingNames = useBuildingNames();
  const { task, ready } = useTaskDetail(taskId);
  const [fields, setFields] = useState<ComposeFields | null>(null);
  const [errors, setErrors] = useState<{ title?: string; description?: string }>({});

  useEffect(() => {
    if (task && !fields) {
      setFields({
        ...emptyCompose(),
        title: task.title,
        description: task.description ?? "",
        type: task.type ?? "task",
        assigneeUid: task.assigneeUid ?? null,
        assigneeName: task.assigneeName ?? null,
        deadline: task.deadline ?? null,
        buildingId: task.buildingId ?? null,
        location: (task.location as TaskLocation | null) ?? null,
      });
    }
  }, [task, fields]);

  if (!ready) return <p className="muted pad">Loading task...</p>;
  if (!task || !fields) return <p className="muted pad">Task not found.</p>;

  async function save() {
    if (!task || !fields || !engine) return;
    const errs = validate(fields);
    setErrors(errs);
    if (errs.title || errs.description) return;
    const payload = buildTaskEdit(
      task,
      {
        title: fields.title.trim(),
        description: fields.description,
        type: fields.type,
        deadline: fields.deadline,
        assigneeUid: fields.assigneeUid,
        assigneeName: fields.assigneeName,
        buildingId: fields.buildingId ?? null,
        storeyName: fields.location?.storeyName ?? null,
      },
      { projectId: requireProjectId(projectId), actor, buildingName: (id) => (id ? (buildingNames.get(id) ?? null) : null) },
    );
    if (payload) await engine.enqueue(payload);
    navigate(`/tasks/${taskId}`, { replace: true });
  }

  return (
    <form
      className="task-form pad"
      data-testid="task-edit-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2>Edit task</h2>
      <FieldsUi fields={fields} setFields={setFields} members={members} buildingNames={buildingNames} errors={errors} />
      <div className="form-actions">
        <button type="submit" className="btn primary" data-testid="task-save">
          Save changes
        </button>
        <button type="button" className="btn" onClick={() => navigate(`/tasks/${taskId}`, { replace: true })}>
          Cancel
        </button>
      </div>
    </form>
  );
}
