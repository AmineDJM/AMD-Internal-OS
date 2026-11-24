/** Les dates de l'écran Comptabilité — à l'heure d'Alger, quel que soit le navigateur. Module pur. */

/** « 24 nov. » */
export function dateCourte(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "Africa/Algiers" });
}

/** « 24 nov. 2026 » */
export function dateLongue(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Algiers" });
}

/** La date du jour (AAAA-MM-JJ), à Alger — la valeur d'un champ `type="date"`. */
export function aujourdhuiAlger(): string {
  return new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
}
