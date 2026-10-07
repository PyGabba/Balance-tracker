import { it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// Runs docs/widget/Finanza.scriptable.js against a small mock of the
// Scriptable runtime (it only exists on iOS, so this is the only place the
// script's logic is exercised): widget rendering with the dashboard fields,
// the quick-add form and its "same as last time" memory, idempotent retries,
// server errors, stale memory and the hide toggle.
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "finanza-widget-"));
const SCRIPT_PATH = fileURLToPath(new URL("./Finanza.scriptable.js", import.meta.url));

const SRC = fs.readFileSync(SCRIPT_PATH, "utf8")
  .replace('"https://INCOLLA_QUI/api/widget?key=INCOLLA_LA_TUA_CHIAVE"', '"https://example.test/api/widget?key=TESTKEY"');
fs.writeFileSync(`${OUT}/script_under_test.mjs`, SRC);

// ── Scriptable runtime mock ──
const files = new Map();
let responses = [], shown = [], requests = [], handler, widgetTexts = [], completed = false;
class Color { constructor(hex, a) { this.hex = hex; this.alpha = a; } }
class LinearGradient {}
class Font { constructor(n, s) { this.n = n; this.s = s; } static boldSystemFont(s) { return new Font("bold", s); } static semiboldSystemFont(s) { return new Font("semibold", s); } static mediumSystemFont(s) { return new Font("medium", s); } static systemFont(s) { return new Font("sys", s); } static italicSystemFont(s) { return new Font("it", s); } }
class Node_ {
  addText(t) { const x = { text: t }; widgetTexts.push(t); return x; }
  addStack() { return new Node_(); }
  addSpacer() {}
  layoutVertically() {} centerAlignContent() {} setPadding() {}
}
class ListWidget extends Node_ { async presentMedium() {} }
class Request {
  constructor(url) { this.url = url; }
  async loadJSON() { requests.push({ url: this.url, method: this.method || "GET", headers: this.headers, body: this.body && JSON.parse(this.body) }); return handler(requests.at(-1)); }
}
class Alert {
  constructor() { this.actions = []; this.fields = []; }
  addAction(a) { this.actions.push(a); } addCancelAction() {} addTextField(p, v) { this.fields.push(v); }
  _next() { const r = responses.shift(); assert.ok(r, `unexpected alert: ${this.title} / ${this.message}`); shown.push({ title: this.title, message: this.message, actions: [...this.actions] }); this._r = r; return r.idx; }
  async presentAlert() { return this._next(); }
  async presentSheet() { return this._next(); }
  textFieldValue(i) { return this._r.fields?.[i] ?? ""; }
}
globalThis.Color = Color; globalThis.LinearGradient = LinearGradient; globalThis.Font = Font; globalThis.ListWidget = ListWidget; globalThis.Request = Request; globalThis.Alert = Alert;
globalThis.FileManager = { local: () => ({ documentsDirectory: () => "/docs", joinPath: (a, b) => `${a}/${b}`, fileExists: p => files.has(p), readString: p => files.get(p), writeString: (p, s) => files.set(p, s) }) };
let uuid = 0; globalThis.UUID = { string: () => `uuid-${++uuid}` };
globalThis.Script = { setWidget() {}, complete() { completed = true; } };
globalThis.Safari = { open() {} };

const data = {
  aggiornato: new Date().toISOString(), patrimonio: 5000, investimenti: 0,
  conti: [{ nome: "Banca", icona: "🏦", saldo: 3200 }],
  contiCompleti: [{ id: "c1", nome: "Banca", icona: "🏦" }, { id: "c2", nome: "Contanti", icona: "💶" }],
  persone: [{ id: "g", nome: "Gabriele", emoji: "🧔" }, { id: "l", nome: "Laura", emoji: "👩" }],
  categorie: [{ id: "cibo", nome: "Cibo", emoji: "🍕" }, { id: "casa", nome: "Casa", emoji: "🏠" }],
  speseMese: 886.05, entrateMese: 152.5, speseMesePrec: 279.2, deltaPct: 217,
  inArrivo: [{ descrizione: "Affitto", categoria: "casa", emoji: "🏠", days: 1, importo: 800, variabile: false }], inArrivoTotale: 3,
};
let n = 0;
async function run({ mode, query = {}, resp = [], h }) {
  responses = [...resp]; shown = []; requests = []; widgetTexts = []; completed = false;
  handler = h || ((r) => (r.method === "POST" ? { ok: true } : data));
  globalThis.config = { runsInWidget: mode === "widget", runsInApp: mode !== "widget" };
  globalThis.args = { queryParameters: query };
  await import(pathToFileURL(`${OUT}/script_under_test.mjs`).href + `?n=${++n}`);
  assert.ok(completed, "Script.complete() not reached");
  assert.equal(responses.length, 0, `unused scripted responses: ${JSON.stringify(responses)}`);
}
const ok = () => {};

