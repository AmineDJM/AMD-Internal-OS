import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'APPEL GÉNÉRIQUE D'UNE CAPACITÉ (lot J6, décision 0020) — contre la vraie base, sous la session de la personne.
 *
 *   • R1+ : une CARTE (intention persistée, kind `assistant_ia_capacite`), rien d'écrit avant la confirmation ; la
 *     confirmation exécute L'ACTION ELLE-MÊME (`executerAction`) sous la session de qui confirme ;
 *   • R3/R4 : la carte est RENFORCÉE — sans la ressaisie exigée, rien ne s'exécute ;
 *   • relus à la confirmation : l'arrêt d'urgence, la porte de l'écran, la famille de la console ;
 *   • R0 : exécutée pendant le tour, sous la session de la personne — sans elle (une reprise de fond), refus ;
 *   • jamais offerte : une action illisible, refusée au chemin générique, ou hors de l'assistant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", async (original) => ({ ...(await original<typeof import("@/lib/session")>()), requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { outilsV1, type PropositionPreparee } from "./infra/outils-v1";
import { capacitesOffertes, executerCapacite, registreDesCapacites } from "./infra/capacites";
import { accesAssistantIa } from "./infra/role-config";
import { refusFamille, resoudreAccesIa, FAMILLES_IA, type FamilleIa } from "./domaine/acces-regles";
import { KIND_CAPACITE, texteARessaisir } from "./domaine/capacites";
import { REFUS_ARRET_URGENCE } from "./infra/operations";
import { confirmerIntentionAssistantIA } from "@/modules/assistant-ia/actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iacap_${Date.now().toString(36)}_`;
let sa: CurrentUser;
let lecteur: CurrentUser;
let karim: CurrentUser;

async function compte(nom: string, role: "SUPER_ADMIN" | "VIEWER", ouvrir = false): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${nom} ${TAG}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  if (ouvrir) await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

const outil = (u: CurrentUser, nom: string, props: PropositionPreparee[]) => {
  const o = outilsV1(u, props, [], [], null, undefined, { capacites: true }).find((t) => t.def.name === nom);
  if (!o) throw new Error(`capacité ${nom} absente pour ${u.role}`);
  return o;
};

