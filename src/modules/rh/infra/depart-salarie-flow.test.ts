import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getBlob } from "@/lib/drive-storage";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { createEmployee } from "@/modules/rh/actions";
import {
  annulerFinDeContrat, cocherLigneDeSortie, corrigerFinDeContrat, creerCompteSalarie, genererCertificatDeTravail, enregistrerSoldeDeToutCompte,
  ouvrirFinDeContrat, transfererLigneDeSortie,
} from "@/modules/rh/actions-depart";
import { decideValidation } from "@/lib/actions/validation-actions";
import { fermerLesDepartsEchus, getDepartDeLaFiche } from "@/modules/rh/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DÉPART D'UN SALARIÉ, DE BOUT EN BOUT — par les VRAIS points d'entrée (lot rhdepart).
 *
 * La RH crée la fiche : le compte naît par invitation, une seule fois. Le salarié détient un véhicule des Moyens généraux
 * et du matériel promotionnel, une tâche ouverte, une avance versée. La RH ouvre la fin de contrat : un intrus ne peut
 * rien, le DG ne passe pas avant son tour ; le N+1 renvoie pour correction, la RH corrige depuis la fiche, le N+1 puis
 * le DG valident. La liste de sortie naît préremplie (véhicule, matériel), le solde et le certificat aussi ; le
 * certificat s'émet sur le papier de la société ; le lendemain du dernier jour, la fiche et le compte se ferment.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__rhdepart__";
const form = (champs: Record<string, string>): FormData => { const fd = new FormData(); for (const [k, v] of Object.entries(champs)) fd.set(k, v); return fd; };
async function acteur(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role: u.role, access: await getAccess(id, u.role), mustChangePassword: false } as CurrentUser;
}
const isoDans = (jours: number) => new Date(Date.now() + jours * 86_400_000).toISOString().slice(0, 10);

