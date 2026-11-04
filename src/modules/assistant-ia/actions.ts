"use server";

import { porte } from "./infra/porte-actions";
import { requireUser, type CurrentUser } from "@/lib/session";
import { peutUtiliserAssistantIA, REFUS_ASSISTANT_IA } from "@/lib/rbac";
import {
  ajouterMemoire, annulerSouvenir, effacerMemoire, estChargeOperationIA, executerOperationJournalisee, jetonsDeLaMemoire, listerMemoire, lireReglagesAssistantIa, memoireAutoActive,
  adresseDeLaPersonne, modifierMemoire, reglerMemoireAuto, toutEffacerMemoire,
  type ElementMemoire, type PieceDuTour,
} from "@/modules/assistant-ia/api";
import { cancelActionIntent, executerIntention, type ResultatExecution } from "@/platform/ia/intentions/action-intents";
import type { TravailDetail, TravailVue } from "@/lib/missions/travaux/service";
import { actionReversible } from "@/lib/effets/reversible";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA MÉMOIRE PERSONNELLE DE L'ASSISTANT IA — les gestes de la personne sur SA mémoire.
 *
 * Voir, retenir (après une proposition de l'assistant, ou à la main), corriger, effacer, tout
 * effacer. L'identité vient TOUJOURS de la session (`requireUser`) — jamais d'un paramètre : une
 * action serveur peut être appelée hors de l'écran, et un `userId` reçu permettrait d'écrire dans
 * la mémoire d'un collègue (§118.153). Indisponible en « Vue exacte » : on ne modifie pas la
 * mémoire de quelqu'un en se mettant à sa place.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */


export async function listerMaMemoire(): Promise<{ ok: true; elements: ElementMemoire[]; auto: boolean; jetons: number; budget: number; adresse: "TU" | "VOUS" } | { ok: false; erreur: string }> {
  const p = await porte(false);
  if (!p.ok) return p;
  const [elements, auto, jetons, reglages, adresse] = await Promise.all([
    listerMemoire(p.user.id), memoireAutoActive(p.user.id), jetonsDeLaMemoire(p.user.id), lireReglagesAssistantIa(), adresseDeLaPersonne(p.user.id),
  ]);
  return { ok: true, elements, auto, jetons, budget: reglages.memoireJetonsBudget, adresse };
}

/** Retenir — le geste de CONFIRMATION d'une mémoire proposée (`propose`), ou un ajout à la main (`manuel`). */
export async function retenirMemoire(contenu: string, sorte?: string, depuisCarte?: boolean) {
  const p = await porte(true);
  if (!p.ok) return p;
  const r = await ajouterMemoire(p.user.id, contenu, sorte, { origine: depuisCarte === true ? "propose" : "manuel" });
  return r.ok ? { ok: true as const, element: r.element } : { ok: false as const, erreur: r.erreur };
}

export async function corrigerMemoire(id: string, contenu: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (typeof id !== "string" || !id) return { ok: false as const, erreur: "Élément introuvable." };
  const r = await modifierMemoire(p.user.id, id, contenu);
  return r.ok ? { ok: true as const, element: r.element } : { ok: false as const, erreur: r.erreur };
}

export async function effacerElementMemoire(id: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (typeof id !== "string" || !id) return { ok: false as const, erreur: "Élément introuvable." };
  return (await effacerMemoire(p.user.id, id)) ? { ok: true as const } : { ok: false as const, erreur: "Élément introuvable." };
}

export async function effacerToutMaMemoire() {
  const p = await porte(true);
  if (!p.ok) return p;
  return { ok: true as const, effaces: await toutEffacerMemoire(p.user.id) };
}

/** M1 (décision 0045) : « Retenu : … (annuler) » — le souvenir disparaît, l'ancien revient s'il en remplaçait un. */
export async function annulerSouvenirRetenu(id: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (typeof id !== "string" || !id) return { ok: false as const, erreur: "Élément introuvable." };
  const r = await annulerSouvenir(p.user.id, id);
  return r.ok ? { ok: true as const, restaure: r.restaure } : { ok: false as const, erreur: r.erreur };
}

/** M1 : « mémoire automatique : oui / non » — un réglage de la personne (défaut : oui). */
export async function reglerMaMemoireAuto(active: boolean) {
  // Réversible comme tout réglage (décisions 0040-0044) : la valeur d'avant se remet d'un geste.
  return actionReversible("assistant-ia-actions:reglerMaMemoireAuto", "Réglage de la mémoire automatique", async () => {
    const p = await porte(true);
    if (!p.ok) return p;
    await reglerMemoireAuto(p.user.id, active === true);
    return { ok: true as const, auto: active === true };
  });
}

// ─────────────────────────────── Les routines ───────────────────────────────
//
// Les gestes de la personne sur SES routines, depuis l'onglet « Routines » : les voir, lire un
// passage (il passe « lu »), mettre en pause, reprendre, supprimer, exécuter maintenant. La
// création passe par la conversation et sa carte. Identité de la session, jamais d'un paramètre.

export async function listerMesRoutines() {
  const p = await porte(false);
  if (!p.ok) return p;
  const { listerRoutines, passagesNonLus } = await import("@/modules/assistant-ia/api");
  return { ok: true as const, routines: await listerRoutines(p.user.id), nonLus: await passagesNonLus(p.user.id) };
}

export async function lireMonPassage(runId: string) {
  const p = await porte(false);
  if (!p.ok) return p;
  if (typeof runId !== "string" || !runId) return { ok: false as const, erreur: "Passage introuvable." };
  const { lirePassage } = await import("@/modules/assistant-ia/api");
  const passage = await lirePassage(p.user.id, runId);
  return passage ? { ok: true as const, passage: JSON.parse(JSON.stringify(passage)) as typeof passage } : { ok: false as const, erreur: "Passage introuvable." };
}

export async function basculerMaRoutine(id: string, statut: "ACTIVE" | "PAUSED") {
  const p = await porte(true);
  if (!p.ok) return p;
  if (typeof id !== "string" || !id || (statut !== "ACTIVE" && statut !== "PAUSED")) return { ok: false as const, erreur: "Routine introuvable." };
  const { changerStatut } = await import("@/modules/assistant-ia/api");
  const r = await changerStatut(p.user.id, id, statut);
  return r.ok ? { ok: true as const } : { ok: false as const, erreur: r.erreur };
}

export async function supprimerMaRoutine(id: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (typeof id !== "string" || !id) return { ok: false as const, erreur: "Routine introuvable." };
  const { supprimerRoutine } = await import("@/modules/assistant-ia/api");
  return (await supprimerRoutine(p.user.id, id)) ? { ok: true as const } : { ok: false as const, erreur: "Routine introuvable." };
}

export async function executerMaRoutine(id: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (typeof id !== "string" || !id) return { ok: false as const, erreur: "Routine introuvable." };
  const { executerMaintenant } = await import("@/modules/assistant-ia/api");
  const r = await executerMaintenant(p.user.id, id, { attendre: false });
  return r.ok ? { ok: true as const, statut: r.statut, runId: r.runId ?? undefined } : { ok: false as const, erreur: r.erreur };
}

// ─────────────────────────────── La relance (I6, décision 0070) ───────────────────────────────

/**
 * LA RELANCE DU MOTEUR UNIQUE — ce que faisait `assistantNudge` dans l'ancien Adam, désormais un tour de `jouerTour`
 * (même catalogue filtré par le profil d'accès, mêmes gardes). Une carte proposée reste une intention, confirmée par
 * `confirmerIntentionAssistantIA`.
 */
export async function relanceMoteurUnique(signaturePrecedente: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  const { relanceDuMoteur } = await import("@/modules/assistant-ia/api");
  return { ok: true as const, ...(await relanceDuMoteur(p.user, typeof signaturePrecedente === "string" ? signaturePrecedente.slice(0, 120) : "")) };
}

// ─────────────────────────────── Le fil gardé ───────────────────────────────
//
// La conversation de l'Assistant IA vit sur le serveur (`agent/fil/service.ts`) : envoyer DÉPOSE le
// message et lance le fil SANS L'ATTENDRE — la réponse s'écrit en arrière-plan, l'écran la lit
// (`/api/assistant-ia/fil`), et elle est notifiée si la personne est partie. En « Vue exacte », rien
// n'est écrit dans le fil de la personne regardée : l'écran garde l'ancien tour, joué dans la requête.

/**
 * `pieces` : la liste JSON `[{ id, nom }]` des pièces déjà déposées dans le Drive (revérifiées au tour).
 * `conversation` (décision 0027) : la conversation où écrire — sans elle, la conversation courante.
 */
export async function envoyerAuFil(texte: string, pieces?: string, conversation?: string) {
  const user = await requireUser();
  if (!peutUtiliserAssistantIA(user)) return { ok: false as const, erreur: REFUS_ASSISTANT_IA };
  if (user.impersonatedBy || user.visualise) return { ok: false as const, erreur: "Indisponible en « Vue exacte ».", vueExacte: true };
  const { deposerEcrit } = await import("@/modules/assistant-ia/api");
  let liste: unknown = [];
  try { liste = JSON.parse(typeof pieces === "string" && pieces ? pieces : "[]"); } catch { liste = []; }
  const c = typeof conversation === "string" && conversation.length < 64 ? conversation : null;
  // O1 (décision 0046) : la réponse à la question de l'agenda, une autre demande en parallèle d'un travail long, ou la
  // file habituelle. Le tour, joué NON ATTENDU (il peut durer des minutes) : la requête rend la main tout de suite.
  const r = await deposerEcrit(user.id, typeof texte === "string" ? texte : "", Array.isArray(liste) ? (liste as PieceDuTour[]) : [], c);
  if (!r.ok) return { ok: false as const, erreur: r.erreur };
  return { ok: true as const, id: r.tour.id, conversation: r.conversation };
}

export async function repartirDeZero() {
  const p = await porte(true);
  if (!p.ok) return p;
  const { nouvelleConversation } = await import("@/modules/assistant-ia/api");
  return nouvelleConversation(p.user.id);
}

/** S1 (décision 0048) : « tutoiement / vouvoiement » — l'accueil et les réponses de SON assistant (défaut : vous). */
export async function reglerMonAdresse(adresse: "TU" | "VOUS") {
  return actionReversible("assistant-ia-actions:reglerMonAdresse", "Réglage du tutoiement", async () => {
    const p = await porte(true);
    if (!p.ok) return p;
    const { reglerAdresse } = await import("@/modules/assistant-ia/api");
    const a = adresse === "TU" ? "TU" : "VOUS";
    await reglerAdresse(p.user.id, a);
    return { ok: true as const, adresse: a };
  });
}

/** L'option « réponse vocale » : chaque réponse de l'assistant est aussi dite à voix haute (fichier audio du Drive). */
export async function reglerMaReponseVocale(active: boolean) {
  return actionReversible("assistant-ia-actions:reglerMaReponseVocale", "Réglage de la réponse vocale", async () => {
    const p = await porte(true);
    if (!p.ok) return p;
    const { reglerReponseVocale } = await import("@/modules/assistant-ia/api");
    await reglerReponseVocale(p.user.id, active === true);
    return { ok: true as const, active: active === true };
  });
}

/**
 * LA CONFIRMATION DE L'ASSISTANT IA (/assistant) — sa porte à lui, `peutUtiliserAssistantIA`, et
 * JAMAIS de payload reçu : seulement une intention que CE compte a préparée. Deux exécuteurs, tous deux
 * de l'Assistant IA : ses opérations (`executerOperationIA`) et, depuis J6 (décision 0020), les CAPACITÉS de
 * l'ERP (`executerCapacite` — l'action elle-même, sous cette session, ses gardes d'origine, la famille de la
 * console relue). Plus rien n'est exécuté par Adam (`performAction`) : une carte d'avant J6 se redemande.
 *
 * Elle vivait dans le fichier d'actions d'Adam (`assistant-actions:confirmerIntentionAssistantIA`) ;
 * elle est ici depuis la phase B du lot J0 (décision 0013) — seule clé du contrat qui change. La garde
 * d'exécution (confirmation forte, idempotence) est au socle, `platform/ia/intentions/action-intents.ts`.
 */
export async function confirmerIntentionAssistantIA(intentId: string, confirmTyped?: string, corrections?: string): Promise<ResultatExecution> {
  try {
    const user = await requireUser();
    if (!peutUtiliserAssistantIA(user)) return { ok: false, error: REFUS_ASSISTANT_IA };
    // J11 (décision 0030) : une correction du formulaire voyage en JSON (`corrections`) — le contrat de l'action reste
    // lisible (trois textes). La garde est commune au bouton et à la confirmation orale (décision 0038).
    const { confirmerCarte } = await import("@/modules/assistant-ia/api");
    return await confirmerCarte(user, intentId, confirmTyped, corrections);
  } catch (err) {
    console.error("[assistant] confirmerIntentionAssistantIA failed", err);
    return { ok: false, error: "L'action n'a pas pu être exécutée. Réessayez dans un instant." };
  }
}

/**
 * C1 (décision 0068) — « IGNORER » UNE CARTE, POUR DE BON. Le bouton ne changeait que l'écran : au rechargement, la carte
 * revenait à signer. L'état d'une carte n'a qu'une source, la table des intentions : PROPOSED → CANCELLED, au journal.
 */
export async function ignorerIntentionAssistantIA(intentId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const user = await requireUser();
    if (!peutUtiliserAssistantIA(user)) return { ok: false, error: REFUS_ASSISTANT_IA };
    return (await cancelActionIntent(user.id, String(intentId ?? "")))
      ? { ok: true }
      : { ok: false, error: "Cette carte n'attend plus de décision (déjà exécutée, retirée ou expirée)." };
  } catch (err) {
    console.error("[assistant-ia] ignorerIntentionAssistantIA", err);
    return { ok: false, error: "La carte n'a pas pu être ignorée. Réessayez." };
  }
}

