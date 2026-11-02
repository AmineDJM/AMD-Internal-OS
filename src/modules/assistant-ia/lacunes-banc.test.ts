import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES MANQUES DU BANC « JARVIS » EN DIRECT (V4-H, 29/10/2026) — corrigés, et tenus contre la vraie base :
 *   (3) l'annuaire rend le N+1 et le département ; (5) la file « à valider par moi » est offerte ;
 *   (6) les demandes Ad & Pro se lisent (par la requête de l'écran) ; (8) l'état d'un dossier réglementaire du
 *   PÉRIMÈTRE (frise, réserves, commentaires, échéances) ; les congés de l'année sur la fiche ; les refus
 *   formulés par le droit ; `send_message` ne renvoie plus à un outil absent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { consigneGestesFermes, outilsV1 } from "./infra/outils-v1";
import { accesAssistantIa } from "./infra/role-config";
import { refusFamille } from "./domaine/acces-regles";
import { CoffretDuTour } from "./domaine/filtre-confidentialite";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iabanc_${Date.now().toString(36)}_`;

suite("les manques du banc V4-H", () => {
  let superAdmin: CurrentUser;
  let lecteur: CurrentUser;
  let assia: CurrentUser;
  let produit = "";

  const session = async (role: string, nom: string): Promise<CurrentUser> => {
    const u = await prisma.user.create({ data: { name: `${nom} ${TAG}`, email: `${TAG}${nom.toLowerCase()}@t.dz`, passwordHash: "x", role: role as never } });
    const access = await getAccess(u.id, u.role);
    return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
  };
  const lire = async (u: CurrentUser, nom: string, entree: Record<string, unknown> = {}) => {
    const o = outilsV1(u, [], [], [], new CoffretDuTour(), await accesAssistantIa(u)).find((t) => t.def.name === nom);
    return o ? o.run(entree, u) : null;
  };

  beforeAll(async () => {
    superAdmin = await session("SUPER_ADMIN", "Direction");
    lecteur = await session("VIEWER", "Leila");
    assia = await session("MEDICAL_DELEGATE", "Assia");
    const chef = await prisma.employee.create({ data: { fullName: `Walid ${TAG}Chef`, position: "Directeur marketing" } });
    const e = await prisma.employee.create({ data: { fullName: `Assia ${TAG}Benali`, userId: assia.id, position: "Cheffe de produit", managerId: chef.id } });
    await prisma.leaveRequest.create({ data: { employeeId: e.id, type: "SICK", startDate: new Date(Date.UTC(new Date().getUTCFullYear(), 2, 3)), endDate: new Date(Date.UTC(new Date().getUTCFullYear(), 2, 5)), days: 3, status: "APPROVED" } });
    produit = (await prisma.regulatoryProduct.create({
      data: {
        reference: `REG-${TAG}`, dci: `Nivolumab${TAG}`, status: "AWAITING_ANPP", comments: "Réponse aux réserves attendue sous 30 jours.",
        targetDate: new Date("2026-12-15"),
        dossierSteps: { create: [{ kind: "ANPP_RESERVES", label: "Réserves ANPP du 12/10", order: 1, note: "Deux réserves sur le module 3." }] },
      } as never,
    })).id;
  });

  afterAll(async () => {
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: `REG-${TAG}` } } }).catch(() => {});
    await prisma.leaveRequest.deleteMany({ where: { employee: { fullName: { contains: TAG } } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { contains: TAG }, managerId: { not: null } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { contains: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("(3) l'annuaire rend le N+1 et le département — « qui est le manager d'Assia ? »", async () => {
    const r = JSON.parse((await lire(superAdmin, "directory_lookup", { name: `Assia ${TAG}Benali` }))!);
    const fiche = (r.fiches ?? r.items ?? r.resultats ?? [r]).flat().find((f: { nom?: string }) => f?.nom?.includes("Assia")) ?? r;
    expect(JSON.stringify(fiche)).toContain(`Walid ${TAG}Chef`);
  });

  it("(5) « qu'ai-je à valider ? » : la file de décisions est offerte à chacun", async () => {
    expect(outilsV1(lecteur, []).map((o) => o.def.name)).toContain("list_pending_decisions");
    expect(await lire(lecteur, "list_pending_decisions")).not.toMatch(/ne vous est pas ouvert/);
  });

  it("(6) les demandes Ad & Pro se lisent sous la famille Ad & Pro ; fermée → le refus la nomme", async () => {
    const r = JSON.parse((await lire(superAdmin, "demandes_adpro", { annee: "2026" }))!);
    expect(typeof r.total).toBe("number");
    expect(Array.isArray(r.parNatureEtEtat)).toBe(true);
    expect(await lire(lecteur, "demandes_adpro")).toContain(refusFamille("AD_PRO").slice(0, 30));
  });

  it("(8) l'état d'un dossier réglementaire : statut, échéance, frise (réserves) et commentaires — dans le périmètre", async () => {
    const r = JSON.parse((await lire(superAdmin, "etat_dossier_reglementaire", { dossier: `REG-${TAG}` }))!);
    expect(r).toMatchObject({ reference: `REG-${TAG}`, statut: "Attente ANPP", enregistrementCible: "2026-12-15", commentaires: expect.stringContaining("30 jours") });
    expect(r.frise[0]).toMatchObject({ etape: "Réserves ANPP du 12/10", note: expect.stringContaining("module 3") });
    expect(r.lien).toBe(`/regulatory/${produit}`);
    expect(await lire(lecteur, "etat_dossier_reglementaire", { dossier: `REG-${TAG}` })).toContain(refusFamille("REGLEMENTAIRE").slice(0, 30));
  });

  it("les congés de l'année sur la fiche : la nature précise pour la personne elle-même", async () => {
    const r = JSON.parse((await lire(assia, "lire_fiche_rh", { nom: "moi" }))!);
    expect(r.congesDeLAnnee).toEqual([expect.objectContaining({ jours: 3, statut: "APPROVED" })]);
    expect(r.congesDeLAnnee[0].nature).not.toBe("Absent");
    const parSa = JSON.parse((await lire(superAdmin, "lire_fiche_rh", { nom: `Assia ${TAG}Benali` }))!);
    expect(parSa.responsable).toBe(`Walid ${TAG}Chef`);
  });

  it("les refus nomment le DROIT : un geste non ouvert au rôle est dit tel quel ; send_message ne renvoie plus à search_people", () => {
    expect(consigneGestesFermes(superAdmin)).toBeNull();
    expect(consigneGestesFermes(lecteur)).toMatch(/NON OUVERTS À SON RÔLE.*Demande Ad & Pro « autre »/);
    const send = outilsV1(superAdmin, []).find((o) => o.def.name === "send_message")!;
    expect(send.def.description).not.toMatch(/search_people/);
  });
});
