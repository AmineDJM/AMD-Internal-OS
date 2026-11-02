import { createHash } from "node:crypto";
import { notifyRoles } from "@/lib/notify";
import { sansBloquer } from "@/lib/journal";
import { prisma } from "@/lib/prisma";
import type { OrdreCli } from "@/platform/dev/ports";
import { DELAI_ORDRE_EN_COURS_MS, DUREE_VIE_ORDRE_MS, RELAIS_VIVANT_MS, interpreter, lireAuthStatus, type EtatDeclare, type OrdreRelais, type SortieRelais, type TypeOrdre } from "@/platform/dev/relais";

/**
 * LA FILE D'ORDRES DU RELAIS CLAUDE CODE (lot C2, décision 0043 § 3 bis) — côté ERP.
 *
 *   enfiler   l'ordre est RÉCLAMÉ sous sa clé d'idempotence (`ClaudeRelaisOrdre.cleIdempotence` unique) : la même clé ne
 *             produit jamais deux commandes ; un ordre `ECHEC` (rien n'a agi) se re-réclame, `INCERTAIN` non.
 *   tirer     le relais prend le plus ancien `EN_ATTENTE` (passage atomique à `EN_COURS`) ; avant, le balayage : un ordre
 *             `EN_COURS` sans résultat depuis 20 min devient `INCERTAIN`, un ordre jamais tiré depuis 1 h `ECHEC`.
 *   rendre    la sortie brute est interprétée (`interpreter`, pur) ; seul un ordre `EN_COURS` se conclut (un double POST du
 *             relais ne change rien). Le texte de la consigne est effacé une fois l'ordre conclu (l'empreinte reste).
 *   battement chaque tirage met à jour `ClaudeRelaisEtat` (vu le, version de `claude`, `authMethod`).
 */

const CHOIX = { id: true, type: true, statut: true, sessionId: true, sessionUrl: true, erreur: true } as const;
type Ligne = { id: string; type: string; statut: string; sessionId: string | null; sessionUrl: string | null; erreur: string | null };

const versOrdre = (l: Ligne, deja: boolean): OrdreCli => ({
  ordreId: l.id, type: l.type as TypeOrdre, statut: l.statut as OrdreCli["statut"], sessionId: l.sessionId, sessionUrl: l.sessionUrl, erreur: l.erreur, deja,
});

export interface DemandeOrdre { type: TypeOrdre; cleIdempotence: string; texte: string; depot?: string | null; branche?: string | null; sessionCible?: string | null; missionId?: string | null }

export async function enfilerOrdre(d: DemandeOrdre, maintenant = new Date()): Promise<OrdreCli> {
  const cle = d.cleIdempotence.slice(0, 190);
  const donnees = {
    type: d.type, texte: d.texte, empreinte: createHash("sha256").update(d.texte, "utf8").digest("hex").slice(0, 32),
    depot: d.depot ?? null, branche: d.branche ?? null, sessionCible: d.sessionCible ?? null, missionId: d.missionId ?? null,
    expireLe: new Date(maintenant.getTime() + DUREE_VIE_ORDRE_MS),
  };
  const pris = await prisma.claudeRelaisOrdre.createMany({ data: [{ cleIdempotence: cle, ...donnees }], skipDuplicates: true });
  const ligne = await prisma.claudeRelaisOrdre.findUniqueOrThrow({ where: { cleIdempotence: cle }, select: CHOIX });
  if (pris.count === 1) return versOrdre(ligne, false);
  if (ligne.statut === "ECHEC") {
    const n = await prisma.claudeRelaisOrdre.updateMany({ where: { id: ligne.id, statut: "ECHEC" }, data: { ...donnees, statut: "EN_ATTENTE", erreur: null, prisLe: null, termineLe: null } });
    if (n.count === 1) return versOrdre({ ...ligne, statut: "EN_ATTENTE", erreur: null }, false);
  }
  return versOrdre(ligne, true);
}

export async function lireOrdreCli(id: string): Promise<OrdreCli | null> {
  const l = await prisma.claudeRelaisOrdre.findUnique({ where: { id }, select: CHOIX });
  return l ? versOrdre(l, true) : null;
}

/** Le balayage : rien ne reste « en cours » pour toujours, rien ne part après sa date. */
async function balayer(maintenant: Date): Promise<void> {
  await Promise.all([
    prisma.claudeRelaisOrdre.updateMany({ where: { statut: "EN_COURS", prisLe: { lt: new Date(maintenant.getTime() - DELAI_ORDRE_EN_COURS_MS) } }, data: { statut: "INCERTAIN", erreur: "le relais n'a pas rendu de résultat : la commande a pu agir — vérifier sur claude.ai/code", termineLe: maintenant } }),
    prisma.claudeRelaisOrdre.updateMany({ where: { statut: "EN_ATTENTE", expireLe: { lt: maintenant } }, data: { statut: "ECHEC", erreur: "jamais tiré par le relais (hors ligne ?) : rien n'a été envoyé", termineLe: maintenant, texte: "" } }),
  ]);
}

