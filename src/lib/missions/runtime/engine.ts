/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MOTEUR — l'autorité d'exécution (§13). Le modèle propose ; ce fichier décide.
 *
 * ── LE PRINCIPE, EN UNE PHRASE ───────────────────────────────────────────────────────────
 *
 * Le moteur ne garde RIEN entre deux tours : il relit l'état complet en base, décide ce qui
 * peut partir, l'exécute, écrit le résultat, et recommence. C'est ce qui rend un redémarrage
 * indiscernable d'une pause — et c'est la seule façon d'être reprenable sans y penser à chaque
 * ligne.
 *
 * ── CE QU'UN CRASH À L'ÉTAPE 73 SUR 127 DOIT DONNER ──────────────────────────────────────
 *
 * Les 72 étapes terminées portent un reçu ; elles ne sont pas relues comme du travail à faire.
 * La 73ᵉ, si elle avait commencé, porte une clé d'idempotence : la rejouer traverse le chemin
 * canonique, qui reconnaît la clé et rend le reçu existant au lieu de renvoyer l'e-mail. Les 54
 * suivantes n'ont jamais commencé. Aucun des trois cas n'exige de code particulier ici — c'est
 * le schéma qui les distingue.
 *
 * ── POURQUOI « UN TOUR » PLUTÔT QU'UNE BOUCLE INFINIE ────────────────────────────────────
 *
 * `avancer()` fait avancer la mission autant qu'elle peut avancer MAINTENANT, puis rend la
 * main. Une mission qui attend un événement de dix jours ne doit pas occuper un processus
 * pendant dix jours : elle s'arrête, et c'est l'ordonnanceur existant ou le routeur
 * d'événements qui la rappelle. Aucun ordonnanceur n'est créé ici (§39).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Découpé par responsabilité — voir le dossier `engine/` : `contrat.ts` (bail, ports, dépendances,
 * résultat d'un tour, profil des capacités), `ordonnancement.ts` (étapes prêtes, dépendances,
 * réservation, orphelines, réparables, parallélisme borné), `execution.ts` (références, exécution
 * d'une étape, aiguillage, capacités), `recours.ts` (stratégies de recours), `sortie.ts` (écriture
 * de la sortie, fraîcheur des entrées), `eventail.ts` (déployer et résoudre les éventails),
 * `conclusion.ts` (dernier jugement, bilan, conclure, état). Ce fichier garde le tour lui-même :
 * `avancer` et `demarrer`.
 */
import type { MissionActor } from "@/lib/missions/ports";
import { systemClock } from "@/lib/missions/ports";
import { prendreBail } from "@/lib/missions/runtime/bail";
import { limitesDe, ordonnancer } from "@/lib/missions/runtime/scheduler";
import { EtatMission, chargerEtat, transitionner } from "@/lib/missions/runtime/store";
import { lireInterrupteurMissions, type LecteurInterrupteur } from "@/lib/interrupteurs/missions";
import { type EngineDeps, profilCapacite, type TickResult } from "./engine/contrat";
import { enParallele, etapesPretes, relancerReparables, reprendreOrphelines, reserver } from "./engine/ordonnancement";
import { executerUneEtape } from "./engine/execution";
import { resoudreEventails } from "./engine/eventail";
import { conclure, synchroniserEtat } from "./engine/conclusion";

export { BAIL_MS, type StepContext, type StepOutcome, type StepHandlers, type EngineDeps, type TickResult } from "./engine/contrat";
export { dependanceSatisfaite } from "./engine/ordonnancement";
export { bilanDe, conclure } from "./engine/conclusion";

/**
 * FAIT AVANCER LA MISSION AUTANT QU'ELLE PEUT AVANCER MAINTENANT.
 *
 * Réentrant et sûr à rappeler : deux appels concurrents se disputent les étapes par une
 * réservation en base (`status = READY → RUNNING` conditionnée), et le perdant n'exécute rien.
 */
