import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SearchInput, Skeleton, Toast } from "../../components";
import { api, type ConnectionRow, UnauthorizedError } from "../../lib/api";
import { useMode } from "../../mode";
import { InstallSuccess } from "./templates/InstallSuccess";
import {
  checkConnectionRequirements,
  deriveCategoryChips,
  deriveTemplateView,
  uniqueWorkflowKey,
  type TemplateView,
} from "./templates/model";
import { PreviewModal } from "./templates/PreviewModal";
import { TeachingHero } from "./templates/TeachingHero";
import { TemplateCard } from "./templates/TemplateCard";

/**
 * Templates — the front door / onboarding path. Teaches the trigger → run →
 * approval → done loop (hero), then a searchable, category-filtered gallery of
 * the built-in templates. Every chain/badge/category derives from each
 * template's REAL graph (GET /templates/:key).
 *
 * Install = the real fork flow made one-click: the template's graph is saved as
 * a workflow in the active workspace via POST /graphs, under slug(name) (the
 * same fork naming the canvas uses on Save), uniquified if the key is taken.
 * The success view then opens the actually-created workflowKey in the canvas.
 */

interface ToastItem {
  id: number;
  kind: "done" | "error";
  text: string;
}

interface Installed {
  view: TemplateView;
  workflowKey: string;
}

