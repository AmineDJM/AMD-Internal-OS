/**
 * OÙ S'OUVRE UN COURRIER — dans le panneau latéral du registre, par-dessus le tableau.
 *
 * Un courrier n'a plus de page à lui (Super Admin, 24/11/2026 : « ça ne sert à rien de créer une page
 * entière dédiée à un document ») : l'adresse porte `?courrier=<id>` et le registre ouvre ce pli dans
 * son panneau. L'ancienne adresse `/courriers/<id>` reste une page d'escale qui renvoie ici, pour les
 * liens déjà partagés.
 *
 * Module PUR — aucune importation : le navigateur et le serveur le lisent.
 */

export const CHEMIN_COURRIERS = "/courriers";

/** Le registre, dans un dossier (`none` = les non classés) ou sans dossier. */
export function lienRegistreCourriers(dossier?: string | null): string {
  return dossier ? `${CHEMIN_COURRIERS}?dossier=${encodeURIComponent(dossier)}` : CHEMIN_COURRIERS;
}

/** Un courrier ouvert dans son panneau — le dossier ouvert, s'il y en a un, reste ouvert derrière. */
export function lienCourrier(id: string, dossier?: string | null): string {
  const base = lienRegistreCourriers(dossier);
  return `${base}${base.includes("?") ? "&" : "?"}courrier=${encodeURIComponent(id)}`;
}
