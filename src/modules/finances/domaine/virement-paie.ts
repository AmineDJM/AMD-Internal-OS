import type { Prisma } from "@prisma/client";
import { formatMontant } from "@/lib/utils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PAIE PASSE PAR LE CENTRE DE PAIEMENT — un virement par entité et par mois (§118.176).
 *
 * « La paie doit dorénavant passer par le centre de paiement et attendre la validation. Pour la
 * paie, c'est un bouton pour toute la paie avec mention obligatoire de la somme des salaires à
 * virer. (un bouton par entité) » — la Direction, 01/10/2026.
 *
 * ── CE QUI EST DÉCLARÉ, ET CE QUI EST CALCULÉ ───────────────────────────────────────────────
 *
 * La SOMME À VIRER est DÉCLARÉE par les RH : c'est elle que le centre autorise et que les Finances
 * virent, et c'est elle — une seule écriture — qui entre au livre. La somme des nets des salaires
 * saisis est CALCULÉE et montrée À CÔTÉ, jamais pré-remplie : une valeur par défaut serait une
 * décision prise à la place de celle qui déclare (§118.108), et le champ « obligatoire » ne le
 * serait plus que de nom. L'écart se DIT, il ne bloque pas : une prime, un rappel, une retenue
 * l'expliquent légitimement, et le code ne sait pas lesquels.
 *
 * ── L'ÉTAT D'UN VIREMENT SE LIT SUR SON ORDRE — sauf le fait d'avoir été viré ───────────────
 *
 * Le centre et les Finances écrivent sur l'ORDRE DE DÉPENSE : c'est lui qui dit « en attente »,
 * « autorisé », « refusé ». Recopier cet état sur le virement en ferait une seconde vérité qui
 * prendrait du retard (§118.5). Une seule chose est gardée sur le virement lui-même : le FAIT du
 * virement (`paidAt`), parce que l'historique des règlements se purge — et qu'une paie virée dont
 * l'ordre a disparu redeviendrait « à envoyer », donc partirait deux fois.
 *
 * ── UN SALAIRE EST « VIRÉ » PAR LA LIGNE, PAS PAR LE MOIS ───────────────────────────────────
 *
 * L'envoi pose son virement sur les salaires saisis À CE MOMENT-LÀ : c'est d'eux que la somme
 * déclarée parle. Un salaire saisi après n'est pas couvert — il part dans un COMPLÉMENT. Dire le
 * mois entier « viré » dès qu'un virement est réglé annoncerait payé un salaire que personne
 * n'a compté dans la somme, et le salarié recevrait « votre salaire a été versé » pour de l'argent
 * qui n'est jamais parti.
 *
 * Module PUR — testé, sans base de données (le type Prisma s'efface à la compilation).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Où en est un virement — lu sur son ordre de dépense. */
export type EtatVirement = "EN_ATTENTE" | "A_VIRER" | "VIRE" | "REFUSE" | "ANNULE";

export interface VirementBrut {
  /** Le fait du virement, posé au règlement de l'ordre. */
  paidAt: Date | string | null;
  /** L'ordre de dépense — `null` s'il a disparu (purgé de l'historique, ou jamais créé). */
  ordre: { status: string; centralStatus: string } | null;
}

/**
 * L'ÉTAT D'UN VIREMENT.
 *
 * Un ordre RÉGLÉ dont le virement n'a pas encore son `paidAt` (le crochet du règlement a échoué)
 * est quand même VIRÉ : l'argent est parti, et le croire « à virer » le ferait renvoyer. Un ordre
 * DISPARU sans règlement n'a rien payé : le virement est annulé, ses salaires repartent.
 *
 * Le centre ne rend que deux décisions — autoriser, refuser (`payment-centre-actions.ts`) : la
 * révision du montant et l'argumentation en ont été retirées, et aucun ordre de paie ne peut donc
 * attendre une réponse des RH. Pas d'état pour un chemin qui n'existe pas.
 */
export function etatVirement(v: VirementBrut): EtatVirement {
  if (v.paidAt) return "VIRE";
  const o = v.ordre;
  if (!o) return "ANNULE";
  if (o.status === "PAID") return "VIRE";
  if (o.status === "CANCELLED") return "ANNULE";
  if (o.centralStatus === "REFUSED") return "REFUSE";
  // `NOT_REQUIRED` est l'état historique des ordres d'avant le centre : il est payable.
  if (o.centralStatus === "APPROVED" || o.centralStatus === "NOT_REQUIRED") return "A_VIRER";
  return "EN_ATTENTE";
}

export const ETAT_VIREMENT_LABEL: Record<EtatVirement, string> = {
  EN_ATTENTE: "en attente du centre de paiement",
  A_VIRER: "autorisée — à virer par les Finances",
  VIRE: "virée",
  REFUSE: "refusée par le centre de paiement",
  ANNULE: "annulée",
};

/** Un virement est-il EN COURS — envoyé, ni réglé ni refusé ? Un seul à la fois par mois. */
export function virementEnCours(etat: EtatVirement): boolean {
  return etat === "EN_ATTENTE" || etat === "A_VIRER";
}

/** Un virement COUVRE-t-il encore ses salaires ? Refusé ou annulé, il les libère. */
export function virementCouvre(etat: EtatVirement): boolean {
  return virementEnCours(etat) || etat === "VIRE";
}

/** Où en est UN salaire du mois. */
export type EtatSalaire = "NON_SAISI" | "SAISI" | "ENVOYE" | "VIRE";

/**
 * SAISI AVANT LE CENTRE ? — avant la bascule, « marquer payé » voulait dire « VERSÉ ».
 *
 * L'ancien circuit prévenait le salarié « votre salaire a été versé » vingt-quatre heures après la
 * saisie : un salaire marqué payé avant que la paie passe par le centre de paiement a été payé —
 * qu'il ait été « transféré au budget » ou non. La première version de cette règle ne regardait que
 * le transfert : tout le reste ressortait « à envoyer » au centre, donc payable une SECONDE fois.
 *
 * La ligne compte par le jour où elle a été marquée payée (à défaut, sa création), comparé à
 * l'instant de la bascule (`AppSetting.payrollCentreSince`, posé une fois par la migration et jamais
 * déplacé). Sans cet instant, on ne déclare rien — une garde qui ne lit pas son fait ne décide pas.
 */
export function saisiAvantLeCentre(
  ligne: { paidDate?: Date | string | null; createdAt?: Date | string | null },
  depuis: Date | string | null | undefined,
): boolean {
  if (!depuis) return false;
  const quand = ligne.paidDate ?? ligne.createdAt;
  if (!quand) return false;
  return new Date(quand).getTime() < new Date(depuis).getTime();
}

/**
 * L'ÉTAT D'UN SALAIRE — lu sur la ligne ET sur son virement, jamais stocké une seconde fois.
 *
 * L'ANCIEN CIRCUIT reste lisible : le « transfert au budget » écrivait le décaissement salarié par
 * salarié (`transactionId`, `budgetTransferredAt`). Ces lignes-là sont virées — les faire repasser
 * « à envoyer » enverrait au centre une paie déjà sortie de la banque.
 */
export function etatSalaire(ligne: {
  status: string;
  budgetTransferredAt?: Date | string | null;
  transactionId?: string | null;
  virement: EtatVirement | null;
  /** Marqué payé avant la bascule (`saisiAvantLeCentre`) : versé par l'ancien circuit. */
  avantLeCentre?: boolean;
}): EtatSalaire {
  if (ligne.status !== "PAID") return "NON_SAISI";
  if (ligne.budgetTransferredAt || ligne.transactionId) return "VIRE";
  if (ligne.virement === "VIRE") return "VIRE";
  if (ligne.virement && virementEnCours(ligne.virement)) return "ENVOYE";
  // L'ANCIEN « MARQUER PAYÉ » : versé avant que la paie passe par le centre — jamais renvoyé.
  if (!ligne.virement && ligne.avantLeCentre) return "VIRE";
  return "SAISI";
}

export type LectureSomme = { ok: true; montant: number } | { ok: false; erreur: string };

/** Le refus d'une somme absente — une seule rédaction, lue par la règle ET par l'action. */
export const SOMME_A_VIRER_MANQUANTE = "Indiquez la somme des salaires à virer : c'est elle que le centre de paiement autorise.";

/**
 * LA SOMME DES SALAIRES À VIRER — obligatoire, positive, et lue sans deviner.
 *
 * Les espaces de milliers (ordinaires, insécables, fines) se retirent ; la virgule décimale se lit.
 * Rien d'autre n'est interprété : « 1,2 M » n'est pas un montant qu'on ose recopier sur un ordre
 * de virement.
 */
export function lireSommeAVirer(brut: string | null | undefined): LectureSomme {
  const t = (brut ?? "").replace(/[\s  ]/g, "").replace(",", ".");
  if (!t) return { ok: false, erreur: SOMME_A_VIRER_MANQUANTE };
  if (!/^\d+(\.\d+)?$/.test(t)) return { ok: false, erreur: "La somme des salaires à virer n'est pas un montant lisible." };
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, erreur: "La somme des salaires à virer doit être positive." };
  return { ok: true, montant: Math.round(n * 100) / 100 };
}

