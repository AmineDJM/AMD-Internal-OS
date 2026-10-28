/**
 * Moteur de mission — LE RECOURS : les stratégies inapplicables, et la tentative de recours quand
 * une étape échoue (§118).
 */
import { prisma } from "@/lib/prisma";
import type { CapabilityCatalog, Clock, MissionActor, RegistreRecours } from "@/lib/missions/ports";
import { EtatEtape, EtatMission, journaliser } from "@/lib/missions/runtime/store";
import { attenduDe } from "@/lib/missions/recovery/evaluate";
import { ERROR_KINDS, type ErrorKind, type Strategy } from "@/lib/missions/recovery/strategy";
import { deciderRecours, historiqueDe, noter, peutConclureEtape, type ResolveursRecours } from "@/lib/missions/recovery/coordinator";
import { elargirEntree, memeAppel } from "@/lib/missions/recovery/action";
import { metaDe, type StepOutcome } from "./contrat";
import { appliquer } from "./execution";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RECOURS LOCAL — ce qui se passe entre « ça a échoué » et « la mission a échoué ».
 *
 * ── POURQUOI ICI ET PAS DANS LE COORDINATEUR ─────────────────────────────────────────────
 *
 * Le coordinateur DÉCIDE (quelle stratégie, quel grenier) ; il ne touche pas la base. Cette
 * fonction-ci APPLIQUE la décision : elle réarme l'étape, note la tentative, et injecte la
 * source suivante dans l'entrée. La séparation garde la décision pure et testable seule, et
 * empêche `engine.ts` de devenir le fichier-dieu que §81 interdit.
 *
 * ── CE QU'ELLE NE FAIT PAS ───────────────────────────────────────────────────────────────
 *
 * Elle ne cherche RIEN elle-même. « Essayer Legal » veut dire « rappeler la même capacité en
 * lui disant Legal », pas « écrire une requête Legal ici » (§82).
 *
 * Rend `true` quand l'étape a été réarmée — l'appelant ne doit alors PAS écrire l'échec.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
/**
 * LES STRATÉGIES QUE CETTE ÉTAPE-LÀ NE PEUT PAS CONSOMMER.
 *
 * ── LA RÈGLE, ET ELLE EST STRUCTURELLE ───────────────────────────────────────────────────
 *
 * `AUTRE_SOURCE` et `ELARGIR` n'agissent que d'une façon : en écrivant `source` et `elargir`
 * dans l'ENTRÉE de l'étape, que la capacité relira au prochain passage. Une étape qui ne relit
 * jamais son entrée ne peut donc rien en faire.
 *
 * C'est le cas d'un ÉVENTAIL : `executerUneEtape` le déploie et rend la main AVANT tout appel
 * de capacité (`if (step.forEach) { … return }`). Lui proposer un autre grenier revient à
 * changer un champ que personne ne lit — et c'est très exactement ce qu'un run réel a fait
 * vingt-quatre fois, en écrivant vingt-quatre lignes `STEP_RECOVERY` pour zéro effet, jusqu'à
 * épuiser l'échelle sur une cause qu'elle n'avait pas touchée.
 *
 * Le rendre EXPLICITE plutôt que de le corriger dans le coordinateur garde chaque savoir chez
 * lui : le moteur sait ce qu'un nœud d'éventail fait de son entrée ; le coordinateur sait ce
 * qu'une échelle propose. Aucun des deux n'a besoin de connaître l'autre.
 */
function strategiesInapplicables(step: EtatEtape): Strategy[] {
  return step.forEach ? ["AUTRE_SOURCE", "ELARGIR"] : [];
}