export async function avancer(
  missionId: string,
  actor: MissionActor,
  deps: EngineDeps,
): Promise<TickResult> {
  const clock = deps.clock ?? systemClock;
  const maxTours = deps.maxTours ?? 200;
  const lireInterrupteur: LecteurInterrupteur = deps.interrupteur ?? lireInterrupteurMissions;
  const res: TickResult = {
    missionId, status: "RUNNING", executees: 0, echouees: 0,
    deployees: 0, dedupliquees: 0, tours: 0, enPause: false,
    concurrenceMax: 0, concurrenceCumulee: 0, toursExecutants: 0, differees: 0,
  };

  for (let tour = 0; tour < maxTours; tour++) {
    res.tours = tour + 1;
    const etat = await chargerEtat(missionId);
    if (!etat) throw new Error(`mission introuvable : ${missionId}`);

    // LE BAIL, À CHAQUE VAGUE. Une autre instance vivante la conduit ? On passe — sans toucher à
    // rien. Le renouvellement à chaque vague est ce qui protège une mission longue : le bail ne
    // meurt qu'avec le processus qui le tenait.
    if (!(await prendreBail(missionId, clock.now()))) {
      res.bailRefuse = true;
      res.status = etat.status;
      res.enPause = true;
      return res;
    }

    if (etat.status === "COMPLETED" || etat.status === "CANCELLED") {
      res.status = etat.status;
      res.enPause = true;
      return res;
    }

    /**
     * ── LA PAUSE EST HONORÉE ICI, ET NULLE PART AILLEURS (§118.45) ───────────────────────
     *
     * `PAUSED` existait dans la machine à états depuis toujours, et AUCUN code ne le lisait :
     * on pouvait poser le statut, le battement reprenait la mission au tour suivant comme si
     * de rien n'était. Un état qu'aucun code n'honore est une promesse d'écran, pas une
     * propriété du système.
     *
     * On sort SANS toucher à quoi que ce soit — c'est ce qui rend la reprise exacte : les
     * étapes gardent leur statut, leurs reçus et leurs attentes, et « reprends demain » repart
     * de l'état réel plutôt que d'un état reconstruit.
     */
    if (etat.status === "PAUSED") {
      res.status = "PAUSED";
      res.enPause = true;
      return res;
    }

    /**
     * ── L'INTERRUPTEUR GLOBAL EST HONORÉ ICI, PAR LE SEUL EXÉCUTANT (§118.132) ────────────
     *
     * « Bloque toutes les missions d'Adam. » Battement, clic dans Mission Control, réveil par
     * événement, reprise après accord : tout chemin d'avancement finit dans cette boucle, donc
     * c'est ici que la suspension est une PROPRIÉTÉ du système et non une discipline de chaque
     * appelant. Relu à CHAQUE tour, parce qu'un interrupteur posé pendant une mission de deux
     * cents tours doit l'arrêter au tour suivant, pas au prochain appel.
     *
     * On sort SANS toucher à rien, comme pour PAUSED : c'est ce qui rend la levée exacte —
     * chaque mission repart de son état réel. Et l'on sort AVANT `conclure` : une mission dont
     * plus rien ne peut avancer ne se fait pas JUGER sous suspension, donc ne passe pas BLOCKED,
     * donc ne NOTIFIE pas — c'est précisément la boucle que le dirigeant voulait couper.
     */
    if ((await lireInterrupteur()).suspendues) {
      res.status = etat.status;
      res.enPause = true;
      res.suspenduGlobalement = true;
      return res;
    }

    await demarrer(etat);

    // LES DEUX REMISES EN FILE D'ABORD, PUIS UNE RELECTURE. L'ordre inverse ferait travailler le
    // tour sur une photo antérieure à ses propres écritures : une étape reprise resterait « en
    // cours » aux yeux du moteur, et la mission se figerait en se croyant occupée.
    await reprendreOrphelines(missionId, clock);
    const relancees = await relancerReparables(missionId);
    const frais = await chargerEtat(missionId);
    if (!frais) throw new Error(`mission introuvable : ${missionId}`);

    const pretes = etapesPretes(frais);
    if (pretes.length === 0) {
      const resolues = await resoudreEventails(frais, deps.catalog);
      if (resolues === 0 && relancees === 0) {
        // PLUS RIEN NE PEUT AVANCER. C'est le moment — et le seul — où la question « est-ce
        // fini ? » a un sens. Elle est posée à part, parce qu'y répondre n'est pas exécuter.
        const fin = await conclure(missionId, frais, deps, actor);
        res.status = fin;
        res.enPause = true;
        return res;
      }
      continue;
    }

    /**
     * ── L'ORDONNANCEMENT (§28) — l'ordre décide de la durée, pas seulement du travail ────
     *
     * Ce qui était ici tenait en un `slice(0, maxConcurrency)` : les premières dans l'ordre de
     * la base, jusqu'au plafond de la mission. Trois défauts en une ligne — un ordre arbitraire
     * qui allonge le chemin critique, un plafond unique pour des files qui ne saturent pas
     * ensemble, et une place consommée par des nœuds qui ne font rien. `scheduler.ts` les
     * traite tous les trois, et RIEN d'autre : il décide qui part, jamais ce qui est permis.
     */
    const plan = ordonnancer(pretes, frais.steps, limitesDe(frais.maxConcurrency), profilCapacite);
    res.differees += plan.differees.length;
    res.concurrenceMax = Math.max(res.concurrenceMax, plan.effective);
    res.concurrenceCumulee += plan.effective;
    res.toursExecutants += plan.effective > 0 ? 1 : 0;

    const sorties = await enParallele(plan.lot, Math.max(1, plan.lot.length), async (step) => {
      const reserve = await reserver(step, clock);
      if (!reserve) return null;
      return executerUneEtape(frais, step, actor, deps, clock);
    });

    for (const s of sorties) {
      if (!s) continue;
      if (s.kind === "expansion") { res.deployees += s.n; continue; }
      if (s.dedupliquee) res.dedupliquees += 1;
      if (s.echouee) res.echouees += 1; else res.executees += 1;
    }

    res.status = await synchroniserEtat(missionId, await chargerEtat(missionId) ?? frais);
  }

  res.enPause = true;
  return res;
}

