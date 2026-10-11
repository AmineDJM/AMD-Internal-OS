/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FICHE D'UN DOSSIER DE MATÉRIEL PROMOTIONNEL (circuit 2) — ce que l'écran calcule, sans base.
 *
 * Maquette validée par la Direction (10/2026) : une frise de huit étapes, cinq chiffres d'argent, UNE chose à faire
 * (« où — chez qui » et le seul geste utile à la personne qui regarde), les articles demandés avec leurs prestations
 * couvertes ou non, et les devis côte à côte, une ligne par article × prestation, le meilleur prix en vert.
 *
 * Tout ce qui se lit ici se lit sur des FAITS déjà chargés (le chargeur de la fiche) ; les droits arrivent tranchés
 * (`RegardFiche`) — ce module ne décide d'aucun droit, il choisit seulement le geste à montrer parmi ceux permis.
 *
 * Module PUR (aucun import lourd) : lu par la page serveur comme par les composants clients.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PromoAction } from "@/lib/promo-material/actions-fournisseur";
import { totalLigneHT, totauxDeLaSelection, type DevisLu } from "@/lib/promo-material/devis";
import type { ArticleDemandeLu } from "@/lib/promo-material/achats";

// ─────────────────────────────── 1. LES FAITS ───────────────────────────────

export interface FactureFaits {
  id: string;
  montant: number | null;
  /** Lignes détaillées, et celles qui attendent encore leur réception. */
  lignes: number;
  enAttente: number;
  paiementDemande: boolean;
  reglee: boolean;
  demandeIM: boolean;
}

/** Un devis dont une ligne est retenue — et ce qui en découle. */
export interface BcFaits {
  quoteId: string;
  fournisseur: string;
  /** Le numéro du BC émis ; `null` tant qu'il n'est pas émis. */
  reference: string | null;
  /** L'aperçu attend la validation du demandeur (aucun numéro attribué). */
  brouillon: boolean;
  /** L'étape du BC émis (`EtapeBC`), `null` : pas de BC. */
  etape: string | null;
  /** Montant TTC du BC émis. */
  montantBc: number | null;
  envoye: boolean;
  resteAFacturer: boolean;
  factures: FactureFaits[];
}

export interface FaitsDuDossier {
  /** `circuitState` — `null` pour un dossier de l'ancien parcours. */
  etat: string | null;
  annule: boolean;
  enCorrection: boolean;
  devisRecus: number;
  lignesRetenues: number;
  bcs: BcFaits[];
  /** Chaque chantier est-il fait (clos, ou constaté complet sur ses pièces) ? */
  chantiers: { bc: boolean; paiement: boolean; visa: boolean };
  /** Le jour de la demande, déjà mis en forme (« 02/10 »). */
  dateDemande?: string | null;
}

// ─────────────────────────────── 2. LA FRISE ───────────────────────────────

export const ETAPES_FICHE = [
  { cle: "DEMANDE", libelle: "Demande" },
  { cle: "DEVIS", libelle: "Devis" },
  { cle: "CHOIX", libelle: "Choix des lignes" },
  { cle: "BC", libelle: "Bons de commande" },
  { cle: "RECEPTION", libelle: "Réception" },
  { cle: "FACTURES", libelle: "Factures & paiement" },
  { cle: "VISA", libelle: "Visa / déclaration" },
  { cle: "CLOTURE", libelle: "Clôture" },
] as const;

export type CleEtapeFiche = (typeof ETAPES_FICHE)[number]["cle"];
export type EtatEtapeFiche = "fait" | "ici" | "arret" | "avenir";

export interface EtapeFiche {
  cle: CleEtapeFiche;
  libelle: string;
  etat: EtatEtapeFiche;
  detail: string | null;
}

/** Le rang de chaque état du circuit sur la frise : 0 demande, 1 devis, 2 choix, 3 exécution, 8 terminé. */
const RANG: Record<string, number> = {
  REVIEW_REQUEST: 0, QUOTE_TO_REQUEST: 1, QUOTE_REQUESTED: 1,
  REVIEW_REQUESTER: 2, REVIEW_MANAGER: 2, REVIEW_DG: 2, REVIEW_EXECUTIVE: 2, REVIEW_MEDICAL_INFO: 2,
  IN_EXECUTION: 3, COMPLETED: 8,
};

const pl = (n: number, mot: string, motPluriel = `${mot}s`) => `${n} ${n > 1 ? motPluriel : mot}`;

