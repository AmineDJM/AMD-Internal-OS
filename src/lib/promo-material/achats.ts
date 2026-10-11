/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ACHATS DU MATÉRIEL PROMOTIONNEL ENTRENT AU STOCK (§118.165) — la règle, sans base.
 *
 * « Le demandeur pioche dans le catalogue : par article, le ou les produits liés et des
 * commentaires — autant d'articles qu'il veut, pour que l'assistante sache clairement quels devis
 * chercher. Elle rapproche les devis reçus de la demande, et génère un BC selon ce qui a été
 * demandé et reçu, et voire plus. La facture doit renseigner exactement le matériel reçu en stock :
 * le demandeur coche, sur la facture décomposée en tableau, les références et quantités reçues,
 * et elles entrent au stock général. Le paiement attend que tout soit reçu — sauf si le demandeur
 * le demande malgré une ligne non livrée : il confirme alors qu'un paiement pour cette ligne ne
 * pourra pas être fait ultérieurement. »
 *
 * ── QUATRE RÈGLES ──────────────────────────────────────────────────────────────────────────
 *
 * 1. UNE FACTURE NE FACTURE QUE CE QUI EST COMMANDÉ. Ses lignes sont celles du BC ; la quantité
 *    et le prix se corrigent pour coller au papier, et l'ÉCART se voit — mais on ne facture pas
 *    plus que ce qui reste à facturer sur une ligne : payer ce que personne n'a commandé, c'est
 *    engager la société sur ce que personne n'a validé.
 * 2. LE TOTAL NE SE SAISIT PAS, IL SE CALCULE (§118.59) — par la MÊME arithmétique que le devis
 *    (`totauxTaxes`). Le total IMPRIMÉ se saisit à part, pour contrôler la saisie : un écart de plus
 *    d'un dinar est une ligne mal recopiée.
 * 3. CE QUI EST REÇU, ET SEULEMENT LUI, EST PAYÉ. Une ligne non livrée (en tout ou en partie) ne se
 *    paie pas ; y RENONCER est définitif — la quantité reste facturée sur sa ligne de BC, donc elle
 *    ne se refacture pas ailleurs. C'est exactement « un paiement pour cette ligne ne pourra pas
 *    être fait ultérieurement ».
 * 4. L'ACTION DÉCIDE DU STOCK. Une impression reçue entre au magasin ; une conception reçue est
 *    « faite » — sauf celle d'un support NUMÉRIQUE, qui EST le support : elle pose son lien au
 *    stock. Une ligne d'avant ce vocabulaire (action nulle) laisse la réception décider, en
 *    choisissant — ou non — l'article du catalogue qui la reçoit.
 *
 * Module PUR — aucune base. Testé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { actionProduit, estAction, type PromoAction } from "@/lib/promo-material/actions-fournisseur";
import { formatDzd, totalLigneHT, totauxTaxes, type DevisLu, type Totaux } from "@/lib/promo-material/devis";

export type FamillePromo = "CONSOMMABLE" | "DURABLE" | "NUMERIQUE";

/**
 * UN ARTICLE DU CATALOGUE TEL QU'UN FORMULAIRE LE PROPOSE — le type vit ICI, dans le domaine, et
 * le chargeur (`queries/promo-achats`) le réexporte. Écrit d'abord chez le chargeur, il faisait
 * importer une FAÇADE par un module du domaine (`ad-pro/create-fields.ts`) : une inversion de
 * couche, même pour un simple type (`domains.test.ts`, §118.171).
 */
export interface OptionCatalogue {
  id: string;
  reference: string;
  nom: string;
  famille: FamillePromo;
  unite: string;
  exigeProduit: boolean;
}

/** Tolérance de comparaison des quantités — trois décimales, comme la base. */
const EPS = 0.0005;
const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const nombre = (n: number): string => n.toLocaleString("fr-FR", { maximumFractionDigits: 3 });

// ─────────────────────────────── 1. LA DEMANDE ───────────────────────────────

