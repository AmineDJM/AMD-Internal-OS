import { prisma } from "@/lib/prisma";
import { globsSeRecouvrent } from "@/lib/missions/chantiers/perimetre";
import type { RefDepot } from "@/lib/missions/chantiers/ports-moteur";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RÉSERVATIONS DES CHANTIERS (lot C1, décision 0042 ; CHANTIERS-DEV.md § 4) — avant tout lancement.
 *
 *   BRANCHE:<dépôt>:<branche>    une branche n'a qu'un chantier
 *   PERIMETRE:<dépôt>:<glob>     deux périmètres qui se RECOUVRENT sont sérialisés (jamais deux chantiers au même endroit)
 *   MIGRATIONS:<dépôt>           exclusif : une seule migration en vol par dépôt
 *   DEPLOIEMENT:<service>        exclusif : un déploiement à la fois par service
 *
 * ATOMIQUE, TOUT OU RIEN : la demande entière passe dans UNE transaction, sous un verrou consultatif (le
 * recouvrement de globs ne s'exprime pas en contrainte d'unicité), et la contrainte d'unicité de `cle` reste le
 * dernier mot entre deux processus. Une réservation EXPIRÉE (chantier mort sans libérer) se reprend ; un chantier
 * vivant prolonge les siennes à chaque passage.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** O2 (décision 0059 § 5) : `RESSOURCE:<dépôt>:<nom>` — une ressource partagée NOMMÉE (schéma, contrat…), exclusive. */
export type RessourceChantier = "BRANCHE" | "PERIMETRE" | "MIGRATIONS" | "DEPLOIEMENT" | "RESSOURCE";

export interface DemandeReservation { ressource: RessourceChantier; depot?: string; valeur: string }

/** Une réservation tenue : 6 h, prolongée à chaque passage du chantier (même en pause). */
export const DUREE_RESERVATION_MS = 6 * 3600_000;

/**
 * Les états d'un chantier VIVANT : sa réservation ne se reprend JAMAIS, même échue (une attente de 24 h, une pause
 * « attend tes consignes », un processus arrêté le temps d'un déploiement). Seule celle d'un chantier fini se reprend.
 */
export const STATUTS_VIVANTS = ["AWAITING_APPROVAL", "READY", "RUNNING", "RETRYING", "WAITING_EVENT", "WAITING_INPUT", "WAITING_DEPENDENCY", "PAUSED"] as const;

/** Une réservation encore TENUE : non échue, ou tenue par un chantier vivant (filtre Prisma). */
export const reservationTenue = (maintenant: Date) => ({ OR: [{ expireLe: { gt: maintenant } }, { mission: { status: { in: [...STATUTS_VIVANTS] } } }] });

export const nomDepot = (d: RefDepot): string => `${d.proprietaire}/${d.nom}`.toLowerCase();

export function cleReservation(d: DemandeReservation): string {
  if (d.ressource === "MIGRATIONS") return `MIGRATIONS:${d.depot}`;
  if (d.ressource === "DEPLOIEMENT") return `DEPLOIEMENT:${d.valeur}`;
  return `${d.ressource}:${d.depot}:${d.valeur}`;
}

export type IssueReservation =
  | { ok: true; cles: string[] }
  | { ok: false; conflit: { cle: string; missionId: string; titre: string | null; motif: string } };

/** Verrou consultatif propre aux réservations : un entier fixe, tenu le temps de la transaction. */
const VERROU = 4_100_218;