/** Les constats d'exécution — partagés par la frise et par « ce qu'il reste à faire ». */
function constats(f: FaitsDuDossier) {
  const engages = f.bcs;
  const factures = engages.flatMap((b) => b.factures);
  const enAttente = factures.reduce((s, x) => s + (x.paiementDemande ? 0 : x.enAttente), 0);
  const lignesFacturees = factures.reduce((s, x) => s + x.lignes, 0);
  const bcFait = f.chantiers.bc || (engages.length > 0 && engages.every((b) => b.etape === "SIGNE" && b.envoye));
  const receptionFaite = factures.length > 0 && enAttente === 0 && engages.every((b) => b.etape !== null && !b.resteAFacturer);
  const paiementFait = f.chantiers.paiement
    || (factures.length > 0 && factures.every((x) => x.reglee) && engages.every((b) => b.factures.length > 0));
  const visasAttendues = factures.filter((x) => x.paiementDemande).length;
  const visasFaites = factures.filter((x) => x.paiementDemande && x.demandeIM).length;
  const visaFait = f.chantiers.visa || (visasAttendues > 0 && visasFaites === visasAttendues && paiementFait);
  return { engages, factures, enAttente, lignesFacturees, bcFait, receptionFaite, paiementFait, visasAttendues, visasFaites, visaFait };
}

/**
 * LA FRISE EN HUIT ÉTAPES — faites (vert), l'étape courante (bleu ; rouge si le dossier est arrêté), à venir. Les
 * étapes d'exécution avancent en parallèle : chacune se dit faite sur ses pièces, quel que soit l'ordre ; l'étape
 * courante est la PREMIÈRE qui ne l'est pas. Un dossier refusé (ou d'état inconnu) se place d'après ses faits.
 */
export function friseDuDossier(f: FaitsDuDossier): EtapeFiche[] {
  const rangConnu = f.etat ? RANG[f.etat] : undefined;
  const r = rangConnu ?? (f.lignesRetenues > 0 ? 2 : f.devisRecus > 0 ? 1 : 0);
  const c = constats(f);
  const enExecution = r === 3;
  const fini = r >= 8;
  const fait: boolean[] = [
    r > 0, r > 1, r > 2,
    fini || (enExecution && c.bcFait),
    fini || (enExecution && c.receptionFaite),
    fini || (enExecution && c.paiementFait),
    fini || (enExecution && c.visaFait),
    fini,
  ];
  const courante = fait.indexOf(false);
  const arrete = f.annule || f.etat === "REFUSED";

  const brouillons = c.engages.filter((b) => b.brouillon).length;
  const aSigner = c.engages.filter((b) => b.etape !== null && b.etape !== "SIGNE").length;
  const aEnvoyer = c.engages.filter((b) => b.etape === "SIGNE" && !b.envoye).length;
  const envoyes = c.engages.filter((b) => b.envoye).length;
  const detailBc = brouillons > 0 ? `${brouillons} à vérifier`
    : aSigner > 0 ? `${aSigner} à signer`
    : aEnvoyer > 0 ? `${aEnvoyer} à envoyer`
    : c.engages.length > 0 && (enExecution || fini) ? `${envoyes}/${c.engages.length} envoyé${c.engages.length > 1 ? "s" : ""}`
    : null;
  const payees = c.factures.filter((x) => x.reglee).length;
  const details: (string | null)[] = [
    f.dateDemande ?? null,
    f.devisRecus > 0 ? pl(f.devisRecus, "reçu") : null,
    f.lignesRetenues > 0 ? pl(f.lignesRetenues, "ligne") : null,
    detailBc,
    c.lignesFacturees > 0 ? `${c.lignesFacturees - c.enAttente}/${c.lignesFacturees} reçue${c.lignesFacturees > 1 ? "s" : ""}` : null,
    c.factures.length > 0 ? `${payees}/${c.factures.length} payée${c.factures.length > 1 ? "s" : ""}` : null,
    c.visasAttendues > 0 ? `${c.visasFaites}/${c.visasAttendues}` : null,
    null,
  ];
  return ETAPES_FICHE.map((e, i) => ({
    cle: e.cle, libelle: e.libelle, detail: details[i] ?? null,
    etat: fait[i] ? "fait" : i === courante ? (arrete ? "arret" : "ici") : "avenir",
  }));
}

// ─────────────────────────────── 3. LES CINQ CHIFFRES ───────────────────────────────

export interface ChiffresDuDossier {
  budget: number | null;
  retenu: number | null;
  engage: number;
  facture: number;
  paye: number;
}

const cents = (x: number) => Math.round(x * 100);

/**
 * BUDGET ESTIMÉ (la demande), RETENU TTC (les lignes retenues, chaque devis avec SES taxes — la même arithmétique que
 * le choix), ENGAGÉ (les BC émis : un aperçu n'engage rien), FACTURÉ, PAYÉ (factures réglées).
 */
