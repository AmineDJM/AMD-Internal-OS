import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT F2 — LES DÉFAUTS PRODUIT DU PASSAGE RÉEL DU 02/11 (soir), REJOUÉS CONTRE LA VRAIE BASE.
 * Rapport : docs/assistant/preuves/audit/ANALYSE.md. Chaque bloc nomme la tâche du banc qu'il tient.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", async (original) => ({ ...(await original<typeof import("@/lib/session")>()), requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { outilsV1, type PropositionPreparee } from "./infra/outils-v1";
import { accesAssistantIa } from "./infra/role-config";
import { familleOuverte, famillesAJuger, gestePourSoi } from "./domaine/acces-regles";
import { censurerTexte } from "./domaine/filtre-confidentialite";
import { confirmerIntentionAssistantIA } from "@/modules/assistant-ia/actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__f2_${Date.now().toString(36)}_`;

async function compte(nom: string, role: string): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${nom} ${TAG}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role: role as never } });
  await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

describe("F2 · TR-RH — les gestes pour soi (règle pure)", () => {
  it("sans champ d'autrui, les familles du dossier RH ne se jugent pas ; avec, si", () => {
    expect(gestePourSoi("hr-actions:requestLeave", { startDate: "2026-12-21" })).toBe(true);
    expect(gestePourSoi("hr-actions:requestLeave", { employeeId: "x" })).toBe(false);
    expect(gestePourSoi("hr-actions:decideLeave", {})).toBe(false);
    expect(famillesAJuger("hr-actions:requestAdvance", ["SALAIRES", "ECRITURES"], { amount: 30000 })).toEqual(["ECRITURES"]);
    expect(famillesAJuger("hr-actions:requestAdvance", ["SALAIRES", "ECRITURES"], { amount: 1, employeeId: "e" })).toEqual(["SALAIRES", "ECRITURES"]);
    // Un geste qui n'est pas « pour soi » garde toutes ses familles.
    expect(famillesAJuger("hr-actions:cancelAdvance", ["SALAIRES", "ECRITURES"])).toEqual(["SALAIRES", "ECRITURES"]);
  });

  it("TR-RH-06 : le montant d'une avance dit par la personne arrive au modèle ; une rémunération reste masquée", () => {
    expect(censurerTexte("Je voudrais demander une avance sur salaire de 30 000 DZD.").texte).toContain("30 000 DZD");
    expect(censurerTexte("un acompte sur mon salaire de 20 000 DA").texte).toContain("20 000 DA");
    expect(censurerTexte("Mon salaire net est de 180 000 DZD").texte).not.toContain("180 000");
    expect(censurerTexte("Le salaire de base: 90 000 DA").texte).not.toContain("90 000");
  });
});

