import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { getAppSettings } from "@/lib/settings";
import { advanceWorkflowInstance, ensureInstance as ensureInstanceDuMoteur, stepCreate } from "./engine";
import { defaultDefinition } from "./defaults";
import { getWorkflowForEntity } from "@/lib/queries/workflow";
import { getActionCenter } from "@/lib/queries/action-center";
import { adProState } from "@/lib/ad-pro/unified";
import { resoumettreDemande, retirerDemandeAdPro } from "@/lib/actions/workflow-actions";
import { updateAdProRequest } from "@/lib/actions/ad-pro-edit-actions";
import { cancelCongressRequest } from "@/lib/actions/congress-request-actions";
import { submitEventForApproval } from "@/lib/actions/event-actions";
import { sponsoringAppeal } from "@/lib/actions/sponsoring-actions";
import { transferAdProRequest } from "@/lib/actions/ad-pro-transfer-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RENVOYER POUR CORRECTION, RESOUMETTRE, RETIRER, FAIRE APPEL, RELANCER — par les VRAIES portes
 * (audit 360°, rapport 17 : R01–R04, R15, R24 — §118.186).
 *
 *   kam    délégué médical : il demande (congrès, événement, sponsoring), corrige, resoumet, retire
 *   autre  un second délégué : ni demandeur, ni validateur — il ne peut rien sur la demande d'un collègue
 *   ns     National Sales : l'étape préliminaire d'un KAM
 *   dg     Directeur Général : la porte des grosses dépenses, franchie sous le seuil
 *   pm     Direction Marketing : l'étape qui TRANCHE une demande de KAM
 *   dir    Direction : la vue globale (transfert)
 *
 * Le parcours d'un congrès de KAM : préliminaire (NS) → porte du DG → Direction Marketing. Les
 * montants sont lus contre le seuil RÉEL des réglages, jamais une constante recopiée ici.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `__renvoi${Date.now()}__`;
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const ids: Record<string, string> = {};
const roles: Record<string, UserRole> = {};
const viewer = (qui: string) => ({ id: ids[qui]!, role: roles[qui]!, secondaryRole: null, name: `${TAG}${qui}` });

async function actorFor(qui: string): Promise<CurrentUser> {
  const id = ids[qui]!;
  const access = await getAccess(id, roles[qui] as SessionUser["role"]);
  return { id, name: `${TAG}${qui}`, email: `${TAG}${qui}@t.dz`, role: roles[qui] as SessionUser["role"], secondaryRole: null, access, mustChangePassword: false } as CurrentUser;
}
async function comme(qui: string) { ACTOR = await actorFor(qui); }

const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};

const instanceDe = (entityType: "CONGRESS_INTERNATIONAL" | "EVENT" | "SPONSORING", entityId: string) =>
  prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType, entityId } } });
const circuitExiste = async (entityType: "CONGRESS_INTERNATIONAL" | "EVENT" | "SPONSORING", entityId: string) =>
  (await prisma.workflowInstance.count({ where: { entityType, entityId } })) > 0;
const evenementsDe = async (entityType: "CONGRESS_INTERNATIONAL" | "EVENT" | "SPONSORING", entityId: string) =>
  prisma.workflowStepEvent.findMany({ where: { instance: { entityType, entityId } }, orderBy: { createdAt: "asc" } });
const notifsDe = (qui: string, contient: string) =>
  prisma.notification.findMany({ where: { userId: ids[qui]!, OR: [{ title: { contains: contient } }, { body: { contains: contient } }] } });

/**
 * ═══ LE BANC POSSÈDE SES CIRCUITS ═══
 *
 * MESURÉ : joué à côté de `engine.test.ts`, ce banc tombait deux fois sur deux — non sur un défaut
 * du produit, mais parce que `engine.test.ts` MODIFIE le circuit partagé le temps d'un cas (la porte
 * du DG confiée à la Direction Marketing, l'entrée d'un événement au responsable de département), et
 * `workflow-config.test.ts` remplace le circuit du sponsoring par deux étapes. Un circuit partagé
 * qu'un voisin réécrit n'est pas un décor, c'est une variable (§118.115).
 *
 * Le moteur lit le circuit d'une demande par SA définition (`instance.definitionId`), jamais par la
 * catégorie : chaque demande de ce banc est liée, dès sa naissance, à une COPIE PRIVÉE de la colonne
 * vertébrale, semée par la même fonction que le circuit réel (`stepCreate`). Ce que le banc éprouve
 * est donc le circuit par défaut, et lui seul.
 */
const CIRCUITS: Record<string, string> = {};
async function circuitDuBanc(category: "CONGRESS_INTERNATIONAL" | "EVENTS" | "SPONSORING" | "CONGRESS_NATIONAL"): Promise<string> {
  if (CIRCUITS[category]) return CIRCUITS[category]!;
  const d = defaultDefinition(category);
  const def = await prisma.workflowDefinition.create({
    data: { category: `${TAG}${category}`, name: `${TAG}${d.name}`, steps: { create: d.steps.map(stepCreate) } },
  });
  CIRCUITS[category] = def.id;
  return def.id;
}
const CATEGORIE: Record<string, "CONGRESS_INTERNATIONAL" | "EVENTS" | "SPONSORING" | "CONGRESS_NATIONAL"> = {
  CONGRESS_INTERNATIONAL: "CONGRESS_INTERNATIONAL", EVENT: "EVENTS", SPONSORING: "SPONSORING", CONGRESS_NATIONAL: "CONGRESS_NATIONAL",
};
/** `ensureInstance`, puis la demande est liée au circuit privé du banc. */
async function ensureInstance(entityType: "CONGRESS_INTERNATIONAL" | "EVENT" | "SPONSORING", entityId: string) {
  const inst = await ensureInstanceDuMoteur(entityType, entityId);
  if (!inst) return inst;
  return prisma.workflowInstance.update({ where: { id: inst.id }, data: { definitionId: await circuitDuBanc(CATEGORIE[entityType]!) } });
}

