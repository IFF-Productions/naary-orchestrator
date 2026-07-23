// The drag-and-drop block editor for Form/Email templates (docs/design/TEMPLATE-EDITOR.md, Slice 3).
// A palette adds content blocks; the canvas reorders them via @dnd-kit; each block edits inline; a
// live preview renders the same renderEmailHtml the worker uses. Blocks are the shared primitive —
// this editor is email-first (content blocks); form `field` blocks come in Slice 4.
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { renderEmailHtml, type TemplateBlock } from "@naary/dsl";
import { useMemo } from "react";
import { Icon, SafeHtml, TemplateContentBlock } from "../../../components";

type PaletteItem = { type: TemplateBlock["type"]; label: string; icon: string };

/** Content blocks — layout/copy, shared by email + form templates. */
const CONTENT_BLOCKS: PaletteItem[] = [
  { type: "heading", label: "Heading", icon: "edit" },
  { type: "text", label: "Text", icon: "template" },
  { type: "button", label: "Button", icon: "bolt" },
  { type: "image", label: "Image", icon: "eye" },
  { type: "divider", label: "Divider", icon: "none" },
  { type: "spacer", label: "Spacer", icon: "expand" },
];

/** The input-field block — FORM templates only (an email skips it). */
const FIELD_BLOCK: PaletteItem = {
  type: "field",
  label: "Field",
  icon: "plus",
};

/** The palette for a template kind: forms lead with the field block; emails are content-only. */
function paletteFor(kind: "email" | "form"): PaletteItem[] {
  return kind === "form" ? [FIELD_BLOCK, ...CONTENT_BLOCKS] : CONTENT_BLOCKS;
}

/** A fresh block of `type` with a unique id and sensible defaults. */
function newBlock(type: TemplateBlock["type"]): TemplateBlock {
  const id = crypto.randomUUID();
  switch (type) {
    case "heading":
      return { id, type, level: 2, text: "Heading" };
    case "text":
      return {
        id,
        type,
        html: "<p>Your text — use {{ node.field }} for data.</p>",
      };
    case "button":
      return { id, type, label: "View", href: "https://" };
    case "image":
      return { id, type, src: "https://", alt: "" };
    case "divider":
      return { id, type };
    case "spacer":
      return { id, type, size: 24 };
    case "field":
      return {
        id,
        type,
        key: "field",
        label: "Field",
        fieldType: "text",
        required: false,
      };
  }
}

/** Replace `{{ path }}` with a visible ‹path› marker so placeholders show in the preview instead of
 *  resolving to empty (there's no run ctx at authoring time). */
