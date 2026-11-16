import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type AuthSessionInfo, type PublicStatus } from "../api.js";
import { MapPinIcon } from "./icons.js";

interface LoginScreenProps {
  onAuthenticated: (session: AuthSessionInfo) => void;
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const [displayName, setDisplayName] = useState(() => localStorage.getItem("pd.displayName") ?? "");
  const [accessKey, setAccessKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<PublicStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .publicStatus()
      .then((result) => {
        if (!cancelled) setStatus(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!displayName.trim() || !accessKey) {
      setError("Enter your name and the shared access key.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await api.login(accessKey, displayName.trim());
      localStorage.setItem("pd.displayName", session.displayName);
      onAuthenticated(session);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <section className="login__hero" aria-labelledby="login-title">
        <div className="login__brand">
          <span className="brand-mark" aria-hidden="true">
            <MapPinIcon size={18} />
          </span>
          Places Discovery
        </div>
        <h1 id="login-title">Research places with OpenStreetMap and SerpApi Google Maps.</h1>
        <p>
          Search a neighbourhood, compare two sources on one map, save places into collections, and export
          research data with provenance and honest coverage caveats.
        </p>
        <ul className="login__points">
          <li>Separate OSM and SerpApi layers, never blended into one “Google” layer.</li>
          <li>Server-side credentials; the browser never receives the SerpApi key.</li>
          <li>Explicit request budgets and page caps for paid SerpApi searches.</li>
        </ul>
        {status && !status.serpapiConfigured ? (
          <p className="login__warning" role="status">
            SerpApi is not configured on this server. OSM searches will work; SerpApi searches will be skipped
            until the owner adds a server-side API key.
          </p>
        ) : null}
      </section>

      <section className="login__panel" aria-labelledby="login-form-title">
        <form onSubmit={submit} noValidate>
          <h2 id="login-form-title">Sign in</h2>
          <p className="login__hint">
            This workspace uses one shared access key with named sessions. Use your own name so saved work and
            audit history stay attributable.
          </p>
          <div className="field">
            <label htmlFor="login-name">Your name</label>
            <input
              id="login-name"
              name="displayName"
              autoComplete="name"
              maxLength={80}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="login-key">Access key</label>
            <input
              id="login-key"
              name="accessKey"
              type="password"
              autoComplete="current-password"
              value={accessKey}
              onChange={(event) => setAccessKey(event.target.value)}
              required
            />
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="button button--primary button--wide" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <p className="login__footnote">
            Sessions are HTTP-only cookies. Up to five named sessions are kept at once; older sessions are
            removed when the limit is reached.
          </p>
        </form>
      </section>
    </div>
  );
}
