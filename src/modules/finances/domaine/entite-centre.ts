/**
 * L'ENTITÉ OUVERTE AU CENTRE DE PAIEMENT — le seul filtre de l'écran.
 *
 * Le centre est UN : tous les paiements d'une société, quelle que soit leur origine (Regulatory,
 * Ad & Pro, RH, moyens généraux…), dans une même file (Super Admin, 24/11/2026 : « un même centre
 * de paiement pour tout »). Les trois sections d'avant (Regulatory / Sales & Marketing / Autres,
 * §118.211) ont disparu : les sièges du centre décidaient déjà de toutes, elles ne faisaient que
 * disperser la file. Seule la SOCIÉTÉ sépare encore — autoriser un paiement d'Adventum et un
 * paiement de Pharmagène sont deux gestes comptablement distincts.
 *
 * Module PUR — aucune importation : l'écran, le chargeur et les bancs le lisent sans rien exécuter.
 */

/** La clé d'adresse de la pastille « Sans entité ». */
export const ENTITE_SANS = "sans-entite";

export interface EntiteChoisissable {
  /** Identifiant de la société, ou `ENTITE_SANS`. */
  cle: string;
  enAttente: number;
}

/**
 * L'ENTITÉ AFFICHÉE — jamais une valeur lue telle quelle.
 *
 * Ordre : la demande de l'adresse, si elle désigne une pastille PRÉSENTE (une valeur forgée ou
 * périmée ne désigne rien) ; sinon l'entité sélectionnée dans la barre supérieure, VALIDÉE contre
 * les droits par l'appelant (`preferee`) ; sinon celle qui attend le plus de décisions ; sinon la
 * première. `null` seulement quand il n'y a aucune pastille.
 */
export function choisirEntite(
  entites: readonly EntiteChoisissable[], demandee: string | null | undefined, preferee: string | null | undefined,
): string | null {
  if (entites.length === 0) return null;
  const presente = (cle: string | null | undefined) => (cle && entites.some((e) => e.cle === cle) ? cle : null);
  const demande = presente(demandee);
  if (demande) return demande;
  const pref = presente(preferee);
  if (pref) return pref;
  let meilleure = entites[0]!;
  for (const e of entites) if (e.enAttente > meilleure.enAttente) meilleure = e;
  return meilleure.cle;
}
