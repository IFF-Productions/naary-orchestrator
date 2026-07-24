import type { TemplateBlock } from "@naary/dsl";
import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { TemplateContentBlock } from "../components";
import { api, type FormDefinition, type FormFieldView } from "../lib/api";
import { useEmbedResize } from "../lib/embed-resize";
import { TurnstileWidget } from "./public/TurnstileWidget";
import {
  ButtonSpinner,
  EMBER_BUTTON,
  EMBER_TINT_BG,
  EmberBar,
  PUBLIC_CARD,
  PUBLIC_INPUT,
  PublicFrame,
  PublicNotice,
  ResultBadge,
  SecureFooter,
  BrandRow,
} from "./public/PublicShell";

/**
 * PUBLIC hosted form (Form Trigger mini-program, slice 3). Reached at `/f/:formId`, OUTSIDE
 * RequireAuth — an anonymous visitor loads the definition, fills it, and submits, which starts
 * the tenant's workflow with the sanitized fields as the trigger input. No auth, no tenant/
 * workflow identifiers are ever shown (the definition endpoint returns none). The server is the
 * source of truth for validation; the light client checks (required, type=number/email) are just
 * for a friendlier UX before the round-trip.
 *
 * Redesign: "Naary Public Pages" hosted-form card — 460px, ember top strip, brand tile header,
 * chip-select for enum fields, ember gradient submit, lock footer, green pop success state.
 */
export function FormPage() {
  const { formId } = useParams<{ formId: string }>();
  const [searchParams] = useSearchParams();
  const embed = searchParams.get("embed") === "1";
  useEmbedResize(embed, formId); // report height to the parent iframe when embedded
  const [def, setDef] = useState<FormDefinition | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "notfound">(
    "loading",
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Turnstile: a solved (single-use) token, and a counter to re-arm the widget after a failed submit.
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileReset, setTurnstileReset] = useState(0);

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
    // If the form is bot-gated, require a solved challenge before spending a round-trip.
    if (def.turnstileSiteKey && !turnstileToken) {
      setError("Please complete the verification.");
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
      await api.submitForm(formId, data, turnstileToken ?? undefined);
      setSubmitted(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      // The Turnstile token is single-use — a failed submit consumed it, so re-arm the widget for a
      // retry (the visitor re-solves; managed mode is usually silent).
      if (def.turnstileSiteKey) {
        setTurnstileToken(null);
        setTurnstileReset((n) => n + 1);
      }
      setError(
        /403/.test(msg)
          ? "Verification failed — please complete the check and try again."
          : /400/.test(msg)
            ? "Some answers weren't valid — please check and try again."
            : "Could not submit the form. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PublicFrame embed={embed}>
      <div style={{ width: "100%", maxWidth: 460 }}>
        {state === "loading" && (
          <div style={{ ...PUBLIC_CARD, overflow: "hidden" }}>
            <EmberBar />
            <div
              style={{
                padding: "36px 28px",
                fontSize: 13,
                color: "var(--ink-3)",
              }}
            >
              Loading…
            </div>
          </div>
        )}

        {state === "notfound" && (
          <div style={{ ...PUBLIC_CARD, padding: "36px 28px" }}>
            <PublicNotice
              icon="alert"
              title="Form not found"
              body="This form doesn't exist or is no longer available."
            />
          </div>
        )}

        {state === "ready" && def && submitted && (
          <div
            style={{
              ...PUBLIC_CARD,
              padding: "44px 32px",
              textAlign: "center",
            }}
          >
            <ResultBadge tone="ok" icon="check" />
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 18 }}>
              Request received
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--ink-2)",
                marginTop: 8,
                lineHeight: 1.6,
                maxWidth: 340,
                marginLeft: "auto",
                marginRight: "auto",
              }}
            >
              {/* The submit response carries only `status: "started"` — the workflow is running
                  (it may finish instantly or pause for a human), so the copy claims exactly that. */}
              Your response was submitted and the workflow has started. If a
              step needs a human decision, it will wait safely until someone
              decides.
            </div>
            <button
              onClick={() => {
                setValues({});
                setSubmitted(false);
              }}
              style={{
                marginTop: 22,
                height: 38,
                padding: "0 18px",
                borderRadius: 9,
                border: "1px solid var(--line-2)",
                background: "var(--card)",
                color: "var(--ink-2)",
                fontSize: 12.5,
                fontFamily: "var(--font-sans)",
                cursor: "pointer",
              }}
            >
              Submit another
            </button>
          </div>
        )}

        {state === "ready" && def && !submitted && (
          <div style={{ ...PUBLIC_CARD, overflow: "hidden" }}>
            <EmberBar />
            <div
              style={{
                padding: "26px 28px 20px",
                borderBottom: "1px solid var(--line)",
              }}
            >
              {/* The public definition carries no workspace/tenant name — brand tile only. */}
              <BrandRow />
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  letterSpacing: "-.01em",
                }}
              >
                {def.title ?? "Form"}
              </div>
              {def.description && (
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--ink-2)",
                    marginTop: 6,
                    lineHeight: 1.55,
                  }}
                >
                  {def.description}
                </div>
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!submitting) void submit();
              }}
              style={{ padding: "22px 28px" }}
            >
              {/* A template drives this form → render its blocks in the authored order (content
                  interleaved with inputs), matching the block editor's preview. Otherwise the flat
                  field list (an inline formTrigger form). */}
              {def.blocks
                ? def.blocks.map((b) =>
                    b.type === "field" ? (
                      <FormField
                        key={b.id}
                        field={fieldViewFromBlock(b)}
                        value={values[b.key] ?? ""}
                        onChange={(v) => set(b.key, v)}
                      />
                    ) : (
                      <div key={b.id} style={{ marginBottom: 14 }}>
                        <TemplateContentBlock block={b} />
                      </div>
                    ),
                  )
                : def.fields.map((f) => (
                    <FormField
                      key={f.key}
                      field={f}
                      value={values[f.key] ?? ""}
                      onChange={(v) => set(f.key, v)}
                    />
                  ))}

              {def.turnstileSiteKey && (
                <TurnstileWidget
                  siteKey={def.turnstileSiteKey}
                  onToken={setTurnstileToken}
                  onReset={() => setTurnstileToken(null)}
                  resetSignal={turnstileReset}
                />
              )}

              {error && (
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--state-error)",
                    marginBottom: 14,
                  }}
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={
                  submitting || Boolean(def.turnstileSiteKey && !turnstileToken)
                }
                style={{
                  ...EMBER_BUTTON,
                  width: "100%",
                  height: 46,
                  borderRadius: 11,
                  fontSize: 14,
                  fontWeight: 700,
                  fontFamily: "var(--font-sans)",
                  cursor: submitting ? "default" : "pointer",
                  opacity:
                    def.turnstileSiteKey && !turnstileToken ? 0.6 : undefined,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                {submitting && <ButtonSpinner />}
                {submitting
                  ? "Submitting…"
                  : (def.submitLabel ?? "Submit request")}
              </button>
              <div style={{ marginTop: 14 }}>
                <SecureFooter>Secure form · powered by Naary</SecureFooter>
              </div>
            </form>
          </div>
        )}
      </div>
    </PublicFrame>
  );
}