export function chiffresDuDossier(i: { budget: number | null; devis: readonly DevisLu[]; bcs: readonly BcFaits[] }): ChiffresDuDossier {
  const selection = totauxDeLaSelection(i.devis);
  const somme = (xs: number[]) => xs.reduce((s, x) => s + cents(x), 0) / 100;
  const factures = i.bcs.flatMap((b) => b.factures);
  return {
    budget: i.budget,
    retenu: selection.lignes > 0 ? selection.ttc : null,
    engage: somme(i.bcs.filter((b) => b.etape !== null && b.montantBc != null).map((b) => b.montantBc as number)),
    facture: somme(factures.map((f) => f.montant ?? 0)),
    paye: somme(factures.filter((f) => f.reglee).map((f) => f.montant ?? 0)),
  };
}

// ─────────────────────────────── 4. LES ARTICLES ET LEURS PRESTATIONS ───────────────────────────────

/** « retenue » : une ligne RETENUE la chiffre ; « chiffree » : un devis la chiffre, rien n'est retenu ; « manquante » : aucun devis. */
export type EtatPrestation = "retenue" | "chiffree" | "manquante";

export interface ArticleDeLaFiche {
  article: ArticleDemandeLu;
  prestations: { action: PromoAction; etat: EtatPrestation; demandee: boolean }[];
  /** Les fournisseurs dont une ligne retenue chiffre l'article. */
  fournisseurs: string[];
  /** Le hors-taxe des lignes retenues de l'article ; `null` : rien de retenu. */
  coutHT: number | null;
  /** Le coût retenu rapporté à la quantité demandée ; `null` sans quantité ou sans coût. */
  coutUnitaire: number | null;
}

export function articlesDeLaFiche(articles: readonly ArticleDemandeLu[], devis: readonly DevisLu[]): ArticleDeLaFiche[] {
  return [...articles].sort((a, b) => a.position - b.position).map((article) => {
    const lignes = devis.flatMap((d) => d.lines.filter((l) => l.requestItemId === article.id).map((l) => ({ d, l })));
    const retenues = lignes.filter(({ l }) => l.selected);
    const chiffrees = new Set(lignes.map(({ l }) => l.action).filter((a): a is PromoAction => a != null));
    const tenues = new Set(retenues.map(({ l }) => l.action).filter((a): a is PromoAction => a != null));
    const etat = (a: PromoAction): EtatPrestation => (tenues.has(a) ? "retenue" : chiffrees.has(a) ? "chiffree" : "manquante");
    const demandees = article.actions.map((a) => ({ action: a, etat: etat(a), demandee: true }));
    // Une prestation RETENUE que la demande ne nommait pas se montre aussi : c'est ce qui sera commandé.
    const enPlus = [...tenues].filter((a) => !article.actions.includes(a)).map((a) => ({ action: a, etat: "retenue" as const, demandee: false }));
    const coutC = retenues.reduce((s, { l }) => s + cents(totalLigneHT(l)), 0);
    const coutHT = retenues.length > 0 ? coutC / 100 : null;
    return {
      article,
      prestations: [...demandees, ...enPlus],
      fournisseurs: [...new Set(retenues.map(({ d }) => d.supplierName))],
      coutHT,
      coutUnitaire: coutHT != null && article.quantite != null && article.quantite > 0 ? Math.round((coutHT / article.quantite) * 100) / 100 : null,
    };
  });
}

// ─────────────────────────────── 5. LA COMPARAISON DES DEVIS ───────────────────────────────

export interface LigneDeCellule {
  id: string;
  reference: string;
  quantite: number;
  prixUnitaire: number;
  totalHT: number;
  retenue: boolean;
}

export interface RangeeComparaison {
  cle: string;
  articleId: string | null;
  /** Le libellé de la rangée : le nom de l'article, ou la désignation d'une ligne hors demande. */
  libelle: string;
  action: PromoAction | null;
  horsDemande: boolean;
  /** Les lignes de chaque devis (par identifiant de devis) qui chiffrent la rangée — vide : pas chiffrée par ce devis. */
  cellules: Record<string, LigneDeCellule[]>;
  /** Les devis au meilleur prix unitaire de la rangée (égalité : tous). */
  meilleurs: string[];
  /** Rangée « non chiffrée » d'un article : les prestations demandées qu'aucun devis ne chiffre. */
  manquantes: PromoAction[];
}

const normal = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Le prix unitaire d'une cellule : son hors-taxe rapporté à sa quantité. `null` sans quantité. */
export function prixUnitaireDeCellule(lignes: readonly LigneDeCellule[]): number | null {
  const q = lignes.reduce((s, l) => s + l.quantite, 0);
  if (lignes.length === 0 || !(q > 0)) return null;
  return lignes.reduce((s, l) => s + l.totalHT, 0) / q;
}

/** Les devis au meilleur prix d'une rangée — le plus bas prix unitaire ; un seul devis chiffré est le meilleur. */
export function meilleursPrix(cellules: Record<string, readonly LigneDeCellule[]>): string[] {
  const prix = Object.entries(cellules)
    .map(([quoteId, ls]) => ({ quoteId, pu: prixUnitaireDeCellule(ls) }))
    .filter((x): x is { quoteId: string; pu: number } => x.pu != null);
  if (prix.length === 0) return [];
  const min = Math.min(...prix.map((x) => x.pu));
  return prix.filter((x) => x.pu - min <= 0.005).map((x) => x.quoteId);
}

