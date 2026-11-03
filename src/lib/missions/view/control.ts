import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { MISSION_STATUS_LABEL } from "@/lib/comms/missions";
import { aRegarder, type EntreeMission } from "@/lib/missions/horizon/fraicheur";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CENTRE DE MISSIONS — la vue de conduite, construite par le SERVEUR (§118.14).
 *
 * ── LE TROU QUE CE FICHIER FERME, MESURÉ ────────────────────────────────────────────────
 *
 * Une mission d'exécution avait une ADRESSE (`/missions/<id>`, où pointent ses notifications)
 * et aucune LISTE. `/missions` est le module RH — les ordres de mission, congrès et
 * accompagnants : une personne qui en lançait trois n'avait aucun écran qui les montre
 * ensemble, et le lien « Toutes les missions » de la page de détail menait à une liste qui ne
 * contiendrait jamais cette mission-là. `listerAccordsMission`, écrite pour l'écran, n'avait
 * elle non plus aucun appelant de production : l'accord se donnait uniquement en arrivant par
 * le lien d'une notification, mission par mission.
 *
 * ── CE QUE CE MODULE REND, ET CE QU'IL REFUSE DE RENDRE ─────────────────────────────────
 *
 * Il lit la base, et rien d'autre. Aucun modèle : « où en sont mes missions » a une réponse
 * EXACTE en base, et la faire écrire par un modèle coûterait une seconde et introduirait le
 * risque qu'il décrive un état qu'il a mal lu. C'est la même règle que `workspace.ts`, dont ce
 * fichier est le pendant : l'un montre UNE mission, l'autre montre le PARC.
 *
 * ── POURQUOI LE COMPTE D'ÉTAPES PASSE PAR DU SQL ────────────────────────────────────────
 *
 * Parce qu'il doit être EXACT et qu'il ne doit pas ramener les étapes. Trente-trois envois
 * comptent pour trente-trois, jamais pour un — donc il faut savoir quelles étapes sont des
 * MODÈLES d'éventail (elles ont des filles) et les retirer du compte. Charger les étapes de
 * vingt missions pour le calculer en mémoire marcherait jusqu'à la mission MASSIVE, où l'écran
 * ramènerait trois mille lignes pour afficher un ratio.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce que la mission attend d'une PERSONNE — la seule chose qui justifie de remonter en tête. */
export type AttenteHumaine = "ACCORD" | "ELEMENT" | null;

export interface LigneMission {
  id: string;
  titre: string;
  /** L'état BRUT — c'est lui qui décide des boutons, jamais le libellé (§118.45). */
  statut: string;
  etat: string;
  priorite: number;
  /** Ce que la mission attend de VOUS, et depuis quand. */
  attend: AttenteHumaine;
  attendDepuis: string | null;
  attendQuoi: string | null;
  /**
   * L'AVANCEMENT RÉEL — `jalons` quand la mission en a, sinon les étapes du plan.
   *
   * `franchis` compte ce qui est DERRIÈRE : les jalons aboutis ET ceux que le plan a écartés
   * comme sans objet. C'est exactement le numérateur de `part`, et c'est voulu — afficher
   * « 1/4 » à côté d'une jauge à 50 % ferait lire deux chiffres qui se contredisent. `aboutis`
   * reste distinct : écarté n'est pas fait, et confondre les deux serait le mensonge de
   * tableau de bord qu'on refuse partout ailleurs.
   */
  jalons: { franchis: number; aboutis: number; ecartes: number; total: number; part: number; bloques: number } | null;
  etapes: { faites: number; total: number; echouees: number };
  livrables: { total: number; verifies: number };
  /** VRAI quand plus rien ne peut avancer sans une décision — ce que l'écran met en rouge. */
  bloquee: boolean;
  /** Ce que la mission a coûté en modèle. Zéro est une valeur, pas une absence. */
  cout: { usd: number; appels: number };
  majLe: string;
  creeLe: string;
}

