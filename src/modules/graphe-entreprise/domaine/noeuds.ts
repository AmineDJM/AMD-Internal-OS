/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES NŒUDS ET LES ARÊTES DU GRAPHE DE L'ENTREPRISE (J9, décision 0021) — règle PURE, zéro import.
 *
 * Un nœud n'est PAS une ligne d'un second registre : c'est une RÉFÉRENCE vers la fiche canonique qui existe déjà
 * (`Personne`, `Organisation`, `Product`, `RegulatoryProduct`, une demande Ad & Pro, un congrès, une `Piece`). Son
 * identifiant s'écrit `TYPE:id`. Quand une ligne métier n'a pas (encore) de fiche canonique — un utilisateur sans
 * `Personne`, un fournisseur sans `Organisation` —, l'identifiant garde un préfixe qui le dit (`u:`, `f:`…) : un
 * nœud de repli n'est jamais présenté comme canonique.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const TYPES_NOEUD = ["PERSONNE", "ORGANISATION", "PRODUIT", "DOSSIER", "DEMANDE_AD_PRO", "CONGRES", "DOCUMENT"] as const;
export type TypeNoeud = (typeof TYPES_NOEUD)[number];

export const LIBELLE_TYPE_NOEUD: Record<TypeNoeud, string> = {
  PERSONNE: "personne",
  ORGANISATION: "organisation",
  PRODUIT: "produit",
  DOSSIER: "dossier réglementaire",
  DEMANDE_AD_PRO: "demande Ad & Pro",
  CONGRES: "congrès",
  DOCUMENT: "document",
};

export const estTypeNoeud = (v: unknown): v is TypeNoeud => typeof v === "string" && (TYPES_NOEUD as readonly string[]).includes(v);

/** `PERSONNE:ck…` → { type, id } ; `null` pour toute autre forme. */
export function lireRef(ref: string): { type: TypeNoeud; id: string } | null {
  const i = ref.indexOf(":");
  if (i <= 0) return null;
  const type = ref.slice(0, i);
  const id = ref.slice(i + 1);
  return estTypeNoeud(type) && id ? { type, id } : null;
}

export const ref = (type: TypeNoeud, id: string): string => `${type}:${id}`;
export const typeDe = (r: string): TypeNoeud | null => lireRef(r)?.type ?? null;

/**
 * D'OÙ VIENT UNE ARÊTE OU UN FAIT — la provenance, toujours. `table#id` désigne la ligne qui l'a produit ;
 * `piece` la pièce qui l'atteste quand il y en a une ; `par` qui l'a posé ou confirmé ; `le` quand.
 */
export interface Provenance {
  table: string;
  id: string;
  piece?: string | null;
  par?: string | null;
  le?: string | null;
}

export const texteProvenance = (p: Provenance): string =>
  [`${p.table}#${p.id}`, p.piece ? `pièce ${p.piece}` : null, p.par ? `par ${p.par}` : null, p.le ? `le ${p.le}` : null].filter(Boolean).join(" · ");

/** UNE ARÊTE DATÉE. `depuis` inclus, `jusqua` exclu ; absent = sans borne. */
export interface AreteDatee {
  de: string;
  a: string;
  /** Vocabulaire `RELATIONS` (libre pour un lien déclaré : `lie_a`). */
  relation: string;
  depuis: Date | null;
  jusqua: Date | null;
  source: Provenance;
  note?: string | null;
}

/** Les relations, et la phrase qui les dit dans le sens de l'arête (de → a). */
export const RELATIONS: Record<string, string> = {
  lie_a: "est lié à",
  affilie_a: "est affilié à",
  employe_par: "est employé par",
  responsable_de: "est responsable de",
  assiste: "assiste sur",
  demande: "a demandé",
  instruit: "instruit",
  decide: "a décidé",
  concerne: "concerne",
  fourni_par: "est fourni par",
  porte_par: "est porté par",
  organise_par: "est organisé par",
  beneficiaire: "bénéficie à",
  mentionne: "mentionne",
  atteste: "atteste",
  depose: "a déposé",
};

export const phraseRelation = (relation: string): string => RELATIONS[relation] ?? relation.replace(/_/g, " ").toLowerCase();

/** Une arête est-elle valide à cet instant ? */
export function valideA(a: Pick<AreteDatee, "depuis" | "jusqua">, quand: Date): boolean {
  const t = quand.getTime();
  if (a.depuis && t < a.depuis.getTime()) return false;
  if (a.jusqua && t >= a.jusqua.getTime()) return false;
  return true;
}

/** La clé d'une arête : deux sources qui disent la même chose sur la même ligne ne font qu'une arête. */
export const cleArete = (a: AreteDatee): string => `${a.de}|${a.relation}|${a.a}|${a.source.table}#${a.source.id}`;
