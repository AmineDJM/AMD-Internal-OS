import { prisma } from "@/lib/prisma";
import type {
  CapabilityCatalog, CapabilityRunner, Clock, MissionActor, RegistreRecours, PorteAttention,
} from "@/lib/missions/ports";
import { lireReponse } from "@/lib/missions/runtime/reponse";
import { verifierAvantAgir } from "@/lib/missions/agent/principal";
import { systemClock } from "@/lib/missions/ports";
import { prendreBail } from "@/lib/missions/runtime/bail";
import { limitesDe, ordonnancer } from "@/lib/missions/runtime/scheduler";
import {
  MissionState, STEP_TERMINAL, StepState, assertStepTransition, deduireEtat,
} from "@/lib/missions/runtime/state";
import {
  EtatEtape, EtatMission, chargerEtat, cleIdempotence, compter, journaliser, transitionner,
} from "@/lib/missions/runtime/store";
import { lireInterrupteurMissions, type LecteurInterrupteur } from "@/lib/interrupteurs/missions";
import {
  diagnostiquerReferences, entreeIteration, identiteIteration, injecterSorties, lire, referencesDe,
  type DiagnosticReference, type SortieAmont,
} from "@/lib/missions/runtime/interpolate";
import { expliquer, resoudreCollection } from "@/lib/missions/runtime/collection";
import { classer } from "@/lib/registre/manques";
import {
  aReparer, controlerQualite, evaluerObjectif,
  type EtapeObservee, type JugeObjectif, type JugementAnterieur,
} from "@/lib/missions/goal/evaluate";
import { attenduDe, evaluerResultat } from "@/lib/missions/recovery/evaluate";
import { verifierContrat } from "@/lib/missions/registry/result-contract";
import { ERROR_KINDS, utilisablePourAgir, type ErrorKind, type Strategy } from "@/lib/missions/recovery/strategy";
import {
  deciderRecours, historiqueDe, noter, peutConclureEtape, type ResolveursRecours,
} from "@/lib/missions/recovery/coordinator";
import { elargirEntree, memeAppel, type ActionRecours } from "@/lib/missions/recovery/action";
import { EFFECT_RANK, capabilityMeta, type Effect } from "@/lib/missions/registry/capability-meta";
import { evaluerCondition, lireCondition } from "@/lib/missions/runtime/condition";
import { lireAttente, lireProgres } from "@/lib/missions/events/match";
import { resultatJonction } from "@/lib/missions/runtime/sorties";
import { rattraperFaitAnterieur } from "@/lib/missions/events/router";
import { fabriquerRecu, type ExecutionReceipt } from "@/lib/missions/runtime/receipt";
import { vueParentEventail } from "@/lib/missions/runtime/worker";
import { sansBloquer } from "@/lib/journal";

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
 */

/**
 * LA DURÉE AU-DELÀ DE LAQUELLE UNE ÉTAPE « EN COURS » EST CONSIDÉRÉE ORPHELINE.
 *
 * Un processus tué laisse ses étapes en `RUNNING` pour toujours : personne ne viendra les
 * terminer, et sans reprise la mission serait figée. On les reprend donc — ce qui n'est sûr QUE
 * parce que la clé d'idempotence protège la reprise d'un effet déjà produit.
 */
export const BAIL_MS = 10 * 60 * 1000;

export interface StepContext {
  mission: EtatMission;
  step: EtatEtape;
  actor: MissionActor;
  clock: Clock;
}

/** Ce qu'un gestionnaire de nœud rend au moteur. Rien d'autre n'est écrit en base par lui. */
export type StepOutcome =
  | { status: "DONE"; result?: unknown; receipt?: string; recu?: ExecutionReceipt }
  | { status: "WAITING"; raison: string; result?: unknown }
  | { status: "SKIPPED"; raison: string }
  /**
   * `recu` SUR UN ÉCHEC AUSSI — « nous avons interrogé cette source et cela n'a rien donné » est
   * une information, et c'est celle qui distingue une piste non explorée d'une piste explorée
   * sans succès. `fabriquerRecu` le disait déjà ; le reçu était fabriqué puis jeté, faute d'un
   * champ pour le porter jusqu'à `ecrireSortie`.
   */
  | { status: "FAILED"; error: string; errorKind: string; retryable: boolean; recu?: ExecutionReceipt };

export interface StepHandlers {
  WORKER?: (ctx: StepContext) => Promise<StepOutcome>;
  APPROVAL?: (ctx: StepContext) => Promise<StepOutcome>;
  QA?: (ctx: StepContext) => Promise<StepOutcome>;
  ARTIFACT?: (ctx: StepContext) => Promise<StepOutcome>;
  WAIT_EVENT?: (ctx: StepContext) => Promise<StepOutcome>;
  WAIT_INPUT?: (ctx: StepContext) => Promise<StepOutcome>;
}

export interface EngineDeps {
  runner: CapabilityRunner;
  /**
   * LE LECTEUR DE L'INTERRUPTEUR GLOBAL DES MISSIONS (§118.132). Défaut : le VRAI
   * (`lireInterrupteurMissions`, la ligne `AppSetting.global`). Un banc l'injecte pour éprouver la
   * suspension sans poser l'interrupteur réel — qui est partagé par tous les tests qui tournent
   * en parallèle sur la même base. Aucun appelant de production ne le remplace ; un test de
   * point d'appel le vérifie, parce qu'un lecteur remplacé désarmerait l'interrupteur en
   * silence.
   */
  interrupteur?: LecteurInterrupteur;
  /**
   * LE CATALOGUE, pour la SECONDE vérification de politique (§29).
   *
   * Facultatif, et son absence a une conséquence dite : sans lui, seul le compilateur garde
   * l'interdit d'auto-escalade. Le fournir ajoute une garde au moment d'agir, qui couvre les
   * étapes arrivées AUTREMENT que par un plan compilé — une reprise, une réparation, une
   * insertion directe. C'est le seul contrôle volontairement dupliqué du runtime.
   */
  catalog?: CapabilityCatalog;
  handlers?: StepHandlers;
  clock?: Clock;
  /**
   * LE JUGE DE L'OBJECTIF (§20). Facultatif — et son absence a une conséquence ASSUMÉE : sans
   * lui, la mission n'est jamais déclarée atteinte. Le moteur ne conclut pas faute de juge ; il
   * s'arrête en disant que le travail est fait mais que personne ne l'a vérifié.
   */
  juge?: JugeObjectif;
  /**
   * LE REGISTRE DE RECOURS (§77) — ce qui rend « essaie ailleurs » exécutable.
   *
   * Facultatif, et son absence a une conséquence DITE : sans lui, `AUTRE_SOURCE` n'a aucune
   * capacité de remplacement à proposer, le barreau est sauté, et l'échelle descend vers ce
   * qui agit réellement. C'est très exactement l'état d'avant ce lot — à ceci près qu'il ne
   * s'annonce plus comme un recours.
   */
  registre?: RegistreRecours;
  /**
   * LA PORTE D'ATTENTION (port) — par où le moteur DIT au dirigeant qu'une mission a conclu,
   * s'est bloquée ou a échoué. Absente, le moteur se tait et le journal reste la seule trace :
   * un banc qui n'en fournit pas ne dérange personne.
   */
  attention?: PorteAttention;
  /** Borne le nombre de tours d'un même appel — protège d'un graphe pathologique, pas du volume. */
  maxTours?: number;
}

export interface TickResult {
  missionId: string;
  status: MissionState;
  executees: number;
  echouees: number;
  deployees: number;
  dedupliquees: number;
  tours: number;
  /** Vrai quand plus rien ne peut avancer sans un événement extérieur. */
  enPause: boolean;

