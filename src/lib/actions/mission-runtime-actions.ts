"use server";

import { requireUser } from "@/lib/session";
import { peutPiloterMissionsAdam, REFUS_MISSIONS_ADAM } from "@/lib/rbac";
import { approbationsEnAttente, decider } from "@/lib/missions/approval/gate";
import { fournirEntree } from "@/lib/missions/events/router";
import { annuler, arreterBloquees, mettreEnPause, mettreEnPauseToutes, reprendre } from "@/lib/missions/runtime/control";
import { vueMission } from "@/lib/missions/view/workspace";
import { avancerMission, replanifierMission } from "@/platform/in-process/missions/runtime";
import { prioriserMission } from "@/platform/in-process/missions/control";
import { appliquerModification, prevoirModification } from "@/platform/in-process/missions/modifier";
import { GENRES_MODIFICATION, type EmpreinteModification, type GenreModification } from "@/lib/missions/horizon/modification";
import { approuver, candidats, modeleFaisantAutorite, LIBELLE_TYPE, type TypeModele } from "@/lib/missions/templates/registry";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA MAIN DE LA PERSONNE SUR SES MISSIONS D'EXÉCUTION (§17-19, §33-40).
 *
 * ── LE TROU QUE CE FICHIER FERME, DIT SANS ENJOLIVER ────────────────────────────────────
 *
 * Le runtime savait DEMANDER un accord, poser une attente humaine, suspendre et reprendre. Rien
 * de tout cela n'était atteignable : `decider` et `fournirEntree` n'avaient aucun appelant hors
 * de leurs propres tests. Autrement dit, une mission qui demandait une autorisation la demandait
 * pour toujours. La notification partait, le lien menait à l'écran, l'écran affichait « attend
 * votre accord » — et il n'existait aucun chemin de code pour donner cet accord.
 *
 * Une capacité que personne ne peut déclencher n'existe pas. Ce fichier est le chemin.
 *
 * ── POURQUOI UN FICHIER À PART DE `mission-actions.ts` ──────────────────────────────────
 *
 * Celui-là porte les missions de COORDINATION — accompagnants, ordres de mission, congrès. Ce
 * sont deux familles qui partagent un mot et rien d'autre : l'une assigne des personnes à un
 * déplacement, l'autre fait tourner un graphe d'étapes durables. Les mélanger dans un fichier
 * aurait donné un module dont le nom ne dit plus ce qu'il fait.
 *
 * ── POURQUOI DES ACTIONS SERVEUR ET NON DES ROUTES ──────────────────────────────────────
 *
 * Parce que l'identité doit venir de la SESSION SERVEUR et de nulle part ailleurs. `requireUser`
 * la lit ; aucun paramètre ne porte d'identifiant de personne, donc aucun appel forgé ne peut en
 * désigner une autre. Le reste du produit fonctionne ainsi ; s'en écarter ici aurait créé le
 * seul endroit où l'on fait autrement, c'est-à-dire le seul endroit qu'on oublie de vérifier.
 *
 * ── RÉSERVÉ AU SUPER ADMIN (décision de la Direction, 09/2026) ───────────────────────────
 *
 * Chaque action commence par `peutPiloterMissionsAdam` — le prédicat UNIQUE de `rbac.ts`, celui
 * que lisent aussi l'écran, le menu, les outils de conversation et le moteur. Avant, la porte
 * était le module WORKSPACE, c'est-à-dire tout le monde ; le cloisonnement par propriétaire
 * (`vueMission`, `ownerId` dans chaque `where`) reste en dessous, parce qu'un Super Admin ne
 * touche pas non plus les missions d'un autre Super Admin par une adresse devinée.
 *
 * ── CE QUI RESTE VRAI DE L'AUTRE CÔTÉ DE LA PORTE ───────────────────────────────────────
 *
 * Donner un accord ne fait RIEN d'autre que lever la garde. Les étapes autorisées repassent
 * ensuite par le moteur, donc par le chemin canonique : droits ERP relus, intent créé, clé
 * d'idempotence, reçu, audit. Une approbation n'est pas un raccourci d'exécution — c'est
 * exactement la propriété qui permet de la donner depuis un téléphone sans y réfléchir.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ResultatMission {
  ok: boolean;
  message: string;
  /** L'état de la mission APRÈS le geste — ce que l'écran réaffiche sans second aller-retour. */
  statut?: string | null;
}