function chip(s: string): string {
  // Mirror the renderer's token grammar: an escaped `\{{` is a LITERAL `{{` (not a token), so it
  // must show as `{{`, not `\‹…›`. Same EMBED_RE shape the runtime resolves with (#589 review).
  return s.replace(/\\\{\{|\{\{\s*([^{}]+?)\s*\}\}/g, (m, p?: string) =>
    m === "\\{{" ? "{{" : `‹${(p ?? "").trim()}›`,
  );
}

/** Blocks with `{{ }}` chipified in their string fields — for the preview only. */
function previewBlocks(blocks: TemplateBlock[]): TemplateBlock[] {
  return blocks.map((b) => {
    switch (b.type) {
      case "heading":
        return { ...b, text: chip(b.text) };
      case "text":
        return { ...b, html: chip(b.html) };
      case "button":
        return { ...b, label: chip(b.label), href: chip(b.href) };
      case "image":
        return { ...b, src: chip(b.src), alt: b.alt ? chip(b.alt) : b.alt };
      default:
        return b;
    }
  });
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 9px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontSize: 12.5,
};

/** One block's inline editor — the fields for its type. */
function BlockFields({
  block,
  onChange,
}: {
  block: TemplateBlock;
  onChange: (patch: Partial<TemplateBlock>) => void;
}) {
  switch (block.type) {
    case "heading":
      return (
        <div style={{ display: "flex", gap: 8 }}>
          <select
            value={block.level}
            onChange={(e) =>
              onChange({ level: Number(e.target.value) as 1 | 2 | 3 })
            }
            style={{ ...inputStyle, width: 64 }}
          >
            <option value={1}>H1</option>
            <option value={2}>H2</option>
            <option value={3}>H3</option>
          </select>
          <input
            value={block.text}
            onChange={(e) => onChange({ text: e.target.value })}
            style={inputStyle}
            placeholder="Heading text — {{ trigger.name }} allowed"
          />
        </div>
      );
    case "text":
      return (
        <textarea
          value={block.html}
          onChange={(e) => onChange({ html: e.target.value })}
          rows={3}
          style={{
            ...inputStyle,
            fontFamily: "var(--font-mono)",
            resize: "vertical",
          }}
          placeholder="<p>Hi {{ trigger.name }}, …</p>"
        />
      );
    case "button":
      return (
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={block.label}
            onChange={(e) => onChange({ label: e.target.value })}
            style={inputStyle}
            placeholder="Label"
          />
          <input
            value={block.href}
            onChange={(e) => onChange({ href: e.target.value })}
            style={inputStyle}
            placeholder="https://… or {{ run.url }}"
          />
        </div>
      );
    case "image":
      return (
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={block.src}
            onChange={(e) => onChange({ src: e.target.value })}
            style={inputStyle}
            placeholder="https://…/image.png"
          />
          <input
            value={block.alt ?? ""}
            onChange={(e) => onChange({ alt: e.target.value })}
            style={inputStyle}
            placeholder="Alt text"
          />
        </div>
      );
    case "spacer":
      return (
        <input
          type="number"
          min={0}
          max={200}
          value={block.size}
          onChange={(e) => onChange({ size: Number(e.target.value) })}
          style={{ ...inputStyle, width: 100 }}
        />
      );
    case "field":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={block.label}
              onChange={(e) => onChange({ label: e.target.value })}
              style={inputStyle}
              placeholder="Label (shown to the person)"
            />
            <input
              value={block.key}
              onChange={(e) => onChange({ key: e.target.value })}
              style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
              placeholder="key (in the run input)"
            />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select
              value={block.fieldType}
              onChange={(e) =>
                onChange({
                  fieldType: e.target.value as (typeof block)["fieldType"],
                })
              }
              style={{ ...inputStyle, width: 130 }}
            >
              <option value="text">Text</option>
              <option value="textarea">Long text</option>
              <option value="number">Number</option>
              <option value="email">Email</option>
              <option value="select">Select</option>
            </select>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                color: "var(--ink-2)",
              }}
            >
              <input
                type="checkbox"
                checked={block.required}
                onChange={(e) => onChange({ required: e.target.checked })}
              />
              Required
            </label>
          </div>
          {block.fieldType === "select" && (
            <input
              value={(block.options ?? []).join(", ")}
              onChange={(e) =>
                onChange({
                  options: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              style={inputStyle}
              placeholder="Options, comma-separated (e.g. Low, Medium, High)"
            />
          )}
        </div>
      );
    default:
      return (
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>No options.</div>
      );
  }
}

/** A draggable canvas row wrapping one block's editor. */
function SortableRow({
  block,
  onChange,
  onRemove,
}: {
  block: TemplateBlock;
  onChange: (patch: Partial<TemplateBlock>) => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: block.id });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: 10,
        marginBottom: 8,
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-md)",
        background: "var(--card)",
      }}
    >
      <button
        type="button"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
        style={{
          cursor: "grab",
          background: "none",
          border: "none",
          color: "var(--ink-3)",
          padding: "2px 4px",
          touchAction: "none",
        }}
      >
        <Icon name="menu" size={14} />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="mono"
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
            marginBottom: 5,
          }}
        >
          {block.type}
        </div>
        <BlockFields block={block} onChange={onChange} />
      </div>
      <button
        type="button"
        aria-label="Remove block"
        onClick={onRemove}
        className="btn btn-ghost btn-icon btn-sm"
      >
        <Icon name="trash" size={13} />
      </button>
    </div>
  );
}

/** Preview of a FORM template: content blocks render as their visual, `field` blocks as the actual
 *  (disabled) input the hosted form will show. Mirrors the public FormPage's control set. */