export interface ArticleDemandeLu {
  id: string;
  position: number;
  catalogueId: string;
  /** La référence fixe du catalogue (CAT-0042). */
  reference: string;
  nom: string;
  famille: FamillePromo;
  unite: string;
  /** Les produits CANONIQUES liés — ceux que le stock lit à la réception. */
  produits: { id: string; nom: string }[];
  /**
   * CE QUE LA LIGNE PROMEUT, en libellés lisibles (§118.204) : « Société en général », « Gamme … »,
   * les produits des Business Units, « Autre : … ». Absent : ligne d'avant, ses produits canoniques font foi.
   */
  promus?: string[];
  /** Le choix tel que le sélecteur le présélectionne à la correction (codes et saisie « Autre »). */
  choixPromus?: { codes: string[]; autre: string | null };
  quantite: number | null;
  actions: PromoAction[];
  commentaire: string | null;
  /** « Autre article » saisi librement, absent du catalogue (archivé tant qu'un gestionnaire ne l'y a pas ajouté). */
  horsCatalogue?: { description: string | null };
}

/** Ce qu'une ligne promeut, en libellés — les promus quand ils existent, sinon les produits canoniques (ligne d'avant). */
export function libellesPromusDeLArticle(a: Pick<ArticleDemandeLu, "produits" | "promus">): string[] {
  return a.promus && a.promus.length ? a.promus : a.produits.map((p) => p.nom).filter(Boolean);
}

/** « CAT-0042 Fiche posologique — Nivolex · 5 000 pièces » — ce qu'on lit dans un menu ou une phrase. */
export function libelleArticleDemande(a: Pick<ArticleDemandeLu, "reference" | "nom" | "produits" | "promus" | "quantite" | "unite">): string {
  const produits = libellesPromusDeLArticle(a);
  const base = `${a.reference} ${a.nom}${produits.length ? ` — ${produits.join(", ")}` : ""}`;
  return a.quantite != null ? `${base} · ${nombre(a.quantite)} ${a.unite}` : base;
}

export interface CatalogueAValider {
  reference: string;
  nom: string;
  famille: FamillePromo;
  exigeProduit: boolean;
  actif: boolean;
}

export interface ArticleDemandeValide {
  produitIds: string[];
  quantite: number | null;
  actions: PromoAction[];
  commentaire: string | null;
}

/**
 * VALIDER UN ARTICLE DEMANDÉ — tout ce qui manque, en une fois (§118.18).
 *
 * - l'article du catalogue existe et n'est pas archivé ;
 * - un article qui n'existe que pour un produit (fiche posologique) le nomme ;
 * - au moins UNE action — « ce qu'on attend du fournisseur » ; sans elle, l'assistante ne sait pas
 *   s'il faut chercher une agence de conception ou un imprimeur ;
 * - un support NUMÉRIQUE n'a pas de quantité ; ailleurs, la quantité est facultative (une
 *   conception seule n'a rien à compter) mais, donnée, elle est un nombre positif.
 */
export function validerArticleDemande(s: {
  catalogue: CatalogueAValider | null;
  produitIds: readonly string[];
  quantite: number | null;
  /** La saisie brute de la quantité était-elle illisible (« 5 mille ») ? */
  quantiteIllisible: boolean;
  actions: readonly string[];
  commentaire: string | null;
}): { ok: true; article: ArticleDemandeValide } | { ok: false; error: string } {
  if (!s.catalogue) return { ok: false, error: "Choisissez l'article dans le catalogue." };
  const c = s.catalogue;
  if (!c.actif) return { ok: false, error: `${c.reference} est archivé : il ne se commande plus. Choisissez un article actif du catalogue.` };
  const manques: string[] = [];
  const produitIds = [...new Set(s.produitIds.map((x) => x.trim()).filter(Boolean))];
  if (c.exigeProduit && produitIds.length === 0) manques.push(`le ou les produits concernés (${c.nom} n'existe que pour un produit)`);
  const actions = [...new Set(s.actions)];
  const inconnues = actions.filter((a) => !estAction(a));
  if (inconnues.length) return { ok: false, error: `Action inconnue : ${inconnues.join(", ")}.` };
  if (actions.length === 0) manques.push("au moins une action attendue du fournisseur (conception, impression…)");
  if (s.quantiteIllisible) manques.push("une quantité lisible (un nombre)");
  if (c.famille === "NUMERIQUE" && s.quantite != null) {
    return { ok: false, error: `${c.nom} est un support NUMÉRIQUE : il n'a pas de quantité — laissez-la vide.` };
  }
  if (s.quantite != null && !(s.quantite > 0)) manques.push("une quantité supérieure à zéro (ou laissez-la vide)");
  if (manques.length) return { ok: false, error: `Il manque ${manques.join(", ")}.` };
  return {
    ok: true,
    article: {
      produitIds,
      quantite: s.quantite != null ? r3(s.quantite) : null,
      actions: actions as PromoAction[],
      commentaire: s.commentaire?.trim() || null,
    },
  };
}