export interface AccordEnAttente {
  id: string;
  missionId: string;
  missionTitle: string;
  summary: string;
  niveau: string;
  etapes: string[];
  depuis: string;
}

const REFUS: ResultatMission = { ok: false, message: REFUS_MISSIONS_ADAM };

/**
 * LES ACCORDS QUE CETTE PERSONNE DOIT DONNER.
 *
 * Ce que la notification annonce et ce que l'écran doit lister. Rendu sans jugement : l'ordre
 * est celui de l'arrivée, parce que le plus ancien est celui qui bloque depuis le plus longtemps.
 */
export async function listerAccordsMission(): Promise<AccordEnAttente[]> {
  const user = await requireUser();
  if (!peutPiloterMissionsAdam(user)) return [];

  const rows = await approbationsEnAttente(user.id);
  return rows.map((a) => ({
    id: a.id,
    missionId: a.missionId,
    missionTitle: a.mission.title,
    summary: a.summary,
    // Le niveau est relu depuis la base ; une valeur inconnue retombe sur NORMAL plutôt que de
    // faire planter l'écran. Afficher « niveau inconnu » n'aide personne à décider.
    niveau: ["CRITICAL", "SENSITIVE", "NORMAL"].includes(a.level) ? a.level : "NORMAL",
    etapes: a.stepKeys,
    depuis: a.createdAt.toISOString(),
  }));
}

/**
 * DONNE — OU REFUSE — UN ACCORD, PUIS FAIT REPARTIR LA MISSION.
 *
 * L'avancement immédiat n'est pas un confort : sans lui, la mission attendrait le prochain
 * battement, c'est-à-dire jusqu'à une minute pendant laquelle la personne qui vient de cliquer
 * verrait « attend votre accord » alors qu'elle vient de le donner. Le battement reste le
 * filet — si cet appel-ci échoue, il repassera.
 */
export async function deciderAccordMission(
  approvalId: string,
  decision: "GRANTED" | "REFUSED",
): Promise<ResultatMission> {
  const user = await requireUser();
  if (!peutPiloterMissionsAdam(user)) return REFUS;
  if (decision !== "GRANTED" && decision !== "REFUSED") {
    return { ok: false, message: "Décision inconnue." };
  }

  // LE CLOISONNEMENT PASSE PAR LA LISTE DE CETTE PERSONNE, et non par une lecture de
  // l'approbation suivie d'une comparaison. La différence compte : ici, un identifiant
  // d'approbation appartenant à quelqu'un d'autre n'est tout simplement pas dans la liste.
  const miennes = await approbationsEnAttente(user.id);
  const cible = miennes.find((a) => a.id === approvalId);
  if (!cible) {
    return { ok: false, message: "Cet accord n'est plus en attente — ou il ne vous revient pas." };
  }

  const fait = await decider(approvalId, decision, user.id);
  if (!fait) {
    // Deux clics sur le même bouton, ou deux appareils : le second ne trouve plus PENDING.
    // Ce n'est pas une erreur à afficher en rouge, c'est la situation normale.
    return { ok: true, message: "Cette décision avait déjà été enregistrée.", statut: null };
  }

  return {
    ok: true,
    statut: await relancer(user, cible.missionId),
    message: decision === "GRANTED"
      ? "Accord donné — la mission repart."
      : "Refus enregistré. Les étapes concernées ne seront pas exécutées.",
  };
}