const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** « octobre 2026 » — le mois tel qu'on le dit, sans dépendre d'une locale du serveur. */
export function moisDeLaPaie(year: number, month: number): string {
  return `${MOIS[month - 1] ?? `mois ${month}`} ${year}`;
}

/**
 * « d'octobre 2026 », « de septembre 2026 » — l'élision devant une voyelle (avril, août, octobre).
 * La première rédaction écrivait « la paie de octobre » : juste sur le fond, fausse en français,
 * dans la phrase même que la RH lit après avoir cliqué.
 */
export function deMois(mois: string): string {
  return /^[aeiouyàâäéèêëîïôöùûü]/i.test(mois) ? `d'${mois}` : `de ${mois}`;
}

/** Le libellé de l'ordre — reconnaissable au centre, aux Finances et dans le livre. */
export function libelleVirementPaie(entite: string, year: number, month: number, complement = false): string {
  return `${complement ? "Complément de paie" : "Paie"} ${moisDeLaPaie(year, month)} — ${entite}`;
}

const dzd = (n: number): string => `${formatMontant(n)} DZD`;

/**
 * LA NOTE QUE LE CENTRE LIT — la somme déclarée, et ce que les salaires saisis en disent.
 *
 * Le centre autorise un montant : il doit voir ce qui le justifie sans rouvrir la paie. L'écart
 * est nommé avec son SIGNE — « +4 567 DZD » n'a pas le même sens que « −4 567 DZD ».
 */