/**
 * LES DEVIS CÔTE À CÔTE — une rangée par article × prestation chiffrée (dans l'ordre de la demande), une rangée
 * « non chiffrée » par article dont une prestation demandée n'a aucun devis, puis les lignes HORS DEMANDE (regroupées
 * par désignation et prestation, d'un devis à l'autre). Une ligne rattachée à un article disparu est hors demande :
 * on ne perd pas une ligne chiffrée parce qu'une demande a été retouchée.
 */
export function comparaisonDesDevis(articles: readonly ArticleDemandeLu[], devis: readonly DevisLu[]): RangeeComparaison[] {
  const connus = new Map(articles.map((a) => [a.id, a]));
  const rangees = new Map<string, RangeeComparaison>();
  const ordreArticles = [...articles].sort((a, b) => a.position - b.position);
  const vide = (): Record<string, LigneDeCellule[]> => Object.fromEntries(devis.map((d) => [d.id, [] as LigneDeCellule[]]));

  // Les rangées des articles, dans l'ordre de leurs prestations demandées d'abord.
  for (const a of ordreArticles) {
    for (const action of a.actions) {
      rangees.set(`${a.id}|${action}`, { cle: `${a.id}|${action}`, articleId: a.id, libelle: a.nom, action, horsDemande: false, cellules: vide(), meilleurs: [], manquantes: [] });
    }
  }
  const horsDemande: RangeeComparaison[] = [];
  for (const d of devis) {
    for (const l of [...d.lines].sort((x, y) => x.position - y.position)) {
      const cellule: LigneDeCellule = {
        id: l.id, reference: l.reference, quantite: Number(l.quantity), prixUnitaire: Number(l.unitPrice), totalHT: totalLigneHT(l), retenue: l.selected,
      };
      const article = l.requestItemId ? connus.get(l.requestItemId) : undefined;
      const action = l.action ?? null;
      let cle: string;
      if (article) {
        cle = `${article.id}|${action ?? "-"}`;
        if (!rangees.has(cle)) {
          rangees.set(cle, { cle, articleId: article.id, libelle: article.nom, action, horsDemande: false, cellules: vide(), meilleurs: [], manquantes: [] });
        }
      } else {
        cle = `hors|${normal(l.reference)}|${action ?? "-"}`;
        if (!rangees.has(cle)) {
          const r: RangeeComparaison = { cle, articleId: null, libelle: l.reference.trim(), action, horsDemande: true, cellules: vide(), meilleurs: [], manquantes: [] };
          rangees.set(cle, r);
          horsDemande.push(r);
        }
      }
      rangees.get(cle)!.cellules[d.id]!.push(cellule);
    }
  }

  const resultat: RangeeComparaison[] = [];
  for (const a of ordreArticles) {
    const siennes = [...rangees.values()].filter((r) => r.articleId === a.id);
    const chiffrees = siennes.filter((r) => Object.values(r.cellules).some((ls) => ls.length > 0));
    // Les prestations demandées dans l'ordre de la demande, puis celles que les devis ajoutent.
    const rang = (r: RangeeComparaison) => { const i = r.action ? a.actions.indexOf(r.action) : -1; return i === -1 ? a.actions.length : i; };
    resultat.push(...chiffrees.sort((x, y) => rang(x) - rang(y)));
    const manquantes = a.actions.filter((act) => !chiffrees.some((r) => r.action === act));
    if (manquantes.length > 0) {
      resultat.push({ cle: `${a.id}|manque`, articleId: a.id, libelle: a.nom, action: null, horsDemande: false, cellules: vide(), meilleurs: [], manquantes });
    }
  }
  resultat.push(...horsDemande);
  for (const r of resultat) r.meilleurs = meilleursPrix(r.cellules);
  return resultat;
}

// ─────────────────────────────── 6. CE QU'IL RESTE À FAIRE ───────────────────────────────

export type CleGeste =
  | "BASCULER" | "VALIDER_ETAPE" | "RESOUMETTRE" | "ENVOYER_DEMANDE_DEVIS" | "TERMINER_RETRANSCRIPTION" | "CHOISIR_LIGNES"
  | "PREPARER_BC" | "VERIFIER_BC" | "MODIFIER_BC" | "ENVOYER_BC" | "DEPOSER_FACTURE" | "RECEPTIONNER" | "DEMANDER_PAIEMENT"
  | "ADRESSER_IM" | "CLORE";

export interface GesteFiche {
  cle: CleGeste;
  libelle: string;
  /** Le devis (donc le BC) que le geste vise, quand il en vise un. */
  quoteId?: string;
}

