/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FICHE DE DÉCISION DU CENTRE DE PAIEMENT — sa forme, et les règles qui la remplissent.
 *
 * Maquette validée le 24/11/2026 (`CentrePaiement.dc.html`) : à gauche la file « À décider », à
 * droite UNE fiche qui dit, pour l'ordre choisi, tout ce qu'il faut savoir avant d'autoriser —
 * d'où vient le paiement, à qui il part (et si on l'a déjà payé), ce qui a déjà été validé en
 * amont (BC signé, bon à payer…), les pièces, les montants du devis à la facture, le budget avant
 * et après, et les ALERTES en rouge (doublon, bénéficiaire nouveau, montant au-dessus du BC…).
 *
 * L'écran précédent montrait une ligne de tableau et un lien vers « le dossier » : le centre
 * autorisait sans voir le BC amont, ni la facture, ni le budget. Ce module ne lit rien : il décrit
 * la forme que le chargeur (`infra/requetes/contexte-decision.ts`) remplit, et les règles PURES
 * qu'on veut éprouver sans base — l'ordre de la file, la phrase d'historique, les écarts de
 * montant, le budget avant/après.
 *
 * Module PUR : importable par l'écran (navigateur) comme par le chargeur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { isHighValue } from "./authorization";

/** Rouge : à lire AVANT d'autoriser. Orange : à savoir, sans gravité. */
export type NiveauAlerte = "BLOQUANT" | "ATTENTION";

export interface AlerteDecision {
  titre: string;
  detail: string;
  niveau: NiveauAlerte;
}

/** Une étape déjà franchie (ou attendue) en amont du centre. */
export type EtatEtape = "OK" | "KO" | "ATTENTE";

export interface EtapeChaine {
  etape: string;
  detail: string | null;
  etat: EtatEtape;
}

/** Une pièce attendue ou jointe — `documentId` posé quand elle s'ouvre en aperçu, `fichier` (son nom) dit comment la rendre. */
export interface PieceDecision {
  nom: string;
  present: boolean;
  documentId: string | null;
  fichier?: string | null;
}

/** Un jalon du montant, du devis à ce qu'on paie — `ecart` : il dépasse ce qui a été accordé avant lui. */
export interface MontantJalon {
  libelle: string;
  valeur: number;
  ecart: boolean;
}

export type BudgetDecision =
  /** Imputé à une ligne : ce qui reste disponible avant et après ce paiement. */
  | { etat: "IMPUTE"; ligne: string; avant: number; apres: number }
  /** Ne relève d'aucune enveloppe (paie, remise de caisse) — la phrase dit pourquoi. */
  | { etat: "HORS_ENVELOPPE"; phrase: string }
  /** Aucune catégorie trouvée : il s'imputera au règlement. */
  | { etat: "NON_IMPUTE" }
  /** La lecture du budget a échoué : on le dit au lieu d'inventer un chiffre. */
  | { etat: "INCONNU" };

export interface MessageDuFil {
  id: string;
  auteur: string | null;
  decision: string | null;
  texte: string;
  le: string;
}

export interface PieceReclamee {
  id: string;
  libelle: string;
  a: string | null;
  deposee: boolean;
}

/** Tout ce que la fiche affiche pour UN ordre en attente — forme sérialisable, rien à recalculer à l'écran. */
export interface ContexteDecision {
  id: string;
  /** La référence de l'ordre, suivie de celle de sa demande d'origine (« OD-2026-412 · SPO-2026-041 »). */
  reference: string;
  /** L'origine en clair (« Ad & Pro · poste agence », « Demande de paiement », « Paie »…). */
  origine: string;
  objet: string;
  beneficiaire: string | null;
  /** « 1er paiement à ce bénéficiaire » / « 4 paiements en 2026, 1,6 M DZD, dernier le 12 oct. ». */
  historique: string | null;
  montant: number;
  /** L'échéance demandée (ISO) — et si elle est FIXE (engagée auprès du bénéficiaire). */
  echeance: string | null;
  echeanceFixe: boolean;
  demandeur: string | null;
  /** La date de la demande (ISO). */
  demandeLe: string;
  alertes: AlerteDecision[];
  chaine: EtapeChaine[];
  pieces: PieceDecision[];
  montants: MontantJalon[];
  /** La ligne budgétaire lue (« Marketing › Événements ») — `null` hors budget. */
  budget: BudgetDecision;
  /** Ce qui a déjà été payé sur la même demande — une phrase, toujours dite. */
  dejaPaye: string;
  /** L'état au centre (une décision locale le fait bouger à l'écran). */
  centralStatus: string;
  /** Qui regarde a demandé ce paiement. */
  estLeDemandeur: boolean;
  /** Le refus de la séparation des tâches, dit AVANT le clic — `null` : on peut autoriser. */
  refusAutoriser: string | null;
  /** Le dossier compagnon (pièces, fil, « demander une pièce ») et la fiche d'origine. */
  dossierHref: string | null;
  origineHref: string | null;
  fil: MessageDuFil[];
  piecesReclamees: PieceReclamee[];
  /** Le commentaire écrit par le demandeur avec sa demande. */
  note: string | null;
}

