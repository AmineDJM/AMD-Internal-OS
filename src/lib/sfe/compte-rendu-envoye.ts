/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * APRÈS L'ENVOI D'UN COMPTE RENDU — ce que le délégué lit (interface du délégué, maquette VALIDÉE le 24/11/2026).
 *
 * Le compte rendu envoyé n'est pas un trou noir : le délégué voit ce qu'il a envoyé, ce que l'IA y a lu (le possible cas
 * de pharmacovigilance, avec la PHRASE relevée), puis la relecture de son superviseur. Ici, les règles d'AFFICHAGE et la
 * règle du geste « Ce n'est pas un cas », lues aussi par l'action serveur — une seule écriture de chaque règle.
 *
 * Et les comptes rendus EN RETARD de « Ma journée » : la fenêtre de 48 h est la règle (`fenetreRapport`), ce module ne
 * fait que ranger ce qu'elle a déjà tranché.
 *
 * Module PUR — aucune importation de valeur : le navigateur, le serveur et les tests le lisent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { EtatVisite } from "@/lib/sfe/tournee";

/** Ce que la base sait de la lecture d'un compte rendu par l'IA, et de ce qui en a suivi. */
export interface LectureDuCompteRendu {
  /** `AUCUN` | `POSSIBLE` | `PROBABLE` ; nul = pas encore lu (IA en file, coupée ou en échec). */
  pvIa: string | null;
  /** La phrase EXACTE relevée dans le texte. */
  extrait: string | null;
  /** ISO — la dernière lecture. */
  analyseLe: string | null;
  /** Le cas de pharmacovigilance signalé depuis cette visite, s'il y en a un. */
  cas: { id: string; reference: string | null } | null;
  /** ISO — « Ce n'est pas un cas » dit par le délégué. */
  ecarteLe: string | null;
  /** La relecture du superviseur. */
  relu: { le: string; par: string | null; mot: string | null } | null;
}

export type SorteLectureIa = "EN_ATTENTE" | "RIEN" | "ALERTE" | "ECARTE" | "DECLARE";

export interface EtatLectureIa {
  sorte: SorteLectureIa;
  titre: string;
  texte: string;
  /** La phrase relevée — montrée tant qu'aucun cas n'est déclaré. */
  citation: string | null;
  /** Les deux gestes du délégué : « Déclarer un PV (prérempli) » et « Ce n'est pas un cas ». */
  gestes: boolean;
  ton: "neutral" | "danger" | "success" | "warning";
}

const signal = (pv: string | null): boolean => pv === "POSSIBLE" || pv === "PROBABLE";

/**
 * L'ÉTAT DE LA LECTURE PAR L'IA, dans l'ordre où il se tranche :
 *   1. un cas est DÉCLARÉ depuis la visite → c'est lui qui compte, l'alerte s'efface ;
 *   2. pas encore lu → « en attente » (l'IA lit en tâche de fond : cela ne bloque rien) ;
 *   3. lu sans signal → rien à faire ;
 *   4. signal, dit « pas un cas » par le délégué → la réponse est dite, le superviseur tranchera ;
 *   5. signal sans réponse → l'alerte, la citation, les deux gestes.
 */
export function etatLectureIa(l: Pick<LectureDuCompteRendu, "pvIa" | "extrait" | "analyseLe" | "cas" | "ecarteLe">): EtatLectureIa {
  if (l.cas) {
    return {
      sorte: "DECLARE", titre: `Cas déclaré${l.cas.reference ? ` : ${l.cas.reference}` : ""}`,
      texte: "Regulatory est prévenu ; le cas suit son circuit dans « Pharmacovigilance ».",
      citation: null, gestes: false, ton: "success",
    };
  }
  if (!l.analyseLe || l.pvIa === null) {
    return {
      sorte: "EN_ATTENTE", titre: "Lecture par l'IA en attente",
      texte: "Elle cherche un effet indésirable, une erreur ou un défaut de qualité. Cela ne bloque rien.",
      citation: null, gestes: false, ton: "neutral",
    };
  }
  if (!signal(l.pvIa)) {
    return { sorte: "RIEN", titre: "Aucun signe de pharmacovigilance", texte: "Rien à faire.", citation: null, gestes: false, ton: "neutral" };
  }
  if (l.ecarteLe) {
    return {
      sorte: "ECARTE", titre: "Vous avez indiqué : pas un cas",
      texte: "Votre superviseur garde ce rapport en priorité et tranchera à la relecture.",
      citation: l.extrait, gestes: false, ton: "warning",
    };
  }
  return {
    sorte: "ALERTE", titre: l.pvIa === "PROBABLE" ? "Probable cas de pharmacovigilance" : "Possible cas de pharmacovigilance",
    texte: "L'IA a relevé cette phrase. Votre superviseur relira ce rapport en priorité. Un humain confirme toujours.",
    citation: l.extrait, gestes: true, ton: "danger",
  };
}

