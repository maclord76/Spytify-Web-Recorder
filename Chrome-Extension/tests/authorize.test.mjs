import assert from "node:assert/strict";

const elements = new Map();
globalThis.document = { querySelector(selector) {
  if (!elements.has(selector)) elements.set(selector, { textContent: "", addEventListener() {} });
  return elements.get(selector);
} };
let closes = 0;
let response;
let request;
globalThis.window = { close() { closes++; } };
globalThis.chrome = { runtime: {
  getManifest: () => ({ version: "1.14.4" }),
  async sendMessage(message) { request = message; return response; }
} };
const flush = () => new Promise(resolve => setImmediate(resolve));
response = { ok: true, state: { phase: "prepared" } };
await import("../authorize.js?prepared");
await flush();
assert.equal(request.type, "AUTHORIZE_CAPTURE");
assert.equal(closes, 1);
assert.equal(elements.get("#authorization-version").textContent, "Version 1.14.4");

response = { ok: false, error: "Erreur Chrome précise" };
await import("../authorize.js?error");
await flush();
assert.equal(closes, 1, "Garder la fenêtre ouverte pour afficher l'erreur.");
assert.equal(elements.get("#authorization-status").textContent, response.error);
response = { ok: true, state: { phase: "capture_permission", message: "Autorisation refusée" } };
await import("../authorize.js?permission");
await flush();
assert.equal(closes, 1);
assert.equal(elements.get("#authorization-status").textContent, response.state.message);
console.log("Fenêtre autorisation : demande explicite, fermeture après succès, erreurs visibles vérifiées.");
