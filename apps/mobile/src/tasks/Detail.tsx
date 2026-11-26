import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useProjectId } from "@ff/auth";
import { buildActionPayload, isLinkviewLocation, type TaskStatus, type TaskVerb } from "@ff/tasks";
import {
  VERB_LABELS,
  effectiveTaskBuildingId,
  isOverdueDeadline,
  resolveSheetRefOpen,
  useSheetCatalog,
  useTaskBuildingIndex,
  usePhotoUrl,
  transitionBadge,
  useTaskEngine,
  useTaskPhotoResolver,
  type ComposePhoto,
} from "@ff/tasks-react";
import { locationToAnchor, modelLink, planLink } from "./anchor";
import { buildTaskEdit, type MobileEditable } from "./edits";
import { ChecklistSection, PriorityRow, SheetsSection, WatchersSection } from "./Extras";
import { useBuildingNames, useRoster, useTaskDetail } from "./hooks";
import { PhotoAttach } from "./PhotoAttach";
import { ConnectedExportSheet } from "./export/ExportSheet";
import { MarkupThumb, MarkupViewer } from "./MarkupAttachments";
import { deriveMarkups, removeMarkup, type MarkupAttachment } from "./markupAttach";
import { availableSources } from "./markupSource";
import { useSingleFlight } from "./singleFlight";
import { canAssign, canComment, canEdit, statusActionsFor } from "./transitions";
import { Avatar, Lightbox, numLabel, PhotoThumb, Sheet, StatusChip, SyncBadge, fmtDate, fmtDateTime } from "./ui";

