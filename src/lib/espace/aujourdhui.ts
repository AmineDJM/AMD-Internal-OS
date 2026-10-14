import { joursCivilsDepuis } from "@/lib/calendar-tz";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « AUJOURD'HUI » — L'ONGLET QUI REMPLACE « MON ESPACE » (Direction, 14/10/2026).
 *
 * La maquette « Mon espace par métier » est validée pour son onglet « Aujourd'hui » seulement :
 * une phrase « Votre journée », 3 à 4 chiffres PROPRES AU MÉTIER, la file « À faire maintenant »
 * GROUPÉE PAR LOT et triée par urgence, « Ma semaine », l'encart « Mon équipe » pour un N+1,
 * les rappels, les raccourcis du métier et un bloc « Moi » discret.
 *
 * Ce module porte les RÈGLES, sans base et sans import lourd (il ne lit que `calendar-tz`, pur) :
 * la page serveur le nourrit avec ce que le centre d'actions a déjà filtré par les droits de la
 * personne (`getActionCenter`), et le composant client de la file en relit les types. Rien n'y
 * est estimé : un chiffre qu'aucune donnée ne porte n'a pas de tuile (`null`), on ne le fabrique
 * pas (§118.16).
 *
 *   · LE LOT — une nature (paiements à régler, déclarations à faire, validations, demandes
 *     assignées, pièces à déposer…), une ligne de titre concrète (« 12 paiements à régler —
 *     2 022 550 DZD, dont 5 en retard »), des sous-lignes dépliables, rangées par famille quand la
 *     donnée en porte une, et UN geste principal qui mène au bon écran.
 *   · L'URGENCE — retard d'abord (jours de retard cumulés), puis montant, puis ancienneté.
 *   · LA SEMAINE — dimanche → jeudi (la semaine ouvrée algérienne, fournie par l'appelant),
 *     comptée sur des horodatages qui existent ; pas de « série sans retard » : aucun historique
 *     ne dit qu'un jour passé était sans retard, et l'on n'invente pas ce passé.
 *   · LE MÉTIER — chaque rôle a sa composition (tuiles, raccourcis) ; un compte à deux rôles voit
 *     l'union, sans doublon, la tuile la plus pressante d'abord.
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
}

// ─────────────────────────────────────────── Natures ─────────────────────────────────────────

export type NatureLot =
  | "paiement" | "declaration" | "declaration-prete" | "declaration-pieces" | "declaration-finale"
  | "validation" | "conge" | "achat" | "demande" | "adpro" | "correction" | "plan" | "mission"
  | "invitation" | "formation" | "regulatory" | "piece" | "directive" | "tache" | "stock" | "promo"
  | "prise-en-charge" | "support" | "dossier" | "autre";

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
  correction: {
    chapeau: "Ad & Pro", titre: (n) => `${n} ${pl(n, "demande")} à corriger`,
    sousTitre: "Renvoyées pour correction", verbe: "Corriger", liste: "/ad-pro", decision: false,
  },
  plan: {
    chapeau: "Promotion médicale", titre: (n) => `${n} ${pl(n, "plan")} de tournée à valider`,
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
  if (e.module === "Ad & Pro") return "adpro";
  if (o.startsWith("CONGRESS_NATIONAL:") || o.startsWith("CONGRESS_INTERNATIONAL:")) return "prise-en-charge";
  // Les lignes « reste » des files de décision : la file dont elles ferment la liste.
  if (estReste(e)) {
    if (e.module === "Demandes administratives") return "achat";
    if (e.module === "Promotion médicale") return "plan";
  }
  return "autre";
}

// ─────────────────────────────────────────── Sortie ──────────────────────────────────────────

export interface Geste {
  libelle: string;
  href: string;
}

export interface LigneLot {
  key: string;
  /** La référence lisible (« OD-2026-013 ») quand la ligne en porte une. */
  ref: string | null;
  libelle: string;
  detail: string | null;
  montant: number | null;
  /** Jours civils de retard — `null` si la ligne n'est pas en retard. */
  retard: number | null;
  /** Jours civils d'attente — `null` si rien ne la date. */
  attente: number | null;
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
  return {
    key: e.key,
    ref,
    libelle: e.title,
    detail: parties.length ? [...new Set(parties)].join(" · ") : null,
    montant: e.montant != null && Number.isFinite(e.montant) ? e.montant : null,
    retard: retardDe(e, now),
    attente: attenteDe(e, now),
    famille: e.famille ?? null,
    geste: { libelle: verbe, href: e.href },
  };
}

