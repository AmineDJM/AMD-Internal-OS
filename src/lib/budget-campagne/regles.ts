import { plier } from "@/lib/utils";
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CAMPAGNE BUDGÉTAIRE — LES RÈGLES (Budgets 2027, Direction 10/2026, maquette validée).
 *
 * Chaque pôle (un DÉPARTEMENT de l'organigramme) prépare sa proposition, la soumet (v1), les valideurs l'examinent
 * ligne par ligne et décident ; « à revoir » la renvoie au pôle qui resoumet (v2…), autant de tours qu'il faut ; on
 * arbitre ; on valide ; et les enveloppes de l'année se créent d'elles-mêmes, sans jamais se doubler.
 *
 * LES DÉCISIONS DE LA DIRECTION (réglables par campagne, défauts ci-dessous) :
 *   • le DG pose un cadrage global au départ, PRIVÉ — les pôles préparent librement et ne le voient jamais ;
 *   • on valide à deux : le DG ET le Super Admin (comité, règle « tous ») ;
 *   • pas de révision après validation, sauf si le Super Admin l'autorise, proposition par proposition.
 *
 * Module PUR, sans aucun import : lu par les écrans clients (client-bundle-guard), les requêtes, les actions et testé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────── Vocabulaire ───────────────────────────────

export const STATUTS_CAMPAGNE = ["DRAFT", "OPEN", "REVIEW", "ARBITRAGE", "CLOSED"] as const;
export type StatutCampagne = (typeof STATUTS_CAMPAGNE)[number];

export const LIBELLE_STATUT_CAMPAGNE: Record<StatutCampagne, string> = {
  DRAFT: "Cadrage",
  OPEN: "Préparation par pôle",
  REVIEW: "Revue et allers-retours",
  ARBITRAGE: "Arbitrage",
  CLOSED: "Budgets ouverts",
};

export const STATUTS_PROPOSITION = ["EN_PREPARATION", "SOUMIS", "A_REVOIR", "ACCEPTE", "ACCEPTE_AVEC_AJUSTEMENTS", "REFUSE"] as const;
export type StatutProposition = (typeof STATUTS_PROPOSITION)[number];

export const LIBELLE_STATUT_PROPOSITION: Record<StatutProposition, string> = {
  EN_PREPARATION: "en préparation",
  SOUMIS: "à examiner",
  A_REVOIR: "à revoir",
  ACCEPTE: "accepté",
  ACCEPTE_AVEC_AJUSTEMENTS: "accepté avec ajustements",
  REFUSE: "refusé",
};

/** Le ton du badge (`BadgeTone` des écrans). */
export const TON_STATUT_PROPOSITION: Record<StatutProposition, "neutral" | "info" | "warning" | "success" | "danger"> = {
  EN_PREPARATION: "neutral",
  SOUMIS: "info",
  A_REVOIR: "warning",
  ACCEPTE: "success",
  ACCEPTE_AVEC_AJUSTEMENTS: "success",
  REFUSE: "danger",
};

export const STATUTS_ACCEPTES: readonly StatutProposition[] = ["ACCEPTE", "ACCEPTE_AVEC_AJUSTEMENTS"];
export const STATUTS_FINAUX: readonly StatutProposition[] = ["ACCEPTE", "ACCEPTE_AVEC_AJUSTEMENTS", "REFUSE"];

export const SOURCES_LIGNE = ["AUTO_PAIE", "AUTO_RECRUTEMENT", "AUTO_BV", "AUTO_ADPRO", "REALISE_2026", "SAISIE"] as const;
export type SourceLigne = (typeof SOURCES_LIGNE)[number];

export const LIBELLE_SOURCE: Record<SourceLigne, string> = {
  AUTO_PAIE: "Paie",
  AUTO_RECRUTEMENT: "Recrutements",
  AUTO_BV: "Dossiers (BV)",
  AUTO_ADPRO: "Ad & Pro",
  REALISE_2026: "réalisé projeté",
  SAISIE: "saisie",
};

export const DECISIONS_LIGNE = ["ACCEPTE", "AJUSTE", "QUESTION", "REFUSE"] as const;
export type DecisionLigne = (typeof DECISIONS_LIGNE)[number];

export const LIBELLE_DECISION_LIGNE: Record<DecisionLigne, string> = {
  ACCEPTE: "accepté",
  AJUSTE: "ajusté",
  QUESTION: "question posée",
  REFUSE: "refusé",
};

export const MODES_VALIDATION = ["DG", "COMITE"] as const;
export type ModeValidation = (typeof MODES_VALIDATION)[number];
export const REGLES_VALIDATION = ["ALL", "ANY"] as const;
export type RegleValidation = (typeof REGLES_VALIDATION)[number];

export const DOMAINES_CAMPAGNE = ["MARKETING", "REGULATORY", "OPERATIONS", "GENERAL"] as const;
export type DomaineCampagne = (typeof DOMAINES_CAMPAGNE)[number];
export const LIBELLE_DOMAINE: Record<DomaineCampagne, string> = {
  MARKETING: "Budget Marketing",
  REGULATORY: "Budget Regulatory",
  OPERATIONS: "Budget Operations & Sales",
  GENERAL: "Budgets",
};

/** Les clés de catégorie que le code des pôles reconnaît — reprises telles quelles sur la catégorie créée. */
export const CLES_RECONNUES = ["BV_25", "BV_75", "MASSE_SALARIALE_FDV"] as const;

/** Le seuil de justification par défaut (Direction : « au-delà de ±5 % »). */
export const SEUIL_JUSTIFICATION_DEFAUT = 5;

const dans = <T extends string>(liste: readonly T[], v: unknown): v is T => typeof v === "string" && (liste as readonly string[]).includes(v);
export const estStatutCampagne = (v: unknown): v is StatutCampagne => dans(STATUTS_CAMPAGNE, v);
export const estStatutProposition = (v: unknown): v is StatutProposition => dans(STATUTS_PROPOSITION, v);
export const estDecisionLigne = (v: unknown): v is DecisionLigne => dans(DECISIONS_LIGNE, v);
export const estDomaineCampagne = (v: unknown): v is DomaineCampagne => dans(DOMAINES_CAMPAGNE, v);
export const estModeValidation = (v: unknown): v is ModeValidation => dans(MODES_VALIDATION, v);
export const estRegleValidation = (v: unknown): v is RegleValidation => dans(REGLES_VALIDATION, v);
export const estSourceLigne = (v: unknown): v is SourceLigne => dans(SOURCES_LIGNE, v);

// ─────────────────────────────── La campagne ───────────────────────────────

/** Les passages permis — en avant, et un pas en arrière tant que rien n'est clos (une remise rouverte, une revue reprise). */
export const TRANSITIONS_CAMPAGNE: Record<StatutCampagne, readonly StatutCampagne[]> = {
  DRAFT: ["OPEN"],
  OPEN: ["REVIEW"],
  REVIEW: ["OPEN", "ARBITRAGE"],
  ARBITRAGE: ["REVIEW", "CLOSED"],
  CLOSED: [],
};

export function peutPasserCampagne(de: StatutCampagne, vers: StatutCampagne): boolean {
  return TRANSITIONS_CAMPAGNE[de].includes(vers);
}

/** Clore la campagne : chaque proposition doit être tranchée (acceptée ou refusée). */
export function verifierCloture(statuts: readonly string[]): { ok: true } | { ok: false; raison: string } {
  const ouvertes = statuts.filter((s) => !(STATUTS_FINAUX as readonly string[]).includes(s)).length;
  if (ouvertes > 0) return { ok: false, raison: `${ouvertes} proposition(s) ne sont pas encore tranchées.` };
  return { ok: true };
}

/** Les six étapes de la frise. */
export const ETAPES_FRISE = ["Cadrage DG", "Préparation par pôle", "Revue et allers-retours", "Arbitrage", "Validation", "Budgets ouverts"] as const;

/** L'étape en cours (index dans `ETAPES_FRISE`). En arbitrage, tout tranché = on en est à la validation. */
export function etapeCourante(statut: StatutCampagne, statutsPropositions: readonly string[]): number {
  switch (statut) {
    case "DRAFT": return 0;
    case "OPEN": return 1;
    case "REVIEW": return 2;
    case "ARBITRAGE": return statutsPropositions.length > 0 && verifierCloture(statutsPropositions).ok ? 4 : 3;
    case "CLOSED": return 5;
  }
}

// ─────────────────────────────── La proposition ───────────────────────────────

export type GesteProposition =
  | "MODIFIER" | "SOUMETTRE" | "DECIDER_LIGNE" | "VOTER" | "RENVOYER" | "REPRENDRE"
  | "AUTORISER_REVISION" | "ROUVRIR_RECTIFICATIF";

export interface ContexteGeste {
  statutCampagne: StatutCampagne;
  statut: StatutProposition;
  revisionAutorisee: boolean;
  allowRectificatif: boolean;
  estRectificatif: boolean;
}

type Verdict = { ok: true } | { ok: false; raison: string };
const non = (raison: string): Verdict => ({ ok: false, raison });
const oui: Verdict = { ok: true };

/**
 * UN GESTE EST-IL PERMIS DANS CET ÉTAT ? (Les DROITS de la personne se vérifient à part : `droitsCampagne`.)
 *
 * Le pôle prépare tant que la proposition est « en préparation » ou « à revoir » ; les valideurs décident sur une
 * version SOUMISE ; une proposition acceptée ne bouge plus — sauf rectificatif autorisé.
 */
export function gestePermis(geste: GesteProposition, c: ContexteGeste): Verdict {
  const enMain = c.statut === "EN_PREPARATION" || c.statut === "A_REVOIR";
  const campagneVivante = c.statutCampagne !== "DRAFT" && (c.statutCampagne !== "CLOSED" || c.estRectificatif);
  switch (geste) {
    case "MODIFIER":
    case "SOUMETTRE":
      if (c.statutCampagne === "DRAFT") return non("La campagne n'est pas encore ouverte.");
      if (!campagneVivante) return non("La campagne est close.");
      return enMain ? oui : non(`La proposition est ${LIBELLE_STATUT_PROPOSITION[c.statut]} : elle ne se modifie pas.`);
    case "DECIDER_LIGNE":
    case "VOTER":
    case "RENVOYER":
      return c.statut === "SOUMIS" ? oui : non("Seule une version soumise s'examine.");
    case "REPRENDRE":
      if (c.statutCampagne === "CLOSED") return non("La campagne est close.");
      return c.statut === "REFUSE" ? oui : non("Seule une proposition refusée se reprend.");
    case "AUTORISER_REVISION":
      return STATUTS_ACCEPTES.includes(c.statut) ? oui : non("Seule une proposition validée peut recevoir une révision.");
    case "ROUVRIR_RECTIFICATIF":
      if (!STATUTS_ACCEPTES.includes(c.statut)) return non("Seule une proposition validée se rouvre en rectificatif.");
      return c.revisionAutorisee || c.allowRectificatif ? oui : non("Aucune révision n'est autorisée sur ce budget : le Super Admin doit l'autoriser.");
  }
}

/** L'état d'arrivée d'un geste qui change l'état (les votes, eux, passent par `issueDesVotes`). */
export function statutApres(geste: "SOUMETTRE" | "RENVOYER" | "REPRENDRE" | "ROUVRIR_RECTIFICATIF"): StatutProposition {
  return geste === "SOUMETTRE" ? "SOUMIS" : "A_REVOIR";
}

// ─────────────────────────────── Les valideurs ───────────────────────────────

export interface Vote { userId: string; decision: "ACCEPTE" | "REFUSE"; at: number }

/**
 * L'ISSUE DES AVIS sur une version — `null` tant qu'elle n'est pas acquise.
 *   • ALL : un refus suffit à refuser ; il faut l'accord de CHAQUE valideur pour accepter.
 *   • ANY : le premier avis donné tranche.
 * Seuls les avis des valideurs DÉSIGNÉS comptent. Aucun valideur : rien ne se décide (la campagne doit en nommer).
 */
export function issueDesVotes(input: {
  votes: readonly Vote[];
  validatorIds: readonly string[];
  regle: RegleValidation;
  ajustements: boolean;
}): StatutProposition | null {
  const valideurs = new Set(input.validatorIds);
  if (valideurs.size === 0) return null;
  const utiles = input.votes.filter((v) => valideurs.has(v.userId)).sort((a, b) => a.at - b.at);
  if (utiles.length === 0) return null;
  const accepte = input.ajustements ? "ACCEPTE_AVEC_AJUSTEMENTS" : "ACCEPTE";
  if (input.regle === "ANY") return utiles[0].decision === "REFUSE" ? "REFUSE" : accepte;
  // ALL — le dernier avis de chacun compte (un avis se change).
  const dernier = new Map<string, Vote["decision"]>();
  for (const v of utiles) dernier.set(v.userId, v.decision);
  if ([...dernier.values()].includes("REFUSE")) return "REFUSE";
  return [...valideurs].every((id) => dernier.get(id) === "ACCEPTE") ? accepte : null;
}

/** Les valideurs qui n'ont pas encore donné leur avis (« chez qui »). */
export function valideursEnAttente(votes: readonly Vote[], validatorIds: readonly string[]): string[] {
  const ont = new Set(votes.map((v) => v.userId));
  return validatorIds.filter((id) => !ont.has(id));
}

// ─────────────────────────────── Montants, écarts, justification ───────────────────────────────

/** L'écart en % (arrondi au dixième) ; `null` quand il n'y a pas de réalisé (ligne nouvelle). */
export function ecartPct(realise: number, propose: number): number | null {
  if (!(realise > 0)) return propose > 0 ? null : 0;
  return Math.round(((propose - realise) / realise) * 1000) / 10;
}

/** Une justification est exigée au-delà du seuil (strictement) — et toujours pour une ligne nouvelle non nulle. */
export function justificationRequise(realise: number, propose: number, seuilPct: number): boolean {
  const e = ecartPct(realise, propose);
  if (e === null) return propose > 0;
  return Math.abs(e) > Math.max(0, seuilPct);
}

export function lignesSansJustification(
  lignes: readonly { key: string; realise2026: number; propose: number; justification?: string | null }[],
  seuilPct: number,
): string[] {
  return lignes
    .filter((l) => justificationRequise(l.realise2026, l.propose, seuilPct) && !(l.justification ?? "").trim())
    .map((l) => l.key);
}

export interface LigneDecidee { propose: number; ajuste: number | null; decision: string | null }

/** Le montant RETENU d'une ligne : refusée → 0 ; ajustée → le montant ajusté ; sinon le proposé. */
export function montantRetenu(l: LigneDecidee): number {
  if (l.decision === "REFUSE") return 0;
  if (l.decision === "AJUSTE" && l.ajuste !== null && Number.isFinite(l.ajuste)) return Math.max(0, l.ajuste);
  return Math.max(0, l.propose);
}

/** Une ligne ajustée (à un autre montant) ou refusée fait une acceptation « avec ajustements ». */
export function aDesAjustements(lignes: readonly LigneDecidee[]): boolean {
  return lignes.some((l) => l.decision === "REFUSE" || (l.decision === "AJUSTE" && l.ajuste !== null && l.ajuste !== l.propose));
}

/**
 * LE RÉALISÉ DE L'ANNÉE PROJETÉ SUR 12 MOIS — ce qu'on a dépensé depuis le 1er janvier, ramené à une année pleine. Un
 * mois au moins est compté (une projection sur trois jours de janvier multiplierait n'importe quoi par cent). Année
 * close ou passée : le réalisé tel quel. Année pas encore commencée : rien à projeter.
 */
export function projeter12Mois(montant: number, annee: number, maintenant: Date): number {
  if (!(montant > 0)) return 0;
  const debut = Date.UTC(annee, 0, 1);
  const fin = Date.UTC(annee + 1, 0, 1);
  const t = maintenant.getTime();
  if (t <= debut) return Math.round(montant);
  if (t >= fin) return Math.round(montant);
  const mois = Math.max(1, ((t - debut) / (fin - debut)) * 12);
  return Math.round((montant * 12) / mois);
}

// ─────────────────────────────── Versions ───────────────────────────────

export interface LigneInstantane { key: string; label: string; propose: number; categoryLineId?: string | null; justification?: string | null; source?: string }

export interface DiffVersions {
  ajoutees: LigneInstantane[];
  retirees: LigneInstantane[];
  modifiees: { key: string; label: string; de: number; a: number }[];
}

export function diffVersions(avant: readonly LigneInstantane[], apres: readonly LigneInstantane[]): DiffVersions {
  const a = new Map(avant.map((l) => [l.key, l]));
  const b = new Map(apres.map((l) => [l.key, l]));
  return {
    ajoutees: apres.filter((l) => !a.has(l.key)),
    retirees: avant.filter((l) => !b.has(l.key)),
    modifiees: apres
      .filter((l) => a.has(l.key) && a.get(l.key)!.propose !== l.propose)
      .map((l) => ({ key: l.key, label: l.label, de: a.get(l.key)!.propose, a: l.propose })),
  };
}

/**
 * Un montant EXACT, à la française (« 17 500 000 », « 12 500,50 ») — la plateforme n'arrondit jamais un montant
 * (décision du 05/10/2026, la même règle que `formatMontant`, recopiée ici pour garder ce module sans import).
 */
export function montantCourt(n: number): string {
  const entier = Number.isInteger(Math.round(n * 100) / 100);
  return new Intl.NumberFormat("fr-FR", { minimumFractionDigits: entier ? 0 : 2, maximumFractionDigits: 2 }).format(n);
}

/** Le résumé EXACT des changements — le repli de Luna, et ce qu'elle doit dire au minimum. */
export function resumeDiff(vAvant: number, vApres: number, d: DiffVersions): string {
  const morceaux = [
    ...d.modifiees.map((m) => `${m.label.toLowerCase()} ${montantCourt(m.de)} → ${montantCourt(m.a)}`),
    ...d.ajoutees.map((l) => `+ ${l.label.toLowerCase()} (${montantCourt(l.propose)})`),
    ...d.retirees.map((l) => `− ${l.label.toLowerCase()}`),
  ];
  return `v${vAvant} → v${vApres} : ${morceaux.length ? morceaux.join(" ; ") : "aucun montant changé"}.`;
}

/**
 * APRÈS UNE RESOUMISSION, ce que deviennent les décisions de ligne : une question posée est rendue (on y a répondu en
 * resoumettant) ; une ligne dont le montant a bougé redevient à examiner ; une ligne inchangée garde sa décision.
 */
export function decisionsApresResoumission(
  avant: ReadonlyMap<string, number>,
  lignes: readonly { key: string; propose: number; decision: string | null; ajuste: number | null }[],
): { key: string; decision: string | null; ajuste: number | null }[] {
  return lignes.map((l) => {
    const change = avant.get(l.key) !== l.propose;
    if (l.decision === "QUESTION" || change) return { key: l.key, decision: null, ajuste: null };
    return { key: l.key, decision: l.decision, ajuste: l.ajuste };
  });
}

// ─────────────────────────────── Le cadrage reste privé ───────────────────────────────

/** Ce qu'un pôle reçoit de la campagne — une LISTE BLANCHE : le cadrage n'y entre pas, même par mégarde. */
export interface CampagnePourPole {
  id: string; year: number; title: string; status: StatutCampagne;
  opensAt: string; submitDeadline: string; validationDeadline: string;
  seuilJustificationPct: number;
}

export function campagnePourPole(c: {
  id: string; year: number; title: string; status: string;
  opensAt: Date | string; submitDeadline: Date | string; validationDeadline: Date | string;
  seuilJustificationPct: number;
}): CampagnePourPole {
  const iso = (d: Date | string) => (typeof d === "string" ? d : d.toISOString());
  return {
    id: c.id, year: c.year, title: c.title, status: estStatutCampagne(c.status) ? c.status : "DRAFT",
    opensAt: iso(c.opensAt), submitDeadline: iso(c.submitDeadline), validationDeadline: iso(c.validationDeadline),
    seuilJustificationPct: c.seuilJustificationPct,
  };
}

/** Une proposition telle qu'un pôle la reçoit : sans son cadrage. */
export function vuePoleSansCadrage<T extends { cadrage?: unknown }>(p: T): Omit<T, "cadrage"> {
  const copie: Partial<T> = { ...p };
  delete copie.cadrage;
  return copie as Omit<T, "cadrage">;
}

// ─────────────────────────────── Les droits ───────────────────────────────

export interface EntreeDroits {
  userId: string;
  estSuperAdmin: boolean;
  /** Directeur Général (rôle principal ou « autre rôle »). */
  estDG: boolean;
  /** Le module en portée « tout » (Direction, DG, Finances…) — l'accès implicite d'un responsable est borné. */
  voitTout: boolean;
  /** BUDGET_CAMPAIGN:UPDATE — créer, régler, faire avancer la campagne. */
  peutPiloter: boolean;
  validatorIds: readonly string[];
  /** Les départements dont la personne est responsable ou adjointe. */
  polesTenus: readonly string[];
}

export interface DroitsCampagne {
  voitVueDG: boolean;
  voitLeCadrage: boolean;
  estValideur: boolean;
  peutPiloter: boolean;
  peutAutoriserRevision: boolean;
  peutReglerRectificatif: boolean;
}

export function droitsCampagne(e: EntreeDroits): DroitsCampagne {
  const estValideur = e.validatorIds.includes(e.userId);
  const peutPiloter = e.peutPiloter || e.estSuperAdmin;
  return {
    voitVueDG: e.voitTout || peutPiloter || estValideur,
    // PRIVÉ (Direction) : le DG, les valideurs et le Super Admin — pas le pilote qui ne valide pas, jamais un pôle.
    voitLeCadrage: e.estSuperAdmin || e.estDG || estValideur,
    estValideur,
    peutPiloter,
    peutAutoriserRevision: e.estSuperAdmin,
    peutReglerRectificatif: e.estSuperAdmin,
  };
}

export function peutPreparer(e: EntreeDroits, departmentId: string | null): boolean {
  if (e.peutPiloter || e.estSuperAdmin) return true;
  return departmentId !== null && e.polesTenus.includes(departmentId);
}

export function peutVoirProposition(e: EntreeDroits, departmentId: string | null): boolean {
  return droitsCampagne(e).voitVueDG || (departmentId !== null && e.polesTenus.includes(departmentId));
}

// ─────────────────────────────── Pôles et domaines ───────────────────────────────

/** Le domaine des enveloppes d'un pôle, deviné de son nom (modifiable dans les réglages). */
export function domaineParDefaut(nom: string, code?: string | null): DomaineCampagne {
  const t = plier(`${nom} ${code ?? ""}`);
  if (t.includes("marketing")) return "MARKETING";
  if (t.includes("regul")) return "REGULATORY";
  if (/operation|commercial|sales|vente/.test(t)) return "OPERATIONS";
  return "GENERAL";
}

/** « Où — chez qui » d'une proposition. */
export function ouChezQui(statut: StatutProposition, pole: string, valideursRestants: readonly string[] = []): string {
  switch (statut) {
    case "EN_PREPARATION": return `en préparation — chez ${pole}`;
    case "SOUMIS": return valideursRestants.length ? `à examiner — chez ${valideursRestants.join(", ")}` : "à examiner — chez les valideurs";
    case "A_REVOIR": return `à revoir — chez ${pole}`;
    default: return LIBELLE_STATUT_PROPOSITION[statut];
  }
}

// ─────────────────────────────── Le pré-remplissage ───────────────────────────────

export interface LignePrefill {
  key: string; label: string; categoryKey: string | null; source: SourceLigne;
  realise2026: number; propose: number; justification?: string | null;
}

export interface LigneExistante { key: string; source: string; propose: number; justification: string | null }

/**
 * FUSIONNER UN PRÉ-REMPLISSAGE dans les lignes existantes — rejouable : une ligne connue voit son réalisé mis à jour,
 * mais son montant proposé n'est repris que s'il est encore à zéro (on n'écrase jamais ce que le pôle a saisi). Une
 * ligne saisie à la main n'est jamais touchée.
 */
export function fusionnerPrefill(existantes: readonly LigneExistante[], proposees: readonly LignePrefill[]): {
  creer: LignePrefill[];
  maj: { key: string; realise2026: number; propose?: number; source: SourceLigne; justification?: string | null }[];
} {
  const par = new Map(existantes.map((l) => [l.key, l]));
  const creer: LignePrefill[] = [];
  const maj: { key: string; realise2026: number; propose?: number; source: SourceLigne; justification?: string | null }[] = [];
  for (const p of proposees) {
    const e = par.get(p.key);
    if (!e) { creer.push(p); continue; }
    if (e.source === "SAISIE") continue;
    maj.push({
      key: p.key, realise2026: p.realise2026, source: p.source,
      ...(e.propose === 0 ? { propose: p.propose } : {}),
      ...(!(e.justification ?? "").trim() && p.justification ? { justification: p.justification } : {}),
    });
  }
  return { creer, maj };
}

// ─────────────────────────────── L'enveloppe de l'année (idempotente) ───────────────────────────────

export interface LignePourEnveloppe { key: string; label: string; categoryKey: string | null; categoryLineId: string | null; montant: number }
export interface CategorieExistante { id: string; name: string; cle: string | null; allocated: number; parentId: string | null }

export interface PlanEnveloppe {
  creer: { key: string; nom: string; cle: string | null; allocated: number }[];
  majCategories: { categoryId: string; key: string | null; nom: string; de: number; a: number }[];
  /** Les lignes à (re)lier à leur catégorie. */
  liens: { key: string; categoryId: string }[];
  total: number;
}

const cleReconnue = (k: string | null): string | null => (k && (CLES_RECONNUES as readonly string[]).includes(k) ? k : null);

/**
 * CE QU'IL FAUT ÉCRIRE pour que l'enveloppe dise la proposition validée — et RIEN si elle le dit déjà.
 *
 * Une ligne retrouve sa catégorie par l'id gardé, puis par sa clé reconnue (BV, masse salariale), puis par son nom ;
 * sinon on la crée (si son montant n'est pas nul). Une catégorie liée par une version précédente et qui n'a plus de
 * ligne (rectificatif) passe à zéro — on ne supprime jamais une catégorie qui a peut-être déjà consommé. Rejouée sur
 * son propre résultat, la fonction ne crée rien et ne change rien : c'est l'idempotence.
 */
export function planEnveloppe(
  lignes: readonly LignePourEnveloppe[],
  existantes: readonly CategorieExistante[],
  categoriesLiees: readonly string[] = [],
): PlanEnveloppe {
  const tete = existantes.filter((c) => c.parentId === null);
  const prises = new Set<string>();
  const plan: PlanEnveloppe = { creer: [], majCategories: [], liens: [], total: 0 };
  for (const l of lignes) {
    const montant = Math.max(0, Math.round(l.montant * 100) / 100);
    plan.total += montant;
    const libre = (c: CategorieExistante) => !prises.has(c.id);
    const cle = cleReconnue(l.categoryKey);
    const trouvee =
      (l.categoryLineId ? tete.find((c) => c.id === l.categoryLineId && libre(c)) : undefined)
      ?? (cle ? tete.find((c) => c.cle === cle && libre(c)) : undefined)
      ?? tete.find((c) => plier(c.name) === plier(l.label) && libre(c));
    if (trouvee) {
      prises.add(trouvee.id);
      if (trouvee.allocated !== montant) plan.majCategories.push({ categoryId: trouvee.id, key: l.key, nom: trouvee.name, de: trouvee.allocated, a: montant });
      if (l.categoryLineId !== trouvee.id) plan.liens.push({ key: l.key, categoryId: trouvee.id });
    } else if (montant > 0) {
      plan.creer.push({ key: l.key, nom: l.label, cle, allocated: montant });
    }
  }
  for (const id of categoriesLiees) {
    const c = tete.find((x) => x.id === id);
    if (c && !prises.has(c.id) && c.allocated !== 0) plan.majCategories.push({ categoryId: c.id, key: null, nom: c.name, de: c.allocated, a: 0 });
  }
  plan.total = Math.round(plan.total * 100) / 100;
  return plan;
}

/** Le nom de l'enveloppe de l'année d'un pôle. */
export function nomEnveloppe(annee: number, pole: string): string {
  return `Budget ${annee} — ${pole}`;
}
