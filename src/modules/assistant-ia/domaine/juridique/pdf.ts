/**
 * LOT T1 — LES PAGES DEMANDÉES D'UN PDF (« 1-3, 7 », « 2 à 4 », « dernière ») → indices 0-based, dans l'ordre, sans
 * doublon. Pur. Une page hors du document est une ERREUR dite, jamais ignorée en silence.
 */
export function pagesDemandees(spec: string, total: number): number[] | { erreur: string } {
  const s = spec.toLowerCase().replace(/\s+/g, " ").replace(/\s+(?:à|a|au)\s+/g, "-").replace(/derni[eè]re/g, String(total)).trim();
  if (!s) return { erreur: "aucune page demandée" };
  const out: number[] = [];
  for (const morceau of s.split(/[,;]| et /).map((x) => x.trim()).filter(Boolean)) {
    const m = morceau.match(/^(?:p(?:ages?)?\.?\s*)?(\d+)\s*(?:-\s*(\d+))?$/);
    if (!m) return { erreur: `« ${morceau} » n'est pas une page ou une plage (ex. « 1-3, 7 »)` };
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a) return { erreur: `plage « ${morceau} » invalide` };
    if (b > total) return { erreur: `page ${b} demandée, le document en compte ${total}` };
    for (let i = a; i <= b; i++) if (!out.includes(i - 1)) out.push(i - 1);
  }
  return out;
}