suite("l'appel générique d'une capacité (J6)", () => {
  beforeAll(async () => {
    sa = await compte("Admin", "SUPER_ADMIN");
    karim = await compte("Karim", "VIEWER");
    lecteur = await compte("Lecteur", "VIEWER", true);
  });
  afterAll(async () => {
    const ids = [sa?.id, karim?.id, lecteur?.id].filter(Boolean) as string[];
    await prisma.task.deleteMany({ where: { title: { contains: TAG } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { contains: TAG } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("R2 « crée une tâche pour Karim » : une CARTE, la personne désignée par son nom, rien d'écrit ; confirmée → l'action de l'écran crée", async () => {
    ACTEUR = sa;
    const props: PropositionPreparee[] = [];
    const sortie = JSON.parse(await outil(sa, "task__createTask", props).run({ title: `Relancer le fournisseur ${TAG}`, assignedToId: `Karim ${TAG}` }, sa));
    expect(sortie.statut).toBe("EN_ATTENTE_DE_CONFIRMATION");
    expect(props).toHaveLength(1);
    expect(await prisma.task.count({ where: { title: { contains: TAG } } })).toBe(0);
    const intent = await prisma.assistantActionIntent.findUniqueOrThrow({ where: { id: props[0]!.intentId } });
    expect(intent).toMatchObject({ kind: KIND_CAPACITE, status: "PROPOSED", level: "SENSITIVE" });
    expect(intent.payload).toMatchObject({ kind: KIND_CAPACITE, id: "task-actions:createTask", entree: { assignedToId: karim.id } });
    // La carte montre le NOM résolu, jamais l'identifiant nu.
    expect(JSON.stringify(props[0]!.proposition.fields)).toContain(`Karim ${TAG}`);

    const r = await confirmerIntentionAssistantIA(props[0]!.intentId);
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.task.findFirst({ where: { title: { contains: TAG } }, select: { assignedToId: true, createdById: true } })).toEqual({ assignedToId: karim.id, createdById: sa.id });
    // Idempotente : une seconde confirmation ne recrée rien.
    await confirmerIntentionAssistantIA(props[0]!.intentId);
    expect(await prisma.task.count({ where: { title: { contains: TAG } } })).toBe(1);
  });

  it("R4 « supprime la tâche » : carte RENFORCÉE — sans la ressaisie, rien ; avec, l'action supprime", async () => {
    ACTEUR = sa;
    const tache = await prisma.task.findFirstOrThrow({ where: { title: { contains: TAG } }, select: { id: true } });
    const props: PropositionPreparee[] = [];
    JSON.parse(await outil(sa, "task__deleteTask", props).run({ id: tache.id }, sa));
    expect(props[0]!.proposition).toMatchObject({ level: "CRITICAL", confirmText: "SUPPRIMER" });
    expect((await confirmerIntentionAssistantIA(props[0]!.intentId)).ok).toBe(false);
    expect((await confirmerIntentionAssistantIA(props[0]!.intentId, "supprimr")).ok).toBe(false);
    expect(await prisma.task.count({ where: { id: tache.id } })).toBe(1);
    const r = await confirmerIntentionAssistantIA(props[0]!.intentId, "supprimer");
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.task.count({ where: { id: tache.id } })).toBe(0);
  });

  it("une seule carte par tour : la seconde est refusée avant d'être préparée", async () => {
    const props: PropositionPreparee[] = [];
    await outil(sa, "task__createTask", props).run({ title: `Une ${TAG}` }, sa);
    const seconde = JSON.parse(await outil(sa, "task__createTask", props).run({ title: `Deux ${TAG}` }, sa));
    expect(seconde.statut).toBe("REFUS");
    expect(props).toHaveLength(1);
  });

  it("une entrée hors contrat, un champ obligatoire manquant : la carte n'est pas préparée, la raison est dite", async () => {
    const props: PropositionPreparee[] = [];
    const r = JSON.parse(await outil(sa, "task__createTask", props).run({ description: "sans titre" }, sa));
    expect(r.statut).toBe("INCOMPLET");
    expect(JSON.stringify(r.manque)).toMatch(/title/);
    expect(props).toHaveLength(0);
  });

  it("RELUS À LA CONFIRMATION : l'arrêt d'urgence, puis la famille de la console fermée", async () => {
    ACTEUR = sa;
    const props: PropositionPreparee[] = [];
    await outil(sa, "task__createTask", props).run({ title: `Arrêt ${TAG}` }, sa);
    const charge = props[0]!.proposition.payload;
    const avant = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { aiExternalActionsDisabled: true } });
    await prisma.appSetting.upsert({ where: { id: "global" }, create: { id: "global", aiExternalActionsDisabled: true }, update: { aiExternalActionsDisabled: true } });
    try {
      expect(await executerCapacite(sa, charge, await accesAssistantIa(sa))).toEqual({ ok: false, error: REFUS_ARRET_URGENCE });
    } finally {
      await prisma.appSetting.update({ where: { id: "global" }, data: { aiExternalActionsDisabled: avant?.aiExternalActionsDisabled ?? false } });
    }
    const sansEcritures = resoudreAccesIa({ superAdmin: false, droits: Object.fromEntries(FAMILLES_IA.map((f) => [f, f !== "ECRITURES"])) as Record<FamilleIa, boolean> });
    expect(await executerCapacite({ ...sa, role: "VIEWER" } as CurrentUser, charge, sansEcritures)).toMatchObject({ ok: false });
    expect(await prisma.task.count({ where: { title: `Arrêt ${TAG}` } })).toBe(0);
  });

  it("la famille de la console est jugée DANS l'outil : « Écritures métier » fermée → refus nommé, pas de carte", async () => {
    const sansEcritures = resoudreAccesIa({ superAdmin: false, droits: Object.fromEntries(FAMILLES_IA.map((f) => [f, f !== "ECRITURES"])) as Record<FamilleIa, boolean> });
    const props: PropositionPreparee[] = [];
    const o = outilsV1(lecteur, props, [], [], null, sansEcritures, { capacites: true }).find((t) => t.def.name === "task__createTask")!;
    expect(JSON.parse(await o.run({ title: `Fermé ${TAG}` }, lecteur))).toEqual({ statut: "REFUS", raison: refusFamille("ECRITURES") });
    expect(props).toHaveLength(0);
  });

  it("R0 : exécutée pendant le tour sous la session de la personne ; sans session (une reprise de fond), refusée", async () => {
    const props: PropositionPreparee[] = [];
    ACTEUR = sa;
    const lu = await outil(sa, "regulatory__checkDciDuplicate", props).run({ dci: `Introuvable${TAG}` }, sa);
    expect(lu).not.toMatch(/REFUS/);
    expect(props).toHaveLength(0);
    ACTEUR = null;
    expect(JSON.parse(await outil(sa, "regulatory__checkDciDuplicate", props).run({ dci: "x" }, sa)).statut).toBe("REFUS");
    ACTEUR = karim;
    expect(JSON.parse(await outil(sa, "regulatory__checkDciDuplicate", props).run({ dci: "x" }, sa)).statut).toBe("REFUS");
  });

  it("JAMAIS OFFERTE : illisible, refusée au chemin générique, hors de l'assistant ; et un rôle limité ne voit que ses écrans", () => {
    const offertes = new Set(capacitesOffertes(sa).map((c) => c.id));
    for (const c of registreDesCapacites().capacites.filter((x) => x.source === "action" && !x.appelable)) expect(offertes.has(c.id), c.id).toBe(false);
    expect(offertes.has("assistant-ia-actions:confirmerIntentionAssistantIA")).toBe(false);
    expect(offertes.has("bc-signature-actions:signerBonDeCommande")).toBe(false);
    const duLecteur = capacitesOffertes(lecteur).map((c) => c.id);
    expect(duLecteur.length).toBeLessThan(offertes.size);
    expect(duLecteur).not.toContain("regulatory-actions:createRegulatoryProduct");
    expect(duLecteur).not.toContain("finance-actions:createTransaction");
  });

  it("FICHE EMPLOYÉ : jamais le champ du compte ; la carte est renforcée ; confirmée, la fiche est RELUE et seul le champ demandé change", async () => {
    ACTEUR = sa;
    const fiche = await prisma.employee.create({ data: { fullName: `Fiche ${TAG}`, userId: karim.id, isActive: true, baseSalary: 185000, phone: "0550000000", hireDate: new Date("2024-03-01T00:00:00.000Z") } });
    const o = outil(sa, "hr__updateEmployee", []);
    expect(Object.keys((o.def.input_schema as { properties: Record<string, unknown> }).properties)).not.toContain("userId");
    const props: PropositionPreparee[] = [];
    const sortie = JSON.parse(await outil(sa, "hr__updateEmployee", props).run({ id: fiche.id, phone: "0661234567", userId: sa.id }, sa));
    expect(sortie.statut).toBe("EN_ATTENTE_DE_CONFIRMATION");
    expect(props[0]!.proposition).toMatchObject({ level: "CRITICAL" });
    const charge = props[0]!.proposition.payload as { entree: Record<string, unknown> };
    expect(charge.entree).toEqual({ id: fiche.id, phone: "0661234567" });
    // Une charge où l'on aurait glissé le compte : le champ retenu ne passe pas.
    const r = await executerCapacite(sa, { ...charge, entree: { ...charge.entree, userId: sa.id } }, await accesAssistantIa(sa));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const apres = await prisma.employee.findUniqueOrThrow({ where: { id: fiche.id } });
    expect(apres).toMatchObject({ phone: "0661234567", userId: karim.id, isActive: true, fullName: `Fiche ${TAG}` });
    expect(Number(apres.baseSalary)).toBe(185000);
    expect(apres.hireDate?.toISOString().slice(0, 10)).toBe("2024-03-01");
  });

  it("FICHE EMPLOYÉ : toucher la rémunération exige aussi la famille « Salaires & paie »", async () => {
    ACTEUR = sa;
    const fiche = await prisma.employee.create({ data: { fullName: `Paie ${TAG}`, isActive: true, baseSalary: 100000 } });
    const sansSalaires = { superAdmin: false, ouvertes: FAMILLES_IA.filter((f) => f !== "SALAIRES"), explicites: [] };
    const o = outilsV1(sa, [], [], [], null, sansSalaires, { capacites: true }).find((t) => t.def.name === "hr__updateEmployee")!;
    expect(JSON.parse(await o.run({ id: fiche.id, baseSalary: 120000 }, sa)).statut).toBe("REFUS");
    expect(JSON.parse(await o.run({ id: fiche.id, phone: "0770000000" }, sa)).statut).toBe("EN_ATTENTE_DE_CONFIRMATION");
  });

  it("une carte d'avant J6 (charge d'Adam) ne s'exécute plus : elle se redemande", async () => {
    ACTEUR = sa;
    const intent = await prisma.assistantActionIntent.create({
      data: { userId: sa.id, kind: "create_task", module: "WORKSPACE", title: "Ancienne carte", summary: "x", payload: { kind: "create_task", title: `Ancienne ${TAG}` }, status: "PROPOSED", origin: "text", events: [] },
    });
    const r = await confirmerIntentionAssistantIA(intent.id);
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/redemandez/);
    expect(await prisma.task.count({ where: { title: `Ancienne ${TAG}` } })).toBe(0);
  });

  it("la valeur ressaisie d'une carte renforcée : le montant s'il y en a un, sinon le verbe", () => {
    expect(texteARessaisir("Supprimer tâche", { id: "x" })).toBe("SUPPRIMER");
    expect(texteARessaisir("Régler ordre dépense", { id: "x", amount: 120000 })).toBe("120000");
    expect(texteARessaisir("Décider congé", {})).toBe("DECIDER");
  });
});