/** Le sélecteur d'une référence du formulaire de carte (J11) : les fiches que la personne voit, pour un champ de SA carte. */
export async function chercherReferenceCarteAssistantIA(intentId: string, champ: string, texte: string) {
  try {
    const user = await requireUser();
    if (!peutUtiliserAssistantIA(user)) return { ok: false as const, error: REFUS_ASSISTANT_IA };
    const { chercherReferenceDeCarte } = await import("@/modules/assistant-ia/api");
    return await chercherReferenceDeCarte(user, intentId, String(champ ?? ""), String(texte ?? ""));
  } catch (err) {
    console.error("[assistant-ia] chercherReferenceCarteAssistantIA", err);
    return { ok: false as const, error: "La recherche n'a pas abouti. Réessayez." };
  }
}

/**
 * LA CONFIRMATION D'UNE CARTE DE TERRAIN (lot J13, décision 0025) — compte rendu pré-rempli, demande d'échantillons,
 * tournée de demain, photo rattachée. Sa porte est celle du TERRAIN (module Rapports terrain), pas de l'Assistant IA :
 * un délégué dicte sans avoir la conversation. Elle n'exécute QUE les opérations `terrain_*` que CE compte a préparées
 * (jamais un payload reçu), sous la même garde que toute carte : réclamation atomique, idempotence, action de l'écran.
 */