/** Le lien qui ouvre le lot : l'écran de la nature, filtré quand l'écran sait l'être. */
function gesteDuLot(nature: NatureLot, lignes: LigneLot[], objets: Map<string, string>): Geste {
  const def = NATURES[nature];
  if (nature === "paiement") {
    // « Régler les N » OUVRE l'écran des paiements, ces ordres mis en évidence : le règlement reste
    // le geste de cet écran (compte, budget, quittance) — aucun circuit financier neuf ici.
    const enRetard = lignes.filter((l) => l.retard !== null);
    const cibles = enRetard.length > 0 ? enRetard : lignes;
    const ids = cibles.map((l) => (objets.get(l.key) ?? "").replace(/^EXPENSE_ORDER:/, "")).filter(Boolean);
    const libelle = enRetard.length > 0
      ? `Régler ${enRetard.length > 1 ? `les ${enRetard.length} en retard` : "celui en retard"}`
      : lignes.length > 1 ? `Régler les ${lignes.length}` : "Régler";
    return { libelle, href: ids.length ? `/finances/paiements-a-faire?focus=${ids.join(",")}#ord-${ids[0]}` : "/finances/paiements-a-faire" };
  }
  if (lignes.length === 1) return { libelle: def.verbe, href: lignes[0].geste.href };
  return { libelle: `${def.verbe} — tout voir`, href: def.liste ?? lignes[0].geste.href };
}

/**
 * LA FILE « À FAIRE MAINTENANT » — groupée par lot, triée par urgence.
 *
 * Une ligne par objet (le centre d'actions l'a déjà dédoublonnée) ; les lignes « et d'autres… »
 * ne sont pas comptées : elles deviennent la `suite` du lot dont elles ferment la liste.
 */
export function regrouperFile(elements: readonly ElementFile[], now: Date): Lot[] {
  const parNature = new Map<string, { nature: NatureLot; module: string; lignes: LigneLot[]; suite: Geste | null }>();
  const objets = new Map<string, string>();
  for (const e of elements) {
    const nature = natureDe(e);
    // « Autres » se range par module : deux modules sans nature propre ne font pas un même lot.
    const id = nature === "autre" ? `autre:${e.module}` : nature;
    const g = parNature.get(id) ?? { nature, module: e.module, lignes: [], suite: null };
    parNature.set(id, g);
    if (estReste(e)) {
      g.suite = { libelle: e.title, href: e.href };
      continue;
    }
    objets.set(e.key, e.objet);
    g.lignes.push(ligneDe(e, NATURES[nature].verbe, now));
  }

  const lots: Lot[] = [];
  for (const [id, g] of parNature) {
    if (g.lignes.length === 0 && !g.suite) continue;
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
      if (enRetard > 0) {
        titre += g.nature === "regulatory"
          ? `, dont ${enRetard} au-delà de la date cible`
          : n === enRetard ? (n > 1 ? `, tous en retard` : `, en retard`) : `, dont ${enRetard} en retard`;
      }
    }
    const sousTitre = n === 1
      ? [lignes[0].ref, g.nature === "paiement" ? lignes[0].libelle : def.sousTitre].filter(Boolean).join(" · ")
      : def.sousTitre || g.module;
    const ton: Lot["ton"] = enRetard > 0 ? "late" : (attenteMax ?? 0) >= 30 ? "warn" : "";

    lots.push({
      id, nature: g.nature, chapeau: g.nature === "autre" ? g.module : def.chapeau, titre, sousTitre,
      n, montant, enRetard, retardMax, retardCumule, attenteMax, ton, lignes, familles,
      geste: n === 0 && g.suite ? g.suite : gesteDuLot(g.nature, lignes, objets),
      suite: n > 0 ? g.suite : null,
    });
  }
  return lots.sort(parUrgence);
}

/** Les chapeaux de la file, dans l'ordre d'urgence de leurs lots — les filtres de la file. */
export function chapeauxDe(lots: readonly Lot[]): { chapeau: string; n: number }[] {
  const m = new Map<string, number>();
  for (const l of lots) m.set(l.chapeau, (m.get(l.chapeau) ?? 0) + l.n);
  return [...m].map(([chapeau, n]) => ({ chapeau, n }));
}

// ───────────────────────────────────── Votre journée ─────────────────────────────────────────

/** Un fragment de phrase, en gras ou non — la page le rend sans réécrire la phrase. */
export interface Fragment {
  t: string;
  b?: boolean;
}

export function totaux(lots: readonly Lot[]) {
  return {
    ouverts: lots.reduce((s, l) => s + l.n, 0),
    enRetard: lots.reduce((s, l) => s + l.enRetard, 0),
  };
}