/** Ce que la personne qui regarde peut faire — tranché au serveur, par les règles des actions. */
export interface RegardFiche {
  peutBasculer: boolean;
  peutTrancher: boolean;
  peutResoumettre: boolean;
  peutEnvoyerDevis: boolean;
  peutRetranscrire: boolean;
  peutChoisir: boolean;
  pilote: boolean;
  peutValiderBc: boolean;
  peutReceptionner: boolean;
}

export interface OuEnEst {
  /** « où » : l'état, en mots courts. */
  etat: string;
  /** « chez qui » ; `null` : personne (terminé, refusé, annulé). */
  chez: string | null;
  ton: "info" | "warning" | "success" | "danger" | "neutral";
}

export interface NomsFiche {
  /** Le nom attendu à l'étape de validation (validateur, assistante, Direction Marketing…). */
  chezEtape: string | null;
  demandeur: string | null;
  /** Le libellé court de l'étape, pour les états que la fiche ne nomme pas elle-même. */
  libelleEtat: string;
}

const LIB_ETAT: Record<string, string> = {
  REVIEW_REQUEST: "Validation de la demande",
  QUOTE_TO_REQUEST: "Demande de devis à envoyer",
  QUOTE_REQUESTED: "Retranscription des devis",
  REVIEW_REQUESTER: "Choix des lignes",
  REVIEW_MANAGER: "Validation Direction Marketing",
  REVIEW_DG: "Validation du Directeur Général",
};

/** OÙ EN EST LE DOSSIER, ET CHEZ QUI — la même phrase pour tous (la pastille de l'en-tête). */
export function ouEnEst(f: FaitsDuDossier, n: NomsFiche): OuEnEst {
  const demandeur = n.demandeur || "le demandeur";
  if (f.annule) return { etat: "Annulé", chez: null, ton: "neutral" };
  if (!f.etat) return { etat: n.libelleEtat, chez: null, ton: "neutral" };
  if (f.etat === "REFUSED") return { etat: "Refusé", chez: null, ton: "danger" };
  if (f.etat === "COMPLETED") return { etat: "Terminé", chez: null, ton: "success" };
  if (f.enCorrection) return { etat: "À corriger", chez: demandeur, ton: "warning" };
  if (f.etat !== "IN_EXECUTION") {
    const chezDemandeur = f.etat === "QUOTE_TO_REQUEST" || f.etat === "REVIEW_REQUESTER";
    return { etat: LIB_ETAT[f.etat] ?? n.libelleEtat, chez: chezDemandeur ? demandeur : n.chezEtape, ton: "warning" };
  }
  const c = constats(f);
  const b = c.engages;
  const tous = b.flatMap((x) => x.factures.map((fa) => ({ x, fa })));
  if (b.some((x) => x.brouillon)) return { etat: "BC à vérifier", chez: demandeur, ton: "warning" };
  if (b.some((x) => !x.brouillon && x.etape === null)) return { etat: "BC à préparer", chez: demandeur, ton: "warning" };
  if (b.some((x) => x.etape === "A_REVOIR" || x.etape === "A_CORRIGER" || x.etape === "REFUSE")) return { etat: "BC à corriger", chez: demandeur, ton: "warning" };
  if (b.some((x) => x.etape === "A_VALIDER" || x.etape === "SANS_PORTE")) return { etat: "Validation des BC", chez: "le centre Ad & Pro", ton: "info" };
  if (b.some((x) => x.etape === "A_SIGNER")) return { etat: "Signature des BC", chez: "les Finances", ton: "info" };
  if (b.some((x) => x.etape === "SIGNE" && !x.envoye)) return { etat: "BC à envoyer", chez: demandeur, ton: "warning" };
  if (tous.some(({ fa }) => !fa.paiementDemande && fa.enAttente > 0)) return { etat: "Réception à cocher", chez: demandeur, ton: "warning" };
  if (tous.some(({ fa }) => !fa.paiementDemande)) return { etat: "Paiement à demander", chez: demandeur, ton: "warning" };
  if (tous.some(({ fa }) => fa.paiementDemande && !fa.demandeIM)) return { etat: "Visa à demander", chez: demandeur, ton: "warning" };
  if (b.some((x) => x.resteAFacturer || x.factures.length === 0)) return { etat: "Factures attendues", chez: demandeur, ton: "info" };
  if (tous.some(({ fa }) => !fa.reglee)) return { etat: "Paiement", chez: "les Finances", ton: "info" };
  return { etat: "Clôture", chez: demandeur, ton: "warning" };
}

/**
 * LE GESTE UTILE À LA PERSONNE QUI REGARDE — un seul, choisi dans l'ordre où le dossier avance, parmi ceux que ses
 * droits permettent ; `null` : rien à faire de son côté (l'écran dit alors « En attente — chez … »).
 */