export function TaskDetail({ taskId, onBack }: { taskId: string; onBack?: () => void }) {
  const projectId = useProjectId();
  const engine = useTaskEngine();
  const { actor, members } = useRoster();
  const buildingNames = useBuildingNames();
  const resolver = useTaskPhotoResolver();
  const { task, ready, entries, pendingKeys, entryPaths } = useTaskDetail(taskId);
  const [picker, setPicker] = useState(false);
  const [confirm, setConfirm] = useState<TaskVerb | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [commentPhotos, setCommentPhotos] = useState<ComposePhoto[]>([]);
  const [commentKey, setCommentKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const once = useSingleFlight();
  const navigate = useNavigate();
  const buildingIndex = useTaskBuildingIndex();
  const catalog = useSheetCatalog(projectId ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [markupView, setMarkupView] = useState<{ markup: MarkupAttachment; url: string } | null>(null);

  const actions = useMemo(() => statusActionsFor(task?.status ?? null), [task?.status]);
  // Markups are attachments carried by tagged comment entries (see markupAttach.ts): fold the timeline into the live ones.
  const derived = deriveMarkups(entries, entryPaths);

  if (!ready) return <p className="muted pad">Loading task...</p>;
  if (!task) {
    return (
      <div className="pad" data-testid="task-missing">
        <p>This task is not on this device yet.</p>
        <p className="muted">It may not have synced, or it was removed.</p>
        {onBack && (
          <button type="button" className="btn" onClick={onBack}>
            Back to tasks
          </button>
        )}
      </div>
    );
  }

  const status = task.status;
  const now = Date.now();
  const pid = projectId ?? null;

  async function act(verb: TaskVerb, text = "", photos: ComposePhoto[] = []) {
    if (!engine || !task || !pid) return;
    setError(null);
    try {
      await engine.enqueue(
        buildActionPayload({
          verb,
          projectId: pid,
          taskId,
          statusFrom: task.status as TaskStatus,
          actor,
          title: task.title,
          text,
          photoRefs: photos.map(({ blobKey, sha256, size, mime }) => ({ blobKey, sha256, size, mime })),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const assign = (uid: string | null) =>
    once(async () => {
      if (!engine || !task || !pid) return;
      const m = members.find((x) => x.uid === uid);
      const payload = buildTaskEdit(task, { assigneeUid: m?.uid ?? null, assigneeName: m?.name ?? null }, { projectId: pid, actor });
      if (payload) await engine.enqueue(payload);
      setPicker(false);
    });

  /** Priority, checklist, watchers and sheets: ONE `edit` action with the full next value (offline-safe, same as the web). */
  const editFields = (next: Partial<MobileEditable>) => {
    if (!engine || !task || !pid) return;
    setError(null);
    const payload = buildTaskEdit(task, next, { projectId: pid, actor, buildingName: (id) => (id ? (buildingNames.get(id) ?? null) : null) });
    if (!payload) return;
    engine.enqueue(payload).catch((e: Error) => setError(e.message));
  };

  // a double tap must not post the comment twice: the input is only cleared after the enqueue
  const sendComment = () =>
    once(async () => {
      const text = comment.trim();
      if (!text && commentPhotos.length === 0) return;
      await act("comment", text, commentPhotos);
      setComment("");
      setCommentPhotos([]);
      setCommentKey(crypto.randomUUID()); // fresh photo namespace for the next comment
    });

  const loc = task.location ?? null;
  // the building is shown for every task: an old task without a stamped building reads it from the model or sheet it is pinned on
  const effBuildingId = effectiveTaskBuildingId({ buildingId: task.buildingId, location: loc as never }, buildingIndex);
  const plan = planLink(loc as Parameters<typeof planLink>[0], task.id);
  const model = modelLink(loc, effBuildingId, task.id);
  const anchor = locationToAnchor(loc as never);
  const dual = isLinkviewLocation(loc);
  const thumb3d = (loc as { thumb?: { storagePath?: string } } | null)?.thumb?.storagePath ?? null;
  const thumb2d = (loc as { thumb2d?: { storagePath?: string } } | null)?.thumb2d?.storagePath ?? null;
  const openSheet = (ref: Parameters<typeof resolveSheetRefOpen>[0]) => {
    const res = resolveSheetRefOpen(ref, catalog);
    if (!res.ok) return setNotice(res.message);
    setNotice(null);
    navigate(`/plans/${encodeURIComponent(ref.pdfFileId)}${ref.page ? `?page=${ref.page}` : ""}`);
  };
  const editable = canEdit(status);
  const taskPhotos = task.photos ?? [];
  const overdue = isOverdueDeadline(task.deadline ?? null, status, now);

  return (
    <article className="task-detail pad" data-testid="task-detail" data-task-id={task.id} data-status={status}>
      {onBack && (
        <button type="button" className="back" onClick={onBack} data-testid="task-back">
          &lsaquo; Tasks
        </button>
      )}
      <header className="detail-head">
        <p className="muted">
          {numLabel(task.num)} <SyncBadge pending={task.pending} failed={task.failed} />
        </p>
        <h2 data-testid="detail-title">{task.title}</h2>
        <div className="row-inline">
          <StatusChip status={status} />
          {canEdit(status) && (
            <Link to={`/tasks/${task.id}/edit`} className="btn" data-testid="task-edit">
              Edit
            </Link>
          )}
          {canComment(status) && availableSources(loc as never).length > 0 && (
            <Link to={`/tasks/${encodeURIComponent(task.id)}/markup`} className="btn" data-testid="task-markup-create">
              Create markup
            </Link>
          )}
          <button type="button" className="btn" data-testid="task-export" onClick={() => setExportOpen(true)}>
            Export
          </button>
        </div>
      </header>

      <dl className="kv">
        <dt>Assignee</dt>
        <dd>
          <button type="button" className="link-btn" data-testid="assignee-button" disabled={!canEdit(status)} onClick={() => setPicker(true)}>
            <Avatar name={task.assigneeName} /> {task.assigneeName ?? "Unassigned"}
          </button>
        </dd>
        {task.type && task.type !== "task" && (
          <>
            <dt>Type</dt>
            <dd>{task.type}</dd>
          </>
        )}
        <dt>Deadline</dt>
        <dd className={overdue ? "is-overdue" : undefined}>{task.deadline ? `${fmtDate(task.deadline)}${overdue ? " (overdue)" : ""}` : "None"}</dd>
        <dt>Building</dt>
        <dd data-testid="detail-building">{effBuildingId ? (buildingNames.get(effBuildingId) ?? effBuildingId) : "None"}</dd>
        <PriorityRow task={task} editable={editable} onEdit={editFields} />
        {loc?.storeyName && (
          <>
            <dt>Storey</dt>
            <dd>{loc.storeyName}</dd>
          </>
        )}
        {task.createdBy && (
          <>
            <dt>Created by</dt>
            <dd>{task.createdBy}</dd>
          </>
        )}
      </dl>

      {task.description ? <p className="description">{task.description}</p> : null}

      {(anchor || loc?.text || loc?.pdf || loc?.bim) && (
        <div className="loc-chips" data-testid="location-chips" data-dual={dual ? "1" : "0"}>
          {thumb2d && plan && <LocThumb path={thumb2d} resolver={resolver} to={plan} label="Plan snapshot" testId="loc-thumb-plan" />}
          {thumb3d && (dual ? model : (model ?? plan)) && <LocThumb path={thumb3d} resolver={resolver} to={(dual ? model : (model ?? plan)) as string} label="Location snapshot" testId="loc-thumb-model" />}
          {plan && (
            <Link to={plan} className="loc-chip" data-testid="loc-plan">
              Show on plan{(loc?.pdf as { page?: number } | null | undefined)?.page ? `, page ${(loc?.pdf as { page: number }).page}` : ""}
            </Link>
          )}
          {model && (
            <Link to={model} className="loc-chip" data-testid="loc-model">
              Show in model
            </Link>
          )}
          {loc?.text && <span className="loc-chip">{loc.text}</span>}
        </div>
      )}

      <ChecklistSection task={task} editable={editable} onEdit={editFields} />
      <SheetsSection task={task} catalog={catalog} editable={editable} onEdit={editFields} onOpen={openSheet} />
      {notice && (
        <p className="error" role="alert" data-testid="sheet-notice">
          {notice}
        </p>
      )}
      <WatchersSection task={task} members={members} actorUid={actor.uid ?? null} editable={editable} onEdit={editFields} />

      {derived.markups.length > 0 && (
        <section data-testid="task-markups-section">
          <h3>Markups</h3>
          <div className="photo-grid" data-testid="task-markups" data-count={derived.markups.length}>
            {derived.markups.map((m) => (
              <MarkupThumb key={m.id} markup={m} resolver={resolver} blobKey={pendingKeys.get(m.path)} onOpen={(url) => setMarkupView({ markup: m, url })} />
            ))}
          </div>
        </section>
      )}

      {taskPhotos.length > 0 && (
        <section>
          <h3>Photos</h3>
          <div className="photo-grid" data-testid="task-photos">
            {taskPhotos.map((p) => (
              <PhotoThumb key={p.storagePath} storagePath={p.storagePath} blobKey={pendingKeys.get(p.storagePath)} resolver={resolver} onOpen={setLightbox} />
            ))}
          </div>
        </section>
      )}

      {actions.length > 0 && (
        <section>
          <h3>Change status</h3>
          <div className="status-actions" data-testid="status-actions">
            {actions.map((a) => (
              <button
                key={a.verb}
                type="button"
                className={`btn${a.tone === "primary" ? " primary" : ""}${a.tone === "danger" ? " danger" : ""}`}
                data-testid={`action-${a.verb}`}
                onClick={() => (a.tone === "danger" ? setConfirm(a.verb) : void once(() => act(a.verb)))}
              >
                {a.label}
              </button>
            ))}
          </div>
        </section>
      )}
      {actions.length === 0 && <p className="muted">This task is closed. Closed tasks accept no further changes.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section>
        <h3>Timeline</h3>
        <ol className="timeline" data-testid="timeline">
          {entries.map((e) => {
            const badge = transitionBadge(e.statusFrom, e.statusTo);
            const mk = derived.markupEntries.get(e.id);
            const paths = mk ? [] : entryPaths(e);
            return (
              <li key={e.id} className={`tl-entry${e.pending ? " is-pending" : ""}${e.failed ? " is-failed" : ""}`} data-testid="timeline-entry" data-action={e.action}>
                <p className="tl-head">
                  <strong>{e.by}</strong> <span className="muted">{VERB_LABELS[e.action as TaskVerb] ?? e.action}</span>
                  <span className="muted tiny"> {fmtDateTime(e.at)}</span>
                  <SyncBadge pending={e.pending && !e.failed} failed={e.failed} />
                </p>
                {badge && <p className="tl-badge">{badge}</p>}
                {mk ? (
                  <p className="tl-text markup-entry-note" data-testid="timeline-markup" data-removed={mk.removed ? "1" : "0"}>
                    {mk.kind === "removed" ? "Removed a markup" : mk.removed ? "Added a markup (since removed)" : "Added a markup"}
                  </p>
                ) : e.text && e.action !== "create" ? (
                  <p className="tl-text">{e.text}</p>
                ) : null}
                {paths.length > 0 && (
                  <div className="photo-grid">
                    {paths.map((path) => (
                      <PhotoThumb key={path} storagePath={path} blobKey={pendingKeys.get(path)} resolver={resolver} onOpen={setLightbox} />
                    ))}
                  </div>
                )}
                {e.failed && engine && (
                  <button type="button" className="btn" onClick={() => void engine.retryNow(e.clientGuid)}>
                    Retry
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      {canComment(status) && (
        <section className="comment-box" data-testid="comment-box">
          <textarea
            className="input"
            rows={2}
            placeholder="Add a comment"
            aria-label="Add a comment"
            data-testid="comment-input"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <PhotoAttach key={commentKey} taskId={task.id} photos={commentPhotos} onChange={setCommentPhotos} />
          <button
            type="button"
            className="btn primary"
            data-testid="comment-send"
            disabled={!comment.trim() && commentPhotos.length === 0}
            onClick={() => void sendComment()}
          >
            Post comment
          </button>
        </section>
      )}

      {picker && (
        <Sheet title="Assign to" onClose={() => setPicker(false)} testId="assignee-sheet">
          <ul className="list">
            <li>
              <button type="button" className="row" data-testid="assignee-none" onClick={() => void assign(null)}>
                Unassigned
              </button>
            </li>
            {members.map((m) => (
              <li key={m.uid}>
                <button type="button" className="row" data-testid={`assignee-${m.uid}`} onClick={() => void assign(m.uid)}>
                  <Avatar name={m.name} /> {m.name}
                  {task.assigneeUid === m.uid && <span className="muted"> (current)</span>}
                </button>
              </li>
            ))}
          </ul>
          {!canAssign(status) && <p className="muted tiny">Assignment is recorded as an edit in this status.</p>}
        </Sheet>
      )}
      {confirm && (
        <Sheet title="Discontinue this task?" onClose={() => setConfirm(null)} testId="confirm-sheet">
          <p>Discontinued tasks are closed and cannot be reopened.</p>
          <div className="sheet-actions">
            <button
              type="button"
              className="btn danger"
              data-testid="confirm-discontinue"
              onClick={() => {
                void once(() => act(confirm));
                setConfirm(null);
              }}
            >
              Discontinue
            </button>
          </div>
        </Sheet>
      )}
      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
      {markupView && (
        <MarkupViewer
          url={markupView.url}
          canDelete={canComment(status) && !!engine && !!pid}
          onClose={() => setMarkupView(null)}
          onDelete={async () => {
            if (!engine || !pid) throw new Error("The task engine is not ready.");
            await removeMarkup({ engine, projectId: pid, taskId, title: task.title, statusFrom: task.status as TaskStatus, actor }, markupView.markup.key);
          }}
        />
      )}
      {exportOpen && (
        <ConnectedExportSheet
          note={() => "Single task"}
          rows={[{ ...task, buildingName: effBuildingId ? (buildingNames.get(effBuildingId) ?? null) : null, storeyName: loc?.storeyName ?? null }]}
          scopeLabel="This task"
          onClose={() => setExportOpen(false)}
        />
      )}
    </article>
  );
}

/** A location snapshot that opens the view it was taken in. */
function LocThumb({ path, resolver, to, label, testId }: { path: string; resolver: Parameters<typeof usePhotoUrl>[0]; to: string; label: string; testId: string }) {
  const url = usePhotoUrl(resolver, path);
  if (!url) return null;
  return (
    <Link to={to} className="loc-thumb" aria-label={label} data-testid={testId}>
      <img src={url} alt={label} />
    </Link>
  );
}