export interface CentreDeMissions {
  /** Ce qui tourne, ce qui attend, ce qui bloque — dans cet ordre de priorité de lecture. */
  vivantes: LigneMission[];
  /** Terminées ou arrêtées, les plus récentes d'abord. Repliées à l'écran. */
  closes: LigneMission[];
  compteurs: { vivantes: number; attendentVous: number; bloquees: number; enPause: number };
}

const TERMINALES = ["COMPLETED", "CANCELLED", "FAILED"] as const;

/**
 * L'ORDRE DE LECTURE, ET POURQUOI IL N'EST PAS CHRONOLOGIQUE.
 *
 * Une liste triée par date met en haut ce qui vient de bouger tout seul, c'est-à-dire
 * exactement ce dont personne n'a besoin de s'occuper. Ce qui attend une personne passe donc
 * devant, puis ce qui est bloqué, puis la priorité déclarée, et la date en dernier recours.
 */
function rang(l: LigneMission): number {
  if (l.attend !== null) return 0;
  if (l.bloquee) return 1;
  if (l.statut === "PAUSED") return 3;
  return 2;
}

interface CompteEtapes { total: number; faites: number; echouees: number }

/**
 * LE COMPTE EXACT DES ÉTAPES RÉELLES, POUR PLUSIEURS MISSIONS, EN UNE REQUÊTE.
 *
 * Un MODÈLE d'éventail — l'étape qui s'est démultipliée — ne compte pas : ce sont ses filles
 * qui ont eu lieu. `enfants` retrouve les modèles par le PRÉFIXE de clé (`envoi#khaled` a pour
 * modèle `envoi`), sans `LIKE` : une clé de plan pourrait contenir un caractère joker, et un
 * compte faux ici est un compte faux partout, puisque c'est celui que l'écran affiche.
 */
async function compterEtapes(ids: readonly string[]): Promise<Map<string, CompteEtapes>> {
  const out = new Map<string, CompteEtapes>();
  if (ids.length === 0) return out;

  const rows = await prisma.$queryRaw<Array<{
    missionid: string; total: bigint; faites: bigint; echouees: bigint;
  }>>`
    WITH enfants AS (
      SELECT DISTINCT "missionId", left(key, position('#' in key) - 1) AS modele
      FROM "MissionStep"
      WHERE "missionId" IN (${Prisma.join([...ids])}) AND position('#' in key) > 0
        AND "supersededAt" IS NULL
    )
    SELECT st."missionId" AS missionid,
           count(*) FILTER (WHERE e.modele IS NULL) AS total,
           count(*) FILTER (WHERE e.modele IS NULL AND st.status = 'DONE') AS faites,
           count(*) FILTER (WHERE e.modele IS NULL AND st.status = 'FAILED') AS echouees
    FROM "MissionStep" st
    LEFT JOIN enfants e ON e."missionId" = st."missionId" AND e.modele = st.key
    WHERE st."missionId" IN (${Prisma.join([...ids])}) AND st."supersededAt" IS NULL
    GROUP BY st."missionId"`;

  for (const r of rows) {
    out.set(r.missionid, {
      total: Number(r.total), faites: Number(r.faites), echouees: Number(r.echouees),
    });
  }
  return out;
}

/**
 * LE PARC DE MISSIONS D'UNE PERSONNE.
 *
 * Borné par `limite` — mais le plafond porte sur ce qu'on AFFICHE, jamais sur ce qu'on compte :
 * les compteurs du bandeau parlent de toutes les missions vivantes, sans quoi « 2 en attente de
 * vous » deviendrait faux le jour où la vingt-sixième arrive.
 */