export function prochainGeste(f: FaitsDuDossier, r: RegardFiche): GesteFiche | null {
  if (f.annule || f.etat === "REFUSED" || f.etat === "COMPLETED") return null;
  if (!f.etat) return r.peutBasculer ? { cle: "BASCULER", libelle: "Basculer sur le circuit actuel" } : null;
  if (f.enCorrection) return r.peutResoumettre ? { cle: "RESOUMETTRE", libelle: "Corriger et resoumettre la demande" } : null;
  switch (f.etat) {
    case "REVIEW_REQUEST": return r.peutTrancher ? { cle: "VALIDER_ETAPE", libelle: "Valider la demande" } : null;
    case "QUOTE_TO_REQUEST": return r.peutEnvoyerDevis ? { cle: "ENVOYER_DEMANDE_DEVIS", libelle: "Envoyer la demande de devis" } : null;
    case "QUOTE_REQUESTED": return r.peutRetranscrire ? { cle: "TERMINER_RETRANSCRIPTION", libelle: "Retranscrire les devis, puis les envoyer au demandeur" } : null;
    case "REVIEW_REQUESTER": return r.peutChoisir ? { cle: "CHOISIR_LIGNES", libelle: "Retenir vos lignes dans les devis" } : null;
    case "IN_EXECUTION": break;
    default: return r.peutTrancher ? { cle: "VALIDER_ETAPE", libelle: "Valider le choix" } : null;
  }
  const c = constats(f);
  const b = c.engages;
  const nom = (x: BcFaits) => (x.reference ? `BC ${x.reference}` : `BC ${x.fournisseur}`);
  const brouillon = b.find((x) => x.brouillon);
  if (brouillon && r.peutValiderBc) return { cle: "VERIFIER_BC", libelle: `Vérifier et valider le BC — ${brouillon.fournisseur}`, quoteId: brouillon.quoteId };
  if (r.pilote && b.some((x) => !x.brouillon && x.etape === null)) return { cle: "PREPARER_BC", libelle: "Préparer les bons de commande" };
  const aCorriger = b.find((x) => x.etape === "A_REVOIR" || x.etape === "A_CORRIGER");
  if (aCorriger && r.pilote) return { cle: "MODIFIER_BC", libelle: `Corriger le ${nom(aCorriger)}`, quoteId: aCorriger.quoteId };
  const aEnvoyer = b.find((x) => x.etape === "SIGNE" && !x.envoye);
  if (aEnvoyer && r.pilote) return { cle: "ENVOYER_BC", libelle: `Envoyer le ${nom(aEnvoyer)} au fournisseur`, quoteId: aEnvoyer.quoteId };
  const aRecevoir = b.find((x) => x.factures.some((fa) => !fa.paiementDemande && fa.enAttente > 0));
  if (aRecevoir && r.peutReceptionner) return { cle: "RECEPTIONNER", libelle: `Cocher la réception — ${aRecevoir.fournisseur}`, quoteId: aRecevoir.quoteId };
  if (r.pilote) {
    const aPayer = b.find((x) => x.factures.some((fa) => !fa.paiementDemande && fa.enAttente === 0));
    if (aPayer) return { cle: "DEMANDER_PAIEMENT", libelle: `Demander le paiement — ${aPayer.fournisseur}`, quoteId: aPayer.quoteId };
    const aViser = b.find((x) => x.factures.some((fa) => fa.paiementDemande && !fa.demandeIM));
    if (aViser) return { cle: "ADRESSER_IM", libelle: `Adresser le visa / la déclaration — ${aViser.fournisseur}`, quoteId: aViser.quoteId };
    const aFacturer = b.find((x) => x.etape === "SIGNE" && x.envoye && x.resteAFacturer);
    if (aFacturer) return { cle: "DEPOSER_FACTURE", libelle: `Déposer la facture du ${nom(aFacturer)}`, quoteId: aFacturer.quoteId };
    if (c.bcFait && c.paiementFait && c.visaFait) return { cle: "CLORE", libelle: "Clore le dossier" };
  }
  return null;
}

// ─────────────────────────────── 7. LE TABLEAU « COMMANDES » ───────────────────────────────
//
// Maquette validée (Direction, 10/2026, étape 4 « Commande, livraison, paiement ») : une ligne par BC — Fournisseur,
// BC, TTC, Livraison, Facture, Paiement, Visa / déclaration IM — chaque état en UNE pastille « état — chez qui », et UN
// seul bouton : le prochain geste de la personne qui regarde. La réception se coche sur les lignes de la FACTURE (elle
// est ce qui entre au stock, §118.165) : la facture se joint donc avant « J'ai reçu ».

export type TonPastille = "info" | "warning" | "success" | "danger" | "neutral";
export interface Pastille { texte: string; ton: TonPastille }