/**
 * Le relais tire : battement de cœur, balayage, puis l'ordre le plus ancien (ou `null`).
 *
 * CONNEXION CLAUDE.AI PERDUE (connexion expirée, déconnexion) : aucun ordre n'est donné — les ordres en file ATTENDENT
 * (leur échéance est repoussée), et le Super Admin est prévenu UNE fois, au passage de « connecté » à « non connecté ».
 */
export async function tirerOrdre(etat: EtatDeclare, maintenant = new Date()): Promise<OrdreRelais | null> {
  const auth = lireAuthStatus(etat.authStatus, etat.authCode);
  const vu = { vuLe: maintenant, version: etat.version?.slice(0, 80) ?? null, authMethod: auth.authMethod, connecte: auth.connecte };
  const avant = await prisma.claudeRelaisEtat.findUnique({ where: { id: "relais" }, select: { connecte: true } });
  await prisma.claudeRelaisEtat.upsert({ where: { id: "relais" }, create: { id: "relais", ...vu }, update: vu });
  if (auth.connecte === false && avant?.connecte !== false) {
    await notifyRoles(["SUPER_ADMIN"], {
      type: "GENERIC",
      title: "Relais Claude Code : connexion claude.ai perdue",
      body: "Les chantiers attendent. Render › claude-relais › Shell › « claude auth login » (URL à ouvrir, code à coller).",
      link: "/admin/developpement",
    }).catch(sansBloquer("chantiers.relais.notification"));
  }
  if (auth.connecte === false) {
    await prisma.claudeRelaisOrdre.updateMany({ where: { statut: "EN_ATTENTE" }, data: { expireLe: new Date(maintenant.getTime() + DUREE_VIE_ORDRE_MS) } });
    return null;
  }
  await balayer(maintenant);
  for (let essai = 0; essai < 3; essai += 1) {
    const c = await prisma.claudeRelaisOrdre.findFirst({ where: { statut: "EN_ATTENTE" }, orderBy: { createdAt: "asc" }, select: { id: true, type: true, depot: true, branche: true, sessionCible: true, texte: true } });
    if (!c) return null;
    const n = await prisma.claudeRelaisOrdre.updateMany({ where: { id: c.id, statut: "EN_ATTENTE" }, data: { statut: "EN_COURS", prisLe: maintenant } });
    if (n.count === 1) return { id: c.id, type: c.type as TypeOrdre, depot: c.depot, branche: c.branche, sessionId: c.sessionCible, texte: c.texte };
  }
  return null;
}

/** Le relais rend une sortie brute. Rend l'ordre conclu (pour le fait `DEV_SESSION`), ou `null` s'il n'était pas en cours. */
export async function rendreOrdre(s: SortieRelais, maintenant = new Date()): Promise<(OrdreCli & { missionId: string | null }) | null> {
  const l = await prisma.claudeRelaisOrdre.findUnique({ where: { id: s.id }, select: { type: true, statut: true, missionId: true } });
  if (!l || l.statut !== "EN_COURS") return null;
  const i = interpreter(l.type as TypeOrdre, s);
  const n = await prisma.claudeRelaisOrdre.updateMany({
    where: { id: s.id, statut: "EN_COURS" },
    data: { statut: i.statut, sessionId: i.sessionId, sessionUrl: i.url, erreur: i.erreur?.slice(0, 500) ?? null, termineLe: maintenant, texte: "" },
  });
  if (n.count !== 1) return null;
  return { ordreId: s.id, type: l.type as TypeOrdre, statut: i.statut, sessionId: i.sessionId, sessionUrl: i.url, erreur: i.erreur, deja: false, missionId: l.missionId };
}

/** Attendre un ordre (long-polling) : le relais tire, l'ERP rend la main dès qu'un ordre arrive, au plus `attenteMs`. */
export async function tirerEnAttendant(etat: EtatDeclare, attenteMs: number, pasMs = 1_500): Promise<OrdreRelais | null> {
  const fin = Date.now() + attenteMs;
  for (;;) {
    const o = await tirerOrdre(etat);
    if (o || Date.now() + pasMs > fin) return o;
    await new Promise((r) => setTimeout(r, pasMs));
  }
}

export interface EtatRelais { vuLe: Date | null; vivant: boolean; version: string | null; authMethod: string | null; connecte: boolean | null; enAttente: number; incertains: number }

export async function etatDuRelais(maintenant = new Date()): Promise<EtatRelais> {
  const [e, enAttente, incertains] = await Promise.all([
    prisma.claudeRelaisEtat.findUnique({ where: { id: "relais" } }),
    prisma.claudeRelaisOrdre.count({ where: { statut: { in: ["EN_ATTENTE", "EN_COURS"] } } }),
    prisma.claudeRelaisOrdre.count({ where: { statut: "INCERTAIN", updatedAt: { gte: new Date(maintenant.getTime() - 7 * 86_400_000) } } }),
  ]);
  return {
    vuLe: e?.vuLe ?? null, vivant: Boolean(e && maintenant.getTime() - e.vuLe.getTime() < RELAIS_VIVANT_MS),
    version: e?.version ?? null, authMethod: e?.authMethod ?? null, connecte: e?.connecte ?? null, enAttente, incertains,
  };
}
