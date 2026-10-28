/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FILE « À CONFIRMER » — qui tranche, et ce qu'un fait confirmé change sur la fiche. Module PUR.
 *
 * ── QUI TRANCHE ──────────────────────────────────────────────────────────────────────────────
 *
 * Le référentiel n'a pas (encore) de « responsable de fiche » en base. En attendant la décision de la
 * Direction (`docs/architecture/refonte-vague-2.md`, V2-A), le responsable d'un fait est la personne
 * qui a DÉPOSÉ la pièce dont il vient — elle connaît le contexte (le voyageur, le fournisseur) — et le
 * Super Admin. Une pièce déposée par un système (e-mail entrant) n'a que le Super Admin.
 *
 * ── CE QUE LA CONFIRMATION ÉCRIT SUR LA FICHE ────────────────────────────────────────────────
 *
 * `FaitConfirme` garde toujours l'historique. Certaines valeurs ont en plus une COLONNE sur la fiche,
 * mise à jour au même geste : le nom et les prénoms d'une Personne, la raison sociale, la forme
 * juridique et le site d'une Organisation. Les autres (coordonnées, adresses) vivent dans le
 * `FaitConfirme` jusqu'au lot des lieux et coordonnées (V2-D), qui les projettera.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface Trancheur {
  userId: string;
  superAdmin: boolean;
}

/** Le trancheur peut-il confirmer, rejeter ou trancher un fait venu d'une pièce déposée par `deposeParId` ? */
export function peutTrancher(t: Trancheur, piece: { deposeParId: string | null }): boolean {
  return t.superAdmin || (piece.deposeParId !== null && piece.deposeParId === t.userId);
}

export type ColonnesPersonne = Partial<Record<"nom" | "prenoms" | "civilite", string>> & { naissance?: Date };
export type ColonnesOrganisation = Partial<Record<"raisonSociale" | "formeJuridique" | "siteWeb", string>>;

/** La colonne de la fiche Personne que porte un attribut confirmé — `null` : l'historique suffit. */
export function colonnesPersonne(attribut: string, valeur: string): ColonnesPersonne | null {
  const v = valeur.trim();
  if (!v) return null;
  switch (attribut) {
    case "personne.nom": return { nom: v };
    case "personne.prenoms": return { prenoms: v };
    case "personne.civilite": return { civilite: v };
    case "personne.naissance": {
      const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null;
      return d && !Number.isNaN(d.getTime()) ? { naissance: d } : null;
    }
    default: return null;
  }
}

/** La colonne de la fiche Organisation que porte un attribut confirmé — `null` : l'historique suffit. */
export function colonnesOrganisation(attribut: string, valeur: string): ColonnesOrganisation | null {
  const v = valeur.trim();
  if (!v) return null;
  switch (attribut) {
    case "organisation.raisonSociale": return { raisonSociale: v };
    case "organisation.formeJuridique": return { formeJuridique: v };
    case "organisation.siteWeb": return { siteWeb: v };
    default: return null;
  }
}

/** L'identifiant d'organisation (`OrganisationIdentifiant.type`) que porte un attribut confirmé. */
export function typeIdentifiantOrganisation(attribut: string): "NIF" | "NIS" | "RC" | "AI" | null {
  switch (attribut) {
    case "organisation.nif": return "NIF";
    case "organisation.nis": return "NIS";
    case "organisation.rc": return "RC";
    case "organisation.ai": return "AI";
    default: return null;
  }
}
