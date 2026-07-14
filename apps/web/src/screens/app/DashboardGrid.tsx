import type { ReactNode } from "react";
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
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Icon } from "../../components";
import type { DashboardItem } from "../../lib/api";

/** Widths a widget can cycle through on the 12-col grid. */
const SPANS = [4, 6, 8, 12] as const;
const SPAN_LABEL: Record<number, string> = {
  4: "¼",
  6: "½",
  8: "⅔",
  12: "Full",
};

export interface WidgetMeta {
  id: string;
  title: string;
}

/**
 * The customizable Overview grid. `layout` is the full ordered list (visible + hidden);
 * `render(id)` draws a widget's content. In `customizing` mode each visible widget gets a
 * drag handle + width cycler + hide button, and hidden widgets appear in a tray to re-add.
 * Every change (reorder / resize / hide / show) calls `onChange` with the next layout —
 * the parent persists it. Built on @dnd-kit (React-19-native; no findDOMNode).
 */
export function DashboardGrid({
  layout,
  widgets,
  customizing,
  render,
  onChange,
}: {
  layout: DashboardItem[];
  widgets: WidgetMeta[];
  customizing: boolean;
  render: (id: string) => ReactNode;
  onChange: (next: DashboardItem[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const titleOf = (id: string) => widgets.find((w) => w.id === id)?.title ?? id;
  const visible = layout.filter((i) => !i.hidden);
  const hidden = layout.filter((i) => i.hidden);

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = visible.map((i) => i.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const reordered = arrayMove(visible, from, to);
    // Persist the new visible order, then the hidden ones (they live in the tray).
    onChange([...reordered, ...hidden]);
  }

  function patch(id: string, next: Partial<DashboardItem>) {
    onChange(layout.map((i) => (i.id === id ? { ...i, ...next } : i)));
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={visible.map((i) => i.id)}
          strategy={rectSortingStrategy}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
              gap: 16,
              alignItems: "start",
            }}
          >
            {visible.map((item) => (
              <SortableWidget
                key={item.id}
                item={item}
                title={titleOf(item.id)}
                customizing={customizing}
                onCycleWidth={() => {
                  const idx = SPANS.indexOf(
                    item.span as (typeof SPANS)[number],
                  );
                  patch(item.id, {
                    span: SPANS[(idx + 1) % SPANS.length],
                  });
                }}
                onHide={() => patch(item.id, { hidden: true })}
              >
                {render(item.id)}
              </SortableWidget>
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {customizing && hidden.length > 0 && (
        <div
          style={{
            marginTop: 18,
            padding: 14,
            border: "1px dashed var(--line-2)",
            borderRadius: "var(--radius-md)",
            background: "var(--card-2)",
          }}
        >
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginBottom: 10,
            }}
          >
            Hidden widgets — click to add back
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {hidden.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => patch(item.id, { hidden: false })}
                className="btn btn-secondary btn-sm"
              >
                <Icon name="plus" size={13} strokeWidth={2} />
                {titleOf(item.id)}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function SortableWidget({
  item,
  title,
  customizing,
  onCycleWidth,
  onHide,
  children,
}: {
  item: DashboardItem;
  title: string;
  customizing: boolean;
  onCycleWidth: () => void;
  onHide: () => void;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled: !customizing });

  return (
    <div
      ref={setNodeRef}
      style={{
        gridColumn: `span ${item.span}`,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.55 : 1,
        zIndex: isDragging ? 5 : undefined,
      }}
    >
      {customizing && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 8px",
            marginBottom: 8,
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-sm)",
            background: "var(--surface)",
          }}
        >
          <button
            type="button"
            aria-label="Drag to reorder"
            title="Drag to reorder"
            {...attributes}
            {...listeners}
            style={{
              display: "inline-flex",
              border: "none",
              background: "transparent",
              color: "var(--ink-3)",
              cursor: "grab",
              padding: 2,
            }}
          >
            <Icon name="grid" size={14} strokeWidth={2} />
          </button>
          <span
            style={{
              flex: 1,
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </span>
          <button
            type="button"
            onClick={onCycleWidth}
            title="Change width"
            className="btn btn-ghost btn-sm"
            style={{ minWidth: 44 }}
          >
            {SPAN_LABEL[item.span] ?? item.span}
          </button>
          <button
            type="button"
            onClick={onHide}
            title="Hide widget"
            aria-label="Hide widget"
            className="btn btn-ghost btn-sm btn-icon"
          >
            <Icon name="eye" size={14} strokeWidth={2} />
          </button>
        </div>
      )}
      <div
        style={
          customizing
            ? {
                outline: "1px dashed var(--line-2)",
                outlineOffset: 4,
                borderRadius: "var(--radius-lg)",
              }
            : undefined
        }
      >
        {children}
      </div>
    </div>
  );
}