// ─────────────────────────────── 2. LE RAPPROCHEMENT ───────────────────────────────

export interface LigneRapprochee {
  quoteId: string;
  fournisseur: string;
  ligneId: string;
  reference: string;
  action: PromoAction | null;
  quantite: number;
  prixUnitaire: number;
  totalHT: number;
  retenue: boolean;
}

export interface Rapprochement {
  /** Chaque article demandé, avec les lignes de devis qui le chiffrent — tous fournisseurs. */
  articles: { article: ArticleDemandeLu; lignes: LigneRapprochee[]; actionsSansDevis: PromoAction[] }[];
  /** Les lignes que personne n'a demandées — elles peuvent être retenues (« et voire plus »). */
  enPlus: LigneRapprochee[];
  /** Les articles demandés qu'aucune ligne de devis ne chiffre encore. */
  sansDevis: ArticleDemandeLu[];
}

/**
 * RAPPROCHER LES DEVIS DE LA DEMANDE — ce que l'assistante fait de tête, posé sous les yeux.
 *
 * Pour chaque article demandé : les lignes de tous les devis qui le chiffrent, et les ACTIONS
 * demandées qu'aucune ligne ne chiffre encore (« il manque un devis d'impression »). Une ligne
 * rattachée à un article qui n'existe plus est rangée « en plus » : on ne perd pas une ligne
 * chiffrée parce qu'une demande a été retouchée.
 */
export function rapprocher(articles: readonly ArticleDemandeLu[], devis: readonly DevisLu[]): Rapprochement {
  const parArticle = new Map<string, LigneRapprochee[]>(articles.map((a) => [a.id, []]));
  const enPlus: LigneRapprochee[] = [];
  for (const d of devis) {
    for (const l of [...d.lines].sort((a, b) => a.position - b.position)) {
      const lr: LigneRapprochee = {
        quoteId: d.id, fournisseur: d.supplierName, ligneId: l.id, reference: l.reference,
        action: l.action ?? null, quantite: Number(l.quantity), prixUnitaire: Number(l.unitPrice),
        totalHT: totalLigneHT(l), retenue: l.selected,
      };
      const cible = l.requestItemId ? parArticle.get(l.requestItemId) : undefined;
      if (cible) cible.push(lr); else enPlus.push(lr);
    }
  }
  const lignes = [...articles].sort((a, b) => a.position - b.position).map((article) => {
    const ls = parArticle.get(article.id) ?? [];
    const chiffrees = new Set(ls.map((l) => l.action).filter((a): a is PromoAction => a != null));
    return { article, lignes: ls, actionsSansDevis: article.actions.filter((a) => !chiffrees.has(a)) };
  });
  return { articles: lignes, enPlus, sansDevis: lignes.filter((x) => x.lignes.length === 0).map((x) => x.article) };
}

// ─────────────────────────────── 3. LA FACTURE ───────────────────────────────

/** Une ligne du BC — une ligne de devis RETENUE —, avec ce qui en est déjà facturé. */
export interface LigneBC {
  quoteLineId: string;
  designation: string;
  action: PromoAction | null;
  unite: string | null;
  /** Quantité commandée. */
  quantite: number;
  prixUnitaire: number;
  requestItemId: string | null;
  /** Quantité déjà facturée sur des factures non annulées. */
  dejaFacture: number;
}

/**
 * LES LIGNES DU BC D'UN DEVIS — les retenues, avec ce que les factures non annulées en ont déjà
 * facturé. `facturees` = les lignes de facture des factures ACTIVES de ce BC.
 */