/** « 26 éléments attendent un geste de votre part, dont 6 en retard. Commencez par … » */
export function phraseJournee(lots: readonly Lot[]): Fragment[] {
  const { ouverts, enRetard } = totaux(lots);
  if (ouverts === 0) return [{ t: "Rien ne vous attend pour l'instant : " }, { t: "votre file est à jour.", b: true }];
  const out: Fragment[] = [
    { t: `${ouverts} ${pl(ouverts, "élément")}`, b: true },
    { t: ` ${ouverts > 1 ? "attendent" : "attend"} un geste de votre part` },
  ];
  if (enRetard > 0) out.push({ t: ", dont " }, { t: `${enRetard} en retard`, b: true });
  else out.push({ t: ", aucun en retard" });
  const premier = lots.find((l) => l.n > 0);
  if (premier) {
    out.push({ t: ". Commencez par " }, { t: premier.titre, b: true });
    if (premier.retardMax > 0) out.push({ t: ` (jusqu'à ${premier.retardMax} j de retard)` });
    else if ((premier.attenteMax ?? 0) > 0) out.push({ t: ` (attend depuis ${premier.attenteMax} j)` });
  }
  out.push({ t: "." });
  return out;
}

// ───────────────────────────────────────── Ma semaine ────────────────────────────────────────

const JOURS_COURTS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const JOURS_LONGS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const dowDe = (jour: string) => new Date(`${jour}T00:00:00.000Z`).getUTCDay();

export interface BarreJour {
  jour: string;
  label: string;
  n: number;
  etat: "passe" | "aujourdhui" | "futur";
}

export interface Semaine {
  barres: BarreJour[];
  fait: number;
  reste: number;
  /** Part faite de (fait + reste), en % — 100 quand il n'y a rien du tout. */
  pct: number;
  mois: number;
  semainePrecedente: number;
  reconnaissance: Fragment[] | null;
}

/**
 * MA SEMAINE — dimanche → jeudi, comptée sur les horodatages EXISTANTS.
 *
 * `semaine` : les cinq jours ouvrés (« AAAA-MM-JJ », Alger), que l'appelant tient de la règle
 * commune (`semaineOuvree`). `joursDesGestes` : le jour d'Alger de chaque geste daté (décision
 * d'une validation, d'un achat, d'un congé, paiement réglé, déclaration validée, tâche terminée…).
 * La reconnaissance est factuelle : un nombre, une comparaison, un jour — jamais un adjectif
 * que les données ne portent pas ; sans geste, il n'y en a pas.
 */
export function calculerSemaine(p: {
  semaine: readonly string[];
  aujourdhui: string;
  joursDesGestes: readonly string[];
  reste: number;
  semainePrecedente: number;
  mois: number;
}): Semaine {
  const parJour = new Map<string, number>();
  for (const j of p.joursDesGestes) parJour.set(j, (parJour.get(j) ?? 0) + 1);
  const barres: BarreJour[] = p.semaine.map((jour) => ({
    jour,
    label: JOURS_COURTS[dowDe(jour)],
    n: jour > p.aujourdhui ? 0 : parJour.get(jour) ?? 0,
    etat: jour === p.aujourdhui ? "aujourdhui" : jour > p.aujourdhui ? "futur" : "passe",
  }));
  const fait = barres.reduce((s, b) => s + b.n, 0);
  const total = fait + p.reste;
  const pct = total === 0 ? 100 : Math.round((fait / total) * 100);

  let reconnaissance: Fragment[] | null = null;
  if (fait > 0) {
    reconnaissance = [{ t: `${fait} ${pl(fait, "geste")}`, b: true }, { t: " depuis dimanche" }];
    if (p.semainePrecedente > 0) {
      reconnaissance.push(
        fait > p.semainePrecedente
          ? { t: `, plus que toute la semaine dernière (${p.semainePrecedente})` }
          : { t: ` ; ${p.semainePrecedente} la semaine dernière` },
      );
    }
    const meilleur = barres.reduce((m, b) => (b.n > m.n ? b : m), barres[0]);
    if (meilleur && meilleur.n > 1 && barres.filter((b) => b.n > 0).length > 1) {
      reconnaissance.push({ t: `. Journée la plus remplie : ${JOURS_LONGS[dowDe(meilleur.jour)]} (${meilleur.n})` });
    }
    reconnaissance.push({ t: "." });
  } else if (p.mois > 0) {
    reconnaissance = [{ t: `${p.mois} ${pl(p.mois, "geste")}`, b: true }, { t: " depuis le début du mois." }];
  }
  return { barres, fait, reste: p.reste, pct, mois: p.mois, semainePrecedente: p.semainePrecedente, reconnaissance };
}

