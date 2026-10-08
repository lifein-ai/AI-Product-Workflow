export function createRequestHeaders(options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return headers;
}
