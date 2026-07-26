import { Button } from "../../components";

/**
 * The Runs list's pagination footer, extracted from Runs.tsx (which the >1000-line PR check flagged
 * once paging landed).
 *
 * Its real job is keeping the counts HONEST. The status tabs filter client-side over loaded rows —
 * they have to, because `accessToRunSummary` reconciles a non-terminal run against Temporal *after*
 * the query, so a SQL `status IN (…)` would return confidently wrong pages. That means every number
 * on this screen is "so far", and the copy has to say so rather than implying a total we never asked
 * the database for.
 */
export function RunsPagination({
  loadedCount,
  visibleCount,
  filterLabel,
  nextCursor,
  loadingMore,
  disabled,
  onLoadMore,
}: {
  /** Rows fetched so far, across every page. */
  loadedCount: number;
  /** Rows the active status tab actually shows (≤ loadedCount). */
  visibleCount: number;
  /** The active tab, for the "nothing matched yet" hint. */
  filterLabel: string;
  /** Opaque cursor for the next page; null ⇒ the oldest run is loaded. */
  nextCursor: string | null;
  loadingMore: boolean;
  /** Also disabled while a bulk action is in flight. */
  disabled: boolean;
  onLoadMore: () => void;
}) {
  if (loadedCount === 0) return null; // never beside the loading skeleton or the empty state

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          flexWrap: "wrap",
          padding: "14px 18px",
        }}
      >
        <span
          style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
          aria-live="polite"
        >
          {/* "N loaded", never "N runs": the tenant almost certainly has more, and claiming a total
              we never queried would be a lie. Only once the cursor is exhausted can it say so. */}
          {visibleCount === loadedCount
            ? `${loadedCount} loaded`
            : `${visibleCount} of ${loadedCount} loaded`}
          {nextCursor ? "" : " · all runs"}
        </span>
        {nextCursor && (
          <Button
            variant="secondary"
            onClick={onLoadMore}
            disabled={loadingMore || disabled}
            loading={loadingMore}
            data-testid="runs-load-more"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        )}
      </div>

      {/* A status tab can hide every LOADED row while older matches sit unfetched. Without this the
          screen reads as "no failed runs" when it means "none among the newest N" — the difference
          between "we're fine" and "look further back". */}
      {visibleCount === 0 && nextCursor && (
        <div
          style={{
            padding: "18px",
            textAlign: "center",
            fontSize: "var(--text-xs)",
            color: "var(--ink-3)",
          }}
        >
          No {filterLabel.toLowerCase()} runs among the {loadedCount} loaded —
          load more to search further back.
        </div>
      )}
    </>
  );
}