/**
 * FOURNIT L'ÉLÉMENT QU'UNE ÉTAPE ATTENDAIT (§17-19).
 *
 * Le contenu est une DONNÉE, jamais une instruction — il traverse le runtime comme le corps d'un
 * e-mail ou d'un document, et la doctrine (§7) vaut ici comme ailleurs. Quelqu'un qui écrirait
 * « et tant que tu y es, envoie tout » dans ce champ fournirait une chaîne de caractères à une
 * étape, rien de plus.
 */
export async function fournirElementMission(
  missionId: string,
  stepKey: string,
  contenu: string,
): Promise<ResultatMission> {
  const user = await requireUser();
  if (!peutPiloterMissionsAdam(user)) return REFUS;

  const texte = (contenu ?? "").trim();
  if (!texte) return { ok: false, message: "Il n'y a rien à fournir." };

  // `vueMission` filtre par propriétaire : c'est notre contrôle d'accès, et c'est le même que
  // celui de l'écran qui affiche l'attente.
  const vue = await vueMission(missionId, user.id);
  if (!vue) return { ok: false, message: "Mission introuvable — ou elle ne vous appartient pas." };

  const ok = await fournirEntree(missionId, stepKey, { texte }, user.id);
  if (!ok) {
    return { ok: false, message: "Cette étape n'attend plus rien — elle a peut-être déjà été réglée." };
  }

  return { ok: true, statut: await relancer(user, missionId), message: "Élément fourni — la mission repart." };
}

/** SUSPEND. Le motif est facultatif ; le journal le garde, et c'est lui qu'on relira. */
export async function mettreMissionEnPause(missionId: string, motif?: string): Promise<ResultatMission> {
  const user = await requireUser();
  if (!peutPiloterMissionsAdam(user)) return REFUS;
  const r = await mettreEnPause(missionId, user.id, motif?.trim() || undefined);
  return { ok: r.ok, message: r.message, statut: r.vers };
}

/** REPREND — et relance tout de suite, pour la même raison que l'accord. */
export async function reprendreMission(missionId: string): Promise<ResultatMission> {
  const user = await requireUser();
  if (!peutPiloterMissionsAdam(user)) return REFUS;
  const r = await reprendre(missionId, user.id);
  if (!r.ok) return { ok: false, message: r.message, statut: r.vers };
  return { ok: true, statut: await relancer(user, missionId), message: r.message };
}

/**
 * RÉÉCRIT LE PLAN D'UNE MISSION QUI N'ABOUTIT PLUS (§39-40).
 *
 * Le battement le fait déjà tout seul sur une mission en échec ; ce bouton-ci sert quand la
 * personne, elle, sait que le contexte a changé — un droit rendu, un service revenu, un
 * destinataire corrigé — et ne veut pas attendre le prochain passage.
 *
 * Rien de ce que le nouveau plan ajoute ne s'exécute sans son accord : `reouvrirSiChange`
 * rouvre la partie non couverte, et elle seule.
 */
export async function replanifierMissionAction(missionId: string): Promise<ResultatMission> {
  const user = await requireUser();
  if (!peutPiloterMissionsAdam(user)) return REFUS;
  const r = await replanifierMission(user, missionId);
  if (!r.replanifie) return { ok: false, message: r.raison };
  return { ok: true, statut: await relancer(user, missionId), message: r.raison };
}

/**
 * CHANGE LA PRIORITÉ (« celle-ci passe devant »).
 *
 * Le battement sert les priorités hautes d'abord, l'ancienneté ensuite : relever une mission ne
 * fait mourir de faim aucune autre. Le geste ne fait RIEN sortir et ne franchit aucun droit —
 * c'est un ordre de passage, pas une autorisation.
 */
