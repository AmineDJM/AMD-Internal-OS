import { joursCivilsDepuis } from "@/lib/calendar-tz";
import { CHEMIN_AGENCES, CHEMIN_BUREAU, LIBELLE_AGENCES, LIBELLE_BUREAU } from "@/lib/chemins/ad-pro";
import { estModuleVisite, MODULE_AUDIT_VISITE } from "@/lib/medical/module-visite";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « AUJOURD'HUI » — LES RÈGLES DE LA FILE DE « MON ESPACE » (Direction, 14/10/2026 ; écran simplifié
 * le 24/11/2026 — maquette validée : « À faire » en trois groupes, `espace/a-faire.ts`).
 *
 * Ce module porte les RÈGLES, sans base et sans import lourd (il ne lit que des modules purs : `calendar-tz`, `chemins/ad-pro`) :
 * la page serveur le nourrit avec ce que le centre d'actions a déjà filtré par les droits de la
 * personne (`getActionCenter`), et le composant client de la file en relit les types. Rien n'y
 * est estimé (§118.16).
 *
 *   · LE LOT — une nature (paiements à régler, déclarations à faire, validations, demandes
 *     assignées, pièces à déposer…), une ligne de titre concrète (« 12 paiements à régler —
 *     2 022 550 DZD, dont 5 en retard »), des sous-lignes dépliables, rangées par famille quand la
 *     donnée en porte une, et UN geste principal qui mène au bon écran.
 *   · L'URGENCE — retard d'abord (jours de retard cumulés), puis montant, puis ancienneté.
 *   · MON ÉQUIPE — pour un N+1 : qui est en retard, et la tâche qu'on peut lui relancer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────── Entrée ──────────────────────────────────────────

/** Ce que la file lit d'une ligne du centre d'actions (`ActionItem`, plus les pièces demandées). */
export interface ElementFile {
  key: string;
  objet: string;
  title: string;
  subtitle: string;
  module: string;
  href: string;
  kind: string;
  /** ISO — l'échéance ; dépassée d'au moins un jour civil, la ligne est EN RETARD. */
  deadline: string | null;
  /** ISO — depuis quand l'élément attend un geste ; `null` quand rien ne le date. */
  depuis: string | null;
  owner: string;
  statusLabel: string | null;
  /** Le montant que la base porte (ordre de dépense, validation chiffrée, poste Ad & Pro). */
  montant?: number | null;
  /** La famille d'un lot (catégorie d'un ordre de dépense, nature de la source d'une déclaration). */
  famille?: string | null;
  /** Le statut brut quand la nature en dépend (déclarations d'information médicale). */
  statut?: string | null;
  /** La priorité que la base porte (tâche, validation, demande) — `HIGH`/`CRITICAL` rendent la ligne urgente. */
  priority?: string | null;
}

// ─────────────────────────────────────────── Natures ─────────────────────────────────────────

export type NatureLot =
  | "paiement" | "justificatif" | "declaration" | "declaration-prete" | "declaration-pieces" | "declaration-finale"
  | "validation" | "conge" | "achat" | "demande" | "adpro" | "correction" | "plan" | "mission"
  | "invitation" | "formation" | "regulatory" | "piece" | "directive" | "tache" | "stock" | "promo"
  | "prise-en-charge" | "support" | "dossier" | "agence" | "bat" | "total-dg" | "question-finances" | "charge-fixe" | "autre";

interface DefNature {
  /** Le chapeau — le filtre de la file et l'étiquette du lot. */
  chapeau: string;
  /** Le titre d'un lot de N lignes (N > 1, ou 1 quand le lot ne prend pas le titre de sa ligne). */
  titre: (n: number) => string;
  /** Ce que dit le lot sous son titre. */
  sousTitre: string;
  /** Le geste — sur chaque ligne et sur le lot. */
  verbe: string;
  /** L'écran du lot quand il porte plusieurs lignes ; à défaut, la ligne la plus pressante. */
  liste: string | null;
  /** Une décision (compte dans « À décider »). */
  decision: boolean;
}

const pl = (n: number, s: string, p?: string) => (n > 1 ? p ?? `${s}s` : s);

