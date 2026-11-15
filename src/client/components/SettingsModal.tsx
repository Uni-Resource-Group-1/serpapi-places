import { useEffect, useState, type FormEvent } from "react";
import type { AppSettings } from "../../shared/types.js";
import { api, ApiError, type SettingsPayload } from "../api.js";
import { formatDateTime, formatUsd, percent } from "../format.js";
import { Modal } from "./Modal.js";
import { Spinner } from "./Feedback.js";

interface SettingsModalProps {
  onClose: () => void;
  onSaved: () => void;
  onNotify: (kind: "info" | "success" | "error", message: string) => void;
}

export function SettingsModal({ onClose, onSaved, onNotify }: SettingsModalProps) {
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [form, setForm] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((result) => {
        if (cancelled) return;
        setPayload(result);
        setForm({
          serpapiMonthlyLimit: result.settings.serpapiMonthlyLimit,
          serpapiDailyLimit: result.settings.serpapiDailyLimit,
          serpapiMaxPages: result.settings.serpapiMaxPages,
          serpapiMaxResults: result.settings.serpapiMaxResults,
          serpapiPriceUsd: result.settings.serpapiPriceUsd,
        });
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof ApiError ? caught.message : "Could not load settings.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (key: keyof AppSettings, value: number) => {
    if (!form) return;
    setForm({ ...form, [key]: Number.isFinite(value) ? value : 0 });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || !payload) return;
    const limits = payload.hardLimits;
    if (form.serpapiMonthlyLimit > limits.monthly) {
      setError(`Monthly limit cannot exceed the server hard cap of ${limits.monthly}.`);
      return;
    }
    if (form.serpapiDailyLimit > limits.daily) {
      setError(`Daily limit cannot exceed the server hard cap of ${limits.daily}.`);
      return;
    }
    if (form.serpapiMaxPages > limits.maxPages || form.serpapiMaxPages < 1) {
      setError(`Pages per run must be between 1 and ${limits.maxPages}.`);
      return;
    }
    if (form.serpapiMaxResults > limits.maxResults || form.serpapiMaxResults < 20) {
      setError(`Results per run must be between 20 and ${limits.maxResults}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateSettings(form);
      onNotify("success", "SerpApi limits saved.");
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save settings.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Budget and data settings"
      subtitle="Limits apply to everyone using this workspace and are enforced again by server hard caps."
      onClose={onClose}
      size="medium"
    >
      {!payload || !form ? (
        error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : (
          <div className="modal-loading" role="status">
            <Spinner label="Loading settings" /> Loading settings…
          </div>
        )
      ) : (
        <form onSubmit={submit} className="settings-form" noValidate>
          <section className="settings-section" aria-labelledby="usage-heading">
            <h3 id="usage-heading">Current SerpApi usage</h3>
            <div className="usage">
              <div className="usage__row">
                <span>Monthly ({payload.usage.month.period})</span>
                <strong>
                  {payload.usage.month.used} / {payload.usage.month.limit}
                </strong>
              </div>
              <div className="meter" aria-hidden="true">
                <span className="meter__fill" style={{ width: `${percent(payload.usage.month.used, payload.usage.month.limit)}%` }} />
              </div>
              <div className="usage__row">
                <span>Daily ({payload.usage.day.period})</span>
                <strong>
                  {payload.usage.day.used} / {payload.usage.day.limit}
                </strong>
              </div>
              <div className="meter" aria-hidden="true">
                <span className="meter__fill" style={{ width: `${percent(payload.usage.day.used, payload.usage.day.limit)}%` }} />
              </div>
              <div className="usage__row usage__row--muted">
                <span>Estimated spend this month</span>
                <span>{formatUsd(payload.usage.estimatedCostUsd)}</span>
              </div>
              <p className="field__hint">
                Counters reset at UTC month and day boundaries. Requests are reserved before provider dispatch and
                ambiguous outcomes remain counted.
              </p>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="limits-heading">
            <h3 id="limits-heading">Request and result limits</h3>
            <div className="field-grid">
              <div className="field">
                <label htmlFor="monthly-limit">Monthly requests</label>
                <input
                  id="monthly-limit"
                  type="number"
                  min={0}
                  max={payload.hardLimits.monthly}
                  step={1}
                  value={form.serpapiMonthlyLimit}
                  onChange={(event) => update("serpapiMonthlyLimit", Number(event.target.value))}
                />
                <p className="field__hint">Hard cap {payload.hardLimits.monthly}</p>
              </div>
              <div className="field">
                <label htmlFor="daily-limit">Daily requests</label>
                <input
                  id="daily-limit"
                  type="number"
                  min={0}
                  max={payload.hardLimits.daily}
                  step={1}
                  value={form.serpapiDailyLimit}
                  onChange={(event) => update("serpapiDailyLimit", Number(event.target.value))}
                />
                <p className="field__hint">Hard cap {payload.hardLimits.daily}</p>
              </div>
              <div className="field">
                <label htmlFor="max-pages">Pages per run</label>
                <input
                  id="max-pages"
                  type="number"
                  min={1}
                  max={payload.hardLimits.maxPages}
                  step={1}
                  value={form.serpapiMaxPages}
                  onChange={(event) => update("serpapiMaxPages", Number(event.target.value))}
                />
                <p className="field__hint">Hard cap {payload.hardLimits.maxPages}</p>
              </div>
              <div className="field">
                <label htmlFor="max-results">Results per source per run</label>
                <input
                  id="max-results"
                  type="number"
                  min={20}
                  max={payload.hardLimits.maxResults}
                  step={20}
                  value={form.serpapiMaxResults}
                  onChange={(event) => update("serpapiMaxResults", Number(event.target.value))}
                />
                <p className="field__hint">Hard cap {payload.hardLimits.maxResults}</p>
              </div>
              <div className="field">
                <label htmlFor="price">Price per SerpApi search (USD)</label>
                <input
                  id="price"
                  type="number"
                  min={0}
                  max={100}
                  step={0.001}
                  value={form.serpapiPriceUsd}
                  onChange={(event) => update("serpapiPriceUsd", Number(event.target.value))}
                />
                <p className="field__hint">Used only for estimates, not billing.</p>
              </div>
            </div>
            <p className="field__hint">
              Last updated {formatDateTime(payload.settings.updatedAt)}
              {payload.settings.updatedBy ? ` by ${payload.settings.updatedBy}` : ""}.
            </p>
          </section>

          <section className="settings-section" aria-labelledby="policy-heading">
            <h3 id="policy-heading">Data policy (server environment)</h3>
            <dl className="policy-list">
              <div>
                <dt>Reviews</dt>
                <dd>
                  {payload.policy.reviewsEnabled ? "Enabled" : "Disabled"} ·{" "}
                  {payload.policy.reviewRetentionDays > 0
                    ? `retention ${payload.policy.reviewRetentionDays} days`
                    : "no automatic expiry"}
                  . Stored reviews can be downloaded when the export includes the reviews field.
                </dd>
              </div>
              <div>
                <dt>SerpApi exports</dt>
                <dd>
                  {payload.policy.serpapiExportEnabled
                    ? "Enabled. Place and stored review records export for this workspace's own use."
                    : "Disabled by the server policy flag. OSM data can still be exported; SerpApi rows are omitted with a manifest note."}
                </dd>
              </div>
              <div>
                <dt>SerpApi record retention</dt>
                <dd>
                  {payload.policy.serpapiStorageDays > 0
                    ? `${payload.policy.serpapiStorageDays} days before cached SerpApi records expire.`
                    : "No automatic expiry. Records remain until deleted."}
                </dd>
              </div>
              <div>
                <dt>Page cache</dt>
                <dd>{payload.policy.cacheTtlSeconds} seconds. Zero means every run is a fresh paid request.</dd>
              </div>
            </dl>
            <p className="field__hint">
              These flags come from server-side environment variables and cannot be changed from the browser. The
              SerpApi key itself never leaves the server.
            </p>
          </section>

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="modal-actions">
            <button type="button" className="button button--ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button button--primary" disabled={busy}>
              {busy ? "Saving…" : "Save settings"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