export function noteVirementPaie(input: { declare: number; salaires: number; nets: number }): string {
  const { declare, salaires, nets } = input;
  const base = `Somme des salaires à virer déclarée par les RH : ${dzd(declare)} · ${salaires} salaire${salaires > 1 ? "s" : ""} saisi${salaires > 1 ? "s" : ""}, nets ${dzd(nets)}`;
  const ecart = Math.round((declare - nets) * 100) / 100;
  if (ecart === 0) return `${base}.`;
  return `${base} (écart ${ecart > 0 ? "+" : "−"}${dzd(Math.abs(ecart))} avec la somme des nets).`;
}

export interface VirementDuMois {
  id: string;
  reference: string | null;
  montant: number;
  etat: EtatVirement;
  envoyeLe: string;
  vireLe: string | null;
}

export interface MoisDeLEntite {
  /** Salaires saisis que l'envoi suivant couvrira. */
  aEnvoyer: number;
  netsAEnvoyer: number;
  /** Salaires couverts par un virement en cours. */
  envoyes: number;
  /** Salaires virés (ancien circuit compris). */
  vires: number;
  /** Le virement en cours, s'il y en a un. */
  enCours: VirementDuMois | null;
  /** Une partie de la paie du mois est-elle déjà virée ? L'envoi suivant est alors un COMPLÉMENT. */
  complement: boolean;
  /** Pourquoi on ne peut pas envoyer — `null` quand le bouton est ouvert. */
  refus: string | null;
}