export const NATURES: Record<NatureLot, DefNature> = {
  paiement: {
    chapeau: "Espace comptable", titre: (n) => `${n} ${pl(n, "paiement")} à régler`,
    sousTitre: "Ordres de dépense autorisés", verbe: "Régler", liste: "/finances/paiements-a-faire", decision: true,
  },
  // LE JUSTIFICATIF OBLIGATOIRE (24/11/2026) : un ordre sans pièce n'entre pas au centre — il attend chez son émetteur.
  justificatif: {
    chapeau: "Paiements", titre: (n) => `${n} ${pl(n, "justificatif")} à joindre`,
    sousTitre: "Sans justificatif, le paiement n'entre pas au centre", verbe: "Joindre", liste: null, decision: false,
  },
  declaration: {
    chapeau: "Information médicale", titre: (n) => `${n} ${pl(n, "déclaration")} à faire`,
    sousTitre: "Regroupées par famille", verbe: "Déclarer", liste: "/information-medicale", decision: false,
  },
  "declaration-prete": {
    chapeau: "Information médicale", titre: (n) => `${n} ${pl(n, "déclaration prête", "déclarations prêtes")} à valider`,
    sousTitre: "Pièces complètes", verbe: "Valider", liste: "/information-medicale", decision: true,
  },
  "declaration-pieces": {
    chapeau: "Information médicale", titre: (n) => `${n} ${pl(n, "déclaration")} en attente de pièces`,
    sousTitre: "Ce que vous attendez des autres", verbe: "Relancer", liste: "/information-medicale", decision: false,
  },
  "declaration-finale": {
    chapeau: "Information médicale", titre: (n) => `${n} ${pl(n, "déclaration")} à valider (validation finale)`,
    sousTitre: "Validées par le pharmacien · votre validation crée l'ordre de dépense", verbe: "Valider",
    liste: "/information-medicale", decision: true,
  },
  validation: {
    chapeau: "Validations", titre: (n) => `${n} ${pl(n, "validation")} à faire`,
    sousTitre: "C'est votre tour", verbe: "Valider", liste: "/validations", decision: true,
  },
  conge: {
    chapeau: "Ressources humaines", titre: (n) => `${n} ${pl(n, "congé")} à signer`,
    sousTitre: "Circuit N+1 → RH → direction générale", verbe: "Signer", liste: "/mon-espace#conges-a-signer", decision: true,
  },
  achat: {
    chapeau: "Bureau du secrétariat", titre: (n) => `${n} ${pl(n, "achat")} à approuver`,
    sousTitre: "Vous êtes le valideur", verbe: "Approuver", liste: "/demandes/approvals", decision: true,
  },
  demande: {
    chapeau: "Bureau du secrétariat", titre: (n) => `${n} ${pl(n, "demande")} à traiter`,
    sousTitre: "Assignées à vous", verbe: "Traiter", liste: "/demandes", decision: false,
  },
  adpro: {
    chapeau: "Ad & Pro", titre: (n) => `${n} ${pl(n, "demande")} Ad & Pro à arbitrer`,
    sousTitre: "À votre étape", verbe: "Arbitrer", liste: "/ad-pro", decision: true,
  },
  // LE PARCOURS AGENCE (recette du 21/11/2026) : déposer les devis, finaliser le BC, contrôler le BAT… ne sont pas des
  // arbitrages — Radia lisait « 7 demandes Ad & Pro à arbitrer » et un bouton « Arbitrer » pour déposer des devis.
  agence: {
    chapeau: "Ad & Pro", titre: (n) => `${n} ${pl(n, "geste")} du parcours agence`,
    sousTitre: "Devis, bon de commande, BAT — c'est à vous", verbe: "Ouvrir", liste: "/ad-pro", decision: false,
  },
  // LES BAT DE L'INFORMATION MÉDICALE (23/11/2026) : contrôler un BAT n'est pas « un geste du parcours agence » — c'est le
  // travail du pharmacien, qu'il fait sur SON écran (« Contrôles de conformité »), décision sur la ligne.
  bat: {
    chapeau: "Information médicale", titre: (n) => `${n} BAT à contrôler`,
    sousTitre: "Conformité avant impression — décidez sur la ligne", verbe: "Contrôler", liste: "/information-medicale/conformite", decision: true,
  },
  // LE TOTAL D'UNE DEMANDE AU-DESSUS DU SEUIL (recette du 21/11/2026) : le DG ne le voyait que sur la fiche.
  "total-dg": {
    chapeau: "Ad & Pro", titre: (n) => `${n} ${pl(n, "total", "totaux")} de demande à valider`,
    sousTitre: "Au-dessus du seuil du Directeur Général", verbe: "Valider", liste: "/centre-ad-pro", decision: true,
  },
  correction: {
    chapeau: "Ad & Pro", titre: (n) => `${n} ${pl(n, "demande")} à corriger`,
    sousTitre: "Renvoyées pour correction", verbe: "Corriger", liste: "/ad-pro", decision: false,
  },
  plan: {
    chapeau: MODULE_AUDIT_VISITE, titre: (n) => `${n} ${pl(n, "plan")} de tournée à valider`,
    sousTitre: "Soumis par vos délégués", verbe: "Valider", liste: "/medical/plan-de-tournee", decision: true,
  },
  mission: {
    chapeau: "Missions", titre: (n) => `${n} ${pl(n, "ordre")} de mission à valider`,
    sousTitre: "Vous êtes N+1", verbe: "Valider", liste: null, decision: true,
  },
  invitation: {
    chapeau: "Missions", titre: (n) => `${n} ${pl(n, "invitation")} à une mission`,
    sousTitre: "Votre réponse est attendue", verbe: "Répondre", liste: "/mon-espace/missions", decision: false,
  },
  formation: {
    chapeau: "Ressources humaines", titre: (n) => `${n} ${pl(n, "formation")} à trancher`,
    sousTitre: "Intérim", verbe: "Trancher", liste: "/formations", decision: true,
  },
  regulatory: {
    chapeau: "Regulatory", titre: (n) => `${n} ${pl(n, "dossier réglementaire", "dossiers réglementaires")} en cours`,
    sousTitre: "Vos dossiers non clôturés", verbe: "Mettre à jour", liste: "/regulatory", decision: false,
  },
  piece: {
    chapeau: "Pièces", titre: (n) => `${n} ${pl(n, "pièce")} à déposer`,
    sousTitre: "On vous les a demandées", verbe: "Déposer", liste: "/pieces", decision: false,
  },
  directive: {
    chapeau: "Directives", titre: (n) => `${n} ${pl(n, "directive")} à suivre`,
    sousTitre: "De la Direction", verbe: "Ouvrir", liste: "/directives", decision: false,
  },
  tache: {
    chapeau: "Tâches", titre: (n) => `${n} ${pl(n, "tâche")} à faire`,
    sousTitre: "Assignées à vous", verbe: "Ouvrir", liste: "/mon-espace/taches", decision: false,
  },
  stock: {
    chapeau: "Stocks", titre: (n) => `${n} ${pl(n, "demande")} de stocks à renseigner`,
    sousTitre: "Vous êtes destinataire", verbe: "Renseigner", liste: null, decision: false,
  },
  promo: {
    chapeau: "Matériel promotionnel", titre: (n) => `${n} ${pl(n, "dossier")} de matériel promotionnel`,
    sousTitre: "À votre étape", verbe: "Ouvrir", liste: "/promo-material", decision: false,
  },
  "prise-en-charge": {
    chapeau: "Prises en charge", titre: (n) => `${n} ${pl(n, "prise")} en charge à instruire`,
    sousTitre: "Congrès nationaux et internationaux", verbe: "Instruire", liste: null, decision: false,
  },
  support: {
    chapeau: "Support", titre: (n) => `${n} ${pl(n, "demande")} de support`,
    sousTitre: "Qui vous attendent", verbe: "Répondre", liste: "/support", decision: false,
  },
  dossier: {
    chapeau: "Dossiers", titre: (n) => `${n} ${pl(n, "dossier")} de suivi`,
    sousTitre: "Qui vous sont confiés", verbe: "Ouvrir", liste: "/dossiers", decision: false,
  },
  // La question des Finances au demandeur d'un paiement (Banque & paiements, 24/11/2026) : il répond depuis sa demande.
  "question-finances": {
    chapeau: "Finances", titre: (n) => `${n} ${pl(n, "question")} des Finances`,
    sousTitre: "Elles attendent votre réponse pour payer", verbe: "Répondre", liste: null, decision: false,
  },
  // LES CHARGES FIXES DES LOCAUX (Super Admin, 24/11/2026) : chaque échéance, quinze jours avant — les Finances joignent la
  // facture et demandent le paiement depuis Informations de la société.
  "charge-fixe": {
    chapeau: "Finances", titre: (n) => `${n} ${pl(n, "charge fixe", "charges fixes")} à payer`,
    sousTitre: "Loyer et charges des locaux — joignez la facture", verbe: "Payer", liste: null, decision: false,
  },
  autre: {
    chapeau: "Autres", titre: (n) => `${n} ${pl(n, "élément")} à traiter`,
    sousTitre: "", verbe: "Ouvrir", liste: null, decision: false,
  },
};

