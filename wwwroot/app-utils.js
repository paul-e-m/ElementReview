// Shared frontend helpers used by the main operator UI.
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

export function getOperatorAuthToken() {
  return String(window.__ELEMENT_REVIEW_OPERATOR_TOKEN || "");
}

function authHeaders(extraHeaders = {}) {
  const token = getOperatorAuthToken();
  if (!token) {
    throw new Error("Element Review operator token was not injected by the native shell.");
  }

  return { ...extraHeaders, Authorization: `Bearer ${token}` };
}

async function fetchWithAuth(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: authHeaders(options.headers || {}),
  });
}

export async function apiGet(path) {
  // Status/config reads should always reflect the latest backend state.
  const response = await fetchWithAuth(path, { cache: "no-store" });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export async function apiPost(path, bodyObj) {
  // The backend expects JSON bodies even for commands without payload fields.
  const response = await fetchWithAuth(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyObj ? JSON.stringify(bodyObj) : "{}",
  });

  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