export async function centreDeMissions(
  ownerId: string,
  opts: { limite?: number; closes?: number } = {},
): Promise<CentreDeMissions> {
  const limite = Math.min(Math.max(1, opts.limite ?? 40), 200);
  const closesMax = Math.min(Math.max(0, opts.closes ?? 10), 100);

  const missions = await prisma.mission.findMany({
    where: { ownerId, kind: "RUNTIME" },
    select: {
      id: true, title: true, status: true, priority: true, costUsd: true, modelCalls: true,
      createdAt: true, updatedAt: true, replanBloque: true,
      steps: {
        where: { status: "WAITING", supersededAt: null, nodeType: { in: ["APPROVAL", "WAIT_INPUT"] } },
        select: { nodeType: true, title: true, updatedAt: true },
        orderBy: { updatedAt: "asc" },
        take: 1,
      },
      milestones2: { select: { statut: true } },
      artifacts: { select: { status: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: limite + closesMax + 50,
  });
  if (missions.length === 0) {
    return { vivantes: [], closes: [], compteurs: { vivantes: 0, attendentVous: 0, bloquees: 0, enPause: 0 } };
  }

  const comptes = await compterEtapes(missions.map((m) => m.id));

  const lignes: LigneMission[] = missions.map((m) => {
    const c = comptes.get(m.id) ?? { total: 0, faites: 0, echouees: 0 };
    const att = m.steps[0] ?? null;

    // ANNULÉ sort du dénominateur : un jalon qu'une personne a retiré ne doit pas faire
    // chuter l'avancement de ce qui reste. ÉCARTÉ, lui, est DERRIÈRE — le plan l'a jugé sans
    // objet — donc il compte au numérateur sans compter comme accompli.
    const jalonsVivants = m.milestones2.filter((j) => j.statut !== "CANCELLED");
    const aboutis = jalonsVivants.filter((j) => j.statut === "DONE").length;
    const ecartes = jalonsVivants.filter((j) => j.statut === "SKIPPED").length;
    const jalons = m.milestones2.length > 0
      ? {
          franchis: aboutis + ecartes,
          aboutis,
          ecartes,
          total: m.milestones2.length,
          part: jalonsVivants.length === 0 ? 0 : (aboutis + ecartes) / jalonsVivants.length,
          bloques: m.milestones2.filter((j) => j.statut === "BLOCKED").length,
        }
      : null;

    return {
      id: m.id,
      titre: m.title,
      statut: m.status,
      etat: MISSION_STATUS_LABEL[m.status] ?? m.status,
      priorite: m.priority,
      attend: att ? (att.nodeType === "APPROVAL" ? "ACCORD" : "ELEMENT") : null,
      attendDepuis: att ? att.updatedAt.toISOString() : null,
      attendQuoi: att ? att.title : null,
      jalons,
      etapes: c,
      livrables: {
        total: m.artifacts.length,
        verifies: m.artifacts.filter((a) => a.status === "VERIFIED").length,
      },
      // BLOQUÉE dit « plus rien n'avancera tout seul ». `replanBloque` en fait partie : une
      // mission dont le refus de compilation se répète ne repartira pas au prochain battement,
      // et l'afficher « en cours » ferait attendre pour rien (§118.42).
      bloquee: m.status === "BLOCKED" || m.status === "FAILED" || m.replanBloque
        || (jalons?.bloques ?? 0) > 0,
      cout: { usd: m.costUsd, appels: m.modelCalls },
      majLe: m.updatedAt.toISOString(),
      creeLe: m.createdAt.toISOString(),
    };
  });

  const vivantes = lignes.filter((l) => !TERMINALES.includes(l.statut as (typeof TERMINALES)[number]));
  const closes = lignes.filter((l) => TERMINALES.includes(l.statut as (typeof TERMINALES)[number]));

  vivantes.sort((a, b) => rang(a) - rang(b)
    || b.priorite - a.priorite
    || b.majLe.localeCompare(a.majLe));

  return {
    vivantes: vivantes.slice(0, limite),
    closes: closes.slice(0, closesMax),
    compteurs: {
      vivantes: vivantes.length,
      attendentVous: vivantes.filter((l) => l.attend !== null).length,
      bloquees: vivantes.filter((l) => l.bloquee).length,
      enPause: vivantes.filter((l) => l.statut === "PAUSED").length,
    },
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE JOURNAL, LISIBLE — et pourquoi il ne s'affiche pas tel quel.
 *
 * ── LE FAIT, MESURÉ ─────────────────────────────────────────────────────────────────────
 *
 * Sur la base de banc : 8 751 `STATE_CHANGED` (« le moteur prend la main », répété à chaque
 * tour), 3 714 `STEP_DONE`, 981 `NOTIFIED`. Le journal brut d'une mission, affiché, noierait
 * les six lignes qui expliquent où elle en est sous deux cents lignes de comptabilité de
 * moteur. Un écran qui montre tout ne montre rien.
 *
 * ── LA RÈGLE, ET SON DÉFAUT À ÉVITER ────────────────────────────────────────────────────
 *
 * Un genre INCONNU s'affiche. C'est délibéré et c'est l'inverse de l'intuition : un filtre dont
 * le défaut est « cacher » rend invisible tout ce que le moteur apprendra à dire demain, en
 * silence, et personne ne s'apercevra que la ligne manque. Le bruit, lui, est NOMMÉ — une liste
 * fermée, courte, qu'on relit quand elle grandit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export type GraviteJournal = "decision" | "fait" | "probleme";

/**
 * LE BRUIT — la comptabilité que le moteur tient pour lui-même.
 *
 * Chacun de ces genres a déjà sa traduction ailleurs à l'écran : l'état courant est dans le
 * bandeau, les étapes dans leur liste, les attentes dans la leur, les notifications dans le
 * centre de notifications. Les répéter en journal ne dit rien de neuf.
 */
const BRUIT: ReadonlySet<string> = new Set([
  "STATE_CHANGED", "STEP_DONE", "STEP_WAITING", "STEP_SKIPPED", "STEP_RECLAIMED",
  "NOTIFIED", "WATCH_CHECKED", "FANOUT", "FANOUT_DONE", "FANOUT_PATH_CORRIGE",
]);

/** Ce qui n'est pas un simple fait : une DÉCISION prise, ou un PROBLÈME rencontré. */
const GRAVITE: Record<string, GraviteJournal> = {
  APPROVAL_REQUESTED: "decision", APPROVAL_GRANTED: "decision", APPROVAL_REFUSED: "decision",
  APPROVAL_REOPENED: "decision", PAUSED: "decision", RESUMED: "decision", PRIORITY: "decision",
  MISSION_MODIFIED: "decision", CLOSED: "decision", BUDGET_SET: "decision",
  INPUT_PROVIDED: "decision",

  STEP_FAILED: "probleme", PLANNING_FAILED: "probleme", GOAL_UNSATISFIED: "probleme",
  GAP_DECLARED: "probleme", MILESTONE_BLOCKED: "probleme", MILESTONE_UNSATISFIED: "probleme",
  MILESTONE_PLAN_FAILED: "probleme", MILESTONE_JUDGE_UNAVAILABLE: "probleme",
  REPLAN_BLOCKED: "probleme", REPLAN_SKIPPED: "probleme", WATCH_ERROR: "probleme",
  OVERDUE: "probleme", EVENT_ORPHELIN: "probleme", MODIFICATION_REFUSEE: "probleme",
  BUDGET_HOLD: "probleme", LATE_REPLY: "probleme", PLANNING_DEFERRED: "probleme",
};

export interface LigneJournal {
  id: string;
  genre: string;
  gravite: GraviteJournal;
  texte: string;
  quand: string;
  /** Combien de fois de suite le même genre s'est produit — 1 sauf regroupement. */
  fois: number;
}

export interface JournalMission {
  lignes: LigneJournal[];
  /** Ce qui a été écarté comme comptabilité de moteur. DIT, jamais tu (§118.17). */
  bruitEcarte: number;
}

/**
 * LE JOURNAL D'UNE MISSION, PRÊT À LIRE.
 *
 * Les répétitions consécutives d'un même genre se replient en une ligne avec son compte : trois
 * échecs d'étape à la suite sont un fait, pas trois. La phrase gardée est celle de la
 * PREMIÈRE — c'est elle qui dit ce qui a commencé.
 */
export async function journalDeMission(
  missionId: string,
  ownerId: string,
  limite = 40,
): Promise<JournalMission | null> {
  const m = await prisma.mission.findFirst({
    where: { id: missionId, ownerId }, select: { id: true },
  });
  if (!m) return null;

  // On lit LARGE puis on filtre : le bruit est majoritaire, et prendre les 40 derniers
  // événements bruts rendrait quarante fois « le moteur prend la main ».
  const bruts = await prisma.missionEvent.findMany({
    where: { missionId },
    select: { id: true, kind: true, summary: true, at: true },
    orderBy: { at: "desc" },
    take: Math.max(limite * 12, 300),
  });

  const utiles = bruts.filter((e) => !BRUIT.has(e.kind));
  const bruitEcarte = bruts.length - utiles.length;

  const lignes: LigneJournal[] = [];
  for (const e of utiles) {
    const derniere = lignes[lignes.length - 1];
    if (derniere && derniere.genre === e.kind && derniere.texte === e.summary) {
      derniere.fois += 1;
      continue;
    }
    if (lignes.length >= limite) break;
    lignes.push({
      id: e.id,
      genre: e.kind,
      gravite: GRAVITE[e.kind] ?? "fait",
      texte: e.summary,
      quand: e.at.toISOString(),
      fois: 1,
    });
  }

  return { lignes, bruitEcarte };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE LA MISSION ATTEND — de qui, depuis quand, et combien de fois relancé.
 *
 * `vueMission` rend UNE attente (celle qui appelle un geste immédiat). Une mission longue en a
 * plusieurs à la fois : trois personnes sollicitées, un événement ERP, une échéance. Les
 * afficher toutes est ce qui remplace « pourquoi ça n'avance pas ? » par une réponse.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface AttenteLue {
  stepKey: string;
  titre: string;
  /** ACCORD | ELEMENT | EVENEMENT — ce qui la lèvera. */
  nature: "ACCORD" | "ELEMENT" | "EVENEMENT";
  /** De QUI, quand la mission le sait. Une attente d'événement n'a pas toujours de personne. */
  de: string | null;
  depuis: string;
  /** Nombre de relances déjà parties sur cette attente. */
  relances: number;
  /** L'échéance que le plan s'est donnée, s'il s'en est donné une. */
  jusqua: string | null;
}

function texteDe(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export async function attentesDeMission(missionId: string, ownerId: string): Promise<AttenteLue[] | null> {
  const m = await prisma.mission.findFirst({
    where: { id: missionId, ownerId },
    select: {
      steps: {
        where: { status: "WAITING", supersededAt: null },
        select: {
          key: true, title: true, nodeType: true, waitFor: true, recovery: true, updatedAt: true,
        },
        orderBy: { updatedAt: "asc" },
      },
    },
  });
  if (!m) return null;

  return m.steps.map((s) => {
    const w = (s.waitFor ?? {}) as Record<string, unknown>;
    const r = (s.recovery ?? {}) as Record<string, unknown>;
    const relances = Array.isArray(r.nudges) ? r.nudges.length
      : typeof r.nudges === "number" ? r.nudges : 0;
    return {
      stepKey: s.key,
      titre: s.title,
      nature: s.nodeType === "APPROVAL" ? "ACCORD" as const
        : s.nodeType === "WAIT_INPUT" ? "ELEMENT" as const
          : "EVENEMENT" as const,
      de: texteDe(w.from) ?? texteDe(w.who) ?? null,
      depuis: s.updatedAt.toISOString(),
      relances,
      jusqua: texteDe(w.until),
    };
  });
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE LA MISSION A LU, ET CE QUI A PU BOUGER DEPUIS (§118.41).
 *
 * ── LE FAUX SUCCÈS QUE CECI REND VISIBLE ────────────────────────────────────────────────
 *
 * Jour 1 : le forecast vaut 41,3. Jour 18 : Finance l'a révisé. Jour 19 : la mission livre.
 * Toutes les étapes vertes, le contrôle passe, le livrable est cohérent — et le chiffre est
 * mort. Aucune signature d'échec, nulle part. La seule façon de le voir est de DATER les
 * lectures, ce que le moteur fait déjà : cet écran ne fait que les montrer.
 *
 * ── CE QU'ON MONTRE, ET CE QU'ON NE FAIT PAS ────────────────────────────────────────────
 *
 * On DIT « ceci a de l'âge ». On ne relit pas : relire coûte des appels et peut avoir des
 * effets, et décider de relire appartient au PLAN, pas à un écran. La personne, elle, lit et
 * décide — c'est exactement ce qu'un tableau de bord doit permettre.
 *
 * L'empreinte n'est jamais affichée : c'est une somme de contrôle, pas une information. Ce qui
 * se lit, c'est la clé, la source et l'âge.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface LectureDatee {
  cle: string;
  source: string;
  /** Le moment de la lecture — c'est de LUI que se calcule l'âge, pas de la date d'écriture. */
  lueLe: string;
  /** L'âge en heures, pour décider ; `phrase` est la version qui se lit. */
  ageH: number;
  phrase: string;
}

export async function lecturesAgeesDeMission(
  missionId: string,
  ownerId: string,
  maintenant: Date,
): Promise<LectureDatee[] | null> {
  const m = await prisma.mission.findFirst({
    where: { id: missionId, ownerId }, select: { id: true },
  });
  if (!m) return null;

  const rows = await prisma.missionInput.findMany({
    where: { missionId, supersededAt: null },
    select: {
      cle: true, source: true, version: true, empreinte: true, confiance: true,
      retrievedAt: true, effectiveAt: true, supersededAt: true, stepKey: true, milestoneId: true,
    },
    orderBy: { retrievedAt: "asc" },
    take: 500,
  });

  const entrees: EntreeMission[] = rows.map((r) => ({
    cle: r.cle, source: r.source, version: r.version, empreinte: r.empreinte,
    confiance: r.confiance as EntreeMission["confiance"],
    retrievedAt: r.retrievedAt, effectiveAt: r.effectiveAt, supersededAt: r.supersededAt,
    stepKey: r.stepKey, milestoneId: r.milestoneId,
  }));

  return aRegarder(entrees, maintenant).map((v) => ({
    cle: v.entree.cle,
    source: v.entree.source,
    lueLe: (v.entree.effectiveAt ?? v.entree.retrievedAt).toISOString(),
    ageH: v.ageH,
    phrase: v.phrase,
  }));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VUE GLOBALE — le Super Admin SEUL (Direction, 02/11/2026).
 *
 * « Tout le monde verra les missions d'Adam, chacun selon les missions qu'il lui a données » : chacun lit les siennes
 * (`centreDeMissions(ownerId)`, les travaux de l'assistant filtrés par personne). Le Super Admin garde EN PLUS le parc
 * entier, toutes personnes confondues, avec le nom du propriétaire. Cette lecture n'a AUCUN filtre de propriétaire :
 * l'appelant la garde par `peutPiloterMissionsAdam` — la page, et elle seule, l'appelle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface LigneGlobale {
  id: string;
  titre: string;
  statut: string;
  etat: string;
  /** RUNTIME (exécution), TRAVAIL (travail long de l'assistant), WATCH (surveillance)… */
  genre: string;
  proprietaire: { id: string; nom: string };
  majLe: string;
}

export async function vueGlobaleDesMissions(opts: { limite?: number } = {}): Promise<{ lignes: LigneGlobale[]; vivantes: number; personnes: number }> {
  const limite = Math.min(Math.max(1, opts.limite ?? 60), 200);
  const vivantes = { status: { notIn: [...TERMINALES] as never[] } };
  const [missions, nVivantes, parPersonne] = await Promise.all([
    prisma.mission.findMany({
      where: { parentMissionId: null },
      select: { id: true, title: true, status: true, kind: true, updatedAt: true, owner: { select: { id: true, name: true } } },
      orderBy: { updatedAt: "desc" },
      take: limite,
    }),
    prisma.mission.count({ where: { parentMissionId: null, ...vivantes } }),
    prisma.mission.groupBy({ by: ["ownerId"], where: { parentMissionId: null, ...vivantes } }),
  ]);
  return {
    lignes: missions.map((m) => ({
      id: m.id, titre: m.title, statut: m.status, etat: MISSION_STATUS_LABEL[m.status] ?? m.status, genre: m.kind,
      proprietaire: { id: m.owner.id, nom: m.owner.name }, majLe: m.updatedAt.toISOString(),
    })),
    vivantes: nVivantes,
    personnes: parPersonne.length,
  };
}