/** Les lignes « et d'autres… » du centre (une coupe qui se dit, §118.60) — jamais comptées comme des lignes. */
const PREFIXE_RESTE = "reste:";
const estReste = (e: ElementFile) => e.objet.startsWith(PREFIXE_RESTE) || e.objet.endsWith(`:${PREFIXE_RESTE}`);

/** LA NATURE D'UNE LIGNE — lue sur l'identité de l'objet d'abord, sur le module ensuite. */
export function natureDe(e: ElementFile): NatureLot {
  const o = e.objet;
  if (o.startsWith("QUESTION_FINANCES:")) return "question-finances";
  if (e.key.startsWith("justif-")) return "justificatif";
  if (e.key.startsWith("chargefixe-")) return "charge-fixe";
  if (e.kind === "payment" || o.startsWith("EXPENSE_ORDER:")) return "paiement";
  if (o.startsWith("MEDICAL_INFO_DECLARATION:")) {
    if (e.statut === "AWAITING_DIRECTION") return "declaration-finale";
    if (e.statut === "READY") return "declaration-prete";
    if (e.statut === "DOCS_REQUESTED") return "declaration-pieces";
    return "declaration";
  }
  if (o.startsWith("MEDICAL_INFO_DOC_REQUEST:") || o.startsWith("DOCUMENT_REQUEST:")) return "piece";
  if (o.startsWith("LEAVE_REQUEST:")) return "conge";
  if (o.startsWith("VALIDATION_REQUEST:")) return "validation";
  if (e.statusLabel === "À corriger") return "correction";
  if (o.startsWith("ADMIN_REQUEST:")) return e.kind === "validation" ? "achat" : "demande";
  if (o.startsWith("TOUR_PLAN:")) return "plan";
  if (o.startsWith("HR_REQUEST:")) return "mission";
  if (o.startsWith("MISSION_ASSIGNMENT:")) return "invitation";
  if (o.startsWith("TRAINING:")) return "formation";
  if (e.kind === "regulatory" || o.startsWith("REGULATORY_PRODUCT:")) return "regulatory";
  if (o.startsWith("DIRECTIVE:")) return "directive";
  if (o.startsWith("TASK:")) return "tache";
  if (o.startsWith("STOCK_COUNT_REQUEST:")) return "stock";
  if (o.startsWith("PROMO_MATERIAL:")) return "promo";
  if (o.startsWith("SUPPORT_REQUEST:")) return "support";
  if (o.startsWith("DOSSIER:")) return "dossier";
  if (o.startsWith("PORTE_DG:")) return "total-dg";
  // Les gestes du parcours agence (`file-agences.ts`, clé `agence-…`) — pas les postes à décider, qui sont des arbitrages.
  if (o.startsWith("AD_PRO_ITEM:") && e.key.startsWith("agence-")) return "agence";
  if (o.startsWith("AD_PRO_ITEM:") && e.key.startsWith("bat-")) return "bat";
  if (e.module === "Ad & Pro") return "adpro";
  if (o.startsWith("CONGRESS_NATIONAL:") || o.startsWith("CONGRESS_INTERNATIONAL:")) return "prise-en-charge";
  // Les lignes « reste » des files de décision : la file dont elles ferment la liste.
  if (estReste(e)) {
    if (e.module === "Demandes administratives") return "achat";
    // L'ANCIEN NOM AUSSI : une file calculée, ou relue d'un lot, avant le renommage porte encore « Promotion médicale ».
    if (estModuleVisite(e.module)) return "plan";
  }
  return "autre";
}

