import { Prisma, type AssistantMandat, type AssistantSignal } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import type { CurrentUser } from "@/lib/session";
import { accesAssistantIa } from "../role-config";
import { executerOperationJournalisee, OPERATIONS_IA } from "../operations";
import { lireConsoleProactivite } from "./reglages";
import { debutDuJourAlger } from "../../domaine/proactivite/budget";
import { CAPACITE, CAPACITES_MANDAT, validerDemandeMandat, verifierGeste, type CapaciteMandat } from "../../domaine/proactivite/mandats";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES MANDATS — accorder, révoquer, faire les gestes (J12, décision 0024).
 *
 * ── OÙ LE GESTE S'EXÉCUTE, ET POURQUOI ───────────────────────────────────────────────────
 *
 * Un geste sous mandat passe par la MÊME porte qu'une carte confirmée : `proposer` (contrôles de
 * l'écran), puis `executerOperationIA` (arrêt d'urgence, droit d'écran), qui appelle L'ACTION
 * MÉTIER DE L'ÉCRAN. Or ces actions lisent la session (`requireUser`) et invalident le cache des
 * pages (`revalidatePath`) : hors d'une requête — sur le battement, sur le worker — elles échouent,
 * et `revalidatePath` lève APRÈS l'écriture (le commentaire est écrit, « ok » est perdu). Mesuré dans
 * le code de Next 15 (« static generation store missing »). Plutôt qu'une identité de fond ou un
 * second chemin d'écriture, les gestes se font DANS UNE REQUÊTE DE LA PERSONNE : la coque de l'ERP
 * appelle `executerMesGestesSousMandat` (au plus une fois par fenêtre de 10 min), sous SA session —
 * jamais en « Vue exacte ». La veille constate en arrière-plan ; le geste suit dès qu'elle revient.
 *
 * ── LE REÇU AVANT LE GESTE ───────────────────────────────────────────────────────────────
 *
 * Le reçu (`AssistantMandatGeste`, unique par mandat et par constat) est PRIS avant d'agir : deux
 * onglets ouverts ne relancent pas deux fois ; un geste coupé en route reste « EN_COURS », jamais
 * rejoué. Chaque geste et chaque refus va à l'audit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const MANDATS_ACTIFS_MAX = 5;
export const FENETRE_GESTES_MS = 10 * 60_000;
const MODULE_AUDIT = "Assistant IA — mandats";

/** Les capacités qu'une personne PEUT mandater : le geste lui est ouvert à l'écran et sa famille l'est à l'assistant. */
export async function capacitesOuvertes(user: CurrentUser): Promise<CapaciteMandat[]> {
  const acces = await accesAssistantIa(user);
  return CAPACITES_MANDAT.filter((c) => {
    const o = OPERATIONS_IA.find((x) => x.nom === c.operation);
    return !!o && o.ouverte(user) && acces.ouvertes.includes(c.famille) && acces.ouvertes.includes("ECRITURES");
  });
}

export async function accorderMandat(user: CurrentUser, entree: Record<string, unknown>, now = new Date()): Promise<{ ok: true; mandat: AssistantMandat } | { ok: false; erreur: string }> {
  const v = validerDemandeMandat(entree, now);
  if (!v.ok) return v;
  if (!(await capacitesOuvertes(user)).some((c) => c.code === v.capacite.code)) return { ok: false, erreur: "Ce geste ne vous est pas ouvert (droits ou console de l'assistant)." };
  const actifs = await prisma.assistantMandat.count({ where: { userId: user.id, statut: { in: ["ACTIF", "EN_ATTENTE_CONSOLE"] }, expireLe: { gt: now } } });
  if (actifs >= MANDATS_ACTIFS_MAX) return { ok: false, erreur: `Vous avez déjà ${MANDATS_ACTIFS_MAX} mandats : révoquez-en un.` };
  const d = v.demande;
  const mandat = await prisma.assistantMandat.create({
    data: {
      userId: user.id, capacite: d.capacite, statut: v.console ? "EN_ATTENTE_CONSOLE" : "ACTIF", destinataires: d.destinataires,
      montantMax: d.montantMax, gestesParJour: d.gestesParJour, expireLe: d.expireLe, accordeLe: now,
    },
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: MODULE_AUDIT,
    summary: `Mandat accordé : « ${v.capacite.libelle} », ${d.gestesParJour} geste(s)/jour, jusqu'au ${d.expireLe.toISOString().slice(0, 10)}`
      + `${d.destinataires.length ? `, ${d.destinataires.length} destinataire(s)` : ""}${v.console ? " — en attente de la console" : ""}`,
  });
  return { ok: true, mandat };
}