/** L'alerte attend-elle le délégué ? (la pastille « Possible PV — à déclarer » de « Ma journée »). */
export function alertePvOuverte(l: Pick<LectureDuCompteRendu, "pvIa" | "analyseLe" | "cas" | "ecarteLe">): boolean {
  return etatLectureIa({ ...l, extrait: null }).sorte === "ALERTE";
}

/**
 * « CE N'EST PAS UN CAS » — qui peut le dire, et quand. Le refus dit le remède (§118.30). L'action serveur relit la base
 * et appelle cette règle ; l'écran ne fait qu'offrir le geste à qui la passera.
 */
export function refusEcarterAlertePv(v: {
  delegateId: string | null;
  userId: string;
  pvIa: string | null;
  nbCas: number;
  ecarteLe: Date | string | null;
}): string | null {
  if (v.delegateId !== v.userId) return "Seul le délégué qui a écrit ce compte rendu répond à l'alerte de l'IA.";
  if (v.nbCas > 0) return "Un cas de pharmacovigilance est déjà déclaré depuis cette visite : il suit son circuit chez Regulatory.";
  if (!signal(v.pvIa)) return "L'IA n'a relevé aucun possible cas dans ce compte rendu : il n'y a rien à écarter.";
  if (v.ecarteLe) return "Vous avez déjà indiqué que ce n'est pas un cas : votre superviseur tranchera à la relecture.";
  return null;
}

/** L'état de la relecture du superviseur, en une ligne. */
export function etatRelecture(l: Pick<LectureDuCompteRendu, "relu" | "pvIa" | "cas">): { libelle: string; ton: "success" | "danger" | "warning" } {
  if (l.relu) return { libelle: "Relu", ton: "success" };
  if (signal(l.pvIa) || l.cas) return { libelle: "À relire en priorité", ton: "danger" };
  return { libelle: "En attente de relecture", ton: "warning" };
}

// ─────────────────────────── Les comptes rendus en retard ───────────────────────────

/** Le minimum d'une visite pour le bloc « Comptes rendus en retard ». */
export interface VisiteARapporter {
  id: string;
  /** ISO. */
  date: string;
  etat: EtatVisite;
  heuresRestantes: number;
}

/**
 * LES COMPTES RENDUS EN RETARD — les visites d'un jour PASSÉ :
 *   · encore À FAIRE dans leur fenêtre de 48 h → à écrire, la plus proche de sa limite d'abord ;
 *   · fenêtre FERMÉE sans compte rendu (`PERDUE`) → dites, la plus récente d'abord : elles restent « non rapportées ».
 * `aujourdhui` est le jour local `AAAA-MM-JJ` du serveur (la même horloge que les fenêtres).
 */
export function comptesRendusEnRetard<V extends VisiteARapporter>(visites: readonly V[], aujourdhui: string, jourDe: (iso: string) => string): {
  ouverts: V[];
  fermes: V[];
} {
  const passees = visites.filter((v) => jourDe(v.date) < aujourdhui);
  return {
    ouverts: passees.filter((v) => v.etat === "A_FAIRE" && v.heuresRestantes > 0).sort((a, b) => a.heuresRestantes - b.heuresRestantes),
    fermes: passees.filter((v) => v.etat === "PERDUE").sort((a, b) => b.date.localeCompare(a.date)),
  };
}

/** Le ton du temps restant : rouge sous 6 h, ambre ensuite. */
export function tonDuDelai(heuresRestantes: number): "danger" | "warning" {
  return heuresRestantes <= 6 ? "danger" : "warning";
}