let SEUIL = 1_000_000;
async function nouveauCongres(nom: string, budget: number): Promise<string> {
  const c = await prisma.congressInternational.create({
    data: { name: `${TAG}${nom}`, requestStatus: "AWAITING_PRELIMINARY", requesterId: ids.kam!, estimatedBudget: budget },
  });
  await ensureInstance("CONGRESS_INTERNATIONAL", c.id);
  return c.id;
}

/**
 * LANCE DES GESTES ET LES RETIENT À LEUR PREMIÈRE ÉCRITURE SUR LE CIRCUIT, puis les relâche
 * ensemble (§118.164e). Sans barrière, deux gestes « simultanés » se succèdent souvent, et un banc
 * de concurrence passerait sur le défaut qu'il existe pour attraper.
 */
async function sousBarriere<T>(lancer: () => Promise<T>[]): Promise<T[]> {
  let gestes: Promise<T>[] = [];
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`LOCK TABLE "WorkflowInstance" IN SHARE MODE`);
    gestes = lancer();
    for (const g of gestes) g.catch(() => undefined);
    const debut = Date.now();
    for (;;) {
      await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
      const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query ILIKE '%WorkflowInstance%'`;
      if (n >= gestes.length) break;
      if (Date.now() - debut > 10_000) throw new Error(`les gestes n'ont pas atteint la barrière (${n} en attente sur ${gestes.length})`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }, { timeout: 20_000 });
  return Promise.all(gestes);
}