function FormPreview({ blocks }: { blocks: TemplateBlock[] }) {
  const previewInput: React.CSSProperties = {
    width: "100%",
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid #d0d3d9",
    background: "#fff",
    color: "#111",
    fontSize: 13,
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {blocks.map((b) => {
        // Content blocks go through the SHARED renderer (same as the public form page — so the
        // preview and the hosted form can't diverge). Only `field` blocks differ: the preview shows
        // a disabled control, the public page a live input.
        if (b.type !== "field") {
          // `preview` so a button/link block can't navigate out of the editor when clicked.
          return <TemplateContentBlock key={b.id} block={b} preview />;
        }
        return (
          <label
            key={b.id}
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>
              {b.label}
              {b.required && <span style={{ color: "#c00" }}> *</span>}
            </span>
            {b.fieldType === "textarea" ? (
              <textarea disabled rows={3} style={previewInput} />
            ) : b.fieldType === "select" ? (
              <select disabled style={previewInput}>
                {(b.options ?? []).map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            ) : (
              <input
                disabled
                type={b.fieldType === "number" ? "number" : b.fieldType}
                style={previewInput}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}

export function TemplateBlockEditor({
  blocks,
  onChange,
  kind = "email",
}: {
  blocks: TemplateBlock[];
  onChange: (blocks: TemplateBlock[]) => void;
  /** email → content blocks + HTML preview; form → adds the field block + a form preview. */
  kind?: "email" | "form";
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = blocks.findIndex((b) => b.id === active.id);
    const to = blocks.findIndex((b) => b.id === over.id);
    if (from < 0 || to < 0) return;
    onChange(arrayMove(blocks, from, to));
  }

  const previewHtml = useMemo(
    () => renderEmailHtml(previewBlocks(blocks), {}),
    [blocks],
  );

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
        gap: 16,
        alignItems: "start",
      }}
    >
      {/* ---- Left: palette + block canvas ---- */}
      <div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginBottom: 12,
          }}
        >
          {paletteFor(kind).map((p) => (
            <button
              key={p.type}
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onChange([...blocks, newBlock(p.type)])}
            >
              <Icon name={p.icon as never} size={12} /> {p.label}
            </button>
          ))}
        </div>

        {blocks.length === 0 ? (
          <div
            style={{
              border: "1px dashed var(--line-2)",
              borderRadius: "var(--radius-md)",
              padding: 24,
              textAlign: "center",
              color: "var(--ink-3)",
              fontSize: 12.5,
            }}
          >
            Add blocks above to build the {kind === "form" ? "form" : "email"}.
            Drag the handle to reorder.
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={blocks.map((b) => b.id)}
              strategy={verticalListSortingStrategy}
            >
              {blocks.map((b) => (
                <SortableRow
                  key={b.id}
                  block={b}
                  onChange={(patch) =>
                    onChange(
                      blocks.map((x) =>
                        x.id === b.id
                          ? ({ ...x, ...patch } as TemplateBlock)
                          : x,
                      ),
                    )
                  }
                  onRemove={() => onChange(blocks.filter((x) => x.id !== b.id))}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* ---- Right: live preview (the SAME renderEmailHtml the worker sends) ---- */}
      <div style={{ position: "sticky", top: 0 }}>
        <div
          className="mono"
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
            marginBottom: 6,
          }}
        >
          Preview
        </div>
        {kind === "form" ? (
          <div
            style={{
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-md)",
              padding: 16,
              background: "#fff",
              color: "#111",
              minHeight: 120,
            }}
          >
            <FormPreview blocks={blocks} />
          </div>
        ) : (
          // renderEmailHtml escapes interpolated values; the author's OWN block markup is raw, and a
          // shared env-scoped template can carry another user's markup — SafeHtml sanitizes it
          // (DOMPurify) so the preview can't run a stored `<script>`/`on*=` payload.
          <SafeHtml
            style={{
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-md)",
              padding: 16,
              background: "#fff",
              color: "#111",
              minHeight: 120,
              overflow: "auto",
              // A preview: don't let a rendered <a> navigate the author out of the editor.
              pointerEvents: "none",
            }}
            html={previewHtml}
          />
        )}
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6 }}>
          {kind === "form"
            ? "How the hosted form will look. Fields become the run's input."
            : "‹field› markers fill from the run's data when the email is sent."}
        </div>
      </div>
    </div>
  );
}
