import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * K10c — LES RÉGLAGES ET LA DIFFUSION, RÉVERSIBLES : chaque action EXÉCUTÉE (la vraie, au clic de l'écran), puis
 * ANNULÉE (le bouton « Annuler »), contre la base locale. On vérifie l'état (la valeur d'avant revient), le journal
 * (le geste et son annulation) et l'audit ; puis on RÉTABLIT (l'annulation est elle-même un geste).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { annulerGeste, retablirGeste, type CompteRenduAnnulation } from "@/lib/effets/annulation";
import { expedierEffetsEchus } from "@/lib/effets/fenetre";
import { reglerMaReponseVocale } from "@/modules/assistant-ia/actions";
import { reglerMaConversationPrivee } from "@/modules/assistant-ia/actions-conversations";
import { reglerConsoleProactivite, reglerMaVeille, reglerMonVeilleur } from "@/modules/assistant-ia/actions-proactivite";
import { reglerMaPreferenceDOffice, reglerPrioriteMonTravail } from "@/modules/assistant-ia/actions-travaux";
import { reglerDoubleEcritureLieux } from "@/lib/actions/lieux-actions";
import { reglerDoubleEcritureOrganisations } from "@/modules/referentiels/actions-organisations";
import { reglerDelaiEtape } from "@/lib/actions/process-intelligence-actions";
import { testerEditeurOffice } from "@/lib/actions/onlyoffice-diagnostic-actions";
import { sendBroadcast } from "@/lib/actions/notification-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zk10creg${Date.now()}`;
let moi: CurrentUser;
const autres: string[] = [];
const fd = (o: Record<string, string | string[]>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x); return f; };

/** Le geste que l'action vient d'inscrire — `annulable.gesteId` rendu à l'écran. */
const gesteDe = (r: unknown): string => {
  const g = (r as { annulable?: { gesteId?: string } }).annulable?.gesteId;
  expect(g, JSON.stringify(r)).toBeTruthy();
  return g!;
};
const annuler = async (gesteId: string): Promise<CompteRenduAnnulation> => {
  const r = await annulerGeste(gesteId, moi);
  if ("refus" in r) throw new Error(r.refus);
  return r;
};
const retablir = async (gesteId: string): Promise<CompteRenduAnnulation> => {
  const r = await retablirGeste(gesteId, moi);
  if ("refus" in r) throw new Error(r.refus);
  return r;
};
/** L'annulation est au journal (qui, quand) et à l'audit. */
const traceeDe = async (gesteId: string) => {
  const g = await prisma.assistantGesteJournal.findUniqueOrThrow({ where: { id: gesteId } });
  expect(g.annuleParId).toBe(moi.id);
  expect(g.annuleLe).toBeTruthy();
  expect(await prisma.auditLog.count({ where: { entityId: gesteId, summary: { contains: "Annulation" } } })).toBe(1);
};

