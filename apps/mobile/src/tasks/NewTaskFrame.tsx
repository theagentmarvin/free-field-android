import { useEffect, useRef, type ReactNode } from "react";

/**
 * The dedicated New task screen, laid out like the web compose sheet: a top bar (close, title), a scrolling body of cards and
 * a sticky bottom bar with the primary action. It fills the whole content area (the app shell hides its header and navigation
 * for it) so the task list is never beside it, in either orientation. The body is the only scroller, so with the soft
 * keyboard up (the shell resizes the content area) the bottom bar stays visible and the focused field is scrolled into view.
 */
export function NewTaskFrame({
  children,
  status,
  onClose,
  onSubmit,
  onDiscard,
  submitting,
}: {
  children: ReactNode;
  status: ReactNode;
  onClose: () => void;
  onSubmit: () => void;
  onDiscard: () => void;
  submitting: boolean;
}) {
  const body = useRef<HTMLDivElement>(null);

  // keep the focused field above the soft keyboard: after the viewport resizes, scroll it to the middle of the body
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    let target: Element | null = null;
    const field = (t: EventTarget | null) => (t instanceof HTMLElement && t.matches("input, textarea, select") ? t : null);
    const onFocus = (e: FocusEvent) => {
      target = field(e.target);
      if (target) setTimeout(() => target?.scrollIntoView({ block: "center", behavior: "auto" }), 250);
    };
    const onResize = () => {
      if (target && document.activeElement === target) target.scrollIntoView({ block: "center", behavior: "auto" });
    };
    el.addEventListener("focusin", onFocus);
    window.addEventListener("resize", onResize);
    return () => {
      el.removeEventListener("focusin", onFocus);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <form
      className="newtask"
      data-testid="task-form"
      role="dialog"
      aria-label="New task"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(); // an empty title is reported by the form itself, next to the field
      }}
    >
      <header className="newtask-top">
        <button type="button" className="newtask-close" aria-label="Close" data-testid="task-back" onClick={onClose}>
          &times;
        </button>
        <h2>
          New task <span className="muted tiny">draft, numbered when sent</span>
        </h2>
        <span className="newtask-spacer" aria-hidden />
      </header>
      <div className="newtask-body" ref={body} data-testid="new-task-body">
        <div className="newtask-cards">{children}</div>
      </div>
      <footer className="newtask-bottom">
        <button type="submit" className="btn primary newtask-send" data-testid="task-submit" disabled={submitting}>
          {submitting ? "Creating…" : "Create task"}
        </button>
        <button type="button" className="btn" data-testid="task-discard" onClick={onDiscard}>
          Discard draft
        </button>
        {status}
      </footer>
    </form>
  );
}

export function NewTaskCard({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section className="newtask-card" data-testid={testId}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}
