import { splitItems, type FilterItem } from "./filterSummary";

interface Props {
  items: readonly FilterItem[];
  onRemove: (kind: FilterItem["kind"]) => void;
  onMore: () => void;
}

/** Under the toolbar: at most two removable chips and "+n" (opens the sheet). */
export function FilterSummary({ items, onRemove, onMore }: Props) {
  if (items.length === 0) return null;
  const { shown, more } = splitItems(items, 2);
  return (
    <div className="filter-summary" data-testid="filter-summary" data-count={items.length}>
      {shown.map((it) => (
        <button key={it.kind} type="button" className="chip is-on filter-chip" data-testid="filter-chip" data-kind={it.kind} aria-label={`Remove filter: ${it.label}`} onClick={() => onRemove(it.kind)}>
          <span>{it.label}</span>
          <span aria-hidden="true"> ×</span>
        </button>
      ))}
      {more > 0 && (
        <button type="button" className="chip" data-testid="filter-more" aria-label={`${more} more filters, open filters`} onClick={onMore}>
          +{more}
        </button>
      )}
    </div>
  );
}