suite("la fin de contrat d'un salarié — compte, triple validation, sortie, certificat, fermeture", () => {
  const u: Record<string, string> = {};
  let companyId = "", chefEmp = "", employeeId = "", departId = "", requestId = "";
  const dateFin = isoDans(10);
  const debut = new Date();
  let dgUtilise: string | null = null;

  async function nettoyer() {
    // Le DG du circuit peut être le compte PERMANENT du banc (`siege-dg@banc-de-tests.local`) : ses gestes de ce passage partent.
    if (dgUtilise) {
      await prisma.effetSortantDiffere.deleteMany({ where: { principalId: dgUtilise, creeLe: { gte: debut } } }).catch(() => undefined);
      await prisma.assistantGesteJournal.deleteMany({ where: { principalId: dgUtilise, creeLe: { gte: debut } } }).catch(() => undefined);
      await prisma.notification.deleteMany({ where: { userId: dgUtilise, createdAt: { gte: debut }, body: { contains: TAG } } }).catch(() => undefined);
    }
    const emps = await prisma.employee.findMany({ where: { fullName: { startsWith: TAG } }, select: { id: true } });
    const ids = emps.map((e) => e.id);
    await prisma.validationRequest.deleteMany({ where: { entityType: "EMPLOYEE", entityId: { in: ids } } }).catch(() => undefined);
    await prisma.departSalarie.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => undefined);
    await prisma.moyenGeneral.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.promoStockItem.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.promoCatalogueArticle.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.task.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.employee.deleteMany({ where: { id: { in: ids }, managerId: { not: null } } }).catch(() => undefined);
    await prisma.employee.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.documentReference.deleteMany({ where: { company: { name: { startsWith: TAG } } } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
  }

  beforeAll(async () => {
    await nettoyer();
    companyId = (await prisma.company.create({
      data: { name: `${TAG} Pharma`, legalIdentity: { create: { legalName: `${TAG} PHARMA`, legalForm: "SARL", managerName: "SAIDI Karim", managerTitle: "Gérant" } } },
    })).id;
    const mk = async (k: string, role: SessionUser["role"]) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await mk("rh", "VIEWER");
    await mk("chef", "VIEWER");
    await mk("intrus", "VIEWER");
    await mk("dg", "GENERAL_MANAGER");
    for (const module of ["RH", "EMPLOYEES", "HR_REQUESTS"]) {
      await prisma.userAccess.create({ data: { userId: u.rh, module, canView: true, canCreate: true, canUpdate: true, canValidate: true, scope: "ALL" } });
    }
    chefEmp = (await prisma.employee.create({ data: { fullName: `${TAG} chef`, userId: u.chef, companyId } })).id;
  }, 60_000);
  afterAll(nettoyer, 60_000);

  it("créer la fiche crée le compte par invitation — une seule fois, jamais en double", async () => {
    ACTOR = await acteur(u.rh);
    const r = await createEmployee(undefined, form({
      fullName: `${TAG} KACI Lina`, email: `${TAG}Partant@T.dz`, companyId, managerId: chefEmp, position: "Déléguée médicale",
      hireDate: "2025-07-01", baseSalary: "120000", leaveBalanceDays: "12.5",
    }));
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Compte applicatif créé \(Lecteur\)/);
    employeeId = r.id!;
    const fiche = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { userId: true } });
    expect(fiche.userId).toBeTruthy();
    u.partant = fiche.userId!;
    const compte = await prisma.user.findUniqueOrThrow({ where: { id: u.partant } });
    expect(compte).toMatchObject({ email: `${TAG}partant@t.dz`, role: "VIEWER", mustOnboard: true, isActive: true });
    expect(await prisma.userInvite.count({ where: { userId: u.partant, usedAt: null } })).toBe(1);

    // Rejoué : rien de neuf. Une seconde fiche à la même adresse : refusée, la fiche reste sans compte.
    expect(await creerCompteSalarie(form({ id: employeeId }))).toMatchObject({ ok: true });
    const bis = await createEmployee(undefined, form({ fullName: `${TAG} homonyme`, email: `${TAG}partant@t.dz`, companyId }));
    expect(bis.ok).toBe(true);
    expect(bis.message).toMatch(/déjà le compte d'un autre salarié/);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: bis.id! } })).userId).toBeNull();
    expect(await prisma.user.count({ where: { email: `${TAG}partant@t.dz` } })).toBe(1);
  }, 60_000);

  it("un non-RH n'ouvre pas la fin de contrat ; la RH l'ouvre, sa marche est acquise, le N+1 est prévenu", async () => {
    // Ce que le salarié détient, lu à l'accord final.
    await prisma.moyenGeneral.create({ data: { reference: `${TAG}MG1`, type: "VEHICULE", libelle: "Renault Clio", identifiant: "12345-116-16", responsableId: u.partant } });
    const art = await prisma.promoCatalogueArticle.create({ data: { reference: `${TAG}ART`, nom: `${TAG} Présentoir`, famille: "DURABLE" as never } });
    const item = await prisma.promoStockItem.create({ data: { catalogueId: art.id, name: `${TAG} Présentoir`, unit: "pièce", companyId } });
    const lot = await prisma.promoStockLot.create({ data: { itemId: item.id, numero: 1, origine: "SAISIE" } });
    await prisma.promoStockMovement.create({ data: { itemId: item.id, lotId: lot.id, holderId: u.partant, kind: "OPENING", delta: 5 } });
    await prisma.task.create({ data: { title: `${TAG} relancer la pharmacie`, assignedToId: u.partant, status: "TODO" } });
    await prisma.salaryAdvance.create({ data: { employeeId, amount: 20000, status: "PAID", paidDate: new Date() } });

    ACTOR = await acteur(u.intrus);
    expect(await ouvrirFinDeContrat(form({ employeeId, motif: "DEMISSION", dateFin }))).toMatchObject({ ok: false, error: expect.stringMatching(/Réservé aux RH/) });

    ACTOR = await acteur(u.rh);
    expect(await ouvrirFinDeContrat(form({ employeeId, motif: "AUTRE", dateFin }))).toMatchObject({ ok: false, error: expect.stringMatching(/Précisez/) });
    const r = await ouvrirFinDeContrat(form({ employeeId, motif: "DEMISSION", dateFin, preavisJours: "30" }));
    expect(r).toMatchObject({ ok: true });
    departId = r.id!;
    // Une seconde, pendant que la première vit : refusée.
    expect(await ouvrirFinDeContrat(form({ employeeId, motif: "DEMISSION", dateFin }))).toMatchObject({ ok: false, error: expect.stringMatching(/déjà en cours/) });

    const d = await prisma.departSalarie.findUniqueOrThrow({ where: { id: departId } });
    requestId = d.validationRequestId!;
    const v = await prisma.validationRequest.findUniqueOrThrow({ where: { id: requestId }, include: { steps: { orderBy: { order: "asc" } } } });
    expect(v).toMatchObject({ objectType: "DEPART_SALARIE", status: "PENDING", currentOrder: 2, entityType: "EMPLOYEE", entityId: employeeId });
    expect(v.steps.map((s) => [s.validatorId === u.rh ? "rh" : s.validatorId === u.chef ? "chef" : "dg", s.status])).toEqual([["rh", "APPROVED"], ["chef", "PENDING"], ["dg", "PENDING"]]);
    expect(await prisma.notification.count({ where: { userId: u.chef, type: "VALIDATION_REQUIRED" } })).toBe(1);
    // La RH n'est pas « sollicitée » pour sa propre marche, déjà tranchée.
    expect(await prisma.notification.count({ where: { userId: u.rh, type: "VALIDATION_REQUIRED" } })).toBe(0);
  }, 60_000);

  it("RH → N+1 → DG : un intrus est refusé, le DG attend son tour, le renvoi se corrige depuis la fiche", async () => {
    const steps = await prisma.validationStep.findMany({ where: { requestId }, orderBy: { order: "asc" } });
    const [, n1, dg] = steps;
    dgUtilise = dg.validatorId;
    const decider = (stepId: string, decision: string, reason?: string) => decideValidation(form({ stepId, decision, ...(reason ? { reason } : {}) }));

    ACTOR = await acteur(u.intrus);
    expect(await decider(n1.id, "APPROVED")).toMatchObject({ ok: false, error: "Vous n'êtes pas le validateur de cette étape." });
    ACTOR = await acteur(dg.validatorId);
    expect(await decider(dg.id, "APPROVED")).toMatchObject({ ok: false, error: "Ce n'est pas encore votre tour." });

    ACTOR = await acteur(u.chef);
    expect(await decider(n1.id, "CHANGES_REQUESTED", "Le préavis court jusqu'au 31.")).toMatchObject({ ok: true });
    expect((await prisma.departSalarie.findUniqueOrThrow({ where: { id: departId } })).statut).toBe("A_CORRIGER");

    ACTOR = await acteur(u.rh);
    const c = await corrigerFinDeContrat(form({ departId, motif: "DEMISSION", dateFin, preavisJours: "31", correction: "Préavis porté à 31 jours." }));
    expect(c).toMatchObject({ ok: true });
    expect(await prisma.validationRequest.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: "PENDING", version: 2, currentOrder: 2 });

    ACTOR = await acteur(u.chef);
    expect(await decider(n1.id, "APPROVED")).toMatchObject({ ok: true });
    ACTOR = await acteur(dg.validatorId);
    expect(await decider(dg.id, "APPROVED")).toMatchObject({ ok: true });

    const d = await prisma.departSalarie.findUniqueOrThrow({ where: { id: departId } });
    expect(d).toMatchObject({ statut: "VALIDE", preavisJours: 31 });
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } })).contractEnd?.toISOString().slice(0, 10)).toBe(dateFin);
    expect(await prisma.notification.count({ where: { userId: u.partant, title: "Votre départ est enregistré" } })).toBe(1);
  }, 60_000);

  it("la liste de sortie naît préremplie (véhicule, matériel promotionnel, transfert) ; le solde et le certificat aussi", async () => {
    const vue = await getDepartDeLaFiche(employeeId, { avecSolde: true });
    expect(vue?.statut).toBe("VALIDE");
    const t = vue!.taches;
    expect(t.find((x) => x.categorie === "VEHICULE")).toMatchObject({ libelle: "Restituer le véhicule Renault Clio", detail: expect.stringContaining("12345-116-16") });
    expect(t.find((x) => x.categorie === "MATERIEL_PROMO")).toMatchObject({ libelle: `Rendre au magasin : ${TAG} Présentoir`, quantite: 5 });
    expect(t.find((x) => x.source === "AUTO:TRANSFERT_TACHES")?.libelle).toBe(`Transférer 1 tâche en cours à ${TAG} chef`);
    expect(vue!.solde?.find((l) => l.id === "salaire")?.montant).toBe(120000);
    expect(vue!.solde?.some((l) => l.sens === "RETENUE" && l.montant === 20000)).toBe(true);
    expect(vue!.certificat).toMatchObject({ salarie: `${TAG} KACI Lina`, dateFin, societe: `SARL ${TAG} PHARMA`, signataire: "SAIDI Karim" });

    // Sans les droits de paie, le solde ne part pas à l'écran.
    expect((await getDepartDeLaFiche(employeeId, { avecSolde: false }))?.solde).toBeNull();

    // Préparer à nouveau ne double rien.
    const { preparerLaSortie } = await import("@/modules/rh/api");
    await preparerLaSortie(departId, u.rh);
    expect(await prisma.departSalarieTache.count({ where: { departId } })).toBe(t.length);
  }, 60_000);

  it("la liste se tient : cocher (qui, quand), transférer au N+1 ; le solde se modifie", async () => {
    ACTOR = await acteur(u.rh);
    const t = await prisma.departSalarieTache.findMany({ where: { departId } });
    const vehicule = t.find((x) => x.categorie === "VEHICULE")!;
    expect(await cocherLigneDeSortie(form({ tacheId: vehicule.id, fait: "true" }))).toMatchObject({ ok: true });
    expect(await prisma.departSalarieTache.findUniqueOrThrow({ where: { id: vehicule.id } })).toMatchObject({ faitParId: u.rh });

    const transfert = t.find((x) => x.source === "AUTO:TRANSFERT_TACHES")!;
    const r = await transfererLigneDeSortie(form({ tacheId: transfert.id }));
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/1 tâche\(s\) transféré\(s\)/) });
    expect(await prisma.task.count({ where: { title: { startsWith: TAG }, assignedToId: u.chef } })).toBe(1);

    const lignes = [{ libelle: "Salaire de décembre (prorata)", montant: 95000, sens: "GAIN" }, { libelle: "Indemnité de congés", montant: 30000, sens: "GAIN" }];
    expect(await enregistrerSoldeDeToutCompte(form({ departId, lignes: JSON.stringify(lignes) }))).toMatchObject({ ok: true });
    ACTOR = await acteur(u.intrus);
    expect(await enregistrerSoldeDeToutCompte(form({ departId, lignes: "[]" }))).toMatchObject({ ok: false });
  }, 60_000);

  it("le certificat de travail s'émet sur le papier de la société, au dossier RH, et le salarié le voit", async () => {
    ACTOR = await acteur(u.rh);
    const d = await prisma.departSalarie.findUniqueOrThrow({ where: { id: departId } });
    const champs = { ...(d.certificat as Record<string, string>), corps: "Ligne un du certificat.\nIl quitte la société libre de tout engagement." };
    const r = await genererCertificatDeTravail(form({ departId, champs: JSON.stringify(champs) }));
    expect(r).toMatchObject({ ok: true });
    const docs = await prisma.employeeDocument.findMany({ where: { employeeId, category: "WORK_CERTIFICATE" }, orderBy: { createdAt: "asc" } });
    const word = docs.find((x) => x.name.endsWith(".docx"))!;
    expect(word.name).toMatch(/^Certificat de travail/);
    const xml = await (await JSZip.loadAsync((await getBlob(word.blobId))!)).file("word/document.xml")!.async("string");
    expect(xml).toContain("Certificat de travail");
    expect(xml).toContain("Ligne un du certificat.");
    expect(xml).not.toContain("{{");
    expect(xml).not.toContain("Attestation de travail");
    expect(await prisma.departSalarieTache.findFirst({ where: { departId, source: "AUTO:CERTIFICAT" } })).toMatchObject({ faitParId: u.rh });
    expect((await prisma.departSalarie.findUniqueOrThrow({ where: { id: departId } })).certificatEmisLe).not.toBeNull();
  }, 60_000);

  it("le lendemain du dernier jour, la fiche et le compte se ferment — une seule fois ; l'annulation n'est plus possible", async () => {
    expect(await fermerLesDepartsEchus(new Date())).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.partant } })).isActive).toBe(true);
    const apres = new Date(new Date(`${dateFin}T00:00:00.000Z`).getTime() + 86_400_000);
    expect(await fermerLesDepartsEchus(apres)).toBeGreaterThanOrEqual(1);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } })).isActive).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.partant } })).isActive).toBe(false);
    expect(await prisma.departSalarieTache.findFirst({ where: { departId, source: "AUTO:COMPTE" } })).toMatchObject({ faitLe: expect.any(Date) });
    expect(await fermerLesDepartsEchus(apres)).toBe(0);

    ACTOR = await acteur(u.rh);
    expect(await annulerFinDeContrat(form({ departId, motif: "erreur" }))).toMatchObject({ ok: false, error: expect.stringMatching(/consommé/) });
  }, 60_000);
});