export async function changerPrioriteMission(
  missionId: string,
  priorite: number,
): Promise<ResultatMission> {
  const user = await requireUser();
  if (!peutPiloterMissionsAdam(user)) return REFUS;
  if (!Number.isFinite(priorite)) return { ok: false, message: "Priorité illisible." };
  const r = await prioriserMission(user, missionId, priorite);
  return { ok: r.fait, message: r.message, statut: r.statut };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODIFIER UNE MISSION EN COURS — en DEUX temps, et c'est le sujet (§118.48).
 *
 * ── POURQUOI L'APERÇU EST UNE ACTION À PART ─────────────────────────────────────────────
 *
 * « Finalement Amel à la place de Deepak » a une EMPREINTE : des étapes visées, leur
 * descendance à réécrire, des jalons rouverts, ce qui est PRÉSERVÉ, et ce qui est DÉJÀ PARTI
 * et ne sera donc pas rejoué. Appliquer d'abord et raconter ensuite demanderait à la personne
 * de faire confiance à un résumé écrit après coup ; ici elle lit l'empreinte AVANT, et c'est
 * elle qui décide si le périmètre est le bon.
 *
 * `prevoirModification` n'écrit RIEN — c'est ce qui rend l'aperçu sûr à appeler aussi souvent
 * qu'on reformule sa phrase.
 *
 * ── CE QUE L'APERÇU NE DEVINE PAS ───────────────────────────────────────────────────────
 *
 * Une cible reconnue nulle part ne touche à RIEN, et le dit. Deviner choisirait la branche à
 * jeter à la place d'un humain — sur une mission qui a déjà envoyé des demandes à trois
 * personnes, se tromper de branche coûte ces trois demandes.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface DemandeModificationEcran {
  genre: GenreModification;
  cible: string;
  remplacant?: string | null;
  ajout?: string | null;
  motif?: string | null;
}

export interface ApercuModification {
  ok: boolean;
  message: string;
  empreinte: EmpreinteModification | null;
}

export async function prevoirModificationMission(
  missionId: string,
  demande: DemandeModificationEcran,
): Promise<ApercuModification> {
  const user = await requireUser();
  if (!peutPiloterMissionsAdam(user)) return { ok: false, message: REFUS.message, empreinte: null };
  if (!GENRES_MODIFICATION.includes(demande.genre)) {
    return { ok: false, message: "Modification inconnue.", empreinte: null };
  }

  const empreinte = await prevoirModification(user, missionId, {
    genre: demande.genre,
    cible: (demande.cible ?? "").trim(),
    remplacant: demande.remplacant?.trim() || null,
    ajout: demande.ajout?.trim() || null,
    motif: demande.motif?.trim() || null,
  });
  if (!empreinte) {
    return { ok: false, message: "Mission introuvable — ou elle ne vous appartient pas.", empreinte: null };
  }
  return { ok: empreinte.reconnue, message: empreinte.resume, empreinte };
}

/**
 * APPLIQUE la modification — le geste qui écrit, après l'aperçu.
 *
 * Ce qui est déjà PARTI n'est jamais rejoué : `appliquerModification` le nomme et l'exclut. Une
 * modification est aussi une information NEUVE, donc elle rouvre le droit de replanifier
 * (§118.42) : une mission qu'un refus répété avait close repart quand on lui donne autre chose.
 */
export async function appliquerModificationMission(
  missionId: string,
  demande: DemandeModificationEcran,
): Promise<ResultatMission & { empreinte: EmpreinteModification | null }> {
  const user = await requireUser();
  if (!peutPiloterMissionsAdam(user)) return { ...REFUS, empreinte: null };
  if (!GENRES_MODIFICATION.includes(demande.genre)) {
    return { ok: false, message: "Modification inconnue.", empreinte: null };
  }

  const r = await appliquerModification(user, missionId, {
    genre: demande.genre,
    cible: (demande.cible ?? "").trim(),
    remplacant: demande.remplacant?.trim() || null,
    ajout: demande.ajout?.trim() || null,
    motif: demande.motif?.trim() || null,
  });
  if (!r.fait) return { ok: false, message: r.message, empreinte: r.empreinte };

  return {
    ok: true,
    message: r.message,
    empreinte: r.empreinte,
    statut: await relancer(user, missionId),
  };
}

/** ARRÊTE. Ce qui a déjà été fait reste fait — la fonction sous-jacente le dit aussi. */
export async function arreterMission(missionId: string, motif?: string): Promise<ResultatMission> {
  const user = await requireUser();
  if (!peutPiloterMissionsAdam(user)) return REFUS;
  const r = await annuler(missionId, user.id, motif?.trim() || undefined);
  return { ok: r.ok, message: r.message, statut: r.vers };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES GESTES DE MASSE (§118.132) — suspendre tout ce qui tourne, arrêter tout ce qui est bloqué.
 *
 * Deux boutons du Centre de missions, et le confort du bouton seulement : chacun rejoue
 * `mettreEnPause` ou `annuler` sur chaque mission de la personne, donc le même cloisonnement
 * (`ownerId` dans le `where`), le même journal, les mêmes refus de la machine à états. Le
 * nombre annoncé sur le bouton et le nombre touché viennent du MÊME prédicat
 * (`runtime/control.ts`). Ni l'un ni l'autre ne pose l'interrupteur global, qui est un geste de
 * direction et vit dans les réglages d'Adam.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface ResultatMasse {
  ok: boolean;
  message: string;
  visees: number;
  faites: number;
}

const phraseDeMasse = (
  r: { visees: number; faites: number; deja: number; refusees: { message: string }[] },
  verbe: { fait: string; deja: string; rien: string; suite: string },
): string => {
  if (r.visees === 0) return verbe.rien;
  const parts = [`${r.faites} mission(s) ${verbe.fait}`];
  if (r.deja > 0) parts.push(`${r.deja} ${verbe.deja}`);
  if (r.refusees.length > 0) parts.push(`${r.refusees.length} refusée(s) : ${r.refusees[0]!.message}`);
  return `${parts.join(", ")}. ${verbe.suite}`;
};

/** SUSPEND toutes les missions vivantes de la personne. Réversible, mission par mission. */
export async function suspendreToutesMesMissions(motif?: string): Promise<ResultatMasse> {
  const user = await requireUser();
  if (!peutPiloterMissionsAdam(user)) return { ...REFUS, visees: 0, faites: 0 };
  const r = await mettreEnPauseToutes(user.id, motif?.trim() || "suspension de toutes les missions depuis le Centre de missions");
  return {
    ok: true, visees: r.visees, faites: r.faites,
    message: phraseDeMasse(r, {
      fait: "suspendue(s)", deja: "l'étai(en)t déjà",
      rien: "Aucune mission à suspendre.",
      suite: "Elles repartiront où elles en étaient quand vous les reprendrez, une par une.",
    }),
  };
}

/** ARRÊTE définitivement les missions bloquées ou en échec de la personne. */
export async function arreterMesMissionsBloquees(motif?: string): Promise<ResultatMasse> {
  const user = await requireUser();
  if (!peutPiloterMissionsAdam(user)) return { ...REFUS, visees: 0, faites: 0 };
  const r = await arreterBloquees(user.id, motif?.trim() || "arrêt des missions bloquées ou en échec depuis le Centre de missions");
  return {
    ok: true, visees: r.visees, faites: r.faites,
    message: phraseDeMasse(r, {
      fait: "arrêtée(s)", deja: "l'étai(en)t déjà",
      rien: "Aucune mission bloquée ou en échec à arrêter.",
      suite: "Ce qui avait déjà été fait reste fait — rien n'est défait.",
    }),
  };
}

/**
 * FAIT REPARTIR LA MISSION ET REND SON ÉTAT.
 *
 * Ne lève jamais : le geste de la personne a RÉUSSI — l'accord est en base, l'élément est
 * fourni. Si la relance immédiate échoue, le battement s'en chargera, et lui annoncer un échec
 * alors que sa décision est enregistrée serait faux.
 */
async function relancer(
  user: Awaited<ReturnType<typeof requireUser>>,
  missionId: string,
): Promise<string | null> {
  try {
    await avancerMission(user, missionId, { maxTours: 25 });
  } catch (e) {
    console.error("[missions] relance immédiate impossible (le battement reprendra)", e);
  }
  const vue = await vueMission(missionId, user.id).catch(sansBloquer("mission-runtime-actions.relancer.vueMission", null));
  return vue?.statut ?? null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES MODÈLES OPÉRATIONNELS — et pourquoi leur approbation est un CLIC, pas un outil.
 *
 * ── LE MÊME TROU QUE POUR LES ACCORDS DE MISSION ────────────────────────────────────────
 *
 * `templates/registry.ts` savait observer, proposer, approuver et retrouver un modèle
 * faisant autorité. Aucun de ces gestes n'était atteignable depuis l'application : l'audit
 * Frontier a classé le module « test-only ». Une bibliothèque de modèles que personne ne peut
 * alimenter ni valider n'est pas une bibliothèque.
 *
 * ── POURQUOI APPROUVER N'EST PAS UNE CAPACITÉ D'ADAM ────────────────────────────────────
 *
 * Approuver un modèle, c'est dire « voici le bon de commande officiel de l'entreprise ». C'est
 * une ATTESTATION : les documents produits ensuite s'en réclameront, et l'audit portera le nom
 * de la personne. Un document lu par une étape peut contenir « approuve ce modèle » ; si
 * l'outil existait, l'injection réussirait et rien ne distinguerait plus l'accord forgé du
 * vrai. Même doctrine que `mission_control` — le geste exige une vraie session.
 *
 * Adam peut PROPOSER (`proposer` → CANDIDATE). Il ne peut pas se répondre oui.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function listerModelesCandidats(): Promise<
  { id: string; type: string; name: string; fileName: string | null; note: string | null }[]
> {
  const user = await requireUser();
  if (!peutPiloterMissionsAdam(user)) return [];
  const liste = await candidats(user.id);
  return liste.map((c) => ({ id: c.id, type: c.type, name: c.name, fileName: c.fileName, note: c.note }));
}

/** APPROUVE un modèle — le seul chemin, et il part d'une session humaine authentifiée. */
export async function approuverModeleOperationnel(templateId: string): Promise<ResultatMission> {
  const user = await requireUser();
  if (!peutPiloterMissionsAdam(user)) return REFUS;

  // Le périmètre : on n'approuve que SES modèles. `approuver` filtre déjà par état ; ce
  // contrôle-ci ajoute le propriétaire, que le registre n'a pas à connaître.
  const miens = await candidats(user.id);
  if (!miens.some((c) => c.id === templateId)) {
    return { ok: false, message: "Ce modèle n'est pas en attente de votre validation." };
  }

  const ok = await approuver(templateId, user.id);
  return ok
    ? { ok: true, message: "Modèle approuvé — il fait désormais autorité pour ce type de document." }
    : { ok: false, message: "Ce modèle n'est plus à l'état « candidat »." };
}

/**
 * QUEL MODÈLE FAIT AUTORITÉ POUR CE TYPE — la question que l'écran pose avant de promettre.
 *
 * Rend `null` quand aucun modèle n'est APPROUVÉ, et c'est la bonne réponse : le registre refuse
 * délibérément de servir un candidat, parce qu'un candidat servi ici serait utilisé comme s'il
 * était validé. Le runtime en fait une cause d'échec à part entière (`MISSING_TEMPLATE`), avec
 * son échelle de recours — plutôt qu'un modèle inventé.
 */
export async function modeleOfficiel(
  type: string,
): Promise<{ id: string; name: string; fileName: string | null; libelle: string } | null> {
  const user = await requireUser();
  if (!peutPiloterMissionsAdam(user)) return null;
  const m = await modeleFaisantAutorite(user.id, type as TypeModele);
  if (!m) return null;
  return { id: m.id, name: m.name, fileName: m.fileName, libelle: LIBELLE_TYPE[type as TypeModele] ?? type };
}
