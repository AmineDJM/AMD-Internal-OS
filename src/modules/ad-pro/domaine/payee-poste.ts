/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « AGENCE / BÉNÉFICIAIRE » D'UN POSTE DÉCLARÉ — QUI EST PAYÉ (recette sponsoring, 23/11/2026).
 *
 * La fiche d'information médicale lisait « Agence / bénéficiaire : — · BC 051/DG/2026 — Signé » sur le poste
 * billetterie, alors que ce BC est adressé à « Tassili Voyages & Billetterie ». La lecture ne connaissait que
 * l'agence RETENUE (le devis choisi au parcours agence) et le fournisseur saisi sur le poste : un poste commandé
 * hors parcours agence — la billetterie, un fournisseur direct — n'avait ni l'un ni l'autre, et son BC, pourtant
 * signé, ne comptait pas.
 *
 * L'ordre, du plus engageant au plus indicatif :
 *   1. l'agence retenue (le tiers du devis choisi) ;
 *   2. le tiers des BONS DE COMMANDE du poste — ceux signés d'abord, à défaut ceux en circuit ; un BC refusé ne
 *      dit pas qui est payé. Un poste peut en porter un par devis (§118.206) : les tiers distincts se lisent tous ;
 *   3. le fournisseur saisi sur le poste ;
 *   4. le tiers des devis acceptés (ni annulés, ni écartés) ;
 *   sinon rien — l'écran écrit « — ».
 *
 * Module PUR, sans aucun import : lu par la requête des postes déclarés (`infra/requetes/postes-declares.ts`), testé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface SourcesPayee {
  /** Le tiers du devis retenu au parcours agence — `null` sans agence choisie. */
  agenceRetenue: string | null;
  /** Les BC vivants (non annulés) du poste : leur tiers et leur étape (`EtapeBC`, `null` hors lecture). */
  bcs: readonly { tiers: string | null; etape: string | null }[];
  /** Le fournisseur saisi sur le poste. */
  fournisseur: string | null;
  /** Le tiers des devis acceptés du poste. */
  devis: readonly { tiers: string | null }[];
}

const nom = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  return t ? t : null;
};

/** Les noms non vides, sans doublon (à la casse près), dans l'ordre. */
function distincts(noms: readonly (string | null)[]): string[] {
  const vus = new Set<string>();
  const out: string[] = [];
  for (const n of noms) {
    const t = nom(n);
    if (!t || vus.has(t.toLocaleLowerCase("fr"))) continue;
    vus.add(t.toLocaleLowerCase("fr"));
    out.push(t);
  }
  return out;
}

export function payeeDuPoste(s: SourcesPayee): string | null {
  const agence = nom(s.agenceRetenue);
  if (agence) return agence;
  const vivants = s.bcs.filter((b) => b.etape !== "REFUSE");
  const signes = vivants.filter((b) => b.etape === "SIGNE");
  const parBc = distincts((signes.length > 0 ? signes : vivants).map((b) => b.tiers));
  if (parBc.length > 0) return parBc.join(", ");
  const fournisseur = nom(s.fournisseur);
  if (fournisseur) return fournisseur;
  const parDevis = distincts(s.devis.map((d) => d.tiers));
  return parDevis.length > 0 ? parDevis.join(", ") : null;
}
