// ─── Display formatting (MOD-012) ───
// Extracted from App.jsx, used across nearly every feature.
//
// Privacy mode ("hide amounts") is implemented as module-level mutable
// state read by formattaValuta/importoOscurabile, rather than threading a
// prop through every single call site (there are 100+ across the app).
// The root app component keeps this in sync with its own React state via
// setImportiNascosti() on every render; every consumer of this module sees
// the same live value because ES modules are singletons.
let importiNascosti = false;

export function setImportiNascosti(value) {
  importiNascosti = value;
}

export function getImportiNascosti() {
  return importiNascosti;
}

// For compact custom-formatted amounts (chart labels etc.)
export function importoOscurabile(str) {
  return importiNascosti ? "••••" : str;
}

export function formattaValuta(n) {
  if (importiNascosti) return "€ ••••";
  return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(n);
}

export function formattaData(d) {
  return new Date(d).toLocaleDateString("it-IT", { day: "numeric", month: "short" });
}
