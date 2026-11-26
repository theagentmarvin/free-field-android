import { useState, type FormEvent } from "react";
import { isDemoAuth, useAuthContext } from "@ff/auth";
import { signInSession } from "../session";
import { isPlausibleEmail, requestSignInLink } from "../auth/emailLink";
import { useLinkStore } from "../auth/linkStore";
import { useLinkCompletion } from "../auth/useLinkCompletion";

export function SignInPage() {
  return (
    <div className="center-screen">
      <h1>FreeField Field</h1>
      <p className="muted">Site tasks, plans and models, online or offline.</p>
      {isDemoAuth() ? <DemoSignIn /> : <EmailLinkSignIn />}
    </div>
  );
}

function DemoSignIn() {
  return (
    <button className="btn primary" data-testid="demo-signin" onClick={signInSession}>
      Continue in demo mode
    </button>
  );
}

function EmailLinkSignIn() {
  const { auth } = useAuthContext();
  const complete = useLinkCompletion();
  const { pendingUrl, completing, error: linkError } = useLinkStore();
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isPlausibleEmail(email)) {
      setError("Enter a valid email address.");
      return;
    }
    setSending(true);
    try {
      if (pendingUrl) {
        // A link already arrived but the address was unknown: finish with what was typed.
        await complete(pendingUrl, email);
      } else {
        setSentTo(await requestSignInLink(auth, email, window.localStorage));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  if (completing) return <p className="muted" data-testid="signin-completing">Signing you in…</p>;

  if (sentTo && !pendingUrl) {
    return (
      <div data-testid="signin-sent">
        <p>
          We sent a sign-in link to <strong>{sentTo}</strong>. Open it on this device to continue.
        </p>
        <button className="btn" data-testid="signin-retry" onClick={() => setSentTo(null)}>
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="center-screen" style={{ minHeight: 0, padding: 0 }} data-testid="signin-form">
      {pendingUrl && <p className="muted">Enter the email address the link was sent to.</p>}
      <input
        className="field"
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder="you@example.com"
        data-testid="signin-email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button className="btn primary" type="submit" disabled={sending} data-testid="signin-submit">
        {sending ? "Working…" : pendingUrl ? "Finish sign-in" : "Email me a sign-in link"}
      </button>
      {(error ?? linkError) && (
        <p className="error" role="alert" data-testid="signin-error">
          {error ?? linkError}
        </p>
      )}
    </form>
  );
}