export function Templates() {
  const navigate = useNavigate();
  const { mode } = useMode();
  const [views, setViews] = useState<TemplateView[] | null>(null);
  // The workspace's real connections, for the required-connection checklist. `null` means
  // "not known" (still loading, or the call failed) — the checklist then renders WITHOUT a
  // satisfied/missing verdict rather than claiming everything is missing.
  const [connections, setConnections] = useState<ConnectionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState<Installed | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const toastIdRef = useRef(0);

  useEffect(() => {
    const timers = timersRef.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  // Load the catalog, then each template's graph — chains, categories, approval
  // badges, and the teaching copy all derive from the real graphs.
  useEffect(() => {
    let alive = true;
    api
      .listTemplates()
      .then((rows) =>
        Promise.allSettled(rows.map((r) => api.getTemplate(r.key))),
      )
      .then((settled) => {
        if (!alive) return;
        const ok = settled.flatMap((s) =>
          s.status === "fulfilled" ? [deriveTemplateView(s.value)] : [],
        );
        if (ok.length === 0 && settled.length > 0) {
          setError("Could not load the template graphs. Try again.");
          return;
        }
        setViews(ok);
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setError(
          e instanceof UnauthorizedError
            ? "Not authenticated — sign in (or set an API token) to see templates."
            : "Could not reach the control plane (apps/api on :3000).",
        );
      });
    return () => {
      alive = false;
    };
  }, []);

  // The workspace's connections — what the required-connection checklist is checked
  // against. A failure leaves it null on purpose (see the state declaration).
  useEffect(() => {
    let alive = true;
    api
      .getMe()
      .then((me) => api.listConnections(me.tenantId))
      .then((rows) => {
        if (alive) setConnections(rows);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const chips = useMemo(
    () => (views ? deriveCategoryChips(views) : []),
    [views],
  );

  const filtered = useMemo(() => {
    if (!views) return [];
    const needle = q.trim().toLowerCase();
    return views.filter(
      (v) =>
        (cat === "all" || v.category.id === cat) &&
        (!needle ||
          // The API's use-case tags are part of the haystack, so they're load-bearing
          // rather than decoration ("rss", "human-approval", … find a template).
          `${v.name} ${v.description} ${v.category.name} ${v.tags.join(" ")}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [views, cat, q]);

  const preview = previewKey
    ? (views?.find((v) => v.key === previewKey) ?? null)
    : null;

  // Verdicts for the previewed / just-installed template's required connections. null
  // whenever the workspace's connections aren't known — never a fabricated "missing".
  const previewChecked = useMemo(
    () =>
      preview && connections
        ? checkConnectionRequirements(preview.requirements, connections)
        : null,
    [preview, connections],
  );
  const installedChecked = useMemo(
    () =>
      installed && connections
        ? checkConnectionRequirements(installed.view.requirements, connections)
        : null,
    [installed, connections],
  );

  function pushToast(kind: ToastItem["kind"], text: string) {
    const id = ++toastIdRef.current;
    setToasts((ts) => [...ts, { id, kind, text }]);
    timersRef.current.push(
      setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 2600),
    );
  }

  // The REAL install: save the template's graph as a workflow (the same call the
  // canvas's Save issues after forking), under a fresh slug(name)-derived key so
  // an existing workflow is never silently versioned over.
  async function install(view: TemplateView) {
    setInstalling(true);
    try {
      const existing = await api.listGraphs().catch(() => []);
      const key = uniqueWorkflowKey(
        view.name,
        new Set(existing.map((g) => g.workflowKey)),
      );
      const saved = await api.saveGraph(key, view.name, view.graph);
      setPreviewKey(null);
      setInstalled({ view, workflowKey: saved.workflowKey });
      pushToast("done", `${view.name} installed`);
    } catch (e) {
      pushToast(
        "error",
        e instanceof UnauthorizedError
          ? "Sign in to install templates."
          : "Couldn't install the template — is the control plane up?",
      );
    } finally {
      setInstalling(false);
    }
  }

  // Bring the success view (or restored gallery) back into view inside the
  // shell's scrolling content region.
  useEffect(() => {
    rootRef.current?.scrollIntoView({ block: "start" });
  }, [installed]);

  const simple = mode === "simple";
  // Closest real AI-generation entry point per variant: the canvas hosts the
  // Build-with-AI panel (Builder); Simple's describe-it flow is /app/automations/new.
  const generateTo = simple ? "/app/automations/new" : "/app/canvas";
  const blankTo = simple ? "/app/automations/new" : "/app/canvas";

  return (
    <div ref={rootRef}>
      <style>{`
        @keyframes tplPop{0%{transform:scale(.4);opacity:0}60%{transform:scale(1.12)}100%{transform:scale(1);opacity:1}}
        @keyframes tplStepIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        .tpl-card{transition:border-color .14s,transform .14s,box-shadow .14s}
        .tpl-card:hover{border-color:var(--line-2) !important;transform:translateY(-3px);box-shadow:0 16px 36px -22px rgba(0,0,0,.55)}
        .tpl-card:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
      `}</style>

      {installed ? (
        <InstallSuccess
          view={installed.view}
          workflowKey={installed.workflowKey}
          checkedRequirements={installedChecked}
          openLabel={simple ? "Open automation" : "Open in canvas"}
          onOpen={() =>
            navigate(
              simple
                ? `/app/automations/${encodeURIComponent(installed.workflowKey)}`
                : `/app/canvas?key=${encodeURIComponent(installed.workflowKey)}`,
            )
          }
          onConnect={(tab) => navigate(`/app/integrations?tab=${tab}`)}
          onBack={() => setInstalled(null)}
        />
      ) : (
        <div style={{ animation: "naaryFadeUp .25s ease" }}>
          <TeachingHero
            onGenerate={() => navigate(generateTo)}
            onStartBlank={() => navigate(blankTo)}
          />

          {/* gallery */}
          <div style={{ padding: "26px 28px 40px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginBottom: 18,
                flexWrap: "wrap",
              }}
            >
              <div
                style={{
                  fontSize: 17,
                  fontWeight: "var(--weight-bold)",
                  color: "var(--ink)",
                }}
              >
                Start from a template
              </div>
              <SearchInput
                placeholder="Search templates…"
                kbd=""
                value={q}
                onChange={setQ}
                style={{ marginLeft: "auto", width: 240 }}
              />
            </div>

            {error && (
              <div
                style={{
                  marginBottom: 14,
                  padding: "9px 12px",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--error-soft)",
                  border:
                    "1px solid color-mix(in srgb, var(--state-error) 40%, transparent)",
                  color: "var(--state-error)",
                  fontSize: "var(--text-sm)",
                }}
              >
                {error}
              </div>
            )}

            {/* category chips — derived from the real template set, with counts */}
            {views && views.length > 0 && (
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  marginBottom: 20,
                }}
              >
                {chips.map((c) => {
                  const active = cat === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setCat(c.id)}
                      style={{
                        fontSize: "var(--text-xs)",
                        padding: "6px 13px",
                        borderRadius: "var(--radius-pill)",
                        cursor: "pointer",
                        fontWeight: "var(--weight-medium)",
                        fontFamily: "inherit",
                        color: active ? "var(--ink)" : "var(--ink-faint)",
                        background: active ? "var(--card)" : "transparent",
                        border: `1px solid ${active ? "var(--line-2)" : "var(--line-mid)"}`,
                        transition:
                          "color .14s ease, background .14s ease, border-color .14s ease",
                      }}
                    >
                      {c.name} <span style={{ opacity: 0.6 }}>{c.count}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {views === null && !error && <GallerySkeleton />}

            {views?.length === 0 && (
              <div
                style={{
                  fontSize: "var(--text-body)",
                  color: "var(--ink-3)",
                }}
              >
                No templates available.
              </div>
            )}

            {views && views.length > 0 && filtered.length > 0 && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
                  gap: 14,
                }}
              >
                {filtered.map((v) => (
                  <TemplateCard
                    key={v.key}
                    view={v}
                    onPreview={() => setPreviewKey(v.key)}
                  />
                ))}
              </div>
            )}

            {views && views.length > 0 && filtered.length === 0 && (
              <div
                style={{
                  textAlign: "center",
                  padding: 60,
                  color: "var(--ink-faint)",
                  fontSize: "var(--text-body)",
                }}
              >
                No templates match —{" "}
                <button
                  type="button"
                  onClick={() => {
                    setQ("");
                    setCat("all");
                  }}
                  style={{
                    border: "none",
                    background: "transparent",
                    padding: 0,
                    color: "var(--brand)",
                    cursor: "pointer",
                    font: "inherit",
                    fontWeight: "var(--weight-semibold)",
                  }}
                >
                  reset filters
                </button>
                .
              </div>
            )}
          </div>
        </div>
      )}

      {preview && (
        <PreviewModal
          view={preview}
          installing={installing}
          checkedRequirements={previewChecked}
          onInstall={() => void install(preview)}
          onClose={() => setPreviewKey(null)}
        />
      )}

      {/* toasts — bottom-right, slide+scale in, auto-dismiss */}
      <div
        style={{
          position: "fixed",
          right: 24,
          bottom: 22,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 9,
          zIndex: 70,
        }}
      >
        {/* the shared Toast (.toast) animates its own entrance */}
        {toasts.map((t) => (
          <div key={t.id}>
            <Toast
              kind={t.kind}
              onDismiss={() =>
                setToasts((ts) => ts.filter((x) => x.id !== t.id))
              }
            >
              <span style={{ fontWeight: "var(--weight-medium)" }}>
                {t.text}
              </span>
            </Toast>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Shimmer placeholders shaped like the gallery grid while the graphs load. */
function GallerySkeleton() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
        gap: 14,
      }}
    >
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          style={{
            border: "1px solid var(--line-mid)",
            background: "var(--card)",
            borderRadius: "var(--radius-xl)",
            padding: 18,
            display: "flex",
            flexDirection: "column",
            gap: 13,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <Skeleton width={38} height={38} radius={10} />
            <div style={{ flex: 1 }}>
              <Skeleton width="55%" height={14} />
              <Skeleton width="30%" height={10} style={{ marginTop: 6 }} />
            </div>
          </div>
          <Skeleton width="100%" height={12} />
          <Skeleton width="80%" height={12} />
          <Skeleton width="60%" height={24} />
        </div>
      ))}
    </div>
  );
}
