import { formatCurrency, formatDate } from "@/lib/utils";

/**
 * LE CENTRE DE VALIDATIONS, UN SEUL ÉCRAN (maquette validée par le Super Admin le 24/11/2026,
 * `CentreValidations.dc.html`) — les règles d'AFFICHAGE, pures.
 *
 * La file « À décider » à gauche, la fiche de la demande choisie à droite, le reste (déjà décidés, mes demandes
 * envoyées, règles) derrière ⋯. Ce module dit ce qu'une ligne affiche : son étiquette, son état court, ses alertes,
 * le libellé du bouton d'accord et la phrase de ce qui suit. Il ne décide d'AUCUN droit et n'écrit rien : la
 * décision reste `decideValidation`, la question `commenterValidation`.
 *
 * Module PUR (seule importation : les formats de `lib/utils`) — l'écran client et le chargeur serveur le lisent,
 * les tests l'éprouvent sans base.
 */

/** La famille d'une demande, pour l'étiquette de la ligne et les gestes propres à chacune. */
export type GenreDemande = "BV" | "BC" | "SEC" | "IM" | "PIECE" | "AUTRE";

/** Les natures posées par le code (`ValidationRequest.objectType`) — recopiées : leurs modules sont serveur. */
const OBJET_BV_25 = "REGULATORY_BV_25";
const OBJET_BV_75 = "REGULATORY_BV_75";
const OBJETS_BC: ReadonlySet<string> = new Set(["BON_DE_COMMANDE", "PREVALIDATION_BC"]);
const OBJET_INFO_MED = "INFO_MED_DIRECTEUR_OPS";

export function genreDeLaDemande(d: { objectType?: string | null; entityType?: string | null; documentId?: string | null }): GenreDemande {
  const o = d.objectType?.trim() ?? "";
  if (o === OBJET_BV_25 || o === OBJET_BV_75) return "BV";
  if (OBJETS_BC.has(o)) return "BC";
  if (o === OBJET_INFO_MED || d.entityType === "MEDICAL_INFO_DECLARATION") return "IM";
  // Une validation qui vise UNE pièce (une facture d'une demande du secrétariat…) : on valide la pièce, pas l'objet.
  if (d.documentId) return "PIECE";
  if (d.entityType === "ADMIN_REQUEST") return "SEC";
  return "AUTRE";
}

/** La part d'un BV (25 / 75) — `null` hors BV. */
export function partDuBv(objectType: string | null | undefined): "25" | "75" | null {
  if (objectType === OBJET_BV_25) return "25";
  if (objectType === OBJET_BV_75) return "75";
  return null;
}

/** L'étiquette courte de la ligne : « BV 25 % », « BC », « Secrétariat »… à défaut le module d'origine. */
export function etiquetteDeLaDemande(genre: GenreDemande, objectType: string | null | undefined, module: string): string {
  switch (genre) {
    case "BV": { const p = partDuBv(objectType); return p ? `BV ${p} %` : "BV"; }
    case "BC": return "BC";
    case "SEC": return "Secrétariat";
    case "IM": return "Info. médicale";
    case "PIECE": return "Pièce";
    default: return module.trim() || "Validation";
  }
}

const JOUR = 86_400_000;
/** Jours calendaires écoulés de `a` à `b` (négatif si `b` est avant `a`). */
const joursEntre = (a: Date, b: Date) => Math.floor((Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) / JOUR);
const court = (d: string | Date) => formatDate(d, { day: "numeric", month: "short" });

export type Ton = "rouge" | "orange" | "bleu" | "neutre";

/** Ce que la ligne a besoin de connaître pour son état et ses alertes. */
export interface EtatLigneSource {
  echeance: string | null;
  /** Depuis quand la décision m'attend (mon tour) ; à défaut le dépôt. */
  depuis: string | null;
  demandeLe: string;
  pourLeCompteDe?: string | null;
  version?: number;
}

/** Échéance dépassée — de combien de jours (0 = pas en retard, ou pas d'échéance). */
export function joursDeRetard(echeance: string | null, now: Date): number {
  if (!echeance) return 0;
  const d = new Date(echeance);
  if (Number.isNaN(d.getTime()) || d.getTime() >= now.getTime()) return 0;
  return Math.max(1, joursEntre(d, now));
}

