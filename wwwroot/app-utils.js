// Shared frontend helpers used across the record/replay UI modules.
// Keep this file intentionally small: DOM lookups, numeric helpers, and the
// thin fetch wrappers that every page uses to talk to the backend.
export const BTN_DIR = "/img/buttons";
export const BTN_SIZE = 52;

export function el(id) {
  return document.getElementById(id);
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function approxEqual(a, b) {
  return Math.abs(a - b) < 1e-6;
}

export function isTypingTarget(target) {
  if (!target) return false;

  const tag = (target.tagName || "").toLowerCase();
  if (tag === "input") {
    const type = (target.type || "").toLowerCase();
    if (type === "range") return false;
  }

  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    target.isContentEditable
  );
}

export async function apiGet(path) {
  // Most state reads are polled frequently and should always reflect the
  // latest backend state rather than a cached JSON response.
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export async function apiPost(path, bodyObj) {
  // The backend expects JSON even for "empty" commands, so default to "{}"
  // instead of omitting the body entirely.
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyObj ? JSON.stringify(bodyObj) : "{}",
  });

  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