/** Révoquer : la personne (le sien) ou le Super Admin (n'importe lequel). Immédiat. */
export async function revoquerMandat(par: CurrentUser, id: string, now = new Date()): Promise<boolean> {
  const where = par.role === "SUPER_ADMIN" ? { id } : { id, userId: par.id };
  const r = await prisma.assistantMandat.updateMany({ where: { ...where, statut: { in: ["ACTIF", "EN_ATTENTE_CONSOLE"] } }, data: { statut: "REVOQUE", revoqueLe: now, revoqueParId: par.id } });
  if (r.count) await recordAudit({ actorId: par.id, action: "UPDATE", module: MODULE_AUDIT, summary: `Mandat ${id} révoqué` });
  return r.count === 1;
}

/** L'accord de la console (Super Admin) pour une capacité sensible. */
export async function approuverMandat(admin: CurrentUser, id: string, now = new Date()): Promise<boolean> {
  if (admin.role !== "SUPER_ADMIN") return false;
  const r = await prisma.assistantMandat.updateMany({ where: { id, statut: "EN_ATTENTE_CONSOLE", expireLe: { gt: now } }, data: { statut: "ACTIF", consoleParId: admin.id, consoleLe: now } });
  if (r.count) await recordAudit({ actorId: admin.id, action: "VALIDATE", module: MODULE_AUDIT, summary: `Mandat ${id} approuvé par la console` });
  return r.count === 1;
}

export async function listerMandats(userId: string | null, now = new Date()) {
  await prisma.assistantMandat.updateMany({ where: { ...(userId ? { userId } : {}), statut: { in: ["ACTIF", "EN_ATTENTE_CONSOLE"] }, expireLe: { lte: now } }, data: { statut: "EXPIRE" } });
  const mandats = await prisma.assistantMandat.findMany({
    where: userId ? { userId } : { statut: { in: ["ACTIF", "EN_ATTENTE_CONSOLE"] } },
    orderBy: [{ statut: "asc" }, { accordeLe: "desc" }], take: 50,
  });
  // Les derniers gestes, lus à part (un `take` imbriqué ne serait pas un LIMIT) : 10 par mandat au plus à l'écran.
  const gestes = mandats.length ? await prisma.assistantMandatGeste.findMany({ where: { mandatId: { in: mandats.map((m) => m.id) } }, orderBy: { faitLe: "desc" }, take: 300 }) : [];
  return mandats.map((m) => ({
    id: m.id, userId: m.userId, capacite: m.capacite, libelle: CAPACITE.get(m.capacite)?.libelle ?? m.capacite, statut: m.statut,
    destinataires: m.destinataires.length, montantMax: m.montantMax, gestesParJour: m.gestesParJour,
    expireLe: m.expireLe.toISOString(), accordeLe: m.accordeLe.toISOString(),
    gestes: gestes.filter((g) => g.mandatId === m.id).slice(0, 10).map((g) => ({ id: g.id, statut: g.statut, resume: g.resume, lien: g.lien, faitLe: g.faitLe.toISOString() })),
  }));
}

// ─────────────────────────────── Les gestes ───────────────────────────────

/** Ce que le geste demande à l'opération, et qui il touche — par capacité. `null` : le constat ne se prête plus au geste. */
async function preparer(c: CapaciteMandat, s: AssistantSignal, user: CurrentUser): Promise<{ entree: Record<string, unknown>; destinataires: string[]; montant: number | null } | null> {
  if (c.code === "RELANCER_VALIDATEUR") {
    if (!s.entiteId) return null;
    const d = await prisma.validationRequest.findFirst({
      where: { id: s.entiteId, requesterId: user.id, status: "PENDING" },
      select: { reference: true, title: true, steps: { where: { status: "PENDING" }, orderBy: { order: "asc" }, take: 1, select: { validatorId: true } } },
    });
    const validateur = d?.steps[0]?.validatorId;
    if (!d || !validateur) return null;
    return {
      entree: { demande: d.reference, message: `Bonjour, je me permets de vous relancer sur ${d.reference} — ${d.title}. Merci. (relance envoyée par mon assistant, sous mandat)` },
      destinataires: [validateur], montant: null,
    };
  }
  return null;
}

export interface BilanGestes { faits: number; refuses: number; echecs: number; raison?: string }

/**
 * FAIRE LES GESTES DUS — dans une requête de la personne (voir en tête). Au plus une fois par fenêtre :
 * la prise de la fenêtre est atomique, deux onglets ne passent pas ensemble. Ne lève jamais.
 */