/**
 * La semaine que « Ma semaine » raconte : un vendredi ou un samedi, c'est celle qui vient de finir
 * (la règle d'équipe `semaineOuvree` regarde, elle, la semaine qui vient — un planning).
 * Rend le jour dont l'appelant demande la semaine ouvrée.
 */
export function jourDeReferenceDeLaSemaine(aujourdhui: string): string {
  const dow = dowDe(aujourdhui);
  const d = new Date(`${aujourdhui}T00:00:00.000Z`);
  if (dow === 5) d.setUTCDate(d.getUTCDate() - 1);
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 2);
  return d.toISOString().slice(0, 10);
}

// ───────────────────────────────────────── Le métier ─────────────────────────────────────────

/** Les chiffres que la page sait lire en plus de la file — chacun ABSENT quand rien ne le porte. */
export interface Mesures {
  reglesSemaine?: { n: number; montant: number } | null;
  declValidees30?: number | null;
  visites30?: number | null;
  visitesPlanifiees?: number | null;
  medecins?: number | null;
  crManquants?: number | null;
  coursesOuvertes?: number | null;
  courses30?: number | null;
  coursesRetard30?: number | null;
  tachesOuvertes?: number | null;
  tachesRetard?: number | null;
  rappels?: number | null;
  equipe?: { directs: number; retards: number; sansRapport: number | null; couverture: { mois: number; objectif: number } | null } | null;
}

export type CleTuile =
  | "a_traiter" | "en_retard" | "plus_longue_attente" | "a_decider"
  | "paiements_montant" | "paiements_retard" | "regles_semaine"
  | "adpro_n" | "adpro_montant" | "promo_n" | "conges" | "achats" | "decl_finales"
  | "reg_dossiers" | "reg_retard" | "pieces"
  | "decl_a_faire" | "decl_pieces" | "decl_validees_30j" | "decl_plus_ancienne"
  | "plans" | "missions" | "equipe_couverture" | "equipe_sans_cr" | "equipe_retards"
  | "visites_30j" | "visites_planifiees" | "medecins" | "cr_a_ecrire" | "prises_en_charge"
  | "directives" | "demandes" | "stocks" | "taches" | "rappels"
  | "courses_ouvertes" | "courses_30j" | "courses_retard_30j";

export interface Tuile {
  cle: CleTuile;
  k: string;
  v: string;
  c: string;
  ton: "late" | "warn" | "ok" | "";
}

export type CleRaccourci =
  | "validations" | "paiements" | "centre_paiement" | "info_med" | "adoption" | "admin" | "ad_pro"
  | "budget_marketing" | "budgets" | "directives" | "regulatory" | "pipeline" | "stocks" | "logistique"
  | "ventes" | "non_servi" | "pch" | "moyens_generaux" | "ma_journee" | "plan_tournee" | "coaching"
  | "rapports_terrain" | "secretariat" | "legal" | "drive" | "documents" | "bd" | "demandes_rh"
  | "conges_rh" | "formations" | "pieces" | "taches" | "promo";

