// ─── Shared app helpers (MOD-012) ───
// Extracted from App.jsx — small pure/near-pure helpers used across
// multiple features (transactions, goals, stats, exports, ...).
import { t } from "./i18n.js";

// Default categories, seeded client-side only until a household customizes
// them (nothing is written server-side until then — see the settings
// feature's loadCategorie). nome is translated by id; ids/emoji/colore stay
// fixed so stored transaction data and custom-category edits are never
// affected by the display language.
const CATEGORIE_BASE = [
  { id: "cibo", emoji: "🍕", colore: "#FF6B6B" },
  { id: "trasporti", emoji: "🚗", colore: "#4ECDC4" },
  { id: "casa", emoji: "🏠", colore: "#45B7D1" },
  { id: "salute", emoji: "💊", colore: "#96CEB4" },
  { id: "svago", emoji: "🎮", colore: "#FFEAA7" },
  { id: "shopping", emoji: "🛍️", colore: "#DDA0DD" },
  { id: "bollette", emoji: "💡", colore: "#F0A500" },
  { id: "altro", emoji: "📦", colore: "#A8A8A8" },
  { id: "entrata", emoji: "💰", colore: "#4ECDC4" },
];
export function defaultCategorie(lang) {
  return CATEGORIE_BASE.map(c => ({ ...c, nome: t(lang, `cat.${c.id}`) }));
}

export function generaId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// Shared palette for ad-hoc "extra" participants (guests not in the
// household's own persone list) — used wherever one gets created:
// SplitSelector's "+ Person", and the Splitwise CSV importer.
export const COLORI_EXTRA = ["#E17055", "#74B9FF", "#55EFC4", "#FDCB6E", "#A29BFE", "#FF7675", "#00CEC9", "#FAB1A0"];

// Same tolerance as the server (server/validation.js, MOD-002) — keeps the
// pre-submit check and the server's final authority in agreement, so a
// split that passes here won't unexpectedly bounce off the API.
const SPLIT_TOTAL_TOLERANCE = 0.05;
export function splitsTotalOk(splits) {
  if (!splits || splits.length === 0) return true; // no split configured = nothing to check here
  const total = splits.reduce((s, x) => s + (x.quota || 0), 0);
  return Math.abs(total - 100) <= SPLIT_TOTAL_TOLERANCE;
}

export function evalImporto(val) {
  if (!val) return 0;
  // Replace Italian comma with dot, allow both , and . in input
  const s = String(val).replace(/,/g, ".");
  if (/^[0-9.]+$/.test(s)) return parseFloat(s) || 0;
  try {
    const sanitized = s.replace(/[^0-9.+*/\-()]/g, "");
    if (sanitized && /^[0-9.+*/\-()]+$/.test(sanitized)) {
      const result = Function(`"use strict"; return (${sanitized})`)();
      if (typeof result === "number" && isFinite(result)) return Math.round(result * 100) / 100;
    }
  } catch {}
  return 0;
}

// Convenience: get all known people from transactions (household + extras)
export function getAllPersone(transazioni, householdPersone) {
  const known = new Map(householdPersone.map(p => [p.id, p]));
  for (const t of transazioni) {
    if (t.extraPersone && Array.isArray(t.extraPersone)) {
      for (const ep of t.extraPersone) {
        if (!known.has(ep.id)) known.set(ep.id, ep);
      }
    }
    if (t.splits && Array.isArray(t.splits)) {
      for (const s of t.splits) {
        if (!known.has(s.personaId)) known.set(s.personaId, { id: s.personaId, nome: s.personaId, emoji: "👤", colore: "#888" });
      }
    }
  }
  return Array.from(known.values());
}