// ─────────────────────────────────────────── Sortie ──────────────────────────────────────────

export interface Geste {
  libelle: string;
  href: string;
}

/**
 * L'URGENCE D'UNE LIGNE (recette du 23/11/2026) : trois niveaux, lus sur ce
 * que la base porte, jamais estimés.
 *   · « En retard » — l'échéance est dépassée d'au moins un jour civil ;
 *   · « Urgent »    — échéance aujourd'hui, demain ou après-demain, ou priorité haute / critique ;
 *   · « À suivre »  — le reste.
 */
export type NiveauUrgence = "retard" | "urgent" | "normal";

const PRIORITES_URGENTES = new Set(["HIGH", "CRITICAL", "URGENT"]);

export interface LigneLot {
  key: string;
  /** L'objet de la ligne (« EXPENSE_ORDER:… ») — le geste « Régler » d'un lot de paiements le relit. */
  objet: string;
  /** La référence lisible (« OD-2026-013 ») quand la ligne en porte une. */
  ref: string | null;
  libelle: string;
  detail: string | null;
  montant: number | null;
  /** Jours civils de retard — `null` si la ligne n'est pas en retard. */
  retard: number | null;
  /** Jours civils d'attente — `null` si rien ne la date. */
  attente: number | null;
  /** Jours avant l'échéance (0 = aujourd'hui) — `null` sans échéance ou si elle est dépassée. */
  echeanceDans: number | null;
  urgence: NiveauUrgence;
  famille: string | null;
  geste: Geste;
}

