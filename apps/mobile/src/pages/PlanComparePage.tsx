import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useAuthContext } from "@ff/auth";
import { getBlobStore } from "../storage";
import { usePlanRecord } from "../plans/usePlans";
import { defaultComparePair, formatRevisionDate, listRevisions } from "../plans/revisions";
import { getTileService } from "../plans/tileService";
import { toVersionRef } from "../plans/planModel";
import { CompareView } from "../plans/compare/CompareView";
import { useCompareSession } from "../plans/compare/useCompareSession";
import { changeLabel, summarizeChanges, type CompareDiff } from "../plans/compare/diff";
import type { CompareMode } from "../plans/compare/drawCompare";
import { MISALIGNED_MESSAGE } from "../plans/compare/webCompare";
import { useRevisionDownload } from "../plans/RevisionSheet";

const MODES: { id: CompareMode; label: string; hint: string }[] = [
  { id: "overlay", label: "Overlay", hint: "Both revisions in one picture: red only in the older one, blue only in the newer one" },
  { id: "swipe", label: "Swipe", hint: "Drag the divider: the older revision on the left, the newer one on the right" },
  { id: "changes", label: "Changes", hint: "The newer revision with every change outlined; step through them" },
];

/**
 * Route `/plans/:pdfFileId/compare?base=<versionId>&rev=<versionId>`: compare two revisions of a plan on the
 * device. Works offline (both PDFs are on the device; tiles are rendered on demand). One shared pan/zoom drives
 * both revisions. See docs/spikes/plan-revisions.md.
 */
