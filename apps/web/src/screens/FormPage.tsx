import type { TemplateBlock } from "@naary/dsl";
import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { TemplateContentBlock } from "../components";
import { api, type FormDefinition, type FormFieldView } from "../lib/api";
import { useEmbedResize } from "../lib/embed-resize";
import { PHONE_QUERY, useMediaQuery } from "../lib/useMediaQuery";
import {
  accentButton,
  accentVars,
  cardMaxWidth,
  fieldGridStyle,
  redirectMode,
  spansFullRow,
} from "./public/form-branding";
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
  // Below the phone breakpoint a 2-column form collapses to one — the desktop/mobile difference is
  // available width, so it's expressed as that rather than as two authored layouts.
  const phone = useMediaQuery(PHONE_QUERY);

  // Tenant presentation (all optional). Absent ⇒ every derived style below returns {} and the page
  // renders exactly as it did before branding existed.
  const branding = def?.branding;
  const accentStyle = accentVars(branding?.accentColor);
  const submitFace = accentButton(branding?.accentColor);
  const gridStyle = fieldGridStyle(branding?.desktopColumns, phone);
  const gridded = Object.keys(gridStyle).length > 0;

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
      // Honour redirectUrl only for a TOP-LEVEL page. Embedded, we render the destination as a link
      // instead of navigating — see redirectMode for why auto-navigating inside a tenant's iframe is
      // the wrong move. The submission has already succeeded either way, so a redirect that never
      // fires can't lose data.
      if (redirectMode(branding?.redirectUrl, embed) === "navigate") {
        window.location.assign(branding?.redirectUrl as string);
      }
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
      {/* The accent custom properties and the forced theme both live on this wrapper. `data-theme`
          works here (not just on <html>) because tokens.css exposes the light palette to any subtree
          — deliberately, since ThemeProvider owns the <html> attribute and its effect would overwrite
          a page-level write on mount. `theme: "auto"`/absent leaves the visitor's own theme alone. */}
      <div
        style={{ width: "100%", maxWidth: cardMaxWidth(branding?.width), ...accentStyle }}
        {...(branding?.theme === "light" || branding?.theme === "dark"
          ? { "data-theme": branding.theme }
          : {})}
      >
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
              {branding?.successTitle ?? "Request received"}
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
                // Author copy may contain newlines; honour them without accepting HTML (this is a
                // text node, so a tenant can never inject markup into their own public page).
                whiteSpace: branding?.successMessage ? "pre-wrap" : undefined,
              }}
            >
              {/* Default copy: the submit response carries only `status: "started"`, so it claims
                  exactly that and no more — the workflow may finish instantly or pause for days. An
                  author who knows their flow can say something more useful via successMessage. */}
              {branding?.successMessage ??
                "Your response was submitted and the workflow has started. If a step needs a human decision, it will wait safely until someone decides."}
            </div>

            {/* Embedded with a redirect configured: we do NOT navigate the iframe (see redirectMode)
                — the destination is offered as a link so the visitor stays in control and can see
                where they're going. `noopener noreferrer` because this is a tenant-supplied URL. */}
            {redirectMode(branding?.redirectUrl, embed) === "link" && (
              <div style={{ marginTop: 16, fontSize: 13 }}>
                <a
                  href={branding?.redirectUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--brand)", fontWeight: 600 }}
                >
                  Continue →
                </a>
              </div>
            )}
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
              <div style={gridStyle}>
                {def.blocks
                  ? def.blocks.map((b) =>
                      b.type === "field" ? (
                        <FormField
                          key={b.id}
                          field={fieldViewFromBlock(b)}
                          value={values[b.key] ?? ""}
                          onChange={(v) => set(b.key, v)}
                          fullRow={gridded && spansFullRow(b.fieldType)}
                        />
                      ) : (
                        // Content blocks always span the full row: a heading or paragraph squeezed
                        // into one column of a two-column form reads as a caption for the field
                        // beside it rather than as the section it is.
                        <div
                          key={b.id}
                          style={{
                            marginBottom: 14,
                            ...(gridded ? { gridColumn: "1 / -1" } : {}),
                          }}
                        >
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
                        fullRow={gridded && spansFullRow(f.type)}
                      />
                    ))}
              </div>

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
                  // AFTER the ember face: EMBER_BUTTON hardcodes its gradient rather than reading
                  // var(--brand), so the accent has to override it explicitly (see accentButton).
                  ...submitFace,
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
  fullRow,
}: {
  field: FormFieldView;
  value: string;
  onChange: (v: string) => void;
  /** In a 2-column layout, make this field span both columns (see spansFullRow). */
  fullRow?: boolean;
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
    <div
      style={{ marginBottom: 14, ...(fullRow ? { gridColumn: "1 / -1" } : {}) }}
    >
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