  /**
   * ── CE QUE L'ORDONNANCEUR A RÉELLEMENT OBTENU (§44) ───────────────────────────────────
   *
   * Sans ces trois chiffres, « la mission est parallèle » est une affirmation. Avec eux, c'est
   * une mesure — et surtout on sait POURQUOI elle ne l'est pas quand elle ne l'est pas :
   * `differees > 0` dit qu'un quota a mordu, `differees === 0` avec une concurrence de 1 dit
   * que c'est le GRAPHE qui est en série. Les deux diagnostics appellent des corrections
   * opposées, et les confondre fait optimiser au mauvais endroit.
   */
  concurrenceMax: number;
  concurrenceCumulee: number;
  toursExecutants: number;
  /** Combien d'étapes étaient prêtes et n'ont pas eu de place. La file d'attente, mesurée. */
  differees: number;
  /**
   * Vrai quand une AUTRE instance vivante conduit cette mission : ce processus n'a pas pris le
   * bail et n'a rien fait (§ bail). Ce n'est ni une pause ni un échec — c'est « pas moi ».
   */
  bailRefuse?: boolean;
  /**
   * Vrai quand l'INTERRUPTEUR GLOBAL est posé (§118.132) : ce processus n'a rien exécuté, rien
   * jugé, rien signalé — et la mission n'a pas changé d'état. Distinct de `bailRefuse` (« pas
   * moi ») et de `PAUSED` (« pas celle-ci ») : c'est « personne, sur aucune ».
   */
  suspenduGlobalement?: boolean;
}

const estTerminal = (s: StepState): boolean => STEP_TERMINAL.has(s);

/**
 * CE QUE L'ORDONNANCEUR SAIT D'UNE CAPACITÉ — son domaine et sa classe de latence.
 *
 * `capabilityMeta` DÉRIVE une métadonnée prudente pour ce qui n'est pas déclaré, donc cet
 * adaptateur ne peut pas échouer sur une capacité inconnue : il rendra la classe la plus
 * conservatrice, ce qui est le bon défaut pour un ordonnanceur.
 */
/**
 * L'EFFET LE PLUS FORT QUE CE CATALOGUE AURAIT LAISSÉ PASSER.
 *
 * Sans catalogue on rend le plafond le plus large, ce qui rend l'attestation d'effets plus
 * FAIBLE — jamais plus forte. C'est le bon sens de l'erreur : une mission qui n'a pas su dire
 * son plafond ne doit pas paraître plus vertueuse qu'une mission qui l'a dit.
 */
function plafondDuCatalogue(cat: CapabilityCatalog | undefined, actor: MissionActor): Effect {
  if (!cat) return "SECURITY_ADMIN";
  const ouvertes = cat.brief(actor);
  if (ouvertes.length === 0) return "READ";
  return ouvertes.reduce<Effect>(
    (max, b) => (EFFECT_RANK[b.effect] > EFFECT_RANK[max] ? b.effect : max), "READ");
}

const profilCapacite = (id: string) => {
  const m = capabilityMeta(id);
  return { domain: m.domain, latency: m.latency };
};

/**
 * LA MÉTADONNÉE D'UNE CAPACITÉ, VUE DU MOTEUR — le catalogue d'abord, le registre nu ensuite.
 *
 * `capabilityMeta(nom)` sans liste d'écritures ne sait pas si une capacité écrit : elle rend
 * alors le défaut PRUDENT (EXTERNAL_COMMUNICATION) — le bon défaut pour un compilateur qui doit
 * demander un accord, le mauvais pour un REÇU qui doit dire ce qui s'est passé. Mesuré sur le
 * banc d'acceptance : une lecture `find_documents` ajoutée par la voie directe recevait un reçu
 * « EXTERNAL_COMMUNICATION », le contrôle qualité lui réclamait un reçu d'intent qu'une lecture
 * n'a pas, et le banc concluait « effet exécuté au-delà du plafond ANALYZE » sur une mission
 * qui n'avait rien écrit. Le catalogue que le composeur a construit porte la liste d'écritures :
 * c'est lui qui fait foi quand il connaît la capacité.
 */
const metaDe = (capability: string, catalog: CapabilityCatalog | undefined) =>
  catalog?.has(capability) ? catalog.meta(capability) : capabilityMeta(capability);

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

/**
 * LES ÉTAPES QUI PEUVENT PARTIR.
 *
 * ── DEUX PORTES D'ENTRÉE, ET ELLES NE DISENT PAS LA MÊME CHOSE ──────────────────────────
 *
 * `PENDING` = « attend ses dépendances » ; le graphe décide.
 * `READY`   = « quelqu'un l'a remise en file » ; une décision extérieure a eu lieu.
 *
 * La seconde existe pour l'approbation : une porte en attente que le PDG vient d'accorder doit
 * être RÉÉVALUÉE, et une étape en attente ne l'est jamais. Sans ce chemin, une mission
 * approuvée restait bloquée sur sa propre porte — l'accord était donné et rien ne repartait.
 *
 * `SKIPPED` compte comme terminée pour les dépendances : une branche écartée ne retient pas sa
 * descendance en otage (le pendant d'exécution de §37).
 */
function etapesPretes(etat: EtatMission): EtatEtape[] {
  const parCle = new Map(etat.steps.map((s) => [s.key, s]));
  return etat.steps.filter((s) => {
    // UNE ÉTAPE QUE LE PLAN COURANT NE PORTE PLUS NE S'EXÉCUTE PAS. Elle reste au dossier ;
    // la relancer ferait travailler la mission pour un plan qu'elle a abandonné.
    if (s.contournee) return false;
    if (s.status === "READY") return true;
    if (s.status !== "PENDING") return false;
    const amonts = s.dependsOn.map((d) => parCle.get(d)).filter((d): d is EtatEtape => d !== undefined);
    // DU MATÉRIAU VIVANT : au moins un amont a ABOUTI. C'est ce qui distingue « synthétiser ce
    // qu'on a, en disant ce qui manque » de « conclure à partir de rien ».
    const materiel = amonts.some((d) => d.status === "DONE");
    return amonts.every((dep) => {
      /**
       * UNE DÉPENDANCE CONTOURNÉE NE RETIENT PERSONNE. Le journal du replan le promet —
       * « elles ne bloquent plus » — et un run Render (2026-08-29) a montré ce que coûte de
       * ne pas le tenir : une étape FAILED du plan v1, contournée par v2 (FAILED n'est pas
       * ACQUIS), n'est ni terminale ni exécutable — sa descendante attendait pour TOUJOURS,
       * la mission s'immobilisait en WAITING_DEPENDENCY sans recours ni replanification.
       * Même principe que SKIPPED (§37) : l'étape partira avec ce que ses amonts vivants ont
       * produit, et le worker DIT ce qui lui manque.
       */
      return dependanceSatisfaite(dep, s, materiel);
    });
  });
}

/** Les nœuds qui SYNTHÉTISENT : ils lisent ce que leurs amonts ont produit, et disent ce qui manque. */
const SYNTHESE: ReadonlySet<string> = new Set(["WORKER", "QA", "JOIN", "ARTIFACT"]);

/** Une étape MORTE : en échec, toutes ses tentatives consommées — plus rien ne la fera aboutir seule. */
const estMorte = (dep: Pick<EtatEtape, "status" | "attempt" | "maxAttempts">): boolean =>
  dep.status === "FAILED" && dep.attempt >= dep.maxAttempts;

/**
 * « CETTE DÉPENDANCE LAISSE-T-ELLE PASSER ? » — pure, exportée pour être testée au cas près.
 *
 * Terminale (DONE, SKIPPED, CANCELLED) ou contournée : oui, pour tout le monde. MORTE : oui pour
 * un nœud de SYNTHÈSE seulement, et seulement s'il a DU MATÉRIAU — au moins un autre amont
 * abouti. Le banc l'a montré sur l'enquête d'une facture : une lecture de pièces en échec
 * définitif tenait en otage l'analyse, l'accord et le contrôle — la mission finissait BLOQUÉE
 * sans avoir rien conclu, alors que l'analyste avait sept lectures réussies sous la main. Un
 * worker part avec ce que ses amonts vivants ont produit et DIT ce qui lui manque ; le juge
 * tranche ensuite.
 *
 * Deux bornes, chacune pour une raison :
 *   • une CAPABILITY reste retenue : écrire à partir d'une lecture qui a échoué, c'est écrire
 *     sur du vide ;
 *   • une synthèse dont TOUS les amonts sont morts reste retenue : « conclure malgré tout »
 *     sans matériau, c'est inventer — le faux succès que §10 interdit. La mission passe alors
 *     BLOCKED (`deduireEtat`, règle 4) et c'est la REPLANIFICATION qui décide, pas le moteur.
 */
