import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INTERRUPTEUR GLOBAL DES MISSIONS — « bloque toutes les missions d'Adam » (§118.132).
 *
 * ── LE TROU, MESURÉ ─────────────────────────────────────────────────────────────────────
 *
 * Le dirigeant recevait « Bloqué — Diagnostic — Une molécule qui n'existe pas … » sans arrêt.
 * Des missions de banc laissées vivantes en production se replanifiaient à chaque battement
 * (un refus de juge n'était jamais une RÉPÉTITION, donc jamais un arrêt) et notifiaient à
 * chaque version de plan. Et il n'existait AUCUN interrupteur du moteur : `PAUSED` se pose
 * mission par mission, `MISSIONS_SWEEP=off` est une variable d'environnement qu'un écran ne
 * peut pas poser et qu'un redéploiement remet, et le compte système ne se désactive pas
 * (`admin-actions.ts` le refuse, à raison).
 *
 * ── CE QUE C'EST, ET CE QUE CE N'EST PAS ────────────────────────────────────────────────
 *
 * Un fait de la BASE (`AppSetting.missionsPaused`), donc durable, visible de toutes les
 * instances et de tous les écrans. Il ne touche à AUCUNE mission : les statuts, les étapes,
 * les attentes et les reçus restent ce qu'ils sont, et la levée fait repartir chaque mission
 * exactement où elle en était. C'est ce qui le distingue de « mettre toutes mes missions en
 * pause » (qui écrit N lignes et se lève N fois) et d'« arrêter » (qui est définitif).
 *
 * ── QUI LE LIT — quatre lecteurs, et il en faut quatre (§118.45) ────────────────────────
 *
 *   • le MOTEUR (`runtime/engine.ts:avancer`), à chaque tour : c'est le seul exécutant, donc
 *     l'endroit où TOUT chemin d'avancement converge — battement, clic, réveil par événement ;
 *   • le BATTEMENT (`sweep.ts`), avant de charger quoi que ce soit : ne pas payer des
 *     candidats, des relances et des notifications pour rien ;
 *   • le PILOTE D'HORIZON (`horizon.ts`), qui COMPILE un sous-plan AVANT d'appeler le moteur :
 *     sans lui, une mission longue suspendue continuerait de PAYER du planificateur ;
 *   • le LANCEMENT (`lancerMission`), pour refuser une mission neuve en nommant le remède
 *     plutôt que de l'enregistrer dans un moteur qui ne la fera pas avancer.
 *
 * ── QUI L'ÉCRIT, ET DANS QUEL SENS ──────────────────────────────────────────────────────
 *
 * POSER est un geste qui RÉDUIT : disponible depuis l'écran des réglages d'Adam et depuis la
 * conversation (`mission_control`, geste `suspendre_tout`, direction seulement). LEVER est le
 * geste qui rouvre un moteur : écran seulement (§118.15 — Adam ne relève pas ses propres
 * barrières, et `adam-settings-actions.ts` est refusé au chemin générique, §118.78).
 *
 * ── POURQUOI CE MODULE VIT AU SOCLE (`lib/interrupteurs/`), ET PAS SOUS `lib/missions/` ──
 *
 * Écrit d'abord sous `missions/runtime/`, il y était juste tant que seul le moteur le lisait.
 * Mais la SANTÉ d'Adam (`lib/google/health.ts`, un domaine) doit le servir à l'écran des
 * réglages — le cliquet de frontière refuse à cet écran de lire la base en direct — et un
 * domaine ne remonte pas vers une façade (`domains.test.ts`, « aucun domaine ne remonte vers une
 * façade », mesuré : 1 inversion). Trois couches en ont donc besoin sans avoir le droit de se
 * parler : la façade `missions/`, le domaine `google/`, les actions et le pont. C'est le critère
 * du socle mot pour mot (§118.72, §118.97, §118.128) — et l'obligation qui va avec : ce fichier
 * n'importe rien d'autre que la base.
 *
 * ── LE LECTEUR S'INJECTE, ET VOICI POURQUOI CE N'EST PAS UNE VARIABLE À POSER ───────────
 *
 * L'interrupteur est GLOBAL, et la suite de tests tourne en parallèle sur une seule base : un
 * test qui poserait le vrai interrupteur pour s'éprouver ferait tomber, pendant sa fenêtre,
 * tous les tests de missions des autres processus (§118.115). Le lecteur est donc un
 * paramètre dont le DÉFAUT est le vrai (`lireInterrupteurMissions`), et un banc injecte le
 * sien. La production ne pose rien ; un test de point d'appel vérifie qu'aucun appelant de
 * production ne remplace le lecteur — sinon l'interrupteur serait désarmé en ayant l'air armé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface EtatInterrupteurMissions {
  /** VRAI = aucune mission n'avance, ne se replanifie, ne se lance ni ne notifie. */
  suspendues: boolean;
  /** Depuis quand — la PREMIÈRE pose, jamais écrasée par une seconde. */
  depuis: Date | null;
  /** Qui a posé l'interrupteur (identifiant de compte). */
  parId: string | null;
}

/** Le lecteur tel que le moteur, le battement, l'horizon et le lancement le reçoivent. */
export type LecteurInterrupteur = () => Promise<EtatInterrupteurMissions>;

/** Le sous-ensemble de client dont on a besoin — accepte le client global ET un client de transaction. */
type ClientReglages = Pick<PrismaClient, "appSetting">;

const LIBRE: EtatInterrupteurMissions = { suspendues: false, depuis: null, parId: null };

/** LE VRAI LECTEUR : la ligne `global` d'`AppSetting`. Sans ligne, rien n'est suspendu. */
export async function lireInterrupteurMissions(client: ClientReglages = prisma): Promise<EtatInterrupteurMissions> {
  const row = await client.appSetting.findUnique({
    where: { id: "global" },
    select: { missionsPaused: true, missionsPausedAt: true, missionsPausedById: true },
  });
  if (!row) return LIBRE;
  return {
    suspendues: row.missionsPaused === true,
    depuis: row.missionsPausedAt ?? null,
    parId: row.missionsPausedById ?? null,
  };
}

/** L'écran depuis lequel la suspension se LÈVE — nommé dans chaque refus (§118.30). */
export const ECRAN_REGLAGES_ADAM = "/adam/reglages";

const dateFr = (d: Date): string =>
  new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Africa/Algiers" }).format(d);

/**
 * LA PHRASE D'UN REFUS SOUS SUSPENSION — la même partout (moteur, lancement, conversation).
 * Elle dit le fait, depuis quand, et le geste EXACT qui le lève : un refus qui ne nomme pas le
 * remède fait payer un aller-retour (§118.30).
 */
export function phraseSuspension(etat: EtatInterrupteurMissions): string {
  const depuis = etat.depuis ? ` depuis le ${dateFr(etat.depuis)}` : "";
  return `Les missions d'Adam sont suspendues par la direction${depuis} : aucune mission n'avance, `
    + `ne se replanifie ni ne se lance tant que la suspension n'est pas levée. La levée se fait `
    + `depuis les Réglages d'Adam (${ECRAN_REGLAGES_ADAM}) — rien n'a été perdu, chaque mission `
    + `repartira où elle en était.`;
}

export interface ChangementInterrupteur {
  /** FAUX quand l'interrupteur était déjà dans l'état demandé — rien n'a été écrit. */
  change: boolean;
  etat: EtatInterrupteurMissions;
}

/**
 * POSE l'interrupteur. Idempotent : une seconde pose ne réécrit ni la date ni l'auteur —
 * « depuis quand » doit rester la première fois, sinon l'écran ment sur la durée.
 */
export async function suspendreMissions(actorId: string, client: ClientReglages = prisma): Promise<ChangementInterrupteur> {
  const avant = await lireInterrupteurMissions(client);
  if (avant.suspendues) return { change: false, etat: avant };
  const maintenant = new Date();
  await client.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", missionsPaused: true, missionsPausedAt: maintenant, missionsPausedById: actorId },
    update: { missionsPaused: true, missionsPausedAt: maintenant, missionsPausedById: actorId },
  });
  return { change: true, etat: { suspendues: true, depuis: maintenant, parId: actorId } };
}

/** LÈVE l'interrupteur. Idempotent. Ne touche à aucune mission : elles repartent au prochain battement. */
export async function leverSuspensionMissions(client: ClientReglages = prisma): Promise<ChangementInterrupteur> {
  const avant = await lireInterrupteurMissions(client);
  if (!avant.suspendues) return { change: false, etat: avant };
  await client.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", missionsPaused: false, missionsPausedAt: null, missionsPausedById: null },
    update: { missionsPaused: false, missionsPausedAt: null, missionsPausedById: null },
  });
  return { change: true, etat: LIBRE };
}