export function lignesDuBC(d: DevisLu, facturees: readonly { quoteLineId: string | null; quantite: number }[]): LigneBC[] {
  const deja = new Map<string, number>();
  for (const f of facturees) {
    if (!f.quoteLineId) continue;
    deja.set(f.quoteLineId, r3((deja.get(f.quoteLineId) ?? 0) + Number(f.quantite)));
  }
  return d.lines
    .filter((l) => l.selected)
    .sort((a, b) => a.position - b.position)
    .map((l) => ({
      quoteLineId: l.id, designation: l.reference.trim(), action: l.action ?? null, unite: l.unit?.trim() || null,
      quantite: Number(l.quantity), prixUnitaire: Number(l.unitPrice), requestItemId: l.requestItemId ?? null,
      dejaFacture: deja.get(l.id) ?? 0,
    }));
}

/** Ce qui reste à facturer sur une ligne du BC — jamais négatif. */
export function resteAFacturer(l: Pick<LigneBC, "quantite" | "dejaFacture">): number {
  return Math.max(0, r3(l.quantite - l.dejaFacture));
}

/** Les lignes PROPOSÉES pour une nouvelle facture : ce qui reste à facturer, au prix du BC. */
export function lignesProposees(lignes: readonly LigneBC[]): { quoteLineId: string; quantite: number; prixUnitaire: number }[] {
  return lignes.filter((l) => resteAFacturer(l) > 0).map((l) => ({ quoteLineId: l.quoteLineId, quantite: resteAFacturer(l), prixUnitaire: l.prixUnitaire }));
}

export interface SaisieLigneFacture {
  quoteLineId: string;
  /** `null` = illisible. */
  quantite: number | null;
  prixUnitaire: number | null;
}

export interface LigneFactureValidee {
  quoteLineId: string;
  designation: string;
  action: PromoAction | null;
  unite: string | null;
  requestItemId: string | null;
  quantite: number;
  prixUnitaire: number;
}

/**
 * VALIDER LES LIGNES D'UNE FACTURE — contre les lignes de SON BC, tout ce qui ne va pas en une fois.
 *
 * Une ligne à quantité nulle n'est pas facturée (elle est ignorée, pas refusée : c'est la façon de
 * dire « cette ligne du BC n'est pas sur cette facture »). Une ligne étrangère au BC, en double, à
 * quantité ou prix illisible, ou qui facture plus que ce qui reste, est refusée et NOMMÉE.
 */
export function validerLignesFacture(saisies: readonly SaisieLigneFacture[], lignesBC: readonly LigneBC[]):
  { ok: true; lignes: LigneFactureValidee[] } | { ok: false; error: string } {
  const parId = new Map(lignesBC.map((l) => [l.quoteLineId, l]));
  const vues = new Set<string>();
  const fautes: string[] = [];
  const lignes: LigneFactureValidee[] = [];
  for (const s of saisies) {
    const bc = parId.get(s.quoteLineId);
    if (!bc) { fautes.push("une ligne n'appartient pas à ce bon de commande"); continue; }
    if (vues.has(s.quoteLineId)) { fautes.push(`« ${bc.designation} » figure deux fois`); continue; }
    vues.add(s.quoteLineId);
    if (s.quantite == null || s.quantite < 0) { fautes.push(`« ${bc.designation} » : quantité illisible ou négative`); continue; }
    if (s.quantite === 0) continue;
    if (s.prixUnitaire == null || s.prixUnitaire < 0) { fautes.push(`« ${bc.designation} » : prix unitaire illisible ou négatif`); continue; }
    const reste = resteAFacturer(bc);
    if (s.quantite > reste + EPS) {
      fautes.push(`« ${bc.designation} » : ${nombre(s.quantite)} facturées pour ${nombre(reste)} restant à facturer sur le BC — on ne facture pas plus que commandé`);
      continue;
    }
    lignes.push({
      quoteLineId: bc.quoteLineId, designation: bc.designation, action: bc.action, unite: bc.unite,
      requestItemId: bc.requestItemId, quantite: r3(s.quantite), prixUnitaire: s.prixUnitaire,
    });
  }
  if (fautes.length) return { ok: false, error: `Lignes de facture à revoir : ${fautes.join(" ; ")}.` };
  if (lignes.length === 0) return { ok: false, error: "Aucune ligne n'est facturée : indiquez au moins une quantité." };
  return { ok: true, lignes };
}

