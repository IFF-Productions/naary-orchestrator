import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Button, Icon, Logo } from "../components";
import { api, type FormDefinition, type FormFieldView } from "../lib/api";

/**
 * PUBLIC hosted form (Form Trigger mini-program, slice 3). Reached at `/f/:formId`, OUTSIDE
 * RequireAuth — an anonymous visitor loads the definition, fills it, and submits, which starts
 * the tenant's workflow with the sanitized fields as the trigger input. No auth, no tenant/
 * workflow identifiers are ever shown (the definition endpoint returns none). The server is the
 * source of truth for validation; the light client checks (required, type=number/email) are just
 * for a friendlier UX before the round-trip.
 */
export function FormPage() {
  const { formId } = useParams<{ formId: string }>();
  const [def, setDef] = useState<FormDefinition | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "notfound">(
    "loading",
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!formId) return;
    try {
      setDef(await api.getFormDefinition(formId));
      setState("ready");
    } catch {
      // Unknown form, unseeded graph, or a graph whose entry isn't a formTrigger all 404 here.
      setState("notfound");
    }
  }, [formId]);

  useEffect(() => {
    void load();
  }, [load]);

  function set(key: string, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  async function submit() {
    if (!def || !formId) return;
    // Light client-side required check (the server re-validates authoritatively).
    const missing = def.fields.find(
      (f) => f.required && !(values[f.key] ?? "").trim(),
    );
    if (missing) {
      setError(`Please fill in "${missing.label}".`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Send only non-empty values; strings throughout (the server coerces numbers).
      const data: Record<string, string> = {};
      for (const f of def.fields) {
        const raw = (values[f.key] ?? "").trim();
        if (raw !== "") data[f.key] = raw;
      }
      await api.submitForm(formId, data);
      setSubmitted(true);
    } catch (e) {
      // A 400 means the server rejected a value (e.g. a malformed email past the light check).
      setError(
        e instanceof Error && /400/.test(e.message)
          ? "Some answers weren't valid — please check and try again."
          : "Could not submit the form. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "48px 20px",
      }}
    >
      <div style={{ marginBottom: 28 }}>
        <Logo />
      </div>

      <div
        style={{
          width: "100%",
          maxWidth: 520,
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-card)",
          padding: 28,
        }}
      >
        {state === "loading" && (
          <div style={{ color: "var(--ink-3)", fontSize: "var(--text-body)" }}>
            Loading…
          </div>
        )}

        {state === "notfound" && (
          <div style={{ textAlign: "center", padding: "24px 8px" }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: "var(--radius-full)",
                background: "var(--card-2)",
                color: "var(--ink-3)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 14,
              }}
            >
              <Icon name="alert" size={20} />
            </div>
            <div
              style={{
                fontSize: "var(--text-md)",
                fontWeight: "var(--weight-semibold)",
                color: "var(--ink)",
                marginBottom: 6,
              }}
            >
              Form not found
            </div>
            <div
              style={{ fontSize: "var(--text-body)", color: "var(--ink-3)" }}
            >
              This form doesn't exist or is no longer available.
            </div>
          </div>
        )}

        {state === "ready" && def && submitted && (
          <div style={{ textAlign: "center", padding: "24px 8px" }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: "var(--radius-full)",
                background:
                  "color-mix(in srgb, var(--state-done) 18%, transparent)",
                color: "var(--state-done)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 16,
              }}
            >
              <Icon name="check" size={24} strokeWidth={3} />
            </div>
            <div
              style={{
                fontSize: "var(--text-md)",
                fontWeight: "var(--weight-semibold)",
                color: "var(--ink)",
                marginBottom: 6,
              }}
            >
              Thanks — we've got it.
            </div>
            <div
              style={{
                fontSize: "var(--text-body)",
                color: "var(--ink-3)",
                marginBottom: 20,
              }}
            >
              Your response was submitted.
            </div>
            <Button
              variant="secondary"
              onClick={() => {
                setValues({});
                setSubmitted(false);
              }}
            >
              Submit another response
            </Button>
          </div>
        )}

        {state === "ready" && def && !submitted && (
          <>
            <div
              style={{
                fontSize: "var(--text-title)",
                fontWeight: "var(--weight-bold)",
                color: "var(--ink)",
                letterSpacing: "var(--tracking-tight)",
              }}
            >
              {def.title ?? "Form"}
            </div>
            {def.description && (
              <div
                style={{
                  fontSize: "var(--text-body)",
                  color: "var(--ink-2)",
                  marginTop: 6,
                  lineHeight: "var(--leading-snug)",
                }}
              >
                {def.description}
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!submitting) void submit();
              }}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 16,
                marginTop: 22,
              }}
            >
              {def.fields.map((f) => (
                <FormField
                  key={f.key}
                  field={f}
                  value={values[f.key] ?? ""}
                  onChange={(v) => set(f.key, v)}
                />
              ))}

              {error && (
                <div
                  style={{
                    fontSize: "var(--text-sm)",
                    color: "var(--state-error)",
                  }}
                >
                  {error}
                </div>
              )}

              <Button
                type="submit"
                variant="primary"
                disabled={submitting}
                style={{ marginTop: 4 }}
              >
                {submitting ? "Submitting…" : (def.submitLabel ?? "Submit")}
              </Button>
            </form>
          </>
        )}
      </div>

      <div
        style={{
          marginTop: 20,
          fontSize: "var(--text-2xs)",
          color: "var(--ink-3)",
        }}
      >
        Powered by Naary
      </div>
    </div>
  );
}

const controlStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 11px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
  fontFamily: "inherit",
};

/** One rendered form control keyed by the field's declared type. Native elements (styled) so the
 *  page stays accessible and dependency-free. */
function FormField({
  field,
  value,
  onChange,
}: {
  field: FormFieldView;
  value: string;
  onChange: (v: string) => void;
}) {
  const label = (
    <label
      className="field-label"
      htmlFor={`f-${field.key}`}
      style={{ display: "block", marginBottom: 6 }}
    >
      {field.label}
      {field.required && (
        <span style={{ color: "var(--state-error)" }}> *</span>
      )}
    </label>
  );

  let control: React.ReactNode;
  if (field.type === "textarea") {
    control = (
      <textarea
        id={`f-${field.key}`}
        value={value}
        required={field.required}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        style={{ ...controlStyle, resize: "vertical" }}
      />
    );
  } else if (field.type === "select") {
    control = (
      <select
        id={`f-${field.key}`}
        value={value}
        required={field.required}
        onChange={(e) => onChange(e.target.value)}
        style={controlStyle}
      >
        <option value="" disabled>
          {field.placeholder ?? "Select…"}
        </option>
        {(field.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <input
        id={`f-${field.key}`}
        type={
          field.type === "number"
            ? "number"
            : field.type === "email"
              ? "email"
              : "text"
        }
        value={value}
        required={field.required}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={controlStyle}
      />
    );
  }

  return (
    <div>
      {label}
      {control}
    </div>
  );
}
