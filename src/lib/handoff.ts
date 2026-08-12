"use client";

/**
 * Carrying a prompt from one screen to another.
 *
 * A model writes a prompt in Chat and the next thing anybody wants is that prompt in a
 * generator, not in the clipboard. The two views never render at the same time — the shell
 * mounts one at a time on purpose — so the text is parked here and collected on mount.
 *
 * `sessionStorage` rather than a React context: the receiving view mounts *after* the
 * navigation, a context value set before `go()` would be gone by then, and parking it in
 * the URL would put a paragraph of somebody's prompt in the address bar.
 */

export interface Handoff {
  prompt: string;
  /** Where it came from, so the receiving panel can say so rather than appear to invent it. */
  from: string;
}

const KEY = "x-forge.handoff";

/** Views that have a prompt field worth filling. */
export const TARGETS = [
  { view: "image-forge", label: "Image Forge", glyph: "✦" },
  { view: "video-forge", label: "Video Forge", glyph: "▶" },
  { view: "audio-lab", label: "Audio Lab", glyph: "♫" },
  { view: "icon-foundry", label: "Icon Foundry", glyph: "◉" },
  { view: "upscale", label: "Upscale Studio", glyph: "⇱" },
] as const;

export function stash(view: string, handoff: Handoff): void {
  try {
    window.sessionStorage.setItem(`${KEY}.${view}`, JSON.stringify(handoff));
  } catch {
    /* a full or blocked store is a lost hand-off, not a broken console */
  }
}

/** Read once. Collecting it twice would refill a field the operator has since edited. */
export function collect(view: string): Handoff | null {
  try {
    const raw = window.sessionStorage.getItem(`${KEY}.${view}`);
    if (!raw) return null;
    window.sessionStorage.removeItem(`${KEY}.${view}`);
    return JSON.parse(raw) as Handoff;
  } catch {
    return null;
  }
}