/** Le raccourci : un libellé, une adresse, et le module dont la porte décide (filtré par l'appelant). */
export const RACCOURCIS: Record<CleRaccourci, { label: string; href: string; module: string }> = {
  validations: { label: "Centre de validations", href: "/validations", module: "VALIDATIONS" },
  paiements: { label: "Paiements à faire", href: "/finances/paiements-a-faire", module: "FINANCES" },
  centre_paiement: { label: "Centre de paiement", href: "/centre-de-paiement", module: "PAYMENT_CENTRE" },
  info_med: { label: "Information médicale", href: "/information-medicale", module: "MEDICAL_INFO" },
  adoption: { label: "Score d'adoption", href: "/admin/adoption", module: "ADMIN" },
  admin: { label: "Administration", href: "/admin", module: "ADMIN" },
  ad_pro: { label: "Ad & Pro", href: "/ad-pro", module: "SPONSORING" },
  budget_marketing: { label: "Budget Marketing", href: "/budget-marketing", module: "BUDGET_MARKETING" },
  budgets: { label: "Budgets", href: "/budgets", module: "BUDGETS" },
  directives: { label: "Directives", href: "/directives", module: "DIRECTIVES" },
  regulatory: { label: "Suivi des dossiers", href: "/regulatory", module: "REGULATORY" },
  pipeline: { label: "Pipeline", href: "/regulatory/pipeline", module: "REGULATORY_PIPELINE" },
  stocks: { label: "Stocks", href: "/stocks", module: "STOCKS" },
  logistique: { label: "Logistique", href: "/logistics", module: "LOGISTICS" },
  ventes: { label: "Ventes PCH", href: "/sales", module: "PCH_VENTES" },
  non_servi: { label: "Non servi", href: "/sales/non-servi", module: "PCH_VENTES" },
  pch: { label: "Marchés PCH", href: "/pch", module: "PCH" },
  moyens_generaux: { label: "Moyens généraux", href: "/moyens-generaux", module: "GENERAL_MEANS" },
  ma_journee: { label: "Ma journée", href: "/medical/ma-journee", module: "MEDICAL" },
  plan_tournee: { label: "Plan de tournée", href: "/medical/plan-de-tournee", module: "MEDICAL" },
  coaching: { label: "Coaching", href: "/medical/coaching", module: "MEDICAL" },
  rapports_terrain: { label: "Rapports terrain", href: "/medical/rapports", module: "FIELD_REPORTS" },
  secretariat: { label: "Bureau du secrétariat", href: "/demandes", module: "ADMIN_REQUESTS" },
  legal: { label: "Legal", href: "/legal", module: "LEGAL" },
  drive: { label: "Drive", href: "/drive", module: "DRIVE" },
  documents: { label: "Documents", href: "/documents", module: "DOCUMENTS" },
  bd: { label: "Business Development", href: "/business-development/projets", module: "BD_PROJECTS" },
  demandes_rh: { label: "Demandes RH", href: "/rh/demandes", module: "HR_REQUESTS" },
  conges_rh: { label: "Congés et absences", href: "/rh/conges", module: "HR_REQUESTS" },
  formations: { label: "Formations", href: "/formations", module: "TRAINING" },
  pieces: { label: "Pièces demandées", href: "/pieces", module: "WORKSPACE" },
  taches: { label: "Mes tâches", href: "/mon-espace/taches", module: "WORKSPACE" },
  promo: { label: "Matériel promotionnel", href: "/promo-material", module: "PROMO_MATERIAL" },
};

interface Composition {
  tuiles: CleTuile[];
  raccourcis: CleRaccourci[];
}

/** LA COMPOSITION DE CHAQUE MÉTIER (maquette « Mon espace par métier », onglet « Aujourd'hui »). */
export const METIERS: Record<string, Composition> = {
  SUPER_ADMIN: { tuiles: ["a_traiter", "en_retard", "paiements_montant", "plus_longue_attente"], raccourcis: ["validations", "paiements", "info_med", "admin", "adoption"] },
  GENERAL_MANAGER: { tuiles: ["a_decider", "adpro_montant", "en_retard", "equipe_retards"], raccourcis: ["validations", "ad_pro", "budgets", "directives", "centre_paiement"] },
  OPERATIONS_DIRECTOR: { tuiles: ["a_traiter", "decl_finales", "achats", "en_retard"], raccourcis: ["stocks", "logistique", "non_servi", "moyens_generaux", "info_med"] },
  DIRECTION: { tuiles: ["a_decider", "adpro_n", "decl_finales", "en_retard"], raccourcis: ["ad_pro", "info_med", "conges_rh", "budgets"] },
  PRODUCT_MANAGER: { tuiles: ["adpro_n", "adpro_montant", "promo_n", "plus_longue_attente"], raccourcis: ["budget_marketing", "ad_pro", "promo", "ventes"] },
  HEAD_OF_REGULATORY: { tuiles: ["reg_dossiers", "reg_retard", "a_decider", "plus_longue_attente"], raccourcis: ["regulatory", "pipeline", "validations", "pieces"] },
  REGULATORY_ASSISTANT: { tuiles: ["reg_dossiers", "reg_retard", "pieces"], raccourcis: ["regulatory", "pieces", "drive"] },
  MEDICAL_INFO_PHARMACIST: { tuiles: ["decl_a_faire", "decl_pieces", "decl_validees_30j", "decl_plus_ancienne"], raccourcis: ["info_med", "ad_pro", "pieces"] },
  FINANCE_BUDGET_MANAGER: { tuiles: ["paiements_montant", "paiements_retard", "regles_semaine", "plus_longue_attente"], raccourcis: ["paiements", "centre_paiement", "budgets"] },
  BUSINESS_DEVELOPMENT_MANAGER: { tuiles: ["a_traiter", "en_retard", "taches", "plus_longue_attente"], raccourcis: ["bd", "documents", "drive"] },
  MEDICAL_PROMOTION_MANAGER: { tuiles: ["plans", "equipe_couverture", "equipe_sans_cr", "missions"], raccourcis: ["plan_tournee", "rapports_terrain", "coaching", "ma_journee"] },
  MEDICAL_DELEGATE: { tuiles: ["visites_planifiees", "visites_30j", "medecins", "cr_a_ecrire"], raccourcis: ["ma_journee", "plan_tournee", "rapports_terrain"] },
  NATIONAL_SALES: { tuiles: ["prises_en_charge", "visites_30j", "medecins", "cr_a_ecrire"], raccourcis: ["ma_journee", "plan_tournee", "ad_pro", "rapports_terrain"] },
  HEAD_OF_SALES: { tuiles: ["a_traiter", "directives", "en_retard", "equipe_retards"], raccourcis: ["ventes", "non_servi", "stocks"] },
  SALES_USER: { tuiles: ["stocks", "en_retard", "taches"], raccourcis: ["ventes", "stocks", "pch"] },
  LOGISTICS_MANAGER: { tuiles: ["a_traiter", "en_retard", "taches", "plus_longue_attente"], raccourcis: ["logistique", "stocks", "moyens_generaux"] },
  DIRECTION_ASSISTANT: { tuiles: ["demandes", "en_retard", "a_traiter", "plus_longue_attente"], raccourcis: ["secretariat", "moyens_generaux", "legal", "promo"] },
  COORDINATOR: { tuiles: ["courses_ouvertes", "courses_30j", "courses_retard_30j"], raccourcis: ["taches", "secretariat", "drive"] },
  VIEWER: { tuiles: ["pieces", "taches", "rappels"], raccourcis: ["pieces", "documents", "drive"] },
};