export async function tenterRecours(
  etat: EtatMission,
  step: EtatEtape,
  sortie: Extract<StepOutcome, { status: "FAILED" }>,
  clock: Clock,
  deps?: { registre?: RegistreRecours; acteur?: MissionActor; catalog?: CapabilityCatalog },
): Promise<boolean> {
  if (!(ERROR_KINDS as readonly string[]).includes(sortie.errorKind)) return false;
  const kind = sortie.errorKind as ErrorKind;

  const historique = historiqueDe(step.recovery);
  const attendu = attenduDe(step.spec);
  const inapplicables = strategiesInapplicables(step);
  const entree: Record<string, unknown> = { ...step.input };

  /**
   * ── LES RÉSOLVEURS : CE QUE LE MOTEUR SAIT FAIRE, POUR DE VRAI ──────────────────────
   *
   * Le coordinateur ne propose plus un barreau sans savoir s'il peut agir. Il pose la question
   * à ces trois fonctions, et saute ce à quoi elles répondent « non ». C'est ce qui remplace
   * l'écriture d'un champ `source` que personne ne relisait.
   */
  const resolveurs: ResolveursRecours = {
    autreSource: (source) => {
      if (!deps?.registre || !deps.acteur || !step.capability) return null;
      const effet = metaDe(step.capability, deps.catalog).effect;
      const alt = deps.registre.autreSource({
        source,
        capaciteActuelle: step.capability,
        entree,
        acteur: deps.acteur,
        effetMax: effet,
      });
      if (!alt) return null;
      // LA CEINTURE : même si le registre se trompait, un appel identique n'est pas un recours.
      if (alt.capability === step.capability && memeAppel(alt.input, entree)) return null;
      return { type: "AUTRE_CAPACITE", capability: alt.capability, input: alt.input, ceQuiChange: alt.ceQuiChange };
    },
    elargir: () => {
      const large = elargirEntree(entree);
      if (!large || memeAppel(large.input, entree)) return null;
      return { type: "REQUETE_ELARGIE", input: large.input, ceQuiChange: large.ceQuiChange };
    },
    // ADAPTER est décidé par le nœud lui-même : seul l'éventail sait relire son amont, et il
    // l'a déjà fait avant d'échouer. Le déclarer ici serait une seconde vérité.
    adaptable: () => false,
  };

  // ── §76 — L'AUTORISATION D'ARRÊTER ─────────────────────────────────────────────────
  //
  // C'est l'échelle qui décide si cette étape a le droit de mourir, pas le moteur. Tant
  // qu'elle refuse, il FAUT tenter quelque chose ; laisser l'étape échouer ici serait
  // exactement le « on s'arrête à la première difficulté » que la doctrine interdit.
  if (peutConclureEtape({
    kind, historique, cible: attendu?.cible ?? null, rejouable: sortie.retryable, inapplicables,
  })) return false;

  const recours = deciderRecours({
    kind,
    historique,
    cible: attendu?.cible ?? null,
    objectif: step.title,
    rejouable: sortie.retryable,
    inapplicables,
    resolveurs,
  });

  /**
   * ── UN BARREAU QUE LE MOTEUR N'EXÉCUTE PAS DOIT QUAND MÊME ÊTRE CONSOMMÉ ────────────
   *
   * Seul « réessayer » réarme l'étape ici. Demander à un humain, escalader, replanifier
   * (localement ou globalement) et bloquer sont des ÉTATS de mission : ils passent par
   * l'écriture normale de la sortie, qui porte déjà le motif exact — et par le balayage.
   *
   * Mais l'inscription à l'HISTORIQUE se faisait après ce filtre. Le barreau n'était donc pas
   * consommé, et `prochaineStrategie`, qui choisit « le premier non tenté », reproposait
   * exactement le même à la tentative suivante. L'échelle bouclait au lieu de descendre : pour
   * NOT_FOUND, INSUFFICIENT_DATA, CAPABILITY_FAILURE, INCOMPATIBLE_RESULT et QA_FAILED, elle
   * atteignait `REPLAN_LOCAL` en deuxième ou troisième position et s'y arrêtait — les barreaux
   * suivants (DEMANDER_HUMAIN, DECLARER_INCONNU) étaient structurellement inatteignables.
   *
   * L'historique est inscrit, le JOURNAL non : `STEP_RECOVERY` ne dit que des recours qui ont
   * réellement changé quelque chose, et cet invariant-là tient (un lecteur du fil doit pouvoir
   * vérifier qu'un recours en était un). Mémoire de l'échelle et record des actes sont deux
   * choses, et les confondre ferait mentir l'un des deux.
   */
  const consommer = async (): Promise<false> => {
    if (!("strategie" in recours)) return false; // BLOQUER ne consomme rien : il n'y a plus d'échelle.
    const h = noter(historique, { strategie: recours.strategie, source: "source" in recours ? recours.source : null, kind }, clock.now());
    await prisma.missionStep.update({ where: { id: step.id }, data: { recovery: h as never } });
    return false;
  };
  if (recours.geste !== "REESSAYER") return consommer();

  const suivant = noter(historique, { strategie: recours.strategie, source: recours.source, kind }, clock.now());
  const majCapacite = appliquer(recours.action, step.capability, entree);

  /**
   * ── L'INVARIANT : AUCUN RECOURS SANS CHANGEMENT RÉEL ────────────────────────────────
   *
   * Un `STEP_RECOVERY` ne peut pas être journalisé si l'appel suivant est identique au
   * précédent. Le seul cas admis est le rejeu technique explicite, où ne rien changer EST le
   * propos : une panne de fournisseur se répare en refaisant le même appel.
   *
   * Cette garde est redondante avec les résolveurs, et c'est voulu. Elle a un coût nul, et
   * elle tombe le jour où quelqu'un ajoute un barreau qui croit changer quelque chose.
   */
  const rejeuTechnique = recours.action.type === "REJEU";
  const identique = majCapacite.capability === step.capability && memeAppel(majCapacite.input, entree);
  if (identique && !rejeuTechnique) {
    // Le barreau n'a rien changé — mais il a été TENTÉ. Ne pas le consommer le ferait
    // reproposer indéfiniment, ce qui est la panne d'échelle décrite ci-dessus. Rien au
    // journal : il n'y a pas eu de recours, seulement un barreau qui n'avait rien à offrir.
    await prisma.missionStep.update({ where: { id: step.id }, data: { recovery: suivant as never } });
    return false;
  }

  await prisma.missionStep.update({
    where: { id: step.id },
    data: {
      status: "READY",
      error: sortie.error,
      errorKind: kind,
      input: majCapacite.input as never,
      ...(majCapacite.capability !== step.capability ? { capability: majCapacite.capability } : {}),
      recovery: suivant as never,
      startedAt: null,
    },
  });

  await journaliser(
    etat.id,
    "STEP_RECOVERY",
    `${step.key} — ${recours.strategie}${recours.source ? ` → ${recours.source}` : ""} : ${recours.action.ceQuiChange}`,
    {
      stepKey: step.key,
      errorKind: kind,
      strategie: recours.strategie,
      source: recours.source,
      tentative: suivant.journal.length,
      // CE QUI CHANGE EST ÉCRIT. Un lecteur du fil peut vérifier que le recours en était un.
      action: recours.action.type,
      capaciteAvant: step.capability,
      capaciteApres: majCapacite.capability,
      // Les barreaux sautés faute d'action possible : ils expliquent le chemin sans le fausser.
      sautes: recours.sautes,
      pourquoi: recours.pourquoi,
    },
  );
  return true;
}
