/**
 * Moteur de mission — LA SORTIE D'UNE ÉTAPE : son écriture (reçu, statut, effets) et la date
 * d'entrée des lectures réussies (la fraîcheur se prend au REÇU, jamais au plan).
 */
import { prisma } from "@/lib/prisma";
import type { Clock } from "@/lib/missions/ports";
import { assertStepTransition } from "@/lib/missions/runtime/state";
import { EtatEtape, EtatMission, journaliser } from "@/lib/missions/runtime/store";
import { classer } from "@/lib/registre/manques";
import type { StepOutcome } from "./contrat";

/** Écrit le résultat de l'étape — et transitionne en passant par la machine à états. */
export async function ecrireSortie(
  etat: EtatMission,
  step: EtatEtape,
  sortie: StepOutcome,
  clock: Clock,
): Promise<void> {
  assertStepTransition("RUNNING", sortie.status);
  const base = { status: sortie.status as string, updatedAt: clock.now() };

  if (sortie.status === "DONE") {
    await prisma.missionStep.update({
      where: { id: step.id },
      data: {
        ...base,
        result: (sortie.result ?? null) as never,
        receipt: sortie.receipt ?? null,
        // LE REÇU STRUCTURÉ SURVIT AU REDÉMARRAGE, comme le reste de l'état. Le garder en
        // mémoire ferait qu'une mission reprise après panne perdrait ses preuves — et le juge
        // conclurait alors sur un dossier amputé sans que rien ne le signale.
        ...(sortie.recu ? { receiptData: sortie.recu as never } : {}),
        error: null,
        errorKind: null,
        completedAt: clock.now(),
      },
    });
    await journaliser(etat.id, "STEP_DONE", `Étape « ${step.title} » terminée.`,
      { stepKey: step.key, receipt: sortie.receipt ?? null });
    // LA FRAÎCHEUR SE PREND ICI, sur le reçu de l'étape qui vient d'aboutir (§118.41).
    await daterLEntree(etat.id, step, sortie);
    return;
  }

  if (sortie.status === "FAILED") {
    await prisma.missionStep.update({
      where: { id: step.id },
      data: {
        ...base,
        error: sortie.error,
        errorKind: sortie.errorKind,
        // LE REÇU D'UN ÉCHEC EST UNE PREUVE, PAS UN DÉCHET. Il porte la source interrogée, la
        // requête et l'horodatage : c'est lui qui permet au juge de distinguer « cette piste n'a
        // pas été explorée » de « cette piste a été explorée et n'a rien donné ».
        ...(sortie.recu ? { receiptData: sortie.recu as never } : {}),
        // UN ÉCHEC NON REJOUABLE ÉPUISE SES TENTATIVES TOUT DE SUITE. Réessayer trois fois une
        // permission manquante ne la fait pas apparaître ; cela retarde seulement le diagnostic.
        ...(sortie.retryable ? {} : { attempt: step.maxAttempts }),
      },
    });
    // ── LE MANQUE EST NOMMÉ ICI, PAS PLUS TARD (§44) ─────────────────────────────────────
    //
    // « L'étape a échoué » ne répare rien ; « le format .xls n'est pas lisible sur ce serveur »
    // se répare et se chiffre. Le classement se fait AU MOMENT de l'échec, où le message est
    // encore entier, et voyage dans le détail de l'événement que le journal écrit déjà — pas
    // dans une table de manques qui dirait la même chose une seconde fois (§17).
    await journaliser(etat.id, "STEP_FAILED", `Étape « ${step.title} » en échec : ${sortie.error}`,
      {
        stepKey: step.key, errorKind: sortie.errorKind, retryable: sortie.retryable,
        manque: classer(sortie.error, { capacite: step.capability ?? null, etape: step.key }),
      });
    return;
  }

  if (sortie.status === "WAITING") {
    // Une attente peut porter une PROGRESSION (branches déjà réglées) : elle voyage avec elle.
    await prisma.missionStep.update({ where: { id: step.id }, data: { ...base, ...(sortie.result !== undefined ? { result: sortie.result as never } : {}) } });
    await journaliser(etat.id, "STEP_WAITING", `Étape « ${step.title} » en attente : ${sortie.raison}`,
      { stepKey: step.key });
    return;
  }

  await prisma.missionStep.update({
    where: { id: step.id },
    data: { ...base, completedAt: clock.now(), error: sortie.raison },
  });
  await journaliser(etat.id, "STEP_SKIPPED", `Étape « ${step.title} » ignorée : ${sortie.raison}`,
    { stepKey: step.key });
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DATER CE QUE LA MISSION VIENT DE LIRE (§118.41) — la fraîcheur, à sa seule source honnête.
 *
 * ── POURQUOI ICI, ET NULLE PART AILLEURS ────────────────────────────────────────────────
 *
 * Le REÇU est la seule chose de ce moteur qui dise ce qui a RÉELLEMENT été interrogé : la
 * source, la requête telle qu'elle est partie, et une empreinte du résultat. Tout autre endroit
 * — le payload du plan, le titre de l'étape, ce qu'un modèle en dit — décrirait une intention.
 * Une fraîcheur bâtie sur une intention daterait des lectures qui n'ont pas eu lieu.
 *
 * ── CE QU'ON ENREGISTRE, ET CE QU'ON N'ENREGISTRE PAS ───────────────────────────────────
 *
 * Seulement les LECTURES (`READ`, `ANALYZE`). Un envoi ou une écriture ne « périment » pas :
 * ils ont eu lieu, et les dater n'aurait aucun sens. Seulement quand le reçu porte une SOURCE
 * et une EMPREINTE : sans l'une des deux, on ne pourrait répondre ni « d'où ça vient ? » ni
 * « est-ce encore ça ? », et une ligne qui ne répond à aucune des deux questions est du bruit.
 *
 * ── POURQUOI L'EMPREINTE VIENT DU REÇU, ET N'EST PAS RECALCULÉE ─────────────────────────
 *
 * `resultHash` est déjà l'empreinte de ce résultat. En recalculer une seconde, autrement,
 * créerait deux empreintes du même fait qui divergeraient le jour où l'une des deux fonctions
 * changerait — et c'est exactement la divergence que la fraîcheur existe pour détecter.
 *
 * ── ÇA NE PEUT PAS FAIRE ÉCHOUER UNE ÉTAPE ──────────────────────────────────────────────
 *
 * L'écriture est en `catch`. Une étape réussie dont la trace de fraîcheur échoue reste réussie :
 * l'inverse ferait perdre un travail réel pour une ligne d'observabilité.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const EFFETS_LECTURE: ReadonlySet<string> = new Set(["READ", "ANALYZE"]);

async function daterLEntree(
  missionId: string,
  step: EtatEtape,
  // La sortie est TOUJOURS un DONE ici — c'est le seul appelant. Le type le dit, plutôt que de
  // laisser un `sortie.recu` qui n'existe pas sur les autres formes de la même union.
  sortie: Extract<StepOutcome, { status: "DONE" }>,
): Promise<void> {
  const recu = sortie.recu;
  if (!recu || !EFFETS_LECTURE.has(recu.effect)) return;
  if (!recu.source || !recu.resultHash) return;
  try {
    const { inscrireEntree } = await import("@/lib/missions/horizon/store");
    const ligne = await prisma.missionStep.findUnique({
      where: { id: step.id }, select: { milestoneId: true },
    });
    await inscrireEntree({
      missionId,
      milestoneId: ligne?.milestoneId ?? null,
      stepKey: step.key,
      // LA CLÉ MÉTIER : ce qui identifie LA MÊME donnée d'une lecture à l'autre. La requête en
      // fait partie — deux lectures de la même source sur deux dossiers différents ne sont pas
      // la même donnée, et les confondre ferait crier au changement à chaque tour.
      cle: `${recu.capability ?? step.capability ?? step.nodeType}:${(recu.query ?? step.key).slice(0, 120)}`,
      source: recu.source,
      // L'EMPREINTE VIENT DU REÇU : on lui passe `resultHash` comme VALEUR, donc l'empreinte
      // inscrite est une fonction stable de celle du reçu. Recalculer une empreinte du résultat
      // par un autre chemin créerait deux vérités qui divergeraient un jour.
      valeur: recu.resultHash,
      apercu: `${recu.resultCount ?? "?"} résultat(s) — ${(recu.query ?? "").slice(0, 200)}`,
      confiance: "TROUVE",
    });
  } catch {
    // Silencieux À DESSEIN : voir l'en-tête. Le journal de l'étape a déjà dit ce qui compte.
  }
}