// ─────────────────────────────── L'ordre de la file ───────────────────────────────

const JOUR = 86_400_000;
/** Une échéance FIXE à moins d'une semaine passe devant tout le reste. */
const ECHEANCE_PROCHE_JOURS = 7;

interface OrdreATrier {
  id: string;
  montant: number;
  echeance: string | Date | null;
  echeanceFixe: boolean;
  demandeLe: string | Date;
}

const t = (d: string | Date): number => (typeof d === "string" ? new Date(d) : d).getTime();

/**
 * L'ORDRE DE LA FILE « À décider » : d'abord les échéances FIXES proches (ou dépassées), la plus
 * proche en tête — les rater a un coût que le bénéficiaire facture ; puis les montants élevés
 * (`isHighValue`, le seuil d'autrefois devenu repère) ; puis le reste. Dans chaque groupe, le plus
 * ancien d'abord : une demande ne doit pas reculer parce que d'autres arrivent derrière elle.
 */
export function trierFile<T extends OrdreATrier>(ordres: readonly T[], maintenant: Date = new Date()): T[] {
  const groupe = (o: T): number => {
    if (o.echeanceFixe && o.echeance && t(o.echeance) - maintenant.getTime() <= ECHEANCE_PROCHE_JOURS * JOUR) return 0;
    if (isHighValue(o.montant)) return 1;
    return 2;
  };
  return [...ordres].sort((a, b) => {
    const ga = groupe(a);
    const gb = groupe(b);
    if (ga !== gb) return ga - gb;
    if (ga === 0) return t(a.echeance!) - t(b.echeance!);
    return t(a.demandeLe) - t(b.demandeLe);
  });
}

// ─────────────────────────────── L'historique du bénéficiaire ───────────────────────────────

const MOIS_COURTS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/** « 1,6 M DZD », « 450 000 DZD » — une somme qui se lit d'un coup d'œil. */
export function montantCourt(n: number): string {
  if (Math.abs(n) >= 1_000_000) {
    return `${(Math.round(n / 100_000) / 10).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M DZD`;
  }
  return `${Math.round(n).toLocaleString("fr-FR")} DZD`;
}

export const PREMIER_PAIEMENT = "1er paiement à ce bénéficiaire";

/**
 * L'HISTORIQUE D'UN BÉNÉFICIAIRE, en une phrase : les paiements des douze derniers mois (combien,
 * pour combien, le dernier quand). Aucun : « 1er paiement à ce bénéficiaire » — c'est précisément
 * le cas qu'un siège doit remarquer.
 */
export function phraseHistorique(p: { nombre: number; total: number; dernier: string | Date | null }): string {
  if (p.nombre === 0) return PREMIER_PAIEMENT;
  const dernier = p.dernier ? new Date(p.dernier) : null;
  const quand = dernier ? `, dernier le ${dernier.getDate()} ${MOIS_COURTS[dernier.getMonth()]}` : "";
  return `${p.nombre} paiement${p.nombre > 1 ? "s" : ""} en 12 mois, ${montantCourt(p.total)}${quand}`;
}

// ─────────────────────────────── Les montants, du début à la fin ───────────────────────────────

/** La marge tolérée au-dessus d'un BC (une facture peut porter un arrondi, des frais annexes). */
const MARGE_BC = 0.1;
/** Un écart de moins d'un dinar n'en est pas un. */
const TOLERANCE_DZD = 1;

export interface JalonLu {
  libelle: string;
  valeur: number | null;
  /** Le jalon PLAFONNE ce qui suit : un BC, un montant accordé, un visa. Un devis ou une facture, non. */
  plafond?: "BC" | "ACCORDE" | "VISA";
  /** Pour la phrase d'alerte : « BC n°BC-2026-118 signé ». */
  nomme?: string;
}

const pourcent = (x: number): string => `${x > 0 ? "+" : ""}${(Math.round(x * 1000) / 10).toLocaleString("fr-FR")} %`;

/**
 * LES JALONS DU MONTANT et les alertes qu'ils portent : le montant À PAYER est confronté à chaque
 * plafond posé avant lui (le BC, avec sa marge de 10 % ; le montant accordé ; le visa). Ce qui
 * dépasse est marqué en rouge, sur le jalon ET dans les alertes — avec les deux chiffres.
 */