export function PlanComparePage() {
  const { pdfFileId = "" } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const rec = usePlanRecord(pdfFileId);
  const { project } = useAuthContext();
  const store = getBlobStore();
  const download = useRevisionDownload(project?.id ?? null, rec?.file?.buildingId);
  const [mode, setMode] = useState<CompareMode>("overlay");
  const [selected, setSelected] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  const revisions = useMemo(() => listRevisions(rec?.versions ?? [], rec?.onDevice ?? null), [rec?.versions, rec?.onDevice]);
  const fallback = useMemo(() => defaultComparePair(revisions), [revisions]);
  const baseId = search.get("base") ?? fallback?.base;
  const revId = search.get("rev") ?? fallback?.revision;
  const baseV = rec?.versions.find((v) => v.id === baseId);
  const revV = rec?.versions.find((v) => v.id === revId);
  const baseOn = !!baseV && revisions.find((r) => r.versionId === baseV.id)?.onDevice;
  const revOn = !!revV && revisions.find((r) => r.versionId === revV.id)?.onDevice;
  const usable = !!baseV && !!revV && baseV.id !== revV.id && baseOn && revOn;

  const session = useCompareSession(rec?.file, usable ? baseV : undefined, usable ? revV : undefined, store);

  useEffect(() => setSelected(null), [baseId, revId]);

  const setPair = useCallback(
    (b: string | undefined, r: string | undefined) => {
      const next = new URLSearchParams(search);
      if (b) next.set("base", b);
      if (r) next.set("rev", r);
      setSearch(next, { replace: true });
    },
    [search, setSearch],
  );

  const regions = useMemo(() => (session.phase === "ready" ? session.diff.regions : []), [session]);
  const step = useCallback(
    (d: 1 | -1) => {
      if (regions.length === 0) return;
      const idx = selected == null ? (d > 0 ? 0 : regions.length - 1) : (regions.findIndex((r) => r.id === selected) + d + regions.length) % regions.length;
      setSelected(regions[idx].id);
      setNonce((n) => n + 1);
    },
    [regions, selected],
  );
  const onSelectRegion = useCallback((id: number | null) => {
    setSelected(id);
    if (id != null) setNonce((n) => n + 1);
  }, []);

  const backTo = revV && !revV.isLatest ? `/plans/${pdfFileId}?rev=${revV.id}` : `/plans/${pdfFileId}`;
  const back = (
    <Link to={backTo} className="back" data-testid="compare-back">
      ‹ Plan
    </Link>
  );
  if (rec === undefined) return <p className="muted pad">Loading…</p>;
  if (!rec.file) {
    return (
      <div>
        <Link to="/plans" className="back">‹ Plans</Link>
        <p className="muted pad">Plan not found.</p>
      </div>
    );
  }

  const opt = (v: (typeof revisions)[number]) => `Revision ${v.number}${v.isLatest ? " (latest)" : ""} · ${v.name}${v.storedAt ? ` · ${formatRevisionDate(v.storedAt)}` : ""}${v.onDevice ? "" : " (not on device)"}`;
  const label = (v: { versionNumber: number } | undefined) => (v ? `Revision ${v.versionNumber}` : "");
  const summary = session.phase === "ready" ? summarizeChanges(session.diff.regions) : null;
  const sel = regions.find((r) => r.id === selected);

  return (
    <div className="plan-page cmp-page" data-testid="compare-page" data-plan-name={rec.file.name} data-phase={session.phase} data-mode={mode}>
      <div className="plan-bar">
        {back}
        <strong className="grow">Compare · {rec.file.name}</strong>
      </div>
      <div className="cmp-controls">
        <label className="cmp-pick">
          <span className="muted">Older</span>
          <select className="field" data-testid="compare-base" value={baseId ?? ""} onChange={(e) => setPair(e.target.value, revId)}>
            {revisions.map((r) => (
              <option key={r.versionId} value={r.versionId} disabled={!r.onDevice}>
                {opt(r)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn" data-testid="compare-swap" aria-label="Swap revisions" onClick={() => setPair(revId, baseId)}>
          ⇄
        </button>
        <label className="cmp-pick">
          <span className="muted">Newer</span>
          <select className="field" data-testid="compare-rev" value={revId ?? ""} onChange={(e) => setPair(baseId, e.target.value)}>
            {revisions.map((r) => (
              <option key={r.versionId} value={r.versionId} disabled={!r.onDevice}>
                {opt(r)}
              </option>
            ))}
          </select>
        </label>
        <div className="cmp-modes" role="group" aria-label="Compare mode">
          {MODES.map((m) => (
            <button key={m.id} type="button" className={`btn${mode === m.id ? " primary" : ""}`} data-testid={`compare-mode-${m.id}`} aria-pressed={mode === m.id} title={m.hint} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {!usable ? (
        <div className="center-screen" data-testid="compare-unavailable">
          {revisions.length < 2 ? (
            <p>This plan has only one revision, so there is nothing to compare.</p>
          ) : baseV && revV && baseV.id === revV.id ? (
            <p>Pick two different revisions.</p>
          ) : (
            <>
              <p>{baseV && !baseOn ? label(baseV) : label(revV)} is not on this device yet.</p>
              <p className="muted">{download.online ? "Download it, then compare, also without a connection later." : "You are offline. Connect to download it."}</p>
              {download.notice && <p className="error">{download.notice}</p>}
              <button type="button" className="btn primary" data-testid="revision-download" disabled={download.busy || !download.online} onClick={() => void download.download()}>
                Download revisions
              </button>
            </>
          )}
        </div>
      ) : session.phase === "preparing" ? (
        <div className="center-screen" data-testid="compare-preparing">
          <p>Preparing the revisions for comparing…</p>
          <p className="muted">
            {label(baseV)}: {sideText(session.base)} · {label(revV)}: {sideText(session.revision)}
          </p>
        </div>
      ) : session.phase === "comparing" ? (
        <div className="center-screen" data-testid="compare-comparing">
          <p>Lining up the drawings and finding the changes…</p>
        </div>
      ) : session.phase === "error" ? (
        <div className="center-screen" data-testid="compare-error">
          <p className="error">Could not compare: {session.message}</p>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              for (const v of [baseV, revV]) if (v && rec.file) void getTileService().ensureTiles(toVersionRef(rec.file, v)).catch(() => undefined);
            }}
          >
            Retry
          </button>
          <button type="button" className="btn" onClick={() => navigate(backTo)}>
            Back to the plan
          </button>
        </div>
      ) : (
        <>
          <CompareView
            store={store}
            base={{ manifest: session.base, label: label(baseV) }}
            revision={{ manifest: session.revision, label: label(revV) }}
            diff={session.diff}
            mode={mode}
            selectedId={selected}
            focusNonce={nonce}
            onSelectRegion={onSelectRegion}
          />
          <div className="cmp-bar" data-testid="compare-bar">
            <span className="grow" data-testid="compare-summary" data-changes={summary?.total ?? 0}>
              {summary && summary.total > 0
                ? `${summary.total} change${summary.total === 1 ? "" : "s"}${summary.added ? ` · ${summary.added} added` : ""}${summary.removed ? ` · ${summary.removed} removed` : ""}${summary.modified ? ` · ${summary.modified} modified` : ""}`
                : "No differences found"}
            </span>
            {mode === "changes" && summary && summary.total > 0 && (
              <>
                <span className="muted" data-testid="compare-current">
                  {sel ? `#${sel.id} ${changeLabel(sel)}` : "Tap a change"}
                </span>
                <button type="button" className="btn" data-testid="compare-prev" aria-label="Previous change" onClick={() => step(-1)}>
                  ‹
                </button>
                <button type="button" className="btn" data-testid="compare-next" aria-label="Next change" onClick={() => step(1)}>
                  ›
                </button>
              </>
            )}
          </div>
          <Notices diff={session.diff} />
        </>
      )}
    </div>
  );
}

function sideText(s: { state: string; fraction: number }): string {
  if (s.state === "ready") return "ready";
  if (s.state === "rendering") return `rendering ${Math.round(s.fraction * 100)}%`;
  return "waiting";
}

function Notices({ diff }: { diff: CompareDiff }) {
  const notes: string[] = [];
  const moved = Math.hypot(diff.offsetPt.x, diff.offsetPt.y);
  if (moved >= 1) notes.push(`The newer drawing was shifted ${moved.toFixed(0)} pt to line up with the older one.`);
  if (Math.abs(diff.frame.s - 1) > 1e-6) notes.push("The newer drawing has a different size and was scaled to the older one.");
  if (diff.aspectMismatch) notes.push("The page proportions differ; differences near the edges may not be real.");
  if (diff.looksMisaligned) notes.push(MISALIGNED_MESSAGE);
  if (notes.length === 0) return null;
  return (
    <ul className="cmp-notes muted" data-testid="compare-notice">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}