/** Une facture d'une ligne du tableau, en faits. */
export interface FactureDeCommande {
  /** Lignes détaillées (0 : facture d'avant le détail), celles qui attendent leur réception, celles reçues, celles renoncées. */
  lignes: number;
  enAttente: number;
  recues: number;
  renoncees: number;
  /** La dernière réception cochée (ISO), s'il y en a une. */
  derniereReception: string | null;
  paiementDemande: boolean;
  reglee: boolean;
  /** L'état du règlement (`EtatReglement` : REGLE, AU_CENTRE, REFUSE, AUX_FINANCES, NON_ENVOYE). */
  etatReglement: string;
  demandeIM: boolean;
}

/** Une ligne du tableau « Commandes » — un devis retenu, son BC et ce qui en découle. */
export interface CommandeFaits {
  /** L'étape du BC émis (`EtapeBC`) ; `null` : pas de BC émis. */
  etape: string | null;
  /** L'aperçu attend la validation du demandeur. */
  brouillon: boolean;
  /** Envoyé au fournisseur le (ISO). */
  envoyeLe: string | null;
  resteAFacturer: boolean;
  factures: FactureDeCommande[];
}

export interface PastillesDeCommande {
  /** Où est le BC tant qu'il n'est pas parti ; `null` une fois envoyé (la livraison prend le relais). */
  bc: Pastille | null;
  livraison: Pastille | null;
  facture: Pastille | null;
  paiement: Pastille | null;
  visa: Pastille | null;
}

