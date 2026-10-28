/**
 * Moteur de mission — LA CONCLUSION : le dernier jugement, le bilan, `conclure` (horizon, contrôle,
 * juge), la synchronisation de l'état et sa raison.
 */
import { prisma } from "@/lib/prisma";
import type { MissionActor } from "@/lib/missions/ports";
import { MissionState, STEP_TERMINAL, deduireEtat } from "@/lib/missions/runtime/state";
import { EtatMission, journaliser, transitionner } from "@/lib/missions/runtime/store";
import { aReparer, controlerQualite, evaluerObjectif, type EtapeObservee, type JugementAnterieur } from "@/lib/missions/goal/evaluate";
import { EFFECT_RANK } from "@/lib/missions/registry/capability-meta";
import { sansBloquer } from "@/lib/journal";
import { type EngineDeps, plafondDuCatalogue } from "./contrat";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CONCLUSION — §20 et §22, au seul endroit où elles peuvent s'appliquer.
 *
 * ── POURQUOI CE N'EST PAS DANS `deduireEtat` ─────────────────────────────────────────────
 *
 * Parce que déduire est une lecture, et conclure une DÉCISION. `deduireEtat` dit ce que font
 * les étapes ; il ne peut pas dire si l'objectif est atteint — cela demande de compter des
 * reçus et, souvent, de juger un contenu. Les mêler ferait qu'une simple relecture d'état
 * conclurait une mission.
 *
 * ── LES TROIS ISSUES, ET CE QU'ELLES SIGNIFIENT ──────────────────────────────────────────
 *
 *   COMPLETED — le compte est bon ET l'objectif est jugé atteint. Les deux, jamais l'un.
 *   PARTIAL   — le travail s'est arrêté avec un manque IDENTIFIÉ. Ce n'est pas une fin : le
 *               moteur sait quoi réparer, et la mission reste ouverte.
 *   l'état déduit — tout le reste. Notamment : tout est vert, mais personne n'a vérifié.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
/**
 * LE DERNIER JUGEMENT RENDU SUR CETTE MISSION — relu du JOURNAL, pas d'une table à part.
 *
 * ── POURQUOI LE JOURNAL, ET POURQUOI SEULEMENT LUI ───────────────────────────────────────
 *
 * `MissionEvent` est déjà le registre des faits de la mission (§17 : pas de second registre). Le
 * verdict et son empreinte y sont écrits ensemble, dans la même ligne, par la même écriture :
 * ils ne peuvent donc pas diverger. Une colonne supplémentaire sur `Mission` aurait dit la même
 * chose une seconde fois — et le jour où l'une des deux écritures échouerait, on aurait une
 * empreinte sans verdict, ou l'inverse.
 *
 * ── CE QUE RETOURNE `null`, ET CE QUE ÇA DÉCLENCHE ───────────────────────────────────────
 *
 * Aucun jugement antérieur, ou un jugement sans empreinte (une ligne écrite avant que cette
 * mécanique n'existe) : on rend `null`, et le juge est appelé normalement. Le défaut est donc
 * TOUJOURS de rejuger — jamais de conclure sans preuve.
 */
async function dernierJugement(missionId: string): Promise<JugementAnterieur | null> {
  const e = await prisma.missionEvent.findFirst({
    where: { missionId, kind: { in: ["GOAL_SATISFIED", "GOAL_UNSATISFIED"] } },
    orderBy: { at: "desc" },
    select: { kind: true, detail: true },
  }).catch(sansBloquer("runtime-engine.dernierJugement.missionEvent", null));
  if (!e) return null;

  const detail = (e.detail ?? null) as { empreinteJugement?: unknown } | null;
  const empreinte = typeof detail?.empreinteJugement === "string" ? detail.empreinteJugement : null;
  if (!empreinte) return null;

  // LE VERDICT VIENT DU MODÈLE `Mission`, PAS DU RÉSUMÉ DE LA LIGNE. Le résumé concatène le
  // contrôle arithmétique et la phrase du juge ; le rendre tel quel doublerait le compte rendu
  // à chaque réutilisation. `goalVerdict` porte exactement la phrase du juge.
  const m = await prisma.mission.findUnique({
    where: { id: missionId },
    select: { goalSatisfied: true, goalVerdict: true },
  }).catch(sansBloquer("runtime-engine.dernierJugement.mission", null));
  if (!m || m.goalVerdict === null) return null;

  return {
    empreinte,
    satisfait: m.goalSatisfied === true && e.kind === "GOAL_SATISFIED",
    raison: m.goalVerdict,
  };
}