it("quick-add widget script: every flow", async () => {
// 1) widget render shows the new month-card data
await run({ mode: "widget" });
assert.ok(widgetTexts.includes("↑ 217% vs mese scorso"), "delta line");
assert.ok(widgetTexts.some(t => t.startsWith("🏠 Affitto · domani")), "coming-up line");
assert.ok(widgetTexts.includes("+2"), "'+2 more' marker (3 due, 1 shown)");
assert.ok(widgetTexts.includes("886,05"), "spent");
ok("widget: delta vs last month, next bill 'domani', +2 more");

// 1b) older server (no new fields) still renders, without the new lines
const old = { ...data }; delete old.deltaPct; delete old.inArrivo; delete old.inArrivoTotale; delete old.speseMesePrec;
await run({ mode: "widget", h: () => old });
assert.ok(!widgetTexts.some(t => t.includes("vs mese scorso")) && !widgetTexts.some(t => t.includes("Affitto")));
ok("widget: older API response (no new fields) still renders");

// 1c) negative delta and null delta
await run({ mode: "widget", h: () => ({ ...data, deltaPct: -12 }) });
assert.ok(widgetTexts.includes("↓ 12% vs mese scorso"));
await run({ mode: "widget", h: () => ({ ...data, deltaPct: null }) });
assert.ok(!widgetTexts.some(t => t.includes("vs mese scorso")));
ok("widget: ↓ for savings, nothing when there's no comparison");

// 2) first expense, no memory: full questions, payload checked
const today = (() => { const d = new Date(), p = x => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
await run({ mode: "app", query: { add: "uscita" }, resp: [
  { idx: 0, fields: ["12,50", "Pizza"] },  // form
  { idx: 0 },                               // category: Cibo
  { idx: 1 },                               // who paid: Laura
  { idx: 1 },                               // split: equally
  { idx: 0 },                               // account: Banca
  { idx: 0 },                               // "Registrata" OK
] });
let post = requests.find(r => r.method === "POST");
assert.equal(post.url, "https://example.test/api/widget/transaction?key=TESTKEY");
assert.equal(post.headers["Idempotency-Key"], "uuid-1");
assert.deepEqual(post.body, { tipo: "uscita", importo: 12.5, descrizione: "Pizza", data: today, categoria: "cibo", pagatoDa: "l", splits: [{ personaId: "g", quota: 50 }, { personaId: "l", quota: 50 }], contoId: "c1" });
ok("first expense: all questions asked, local date + Idempotency-Key sent, splits sum to 100");
const saved = JSON.parse(files.get("/docs/finanza-widget-state.json"));
assert.deepEqual(saved.last.uscita, { pagatoDa: "l", split: "equa", contoId: "c1" });
ok("choices remembered after a successful save");

// 3) second expense: one-tap "same as last time"
await run({ mode: "app", query: { add: "uscita" }, resp: [
  { idx: 0, fields: ["8", ""] },
  { idx: 1 },                  // category: Casa
  { idx: 0 },                  // "Come l'ultima volta?" → Salva così
  { idx: 0 },                  // Registrata OK
] });
assert.equal(shown[2].title, "Come l'ultima volta?");
assert.equal(shown[2].message, "Paga: 👩 Laura\nDivisa equamente tra tutti (2)\nConto: 🏦 Banca");
post = requests.find(r => r.method === "POST");
assert.deepEqual(post.body, { tipo: "uscita", importo: 8, descrizione: "", data: today, categoria: "casa", pagatoDa: "l", splits: [{ personaId: "g", quota: 50 }, { personaId: "l", quota: 50 }], contoId: "c1" });
ok("second expense: amount + category + ONE tap, same payer/split/account");

// 3b) "Cambia" goes back to the full questions
await run({ mode: "app", query: { add: "uscita" }, resp: [
  { idx: 0, fields: ["5", ""] }, { idx: 0 },
  { idx: 1 },                  // Cambia
  { idx: 2 },                  // payer: Nessuno (personale)
  { idx: 2 },                  // account: Nessuno
  { idx: 0 },
] });
post = requests.find(r => r.method === "POST");
assert.equal(post.body.pagatoDa, undefined); assert.equal(post.body.splits, undefined); assert.equal(post.body.contoId, undefined);
ok("'Cambia' re-asks everything; personal expense has no payer/splits/account");

// 3c) a remembered account that no longer exists is not offered again
files.set("/docs/finanza-widget-state.json", JSON.stringify({ last: { uscita: { pagatoDa: "x-deleted", split: "equa", contoId: "c-deleted" } } }));
await run({ mode: "app", query: { add: "uscita" }, resp: [
  { idx: 0, fields: ["3", ""] }, { idx: 0 },
  { idx: 0 },                  // "Come l'ultima volta?" (personale, nessun conto)
  { idx: 0 },
] });
assert.equal(shown[2].message, "Personale\nNessun conto");
post = requests.find(r => r.method === "POST");
assert.equal(post.body.pagatoDa, undefined); assert.equal(post.body.contoId, undefined);
ok("stale memory (deleted person/account) is dropped, not resent");

// 4) income: remembered "intestata a" + account
await run({ mode: "app", query: { add: "entrata" }, resp: [
  { idx: 0, fields: ["1000", "Stipendio"] }, { idx: 1 }, { idx: 1 }, { idx: 0 },
] });
post = requests.find(r => r.method === "POST");
assert.deepEqual(post.body, { tipo: "entrata", importo: 1000, descrizione: "Stipendio", data: today, intestataA: "l", contoId: "c2" });
await run({ mode: "app", query: { add: "entrata" }, resp: [{ idx: 0, fields: ["50", ""] }, { idx: 0 }, { idx: 0 }] });
assert.equal(shown[1].message, "Intestata a: 👩 Laura\nConto: 💶 Contanti");
ok("income: asked once, then one tap");

// 5) server rejection shows its message, not [object Object]
await run({ mode: "app", query: { add: "entrata" }, resp: [{ idx: 0, fields: ["10", ""] }, { idx: 0 }, { idx: 0 }],
  h: (r) => r.method === "POST" ? { error: { code: "INVALID_AMOUNT", message: "Importo non valido" } } : data });
const err = shown.find(s => s.title === "Errore di salvataggio");
assert.equal(err.message, "Importo non valido");
ok("server error text is shown (not [object Object]); rejection isn't retried");

// 6) network failure → retry with the SAME Idempotency-Key
let calls = 0;
await run({ mode: "app", query: { add: "entrata" }, resp: [{ idx: 0, fields: ["10", ""] }, { idx: 0 /* come l'ultima volta */ }, { idx: 0 /* Riprova */ }, { idx: 0 /* Registrata */ }],
  h: (r) => { if (r.method !== "POST") return data; if (++calls === 1) throw new Error("The Internet connection appears to be offline"); return { ok: true }; } });
const posts = requests.filter(r => r.method === "POST");
assert.equal(posts.length, 2);
assert.equal(posts[0].headers["Idempotency-Key"], posts[1].headers["Idempotency-Key"]);
assert.ok(shown.some(s => s.title === "Connessione assente"));
ok("network drop: asks to retry, retry reuses the Idempotency-Key (no duplicate)");

// 6b) declining the retry ends with an error alert, one POST only
calls = 0;
await run({ mode: "app", query: { add: "entrata" }, resp: [{ idx: 0, fields: ["10", ""] }, { idx: 0 }, { idx: -1 /* declina il retry */ }, { idx: 0 /* errore */ }],
  h: (r) => { if (r.method !== "POST") return data; throw new Error("offline"); } });
assert.equal(requests.filter(r => r.method === "POST").length, 1);
ok("declining the retry stops after one attempt");

// 7) validation + cancel paths
await run({ mode: "app", query: { add: "uscita" }, resp: [{ idx: 0, fields: ["abc", ""] }, { idx: 0 }] });
assert.equal(shown[1].title, "Importo non valido");
await run({ mode: "app", query: { add: "uscita" }, resp: [{ idx: -1 }] });
assert.equal(requests.filter(r => r.method === "POST").length, 0);
ok("invalid amount rejected; cancel sends nothing");

// 8) eye toggle keeps the remembered choices
files.set("/docs/finanza-widget-state.json", JSON.stringify({ hidden: false, last: { uscita: { pagatoDa: "g", split: null, contoId: null } } }));
await run({ mode: "app", query: { toggle: "1" } });
const st = JSON.parse(files.get("/docs/finanza-widget-state.json"));
assert.equal(st.hidden, true); assert.equal(st.last.uscita.pagatoDa, "g");
assert.ok(widgetTexts.includes("••••"));
ok("hide toggle persists and keeps 'last' choices; amounts masked");

// 9) unconfigured placeholder
fs.writeFileSync(`${OUT}/script_under_test.mjs`, fs.readFileSync(SCRIPT_PATH, "utf8"));
await run({ mode: "widget" });
assert.ok(widgetTexts.includes("Configura WIDGET_URL nello script"));
ok("placeholder URL → 'Configura WIDGET_URL' message, no network call");


});