/**
 * AMÈNE LA MISSION À `RUNNING` AVANT DE TOUCHER À QUOI QUE CE SOIT.
 *
 * ── POURQUOI CE PASSAGE EXISTE, ET POURQUOI IL EST EXPLICITE ─────────────────────────────
 *
 * L'état déduit des étapes (`deduireEtat`) décrit une mission QUI TRAVAILLE : « il reste des
 * dépendances », « une branche attend ». Ces états ne se rejoignent pas depuis `PLANNING` — et
 * c'est voulu : une mission qui n'a jamais démarré ne peut pas être « en attente d'événement »,
 * elle est simplement en attente de départ.
 *
 * La première écriture de ce moteur l'avait oublié, et la machine à états a refusé la
 * transition plutôt que de laisser une mission dans un état qu'aucune séquence légale ne
 * produit. C'est exactement ce pour quoi elle existe.
 *
 * `PLANNING → READY` n'est pas un pas de plus pour rien : `READY` signifie « le plan est écrit
 * en base et personne ne l'a encore lancé », ce qui est l'état réel entre la compilation et le
 * premier tour, et l'état auquel une porte d'approbation de PÉRIMÈTRE viendra s'accrocher.
 */
async function demarrer(etat: EtatMission): Promise<void> {
  if (etat.status === "PLANNING") {
    await transitionner(etat.id, "READY", "plan écrit en base");
    etat.status = "READY";
  }
  if (etat.status !== "RUNNING") {
    await transitionner(etat.id, "RUNNING", "le moteur prend la main");
    etat.status = "RUNNING";
  }
}