const COMPOSITION_PAR_DEFAUT: Composition = { tuiles: ["a_traiter", "en_retard", "taches", "plus_longue_attente"], raccourcis: ["taches", "pieces"] };

/** Les rôles réels de la personne (principal, puis secondaire), sans doublon. */
export function rolesDe(role: string, secondaryRole?: string | null): string[] {
  return [...new Set([role, secondaryRole].filter((r): r is string => Boolean(r)))];
}

const lotDe = (lots: readonly Lot[], nature: NatureLot) => lots.find((l) => l.nature === nature) ?? null;
const nDe = (lots: readonly Lot[], ...natures: NatureLot[]) => lots.filter((l) => natures.includes(l.nature)).reduce((s, l) => s + l.n, 0);
const plusAncienne = (lots: readonly Lot[]) => {
  let best: { lot: Lot; ligne: LigneLot } | null = null;
  for (const lot of lots) for (const ligne of lot.lignes) {
    if (ligne.attente !== null && (!best || ligne.attente > (best.ligne.attente ?? -1))) best = { lot, ligne };
  }
  return best;
};
const fmtN = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");

/** UNE TUILE, calculée — `null` quand aucune donnée ne la porte (elle n'est pas montrée). */
export function tuile(cle: CleTuile, lots: readonly Lot[], m: Mesures): Tuile | null {
  const t = (k: string, v: string, c: string, ton: Tuile["ton"] = ""): Tuile => ({ cle, k, v, c, ton });
  const { ouverts, enRetard } = totaux(lots);
  const compte = (n: number, k: string, c: string, tonSi: Tuile["ton"] = "") => t(k, fmtN(n), c, n > 0 ? tonSi : "");
  switch (cle) {
    case "a_traiter": {
      const chapeaux = chapeauxDe(lots).slice(0, 3).map((c) => c.chapeau.toLowerCase());
      return t("À traiter", fmtN(ouverts), chapeaux.length ? chapeaux.join(", ") : "rien en attente");
    }
    case "en_retard": {
      const ou = lots.filter((l) => l.enRetard > 0).slice(0, 2).map((l) => l.chapeau.toLowerCase());
      return t("En retard", fmtN(enRetard), enRetard ? ou.join(", ") : "aucun retard", enRetard ? "late" : "ok");
    }
    case "plus_longue_attente": {
      const p = plusAncienne(lots);
      if (!p) return t("Plus longue attente", "—", "rien de daté en attente");
      return t("Plus longue attente", `${p.ligne.attente}\u00a0j`, [p.ligne.ref, p.ligne.libelle].filter(Boolean).join(" · "), (p.ligne.attente ?? 0) >= 30 ? "warn" : "");
    }
    case "a_decider": {
      const n = lots.filter((l) => NATURES[l.nature].decision).reduce((s, l) => s + l.n, 0);
      const quoi = [...new Set(lots.filter((l) => NATURES[l.nature].decision && l.n > 0).map((l) => l.chapeau.toLowerCase()))].slice(0, 3);
      return t("À décider", fmtN(n), quoi.length ? quoi.join(", ") : "aucune décision en attente", n > 0 ? "warn" : "");
    }
    case "paiements_montant": {
      const l = lotDe(lots, "paiement");
      return t("Paiements en attente", montantDzd(l?.montant ?? 0), l ? `${l.n} ${pl(l.n, "ordre")} de dépense` : "aucun ordre à régler");
    }
    case "paiements_retard": {
      const l = lotDe(lots, "paiement");
      const n = l?.enRetard ?? 0;
      return t("Paiements en retard", fmtN(n), n ? `jusqu'à ${l?.retardMax} j après l'échéance` : "aucune échéance dépassée", n ? "late" : "ok");
    }
    case "regles_semaine":
      if (!m.reglesSemaine) return null;
      return t("Réglés cette semaine", fmtN(m.reglesSemaine.n), montantDzd(m.reglesSemaine.montant), m.reglesSemaine.n > 0 ? "ok" : "");
    case "adpro_n":
      return compte(nDe(lots, "adpro"), "Ad & Pro à arbitrer", "à votre étape", "warn");
    case "adpro_montant": {
      const l = lotDe(lots, "adpro");
      if (!l || l.montant === 0) return t("Engagements à arbitrer", montantDzd(0), l ? `${l.n} ${pl(l.n, "demande")} sans montant chiffré` : "aucune demande Ad & Pro");
      return t("Engagements à arbitrer", montantDzd(l.montant), `${l.n} ${pl(l.n, "demande")} Ad & Pro`);
    }
    case "promo_n":
      return compte(nDe(lots, "promo"), "Matériel promotionnel", "dossiers à votre étape");
    case "conges":
      return compte(nDe(lots, "conge"), "Congés à signer", "à votre marche", "warn");
    case "achats": {
      const l = lotDe(lots, "achat");
      return compte(l?.n ?? 0, "Achats à approuver", l && l.montant > 0 ? montantDzd(l.montant) : "vous êtes le valideur", "warn");
    }
    case "decl_finales": {
      const l = lotDe(lots, "declaration-finale");
      return compte(l?.n ?? 0, "Validations finales", l && l.montant > 0 ? `${montantDzd(l.montant)} d'ordres de dépense à naître` : "information médicale", "warn");
    }
    case "reg_dossiers":
      return t("Dossiers suivis", fmtN(nDe(lots, "regulatory")), "non clôturés, dont vous êtes responsable ou assistant·e");
    case "reg_retard": {
      const n = lotDe(lots, "regulatory")?.enRetard ?? 0;
      return t("Dates cibles dépassées", fmtN(n), n ? "à déposer ou replanifier" : "toutes tenues", n ? "late" : "ok");
    }
    case "pieces":
      return compte(nDe(lots, "piece"), "Pièces à déposer", "qu'on vous a demandées", "warn");
    case "decl_a_faire":
      return compte(nDe(lots, "declaration", "declaration-prete"), "À déclarer", `${lotDe(lots, "declaration")?.familles.length ?? 0} ${pl(lotDe(lots, "declaration")?.familles.length ?? 0, "famille")}`);
    case "decl_pieces":
      return compte(nDe(lots, "declaration-pieces"), "Attendent des pièces", "relance depuis la fiche", "warn");
    case "decl_validees_30j":
      if (m.declValidees30 == null) return null;
      return t("Validées sur 30 j", fmtN(m.declValidees30), "par vous", m.declValidees30 > 0 ? "ok" : "");
    case "decl_plus_ancienne": {
      const p = plusAncienne(lots.filter((l) => l.nature.startsWith("declaration")));
      if (!p) return t("Plus ancienne", "—", "aucune déclaration datée");
      return t("Plus ancienne", `${p.ligne.attente}\u00a0j`, [p.ligne.ref, p.ligne.libelle].filter(Boolean).join(" · "), (p.ligne.attente ?? 0) >= 30 ? "warn" : "");
    }
    case "plans":
      return compte(nDe(lots, "plan"), "Plans à valider", "plans de tournée soumis", "warn");
    case "missions":
      return compte(nDe(lots, "mission"), "Ordres de mission", "à valider comme N+1");
    case "equipe_couverture": {
      const c = m.equipe?.couverture;
      if (!c) return null;
      return t("Couverture de l'équipe", `${c.mois}\u00a0%`, `objectif ${c.objectif}\u00a0%`, c.mois >= c.objectif ? "ok" : "warn");
    }
    case "equipe_sans_cr": {
      const n = m.equipe?.sansRapport;
      if (n == null) return null;
      return t("Visites sans compte rendu", fmtN(n), "équipe, mois en cours", n ? "late" : "ok");
    }
    case "equipe_retards": {
      if (!m.equipe) return null;
      return t("Retards dans l'équipe", fmtN(m.equipe.retards), `tâches en retard chez vos ${m.equipe.directs} ${pl(m.equipe.directs, "direct")}`, m.equipe.retards ? "warn" : "ok");
    }
    case "visites_30j":
      return m.visites30 == null ? null : t("Visites réalisées", fmtN(m.visites30), "30 derniers jours", m.visites30 > 0 ? "ok" : "");
    case "visites_planifiees":
      return m.visitesPlanifiees == null ? null : t("Visites planifiées", fmtN(m.visitesPlanifiees), "à venir");
    case "medecins":
      return m.medecins == null ? null : t("Médecins au panel", fmtN(m.medecins), "votre portefeuille");
    case "cr_a_ecrire":
      return m.crManquants == null ? null : t("Comptes rendus à écrire", fmtN(m.crManquants), "visites faites, rien d'écrit", m.crManquants ? "warn" : "ok");
    case "prises_en_charge":
      return compte(nDe(lots, "prise-en-charge"), "Prises en charge", "à instruire", "warn");
    case "directives": {
      const l = lotDe(lots, "directive");
      return compte(l?.n ?? 0, "Directives", l?.enRetard ? `dont ${l.enRetard} en retard` : "à suivre", l?.enRetard ? "late" : "");
    }
    case "demandes": {
      const n = nDe(lots, "demande");
      return compte(n, "Demandes à traiter", "Bureau du secrétariat");
    }
    case "stocks":
      return compte(nDe(lots, "stock"), "Demandes de stocks", "à renseigner", "warn");
    case "taches":
      if (m.tachesOuvertes == null) return null;
      return t("Tâches ouvertes", fmtN(m.tachesOuvertes), m.tachesRetard ? `dont ${m.tachesRetard} en retard` : "aucune en retard", m.tachesRetard ? "warn" : "");
    case "rappels":
      return m.rappels == null ? null : t("Rappels à venir", fmtN(m.rappels), "vos rappels");
    case "courses_ouvertes":
      return m.coursesOuvertes == null ? null : t("Courses à faire", fmtN(m.coursesOuvertes), "ouvertes");
    case "courses_30j":
      return m.courses30 == null ? null : t("Faites sur 30 j", fmtN(m.courses30), "courses terminées", m.courses30 ? "ok" : "");
    case "courses_retard_30j":
      return m.coursesRetard30 == null ? null : t("Hors délai sur 30 j", fmtN(m.coursesRetard30), "durée annoncée dépassée", m.coursesRetard30 ? "warn" : "ok");
    default:
      return null;
  }
}