export interface FamilleLot {
  famille: string;
  n: number;
  montant: number;
  enRetard: number;
}

export interface Lot {
  id: string;
  nature: NatureLot;
  /** Le module des lignes — le chapeau d'un lot « autre ». */
  module: string;
  chapeau: string;
  titre: string;
  sousTitre: string;
  n: number;
  montant: number;
  enRetard: number;
  retardMax: number;
  /** Jours de retard cumulés — la première clé de l'urgence. */
  retardCumule: number;
  attenteMax: number | null;
  ton: "late" | "warn" | "";
  lignes: LigneLot[];
  familles: FamilleLot[];
  geste: Geste;
  /** La file est coupée au-delà : une ligne le dit et mène à la liste complète (§118.60). */
  suite: Geste | null;
}

const REF = /\b[A-Z]{2,6}-\d{4}-\d{2,}\b/;

/** « 2 022 550 DZD » — espaces insécables ; LE MONTANT EXACT, centimes compris quand il y en a (comme `formatCurrency`). */
export function montantDzd(n: number): string {
  const c = Math.round(Math.abs(n) * 100);
  const entier = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  const centimes = c % 100 ? `,${String(c % 100).padStart(2, "0")}` : "";
  return `${n < 0 ? "-" : ""}${entier}${centimes}\u00a0DZD`;
}

function retardDe(e: ElementFile, now: Date): number | null {
  if (!e.deadline) return null;
  const d = new Date(e.deadline);
  if (Number.isNaN(d.getTime()) || d.getTime() >= now.getTime()) return null;
  const j = joursCivilsDepuis(d, now);
  // Dû aujourd'hui n'est pas en retard : le retard commence le lendemain de l'échéance.
  return j >= 1 ? j : null;
}

function attenteDe(e: ElementFile, now: Date): number | null {
  if (!e.depuis) return null;
  const d = new Date(e.depuis);
  if (Number.isNaN(d.getTime())) return null;
  return joursCivilsDepuis(d, now);
}

