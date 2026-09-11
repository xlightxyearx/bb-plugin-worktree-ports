// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createFooterIndicator } from "../src/ui/footer-indicator";

const DOT = "[data-worktree-ports-indicator]";

function sidebar(): HTMLElement {
  document.body.innerHTML = `
    <div data-sidebar="panel">
      <div data-sidebar="footer">
        <ul data-sidebar="menu">
          <li data-sidebar="menu-item" class="relative">
            <button data-testid="plugin-sidebar-footer-item-worktree-ports-ports"></button>
          </li>
        </ul>
      </div>
    </div>`;
  return document.querySelector("li") as HTMLElement;
}

/** MutationObserver callbacks and the rAF coalescing both land off-thread. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("footer indicator", () => {
  it("dots the button while ports are listening and clears when they stop", () => {
    const item = sidebar();
    const indicator = createFooterIndicator("worktree-ports", "ports");

    expect(item.querySelector(DOT)).toBeNull();
    indicator.set(3);
    const dot = item.querySelector(DOT);
    expect(dot?.getAttribute("aria-label")).toBe("3 ports listening");

    indicator.set(0);
    expect(item.querySelector(DOT)).toBeNull();
    indicator.dispose();
  });

  it("counts one port in the singular", () => {
    const item = sidebar();
    const indicator = createFooterIndicator("worktree-ports", "ports");
    indicator.set(1);
    expect(item.querySelector(DOT)?.getAttribute("aria-label")).toBe("1 port listening");
    indicator.dispose();
  });

  it("re-applies itself when the host re-renders the footer", async () => {
    sidebar();
    const indicator = createFooterIndicator("worktree-ports", "ports");
    indicator.set(2);
    expect(document.querySelector(DOT)).not.toBeNull();

    // What a React re-render of the footer row looks like from outside.
    const menu = document.querySelector('[data-sidebar="menu"]') as HTMLElement;
    menu.innerHTML = `
      <li data-sidebar="menu-item" class="relative">
        <button data-testid="plugin-sidebar-footer-item-worktree-ports-ports"></button>
      </li>`;
    expect(document.querySelector(DOT)).toBeNull();

    await settle();
    expect(document.querySelector(DOT)?.getAttribute("aria-label")).toBe("2 ports listening");
    indicator.dispose();
  });

  it("finds the button by its accessible label when the test id is absent", () => {
    document.body.innerHTML = `
      <div data-sidebar="footer">
        <li data-sidebar="menu-item" class="relative">
          <button aria-label="Worktree ports"></button>
        </li>
      </div>`;
    const indicator = createFooterIndicator("worktree-ports", "ports");
    indicator.set(1);
    expect(document.querySelector(DOT)).not.toBeNull();
    indicator.dispose();
  });

  it("does nothing at all when the footer button is not there", () => {
    document.body.innerHTML = `<div data-sidebar="panel"></div>`;
    const indicator = createFooterIndicator("worktree-ports", "ports");
    expect(() => indicator.set(4)).not.toThrow();
    expect(document.querySelector(DOT)).toBeNull();
    indicator.dispose();
  });

  it("removes the dot and stops observing on dispose", async () => {
    sidebar();
    const indicator = createFooterIndicator("worktree-ports", "ports");
    indicator.set(2);
    indicator.dispose();
    expect(document.querySelector(DOT)).toBeNull();

    const menu = document.querySelector('[data-sidebar="menu"]') as HTMLElement;
    menu.innerHTML = `<li data-sidebar="menu-item"><button data-testid="plugin-sidebar-footer-item-worktree-ports-ports"></button></li>`;
    await settle();
    expect(document.querySelector(DOT)).toBeNull();
  });
});