export interface EcartFacture {
  designation: string;
  nature: "QUANTITE" | "PRIX";
  facture: number;
  bc: number;
}

/**
 * LES ÉCARTS FACTURE / BC — mis en évidence, jamais refusés en eux-mêmes : une facture partielle
 * ou un prix revu se paient au montant facturé, dans la limite du BC (le plafond tient ailleurs).
 * QUANTITÉ = moins que ce qui reste à facturer ; PRIX = un prix unitaire différent de celui du BC.
 */
export function ecartsAuBC(lignes: readonly LigneFactureValidee[], lignesBC: readonly LigneBC[]): EcartFacture[] {
  const parId = new Map(lignesBC.map((l) => [l.quoteLineId, l]));
  const ecarts: EcartFacture[] = [];
  for (const l of lignes) {
    const bc = parId.get(l.quoteLineId);
    if (!bc) continue;
    const reste = resteAFacturer(bc);
    if (Math.abs(l.quantite - reste) > EPS) ecarts.push({ designation: l.designation, nature: "QUANTITE", facture: l.quantite, bc: reste });
    if (Math.abs(l.prixUnitaire - bc.prixUnitaire) > 0.005) ecarts.push({ designation: l.designation, nature: "PRIX", facture: l.prixUnitaire, bc: bc.prixUnitaire });
  }
  return ecarts;
}

export function phraseEcart(e: EcartFacture): string {
  return e.nature === "QUANTITE"
    ? `« ${e.designation} » : ${nombre(e.facture)} facturées sur ${nombre(e.bc)} restant au BC`
    : `« ${e.designation} » : prix unitaire ${formatDzd(e.facture)} au lieu de ${formatDzd(e.bc)} au BC`;
}

export interface TaxesFacture {
  /** TVA en POUR CENT. */
  tvaRate: number | null;
  extraTaxRate: number | null;
}

/** Les totaux d'une facture — la MÊME arithmétique que le devis (§118.5). */
export function totauxFacture(taxes: TaxesFacture, lignes: readonly { quantite: number; prixUnitaire: number }[]): Totaux {
  return totauxTaxes(taxes, lignes.map((l) => ({ quantity: l.quantite, unitPrice: l.prixUnitaire })));
}

/**
 * LE TOTAL IMPRIMÉ TOMBE-T-IL SUR LE TOTAL CALCULÉ ? Tolérance d'un dinar (les factures arrondissent
 * leurs lignes, pas toujours pareil). `null` = rien à dire.
 */
export function ecartTotalImprime(calcule: number, imprime: number): { calcule: number; imprime: number; ecart: number } | null {
  const ecart = Math.round((imprime - calcule) * 100) / 100;
  return Math.abs(ecart) <= 1 ? null : { calcule, imprime, ecart };
}

// ─────────────────────────────── 4. LA RÉCEPTION ───────────────────────────────

export interface LigneFactureLue {
  id: string;
  position: number;
  designation: string;
  action: PromoAction | null;
  unite: string | null;
  quantite: number;
  prixUnitaire: number;
  quoteLineId: string | null;
  requestItemId: string | null;
  quantiteRecue: number | null;
  /** Le jour où la réception a été cochée (absent d'une lecture qui ne le charge pas). */
  recueLe?: Date | null;
  renonce: boolean;
  stockItemId: string | null;
  stockLotId: string | null;
}

export type EtatReception = "EN_ATTENTE" | "RECUE" | "PARTIELLE" | "NON_LIVREE" | "RELIQUAT_RENONCE";

export const ETAT_RECEPTION_LABEL: Record<EtatReception, string> = {
  EN_ATTENTE: "À réceptionner",
  RECUE: "Reçue",
  PARTIELLE: "Reçue en partie",
  NON_LIVREE: "Non livrée — renoncé",
  RELIQUAT_RENONCE: "Reçue en partie — reliquat renoncé",
};