/** La ligne la plus pressante d'abord : retard, puis montant, puis ancienneté. */
function parUrgenceLigne(a: LigneLot, b: LigneLot): number {
  return (b.retard ?? 0) - (a.retard ?? 0)
    || (b.montant ?? 0) - (a.montant ?? 0)
    || (b.attente ?? -1) - (a.attente ?? -1)
    || a.libelle.localeCompare(b.libelle, "fr");
}

/** Le lot le plus pressant d'abord : retard cumulé, puis montant, puis ancienneté, puis taille. */
export function parUrgence(a: Lot, b: Lot): number {
  return b.retardCumule - a.retardCumule
    || b.montant - a.montant
    || (b.attenteMax ?? -1) - (a.attenteMax ?? -1)
    || b.n - a.n
    || a.titre.localeCompare(b.titre, "fr");
}

function ligneDe(e: ElementFile, verbe: string, now: Date): LigneLot {
  const ref = e.subtitle.match(REF)?.[0] ?? e.title.match(REF)?.[0] ?? null;
  // Le détail : le sous-titre sans la référence ni le montant déjà dits ailleurs sur la ligne.
  const detail = e.subtitle
    .split(" · ")
    .map((s) => s.trim())
    .filter((s) => s && s !== ref && !(e.montant != null && /\d.*DZD$/.test(s)))
    .join(" · ");
  const parties = [detail || null, e.owner ? e.owner : null].filter(Boolean) as string[];
  const retard = retardDe(e, now);
  const echeanceDans = echeanceDansDe(e, now, retard);
  const urgence: NiveauUrgence = retard !== null
    ? "retard"
    : (echeanceDans !== null && echeanceDans <= 2) || PRIORITES_URGENTES.has((e.priority ?? "").toUpperCase()) ? "urgent" : "normal";
  return {
    key: e.key,
    objet: e.objet,
    ref,
    libelle: e.title,
    detail: parties.length ? [...new Set(parties)].join(" · ") : null,
    montant: e.montant != null && Number.isFinite(e.montant) ? e.montant : null,
    retard,
    attente: attenteDe(e, now),
    echeanceDans,
    urgence,
    famille: e.famille ?? null,
    geste: { libelle: verbe, href: e.href },
  };
}

/** Jours civils avant l'échéance (0 = aujourd'hui) ; `null` sans échéance ou quand elle est dépassée. */
function echeanceDansDe(e: ElementFile, now: Date, retard: number | null): number | null {
  if (!e.deadline || retard !== null) return null;
  const d = new Date(e.deadline);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() <= now.getTime()) return 0;
  return Math.max(0, joursCivilsDepuis(now, d));
}

/** Le lien qui ouvre le lot : l'écran de la nature, filtré quand l'écran sait l'être — le bureau ou le « Suivi des agences » pour le parcours agence. */
function gesteDuLot(nature: NatureLot, lignes: LigneLot[], module: string): Geste {
  const def = NATURES[nature];
  if (nature === "paiement") {
    // « Régler les N » OUVRE l'écran des paiements, ces ordres mis en évidence : le règlement reste
    // le geste de cet écran (compte, budget, quittance) — aucun circuit financier neuf ici.
    const enRetard = lignes.filter((l) => l.retard !== null);
    const cibles = enRetard.length > 0 ? enRetard : lignes;
    const ids = cibles.map((l) => l.objet.replace(/^EXPENSE_ORDER:/, "")).filter(Boolean);
    const libelle = enRetard.length > 0
      ? `Régler ${enRetard.length > 1 ? `les ${enRetard.length} en retard` : "celui en retard"}`
      : lignes.length > 1 ? `Régler les ${lignes.length}` : "Régler";
    return { libelle, href: ids.length ? `/finances/paiements-a-faire?focus=${ids.join(",")}#ord-${ids[0]}` : "/finances/paiements-a-faire" };
  }
  if (lignes.length === 1) return { libelle: def.verbe, href: lignes[0].geste.href };
  const pageAgence = nature === "agence" ? (module === LIBELLE_AGENCES ? CHEMIN_AGENCES : module === LIBELLE_BUREAU ? CHEMIN_BUREAU : null) : null;
  return { libelle: `${def.verbe} — tout voir`, href: (pageAgence ?? def.liste) ?? lignes[0].geste.href };
}

