export type DeliveryPriority = 'final' | 'control' | 'media' | 'intermediate' | 'activity';

export interface DeliveryItem {
  itemId: string;
  text: string;
  priority: DeliveryPriority;
  bytes: number;
  continuationNoticeAttached?: boolean;
}

export interface DeliveryWindow<T extends DeliveryItem = DeliveryItem> {
  items: T[];
  remainingItems: number;
  needsContinuation: boolean;
}

export interface DeliveryPlanOptions {
  sentItems: number;
  maxItems: number;
  maxItemsByPriority?: Partial<Record<DeliveryPriority, number>>;
  maxBytes?: number;
  continuationNotice: string;
}

/**
 * Select one inbound delivery window without mutating the queue. The caller
 * persists the selected items before sending and removes them only after an
 * acknowledged response.
 */
export function planDeliveryWindow<T extends DeliveryItem>(
  items: readonly T[],
  options: DeliveryPlanOptions,
): DeliveryWindow<T> {
  const ordered = [...items];

  const sentItems = Math.max(0, Math.floor(options.sentItems));
  const maxItems = Math.max(0, Math.floor(options.maxItems));
  const selected: T[] = [];
  for (const item of ordered) {
    const priorityLimit = Math.min(
      maxItems,
      Math.max(0, Math.floor(options.maxItemsByPriority?.[item.priority] ?? maxItems)),
    );
    if (sentItems + selected.length >= priorityLimit) break;
    selected.push({ ...item });
  }
  const selectedLast = selected.at(-1);
  const isUnresolvedStreamBoundary = Boolean(selectedLast)
    && sentItems + selected.length === maxItems
    && selected.length === ordered.length
    && (selectedLast!.priority === 'activity' || selectedLast!.priority === 'intermediate');
  if (isUnresolvedStreamBoundary) {
    selected.pop();
    return {
      items: selected,
      remainingItems: ordered.length - selected.length,
      needsContinuation: false,
    };
  }

  const remainingItems = ordered.length - selected.length;
  const last = selected.at(-1);
  const closesPriorityWindow = Boolean(last)
    && sentItems + selected.length >= Math.min(
      maxItems,
      Math.max(0, Math.floor(options.maxItemsByPriority?.[last!.priority] ?? maxItems)),
    )
    && sentItems + selected.length < maxItems;
  const needsContinuation = remainingItems > 0 || closesPriorityWindow;

  if (needsContinuation && selected.length > 0) {
    const selectedLast = selected[selected.length - 1];
    if (selectedLast.continuationNoticeAttached) return { items: selected, remainingItems, needsContinuation };
    const suffix = `\n\n${options.continuationNotice}`;
    const text = `${selectedLast.text}${suffix}`;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (options.maxBytes !== undefined && bytes > options.maxBytes) {
      throw new RangeError(`continuation notice exceeds maxBytes for ${selectedLast.itemId}`);
    }
    selected[selected.length - 1] = { ...selectedLast, text, bytes, continuationNoticeAttached: true };
  }

  return { items: selected, remainingItems, needsContinuation };
}
