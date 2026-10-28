/**
 * COMBIEN A-T-ON DÉPENSÉ SUR CE PRODUIT ? — sans fausse précision comptable (cahier des charges §15, §85).
 *
 * Trois catégories, jamais mélangées :
 *   • DIRECT — une dépense imputée à CE SEUL produit (poste Ad&Pro dont il est l'unique imputation) ;
 *   • ALLOUÉ — sa part d'une dépense PARTAGÉE : un poste réparti entre plusieurs produits, ou un coût de la BU imputé
 *     à aucun produit, réparti selon la règle de l'année (`CoutRepartitionBu`) ;
 *   • NON ALLOUÉ (BU) — ce que la règle de la BU ne répartit pas : affiché à part, jamais ajouté au produit.
 * « Attribué » = direct + alloué, et l'écran le dit en deux nombres.
 *
 * Seul l'argent ACCORDÉ compte (une estimation n'est pas une dépense). Module PUR — testé sans base.
 */

export interface PosteDepense {
  itemId: string;
  libelle: string;
  /** Montant accordé du poste. */
  montant: number;
  businessUnitId: string | null;
  /** Les imputations du poste aux produits (part en % ou montant direct). */
  imputations: { productId: string; pct: number | null; montant: number | null }[];
}

export interface LigneAttribution { itemId: string; libelle: string; montant: number; nature: "DIRECT" | "ALLOUE_POSTE" | "ALLOUE_BU"; detail: string }

export interface Attribution {
  direct: number;
  alloue: number;
  attribue: number;
  /** Coûts des BU du produit imputés à aucun produit ET non couverts par la règle de répartition. */
  nonAlloueBu: number;
  lignes: LigneAttribution[];
  /** Ce qui empêche d'aller plus loin, dit (part manquante, règle à compléter). */
  limites: string[];
}

const arrondi = (n: number) => Math.round(n * 100) / 100;

/** La part d'un poste imputée à un produit : le montant saisi, sinon la part du montant accordé — sinon rien. */
function partDuPoste(p: PosteDepense, productId: string): number | null {
  const i = p.imputations.find((x) => x.productId === productId);
  if (!i) return null;
  if (i.montant !== null) return i.montant;
  if (i.pct !== null) return p.montant * (i.pct / 100);
  return null;
}

/**
 * @param postes   les postes ACCORDÉS de l'année : ceux imputés au produit, et ceux des BU du produit imputés à aucun produit
 * @param repartition  BU → part (0..100) du produit dans les coûts partagés de cette BU ; `totalReparti` BU → somme des parts de tous les produits
 */
export function attribuer(productId: string, postes: readonly PosteDepense[], repartition: Readonly<Record<string, { pct: number; totalReparti: number }>>): Attribution {
  const lignes: LigneAttribution[] = [];
  const limites: string[] = [];
  let direct = 0, alloue = 0, nonAlloueBu = 0;
  for (const p of postes) {
    if (p.imputations.length > 0) {
      const part = partDuPoste(p, productId);
      if (part === null) {
        if (p.imputations.some((i) => i.productId === productId)) limites.push(`« ${p.libelle} » : imputé à ce produit sans part ni montant — compté nulle part.`);
        continue;
      }
      const seul = p.imputations.length === 1;
      if (seul) { direct += part; lignes.push({ itemId: p.itemId, libelle: p.libelle, montant: arrondi(part), nature: "DIRECT", detail: "Imputé à ce seul produit." }); }
      else { alloue += part; lignes.push({ itemId: p.itemId, libelle: p.libelle, montant: arrondi(part), nature: "ALLOUE_POSTE", detail: `Poste partagé entre ${p.imputations.length} produits.` }); }
      continue;
    }
    // Coût de BU imputé à aucun produit : la règle de l'année le répartit, le reste demeure NON ALLOUÉ.
    const r = p.businessUnitId ? repartition[p.businessUnitId] : undefined;
    if (!r) { nonAlloueBu += p.montant; continue; }
    const part = p.montant * (r.pct / 100);
    alloue += part;
    nonAlloueBu += p.montant * Math.max(0, 100 - r.totalReparti) / 100;
    lignes.push({ itemId: p.itemId, libelle: p.libelle, montant: arrondi(part), nature: "ALLOUE_BU", detail: `Coût partagé de la BU, réparti à ${r.pct} %.` });
  }
  return { direct: arrondi(direct), alloue: arrondi(alloue), attribue: arrondi(direct + alloue), nonAlloueBu: arrondi(nonAlloueBu), lignes, limites };
}