/**
 * LA FILE « À FAIRE MAINTENANT » — groupée par lot, triée par urgence.
 *
 * Une ligne par objet (le centre d'actions l'a déjà dédoublonnée) ; les lignes « et d'autres… »
 * ne sont pas comptées : elles deviennent la `suite` du lot dont elles ferment la liste.
 */
export function regrouperFile(elements: readonly ElementFile[], now: Date): Lot[] {
  const parNature = new Map<string, GroupeFile>();
  for (const e of elements) {
    const nature = natureDe(e);
    // « Autres » se range par module : deux modules sans nature propre ne font pas un même lot.
    const id = nature === "autre" ? `autre:${e.module}` : nature;
    const g = parNature.get(id) ?? { id, nature, module: e.module, lignes: [], suite: null };
    parNature.set(id, g);
    if (estReste(e)) {
      g.suite = { libelle: e.title, href: e.href };
      continue;
    }
    g.lignes.push(ligneDe(e, NATURES[nature].verbe, now));
  }

  const lots: Lot[] = [];
  for (const g of parNature.values()) {
    const lot = construireLot(g);
    if (lot) lots.push(lot);
  }
  return lots.sort(parUrgence);
}

export interface GroupeFile { id: string; nature: NatureLot; module: string; lignes: LigneLot[]; suite: Geste | null }

/**
 * Un lot à partir de ses lignes — partagé par la file et par ses groupes (« En retard », « Aujourd'hui »,
 * « Plus tard » : `espace/a-faire.ts`). `taireRetard` : sous l'intitulé « En retard », le titre ne le redit pas.
 */
export function construireLot(g: GroupeFile, opts: { taireRetard?: boolean } = {}): Lot | null {
  const id = g.id;
  {
    if (g.lignes.length === 0 && !g.suite) return null;
    const def = NATURES[g.nature];
    const lignes = [...g.lignes].sort(parUrgenceLigne);
    const n = lignes.length;
    const montant = lignes.reduce((s, l) => s + (l.montant ?? 0), 0);
    const enRetard = lignes.filter((l) => l.retard !== null).length;
    const retardMax = lignes.reduce((m, l) => Math.max(m, l.retard ?? 0), 0);
    const retardCumule = lignes.reduce((s, l) => s + (l.retard ?? 0), 0);
    const attentes = lignes.map((l) => l.attente).filter((a): a is number => a !== null);
    const attenteMax = attentes.length ? Math.max(...attentes) : null;

    // Les familles, dans l'ordre de leur ligne la plus pressante.
    const familles: FamilleLot[] = [];
    if (lignes.some((l) => l.famille)) {
      const parFamille = new Map<string, FamilleLot>();
      for (const l of lignes) {
        const f = l.famille ?? "Autres";
        const x = parFamille.get(f) ?? { famille: f, n: 0, montant: 0, enRetard: 0 };
        x.n += 1;
        x.montant += l.montant ?? 0;
        if (l.retard !== null) x.enRetard += 1;
        parFamille.set(f, x);
      }
      familles.push(...parFamille.values());
    }

    // LE TITRE — concret : combien, combien d'argent, combien en retard. Une ligne seule prend
    // son propre intitulé (« Puce téléphonique… ») : « 1 demande à traiter » ne dit rien.
    let titre: string;
    if (n === 1 && g.nature !== "paiement") titre = lignes[0].libelle;
    else if (n === 0) titre = g.suite?.libelle ?? def.titre(0);
    else {
      titre = g.nature === "autre" ? `${n} ${pl(n, "élément")} — ${g.module}` : def.titre(n);
      if (montant > 0) titre += ` — ${montantDzd(montant)}`;
      if (g.nature === "declaration" && familles.length > 1) titre += `, en ${familles.length} familles`;
      if (enRetard > 0 && !opts.taireRetard) {
        titre += g.nature === "regulatory"
          ? `, dont ${enRetard} au-delà de la date cible`
          : n === enRetard ? (n > 1 ? `, tous en retard` : `, en retard`) : `, dont ${enRetard} en retard`;
      }
    }
    const sousTitre = n === 1
      ? [lignes[0].ref, g.nature === "paiement" ? lignes[0].libelle : def.sousTitre].filter(Boolean).join(" · ")
      : def.sousTitre || g.module;
    const ton: Lot["ton"] = enRetard > 0 ? "late" : (attenteMax ?? 0) >= 30 ? "warn" : "";

    return {
      id, nature: g.nature, module: g.module, chapeau: g.nature === "autre" ? g.module : def.chapeau, titre, sousTitre,
      n, montant, enRetard, retardMax, retardCumule, attenteMax, ton, lignes, familles,
      geste: n === 0 && g.suite ? g.suite : gesteDuLot(g.nature, lignes, g.module),
      suite: n > 0 ? g.suite : null,
    };
  }
}

