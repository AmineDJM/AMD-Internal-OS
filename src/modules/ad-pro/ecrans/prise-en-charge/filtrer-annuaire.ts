/**
 * LA RECHERCHE DANS L'ANNUAIRE d'un sélecteur de praticiens — une règle pour le formulaire de
 * création et pour la fiche : deux filtres écrits à la main finiraient par ne pas trouver le même
 * praticien pour la même saisie (§118.5). Accents et casse mis à part ; tous les mots doivent
 * apparaître, dans le nom, la spécialité ou l'établissement.
 */
export const PLAFOND_MENU = 50;

const plier = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function filtrerAnnuaire<T extends { name: string; specialty?: string | null; institution?: string | null }>(
  annuaire: T[],
  saisie: string,
  plafond = PLAFOND_MENU,
): T[] {
  const mots = plier(saisie).split(/\s+/).filter(Boolean);
  const out: T[] = [];
  for (const d of annuaire) {
    const texte = plier(`${d.name} ${d.specialty ?? ""} ${d.institution ?? ""}`);
    if (mots.every((m) => texte.includes(m))) out.push(d);
    if (out.length >= plafond) break;
  }
  return out;
}