export function dependanceSatisfaite(
  dep: Pick<EtatEtape, "status" | "attempt" | "maxAttempts" | "contournee">,
  dependant: Pick<EtatEtape, "nodeType">,
  /** Le dépendant a-t-il au moins un amont ABOUTI (DONE) ? Sans matériau, rien ne part. */
  materiel: boolean,
): boolean {
  if (dep.contournee || estTerminal(dep.status)) return true;
  return estMorte(dep) && SYNTHESE.has(dependant.nodeType) && materiel;
}

/**
 * RÉSERVE UNE ÉTAPE. C'est la base qui arbitre, pas la politesse des appelants.
 *
 * `updateMany` avec la condition sur l'état ancien rend zéro ligne si un autre processus est
 * passé avant. Sans cette condition, deux instances du moteur — la web et la tâche de fond —
 * exécuteraient la même étape, et l'idempotence ne rattraperait que les écritures.
 */
async function reserver(step: EtatEtape, clock: Clock): Promise<boolean> {
  const r = await prisma.missionStep.updateMany({
    where: { id: step.id, status: { in: ["PENDING", "READY"] } },
    data: { status: "RUNNING", attempt: { increment: 1 }, startedAt: clock.now() },
  });
  return r.count === 1;
}

/**
 * REPREND LES ÉTAPES LAISSÉES « EN COURS » PAR UN PROCESSUS MORT.
 *
 * Sans cela, un redémarrage de Render au mauvais moment fige la mission pour toujours. Avec
 * cela — et grâce à la clé d'idempotence — la reprise est sûre : l'effet déjà produit n'est pas
 * reproduit, seul le reçu est retrouvé.
 */
async function reprendreOrphelines(missionId: string, clock: Clock): Promise<void> {
  const limite = new Date(clock.now().getTime() - BAIL_MS);
  const orphelines = await prisma.missionStep.findMany({
    where: { missionId, status: "RUNNING", startedAt: { lt: limite } },
    select: { id: true, key: true },
  });
  for (const o of orphelines) {
    await prisma.missionStep.updateMany({
      where: { id: o.id, status: "RUNNING" },
      data: { status: "PENDING", error: "reprise après interruption du processus" },
    });
    await journaliser(missionId, "STEP_RECLAIMED",
      `Étape « ${o.key} » reprise : le processus qui l'exécutait ne répond plus.`, { stepKey: o.key });
  }
}

/** Remet en file les étapes échouées à qui il reste des tentatives (§13). */
async function relancerReparables(missionId: string): Promise<number> {
  const r = await prisma.missionStep.updateMany({
    where: { missionId, status: "FAILED", attempt: { lt: prisma.missionStep.fields.maxAttempts } },
    data: { status: "PENDING" },
  });
  if (r.count > 0) {
    await journaliser(missionId, "STEP_RETRY", `${r.count} étape(s) remise(s) en file pour une nouvelle tentative.`);
  }
  return r.count;
}

type Sortie =
  | { kind: "expansion"; n: number }
  | { kind: "etape"; echouee: boolean; dedupliquee: boolean };

/**
 * EXÉCUTE UNE ÉTAPE, et écrit le résultat. C'EST le point de reprise (§14).
 *
 * L'écriture suit immédiatement l'exécution, sans regrouper : différer pour « écrire par lot »
 * ferait perdre exactement le travail qu'on cherche à ne pas refaire.
 */
/** Les nœuds dont l'entrée ou l'attente peut lire la sortie d'une étape amont. */
const NOEUDS_A_RESOUDRE: ReadonlySet<string> = new Set(["CAPABILITY", "WORKER", "ARTIFACT", "WAIT_EVENT", "WAIT_INPUT"]);

/** Les échéances d'une attente, dans un ordre stable — pour comparer l'écrit et le résolu. */
function echeancesDe(w: Record<string, unknown> | null): unknown[] {
  if (!w) return [];
  const branches = (k: string): unknown[] =>
    Array.isArray(w[k]) ? (w[k] as unknown[]).map((b) => (b && typeof b === "object" ? (b as Record<string, unknown>).until : undefined)) : [];
  return [w.until, ...branches("anyOf"), ...branches("allOf")];
}