export async function reserver(missionId: string, demandes: readonly DemandeReservation[], maintenant = new Date()): Promise<IssueReservation> {
  const expireLe = new Date(maintenant.getTime() + DUREE_RESERVATION_MS);
  const voulues = demandes.map((d) => ({ ...d, cle: cleReservation(d) }));
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${VERROU})`;
      // Reprise par expiration : seulement celles d'un chantier FINI (ou disparu) — un chantier vivant garde les siennes.
      await tx.chantierReservation.deleteMany({ where: { expireLe: { lt: maintenant }, mission: { status: { notIn: [...STATUTS_VIVANTS] } } } });
      const autres = await tx.chantierReservation.findMany({
        where: { missionId: { not: missionId }, OR: [{ cle: { in: voulues.map((v) => v.cle) } }, { ressource: "PERIMETRE", depot: { in: [...new Set(voulues.map((v) => v.depot ?? ""))] } }] },
        select: { cle: true, ressource: true, valeur: true, depot: true, missionId: true, mission: { select: { title: true } } },
      });
      for (const v of voulues) {
        const meme = autres.find((a) => a.cle === v.cle);
        const recouvre = v.ressource === "PERIMETRE"
          ? autres.find((a) => a.ressource === "PERIMETRE" && a.depot === (v.depot ?? null) && globsSeRecouvrent(a.valeur, v.valeur))
          : undefined;
        const a = meme ?? recouvre;
        if (a) {
          return {
            ok: false as const,
            conflit: {
              cle: a.cle, missionId: a.missionId, titre: a.mission.title,
              motif: meme ? `${v.cle} est tenu par « ${a.mission.title} »` : `le périmètre « ${v.valeur} » recouvre « ${a.valeur} » de « ${a.mission.title} »`,
            },
          };
        }
      }
      for (const v of voulues) {
        await tx.chantierReservation.upsert({
          where: { cle: v.cle },
          create: { cle: v.cle, ressource: v.ressource, depot: v.depot ?? null, valeur: v.valeur, missionId, expireLe },
          update: { expireLe },
        });
      }
      return { ok: true as const, cles: voulues.map((v) => v.cle) };
    });
  } catch (e) {
    // LA CONTRAINTE D'UNICITÉ A TRANCHÉ (un prétendant hors verrou) : c'est un conflit, pas une panne.
    if ((e as { code?: string }).code === "P2002") {
      return { ok: false, conflit: { cle: voulues[0]?.cle ?? "?", missionId: "?", titre: null, motif: "réservée à l'instant par un autre chantier" } };
    }
    throw e;
  }
}

/** Libère les réservations d'un chantier (toutes, ou celles d'une ressource). Rend les clés libérées. */
export async function liberer(missionId: string, ressource?: RessourceChantier): Promise<string[]> {
  const where = { missionId, ...(ressource ? { ressource } : {}) };
  const tenues = await prisma.chantierReservation.findMany({ where, select: { cle: true } });
  if (tenues.length) await prisma.chantierReservation.deleteMany({ where });
  return tenues.map((t) => t.cle);
}

/**
 * O2 (décision 0059 § 4.6) — UN CHANTIER ENFANT D'UN PROGRAMME FINI VERT : ses réservations PASSENT au programme (une
 * instruction, aucune fenêtre où un autre chantier pourrait les prendre) jusqu'à l'intégration de son travail. Rend le
 * nombre de réservations transférées (0 : pas de programme parent).
 */
export async function transfererAuProgramme(chantierId: string, maintenant = new Date()): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "ChantierReservation" r SET "missionId" = m."parentMissionId", "expireLe" = ${new Date(maintenant.getTime() + DUREE_RESERVATION_MS)}, "updatedAt" = ${maintenant}
    FROM "Mission" m JOIN "Mission" p ON p."id" = m."parentMissionId" AND p."kind" = 'PROGRAMME'
    WHERE r."missionId" = m."id" AND m."id" = ${chantierId}`;
}

/** Libère des réservations précises d'une mission (un programme rend celles d'une tâche intégrée). */
export async function libererCles(missionId: string, cles: readonly string[]): Promise<number> {
  if (!cles.length) return 0;
  return (await prisma.chantierReservation.deleteMany({ where: { missionId, cle: { in: [...cles] } } })).count;
}

/** Un chantier vivant prolonge ses réservations (chaque passage) : elles n'expirent que s'il meurt. */
export async function prolonger(missionId: string, maintenant = new Date()): Promise<void> {
  await prisma.chantierReservation.updateMany({ where: { missionId }, data: { expireLe: new Date(maintenant.getTime() + DUREE_RESERVATION_MS) } });
}

export async function reservationsDe(missionIds: readonly string[]): Promise<Map<string, { cle: string; expireLe: string }[]>> {
  const rs = missionIds.length
    ? await prisma.chantierReservation.findMany({ where: { missionId: { in: [...missionIds] } }, select: { missionId: true, cle: true, expireLe: true }, orderBy: { cle: "asc" } })
    : [];
  const out = new Map<string, { cle: string; expireLe: string }[]>();
  for (const r of rs) out.set(r.missionId, [...(out.get(r.missionId) ?? []), { cle: r.cle, expireLe: r.expireLe.toISOString() }]);
  return out;
}

/** Les demandes d'un plan, au lancement : branche, chaque glob du périmètre, et les migrations si le plan en écrit. */
export function demandesDuPlan(p: { depot: RefDepot; branche: string; perimetre: readonly string[]; migrations: boolean; ressources?: readonly string[] }): DemandeReservation[] {
  const depot = nomDepot(p.depot);
  return [
    { ressource: "BRANCHE", depot, valeur: p.branche },
    ...p.perimetre.map((g) => ({ ressource: "PERIMETRE" as const, depot, valeur: g })),
    ...(p.migrations ? [{ ressource: "MIGRATIONS" as const, depot, valeur: "migrations" }] : []),
    ...(p.ressources ?? []).map((r) => ({ ressource: "RESSOURCE" as const, depot, valeur: r })),
  ];
}