export function etatReception(l: Pick<LigneFactureLue, "quantite" | "quantiteRecue" | "renonce">): EtatReception {
  if (l.quantiteRecue == null) return l.renonce ? "NON_LIVREE" : "EN_ATTENTE";
  if (l.quantiteRecue >= l.quantite - EPS) return "RECUE";
  return l.renonce ? "RELIQUAT_RENONCE" : "PARTIELLE";
}

/** Ce qu'on paie sur une ligne : ce qui a été REÇU (au plus ce qui est facturé). */
export function quantitePayable(l: Pick<LigneFactureLue, "quantite" | "quantiteRecue">): number {
  if (l.quantiteRecue == null) return 0;
  return r3(Math.min(l.quantite, l.quantiteRecue));
}

/** Les lignes qui attendent encore quelque chose : rien reçu, ou une partie seulement, sans renoncement. */
export function lignesAReceptionner<T extends Pick<LigneFactureLue, "quantite" | "quantiteRecue" | "renonce">>(lignes: readonly T[]): T[] {
  return lignes.filter((l) => {
    const e = etatReception(l);
    return e === "EN_ATTENTE" || e === "PARTIELLE";
  });
}

/** QUI COCHE LA RÉCEPTION — le demandeur ; le Super Admin en suppléance (« il peut tout gérer »). */
export function peutReceptionner(acteur: { id: string; role: string | null }, pm: { requesterId: string | null }): boolean {
  return acteur.role === "SUPER_ADMIN" || (pm.requesterId != null && acteur.id === pm.requesterId);
}

export type NatureReception =
  /** Une prestation (conception, livraison…) : cochée « faite », rien n'entre au stock. */
  | { type: "PRESTATION" }
  /** Des unités d'un article CONNU (celui de l'article demandé) : elles entrent au magasin. */
  | { type: "STOCK"; catalogueId: string; produitIds: string[]; famille: FamillePromo }
  /**
   * L'article du catalogue se CHOISIT à la réception : une ligne « en plus » qui produit des unités
   * (obligatoire), ou une ligne d'avant le vocabulaire des actions (facultatif — vide = prestation).
   */
  | { type: "A_CHOISIR"; obligatoire: boolean };

/**
 * CE QUI LIVRE UN SUPPORT NUMÉRIQUE. Un e-ADV, un e-flyer, une vidéo n'ont rien à compter : ce
 * qu'on reçoit, c'est le support lui-même — et il sort d'une CONCEPTION. La traiter en prestation
 * « faite » (la règle générale) aurait coché la ligne sans jamais poser le lien au stock : le
 * support existerait chez l'agence et nulle part chez nous. Une livraison, une installation ou une
 * location du même article restent des prestations.
 */
const LIVRENT_UN_NUMERIQUE = new Set<PromoAction>(["CONCEPTION", "IMPRESSION", "FABRICATION", "ACHAT"]);

export function natureDeReception(
  ligne: Pick<LigneFactureLue, "action" | "requestItemId">,
  article: Pick<ArticleDemandeLu, "catalogueId" | "produits" | "famille"> | null,
): NatureReception {
  if (article?.famille === "NUMERIQUE" && ligne.action && LIVRENT_UN_NUMERIQUE.has(ligne.action)) {
    return { type: "STOCK", catalogueId: article.catalogueId, produitIds: article.produits.map((p) => p.id), famille: article.famille };
  }
  const produit = actionProduit(ligne.action);
  if (produit === false) return { type: "PRESTATION" };
  if (produit === true && article) {
    return { type: "STOCK", catalogueId: article.catalogueId, produitIds: article.produits.map((p) => p.id), famille: article.famille };
  }
  return { type: "A_CHOISIR", obligatoire: produit === true };
}

/**
 * VALIDER UNE RÉCEPTION — sur une ligne qui l'attend. On ne reçoit pas plus que ce qui est
 * facturé, et « rien » ne se coche pas : une ligne non livrée reste en attente, et c'est au
 * paiement qu'on y renonce, en connaissance de cause.
 */