/** « 30/11/2026 » → « 2026-11-30 » : la seule forme de date qu'on normalise, parce qu'elle est sans ambiguïté en français. */
function normaliserDate(u: unknown): unknown {
  if (typeof u !== "string") return u;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(u.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : u;
}

/**
 * RÉSOUT LES RÉFÉRENCES D'UNE ÉTAPE contre les sorties de la mission — ou dit pourquoi elle ne
 * peut pas partir. Pure vis-à-vis de la base : la persistance de l'attente résolue est faite
 * par l'appelant, une fois, et seulement si quelque chose a changé.
 */
function resoudreReferencesEtape(
  etat: EtatMission,
  step: EtatEtape,
): { step: EtatEtape; sortie?: StepOutcome; attenteResolue: boolean; phrases?: DiagnosticReference[] } {
  if (!NOEUDS_A_RESOUDRE.has(step.nodeType)) return { step, attenteResolue: false };
  if (referencesDe(step.input).length === 0 && referencesDe(step.waitFor).length === 0) return { step, attenteResolue: false };

  /**
   * LE PARENT D'UN ÉVENTAIL EST VU PAR SES FILLES, pas par sa comptabilité (§118.20).
   *
   * Sans `vueParentEventail`, `{{lire:contrats.texte}}` tombe sur `{ done, keys, failed,
   * expanded }` dès que l'étape amont s'est démultipliée — et toute sa descendance meurt sur
   * « l'étape a abouti mais ne rend pas « texte » ». Mesuré : 24 étapes tuées sur une seule
   * mission par une référence que le planificateur avait écrite JUSTE.
   *
   * `vueParentEventail` rend `null` sur une étape qui n'est pas un parent d'éventail : les
   * étapes ordinaires gardent exactement leur résultat, au bit près.
   */
  const sorties = new Map<string, SortieAmont>();
  for (const s of etat.steps) {
    if (s.key === step.key) continue;
    sorties.set(s.key, { status: s.status, result: vueParentEventail(s, etat) ?? s.result });
  }
  const diagnostics = [...diagnostiquerReferences(step.input, sorties), ...diagnostiquerReferences(step.waitFor, sorties)];
  const gab = (d: DiagnosticReference) => `{{${d.ref}}}`;
  const echec = (error: string): StepOutcome => ({ status: "FAILED", error, errorKind: "INVALID_STEP", retryable: false });

  // L'ORDRE EST CELUI DE L'INFORMATION : une faute de plan (étape inconnue, chemin absent) se dit
  // avant une absence de matière (liste vide, amont non abouti) — sinon le saut la masquerait.
  const inconnue = diagnostics.find((d) => d.etat === "ETAPE_INCONNUE");
  if (inconnue) {
    return { step, attenteResolue: false, sortie: echec(`« ${gab(inconnue)} » désigne une étape « ${inconnue.etape} » absente de la mission.`) };
  }
  const absent = diagnostics.find((d) => d.etat === "CHEMIN_ABSENT");
  if (absent) {
    const dispo = absent.disponibles.length > 0
      ? `champs disponibles : ${absent.disponibles.join(", ")}`
      : "elle ne rend aucun champ à cet endroit";
    return { step, attenteResolue: false, sortie: echec(`« ${gab(absent)} » : l'étape « ${absent.etape} » a abouti mais ne rend pas « ${absent.chemin} » — ${dispo}.`) };
  }
  const vide = diagnostics.find((d) => d.etat === "COLLECTION_VIDE");
  if (vide) {
    return { step, attenteResolue: false, sortie: { status: "SKIPPED", raison: `rien à traiter : « ${gab(vide)} » — la liste rendue par l'étape « ${vide.etape} » est vide.` } };
  }
  const nonAboutie = diagnostics.find((d) => d.etat === "ETAPE_NON_ABOUTIE");
  if (nonAboutie && !SYNTHESE.has(step.nodeType)) {
    return { step, attenteResolue: false, sortie: { status: "SKIPPED", raison: `« ${gab(nonAboutie)} » attend l'étape « ${nonAboutie.etape} », qui n'a pas abouti (${nonAboutie.statut ?? "?"}).` } };
  }

  // LA TRADUCTION EST REMONTÉE, JAMAIS TAISÉE. Un filtre silencieux ne laisse aucune trace de ce
  // qu'il retire (§118.52) ; ici rien n'est retiré, mais le plan a demandé un CHAMP et reçu une
  // PHRASE — c'est le genre de fait dont le compte rendu d'une mission a besoin, et le seul
  // signal qui dise au lecteur pourquoi une consolidation parle d'une absence.
  const phrases = diagnostics.filter((d) => d.etat === "PHRASE_ENTIERE");

  const valeurs = new Map<string, unknown>();
  for (const [k, v] of sorties) if (v.status === "DONE") valeurs.set(k, v.result);
  const input = injecterSorties(step.input, valeurs) as Record<string, unknown>;
  const waitFor = step.waitFor ? (injecterSorties(step.waitFor, valeurs) as Record<string, unknown>) : null;
  const attenteResolue = waitFor !== null && JSON.stringify(waitFor) !== JSON.stringify(step.waitFor);

  if (attenteResolue && step.nodeType === "WAIT_EVENT" && waitFor) {
    // UNE ÉCHÉANCE DÉRIVÉE DOIT ÊTRE UNE DATE. « {{analyse.dateEcheance}} » qui se résout à
    // rien, ou à « fin novembre », ferait dormir la mission pour toujours : on échoue tout de
    // suite, avec la valeur, et la replanification a de quoi corriger.
    if ("until" in waitFor) waitFor.until = normaliserDate(waitFor.until);
    for (const k of ["anyOf", "allOf"]) {
      if (!Array.isArray(waitFor[k])) continue;
      for (const b of waitFor[k] as unknown[]) {
        if (b && typeof b === "object" && "until" in (b as Record<string, unknown>)) {
          (b as Record<string, unknown>).until = normaliserDate((b as Record<string, unknown>).until);
        }
      }
    }
    const ecrites = echeancesDe(step.waitFor);
    const resolues = echeancesDe(waitFor);
    for (let i = 0; i < ecrites.length; i += 1) {
      if (typeof ecrites[i] !== "string" || referencesDe(ecrites[i]).length === 0) continue;
      const r = resolues[i];
      if (typeof r !== "string" || r.trim() === "" || !Number.isFinite(Date.parse(r))) {
        return { step, attenteResolue: false, sortie: echec(`l'échéance dérivée « ${String(ecrites[i])} » vaut « ${r === undefined || r === null ? "" : String(r)} », qui n'est pas une date lisible : cette attente ne se réveillerait jamais.`) };
      }
    }
  }
  return { step: { ...step, input, waitFor }, attenteResolue, phrases };
}

async function executerUneEtape(
  etat: EtatMission,
  step: EtatEtape,
  actor: MissionActor,
  deps: EngineDeps,
  clock: Clock,
): Promise<Sortie> {
  // ── L'ÉTAPE CONDITIONNELLE : la condition se lit AVANT tout, éventail compris ──────────
  //
  // « Si pas de réponse avant vendredi, relance » : l'étape « relance » dépend de l'attente,
  // et ne part que si l'attente s'est réglée par le TEMPS. Non remplie, elle est IGNORÉE —
  // le journal dit pourquoi, avec les valeurs — et la suite du plan continue (§37).
  const condition = lireCondition(step.spec?.when);
  if (condition) {
    const amont = etat.steps.find((s) => s.key === condition.step);
    const verdict = evaluerCondition(condition, amont ? { status: amont.status, result: amont.result } : undefined);
    if (!verdict.remplie) {
      await ecrireSortie(etat, step, { status: "SKIPPED", raison: `condition non remplie — ${verdict.raison}` }, clock);
      return { kind: "etape", echouee: false, dedupliquee: false };
    }
  }

  // L'ÉVENTAIL SE DÉPLOIE AVANT TOUT AUTRE TRAITEMENT : ce n'est pas une étape à exécuter, c'est
  // une étape qui en fabrique d'autres.
  if (step.forEach) {
    const n = await deployerEventail(etat, step, step.forEach);
    return { kind: "expansion", n };
  }

  // ── LA TUYAUTERIE ENTRE ÉTAPES : `{{cle_etape.chemin}}` se résout ICI, avant tout appel ──
  //
  // Le planificateur compose ses étapes en lisant la sortie des précédentes ; le moteur, lui,
  // ne résolvait que les alias d'éventail, et « {{analyse:coherence.actionPaiement}} » partait
  // en toutes lettres vers l'outil (banc m5 : quatre plans sur neuf). Le diagnostic précède
  // l'injection : un chemin absent ÉCHOUE en nommant les champs rendus, une liste amont vide
  // IGNORE l'étape, une étape amont non aboutie n'invente rien.
  const resolution = resoudreReferencesEtape(etat, step);
  const stepExec = resolution.step;
  for (const p of resolution.phrases ?? []) {
    // Le fait, pas une interprétation : quel champ a été demandé, à quelle étape, et ce qu'elle
    // a répondu à la place. Écrit UNE fois par référence traduite, donc jamais du bruit.
    await journaliser(
      etat.id,
      "REFERENCE_TRADUITE",
      `« {{${p.ref}}} » : l'étape « ${p.etape} » a répondu par une PHRASE, sans aucun champ — `
      + `sa réponse entière remplace « ${p.chemin} ». La capacité a bien répondu ; sa réponse `
      + "n'était pas structurée.",
      { step: step.key, ref: p.ref, etape: p.etape, chemin: p.chemin },
    );
  }
  if (resolution.attenteResolue) {
    // L'ATTENTE DEVIENT CONCRÈTE EN BASE : le balayage temporel lit `waitFor.until` tel quel,
    // et une référence non résolue ne réveillerait jamais personne.
    await prisma.missionStep.update({ where: { id: step.id }, data: { waitFor: (stepExec.waitFor ?? null) as never } });
  }

  const ctx: StepContext = { mission: etat, step: stepExec, actor, clock };
  let sortie: StepOutcome;
  if (resolution.sortie) {
    sortie = resolution.sortie;
  } else {
    try {
      sortie = await dispatcher(ctx, deps);
    } catch (e) {
      sortie = {
        status: "FAILED",
        error: e instanceof Error ? e.message : String(e),
        errorKind: "CAPABILITY_FAILURE",
        retryable: true,
      };
    }
  }

  // ── §5 — RÉUSSITE TECHNIQUE ≠ RÉUSSITE SÉMANTIQUE ──────────────────────────────────
  //
  // Une capacité qui rend 200 avec le mauvais document a réussi son appel, pas l'objectif.
  // L'évaluation est déterministe et ne coûte aucun appel de modèle ; en l'absence de
  // critère (`spec.attendu`), elle se tait et le résultat passe tel quel.
  if (sortie.status === "DONE" && sortie.receipt !== "DEDUPLIQUE") {
    const verdict = evaluerResultat(attenduDe(step.spec), sortie.result);
    // §107-109 — C'EST LA CERTITUDE QUI AUTORISE À AGIR, pas l'absence d'erreur.
    //
    // Un CANDIDAT peut guider la recherche suivante ; il ne peut pas satisfaire l'objectif ni
    // déclencher un effet externe. En passant par `utilisablePourAgir`, l'acceptation d'une
    // étape est gouvernée par l'échelle TROUVÉ / DÉDUIT / CANDIDAT / INCONNU — et non par un
    // test local qui lui ressemblerait.
    if (verdict.kind || !utilisablePourAgir(verdict.certitude)) {
      sortie = {
        status: "FAILED",
        error: verdict.raison,
        // `kind` est nul seulement quand la certitude vaut TROUVÉ ; on ne peut donc pas
        // arriver ici sans cause. Le repli nomme quand même la seule qui aurait du sens.
        errorKind: verdict.kind ?? "INSUFFICIENT_DATA",
        // Rejouer À L'IDENTIQUE ne changerait rien : c'est le CHEMIN qu'il faut changer, et
        // c'est le recours local qui en décide juste en dessous.
        retryable: false,
      };
    }
  }

  // ── §10 — LE RECOURS LOCAL, AVANT D'ÉPUISER L'ÉTAPE ────────────────────────────────
  if (sortie.status === "FAILED") {
    const repris = await tenterRecours(etat, stepExec, sortie, clock, { registre: deps.registre, acteur: actor, catalog: deps.catalog });
    if (repris) return { kind: "etape", echouee: false, dedupliquee: false };
  }

  await ecrireSortie(etat, step, sortie, clock);
  return {
    kind: "etape",
    echouee: sortie.status === "FAILED",
    dedupliquee: sortie.status === "DONE" && sortie.receipt === "DEDUPLIQUE",
  };
}

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

async function tenterRecours(
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

/**
 * TRADUIT L'ACTION EN (CAPACITÉ, ENTRÉE) EFFECTIVES — le seul endroit qui touche l'étape.
 *
 * `courante` est rendue telle quelle quand l'action ne change pas de capacité : rendre `null`
 * ferait croire à un changement à la comparaison qui suit, et l'on écrirait `capability: null`
 * en base sur une étape qui en a une.
 */
function appliquer(
  action: ActionRecours,
  courante: string | null,
  entree: Record<string, unknown>,
): { capability: string | null; input: Record<string, unknown> } {
  switch (action.type) {
    case "AUTRE_CAPACITE":
      return { capability: action.capability, input: action.input };
    case "REQUETE_ELARGIE":
      return { capability: courante, input: action.input };
    case "REJEU":
      return { capability: courante, input: entree };
  }
}

/** Aiguille selon le type de nœud. Les types de CONTRÔLE ont un comportement natif. */
async function dispatcher(ctx: StepContext, deps: EngineDeps): Promise<StepOutcome> {
  const { step } = ctx;
  const h = deps.handlers ?? {};

  switch (step.nodeType) {
    case "JOIN":
      // Une jonction ne fait rien : ses dépendances étant terminées, elle l'est aussi. Son
      // existence sert à réduire le nombre d'arêtes, pas à produire quoi que ce soit — les
      // DONNÉES, elles, la traversent (`amontDeLEtape`), et le compilateur refuse d'y lire
      // autre chose que son compteur.
      return { status: "DONE", result: resultatJonction(step.dependsOn.length) };

    case "WAIT_EVENT": {
      if (h.WAIT_EVENT) return h.WAIT_EVENT(ctx);
      // ── LES FAITS DÉJÀ ARRIVÉS (événements dans le désordre) ────────────────────────────
      //
      // Avant de dormir, l'attente regarde si ce qu'elle attend est DÉJÀ au registre — arrivé
      // pendant l'accord, la lecture amont, ou entre deux tours. La fenêtre commence à la fin
      // de la dernière dépendance qui ÉCRIT (la demande) : un fait antérieur à la demande n'est
      // pas une réponse. Une progression partielle (« le contrat ET le devis » : le contrat
      // déjà là) est persistée avec l'attente.
      const attente = lireAttente(step.waitFor);
      if (attente) {
        const clesEcritures = step.dependsOn.filter((k) => {
          const d = ctx.mission.steps.find((x) => x.key === k);
          return d?.capability ? EFFECT_RANK[metaDe(d.capability, deps.catalog).effect] >= EFFECT_RANK.INTERNAL_REVERSIBLE_WRITE : false;
        });
        const deja = lireProgres(step.result);
        const r = await rattraperFaitAnterieur({ missionId: ctx.mission.id, stepKey: step.key, attente, dejaReglees: deja, clesEcritures, maintenant: ctx.clock.now() });
        if (r.complete && r.fait) {
          return { status: "DONE", result: { reveillePar: r.fait.type, ...lireReponse(r.fait.payload), payload: (r.fait.payload ?? null) as never, attenteProgres: r.reglees, rattrape: true } };
        }
        if (r.reglees.length > deja.length) {
          return { status: "WAITING", raison: `attend l'événement ${String(step.waitFor?.event ?? "?")} (une partie déjà arrivée)`, result: { attenteProgres: r.reglees } };
        }
      }
      return { status: "WAITING", raison: `attend l'événement ${String(step.waitFor?.event ?? "?")}` };
    }

    case "WAIT_INPUT":
      return h.WAIT_INPUT
        ? h.WAIT_INPUT(ctx)
        : { status: "WAITING", raison: String(step.waitFor?.ask ?? "attend un élément humain") };

    case "APPROVAL":
      return h.APPROVAL
        ? h.APPROVAL(ctx)
        // SANS GESTIONNAIRE D'APPROBATION, ON ATTEND — jamais on ne passe. Le défaut d'une porte
        // est d'être fermée : l'inverse ferait d'une brique manquante une autorisation tacite.
        : { status: "WAITING", raison: "attend une approbation" };

    case "WORKER":
      return h.WORKER
        ? h.WORKER(ctx)
        : { status: "FAILED", error: "aucun exécutant de worker n'est branché", errorKind: "MISSING_WORKER", retryable: false };

    case "QA":
      return h.QA ? h.QA(ctx) : { status: "SKIPPED", raison: "aucun contrôleur qualité n'est branché" };

    case "ARTIFACT":
      return h.ARTIFACT
        ? h.ARTIFACT(ctx)
        : { status: "FAILED", error: "aucune fabrique d'artefact n'est branchée", errorKind: "MISSING_ARTIFACT", retryable: false };

    case "CAPABILITY":
    default:
      return executerCapacite(ctx, deps);
  }
}

/** L'appel d'une capacité, avec sa clé d'idempotence quand l'étape en réclame une. */
async function executerCapacite(ctx: StepContext, deps: EngineDeps): Promise<StepOutcome> {
  const { step, mission, actor } = ctx;
  if (!step.capability) {
    return { status: "FAILED", error: "étape CAPABILITY sans capacité", errorKind: "INVALID_STEP", retryable: false };
  }

  // ── §29 : L'INTERDIT D'AUTO-ESCALADE, VÉRIFIÉ UNE SECONDE FOIS ────────────────────────
  //
  // Le compilateur l'a déjà refusé. Cette garde-ci couvre le cas où l'étape n'est PAS venue
  // d'un plan compilé : une reprise, une réparation, ou une ligne insérée directement en base.
  // Une garde qui ne vit qu'à un seul endroit protège tant que personne n'ouvre un second
  // chemin ; celle-ci protège aussi le second chemin.
  if (deps.catalog?.has(step.capability)) {
    const v = verifierAvantAgir(step.capability, deps.catalog.meta(step.capability).effect, actor);
    if (!v.ok) {
      return { status: "FAILED", error: v.raison, errorKind: "MISSING_PERMISSION", retryable: false };
    }
  }

  const cle = step.idempotencyKey
    ?? (step.needsIdempotencyKey ? cleIdempotence(mission.id, step.key, step.capability, cibleDe(step.input)) : null);

  if (cle && cle !== step.idempotencyKey) {
    // POSER LA CLÉ AVANT D'AGIR. Si une autre exécution l'a déjà posée, l'unicité en base
    // refuse — et ce refus EST l'information : le travail a déjà été réclamé ailleurs.
    try {
      await prisma.missionStep.update({ where: { id: step.id }, data: { idempotencyKey: cle } });
    } catch {
      return { status: "DONE", receipt: "DEDUPLIQUE", result: { deduplique: true } };
    }
  }

  const debut = ctx.clock.now();
  const out = await deps.runner.run({
    capability: step.capability,
    input: step.input,
    actor,
    missionId: mission.id,
    stepKey: step.key,
    idempotencyKey: cle,
  });

  await compter(mission.id, { toolCalls: 1 });

  /**
   * ── LE REÇU EST FABRIQUÉ ICI, ET SEULEMENT ICI ────────────────────────────────────────
   *
   * C'est le seul endroit où l'on détient les cinq faits à la fois : la capacité appelée,
   * l'effet que le REGISTRE lui déclare, l'entrée réellement partie, les deux horodatages, et
   * la sortie. Le fabriquer plus loin obligerait à les repasser ; le fabriquer plus tôt
   * obligerait à deviner le résultat.
   *
   * Il est fabriqué même sur ÉCHEC : « nous avons interrogé cette source et l'appel a échoué »
   * est une information, et c'est celle qui distingue une piste non explorée d'une piste
   * explorée sans succès.
   */
  const meta = metaDe(step.capability, deps.catalog);

  /**
   * ── LE SUCCÈS SÉMANTIQUE, ENTRE LE TRANSPORT ET L'ATTENDU DE L'ÉTAPE ─────────────────
   *
   * Quatre niveaux existent, et le runtime n'en tenait que deux :
   *
   *   1. transport      le handler n'a pas levé  → le `try` de `executerUneEtape` ;
   *   2. capacité       elle n'a pas déclaré d'échec → `out.ok` ;
   *   3. SÉMANTIQUE     ce qu'elle rend satisfait ce qu'elle PROMET → ici, et nulle part avant ;
   *   4. attendu        la forme correspond à `spec.attendu` → `recovery/evaluate.ts`.
   *
   * Le 3 manquait, et son absence a un coût nommable : sur un run réel, `read_document` a rendu
   * « Pièce introuvable ou sans fichier », l'étape est passée DONE, et le juge d'objectif a reçu
   * comme preuve de lecture une phrase disant que la lecture n'avait pas eu lieu.
   *
   * Le contrôle porte sur la FORME (`out.structured` : une structure, ou une phrase ?), jamais
   * sur le sens de la phrase — voir `result-contract.ts`. Une capacité sans contrat déclaré
   * (`LIBRE`, le défaut) n'est pas contrôlée : on ne vérifie pas une promesse qui n'a pas été
   * faite.
   */
  const verdict = out.ok
    ? verifierContrat(meta.contrat, out.output, out.structured, EFFECT_RANK[meta.effect] >= EFFECT_RANK.PREPARE)
    : null;
  const honore = verdict === null || verdict.etat === "SUCCESS";

  const recu = fabriquerRecu({
    capability: step.capability,
    effect: meta.effect,
    source: meta.domain,
    input: step.input,
    // LE REÇU DIT CE QUI S'EST VRAIMENT PASSÉ. Un contrat non honoré n'est pas un succès, et
    // laisser `ok: out.ok` ici ferait entrer dans le registre de preuves une lecture qui n'a
    // rien lu — exactement la preuve fabriquée que ce lot existe pour supprimer.
    ok: out.ok && honore,
    sortie: out.output,
    debut,
    fin: ctx.clock.now(),
    deduplicated: out.deduplicated,
  });

  if (!out.ok) {
    return {
      status: "FAILED",
      error: out.error?.message ?? "échec sans message",
      errorKind: out.error?.kind ?? "CAPABILITY_FAILURE",
      retryable: out.error?.retryable ?? true,
      recu,
    };
  }
  if (verdict && !honore) {
    return {
      status: "FAILED",
      error: `${step.capability} : ${verdict.raison}`,
      errorKind: verdict.kind ?? "INCOMPATIBLE_RESULT",
      // REJOUER À L'IDENTIQUE REDIRAIT LA MÊME CHOSE. C'est le CHEMIN qu'il faut changer, et
      // `tenterRecours` — appelé juste après par `executerUneEtape` — en décide.
      retryable: false,
      recu,
    };
  }
  return {
    status: "DONE", result: out.output, recu,
    receipt: out.deduplicated ? "DEDUPLIQUE" : undefined,
  };
}

/** La cible d'une action — ce qui rend la clé unique par PERSONNE, pas seulement par étape. */
function cibleDe(input: Record<string, unknown>): string | null {
  for (const champ of ["to", "destinataire", "employeeId", "userId", "personId", "recordId", "id"]) {
    const v = input[champ];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/** Écrit le résultat de l'étape — et transitionne en passant par la machine à états. */
async function ecrireSortie(
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DÉPLOIEMENT EN ÉVENTAIL (§10) — trente-trois étapes réelles, nées d'une seule.
 *
 * C'est ici que « le même code pour 3 et pour 3 000 » cesse d'être une intention. Le plan porte
 * UNE étape ; la collection n'existe qu'à l'exécution ; le graphe grandit avec les données.
 *
 * L'étape modèle ne disparaît pas : elle passe en ATTENTE de ses filles, ce qui fait que tout
 * ce qui dépendait d'elle attend naturellement les trente-trois. Aucune arête n'est réécrite —
 * et une réécriture d'arêtes en cours d'exécution serait exactement le genre d'opération qu'un
 * crash au mauvais moment laisserait à moitié faite.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
async function deployerEventail(
  etat: EtatMission,
  step: EtatEtape,
  eventail: { from: string; path: string; as: string },
): Promise<number> {
  const { from, path, as } = eventail;
  const source = etat.steps.find((s) => s.key === from);

  if (!source) {
    // L'ÉTAPE AMONT N'EXISTE PAS. Ce n'est pas un problème de forme, c'est un DAG faux — et
    // seul un nouveau plan le corrige. Le message le dit, plutôt que de laisser croire à une
    // liste manquante.
    const sortie: StepOutcome = {
      status: "FAILED",
      error: `l'éventail dépend de « ${from} », qui n'existe dans aucune version du plan.`,
      errorKind: "INCOMPATIBLE_RESULT",
      retryable: false,
    };
    if (await tenterRecours(etat, step, sortie, systemClock)) return 0;
    await ecrireSortie(etat, step, sortie, systemClock);
    return 0;
  }

  /**
   * ── CE QU'ON A TROUVÉ À LA PLACE DE LA LISTE, DIT PRÉCISÉMENT ──────────────────────
   *
   * Ce test était `if (!Array.isArray(lire(...)))`, et le message qui en sortait disait « il a
   * trouvé undefined ». Un run réel a montré ce que coûte cette phrase : elle est recopiée
   * telle quelle dans `refusPrecedent`, le planificateur n'en tire rien, et il récrit la même
   * recherche. Deux fois, pour cent neuf secondes de modèle.
   *
   * La cause réelle était invisible dans « undefined » : la recherche Drive n'avait rien trouvé
   * et l'avait dit EN FRANÇAIS, si bien que le résultat de l'étape amont ne portait plus de
   * structure du tout. Le plan était juste ; le chemin était juste.
   */
  const diagnostic = resoudreCollection(source.result, path);
  if (diagnostic.kind === "CORRIGEE") {
    // UNE SEULE LISTE = UNE CERTITUDE, et on l'inscrit au journal plutôt que de la taire. Le
    // cas ambigu, lui, tombe plus bas : on ne choisit jamais parmi plusieurs candidates.
    await journaliser(etat.id, "FANOUT_PATH_CORRIGE", expliquer(diagnostic, from, path), {
      stepKey: step.key, demande: path, retenu: diagnostic.chemin, elements: diagnostic.valeur.length,
    });
  }
  if (diagnostic.kind !== "LISTE" && diagnostic.kind !== "CORRIGEE") {
    // ── LE RECOURS D'ABORD, L'ÉCHEC ENSUITE ────────────────────────────────────────────
    //
    // Cet échec était écrit DIRECTEMENT en base, sans passer par `tenterRecours` : un
    // `INCOMPATIBLE_RESULT` n'ouvrait aucun recours et la mission mourait BLOCKED. Le
    // déploiement de l'éventail est un chemin d'échec comme un autre ; il emprunte la même porte.
    const sortie: StepOutcome = {
      status: "FAILED",
      error: expliquer(diagnostic, from, path),
      errorKind: "INCOMPATIBLE_RESULT",
      retryable: false,
    };
    if (await tenterRecours(etat, step, sortie, systemClock)) return 0;
    await ecrireSortie(etat, step, sortie, systemClock);
    return 0;
  }
  const collection = diagnostic.valeur;

  if (collection.length === 0) {
    // UNE COLLECTION VIDE N'EST PAS UNE ERREUR, et ce n'est pas non plus une étape « ignorée » :
    // l'étape a bel et bien tourné, elle a lu la liste, la liste était vide. « Écris à tous les
    // salariés en congé » quand il n'y en a aucun est une mission ACCOMPLIE. Le résultat porte
    // le zéro, pour que le contrôle qualité compte zéro attendu et non zéro manquant.
    await ecrireSortie(etat, step,
      { status: "DONE", result: { expanded: 0, keys: [], source: `${from}.${path}` } }, systemClock);
    return 0;
  }

  /**
   * DEUX ÉLÉMENTS, UNE IDENTITÉ → UNE SEULE ITÉRATION, ET C'EST DIT.
   *
   * L'upsert ci-dessous dédoublonne DÉJÀ en base (même clé = même ligne). Mais la première
   * écriture de ce fichier annonçait `expanded: cles.length` AVEC les doublons — le parent
   * disait « 3 itérations » quand la base en portait 2, et le contrôle qualité comptait une
   * incohérence éternelle sur une mission parfaitement saine. L'annonce dit désormais la
   * vérité de la base ; les identités fusionnées sont nommées au journal, jamais tues.
   */
  const clesVues = new Set<string>();
  const doublons: string[] = [];
  const cles: string[] = [];

  /**
   * ── CE QUE LES FILLES D'UN PLAN PRÉCÉDENT DEVIENNENT ────────────────────────────────────
   *
   * `update: {}` plus bas est juste pour une REPRISE : un second déploiement après panne doit
   * retrouver ses filles, jamais les remettre à zéro. Il est faux pour un REPLAN.
   *
   * Quand un nouveau plan reprend la mère, `materialiser` la réarme (§118.33). Elle redéploie —
   * et retrouve ses filles EN ÉCHEC, figées au plan précédent. Elles ne se termineront jamais,
   * la mère les attend, le regroupement recompte 0/1, et la mission remeurt exactement comme
   * avant : le trou d'un cran plus bas. Une fille appartient à la version de plan de sa mère ;
   * quand la mère change de version, ses filles en ÉCHEC repartent avec elle — les ABOUTIES
   * restent acquises (pas de second envoi), et leur clé d'idempotence n'est jamais touchée.
   */
  /**
   * ── UNE FILLE APPARTIENT AU JALON DE SA MÈRE (§118.68) ─────────────────────────────────
   *
   * MESURÉ LIVE, mission `cmttsao1f…`. Le jalon 1 s'appelle « les pièces réglementaires sont
   * officiellement SOLLICITÉES ». Le plan déploie l'envoi en éventail ; les deux filles
   * partent, aboutissent, et leur résultat dit « Message envoyé à Amel Haddad ». Le juge du
   * jalon, lui, ne charge que les étapes qui portent son `milestoneId` — donc la MÈRE, jamais
   * les filles. `attestationEffets` a lu leurs zéro reçu et a conclu, honnêtement :
   *
   *   « toutes les capacités appelées sont des lectures : AUCUNE écriture et AUCUN envoi.
   *     Aucune demande traçable n'est donc démontrée comme ayant été produite. »
   *
   * Le jalon a été refusé DEUX FOIS pour avoir fait exactement ce qu'on lui demandait : le
   * faux ÉCHEC symétrique du faux succès (§118.44), et il coûte aussi cher — une reprise de
   * jalon, un sous-plan neuf, une porte d'accord rouverte et un appel de juge à chaque tour.
   *
   * Tout le travail réel d'une mission massive vit dans les filles : les en priver de leur
   * jalon rend ce travail invisible à ce qui le juge, le compte et le contourne.
   */
  const mere = await prisma.missionStep.findUnique({
    where: { id: step.id }, select: { milestoneId: true },
  });
  const filles = await prisma.missionStep.findMany({
    where: { missionId: etat.id, key: { startsWith: `${step.key}#` } },
    select: { key: true, status: true, planVersion: true },
  });
  const aReprendre = new Map(filles
    .filter((f) => f.status === "FAILED" && f.planVersion < step.planVersion)
    .map((f) => [f.key, f] as const));

  for (const [i, element] of collection.entries()) {
    const cle = `${step.key}#${identiteIteration(element, i)}`;
    if (clesVues.has(cle)) {
      doublons.push(cle);
      continue;
    }
    clesVues.add(cle);
    cles.push(cle);
    /**
     * L'ENTRÉE DE CETTE FILLE, ET CE QUE L'ÉLÉMENT N'A PAS PU DONNER (§118.71).
     *
     * `manquantes` n'est jamais vide par hasard : c'est un chemin que le plan a écrit et que
     * l'élément ne porte pas. La fille échouera donc à coup sûr — autant le dire AVANT de
     * payer l'appel de capacité, et le dire avec les champs réellement disponibles plutôt que
     * de laisser l'outil accuser l'annuaire (règle 20 du planificateur).
     */
    const iteration = entreeIteration(step.input, as, element);
    await prisma.missionStep.upsert({
      where: { missionId_key: { missionId: etat.id, key: cle } },
      create: {
        missionId: etat.id,
        key: cle,
        title: `${step.title} — ${identiteIteration(element, i)}`,
        workstream: step.workstream,
        nodeType: step.nodeType,
        capability: step.capability,
        input: iteration.entree as never,
        maxAttempts: step.maxAttempts,
        // LES FILLES HÉRITENT DE L'EXIGENCE DE CLÉ. Ce sont ELLES qui envoient réellement les
        // trente-trois messages ; l'oublier ici viderait §15 de son sens exactement là où il
        // compte — la première écriture de ce fichier le faisait, et les trente-trois clés
        // arrivaient nulles.
        needsIdempotencyKey: step.needsIdempotencyKey,
        // ET DE LA SPÉCIFICATION, pour la même raison : c'est la fille qui appelle le modèle,
        // donc c'est elle qui doit porter le schéma de sortie exigé et sa condition de fin.
        spec: (step.spec ?? undefined) as never,
        planVersion: step.planVersion,
        // LE JALON DE LA MÈRE — sans quoi le travail réel est invisible au juge du jalon.
        milestoneId: mere?.milestoneId ?? null,
        status: "PENDING",
      },
      // UNE ITÉRATION DÉJÀ CRÉÉE N'EST PAS RÉÉCRITE : un second déploiement (reprise après
      // panne) doit retrouver les filles, jamais les remettre à zéro.
      update: {},
    });

    if (aReprendre.has(cle)) {
      await prisma.missionStep.update({
        where: { missionId_key: { missionId: etat.id, key: cle } },
        data: {
          status: "PENDING", attempt: 0, error: null, errorKind: null,
          startedAt: null, completedAt: null, supersededAt: null,
          planVersion: step.planVersion,
          title: `${step.title} — ${identiteIteration(element, i)}`,
          input: iteration.entree as never,
          spec: (step.spec ?? undefined) as never,
          // UNE FILLE RÉARMÉE SUIT SA MÈRE, jalon compris : un replan peut avoir déplacé la
          // mère d'un jalon à l'autre, et une fille restée sur l'ancien serait jugée deux fois.
          milestoneId: mere?.milestoneId ?? null,
        },
      });
    }

    /**
     * ── UN CHEMIN QUE L'ÉLÉMENT NE PORTE PAS SE DIT ICI, PAS À L'ARRIVÉE (§118.71) ────────
     *
     * Sans cela, `JSON.stringify` efface la clé non résolue, la capacité reçoit une entrée
     * AMPUTÉE, et son refus accuse la mauvaise cause — mesuré : « Destinataire « (rien) »
     * introuvable » sur une itération nommée `#Amel Haddad`. Le planificateur suivant est
     * parti chercher une personne au lieu de corriger un chemin.
     *
     * L'échec est DÉFINITIF (tentatives épuisées) : réessayer ne fera pas apparaître un champ
     * que l'élément n'a pas. Et il ne touche qu'une fille encore devant nous — une itération
     * déjà ABOUTIE garde son acquis, comme partout ailleurs (§118.33).
     */
    if (iteration.manquantes.length > 0) {
      const dit = iteration.manquantes
        .map((m) => `{{${m.reference}}}${m.disponibles.length > 0 ? ` (l'élément porte : ${m.disponibles.join(", ")})` : " (l'élément ne porte aucun champ)"}`)
        .join(" ; ");
      const majAbsente = await prisma.missionStep.updateMany({
        where: { missionId: etat.id, key: cle, status: { in: ["PENDING", "READY"] } },
        data: {
          // `INVALID_STEP` est LE motif de la référence morte `{{etape.champ}}` — c'est
          // exactement ce dont il s'agit, un cran plus bas. Inventer un motif de plus le
          // rendrait invisible à `tenterRecours`, qui rejette d'entrée ce qu'il ne connaît
          // pas : un manque non classé est un manque invisible (§118.31).
          status: "FAILED", attempt: step.maxAttempts, errorKind: "INVALID_STEP",
          error: `l'élément de l'itération ne porte pas ce que le plan lui demande : ${dit}. `
            + `Corrige le chemin — ou référence l'élément entier avec {{${as}}} s'il EST la valeur.`,
          completedAt: new Date(),
        },
      });
      if (majAbsente.count > 0) {
        await journaliser(etat.id, "STEP_FAILED",
          `Étape « ${step.title} — ${identiteIteration(element, i)} » en échec avant exécution : ${dit}`,
          { stepKey: cle, errorKind: "INVALID_STEP", retryable: false, manquantes: iteration.manquantes });
      }
    }

    // Les filles héritent des dépendances du modèle, pas du modèle lui-même : dépendre de lui
    // fermerait un cycle, puisque lui attend ses filles.
    for (const d of step.dependsOn) {
      const parent = etat.steps.find((s) => s.key === d);
      const fille = await prisma.missionStep.findUnique({
        where: { missionId_key: { missionId: etat.id, key: cle } }, select: { id: true },
      });
      if (parent && fille) {
        await prisma.missionStepDep.upsert({
          where: { stepId_dependsOnId: { stepId: fille.id, dependsOnId: parent.id } },
          create: { stepId: fille.id, dependsOnId: parent.id },
          update: {},
        });
      }
    }
  }

  await prisma.missionStep.update({
    where: { id: step.id },
    data: { status: "WAITING", result: { expanded: cles.length, keys: cles } as never },
  });
  const reprises = cles.filter((c) => aReprendre.has(c));
  await journaliser(etat.id, "FANOUT",
    `« ${step.title} » déployée en ${cles.length} étapes individuelles.`
    + (reprises.length > 0
      ? ` ${reprises.length} itération(s) en échec sous le plan précédent sont REPRISES par celui-ci : ${reprises.slice(0, 5).join(", ")}.`
      : "")
    + (doublons.length > 0
      ? ` ${doublons.length} élément(s) partageaient une identité déjà déployée — fusionnés, pas dupliqués : ${[...new Set(doublons)].slice(0, 5).join(", ")}.`
      : ""),
    { stepKey: step.key, count: cles.length, ...(doublons.length > 0 ? { fusionnes: doublons.length } : {}), ...(reprises.length > 0 ? { reprises: reprises.length } : {}) });

  return cles.length;
}

/**
 * FERME LES ÉVENTAILS DONT TOUTES LES FILLES SONT TERMINÉES.
 *
 * Le modèle attend ; quand plus rien ne bouge, on regarde s'il peut conclure. Il conclut en
 * ÉCHEC si une fille a échoué définitivement — sinon un envoi manquant sur trente-trois
 * passerait pour un succès, ce qui est précisément ce que le §22 interdit.
 */
async function resoudreEventails(etat: EtatMission, catalog?: CapabilityCatalog): Promise<number> {
  let resolus = 0;
  for (const step of etat.steps) {
    if (step.status !== "WAITING") continue;
    const r = step.result as { keys?: unknown } | null;
    // Dédoublonné DÉFENSIVEMENT : un résultat écrit avant le correctif d'annonce (voir le
    // déploiement) peut porter deux fois la même clé — la refermer au compte des doublons
    // referait exactement l'incohérence qu'on vient d'éteindre.
    const cles = Array.isArray(r?.keys)
      ? [...new Set((r!.keys as unknown[]).filter((k): k is string => typeof k === "string"))]
      : [];
    if (cles.length === 0) continue;

    const filles = etat.steps.filter((s) => cles.includes(s.key));
    // « RÉGLÉE » N'EST PAS « TERMINÉE ». Une fille en échec définitif ne reviendra jamais : si on
    // exigeait qu'elle finisse bien, le modèle attendrait pour toujours et la mission se
    // figerait sur un envoi raté. On ferme donc sur l'épuisement des tentatives — et on ferme en
    // ÉCHEC, ce qui est précisément la différence entre « fini » et « réussi » (§22).
    const reglee = (f: typeof filles[number]) => STEP_TERMINAL.has(f.status)
      || (f.status === "FAILED" && f.attempt >= f.maxAttempts);
    if (filles.length === 0 || !filles.every(reglee)) continue;

    const echecs = filles.filter((f) => f.status === "FAILED");
    const faites = filles.filter((f) => f.status === "DONE").length;

    /**
     * UNE LECTURE MANQUÉE EST UNE INFORMATION ; UNE ÉCRITURE MANQUÉE EST UNE DETTE (§28).
     *
     * Un éventail d'ÉCRITURE partiellement échoué DOIT échouer : trois vœux non partis sur
     * trente-trois ne se maquillent pas en succès (§22). Un éventail de LECTURE, lui, pose des
     * questions — et « ce document n'a pas pu être lu (paiement du stockage requis) » est une
     * RÉPONSE, pas une panne : la fermer en échec envoyait la mission au recours puis au
     * replan, qui relisait le même mur (mesuré au Run 3 : spirale de replans vides sur des
     * fiches dont UNE cible sur trois était illisible). L'éventail de lecture conclut donc,
     * avec ses manques NOMMÉS dans son résultat — l'étape aval les DIT, le juge les lit, et
     * rien n'est perdu : chaque échec garde son reçu et son erreur sur sa fille.
     */
    const effet = step.capability ? metaDe(step.capability, catalog).effect : "ANALYZE";
    const lectureSeule = EFFECT_RANK[effet] <= EFFECT_RANK.ANALYZE;
    const statut = echecs.length > 0 && !lectureSeule ? "FAILED" : "DONE";

    await prisma.missionStep.update({
      where: { id: step.id },
      data: {
        status: statut,
        attempt: step.maxAttempts,
        completedAt: new Date(),
        result: {
          expanded: cles.length, done: faites, failed: echecs.length, keys: cles,
          ...(echecs.length > 0
            ? { echecs: echecs.map((f) => ({ key: f.key, error: f.error ?? "échec sans message" })) }
            : {}),
        } as never,
        ...(statut === "FAILED"
          ? { error: `${echecs.length} itération(s) sur ${cles.length} en échec.`, errorKind: "PARTIAL_FANOUT" }
          : {}),
      },
    });
    await journaliser(etat.id, echecs.length > 0 ? "FANOUT_PARTIAL" : "FANOUT_DONE",
      `« ${step.title} » : ${faites}/${cles.length} itérations réussies.`,
      { stepKey: step.key, done: faites, failed: echecs.length });
    resolus += 1;
  }
  return resolus;
}

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
async function synchroniserEtat(missionId: string, etat: EtatMission): Promise<MissionState> {
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

/**
 * UNE CARTE PARALLÈLE BORNÉE.
 *
 * `Promise.all` sur trente-trois envois saturerait le fournisseur et ferait échouer par
 * limitation de débit ce qui aurait réussi en trois vagues. La borne est OPÉRATIONNELLE : elle
 * ne dit rien de la taille des missions, seulement de la vitesse à laquelle on les mène (§4).
 */
async function enParallele<T, R>(
  items: readonly T[],
  concurrence: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let curseur = 0;
  const largeur = Math.max(1, Math.min(concurrence, items.length));
  await Promise.all(Array.from({ length: largeur }, async () => {
    for (;;) {
      const i = curseur++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}