/** CE QUE LA MISSION A FAIT, en trois nombres et une liste d'effets lus sur les reçus. PUR. */
export function bilanDe(steps: readonly EtapeObservee[]): {
  faites: number; total: number; echouees: number; effets: string[]; livrables: string[]; effetsExternes: boolean;
} {
  const reelles = steps.filter((s) => s.nodeType !== "JOIN");
  const faites = reelles.filter((s) => s.status === "DONE").length;
  const echouees = reelles.filter((s) => s.status === "FAILED").length;
  const parCapacite = new Map<string, number>();
  let effetsExternes = false;
  for (const s of reelles) {
    if (s.status !== "DONE" || !s.recu || !s.recu.capability) continue;
    if (EFFECT_RANK[s.recu.effect] < EFFECT_RANK.INTERNAL_REVERSIBLE_WRITE) continue;
    // CE QUI A QUITTÉ LA MAISON : une communication externe, un engagement financier, un geste
    // RH. C'est la ligne qui sépare « la conversation l'a déjà dit » de « le dirigeant doit
    // savoir » quand la mission s'est terminée dans la foulée de la demande.
    if (EFFECT_RANK[s.recu.effect] >= EFFECT_RANK.EXTERNAL_COMMUNICATION) effetsExternes = true;
    parCapacite.set(s.recu.capability, (parCapacite.get(s.recu.capability) ?? 0) + 1);
  }
  const effets = [...parCapacite.entries()].map(([c, n]) => (n > 1 ? `${c} ×${n}` : c));
  // LES LIVRABLES : les fabrications abouties. Le message au dirigeant les nomme, et leur
  // présence suffit à mériter une information — un fichier l'attend.
  const livrables = reelles.filter((s) => s.nodeType === "ARTIFACT" && s.status === "DONE").map((s) => s.title);
  return { faites, total: reelles.length, echouees, effets, livrables, effetsExternes };
}