export async function confirmerCarteTerrain(intentId: string): Promise<ResultatExecution> {
  try {
    const user = await requireUser();
    const { peutCapterTerrain } = await import("@/modules/assistant-ia/api");
    if (!peutCapterTerrain(user)) return { ok: false, error: "Le terrain s'ouvre avec le module Rapports terrain." };
    if (typeof intentId !== "string" || !intentId) return { ok: false, error: "Action introuvable." };
    const executeur = async (stored: unknown) =>
      estChargeOperationIA(stored) && stored.op.startsWith("terrain_")
        ? executerOperationJournalisee(user, stored, { origine: "carte", cle: intentId })
        : { ok: false, error: "Cette carte ne se confirme pas depuis le terrain : ouvrez Adam." };
    return (await executerIntention(user, intentId, undefined, executeur)) ?? { ok: false, error: "Action introuvable." };
  } catch (err) {
    console.error("[assistant-ia] confirmerCarteTerrain", err);
    return { ok: false, error: "L'action n'a pas pu être exécutée. Réessayez dans un instant." };
  }
}

// ─────────────────────────────── LES TRAVAUX (J2, décision 0016) ───────────────────────────────
//
// Les gestes de la personne sur SES travaux longs (panneau « Travaux ») : un identifiant reçu ne donne rien
// s'il n'est pas le sien (le service met la personne dans chaque `where`) ; pas d'écriture en « Vue exacte ».