/**
 * L'ÉTAT COURT DE LA LIGNE, à droite sous le montant : « Question posée » quand la dernière parole est la mienne, sinon
 * le retard (rouge), l'échéance à venir, ou l'ancienneté de l'attente.
 */
export function etatCourt(l: EtatLigneSource, now: Date, questionPosee = false): { texte: string; ton: Ton } {
  if (questionPosee) return { texte: "Question posée", ton: "bleu" };
  const retard = joursDeRetard(l.echeance, now);
  if (retard > 0) return { texte: `en retard de ${retard} j`, ton: "rouge" };
  if (l.echeance) return { texte: `avant le ${court(l.echeance)}`, ton: "neutre" };
  const depuis = joursEntre(new Date(l.depuis ?? l.demandeLe), now);
  return { texte: depuis <= 0 ? "aujourd'hui" : `depuis ${depuis} j`, ton: "neutre" };
}

/** L'échéance en tête de fiche, sous le montant. */
export function phraseEcheance(echeance: string | null, now: Date): string {
  if (!echeance) return "Sans échéance";
  if (joursDeRetard(echeance, now) > 0) return `Échéance dépassée (${court(echeance)})`;
  return `Avant le ${court(echeance)}`;
}

export interface Alerte { titre: string; detail: string; ton: "rouge" | "orange" }

/** Une demande sans échéance qui dort depuis ce nombre de jours se signale. */
export const JOURS_DORMANTE = 7;

/**
 * LES ALERTES D'UNE DEMANDE — ce qui doit sauter aux yeux avant de décider, en une phrase chacune. Rien n'est
 * inventé : chaque alerte se lit sur la demande ou sur le budget lu par le chargeur.
 */
export function alertesDeLaDemande(l: EtatLigneSource & { bv?: BlocBv | null }, now: Date): Alerte[] {
  const out: Alerte[] = [];
  const retard = joursDeRetard(l.echeance, now);
  if (retard > 0) {
    out.push({ titre: `En retard de ${retard} jour${retard > 1 ? "s" : ""}`, detail: `échéance du ${court(l.echeance!)}`, ton: "rouge" });
  } else if (!l.echeance) {
    const dort = joursEntre(new Date(l.depuis ?? l.demandeLe), now);
    if (dort >= JOURS_DORMANTE) out.push({ titre: `Sans décision depuis ${dort} jours`, detail: "aucune échéance ne la signale", ton: "orange" });
  }
  if (l.bv && l.bv.etat === "LU" && l.bv.disponibleApres < 0) {
    out.push({ titre: "Budget BV dépassé", detail: `il manquerait ${formatCurrency(-l.bv.disponibleApres)} sur ${l.bv.categorie}`, ton: "rouge" });
  }
  if (l.bv && l.bv.etat === "SANS_ENVELOPPE") {
    out.push({ titre: "Aucune enveloppe BV", detail: "accepté, ce BV ne serait compté dans aucun budget Regulatory", ton: "orange" });
  }
  // En intérim, on tranche AU NOM de l'absent : la fiche le dit avant le bouton (I18).
  if (l.pourLeCompteDe) out.push({ titre: `Intérim pour ${l.pourLeCompteDe}`, detail: "votre décision est enregistrée à votre nom, pour son compte", ton: "orange" });
  if ((l.version ?? 1) > 1) out.push({ titre: "Resoumise après correction", detail: `version ${l.version}`, ton: "orange" });
  return out;
}

/** L'alerte de la ligne, en une phrase (les titres). */
export function alerteCourte(alertes: readonly Alerte[]): { texte: string; ton: "rouge" | "orange" } | null {
  if (alertes.length === 0) return null;
  return { texte: alertes.map((a) => a.titre).join(" · "), ton: alertes.some((a) => a.ton === "rouge") ? "rouge" : "orange" };
}