// ───────────────────────────────────────── Totaux ──────────────────────────────────────────

export function totaux(lots: readonly Lot[]) {
  return {
    ouverts: lots.reduce((s, l) => s + l.n, 0),
    enRetard: lots.reduce((s, l) => s + l.enRetard, 0),
  };
}

// ───────────────────────────────────────── Mon équipe ────────────────────────────────────────

/** Ce que l'encart lit d'une ligne de l'aperçu d'équipe (`getMyTeamOverview`). */
export interface MembreLu {
  employeeId: string;
  nom: string;
  poste: string | null;
  direct: boolean;
  aujourdhui: "PRESENT" | "CONGE" | "ABSENCE" | "MISSION" | "FORMATION";
  ouvertes: number;
  enRetard: number;
  aDecider: number;
  /** La première alerte (« contrat 12 j »…) — déjà rédigée par l'aperçu. */
  alerte: string | null;
  /** Terrain : visites sans compte rendu ce mois. */
  sansRapport: number | null;
}

export interface MembreEncart {
  employeeId: string;
  nom: string;
  initiales: string;
  poste: string | null;
  statut: string | null;
  ouvertes: number;
  enRetard: number;
  bloque: string;
  /** La tâche que JE lui ai demandée, en retard, que la règle de relance laisse relancer. */
  relanceTacheId: string | null;
}

const STATUT_DU_JOUR: Record<MembreLu["aujourdhui"], string | null> = {
  PRESENT: null, CONGE: "Congé", ABSENCE: "Absent·e", MISSION: "Mission", FORMATION: "Formation",
};

/** Qui est bloqué, sur quoi — les directs, le plus en retard d'abord. */
export function composerEquipe(membres: readonly MembreLu[], relances: ReadonlyMap<string, string>, max = 4): { membres: MembreEncart[]; personnesEnRetard: number; retards: number; directs: number } {
  const directs = membres.filter((m) => m.direct);
  const tries = [...directs].sort((a, b) => b.enRetard - a.enRetard || b.ouvertes - a.ouvertes || a.nom.localeCompare(b.nom, "fr"));
  return {
    directs: directs.length,
    personnesEnRetard: directs.filter((m) => m.enRetard > 0).length,
    retards: directs.reduce((s, m) => s + m.enRetard, 0),
    membres: tries.slice(0, max).map((m) => {
      const bloque = [
        m.enRetard > 0 ? `${m.enRetard} ${pl(m.enRetard, "tâche")} en retard` : null,
        m.sansRapport ? `${m.sansRapport} ${pl(m.sansRapport, "visite")} sans compte rendu` : null,
        m.alerte,
      ].filter(Boolean).join(" · ") || (m.ouvertes > 0 ? `${m.ouvertes} ${pl(m.ouvertes, "tâche")} ouverte${m.ouvertes > 1 ? "s" : ""}, rien de bloquant` : "Rien de bloquant");
      return {
        employeeId: m.employeeId,
        nom: m.nom,
        initiales: m.nom.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]?.toUpperCase() ?? "").join(""),
        poste: m.poste,
        statut: STATUT_DU_JOUR[m.aujourdhui],
        ouvertes: m.ouvertes,
        enRetard: m.enRetard,
        bloque,
        relanceTacheId: relances.get(m.employeeId) ?? null,
      };
    }),
  };
}