const id = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length < 64 ? v : null);
// Chargés à l'appel : le moteur des travaux et la persona ne pèsent que sur ces gestes-là.
const travaux = () => import("@/lib/missions/travaux/service");
const persona = async () => (await import("@/modules/assistant-ia/api")).PERSONA_ASSISTANT_IA;

export async function listerMesTravaux(): Promise<{ ok: true; travaux: TravailVue[]; aApprouver: number } | { ok: false; erreur: string }> {
  const p = await porte(false);
  if (!p.ok) return p;
  const liste = await (await travaux()).listerTravaux(p.user.id);
  return { ok: true, travaux: liste, aApprouver: liste.filter((t) => t.etat === "A_APPROUVER").length };
}

export async function lireMonTravail(travailId: string): Promise<{ ok: true; travail: TravailDetail } | { ok: false; erreur: string }> {
  const p = await porte(false);
  if (!p.ok) return p;
  const t = id(travailId) ? await (await travaux()).lireTravail(travailId, p.user.id) : null;
  return t ? { ok: true, travail: t } : { ok: false, erreur: "Travail introuvable." };
}

export async function approuverMonTravail(travailId: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(travailId)) return { ok: false as const, erreur: "Travail introuvable." };
  return (await travaux()).approuverTravail(travailId, p.user.id, await persona());
}

export async function pauserMonTravail(travailId: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(travailId)) return { ok: false as const, erreur: "Travail introuvable." };
  return (await travaux()).pauserTravail(travailId, p.user.id);
}

export async function reprendreMonTravailIA(travailId: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(travailId)) return { ok: false as const, erreur: "Travail introuvable." };
  return (await travaux()).reprendreMonTravail(travailId, p.user.id, await persona());
}

export async function annulerMonTravail(travailId: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(travailId)) return { ok: false as const, erreur: "Travail introuvable." };
  return (await travaux()).annulerTravail(travailId, p.user.id);
}