export async function executerGestesSousMandat(user: CurrentUser, now = new Date()): Promise<BilanGestes> {
  const bilan: BilanGestes = { faits: 0, refuses: 0, echecs: 0 };
  try {
    if ((await lireConsoleProactivite()).coupee) return { ...bilan, raison: "proactivité coupée" };
    await prisma.assistantMandat.updateMany({ where: { userId: user.id, statut: { in: ["ACTIF", "EN_ATTENTE_CONSOLE"] }, expireLe: { lte: now } }, data: { statut: "EXPIRE" } });
    const mandats = await prisma.assistantMandat.findMany({ where: { userId: user.id, statut: "ACTIF" } });
    if (!mandats.length) return { ...bilan, raison: "aucun mandat" };
    await prisma.assistantVeille.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} });
    const prise = await prisma.assistantVeille.updateMany({
      where: { userId: user.id, OR: [{ derniersGestesLe: null }, { derniersGestesLe: { lt: new Date(now.getTime() - FENETRE_GESTES_MS) } }] },
      data: { derniersGestesLe: now },
    });
    if (prise.count !== 1) return { ...bilan, raison: "fenêtre déjà prise" };
    const ouvertes = new Set((await capacitesOuvertes(user)).map((c) => c.code));

    for (const m of mandats) {
      const c = CAPACITE.get(m.capacite);
      if (!c) continue;
      const signaux = await prisma.assistantSignal.findMany({
        where: { userId: user.id, veilleur: c.veilleur, etat: { in: ["EN_ATTENTE", "LIVRE", "JOURNAL"] } }, orderBy: { detecteLe: "asc" }, take: 20,
      });
      // Déjà traité par CE mandat (quel qu'en soit l'issue), ou déjà FAIT sous un autre : une seule relance par étape.
      const dejaFaits = new Set((await prisma.assistantMandatGeste.findMany({
        where: { signalId: { in: signaux.map((s) => s.id) }, OR: [{ mandatId: m.id }, { userId: user.id, statut: { in: ["FAIT", "EN_COURS"] } }] }, select: { signalId: true },
      })).map((g) => g.signalId));
      for (const s of signaux.filter((x) => !dejaFaits.has(x.id))) {
        const aujourdhui = await prisma.assistantMandatGeste.count({ where: { mandatId: m.id, statut: { in: ["FAIT", "EN_COURS"] }, faitLe: { gte: debutDuJourAlger(now) } } });
        const p = await preparer(c, s, user);
        if (!p) continue;
        const ok = ouvertes.has(c.code)
          ? verifierGeste({ ...m, montantMax: m.montantMax }, { capacite: c.code, destinataires: p.destinataires, montant: p.montant }, aujourdhui, now)
          : { ok: false as const, raison: "geste plus ouvert (droits ou console)" };
        if (!ok.ok) {
          // Le plafond du jour n'est pas un refus du constat : il repassera demain. Les autres refus se disent une fois.
          if (ok.raison.startsWith("plafond")) break;
          if (await recu(m.id, user.id, s.id, "REFUSE", `${s.titre} — non fait : ${ok.raison}`, s.lien, now)) {
            bilan.refuses++;
            await recordAudit({ actorId: user.id, action: "REFUSE", module: MODULE_AUDIT, summary: `Geste sous mandat refusé (${c.libelle}) : ${ok.raison}` });
          }
          continue;
        }
        // LE REÇU D'ABORD : unique par (mandat, constat). Un autre onglet qui l'a pris le fait ; nous, non.
        const geste = await recu(m.id, user.id, s.id, "EN_COURS", s.titre, s.lien, now);
        if (!geste) continue;
        const o = OPERATIONS_IA.find((x) => x.nom === c.operation)!;
        const prop = await o.proposer(p.entree, user);
        const r = "carte" in prop
          ? await executerOperationJournalisee(user, { kind: "assistant_ia_op", op: o.nom, args: prop.args }, { origine: "mandat", cle: `${m.id}|${s.id}`, libelle: `${prop.carte.title} (sous mandat)` })
          : { ok: false, error: "manque" in prop ? `il manque : ${prop.manque.join(", ")}` : prop.erreur };
        const fait = r.ok;
        const resume = fait ? `${"carte" in prop ? prop.carte.title : c.libelle} (${s.titre})` : `${s.titre} — échec : ${r.error ?? "refusé"}`;
        await prisma.assistantMandatGeste.update({ where: { id: geste.id }, data: { statut: fait ? "FAIT" : "ECHEC", resume: resume.slice(0, 400), lien: r.link ?? s.lien } });
        await recordAudit({
          actorId: user.id, action: fait ? "CREATE" : "REFUSE", module: MODULE_AUDIT,
          entityType: s.entiteType === "VALIDATION_REQUEST" ? "VALIDATION_REQUEST" : undefined,
          entityId: s.entiteId ?? undefined,
          summary: `${fait ? "Geste sous mandat" : "Geste sous mandat en échec"} — ${resume}`.slice(0, 500),
        });
        if (fait) bilan.faits++; else bilan.echecs++;
      }
    }
  } catch (e) {
    console.error("[mandats] gestes", user.id, e);
  }
  return bilan;
}

async function recu(mandatId: string, userId: string, signalId: string, statut: string, resume: string, lien: string | null, faitLe: Date) {
  try {
    return await prisma.assistantMandatGeste.create({ data: { mandatId, userId, signalId, statut, resume: resume.slice(0, 400), lien, faitLe } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return null;
    throw e;
  }
}