suite("F2 · TR-RH-01/02/04/06 — son congé, son absence, son avance, son attestation (base réelle)", () => {
  let radia: CurrentUser;
  let ficheRadia: { id: string };
  let ficheAutre: { id: string };

  beforeAll(async () => {
    radia = await compte("Radia", "SALES_USER");
    ficheRadia = await prisma.employee.create({ data: { fullName: `Radia KEBIR ${TAG}`, userId: radia.id, isActive: true } });
    ficheAutre = await prisma.employee.create({ data: { fullName: `Assia ABDELAZIZ ${TAG}`, isActive: true } });
  });
  afterAll(async () => {
    const empl = { employee: { fullName: { contains: TAG } } };
    await prisma.leaveRequest.deleteMany({ where: empl }).catch(() => {});
    await prisma.salaryAdvance.deleteMany({ where: empl }).catch(() => {});
    await prisma.hrDocumentRequest.deleteMany({ where: empl }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: radia?.id } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { contains: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  const outil = async (nom: string, props: PropositionPreparee[]) => {
    const o = outilsV1(radia, props, [], [], null, await accesAssistantIa(radia), { capacites: true }).find((t) => t.def.name === nom);
    if (!o) throw new Error(`capacité ${nom} absente`);
    return o;
  };

  it("les familles RH restent FERMÉES pour elle (rien n'est rouvert sur autrui)", async () => {
    const acces = await accesAssistantIa(radia);
    expect(familleOuverte(acces, "FICHES")).toBe(false);
    expect(familleOuverte(acces, "SALAIRES")).toBe(false);
    expect(familleOuverte(acces, "CONTRATS_RH")).toBe(false);
  });

  it("TR-RH-01/02 : son congé annuel et son absence maladie — une carte ; confirmée, posée sur SA fiche", async () => {
    ACTEUR = radia;
    for (const type of ["ANNUAL", "SICK"]) {
      const props: PropositionPreparee[] = [];
      const sortie = JSON.parse(await (await outil("hr__requestLeave", props)).run({ startDate: "2026-12-21", endDate: "2026-12-31", type }, radia));
      expect(sortie.statut, JSON.stringify(sortie)).toBe("EN_ATTENTE_DE_CONFIRMATION");
      const r = await confirmerIntentionAssistantIA(props[0]!.intentId);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
    expect(await prisma.leaveRequest.count({ where: { employeeId: ficheRadia.id } })).toBe(2);
  });

  it("son propre nom recopié dans « employeeId » : retiré, le geste reste pour soi", async () => {
    ACTEUR = radia;
    const props: PropositionPreparee[] = [];
    const sortie = JSON.parse(await (await outil("hr__requestLeave", props)).run({ startDate: "2027-01-04", endDate: "2027-01-05", employeeId: `Radia KEBIR ${TAG}` }, radia));
    expect(sortie.statut, JSON.stringify(sortie)).toBe("EN_ATTENTE_DE_CONFIRMATION");
    expect(JSON.stringify(props[0]!.proposition.payload)).not.toContain("employeeId");
  });

  it("le congé d'AUTRUI reste refusé : la famille « Fiches collaborateurs » se juge sur autrui", async () => {
    ACTEUR = radia;
    const props: PropositionPreparee[] = [];
    const sortie = JSON.parse(await (await outil("hr__requestLeave", props)).run({ startDate: "2026-12-21", endDate: "2026-12-31", employeeId: `Assia ABDELAZIZ ${TAG}` }, radia));
    expect(sortie.statut).not.toBe("EN_ATTENTE_DE_CONFIRMATION");
    expect(props).toHaveLength(0);
    expect(await prisma.leaveRequest.count({ where: { employeeId: ficheAutre.id } })).toBe(0);
  });

  it("TR-RH-06 : son avance de 30 000 DZD — une carte au bon montant ; confirmée, sur SA fiche", async () => {
    ACTEUR = radia;
    const props: PropositionPreparee[] = [];
    const sortie = JSON.parse(await (await outil("hr__requestAdvance", props)).run({ amount: 30000, reason: "Avance" }, radia));
    expect(sortie.statut, JSON.stringify(sortie)).toBe("EN_ATTENTE_DE_CONFIRMATION");
    const intent = await prisma.assistantActionIntent.findUniqueOrThrow({ where: { id: props[0]!.intentId } });
    const r = await confirmerIntentionAssistantIA(intent.id, intent.confirmText ?? undefined);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const avance = await prisma.salaryAdvance.findFirstOrThrow({ where: { employeeId: ficheRadia.id } });
    expect(Number(avance.amount)).toBe(30000);
    // L'avance d'autrui : refusée.
    const autre: PropositionPreparee[] = [];
    expect(JSON.parse(await (await outil("hr__requestAdvance", autre)).run({ amount: 30000, employeeId: `Assia ABDELAZIZ ${TAG}` }, radia)).statut).not.toBe("EN_ATTENTE_DE_CONFIRMATION");
  });

  it("TR-RH-04 : son attestation de travail — l'action de l'ERP, sans mois de note de frais exigé ; confirmée, la demande RH est à SON nom", async () => {
    ACTEUR = radia;
    const props: PropositionPreparee[] = [];
    const sortie = JSON.parse(await (await outil("hr-document__requestHrDocument", props)).run({ type: "WORK_CERTIFICATE", details: "Pour la banque" }, radia));
    expect(sortie.statut, JSON.stringify(sortie)).toBe("EN_ATTENTE_DE_CONFIRMATION");
    const r = await confirmerIntentionAssistantIA(props[0]!.intentId);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await prisma.hrDocumentRequest.count({ where: { employeeId: ficheRadia.id, type: "WORK_CERTIFICATE" } })).toBe(1);
  });
});