const RANG_TON: Record<Tuile["ton"], number> = { late: 0, warn: 1, "": 2, ok: 3 };

/** Les tuiles qu'un métier demande ET que les données nourrissent — quand l'une manque, une tuile commune réelle la remplace. */
export function composerTuiles(roles: readonly string[], lots: readonly Lot[], m: Mesures, max = 4): Tuile[] {
  const compositions = roles.map((r) => METIERS[r] ?? COMPOSITION_PAR_DEFAUT);
  const voulues = [...new Set(compositions.flatMap((c) => c.tuiles))];
  let tuiles = voulues.map((c) => tuile(c, lots, m)).filter((x): x is Tuile => x !== null);
  // UN COMPTE À DEUX RÔLES : l'union, la plus pressante d'abord (un seul métier garde son ordre).
  if (compositions.length > 1) tuiles = tuiles.map((x, i) => ({ x, i })).sort((a, b) => RANG_TON[a.x.ton] - RANG_TON[b.x.ton] || a.i - b.i).map((y) => y.x);
  tuiles = tuiles.slice(0, max);
  const minimum = Math.min(max, Math.max(3, compositions[0]?.tuiles.length ?? 3));
  for (const repli of COMPOSITION_PAR_DEFAUT.tuiles) {
    if (tuiles.length >= minimum) break;
    if (tuiles.some((x) => x.cle === repli)) continue;
    const x = tuile(repli, lots, m);
    if (x) tuiles.push(x);
  }
  return tuiles;
}

/** Les raccourcis des métiers, sans doublon, filtrés par la porte de chaque module (`peutOuvrir`). */
export function composerRaccourcis(roles: readonly string[], peutOuvrir: (module: string) => boolean, max = 6): { label: string; href: string }[] {
  const cles = [...new Set(roles.flatMap((r) => (METIERS[r] ?? COMPOSITION_PAR_DEFAUT).raccourcis))];
  const vus = new Set<string>();
  const out: { label: string; href: string }[] = [];
  for (const c of cles) {
    const r = RACCOURCIS[c];
    if (!r || vus.has(r.href) || !peutOuvrir(r.module)) continue;
    vus.add(r.href);
    out.push({ label: r.label, href: r.href });
    if (out.length >= max) break;
  }
  return out;
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