/** Map a template `field` block to the FormFieldView the renderer + submit path already use. The
 *  block model has no `placeholder`, so it's simply absent. Narrowed to `field` by the caller. */
function fieldViewFromBlock(
  b: Extract<TemplateBlock, { type: "field" }>,
): FormFieldView {
  return {
    key: b.key,
    label: b.label,
    type: b.fieldType,
    ...(b.required ? { required: true } : {}),
    ...(b.fieldType === "select" && b.options ? { options: b.options } : {}),
  };
}

const fieldLabelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11.5,
  color: "var(--ink-2)",
  marginBottom: 6,
};

/** One rendered form control keyed by the field's declared type. Native elements (styled) so the
 *  page stays accessible and dependency-free; `select` renders as the design's chip picker. */
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
    <label htmlFor={`f-${field.key}`} style={fieldLabelStyle}>
      {field.label}
      {field.required ? (
        <span style={{ color: "var(--state-error)" }}> *</span>
      ) : (
        <span style={{ color: "var(--ink-3)" }}> (optional)</span>
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
        style={{
          ...PUBLIC_INPUT,
          height: 70,
          padding: "10px 13px",
          resize: "vertical",
        }}
      />
    );
  } else if (field.type === "select") {
    // Enum fields render as the design's chip picker (single choice; required is enforced
    // by the shared light check + the server, same as before).
    control = (
      <div
        role="group"
        aria-label={field.label}
        style={{ display: "flex", flexWrap: "wrap", gap: 7 }}
      >
        {(field.options ?? []).map((o) => {
          const on = value === o;
          return (
            <button
              key={o}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? "" : o)}
              style={{
                fontSize: 12,
                padding: "7px 12px",
                borderRadius: 20,
                cursor: "pointer",
                fontWeight: 500,
                fontFamily: "var(--font-sans)",
                color: on ? "var(--brand-2)" : "var(--ink-2)",
                border: `1px solid ${on ? "var(--brand)" : "var(--line-2)"}`,
                background: on ? EMBER_TINT_BG : "var(--card)",
              }}
            >
              {o}
            </button>
          );
        })}
      </div>
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
        style={PUBLIC_INPUT}
      />
    );
  }

  return (
    <div style={{ marginBottom: 14 }}>
      {field.type === "select" ? (
        <div style={fieldLabelStyle}>
          {field.label}
          {field.required ? (
            <span style={{ color: "var(--state-error)" }}> *</span>
          ) : (
            <span style={{ color: "var(--ink-3)" }}> (optional)</span>
          )}
        </div>
      ) : (
        label
      )}
      {control}
    </div>
  );
}
