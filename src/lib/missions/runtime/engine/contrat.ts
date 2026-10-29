/**
 * Moteur de mission — LE CONTRAT : durée du bail, contexte et issue d'une étape, gestionnaires,
 * dépendances injectées, résultat d'un tour ; état terminal, plafond et profil des capacités.
 */
import type { CapabilityCatalog, CapabilityRunner, Clock, MissionActor, RegistreRecours, PorteAttention } from "@/lib/missions/ports";
import { MissionState, STEP_TERMINAL, StepState } from "@/lib/missions/runtime/state";
import { EtatEtape, EtatMission } from "@/lib/missions/runtime/store";
import type { LecteurInterrupteur } from "@/lib/interrupteurs/missions";
import type { JugeObjectif } from "@/lib/missions/goal/evaluate";
import { EFFECT_RANK, capabilityMeta, type Effect } from "@/lib/missions/registry/capability-meta";
import type { ExecutionReceipt } from "@/lib/missions/runtime/receipt";

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

export const estTerminal = (s: StepState): boolean => STEP_TERMINAL.has(s);

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
export function plafondDuCatalogue(cat: CapabilityCatalog | undefined, actor: MissionActor): Effect {
  if (!cat) return "SECURITY_ADMIN";
  const ouvertes = cat.brief(actor);
  if (ouvertes.length === 0) return "READ";
  return ouvertes.reduce<Effect>(
    (max, b) => (EFFECT_RANK[b.effect] > EFFECT_RANK[max] ? b.effect : max), "READ");
}

export const profilCapacite = (id: string) => {
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
export const metaDe = (capability: string, catalog: CapabilityCatalog | undefined) =>
  catalog?.has(capability) ? catalog.meta(capability) : capabilityMeta(capability);