/** Les motifs de refus en un clic — ceux du genre d'abord, puis les communs. */
export const MOTIFS_REFUS_COMMUNS = ["Non prioritaire", "Budget insuffisant", "Pièce manquante ou illisible", "Montant à justifier"] as const;
const MOTIFS_PROPRES: Partial<Record<GenreDemande, string[]>> = {
  BV: ["Dossier pas prêt pour la présoumission"],
  BC: ["Prendre le devis le moins cher"],
  IM: ["Pas de déclaration nécessaire"],
};
export function motifsDeRefus(genre: GenreDemande): string[] {
  return [...(MOTIFS_PROPRES[genre] ?? []), ...MOTIFS_REFUS_COMMUNS];
}

export function libelleAccepter(genre: GenreDemande): string {
  switch (genre) {
    case "BV": return "Accepter le BV";
    case "BC": return "Accepter le BC";
    case "IM": return "Accepter : déclarer";
    case "PIECE": return "Accepter la pièce";
    default: return "Accepter";
  }
}

/** Le prénom et l'initiale (« Yasmine B. ») — pour les phrases courtes. */
export function nomCourt(nom: string | null | undefined): string {
  const parts = (nom ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "le demandeur";
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

/**
 * CE QUI SE PASSE APRÈS L'ACCORD — une phrase au-dessus des boutons. Le circuit séquentiel nomme le validateur suivant ;
 * un BV dit ce qu'il engage ; un BC, la signature qui suit.
 */
export function phraseApres(l: { genre: GenreDemande; montant: number | null; demandeur: string; suivant: string | null; bv?: BlocBv | null; objectType?: string | null }): string {
  if (l.suivant) return `Accepté : la demande passe à ${l.suivant}.`;
  if (l.genre === "BV") {
    const montant = l.montant !== null ? formatCurrency(l.montant) : "le montant";
    return `Accepté : ${montant} engagés au budget ${etiquetteDeLaDemande("BV", l.objectType, "")}. Regulatory coche ensuite le paiement sur le dossier.`;
  }
  if (l.genre === "BC") return "Accepté : le bon de commande part à la signature.";
  return `Accepté : ${nomCourt(l.demandeur)} est prévenu.`;
}

/** Une parole du fil de la demande. */
export interface MessageFil { id: string; auteur: string; deMoi: boolean; le: string; texte: string }

/** La dernière parole est la mienne : j'ai posé une question, j'attends la réponse. */
export function questionPosee(fil: readonly MessageFil[]): boolean {
  return fil.length > 0 && fil[fil.length - 1]!.deMoi;
}

// ─────────────────────────────── Le budget d'un BV ───────────────────────────────

/**
 * LE BUDGET D'UN BV, avant → après (`etat`) :
 *  • LU : la catégorie BV de l'enveloppe Regulatory qui le comptera s'il est accepté aujourd'hui, et ses chiffres ;
 *  • NON_VISIBLE : l'enveloppe existe, mais n'est pas ouverte à la personne (on ne montre pas ses chiffres) ;
 *  • SANS_ENVELOPPE : aucune enveloppe Regulatory ne couvre la date — accepté, le BV ne compterait nulle part.
 */
export type BlocBv =
  | {
      etat: "LU"; part: "25" | "75"; categorie: string; periode: string;
      alloue: number; consomme: number; engage: number; demande: number;
      disponibleAvant: number; disponibleApres: number;
      /** BV 25 % : le 75 % qui suivra (3 × ce montant) et ce qu'il reste sur sa ligne — `null` quand on ne le sait pas. */
      prevision75: { montant: number; disponible: number | null } | null;
    }
  | { etat: "NON_VISIBLE"; part: "25" | "75"; categorie: string }
  | { etat: "SANS_ENVELOPPE"; part: "25" | "75" };

export interface SegmentBv { cle: "consomme" | "engage" | "demande" | "disponible"; label: string; valeur: number; pct: number }

/** Les quatre segments de la barre (consommé, engagé, cette demande, disponible après), en % de l'alloué. */
export function segmentsBv(b: Extract<BlocBv, { etat: "LU" }>): SegmentBv[] {
  const base = Math.max(b.alloue, b.consomme + b.engage + b.demande, 1);
  const pct = (v: number) => Math.round((Math.max(0, v) / base) * 1000) / 10;
  return [
    { cle: "consomme", label: "Consommé", valeur: b.consomme, pct: pct(b.consomme) },
    { cle: "engage", label: "Engagé", valeur: b.engage, pct: pct(b.engage) },
    { cle: "demande", label: "Cette demande", valeur: b.demande, pct: pct(b.demande) },
    { cle: "disponible", label: "Disponible après", valeur: b.disponibleApres, pct: pct(b.disponibleApres) },
  ];
}

/** « Disponible 5 750 000 → 3 900 000 DZD ». */
export function phraseAvantApres(b: Extract<BlocBv, { etat: "LU" }>): string {
  return `Disponible ${formatCurrency(b.disponibleAvant).replace(/\s?DZD$/, "")} → ${formatCurrency(b.disponibleApres)}`;
}

// ─────────────────────────────── Le menu ⋯ ───────────────────────────────

/** La décision d'une étape, pour « Déjà décidés ». */
export function libelleDecision(status: string, motif: string | null | undefined): { texte: string; accord: boolean } {
  if (status === "APPROVED") return { texte: "Accepté", accord: true };
  if (status === "REJECTED") return { texte: motif ? `Refusé · ${motif}` : "Refusé", accord: false };
  if (status === "CHANGES_REQUESTED") return { texte: "Renvoyé pour correction", accord: false };
  return { texte: "Sans objet", accord: false };
}

/** L'état d'une demande que j'ai envoyée, pour « Mes demandes envoyées ». */
export function etatEnvoyee(status: string, depuis: string, decideeLe: string | null, now: Date): { texte: string; ton: Ton } {
  if (status === "APPROVED") return { texte: decideeLe ? `Acceptée le ${court(decideeLe)}` : "Acceptée", ton: "neutre" };
  if (status === "REJECTED") return { texte: decideeLe ? `Refusée le ${court(decideeLe)}` : "Refusée", ton: "rouge" };
  if (status === "CHANGES_REQUESTED") return { texte: "À corriger", ton: "orange" };
  if (status === "CANCELLED") return { texte: "Retirée", ton: "neutre" };
  const j = joursEntre(new Date(depuis), now);
  return { texte: j <= 0 ? "En attente" : `En attente · ${j} j`, ton: "orange" };
}

/** Le message qui suit une décision (le bandeau « Accepté : … — … »). */
export function messageDecision(
  decision: "APPROVED" | "REJECTED" | "CHANGES_REQUESTED",
  l: { objet: string; demandeur: string; genre: GenreDemande; montant: number | null; objectType?: string | null; suivant: string | null },
  motif?: string,
): string {
  const qui = nomCourt(l.demandeur);
  if (decision === "REJECTED") return `Refusé : ${l.objet} — ${qui} lit votre motif : « ${motif ?? ""} ».`;
  if (decision === "CHANGES_REQUESTED") return `Renvoyé pour correction : ${l.objet} — la demande revient chez ${qui} avec votre question.`;
  if (l.suivant) return `Accepté : ${l.objet} — la demande passe à ${l.suivant}.`;
  if (l.genre === "BV" && l.montant !== null) return `Accepté : ${l.objet} — ${formatCurrency(l.montant)} engagés au budget ${etiquetteDeLaDemande("BV", l.objectType, "")}.`;
  if (l.genre === "BC") return `Accepté : ${l.objet} — le bon de commande part à la signature.`;
  return `Accepté : ${l.objet} — ${qui} est prévenu.`;
}

/** Le panneau du menu ⋯ qu'une adresse ouvre (`?vue=`) — tout autre mot ramène à la file. */
export type PanneauCentre = "decides" | "envoyees" | "regles" | "supervision";
const PANNEAUX: ReadonlySet<string> = new Set(["decides", "envoyees", "regles", "supervision"]);
export function panneauDeLAdresse(vue: string | null | undefined): PanneauCentre | null {
  return vue && PANNEAUX.has(vue) ? (vue as PanneauCentre) : null;
}

/**
 * LA LIGNE CHOISIE À L'OUVERTURE — celle que l'adresse désigne (`?focus=<étape>` des notifications, ou `?demande=<id>`),
 * sinon la première de la file.
 */
export function ligneInitiale(
  file: readonly { stepId: string; requestId: string }[],
  focus: string | null | undefined,
  demande: string | null | undefined,
): string | null {
  const parEtape = focus ? file.find((l) => l.stepId === focus) : undefined;
  if (parEtape) return parEtape.stepId;
  const parDemande = demande ? file.find((l) => l.requestId === demande) : undefined;
  if (parDemande) return parDemande.stepId;
  return file[0]?.stepId ?? null;
}

// ─────────────────────────────── Les formes que l'écran reçoit ───────────────────────────────

/** Une pièce de la demande, ouvrable en aperçu. */
export interface PieceCentre { id: string; nom: string; hasFile: boolean }

/** UNE LIGNE DE LA FILE — une étape à MOI de décider, avec tout ce que sa fiche affiche (chargeur `centre-validations`). */
export interface LigneCentre {
  stepId: string;
  requestId: string;
  reference: string;
  genre: GenreDemande;
  etiquette: string;
  /** La nature en clair (« Autorisation du BV 25 % ») — à défaut le module. */
  nature: string;
  objectType: string | null;
  objet: string;
  description: string;
  montant: number | null;
  demandeur: string;
  demandeLe: string;
  depuis: string | null;
  echeance: string | null;
  /** L'objet d'origine, ouvrable (`request.link` ou la table des routes) — `null` sans lien sûr. */
  lienObjet: string | null;
  societe: string | null;
  pourLeCompteDe: string | null;
  version: number;
  /** Les étapes déjà acceptées du circuit, dans l'ordre. */
  chaine: { etape: string; detail: string }[];
  /** En séquentiel, le validateur qui suit — `null` quand je suis le dernier (ou en parallèle). */
  suivant: string | null;
  pieces: PieceCentre[];
  fil: MessageFil[];
  bv: BlocBv | null;
  /** Le seuil des BC hors Ad & Pro, rappelé sur la fiche d'un BC. */
  seuilBC: number | null;
}

/** Une décision que j'ai prise (« Déjà décidés »). */
export interface LigneDecidee {
  stepId: string; requestId: string; etiquette: string; genre: GenreDemande; objet: string; montant: number | null;
  status: string; motif: string | null; decideeLe: string;
}

/** Une demande que j'ai envoyée (« Mes demandes envoyées ») — ses pièces séparées regroupées sous elle (`grouping.ts`). */
export interface LigneEnvoyee {
  key: string;
  /** La fiche à ouvrir (`/validations/<id>`). */
  id: string;
  /** La demande portant sur l'objet entier — celle qu'on supprime (Super Admin). */
  mainId: string | null;
  reference: string;
  objet: string;
  /** « à » qui : les validateurs du circuit. */
  a: string;
  status: string;
  depuis: string;
  decideeLe: string | null;
  /** « 3 pièces — 2 acceptées, 1 en attente ». */
  resume: string;
  /** Les retours élément par élément des validateurs (message, pièces). */
  retours: { validateur: string; element: string; decision: string; commentaire: string }[];
  /** La pré-validation d'un BC : le BC, s'il est encore retenu (validation finale à demander), sinon son étape. */
  bc: { docId: string; reference: string; retenu: boolean; etape: string | null } | null;
}

/**
 * LES RÈGLES DE VALIDATION, DITES UNE FOIS (⋯ › Règles de validation) — où part chaque demande et qui la tranche. Le
 * seuil des BC hors Ad & Pro, réglable, s'affiche à part (il vit dans les réglages).
 */
export const REGLES_DU_CENTRE: readonly { quoi: string; qui: string }[] = [
  { quoi: "Bons de commande Ad & Pro", qui: "au Centre de validation Ad & Pro, avec son propre seuil" },
  { quoi: "BV Regulatory 25 % et 75 %", qui: "toute personne qui a accès au Centre de validations · une décision suffit" },
  { quoi: "Information médicale", qui: "le Directeur des Opérations · à défaut, le Super Admin" },
  { quoi: "Demandes du secrétariat", qui: "celles que l'assistante fait valider, au validateur qu'elle désigne" },
  { quoi: "Autres demandes", qui: "les validateurs choisis par le demandeur, dans l'ordre du circuit" },
  { quoi: "Qui a accès au centre", qui: "Directeur Général et Super Admin par défaut · réglé dans Administration › Accès" },
];