/**
 * LE MOIS D'UNE ENTITÉ — ce que la carte affiche, et ce que l'envoi revérifie (une seule règle).
 *
 * Deux refus seulement, et chacun nomme sa suite : un envoi attend déjà (un seul à la fois — deux
 * virements en vol pour la même paie se paieraient deux fois si le centre disait oui aux deux), ou
 * il n'y a rien à envoyer (rien de saisi, ou tout ce qui est saisi est déjà couvert).
 */
export function moisDeLEntite(input: {
  entite: string;
  year: number;
  month: number;
  salaires: readonly { etat: EtatSalaire; net: number }[];
  virements: readonly VirementDuMois[];
}): MoisDeLEntite {
  const saisis = input.salaires.filter((s) => s.etat === "SAISI");
  const enCours = input.virements.find((v) => virementEnCours(v.etat)) ?? null;
  const vires = input.salaires.filter((s) => s.etat === "VIRE").length;
  const complement = vires > 0 || input.virements.some((v) => v.etat === "VIRE");
  const mois = moisDeLaPaie(input.year, input.month);

  let refus: string | null = null;
  if (enCours) {
    const ref = enCours.reference ? ` (${enCours.reference})` : "";
    refus = enCours.etat === "A_VIRER"
      ? `La paie ${deMois(mois)} de ${input.entite} est autorisée et attend son virement par les Finances${ref} — un seul envoi à la fois.`
      : `La paie ${deMois(mois)} de ${input.entite} attend déjà le centre de paiement${ref} — un seul envoi à la fois.`;
  } else if (saisis.length === 0) {
    refus = complement
      ? `Toute la paie saisie ${deMois(mois)} de ${input.entite} est déjà virée : un complément ne s'envoie que pour des salaires saisis depuis.`
      : `Aucun salaire saisi pour ${mois} chez ${input.entite} : saisissez d'abord les salaires du mois (un clic sur le mois de chaque salarié).`;
  }

  return {
    aEnvoyer: saisis.length,
    netsAEnvoyer: saisis.reduce((a, s) => a + s.net, 0),
    envoyes: input.salaires.filter((s) => s.etat === "ENVOYE").length,
    vires,
    enCours,
    complement,
    refus,
  };
}

/**
 * LES SALAIRES DONT ON PEUT ANNONCER LE VERSEMENT — la requête du planificateur (§118.176).
 *
 * Le salarié recevait « votre salaire a été versé » 24 h après la saisie. Sous la nouvelle règle,
 * la saisie n'est plus un versement : on attend AUSSI que son virement soit réglé — par le fait
 * (`paidAt`) ou, si le crochet du règlement a échoué, par son ordre réglé. L'ancien circuit reste
 * annoncé comme avant : son « transfert au budget » écrivait le décaissement.
 */
export function clauseSalairesVersesANotifier(now: Date, avantLeCentre?: Date | null): Prisma.PayrollEntryWhereInput {
  return {
    status: "PAID",
    employeeNotifiedAt: null,
    employeeNotifyAt: { not: null, lte: now },
    OR: [
      { transactionId: { not: null } },
      { budgetTransferredAt: { not: null } },
      { payrollWire: { is: { paidAt: { not: null } } } },
      { payrollWire: { is: { expenseOrder: { is: { status: "PAID" } } } } },
      // Marqué payé AVANT la bascule : l'ancien circuit l'avait versé, et promettait de le dire.
      // Une saisie des dernières vingt-quatre heures avant le déploiement serait sinon restée
      // muette pour toujours — jamais envoyée au centre, puisqu'elle est déjà virée.
      ...(avantLeCentre
        ? [
            { payrollWireId: null, paidDate: { lt: avantLeCentre } },
            { payrollWireId: null, paidDate: null, createdAt: { lt: avantLeCentre } },
          ]
        : []),
    ],
  };
}
