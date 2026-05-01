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

let operatorAuthTokenPromise = null;

export async function getOperatorAuthToken() {
  if (!operatorAuthTokenPromise) {
    operatorAuthTokenPromise = fetch("/api/operator/session", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        const payload = await response.json();
        return String(payload?.token || "");
      });
  }

  return operatorAuthTokenPromise;
}

async function authHeaders(extraHeaders = {}) {
  const token = await getOperatorAuthToken();
  return token
    ? { ...extraHeaders, Authorization: `Bearer ${token}` }
    : { ...extraHeaders };
}

async function fetchWithAuth(path, options = {}, retryOnUnauthorized = true) {
  const response = await fetch(path, {
    ...options,
    headers: await authHeaders(options.headers || {}),
  });

  if (response.status !== 401 || !retryOnUnauthorized) {
    return response;
  }

  operatorAuthTokenPromise = null;
  return fetch(path, {
    ...options,
    headers: await authHeaders(options.headers || {}),
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