export async function conclure(
  missionId: string,
  etat: EtatMission,
  deps: EngineDeps,
  /** L'acteur, pour interroger le catalogue sur son plafond d'effet. Optionnel : voir plus bas. */
  actor?: MissionActor,
): Promise<MissionState> {
  /**
   * LE CONTRÔLE ET LE JUGE NE VOIENT QUE LES OBLIGATIONS DU PLAN COURANT.
   *
   * Une étape contournée par un replan garde son statut en base — c'est une pièce du dossier —
   * mais la compter ici ferait échouer arithmétiquement une mission que le plan suivant a
   * menée à bien. Un run Render l'a montré : neuf étapes du plan v2 abouties, et la mission
   * BLOCKED à cause d'une étape du plan v1 qu'aucun plan ne portait plus.
   */
  const observees: EtapeObservee[] = etat.steps.filter((s) => !s.contournee).map((s) => ({
    key: s.key, title: s.title, status: s.status, nodeType: s.nodeType,
    receipt: s.receipt, attempt: s.attempt, maxAttempts: s.maxAttempts, result: s.result,
    // LE REÇU SUIT L'ÉTAPE JUSQU'AU JUGE. Sans cette ligne, tout ce qui précède — la
    // fabrication du reçu, sa persistance, sa relecture — s'arrêterait à un pas du seul
    // endroit où il sert : la brique serait écrite, testée, et sans effet (§14).
    recu: s.recu,
    // ET L'ENTRÉE PRÉVUE AUSSI : c'est la référence de « exécuté = prévu » (goal/rules.ts).
    input: s.input,
  }));

  /**
   * LES CLÉS CONTOURNÉES VOYAGENT AVEC LA VUE FILTRÉE — la réconciliation des éventails.
   *
   * Le Run 4 a mesuré le défaut de la vue seule : un parent d'éventail DONE annonce ses filles
   * sous le plan qui l'a déployé ; une fille en échec contournée par un replan sort de la vue,
   * et le contrôle qualité comptait alors une « incohérence de comptage » ÉTERNELLE — trois
   * missions brûlées au plafond de replanifications pour une itération que le journal disait
   * déjà contournée. La fille contournée n'est pas un trou : elle est nommée. Le trou — une clé
   * annoncée qui n'existe NULLE PART — bloque toujours.
   */
  const clesContournees: ReadonlySet<string> = new Set(
    etat.steps.filter((s) => s.contournee).map((s) => s.key));

  const encoreEnCours = observees.some((s) => !STEP_TERMINAL.has(s.status)
    && !(s.status === "FAILED" && s.attempt >= s.maxAttempts));
  if (encoreEnCours) return synchroniserEtat(missionId, etat);

  /**
   * ── « CE JALON EST FINI » N'EST PAS « LA MISSION EST FINIE » (§118.44) ─────────────────
   *
   * Sur une mission longue, les étapes en base sont celles du ou des jalons COMPILÉS — les
   * suivants n'existent encore que comme intentions. Toutes terminales signifie donc « ce
   * sous-plan a fini », et rien d'autre.
   *
   * Sans cette porte, une mission de sept jalons se ferait juger au bout du premier : le juge
   * lirait l'objectif ENTIER, ne verrait qu'un septième du travail, refuserait — honnêtement —
   * et la mission mourrait BLOCKED avec six jalons jamais écrits. C'est le faux échec
   * symétrique du faux succès de §118.10, et il coûte exactement aussi cher.
   *
   * `WAITING_DEPENDENCY` est l'état exact : la mission attend son prochain sous-plan. Elle n'a
   * ni échoué, ni fini, et elle ne travaille pas — le pilote d'horizon la reprendra.
   */
  if (etat.horizonOuvert) {
    await transitionner(missionId, "WAITING_DEPENDENCY",
      "le sous-plan courant est terminé ; il reste des jalons à compiler");
    return "WAITING_DEPENDENCY";
  }

  const qa = controlerQualite(observees, clesContournees);
  /**
   * LE PLAFOND D'EFFET EST DÉDUIT DU CATALOGUE, PAS DÉCLARÉ.
   *
   * `catalog` est celui que le composeur a construit — plafonné à `ANALYZE` sous lecture seule.
   * On demande donc au catalogue lui-même quel est l'effet le plus fort qu'il aurait laissé
   * passer, plutôt que de recopier une option d'appel : une option se désynchronise, un
   * catalogue est la source.
   */
  const plafondEffet = actor ? plafondDuCatalogue(deps.catalog, actor) : "SECURITY_ADMIN";

  const verdict = await evaluerObjectif({
    objectif: etat.goalRaw,
    criteres: etat.acceptance,
    steps: observees,
    clesContournees,
    juge: deps.juge,
    anterieur: await dernierJugement(missionId),
    plafondEffet,
  });

  await prisma.mission.update({
    where: { id: missionId },
    data: { qaPassed: qa.ok, goalSatisfied: verdict.satisfait, goalVerdict: verdict.raison },
  });
  // ON N'ÉCRIT PAS DEUX FOIS LA MÊME LIGNE. Un verdict réutilisé n'apprend rien au journal : la
  // ligne existe déjà, à l'identique, et la répéter rendrait le fil illisible tout en laissant
  // croire qu'un second jugement a eu lieu. Les transitions, elles, suivent leur cours.
  if (!verdict.reutilise) {
    await journaliser(missionId, verdict.satisfait ? "GOAL_SATISFIED" : "GOAL_UNSATISFIED",
      `${qa.resume} ${verdict.raison}`,
      {
        qa: qa.ok, attendus: qa.attendus, faits: qa.faits, aReparer: aReparer(qa),
        // L'EMPREINTE EST CE QUI REND LE JUGEMENT REJOUABLE SANS ÊTRE REFAIT. Elle vit dans le
        // journal canonique (§17 : pas de second registre) et nulle part ailleurs.
        ...(verdict.empreinte ? { empreinteJugement: verdict.empreinte } : {}),
        // LE RECOURS SUGGÉRÉ PAR LE JUGE, journalisé tel quel : `null` = « je n'en vois
        // aucun » — c'est ce que la replanification relit avant de payer un plan de plus.
        // Absent quand personne ne l'a mesuré (refus arithmétique, juge indisponible).
        ...(verdict.recoursSuggere !== undefined ? { recoursSuggere: verdict.recoursSuggere } : {}),
      });
  }

  // ── LE COMPTE RENDU AU DIRIGEANT, composé par le code depuis les reçus ───────────────
  const bilan = bilanDe(observees);
  const signaler = async (kind: "MISSION_COMPLETED" | "MISSION_PARTIAL" | "MISSION_BLOCKED", raison: string) => {
    if (!deps.attention) return;
    await deps.attention.signaler({
      kind, missionId, ownerId: etat.ownerId, titre: "", raison, bilan, planVersion: etat.planVersion,
      decision: verdict.recoursSuggere ?? null,
      // LE TEMPS DEPUIS LA DEMANDE : une mission finie dans la foulée n'a pas besoin d'interrompre
      // — la conversation l'a déjà dit. La politique d'attention tranche avec ce chiffre.
      dureeMs: etat.createdAt ? Math.max(0, Date.now() - etat.createdAt.getTime()) : null,
    }).catch(sansBloquer("runtime-engine.signaler.signaler"));
  };
  if (verdict.satisfait) {
    await transitionner(missionId, "RUNNING", "vérification de l'objectif");
    await transitionner(missionId, "COMPLETED", verdict.raison);
    await signaler("MISSION_COMPLETED", verdict.raison);
    // LA FORME DE CE PLAN A RÉUSSI (§64) : elle s'inscrit au registre des formes — jamais le
    // contenu, jamais bloquant, idempotente au rejeu. Import différé : la conclusion d'une
    // mission ne charge le registre que lorsqu'elle a quelque chose à y écrire.
    await import("@/lib/missions/planner/patterns")
      .then((m) => m.enregistrerFormeReussie(missionId))
      .catch(sansBloquer("runtime-engine.conclure"));
    return "COMPLETED";
  }

  if (!qa.ok && qa.manquants.length > 0) {
    await transitionner(missionId, "RUNNING", "bilan");
    await transitionner(missionId, "PARTIAL", qa.resume);
    await signaler("MISSION_PARTIAL", qa.resume);
    return "PARTIAL";
  }

  /**
   * ── LE POINT FIXE, ET POURQUOI IL ÉTAIT UN DÉFAUT ────────────────────────────────────
   *
   * Ici, toutes les étapes sont terminales, le contrôle arithmétique passe, et le juge dit que
   * l'objectif N'EST PAS atteint. `synchroniserEtat` rendait alors `RUNNING` — la réponse
   * honnête de `deduireEtat`, qui signifie « il ne reste plus d'étapes », mais une réponse
   * FAUSSE au niveau de la mission : plus rien ne tournera jamais.
   *
   * Un run réel s'y est immobilisé : sept étapes abouties, QA verte, objectif non atteint, et
   * une mission éternellement `RUNNING`. Ni terminale, ni replanifiable — `RUNNING` n'ouvre
   * aucune des deux portes. Le moteur avait cessé de vivre sans le dire.
   *
   * `BLOCKED` est l'état exact : il y a un obstacle, il est nommé (le verdict du juge), et il
   * ouvre la replanification. C'est ce qui rend le recours possible au lieu de l'attendre.
   *
   * On ne force PAS `COMPLETED` : le juge a refusé, et son refus fait autorité (§10).
   */
  // Atteindre cette ligne SIGNIFIE que plus rien ne peut tourner : `encoreEnCours` a déjà
  // renvoyé plus haut sinon. Réinterroger l'état des étapes ici ajouterait une condition
  // légèrement différente de celle qui garde l'entrée — et deux conditions voisines qui
  // divergent sont exactement la façon dont un état fantôme réapparaît.
  if (observees.length > 0) {
    await transitionner(missionId, "RUNNING", "bilan");
    await transitionner(missionId, "BLOCKED",
      `Toutes les étapes sont abouties et l'objectif n'est pas atteint : ${verdict.raison}`);
    await signaler("MISSION_BLOCKED", verdict.raison);
    return "BLOCKED";
  }

  return synchroniserEtat(missionId, etat);
}