const deux = (n: number) => String(n).padStart(2, "0");
/** « 20/10 » — le jour et le mois d'une date ISO. */
export function jourMois(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${deux(d.getDate())}/${deux(d.getMonth() + 1)}`;
}

/** Où est le BC, en une pastille. */
function pastilleBc(c: CommandeFaits): Pastille | null {
  if (c.etape === null) return c.brouillon ? { texte: "aperçu à vérifier", ton: "warning" } : { texte: "à préparer", ton: "neutral" };
  switch (c.etape) {
    case "A_SIGNER": return { texte: "chez les Finances", ton: "info" };
    case "A_VALIDER": return { texte: "au centre Ad & Pro", ton: "info" };
    case "SANS_PORTE": return { texte: "à adresser au centre", ton: "warning" };
    case "A_REVOIR": case "A_CORRIGER": return { texte: "à corriger", ton: "warning" };
    case "REFUSE": return { texte: "refusé", ton: "danger" };
    case "SIGNE": return c.envoyeLe ? null : { texte: "signé — à envoyer", ton: "warning" };
    default: return { texte: "en cours", ton: "neutral" };
  }
}

/** La livraison — lue sur les lignes des factures, là où la réception se coche. */
function pastilleLivraison(c: CommandeFaits): Pastille | null {
  const detaillees = c.factures.filter((f) => f.lignes > 0);
  if (detaillees.length === 0) {
    if (c.factures.length > 0) return null; // une facture d'avant le détail : pas de réception à suivre
    return c.etape === "SIGNE" && c.envoyeLe ? { texte: "attendue", ton: "warning" } : null;
  }
  const lignes = detaillees.reduce((s, f) => s + f.lignes, 0);
  const enAttente = detaillees.reduce((s, f) => s + f.enAttente, 0);
  const recues = detaillees.reduce((s, f) => s + f.recues, 0);
  if (enAttente > 0) return recues > 0 ? { texte: `en partie — ${recues}/${lignes}`, ton: "warning" } : { texte: "attendue", ton: "warning" };
  if (detaillees.some((f) => f.renoncees > 0)) return { texte: "reçue en partie", ton: "neutral" };
  const dates = detaillees.map((f) => f.derniereReception).filter((x): x is string => Boolean(x)).sort();
  const derniere = dates.length ? jourMois(dates[dates.length - 1]) : "";
  return { texte: derniere ? `reçue le ${derniere}` : "reçue", ton: "success" };
}

function pastilleFacture(c: CommandeFaits): Pastille | null {
  if (c.factures.length === 0) return c.etape === "SIGNE" ? { texte: "attendue", ton: "neutral" } : null;
  if (c.resteAFacturer) return { texte: "en partie", ton: "warning" };
  return { texte: c.factures.length > 1 ? `${c.factures.length} jointes` : "jointe", ton: "success" };
}

/** Le règlement — la facture la moins avancée dit où en est la ligne. */
function pastillePaiement(c: CommandeFaits): Pastille | null {
  if (c.factures.length === 0) return null;
  if (c.factures.some((f) => !f.paiementDemande)) return { texte: "à demander", ton: "warning" };
  const enCours = c.factures.filter((f) => !f.reglee);
  if (enCours.length === 0) return { texte: "payé", ton: "success" };
  if (enCours.some((f) => f.etatReglement === "REFUSE")) return { texte: "refusé par le centre de paiement", ton: "danger" };
  if (enCours.some((f) => f.etatReglement === "NON_ENVOYE")) return { texte: "à redemander", ton: "warning" };
  if (enCours.some((f) => f.etatReglement === "AU_CENTRE")) return { texte: "au centre de paiement", ton: "info" };
  return { texte: "chez les Finances", ton: "info" };
}

/** Le visa ou la déclaration — il part AVEC chaque paiement ; « à adresser » ne se voit que si son départ a échoué. */
function pastilleVisa(c: CommandeFaits): Pastille | null {
  const payees = c.factures.filter((f) => f.paiementDemande);
  if (payees.length === 0) return null;
  if (payees.some((f) => !f.demandeIM)) return { texte: "à adresser", ton: "warning" };
  return { texte: "demandée avec le paiement", ton: "info" };
}

/** LES PASTILLES D'UNE LIGNE — une par colonne, `null` : rien encore (« — »). */
export function pastillesDeLaCommande(c: CommandeFaits): PastillesDeCommande {
  return { bc: pastilleBc(c), livraison: pastilleLivraison(c), facture: pastilleFacture(c), paiement: pastillePaiement(c), visa: pastilleVisa(c) };
}

export type CleGesteCommande = "RECEPTIONNER" | "DEMANDER_PAIEMENT" | "DEPOSER_FACTURE";

/** Ce que la personne qui regarde peut faire sur le tableau — tranché au serveur. */
export interface RegardCommande {
  /** Le dossier est en exécution. */
  ouvert: boolean;
  /** Le demandeur, l'assistante de direction, la Direction (`piloteLExecution`). */
  pilote: boolean;
  /** Le demandeur (le Super Admin en suppléance) coche la réception. */
  peutReceptionner: boolean;
}

/**
 * LE SEUL BOUTON DE LA LIGNE — le prochain geste de la personne qui regarde, dans l'ordre où la ligne avance :
 * « J'ai reçu » (une facture attend sa réception), « Demander le paiement » (une facture reçue n'est pas partie au
 * règlement — le visa ou la déclaration part avec), « Joindre la facture » (le BC envoyé reste à facturer). Les autres
 * gestes (aperçu, envoi, correction, renoncement…) restent dans « ⋯ » ; `null` : rien à faire de son côté.
 */
export function gesteDeLaCommande(c: CommandeFaits, r: RegardCommande): { cle: CleGesteCommande; libelle: string } | null {
  if (!r.ouvert || c.etape !== "SIGNE") return null;
  if (r.peutReceptionner && c.factures.some((f) => !f.paiementDemande && f.enAttente > 0)) return { cle: "RECEPTIONNER", libelle: "J'ai reçu" };
  if (!r.pilote) return null;
  if (c.factures.some((f) => !f.paiementDemande && f.enAttente === 0)) return { cle: "DEMANDER_PAIEMENT", libelle: "Demander le paiement" };
  if (c.envoyeLe && c.resteAFacturer) return { cle: "DEPOSER_FACTURE", libelle: "Joindre la facture" };
  return null;
}

/** LE TOTAL DU TABLEAU — le TTC de chaque ligne (celui du BC émis, sinon le retenu), au centime. */
export function totalDesCommandes(lignes: readonly { ttc: number }[]): number {
  return lignes.reduce((s, l) => s + Math.round(l.ttc * 100), 0) / 100;
}

/**
 * LA FORMALITÉ PROPOSÉE au paiement suivant — celle de la dernière demande déjà adressée pour ce dossier (visa
 * publicitaire ou déclaration au ministère) : le même matériel suit la même formalité. `null` : à choisir.
 */
export function formaliteDuDossier(demandes: readonly ({ formalite?: string | null } | null)[]): "AD_VISA" | "MIP" | null {
  for (let i = demandes.length - 1; i >= 0; i--) {
    const f = demandes[i]?.formalite;
    if (f === "AD_VISA" || f === "MIP") return f;
  }
  return null;
}

/**
 * LE DOSSIER EST-IL SOLDÉ ? — la condition de la CLÔTURE AUTOMATIQUE : chaque BC est signé, entièrement facturé, chaque
 * facture reçue (ou son reliquat renoncé), partie au règlement, réglée, et sa demande de visa ou de déclaration adressée.
 * Aucun BC : rien n'est soldé. Le serveur relit en plus les verdicts des chantiers (`promo-cloture.ts`).
 */
export function commandesSoldees(bcs: readonly {
  etape: string | null; resteAFacturer: boolean;
  factures: readonly Pick<FactureFaits, "enAttente" | "paiementDemande" | "reglee" | "demandeIM">[];
}[]): boolean {
  return bcs.length > 0 && bcs.every((b) => b.etape === "SIGNE" && !b.resteAFacturer && b.factures.length > 0
    && b.factures.every((f) => f.enAttente === 0 && f.paiementDemande && f.reglee && f.demandeIM));
}