export function montantsEtEcarts(aPayer: number, jalons: readonly JalonLu[]): { montants: MontantJalon[]; alertes: AlerteDecision[] } {
  const montants: MontantJalon[] = [];
  const alertes: AlerteDecision[] = [];
  let depasse = false;
  for (const j of jalons) {
    if (j.valeur == null || !Number.isFinite(j.valeur)) continue;
    montants.push({ libelle: j.libelle, valeur: j.valeur, ecart: false });
    if (!j.plafond) continue;
    const marge = j.plafond === "BC" ? MARGE_BC : 0;
    const limite = j.valeur * (1 + marge) + TOLERANCE_DZD;
    if (aPayer > limite) {
      depasse = true;
      const titre = j.plafond === "BC" ? "Montant au-dessus du BC" : j.plafond === "VISA" ? "Montant au-dessus du visa" : "Montant au-dessus de l'accordé";
      const ecartPct = j.valeur > 0 ? ` (${pourcent((aPayer - j.valeur) / j.valeur)})` : "";
      const au = j.plafond === "BC" ? " : au-delà de la marge de 10 %" : "";
      alertes.push({
        titre,
        detail: `${j.nomme ?? j.libelle} : ${Math.round(j.valeur).toLocaleString("fr-FR")} DZD ; à payer ${Math.round(aPayer).toLocaleString("fr-FR")}${ecartPct}${au}`,
        niveau: "BLOQUANT",
      });
    }
  }
  // « À payer » ferme toujours la frise, en rouge quand il dépasse un plafond.
  if (montants.length > 0) montants.push({ libelle: "À payer", valeur: aPayer, ecart: depasse });
  // La facture qui dépasse le BC se lit aussi en rouge : c'est elle qui porte l'écart.
  if (depasse) for (const m of montants) if (m.libelle.startsWith("Facture") && m.valeur > aPayer - TOLERANCE_DZD) m.ecart = true;
  return { montants, alertes };
}

// ─────────────────────────────── Le budget, avant et après ───────────────────────────────

/**
 * LE DISPONIBLE D'UNE LIGNE, avant et après ce paiement. L'ordre en attente est DÉJÀ compté dans
 * l'engagé (un ordre émis engage sa ligne dès sa naissance, `budget/engage.ts`) : le disponible
 * d'aujourd'hui est donc celui d'APRÈS ; celui d'avant le rend.
 */
export function budgetAvantApres(a: { alloue: number; consomme: number; engage: number; montant: number }): { avant: number; apres: number } {
  const apres = Math.round((a.alloue - a.consomme - a.engage) * 100) / 100;
  return { avant: Math.round((apres + a.montant) * 100) / 100, apres };
}

/** La phrase du budget telle que la fiche l'affiche. */
export function phraseBudget(b: BudgetDecision): string {
  switch (b.etat) {
    case "IMPUTE": return `Disponible ${montantCourt(b.avant)} → ${montantCourt(b.apres)} après ce paiement`;
    case "HORS_ENVELOPPE": return b.phrase;
    case "NON_IMPUTE": return "Non imputé — la catégorie se choisira au règlement";
    default: return "Budget non lu pour le moment";
  }
}

/** L'alerte « budget dépassé » : la ligne passe sous zéro avec ce paiement. */
export function alerteBudget(b: BudgetDecision): AlerteDecision | null {
  if (b.etat !== "IMPUTE" || b.apres >= 0) return null;
  return {
    titre: "Budget dépassé",
    detail: `${b.ligne} : disponible ${montantCourt(b.avant)} avant ce paiement, ${montantCourt(b.apres)} après`,
    niveau: "BLOQUANT",
  };
}

/** L'alerte « trésorerie insuffisante » : ce qui reste en banque après les paiements déjà autorisés ne couvre pas celui-ci. */
export function alerteTresorerie(montant: number, disponible: number | null): AlerteDecision | null {
  if (disponible == null || !Number.isFinite(disponible) || montant <= disponible) return null;
  return {
    titre: "Trésorerie insuffisante",
    detail: `${montantCourt(Math.max(0, disponible))} disponibles en banque une fois réglés les paiements déjà autorisés`,
    niveau: "BLOQUANT",
  };
}

/** L'alerte courte d'une ligne de la file : les titres, rouges d'abord. */
export function alerteCourte(alertes: readonly AlerteDecision[]): string | null {
  if (alertes.length === 0) return null;
  const rangees = [...alertes].sort((a, b) => (a.niveau === b.niveau ? 0 : a.niveau === "BLOQUANT" ? -1 : 1));
  return rangees.map((a) => a.titre).join(" · ");
}
