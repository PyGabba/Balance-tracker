import { t } from "../../lib/i18n.js";

// ─── Trip guest view — reached via ?viaggio=<token>, no household PIN required ───
export function guestTripDefaultCategorie(lang) {
  return [
    { id: "trasporto", emoji: "✈️", nome: t(lang, "tripcat.trasporto"), colore: "#74B9FF" },
    { id: "alloggio", emoji: "🏨", nome: t(lang, "tripcat.alloggio"), colore: "#A29BFE" },
    { id: "cibo", emoji: "🍝", nome: t(lang, "cat.cibo"), colore: "#55EFC4" },
    { id: "attivita", emoji: "🎡", nome: t(lang, "tripcat.attivita"), colore: "#FDCB6E" },
    { id: "shopping", emoji: "🛍️", nome: t(lang, "cat.shopping"), colore: "#FF7675" },
    { id: "altro", emoji: "📦", nome: t(lang, "cat.altro"), colore: "#A8A8A8" },
  ];
}
