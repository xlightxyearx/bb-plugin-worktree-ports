// The sidebar-footer button is host-rendered and its registration carries no
// badge field, so the "something is listening" dot is painted onto the host's
// own button from a content script — the sanctioned place to decorate app-shell
// DOM. Everything here degrades to doing nothing if BB's markup moves.
const DOT_ATTR = "data-worktree-ports-indicator";

/** BB's own id-keyed test id, with the accessible label as a fallback. */
function buttonSelector(pluginId: string, itemId: string): string {
  return [
    `[data-testid="plugin-sidebar-footer-item-${pluginId}-${itemId}"]`,
    `[data-sidebar="footer"] button[aria-label="Worktree ports"]`,
  ].join(", ");
}

function styleDot(dot: HTMLElement): void {
  // Inline: the plugin's compiled CSS is scoped to its own subtree and never
  // applies to host elements. The custom properties are on the app root.
  Object.assign(dot.style, {
    position: "absolute",
    top: "3px",
    right: "3px",
    width: "7px",
    height: "7px",
    borderRadius: "9999px",
    background: "var(--timeline-accent, #5e81ac)",
    boxShadow: "0 0 0 2px var(--sidebar, var(--canvas, transparent))",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
}

export interface FooterIndicator {
  set(count: number): void;
  dispose(): void;
}

/**
 * Shows a dot on the footer button while any port is listening. Re-applies
 * when the host re-renders the footer, which would otherwise drop the node.
 */
export function createFooterIndicator(
  pluginId: string,
  itemId: string,
  root: ParentNode = document,
): FooterIndicator {
  const selector = buttonSelector(pluginId, itemId);
  let count = 0;
  let frame: number | null = null;

  const apply = (): void => {
    const button = root.querySelector(selector);
    const anchor = button?.parentElement ?? null;
    if (anchor === null) return;
    const existing = anchor.querySelector(`[${DOT_ATTR}]`);
    if (count === 0) {
      existing?.remove();
      return;
    }
    const dot = (existing as HTMLElement | null) ?? document.createElement("span");
    if (existing === null) {
      dot.setAttribute(DOT_ATTR, "");
      dot.setAttribute("role", "status");
      styleDot(dot);
      // The host's own menu item is already positioned, so the dot can anchor
      // to it without touching the button's layout.
      anchor.append(dot);
    }
    const label = `${count} port${count === 1 ? "" : "s"} listening`;
    dot.setAttribute("aria-label", label);
    dot.title = label;
  };

  const schedule = (): void => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      apply();
    });
  };

  // Scoped to the sidebar so a busy thread timeline does not wake this up.
  const observed =
    (root.querySelector('[data-sidebar="panel"]') as Element | null) ??
    (root.querySelector('[data-sidebar="footer"]') as Element | null) ??
    document.body;
  const observer = new MutationObserver(schedule);
  observer.observe(observed, { childList: true, subtree: true });

  return {
    set(next: number): void {
      if (next === count) return;
      count = next;
      apply();
    },
    dispose(): void {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      root.querySelector(`[${DOT_ATTR}]`)?.remove();
    },
  };
}