/** Recale l'état de la mission sur celui de ses étapes — la déduction fait foi (§37). */
export async function synchroniserEtat(missionId: string, etat: EtatMission): Promise<MissionState> {
  const deduit = deduireEtat(etat.steps.map((s) => ({
    status: s.status, nodeType: s.nodeType, attempt: s.attempt, maxAttempts: s.maxAttempts,
    contournee: s.contournee,
  })));
  if (deduit !== etat.status) await transitionner(missionId, deduit, raisonDeLEtat(deduit, etat));
  return deduit;
}

/**
 * POURQUOI LA MISSION EST DANS CET ÉTAT — dit au journal, pas seulement déduit.
 *
 * Un `STATE_CHANGED | RUNNING → BLOCKED` sans motif ne ressemble à rien et ne se range nulle
 * part (§118.31 : un manque non classé est un manque invisible). Mesuré : une mission a alterné
 * « le moteur prend la main » et « RUNNING → BLOCKED » jusqu'au dernier tour, sans qu'aucune
 * ligne ne dise que deux étapes en échec définitif barraient la route à tout le plan.
 *
 * On ne dit QUE ce qu'on lit dans l'état — jamais une cause devinée.
 */
function raisonDeLEtat(deduit: MissionState, etat: EtatMission): string | undefined {
  if (deduit !== "BLOCKED") return undefined;
  const vivantes = etat.steps.filter((s) => !s.contournee);
  const echouees = vivantes.filter((s) => s.status === "FAILED");
  const enAttentePlan = vivantes.filter((s) => s.status === "PENDING");
  if (echouees.length === 0) return undefined;
  const noms = echouees.slice(0, 4).map((s) => s.key).join(", ");
  const reste = echouees.length > 4 ? ` (+${echouees.length - 4})` : "";
  return `${echouees.length} étape(s) en échec définitif — ${noms}${reste} — et `
    + `${enAttentePlan.length} étape(s) encore en attente : rien ne peut plus démarrer tout seul.`;
}