suite("Renvoyer pour correction, resoumettre, retirer, faire appel, relancer — le moteur Ad & Pro sait faire corriger", () => {
  beforeAll(async () => {
    const faire = (nom: string, role: UserRole) =>
      prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, role, passwordHash: "x" } });
    const quiQuoi: [string, UserRole][] = [
      ["kam", "MEDICAL_DELEGATE"], ["autre", "MEDICAL_DELEGATE"], ["ns", "NATIONAL_SALES"],
      ["dg", "GENERAL_MANAGER"], ["pm", "PRODUCT_MANAGER"], ["dir", "DIRECTION"],
    ];
    const crees = await Promise.all(quiQuoi.map(([n, r]) => faire(n, r)));
    quiQuoi.forEach(([n, r], i) => { ids[n] = crees[i]!.id; roles[n] = r; });
    SEUIL = (await getAppSettings()).adProDgThreshold;
  });

  afterAll(async () => {
    const mine = { OR: [{ name: { startsWith: TAG } }] };
    const congres = await prisma.congressInternational.findMany({ where: mine, select: { id: true } });
    const evts = await prisma.event.findMany({ where: mine, select: { id: true } });
    const spos = await prisma.sponsoringRequest.findMany({ where: { institution: { startsWith: TAG } }, select: { id: true } });
    const entites = [...congres, ...evts, ...spos].map((x) => x.id);
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: { in: entites } } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: entites } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { definition: { category: { startsWith: TAG } } } }).catch(() => {});
    await prisma.workflowDefinition.deleteMany({ where: { category: { startsWith: TAG } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { OR: [{ congressInternationalId: { in: entites } }, { eventId: { in: entites } }, { sponsoringId: { in: entites } }, { congressNationalId: { in: entites } }] } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: mine }).catch(() => {});
    await prisma.event.deleteMany({ where: mine }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { institution: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: Object.values(ids) } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("PRÉMISSES : un seuil réel, et le parcours d'un congrès de KAM (préliminaire → DG → Direction Marketing)", async () => {
    expect(SEUIL, "le seuil du DG se lit dans les réglages").toBeGreaterThan(0);
    const id = await nouveauCongres("Prémisses", Math.round(SEUIL / 2));
    const inst = await instanceDe("CONGRESS_INTERNATIONAL", id);
    expect(inst.currentSlug, "un KAM entre par son superviseur national").toBe("preliminary");
    expect(inst.skippedSlugs, "la Direction des opérations n'est pas sur la route d'un KAM").toEqual(["final"]);
    ids.congresPremisses = id;
  });

  let c1 = "";
  it("RENVOYER exige un motif, et n'est pas ouvert au demandeur lui-même", async () => {
    c1 = await nouveauCongres("Renvoi", Math.round(SEUIL / 2));
    const sansMotif = await advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "CONGRESS_INTERNATIONAL", entityId: c1, action: "RETURN" });
    expect(sansMotif.ok).toBe(false);
    expect(sansMotif.ok ? "" : sansMotif.error).toMatch(/motif du renvoi est obligatoire/);
    const parLeDemandeur = await advanceWorkflowInstance({ viewer: viewer("kam"), entityType: "CONGRESS_INTERNATIONAL", entityId: c1, action: "RETURN", note: "je me renvoie" });
    expect(parLeDemandeur.ok, "le demandeur n'agit pas à l'étape de son superviseur").toBe(false);
    expect((await instanceDe("CONGRESS_INTERNATIONAL", c1)).status).toBe("IN_PROGRESS");
  });

  it("le National Sales RENVOIE : à corriger, chez le demandeur, à cette étape — et le demandeur reçoit le motif", async () => {
    const r = await advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "CONGRESS_INTERNATIONAL", entityId: c1, action: "RETURN", note: "Joignez le programme du congrès" });
    expect(r.ok).toBe(true);
    const inst = await instanceDe("CONGRESS_INTERNATIONAL", c1);
    expect(inst.status).toBe("RETURNED");
    expect(inst.currentSlug, "la demande reviendra à l'étape qui l'a renvoyée").toBe("preliminary");
    expect((await prisma.congressInternational.findUniqueOrThrow({ where: { id: c1 } })).requestStatus).toBe("RETURNED");
    const ev = (await evenementsDe("CONGRESS_INTERNATIONAL", c1)).filter((e) => e.action === "RETURN");
    expect(ev.map((e) => e.note)).toEqual(["Joignez le programme du congrès"]);
    expect((await notifsDe("kam", "Joignez le programme du congrès")).length, "le motif voyage avec la notification").toBe(1);
    expect(adProState("RETURNED"), "la liste unifiée la range à part — ni en attente, ni refusée").toBe("RETURNED");
  });

  it("une demande À CORRIGER n'est pas un circuit clos : le validateur apprend qu'elle est chez son demandeur", async () => {
    const r = await advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "CONGRESS_INTERNATIONAL", entityId: c1, action: "APPROVE", note: "ok" });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/chez son demandeur, pour correction/);
  });

  it("LE DEMANDEUR LIT LE MOTIF — hors de l'historique réservé — et lui seul peut resoumettre", async () => {
    const vueKam = (await getWorkflowForEntity(await actorFor("kam"), "CONGRESS_INTERNATIONAL", c1, ids.kam!))!;
    expect(vueKam.canViewHistory, "PRÉMISSE : l'historique lui reste fermé — le motif doit passer ailleurs").toBe(false);
    expect(vueKam.motif?.nature).toBe("RENVOI");
    expect(vueKam.motif?.motif).toBe("Joignez le programme du congrès");
    expect(vueKam.peutResoumettre).toBe(true);
    const vueNs = (await getWorkflowForEntity(await actorFor("ns"), "CONGRESS_INTERNATIONAL", c1, ids.kam!))!;
    expect(vueNs.peutResoumettre, "le validateur ne resoumet pas à la place du demandeur").toBe(false);
    expect(vueNs.action, "aucun geste de validateur tant que la demande est chez son demandeur").toBeNull();
  });

  it("MON ESPACE : « À corriger » chez le demandeur, avec l'étape et le motif ; rien chez le National Sales", async () => {
    const kam = await getActionCenter(await actorFor("kam"));
    const ligne = kam.items.find((i) => i.key === `corriger-CONGRESS_INTERNATIONAL-${c1}`);
    expect(ligne, "la demande à corriger apparaît dans Mon espace").toBeTruthy();
    expect(ligne?.subtitle).toMatch(/Joignez le programme du congrès/);
    const ns = await getActionCenter(await actorFor("ns"));
    expect(ns.items.some((i) => i.href === `/congress-international/${c1}`), "pas « à arbitrer » chez le validateur").toBe(false);
  });

  it("MODIFIER pendant le renvoi ne prévient personne — la resoumission le fera", async () => {
    await comme("kam");
    const r = await updateAdProRequest(fd({ kind: "CONGRESS_INTERNATIONAL", id: c1, city: "Oran" }));
    expect(r.ok).toBe(true);
    expect((await notifsDe("ns", "modifiée après votre avis")).length).toBe(0);
  });

  it("RESOUMETTRE : refusé à autrui ; le demandeur la renvoie à l'étape qui l'a renvoyée", async () => {
    await comme("ns");
    const parNs = await resoumettreDemande(fd({ entityType: "CONGRESS_INTERNATIONAL", entityId: c1 }));
    expect(parNs.ok).toBe(false);
    await comme("autre");
    const parAutre = await resoumettreDemande(fd({ entityType: "CONGRESS_INTERNATIONAL", entityId: c1 }));
    expect(parAutre.ok, "un collègue ne resoumet pas la demande d'un autre").toBe(false);
    await comme("kam");
    const r = await resoumettreDemande(fd({ entityType: "CONGRESS_INTERNATIONAL", entityId: c1, note: "Programme joint" }));
    expect(r.ok).toBe(true);
    const inst = await instanceDe("CONGRESS_INTERNATIONAL", c1);
    expect(inst.status).toBe("IN_PROGRESS");
    expect(inst.currentSlug).toBe("preliminary");
    expect((await prisma.congressInternational.findUniqueOrThrow({ where: { id: c1 } })).requestStatus, "plus « à corriger » : il attend de nouveau son superviseur").toBe("AWAITING_PRELIMINARY");
    expect((await evenementsDe("CONGRESS_INTERNATIONAL", c1)).filter((e) => e.action === "RESUBMIT").map((e) => e.note)).toEqual(["Programme joint"]);
    expect((await notifsDe("ns", "corrigée et resoumise")).length, "l'étape qui reprend la demande est prévenue").toBeGreaterThan(0);
    const encore = await resoumettreDemande(fd({ entityType: "CONGRESS_INTERNATIONAL", entityId: c1 }));
    expect(encore.ok, "une demande en cours n'a rien à resoumettre").toBe(false);
  });

  it("DEUX RESOUMISSIONS SIMULTANÉES n'en font qu'une — la prise du circuit, sous barrière", async () => {
    const c = await nouveauCongres("Concurrence", Math.round(SEUIL / 2));
    expect((await advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "CONGRESS_INTERNATIONAL", entityId: c, action: "RETURN", note: "à revoir" })).ok).toBe(true);
    await comme("kam");
    const res = await sousBarriere(() => [
      resoumettreDemande(fd({ entityType: "CONGRESS_INTERNATIONAL", entityId: c })),
      resoumettreDemande(fd({ entityType: "CONGRESS_INTERNATIONAL", entityId: c })),
    ]);
    expect(res.filter((r) => r.ok).length, "une seule resoumission passe").toBe(1);
    expect((await evenementsDe("CONGRESS_INTERNATIONAL", c)).filter((e) => e.action === "RESUBMIT").length).toBe(1);
  });

  let c2 = "";
  it("LA PORTE DU DG SE ROUVRE quand la correction fait passer le montant au-dessus du seuil (R15)", async () => {
    c2 = await nouveauCongres("Porte", Math.round(SEUIL / 2));
    expect((await advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "CONGRESS_INTERNATIONAL", entityId: c2, action: "APPROVE", note: "ok NS" })).ok).toBe(true);
    let inst = await instanceDe("CONGRESS_INTERNATIONAL", c2);
    expect(inst.currentSlug, "PRÉMISSE : la porte du DG a été franchie par le montant").toBe("marketing");
    expect((await evenementsDe("CONGRESS_INTERNATIONAL", c2)).some((e) => e.action === "AUTO_SKIP" && e.stepSlug === "dg")).toBe(true);
    expect((await advanceWorkflowInstance({ viewer: viewer("pm"), entityType: "CONGRESS_INTERNATIONAL", entityId: c2, action: "RETURN", note: "Le budget est sous-estimé" })).ok).toBe(true);
    await comme("kam");
    expect((await updateAdProRequest(fd({ kind: "CONGRESS_INTERNATIONAL", id: c2, estimatedBudget: String(SEUIL * 2) }))).ok).toBe(true);
    const r = await resoumettreDemande(fd({ entityType: "CONGRESS_INTERNATIONAL", entityId: c2, note: "Budget réévalué" }));
    expect(r.ok).toBe(true);
    inst = await instanceDe("CONGRESS_INTERNATIONAL", c2);
    expect(inst.currentSlug, "la demande reprend à la porte du DG, pas chez la Direction Marketing").toBe("dg");
    expect((await prisma.congressInternational.findUniqueOrThrow({ where: { id: c2 } })).requestStatus).toBe("PRELIMINARY_APPROVED");
    const resub = (await evenementsDe("CONGRESS_INTERNATIONAL", c2)).filter((e) => e.action === "RESUBMIT");
    expect(resub.at(-1)?.note).toMatch(/ne franchit plus/);
    expect((await notifsDe("pm", "corrigée et resoumise")).length, "celle qui a demandé la correction l'apprend, même avant son étape").toBeGreaterThan(0);
  });

  it("MONTANT REDESCENDU sous le seuil : la porte rouverte se franchit seule à la resoumission", async () => {
    expect((await advanceWorkflowInstance({ viewer: viewer("dg"), entityType: "CONGRESS_INTERNATIONAL", entityId: c2, action: "RETURN", note: "Ramenez le budget sous le seuil" })).ok).toBe(true);
    await comme("kam");
    expect((await updateAdProRequest(fd({ kind: "CONGRESS_INTERNATIONAL", id: c2, estimatedBudget: String(Math.round(SEUIL / 3)) }))).ok).toBe(true);
    expect((await resoumettreDemande(fd({ entityType: "CONGRESS_INTERNATIONAL", entityId: c2 }))).ok).toBe(true);
    expect((await instanceDe("CONGRESS_INTERNATIONAL", c2)).currentSlug).toBe("marketing");
  });

  it("MODIFIER APRÈS UN AVIS (en cours) : la porte franchie se rouvre, et ceux qui ont donné un avis sont prévenus", async () => {
    await comme("kam");
    const r = await updateAdProRequest(fd({ kind: "CONGRESS_INTERNATIONAL", id: c2, estimatedBudget: String(SEUIL * 3) }));
    expect(r.ok).toBe(true);
    expect(r.ok ? r.message ?? "" : "").toMatch(/la demande y retourne/);
    expect((await instanceDe("CONGRESS_INTERNATIONAL", c2)).currentSlug).toBe("dg");
    expect((await evenementsDe("CONGRESS_INTERNATIONAL", c2)).some((e) => e.action === "REOPEN")).toBe(true);
    for (const qui of ["ns", "pm", "dg"]) {
      expect((await notifsDe(qui, "modifiée après votre avis")).length, `${qui} a donné un avis : il l'apprend`).toBeGreaterThan(0);
    }
  });

  it("AVANT TOUT AVIS, une modification ne prévient personne — nul n'a encore rien regardé", async () => {
    const c = await nouveauCongres("Sans avis", Math.round(SEUIL / 2));
    await comme("kam");
    expect((await updateAdProRequest(fd({ kind: "CONGRESS_INTERNATIONAL", id: c, city: "Annaba" }))).ok).toBe(true);
    const tous = await prisma.notification.count({ where: { title: { contains: "modifiée" }, link: { contains: c } } });
    expect(tous).toBe(0);
  });

  it("RETIRER : motif obligatoire, circuit clos, plus aucun geste de validateur — et pas par un collègue", async () => {
    const c = await nouveauCongres("Retrait", Math.round(SEUIL / 2));
    await comme("kam");
    expect((await retirerDemandeAdPro(fd({ entityType: "CONGRESS_INTERNATIONAL", entityId: c }))).ok, "sans motif").toBe(false);
    await comme("autre");
    expect((await retirerDemandeAdPro(fd({ entityType: "CONGRESS_INTERNATIONAL", entityId: c, motif: "pas à moi" }))).ok, "un collègue").toBe(false);
    await comme("kam");
    const r = await retirerDemandeAdPro(fd({ entityType: "CONGRESS_INTERNATIONAL", entityId: c, motif: "Congrès reporté" }));
    expect(r.ok).toBe(true);
    // RETIRER = SUPPRIMER (Direction, 05/10) : la demande et son circuit partent ensemble, par le
    // cœur réversible — la corbeille porte le motif, et le Super Admin peut tout rendre.
    expect(await circuitExiste("CONGRESS_INTERNATIONAL", c), "le circuit part avec la demande").toBe(false);
    expect(await prisma.congressInternational.count({ where: { id: c } }), "la demande est supprimée").toBe(0);
    expect(await prisma.deletedRecord.count({ where: { kind: "CONGRESS_INTERNATIONAL", sourceId: c, restoredAt: null } }), "elle est à la corbeille").toBe(1);
    const trace = await prisma.auditLog.findFirst({ where: { entityId: c, action: "DELETE" } });
    expect(trace?.summary, "l'historique porte le motif").toMatch(/Congrès reporté/);
    const apres = await advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "CONGRESS_INTERNATIONAL", entityId: c, action: "APPROVE" });
    expect(apres.ok, "on n'approuve pas une demande retirée").toBe(false);
  });

  it("RETIRER est refusé tant qu'un poste ENGAGE la dépense — un poste en brouillon ne bloque rien", async () => {
    const c = await nouveauCongres("Retrait engagé", Math.round(SEUIL / 2));
    await prisma.adProItem.create({ data: { congressInternationalId: c, label: `${TAG}Brouillon`, kind: "OTHER" } });
    const engage = await prisma.adProItem.create({ data: { congressInternationalId: c, label: `${TAG}BC demandé`, kind: "OTHER", orderStage: "REQUESTED" } });
    await comme("kam");
    const refus = await retirerDemandeAdPro(fd({ entityType: "CONGRESS_INTERNATIONAL", entityId: c, motif: "Annulé" }));
    expect(refus.ok).toBe(false);
    expect(refus.ok ? "" : refus.error).toMatch(/^1 poste\(s\) de cette demande engagent déjà la dépense/);
    expect((await instanceDe("CONGRESS_INTERNATIONAL", c)).status, "rien n'est fermé sur un refus").toBe("IN_PROGRESS");
    expect(await prisma.congressInternational.count({ where: { id: c } }), "ni supprimé").toBe(1);
    await prisma.adProItem.update({ where: { id: engage.id }, data: { orderStage: "NONE" } });
    expect((await retirerDemandeAdPro(fd({ entityType: "CONGRESS_INTERNATIONAL", entityId: c, motif: "Annulé" }))).ok, "le brouillon seul ne retient pas la demande").toBe(true);
  });

  /**
   * LA RÈGLE « QUI RETIRE » A SON TÉMOIN. Mesuré par un sabotage : la règle neutralisée, le cas
   * ci-dessus restait VERT — le collègue y est refusé PLUS TÔT, par la portée de ligne du congrès
   * (§118.153g), et la règle n'est jamais atteinte. Un événement n'a pas de portée de ligne : un
   * second délégué le VOIT (il tient le module en CONTRIBUTE), sans en être le demandeur ni le
   * trancher. C'est la seule situation où cette règle, et elle seule, décide.
   */
  it("RETIRER : un collègue qui VOIT la demande sans la porter ni la trancher ne la retire pas", async () => {
    const ev = await prisma.event.create({
      data: { name: `${TAG}Événement à retirer`, createdById: ids.kam!, requesterId: ids.kam!, requestStatus: "AWAITING_PRELIMINARY", estimatedBudget: Math.round(SEUIL / 2) },
    });
    await ensureInstance("EVENT", ev.id);
    const collegue = await actorFor("autre");
    expect(await canAccessEntity(collegue, "EVENT", ev.id, "VIEW"), "PRÉMISSE : le collègue voit l'événement — sinon le refus viendrait de la porte").toBe(true);
    expect(userCan(collegue, "EVENTS", "VALIDATE"), "PRÉMISSE : il ne tranche pas les événements").toBe(false);
    expect(hasGlobalView(collegue), "PRÉMISSE : il n'a pas la vue globale").toBe(false);
    await comme("autre");
    const intrus = await retirerDemandeAdPro(fd({ entityType: "EVENT", entityId: ev.id, motif: "pas à moi" }));
    expect(intrus.ok).toBe(false);
    expect(intrus.ok ? "" : intrus.error).toMatch(/Seuls le demandeur et qui tranche ce module retirent une demande/);
    // UN SEUL CHEMIN (audit du 04/10, constat 23) : l'annulation d'un congrès / événement DÉLÈGUE au retrait
    // commun — le même refus, mot pour mot. Elle avait sa propre règle (« Non autorisé. »), et pas la porte
    // de la fiche.
    const parLAutrePorte = await cancelCongressRequest(fd({ type: "EVENT", id: ev.id, motif: "pas à moi" }));
    expect(parLAutrePorte.ok ? "" : parLAutrePorte.error).toMatch(/Seuls le demandeur et qui tranche ce module retirent une demande/);
    expect((await instanceDe("EVENT", ev.id)).status, "rien n'est fermé sur un refus").toBe("IN_PROGRESS");
    await comme("kam");
    expect((await retirerDemandeAdPro(fd({ entityType: "EVENT", entityId: ev.id, motif: "Reporté" }))).ok, "son demandeur, lui, la retire").toBe(true);
    expect(await circuitExiste("EVENT", ev.id)).toBe(false);
    expect(await prisma.event.count({ where: { id: ev.id } })).toBe(0);
  });

  it("ANNULER UN CONGRÈS FERME SON CIRCUIT — l'annulation laissait « Approuver » ouvert sur une demande annulée", async () => {
    const c = await nouveauCongres("Annulation", Math.round(SEUIL / 2));
    await comme("kam");
    expect((await cancelCongressRequest(fd({ type: "INTL", id: c }))).ok, "sans motif").toBe(false);
    expect((await cancelCongressRequest(fd({ type: "INTL", id: c, motif: "Plus de budget" }))).ok).toBe(true);
    expect(await circuitExiste("CONGRESS_INTERNATIONAL", c), "annuler = retirer = supprimer : le circuit part").toBe(false);
    expect((await advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "CONGRESS_INTERNATIONAL", entityId: c, action: "APPROVE" })).ok).toBe(false);
  });

  it("UN TRANSFERT FERME AUSSI UNE DEMANDE À CORRIGER — l'ancienne écriture ne fermait que « en cours »", async () => {
    const c = await nouveauCongres("Transfert", Math.round(SEUIL / 2));
    expect((await advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "CONGRESS_INTERNATIONAL", entityId: c, action: "RETURN", note: "mauvais module" })).ok).toBe(true);
    await comme("dir");
    const r = await transferAdProRequest(undefined, fd({ from: "CONGRESS_INTERNATIONAL", to: "CONGRESS_NATIONAL", sourceId: c }));
    expect(r.ok).toBe(true);
    expect((await instanceDe("CONGRESS_INTERNATIONAL", c)).status).toBe("CANCELLED");
  });

  it("L'APPEL D'UN SPONSORING REFUSÉ ROUVRE L'ÉTAPE QUI A TRANCHÉ — pas la porte du DG (R04)", async () => {
    const spo = await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}SPO`, institution: `${TAG}Association`, type: "Congrès", requesterId: ids.kam!, status: "REFUSED", amountRequested: Math.round(SEUIL / 2) },
    });
    const inst0 = await ensureInstance("SPONSORING", spo.id);
    expect(inst0?.status, "PRÉMISSE : un sponsoring refusé a un circuit clos").toBe("REJECTED");
    await comme("kam");
    const r = await sponsoringAppeal(fd({ id: spo.id, reason: "Le programme a changé" }));
    expect(r.ok).toBe(true);
    const inst = await instanceDe("SPONSORING", spo.id);
    expect(inst.status).toBe("IN_PROGRESS");
    expect(inst.currentSlug, "l'étape qui tranche un sponsoring de KAM").toBe("marketing");
    expect(r.ok ? r.message ?? "" : "").toMatch(/réexamine/);
    expect((await evenementsDe("SPONSORING", spo.id)).find((e) => e.action === "APPEAL")?.note).toBe("Le programme a changé");
    expect((await notifsDe("pm", "appel à réexaminer")).length, "l'étape qui tranche est prévenue").toBeGreaterThan(0);
    const direction = await prisma.notification.findMany({ where: { userId: ids.dir!, link: { contains: spo.id } } });
    expect(direction.map((n) => n.title), "la Direction est informée de l'appel, comme avant le lot").toEqual(["Sponsoring — appel du demandeur"]);
  });

  it("UN APPEL TRANCHÉ PAR LA DIRECTION ne la prévient qu'UNE fois — l'information ne double pas l'étape", async () => {
    const spo = await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}SPO2`, institution: `${TAG}Association DM`, type: "Congrès", requesterId: ids.pm!, status: "REFUSED", amountRequested: Math.round(SEUIL / 2) },
    });
    const inst0 = await ensureInstance("SPONSORING", spo.id);
    expect(inst0?.finalSlug, "PRÉMISSE : la demande de la Direction Marketing est tranchée par la Direction des opérations").toBe("final");
    await comme("pm");
    const r = await sponsoringAppeal(fd({ id: spo.id, reason: "Budget revu" }));
    expect(r.ok).toBe(true);
    expect((await instanceDe("SPONSORING", spo.id)).currentSlug).toBe("final");
    const direction = await prisma.notification.findMany({ where: { userId: ids.dir!, link: { contains: spo.id } } });
    expect(direction.length, "une notification — l'étape qui tranche —, pas une seconde « information »").toBe(1);
    expect(direction[0]?.title).toMatch(/appel à réexaminer/);
  });

  it("UN ÉVÉNEMENT REFUSÉ REPART — nouveau cycle avec motif ; un collègue ne soumet pas l'événement d'un autre (R01)", async () => {
    const ev = await prisma.event.create({ data: { name: `${TAG}Événement`, createdById: ids.kam!, estimatedBudget: Math.round(SEUIL / 2) } });
    await comme("autre");
    const intrus = await submitEventForApproval(fd({ id: ev.id }));
    expect(intrus.ok, "un collègue ne soumet pas l'événement d'un autre").toBe(false);
    await comme("kam");
    expect((await prisma.event.findUniqueOrThrow({ where: { id: ev.id } })).requesterId, "PRÉMISSE : avant la soumission, il n'y a pas encore de demandeur").toBeNull();
    expect((await submitEventForApproval(fd({ id: ev.id }))).ok, "son créateur le soumet").toBe(true);
    await ensureInstance("EVENT", ev.id);
    expect((await advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "EVENT", entityId: ev.id, action: "APPROVE", note: "ok" })).ok).toBe(true);
    expect((await advanceWorkflowInstance({ viewer: viewer("pm"), entityType: "EVENT", entityId: ev.id, action: "REJECT", note: "Hors stratégie cette année" })).ok).toBe(true);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: ev.id } })).requestStatus).toBe("REJECTED");
    const vueRefus = (await getWorkflowForEntity(await actorFor("kam"), "EVENT", ev.id, ids.kam!))!;
    expect(vueRefus.motif?.nature, "le demandeur lit le refus").toBe("REFUS");
    expect(vueRefus.motif?.motif).toBe("Hors stratégie cette année");
    const sansMotif = await submitEventForApproval(fd({ id: ev.id }));
    expect(sansMotif.ok, "relancer exige de dire ce qui a changé").toBe(false);
    const r = await submitEventForApproval(fd({ id: ev.id, note: "Format réduit, budget divisé par deux" }));
    expect(r.ok).toBe(true);
    const inst = await instanceDe("EVENT", ev.id);
    expect(inst.status).toBe("IN_PROGRESS");
    expect(inst.currentSlug).toBe("preliminary");
    const ligne = await prisma.event.findUniqueOrThrow({ where: { id: ev.id } });
    expect(ligne.requestStatus).toBe("AWAITING_PRELIMINARY");
    expect(ligne.rejectionReason, "le refus d'hier ne s'affiche plus au-dessus de la demande d'aujourd'hui").toBeNull();
    expect((await evenementsDe("EVENT", ev.id)).filter((e) => e.action === "REJECT").length, "l'historique du premier cycle reste").toBe(1);
    const vue = (await getWorkflowForEntity(await actorFor("kam"), "EVENT", ev.id, ids.kam!))!;
    expect(vue.motif, "plus de motif de refus sur une demande vivante").toBeNull();
  });

  // ─────────────────────────── UN GESTE À LA FOIS (la prise du circuit) ───────────────────────────

  it("DEUX ACCORDS SIMULTANÉS à la même étape n'en font qu'un — un seul « approuvé » au journal", async () => {
    const c = await nouveauCongres("Double accord", Math.round(SEUIL / 2));
    const res = await sousBarriere(() => [
      advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "CONGRESS_INTERNATIONAL", entityId: c, action: "APPROVE", note: "un" }),
      advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "CONGRESS_INTERNATIONAL", entityId: c, action: "APPROVE", note: "deux" }),
    ]);
    expect(res.filter((r) => r.ok).length, "un seul accord passe").toBe(1);
    const perdant = res.find((r) => !r.ok);
    expect(perdant && !perdant.ok ? perdant.error : "").toMatch(/quelqu'un agit dessus au même instant/);
    expect((await evenementsDe("CONGRESS_INTERNATIONAL", c)).filter((e) => e.action === "APPROVE" && e.stepSlug === "preliminary").length).toBe(1);
  });

  it("UN RENVOI ET UN ACCORD SIMULTANÉS : l'un des deux, jamais les deux", async () => {
    const c = await nouveauCongres("Renvoi contre accord", Math.round(SEUIL / 2));
    const res = await sousBarriere(() => [
      advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "CONGRESS_INTERNATIONAL", entityId: c, action: "RETURN", note: "à corriger" }),
      advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "CONGRESS_INTERNATIONAL", entityId: c, action: "APPROVE", note: "ok" }),
    ]);
    expect(res.filter((r) => r.ok).length).toBe(1);
    const inst = await instanceDe("CONGRESS_INTERNATIONAL", c);
    const gestes = (await evenementsDe("CONGRESS_INTERNATIONAL", c)).filter((e) => e.action === "RETURN" || e.action === "APPROVE");
    expect(gestes.length, "un seul geste au journal").toBe(1);
    if (gestes[0]!.action === "RETURN") expect(inst.status).toBe("RETURNED");
    else expect(inst.status, "approuvée : elle n'est pas « à corriger » en plus").toBe("IN_PROGRESS");
  });

  it("RETIRER PENDANT QU'UN VALIDATEUR APPROUVE : l'un des deux — jamais une demande close ET approuvée", async () => {
    const c = await nouveauCongres("Retrait contre accord", Math.round(SEUIL / 2));
    await comme("kam");
    const res = await sousBarriere<{ ok: boolean }>(() => [
      retirerDemandeAdPro(fd({ entityType: "CONGRESS_INTERNATIONAL", entityId: c, motif: "Annulé" })),
      advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "CONGRESS_INTERNATIONAL", entityId: c, action: "APPROVE", note: "ok" }),
    ]);
    expect(res.filter((r) => r.ok).length).toBe(1);
    // Supprimée (circuit parti) OU approuvée (circuit vivant, avec son accord) — jamais les deux.
    const supprimee = !(await circuitExiste("CONGRESS_INTERNATIONAL", c));
    const approuve = !supprimee && (await evenementsDe("CONGRESS_INTERNATIONAL", c)).some((e) => e.action === "APPROVE");
    expect(supprimee !== approuve, "supprimée OU approuvée, pas les deux").toBe(true);
    if (supprimee) expect(await prisma.congressInternational.count({ where: { id: c } })).toBe(0);
  });

  it("LA PRISE EST RENDUE après un geste — réussi comme refusé en cours de route", async () => {
    const c = await nouveauCongres("Prise rendue", Math.round(SEUIL / 2));
    expect((await advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "CONGRESS_INTERNATIONAL", entityId: c, action: "APPROVE", note: "ok" })).ok).toBe(true);
    expect((await instanceDe("CONGRESS_INTERNATIONAL", c)).claimedAt, "rendue après un accord").toBeNull();
    // Le saut de l'étape qui tranche est refusé APRÈS la prise : le refus doit la rendre aussi.
    const saut = await advanceWorkflowInstance({ viewer: viewer("pm"), entityType: "CONGRESS_INTERNATIONAL", entityId: c, action: "SKIP", note: "on saute" });
    expect(saut.ok ? "" : saut.error, "PRÉMISSE : un refus prononcé sous la prise").toMatch(/ne peut pas être sautée/);
    expect((await instanceDe("CONGRESS_INTERNATIONAL", c)).claimedAt, "rendue après un refus").toBeNull();
    expect((await advanceWorkflowInstance({ viewer: viewer("pm"), entityType: "CONGRESS_INTERNATIONAL", entityId: c, action: "RETURN", note: "et maintenant ?" })).ok, "le circuit n'est pas resté pris").toBe(true);
  });

  it("TOUS LES GESTES respectent une prise en cours — resoumettre, retirer, relancer, faire appel", async () => {
    const prendre = async (entityType: "CONGRESS_INTERNATIONAL" | "EVENT" | "SPONSORING", id: string) =>
      prisma.workflowInstance.update({ where: { entityType_entityId: { entityType, entityId: id } }, data: { claimedAt: new Date() } });
    const liberer = async (entityType: "CONGRESS_INTERNATIONAL" | "EVENT" | "SPONSORING", id: string) =>
      prisma.workflowInstance.update({ where: { entityType_entityId: { entityType, entityId: id } }, data: { claimedAt: null } });

    // Resoumettre
    const c = await nouveauCongres("Prise resoumission", Math.round(SEUIL / 2));
    expect((await advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "CONGRESS_INTERNATIONAL", entityId: c, action: "RETURN", note: "à revoir" })).ok).toBe(true);
    await prendre("CONGRESS_INTERNATIONAL", c);
    await comme("kam");
    const resou = await resoumettreDemande(fd({ entityType: "CONGRESS_INTERNATIONAL", entityId: c }));
    expect(resou.ok ? "" : resou.error, "resoumettre attend son tour").toMatch(/quelqu'un agit dessus au même instant/);
    expect((await instanceDe("CONGRESS_INTERNATIONAL", c)).status).toBe("RETURNED");

    // Retirer
    await liberer("CONGRESS_INTERNATIONAL", c);
    expect((await resoumettreDemande(fd({ entityType: "CONGRESS_INTERNATIONAL", entityId: c }))).ok).toBe(true);
    await prendre("CONGRESS_INTERNATIONAL", c);
    const retrait = await retirerDemandeAdPro(fd({ entityType: "CONGRESS_INTERNATIONAL", entityId: c, motif: "Annulé" }));
    expect(retrait.ok ? "" : retrait.error, "retirer attend son tour").toMatch(/quelqu'un agit dessus au même instant/);
    expect((await instanceDe("CONGRESS_INTERNATIONAL", c)).status).toBe("IN_PROGRESS");

    // Faire appel : le circuit d'abord — la demande n'est pas marquée « en appel » pour rien
    const spo = await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}SPO3`, institution: `${TAG}Association prise`, type: "Congrès", requesterId: ids.kam!, status: "REFUSED", amountRequested: Math.round(SEUIL / 2) },
    });
    await ensureInstance("SPONSORING", spo.id);
    await prendre("SPONSORING", spo.id);
    const appel = await sponsoringAppeal(fd({ id: spo.id, reason: "Nouveau programme" }));
    expect(appel.ok).toBe(false);
    expect((await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spo.id } })).status, "pas « en appel » si le circuit ne s'est pas rouvert").toBe("REFUSED");

    // Relancer un événement refusé
    const ev = await prisma.event.create({ data: { name: `${TAG}Événement pris`, createdById: ids.kam!, requesterId: ids.kam!, requestStatus: "REJECTED", rejectionReason: "Hors budget", estimatedBudget: Math.round(SEUIL / 2) } });
    const instEv = await ensureInstance("EVENT", ev.id);
    expect(instEv?.status, "PRÉMISSE : un événement refusé a un circuit clos").toBe("REJECTED");
    await prendre("EVENT", ev.id);
    const relance = await submitEventForApproval(fd({ id: ev.id, note: "Format réduit" }));
    expect(relance.ok ? "" : relance.error, "relancer attend son tour").toMatch(/quelqu'un agit dessus au même instant/);
    expect((await instanceDe("EVENT", ev.id)).status).toBe("REJECTED");
    const ligne = await prisma.event.findUniqueOrThrow({ where: { id: ev.id } });
    expect(ligne.requestStatus, "la demande n'est pas réécrite quand le circuit ne se relance pas").toBe("REJECTED");
    expect(ligne.rejectionReason).toBe("Hors budget");
    await prisma.workflowInstance.update({ where: { entityType_entityId: { entityType: "EVENT", entityId: ev.id } }, data: { claimedAt: null } });
    expect((await submitEventForApproval(fd({ id: ev.id, note: "Format réduit" }))).ok, "la relance repart une fois le circuit libre").toBe(true);
  });

  it("UNE SUITE D'ÉCRITURE ATTEND SON TOUR — la modification rouvre sa porte une fois le geste en cours terminé", async () => {
    const c = await nouveauCongres("Prise modification", Math.round(SEUIL / 2));
    expect((await advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "CONGRESS_INTERNATIONAL", entityId: c, action: "APPROVE", note: "ok NS" })).ok).toBe(true);
    expect((await instanceDe("CONGRESS_INTERNATIONAL", c)).currentSlug, "PRÉMISSE : porte du DG franchie sous le seuil").toBe("marketing");
    const inst = await instanceDe("CONGRESS_INTERNATIONAL", c);
    await prisma.workflowInstance.update({ where: { id: inst.id }, data: { claimedAt: new Date() } });
    const relache = new Promise<void>((r) => setTimeout(() => {
      void prisma.workflowInstance.update({ where: { id: inst.id }, data: { claimedAt: null } }).then(() => r());
    }, 400));
    await comme("kam");
    const r = await updateAdProRequest(fd({ kind: "CONGRESS_INTERNATIONAL", id: c, estimatedBudget: String(SEUIL * 2) }));
    await relache;
    expect(r.ok).toBe(true);
    expect((await instanceDe("CONGRESS_INTERNATIONAL", c)).currentSlug, "la porte s'est rouverte après l'attente").toBe("dg");
  });

  it("UN TRANSFERT ATTEND LA FIN D'UN GESTE EN COURS pour fermer le circuit de la source", async () => {
    const c = await nouveauCongres("Prise transfert", Math.round(SEUIL / 2));
    const inst = await instanceDe("CONGRESS_INTERNATIONAL", c);
    await prisma.workflowInstance.update({ where: { id: inst.id }, data: { claimedAt: new Date() } });
    const relache = new Promise<void>((r) => setTimeout(() => {
      void prisma.workflowInstance.update({ where: { id: inst.id }, data: { claimedAt: null } }).then(() => r());
    }, 400));
    await comme("dir");
    const r = await transferAdProRequest(undefined, fd({ from: "CONGRESS_INTERNATIONAL", to: "CONGRESS_NATIONAL", sourceId: c }));
    await relache;
    expect(r.ok).toBe(true);
    expect((await instanceDe("CONGRESS_INTERNATIONAL", c)).status, "le circuit de la source est fermé, après l'attente").toBe("CANCELLED");
  });

  it("UNE PRISE EN COURS refuse le geste ; une prise ABANDONNÉE (plus de deux minutes) se reprend", async () => {
    const c = await nouveauCongres("Prise abandonnée", Math.round(SEUIL / 2));
    const inst = await instanceDe("CONGRESS_INTERNATIONAL", c);
    await prisma.workflowInstance.update({ where: { id: inst.id }, data: { claimedAt: new Date() } });
    const pris = await advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "CONGRESS_INTERNATIONAL", entityId: c, action: "APPROVE", note: "ok" });
    expect(pris.ok, "un autre geste est en cours").toBe(false);
    expect(pris.ok ? "" : pris.error).toMatch(/quelqu'un agit dessus au même instant/);
    await prisma.workflowInstance.update({ where: { id: inst.id }, data: { claimedAt: new Date(Date.now() - 3 * 60_000) } });
    expect((await advanceWorkflowInstance({ viewer: viewer("ns"), entityType: "CONGRESS_INTERNATIONAL", entityId: c, action: "APPROVE", note: "ok" })).ok, "une panne ne bloque pas le circuit").toBe(true);
  });
});