export function validerReception(l: Pick<LigneFactureLue, "designation" | "quantite" | "quantiteRecue" | "renonce">, quantite: number | null):
  { ok: true; quantite: number } | { ok: false; error: string } {
  if (l.quantiteRecue != null) return { ok: false, error: `« ${l.designation} » est déjà réceptionnée : annulez la réception pour la refaire.` };
  if (l.renonce) return { ok: false, error: `« ${l.designation} » a été déclarée non livrée au paiement : on y a renoncé, définitivement.` };
  const q = quantite ?? l.quantite;
  if (!(q > 0)) {
    return { ok: false, error: `« ${l.designation} » : indiquez la quantité reçue. Rien n'est arrivé ? Ne cochez rien — au paiement, vous pourrez y renoncer.` };
  }
  if (q > l.quantite + EPS) {
    return { ok: false, error: `« ${l.designation} » : ${nombre(q)} reçues pour ${nombre(l.quantite)} facturées — on ne réceptionne pas plus que la facture.` };
  }
  return { ok: true, quantite: r3(q) };
}

// ─────────────────────────────── 5. LE PAIEMENT ───────────────────────────────

export interface FactureDetaillee extends TaxesFacture {
  totalImprime: number | null;
}

/**
 * CE QUE VAUT LE PAIEMENT D'UNE FACTURE DÉTAILLÉE — ce qui a été reçu, rien d'autre.
 *
 * Tout reçu, rien renoncé : on paie le total IMPRIMÉ — c'est la somme exacte que le fournisseur
 * attend, au centime près, quand les lignes arrondissent autrement. Sinon : le total CALCULÉ des
 * quantités reçues, aux prix et taxes de la facture.
 */
export function montantPayable(f: FactureDetaillee, lignes: readonly Pick<LigneFactureLue, "quantite" | "quantiteRecue" | "renonce" | "prixUnitaire">[]):
  { complet: boolean; totaux: Totaux; montant: number } {
  const complet = lignes.length > 0 && lignes.every((l) => etatReception(l) === "RECUE");
  const totaux = totauxFacture(f, lignes.map((l) => ({ quantite: quantitePayable(l), prixUnitaire: l.prixUnitaire })).filter((l) => l.quantite > 0));
  return { complet, totaux, montant: complet && f.totalImprime != null ? f.totalImprime : totaux.ttc };
}

/**
 * LE PAIEMENT PEUT-IL PARTIR ? Tout ce qui attend une réception est NOMMÉ ; avec le renoncement
 * confirmé, ces lignes sont payées pour ce qui en est reçu (rien, pour une ligne pas livrée du tout)
 * et l'appelant écrit le renoncement. Rien de reçu = rien à payer : la facture s'annule.
 */
export function verdictPaiementDetaille(f: FactureDetaillee, lignes: readonly LigneFactureLue[], confirmeRenoncement: boolean):
  | { ok: true; montant: number; totaux: Totaux; complet: boolean; renoncer: string[] }
  | { ok: false; error: string; aRenoncer: string[] } {
  const attente = lignesAReceptionner(lignes);
  const ids = attente.map((l) => l.id);
  if (attente.length > 0 && !confirmeRenoncement) {
    const detail = attente.map((l) => l.quantiteRecue == null
      ? `« ${l.designation} » (rien de reçu)`
      : `« ${l.designation} » (${nombre(l.quantiteRecue)} reçues sur ${nombre(l.quantite)})`).join(", ");
    return {
      ok: false,
      aRenoncer: ids,
      error: `${attente.length} ligne${attente.length > 1 ? "s ne sont" : " n'est"} pas reçue${attente.length > 1 ? "s" : ""} en entier : ${detail}. `
        + "Cochez ce qui est reçu. Pour payer malgré tout, confirmez que vous renoncez à payer ce qui manque — un paiement pour ces lignes ne pourra pas être fait ultérieurement.",
    };
  }
  const apres = lignes.map((l) => (ids.includes(l.id) ? { ...l, renonce: true } : l));
  const p = montantPayable(f, apres);
  if (!(p.montant > 0)) {
    return {
      ok: false,
      aRenoncer: ids,
      error: "Rien n'a été reçu sur cette facture : il n'y a rien à payer. Annulez-la (et demandez un avoir au fournisseur si elle a été réglée ailleurs).",
    };
  }
  return { ok: true, montant: p.montant, totaux: p.totaux, complet: p.complet, renoncer: ids };
}