suite("K10c — réglages et diffusion : exécuter, annuler, rétablir", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} Admin`, email: `${TAG}@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    moi = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(u.id, "SUPER_ADMIN"), mustChangePassword: false } as unknown as CurrentUser;
    ACTOR = moi;
    for (const n of ["Karim", "Yasmine"]) autres.push((await prisma.user.create({ data: { name: `${TAG} ${n}`, email: `${TAG}${n}@t.dz`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } })).id);
  }, 60_000);

  afterAll(async () => {
    const ids = [moi.id, ...autres];
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: ids } } }).catch(() => undefined);
    await prisma.effetSortantDiffere.deleteMany({ where: { principalId: { in: ids } } }).catch(() => undefined);
    await prisma.processStepSla.deleteMany({ where: { circuit: TAG } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await prisma.mission.deleteMany({ where: { ownerId: { in: ids } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  }, 60_000);

  it("ma veille : la valeur d'avant revient ; rétablir remet la nouvelle", async () => {
    await prisma.assistantVeille.upsert({ where: { userId: moi.id }, create: { userId: moi.id, interruptionsMax: 2 }, update: { interruptionsMax: 2 } });
    const g = gesteDe(await reglerMaVeille(5, 21, 7, true, false));
    expect((await prisma.assistantVeille.findUniqueOrThrow({ where: { userId: moi.id } })).interruptionsMax).toBe(5);
    const r = await annuler(g);
    expect(r.complet).toBe(true);
    expect((await prisma.assistantVeille.findUniqueOrThrow({ where: { userId: moi.id } })).interruptionsMax).toBe(2);
    await traceeDe(g);
    await retablir(g);
    expect((await prisma.assistantVeille.findUniqueOrThrow({ where: { userId: moi.id } })).interruptionsMax).toBe(5);
    // Rétabli : le geste redevient annulable, et l'annulation se refait.
    expect((await prisma.assistantGesteJournal.findUniqueOrThrow({ where: { id: g } })).annuleLe).toBeNull();
    await annuler(g);
    expect((await prisma.assistantVeille.findUniqueOrThrow({ where: { userId: moi.id } })).interruptionsMax).toBe(2);
  });

  it("une valeur changée DEPUIS par quelqu'un : rien n'est écrasé, l'annulation refuse et dit pourquoi", async () => {
    const g = gesteDe(await reglerMaVeille(4, 21, 7, true, false));
    await prisma.assistantVeille.update({ where: { userId: moi.id }, data: { interruptionsMax: 3 } });
    const r = await annulerGeste(g, moi);
    expect("refus" in r ? r.refus : "").toMatch(/Rien n'a été annulé/);
    expect("refus" in r ? r.bloquants?.[0]?.pourquoi : "").toMatch(/vaut maintenant/);
    expect((await prisma.assistantVeille.findUniqueOrThrow({ where: { userId: moi.id } })).interruptionsMax).toBe(3);
    expect((await prisma.assistantGesteJournal.findUniqueOrThrow({ where: { id: g } })).annuleLe).toBeNull();
  });

  it("mon veilleur : l'arrêt est défait, les constats écartés reviennent en attente", async () => {
    await prisma.assistantVeilleur.upsert({ where: { userId_code: { userId: moi.id, code: "VALIDATION_EN_ATTENTE" } }, create: { userId: moi.id, code: "VALIDATION_EN_ATTENTE", actif: true }, update: { actif: true } });
    const signal = await prisma.assistantSignal.create({ data: { userId: moi.id, veilleur: "VALIDATION_EN_ATTENTE", cle: `${TAG}-s`, titre: "Validation en attente", detail: "x", gravite: "INFO", etat: "EN_ATTENTE" } });
    const g = gesteDe(await reglerMonVeilleur("VALIDATION_EN_ATTENTE", false, null));
    expect((await prisma.assistantSignal.findUniqueOrThrow({ where: { id: signal.id } })).etat).toBe("ECARTE");
    await annuler(g);
    expect((await prisma.assistantVeilleur.findUniqueOrThrow({ where: { userId_code: { userId: moi.id, code: "VALIDATION_EN_ATTENTE" } } })).actif).toBe(true);
    expect((await prisma.assistantSignal.findUniqueOrThrow({ where: { id: signal.id } })).etat).toBe("EN_ATTENTE");
    await prisma.assistantSignal.delete({ where: { id: signal.id } });
  });

  it("réponse vocale, préférence d'office, conversation privée, priorité d'un travail : la valeur d'avant revient", async () => {
    const g1 = gesteDe(await reglerMaReponseVocale(true));
    const fils = await prisma.assistantIaFil.findMany({ where: { userId: moi.id } });
    expect(fils.length).toBeGreaterThan(0);
    await annuler(g1);
    // Le fil créé pour porter le réglage est retiré ; ceux qui existaient reprennent leur valeur.
    for (const f of await prisma.assistantIaFil.findMany({ where: { userId: moi.id } })) expect(f.reponseVocale).toBe(false);

    const g2 = gesteDe(await reglerMaPreferenceDOffice(true));
    expect((await prisma.assistantIaPreference.findUnique({ where: { userId: moi.id } }))?.travauxDOffice).toBe(true);
    await annuler(g2);
    expect(await prisma.assistantIaPreference.findUnique({ where: { userId: moi.id } })).toBeNull();

    const fil = await prisma.assistantIaFil.create({ data: { userId: moi.id } });
    const g3 = gesteDe(await reglerMaConversationPrivee(fil.id, true));
    expect((await prisma.assistantIaFil.findUniqueOrThrow({ where: { id: fil.id } })).prive).toBe(true);
    await annuler(g3);
    expect((await prisma.assistantIaFil.findUniqueOrThrow({ where: { id: fil.id } })).prive).toBe(false);

    const t = await prisma.mission.create({ data: { ownerId: moi.id, principalId: moi.id, kind: "TRAVAIL", title: `${TAG} travail`, objective: "x", priority: 0 } as never });
    const g4 = gesteDe(await reglerPrioriteMonTravail(t.id, "HAUTE"));
    expect((await prisma.mission.findUniqueOrThrow({ where: { id: t.id } })).priority).not.toBe(0);
    await annuler(g4);
    expect((await prisma.mission.findUniqueOrThrow({ where: { id: t.id } })).priority).toBe(0);
  });

  it("réglages de la console : proactivité, double écriture des lieux et des organisations, délai d'une étape", async () => {
    const avant = await prisma.assistantIaReglage.findUnique({ where: { id: "global" } });
    const g1 = gesteDe(await reglerConsoleProactivite(7, null));
    expect((await prisma.assistantIaReglage.findUniqueOrThrow({ where: { id: "global" } })).interruptionsMaxJour).toBe(7);
    await annuler(g1);
    const apres = await prisma.assistantIaReglage.findUnique({ where: { id: "global" } });
    expect(apres?.interruptionsMaxJour ?? null).toBe(avant?.interruptionsMaxJour ?? null);

    const lieux = (await prisma.appSetting.findUnique({ where: { id: "global" } }))?.lieuxDoubleEcriture ?? null;
    const g2 = gesteDe(await reglerDoubleEcritureLieux(!lieux));
    await annuler(g2);
    expect((await prisma.appSetting.findUnique({ where: { id: "global" } }))?.lieuxDoubleEcriture ?? null).toBe(lieux);

    const orgs = (await prisma.appSetting.findUnique({ where: { id: "global" } }))?.doubleEcritureOrganisations ?? null;
    const g3 = gesteDe(await reglerDoubleEcritureOrganisations(fd({ actif: orgs ? "0" : "1" })));
    await annuler(g3);
    expect((await prisma.appSetting.findUnique({ where: { id: "global" } }))?.doubleEcritureOrganisations ?? null).toBe(orgs);

    // Un délai posé est retiré ; un délai retiré est recréé à l'identique.
    const g4 = gesteDe(await reglerDelaiEtape(fd({ circuit: TAG, stepKey: "s1", stepLabel: "Étape 1", targetDays: "5" })));
    expect(await prisma.processStepSla.count({ where: { circuit: TAG } })).toBe(1);
    await annuler(g4);
    expect(await prisma.processStepSla.count({ where: { circuit: TAG } })).toBe(0);
    await prisma.processStepSla.create({ data: { circuit: TAG, stepKey: "s2", stepLabel: "Étape 2", targetDays: 3 } });
    const g5 = gesteDe(await reglerDelaiEtape(fd({ circuit: TAG, stepKey: "s2", stepLabel: "Étape 2", targetDays: "" })));
    expect(await prisma.processStepSla.count({ where: { circuit: TAG } })).toBe(0);
    await annuler(g5);
    expect((await prisma.processStepSla.findFirstOrThrow({ where: { circuit: TAG, stepKey: "s2" } })).targetDays).toBe(3);
  });

  it("le diagnostic de l'éditeur Office n'écrit rien : son annulation le dit, sans rien toucher", async () => {
    await testerEditeurOffice();
    // Le diagnostic rend son rapport (ici « échec » : pas d'éditeur configuré en local) ; son geste est au journal.
    const g = await prisma.assistantGesteJournal.findFirstOrThrow({ where: { principalId: moi.id, capaciteId: "onlyoffice-diagnostic-actions:testerEditeurOffice" }, orderBy: { creeLe: "desc" } });
    expect(await prisma.assistantEffet.count({ where: { gesteId: g.id, type: "ECRITURE" } })).toBe(0);
    const c = await annuler(g.id);
    expect(c.details.every((d) => d.issue !== "ANNULE")).toBe(true);
    expect(c.complet).toBe(true);
  });

  it("diffusion : annulée DANS la fenêtre, rien n'est parti", async () => {
    const r = await sendBroadcast(fd({ title: `${TAG} réunion`, body: "Salle B", audience: "USERS", userIds: autres }));
    expect((r as { message?: string }).message).toMatch(/Annuler/);
    const g = gesteDe(r);
    expect(await prisma.notification.count({ where: { userId: { in: autres } } })).toBe(0);
    const c = await annuler(g);
    expect(c.details.some((d) => /rien n'est parti/.test(d.pourquoi))).toBe(true);
    // La fenêtre se ferme : il n'y a plus rien à expédier.
    await expedierEffetsEchus(new Date(Date.now() + 3_600_000));
    expect(await prisma.notification.count({ where: { userId: { in: autres } } })).toBe(0);
    await traceeDe(g);
  });

  it("diffusion : partie APRÈS la fenêtre — non lues retirées, rectificatif à qui l'a lue, la poussée dite ; rétablir les remet", async () => {
    const g = gesteDe(await sendBroadcast(fd({ title: `${TAG} fermeture`, audience: "USERS", userIds: autres })));
    expect(await expedierEffetsEchus(new Date(Date.now() + 3_600_000))).toBeGreaterThanOrEqual(1);
    const parties = await prisma.notification.findMany({ where: { userId: { in: autres }, title: `${TAG} fermeture` } });
    expect(parties).toHaveLength(2);
    await prisma.notification.update({ where: { id: parties.find((n) => n.userId === autres[0])!.id }, data: { isRead: true } });
    const c = await annuler(g);
    const d = c.details.find((x) => x.issue === "COMPENSE")!;
    expect(d.pourquoi).toMatch(/1 notification\(s\) non lue\(s\) retirée\(s\)/);
    expect(d.pourquoi).toMatch(/rectificatif/);
    expect(d.pourquoi).toMatch(/n'est pas effacée chez eux/);
    expect(await prisma.notification.count({ where: { userId: autres[1], title: `${TAG} fermeture` } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: autres[0], title: { startsWith: "Rectificatif" } } })).toBe(1);
    // Rétablir : la notification retirée revient (même identifiant), le rectificatif non lu est retiré.
    await retablir(g);
    expect(await prisma.notification.count({ where: { userId: autres[1], title: `${TAG} fermeture` } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: autres[0], title: { startsWith: "Rectificatif" } } })).toBe(0);
  });
});
