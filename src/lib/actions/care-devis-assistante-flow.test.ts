import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan } from "@/lib/rbac";
import { deleteFileByKey } from "@/lib/storage";
import { createCongressRequest } from "./congress-request-actions";
import { addCareBeneficiary, createCareQuote, decideCareBeneficiary, requestCareQuotes } from "./care-actions";
import { peutSaisirLesDevis } from "@/lib/care-devis-acces";
import { peutLirePieceDePriseEnCharge } from "@/lib/ad-pro/passeport-acces";
import { canAccessEntity } from "@/lib/entity-access";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « DEVIS À OBTENIR — PRISE EN CHARGE » NE MÈNE PLUS À UNE PORTE FERMÉE (audit Assistante de direction, 10/2026).
 *
 * Le défaut : la notification envoyée à l'assistante ouvrait la fiche du congrès — un module qu'elle n'a pas — et
 * `createCareQuote` exigeait le droit d'écrire dans ce module : les devis repartaient par e-mail. Par les VRAIES
 * actions, avec des acteurs SANS vue globale (§118.104) : la Direction Marketing qui porte la demande, une assistante
 * de direction (rôle principal), une seconde par son rôle SECONDAIRE, et une personne étrangère au circuit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__devispec__${Date.now()}`;
const DEBUT = new Date(Date.now() - 60_000);

async function actorFor(id: string, role: UserRole, secondaryRole: UserRole | null = null): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, secondaryRole, access, mustChangePassword: false };
}
const fdOf = (o: Record<string, string>, cellIds: string[] = [], file?: File) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  for (const c of cellIds) fd.append("cellIds", c);
  if (file) fd.set("file", file);
  return fd;
};
const pdf = () => new File([new TextEncoder().encode("%PDF-1.4\n%devis\n")], "devis.pdf", { type: "application/pdf" });

suite("Prise en charge — les devis demandés à l'assistante de direction se saisissent là où on l'envoie", () => {
  let pmId = "", daId = "", da2Id = "", horsId = "", natId = "", autreId = "";
  let PM: CurrentUser, DA: CurrentUser, DA2: CurrentUser, HORS: CurrentUser;
  let cellIds: string[] = [];

  beforeAll(async () => {
    const mk = (n: string, role: UserRole, secondaryRole: UserRole | null = null) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, secondaryRole, passwordHash: "x" } });
    const [pm, da, da2, hors] = await Promise.all([
      mk("dm", "PRODUCT_MANAGER"), mk("da", "DIRECTION_ASSISTANT"), mk("da2", "COORDINATOR", "DIRECTION_ASSISTANT"), mk("hors", "COORDINATOR"),
    ]);
    pmId = pm.id; daId = da.id; da2Id = da2.id; horsId = hors.id;
    PM = await actorFor(pmId, "PRODUCT_MANAGER");
    DA = await actorFor(daId, "DIRECTION_ASSISTANT");
    DA2 = await actorFor(da2Id, "COORDINATOR", "DIRECTION_ASSISTANT");
    HORS = await actorFor(horsId, "COORDINATOR");

    ACTOR = PM;
    const nat = await createCongressRequest(undefined, fdOf({ type: "NATIONAL", name: `${TAG}Nat`, date: "2026-11-10", endDate: "2026-11-11" }));
    const autre = await createCongressRequest(undefined, fdOf({ type: "NATIONAL", name: `${TAG}Autre`, date: "2026-11-12", endDate: "2026-11-13" }));
    expect(nat.ok && autre.ok).toBe(true);
    natId = nat.ok ? nat.id! : ""; autreId = autre.ok ? autre.id! : "";
    const pers = await addCareBeneficiary(undefined, fdOf({ scope: "NATIONAL", requestId: natId, lastName: `${TAG}Orateur` }));
    expect(pers.ok, pers.ok ? "" : pers.error).toBe(true);
    const dec = await decideCareBeneficiary(undefined, fdOf({ id: pers.id!, decision: "APPROVED" }));
    expect(dec.ok, dec.ok ? "" : dec.error).toBe(true);
    // La Direction a validé l'événement : c'est la condition de la demande de devis.
    await prisma.congressNational.updateMany({ where: { id: { in: [natId, autreId] } }, data: { requestStatus: "APPROVED" } });
    cellIds = (await prisma.careCell.findMany({ where: { beneficiary: { congressNationalId: natId }, kind: "SERVICE", status: "REQUESTED" }, select: { id: true } })).map((c) => c.id);
    expect(cellIds.length).toBeGreaterThan(0);
  }, 60_000);

  afterAll(async () => {
    const ids = [natId, autreId].filter(Boolean);
    const docs = await prisma.document.findMany({ where: { entityId: { in: ids } }, select: { fileKey: true } }).catch(() => []);
    for (const d of docs) if (d.fileKey) await deleteFileByKey(d.fileKey).catch(() => {});
    await prisma.document.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    const sujets = (await prisma.congressNational.findMany({ where: { id: { in: ids } }, select: { careReservationDossierId: true } }).catch(() => []))
      .map((s) => s.careReservationDossierId).filter((v): v is string => Boolean(v));
    await prisma.careQuote.deleteMany({ where: { congressNationalId: { in: ids } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.dossier.deleteMany({ where: { id: { in: sujets } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { createdAt: { gte: DEBUT }, OR: [{ user: { email: { startsWith: TAG } } }, { body: { contains: TAG } }, { title: { contains: TAG } }] } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [pmId, daId, da2Id, horsId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    ACTOR = null;
  });

  it("PRÉMISSES : aucune assistante n'a la vue globale ni le droit d'écrire dans le module des congrès nationaux", () => {
    for (const a of [DA, DA2, HORS]) {
      expect(hasGlobalView(a)).toBe(false);
      expect(userCan(a, "CONGRESS_NATIONAL", "UPDATE") || userCan(a, "CONGRESS_NATIONAL", "CREATE"), a.name).toBe(false);
    }
  });

  it("AVANT toute demande de devis, l'assistante ne saisit rien : la porte étroite s'ouvre sur sollicitation", async () => {
    expect(await peutSaisirLesDevis(DA, "NATIONAL", natId)).toBe(false);
    ACTOR = DA;
    const r = await createCareQuote(undefined, fdOf({ scope: "NATIONAL", requestId: natId, supplier: `${TAG}Agence`, amount: "120000" }, cellIds));
    expect(r.ok === false && r.error).toBe("Non autorisé.");
  });

  it("DEMANDER LES DEVIS : le sujet de l'assistante s'ouvre, et la notification mène à la page « Devis » — plus à la fiche du congrès", async () => {
    ACTOR = PM;
    const r = await requestCareQuotes(undefined, fdOf({ scope: "NATIONAL", requestId: natId }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const demande = await prisma.congressNational.findUniqueOrThrow({ where: { id: natId }, select: { careReservationDossierId: true } });
    expect(demande.careReservationDossierId, "le sujet de l'assistante désigne qui est sollicitée").toBeTruthy();
    const avis = await prisma.notification.findMany({ where: { userId: { in: [daId, da2Id] }, title: "Devis à obtenir — prise en charge" }, select: { userId: true, link: true } });
    // Le rôle SECONDAIRE est notifié comme le principal — et les deux arrivent sur la même page.
    expect(avis.map((a) => a.link).sort()).toEqual([`/congress-national/${natId}/devis`, `/congress-national/${natId}/devis`]);
    expect(new Set(avis.map((a) => a.userId))).toEqual(new Set([daId, da2Id]));
  });

  it("la page « Devis » s'ouvre à l'assistante (rôle principal OU secondaire), pas à une personne étrangère ; la fiche reste fermée", async () => {
    expect(await peutSaisirLesDevis(DA, "NATIONAL", natId)).toBe(true);
    expect(await peutSaisirLesDevis(DA2, "NATIONAL", natId)).toBe(true);
    expect(await peutSaisirLesDevis(HORS, "NATIONAL", natId)).toBe(false);
    // Sur une AUTRE demande, pour laquelle personne ne lui a demandé de devis : fermé.
    expect(await peutSaisirLesDevis(DA, "NATIONAL", autreId)).toBe(false);
    // La porte est étroite : la fiche du congrès (et ses pièces) ne s'ouvre pas pour autant.
    expect(await canAccessEntity(DA, "CONGRESS_NATIONAL", natId, "VIEW")).toBe(false);
  });

  it("l'assistante SAISIT le devis reçu, avec son PDF ; la personne étrangère est refusée", async () => {
    ACTOR = HORS;
    const refus = await createCareQuote(undefined, fdOf({ scope: "NATIONAL", requestId: natId, supplier: `${TAG}Intrus`, amount: "1000" }, cellIds));
    expect(refus.ok === false && refus.error).toBe("Non autorisé.");

    ACTOR = DA2;
    const r = await createCareQuote(undefined, fdOf({ scope: "NATIONAL", requestId: natId, supplier: `${TAG}Agence`, amount: "120000" }, cellIds, pdf()));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const devis = await prisma.careQuote.findUniqueOrThrow({ where: { id: r.id! }, select: { supplier: true, amountDzd: true, createdById: true, documentId: true } });
    expect([devis.supplier, Number(devis.amountDzd), devis.createdById]).toEqual([`${TAG}Agence`, 120000, da2Id]);
    expect(devis.documentId).toBeTruthy();
    // Les postes couverts passent à « reçu ».
    expect(await prisma.careCell.count({ where: { id: { in: cellIds }, status: "PROVIDED" } })).toBe(cellIds.length);

    // Le PDF du devis se relit par l'assistante sollicitée — et par elle seule hors de la fiche.
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: devis.documentId! }, select: { id: true, entityType: true, entityId: true, stepKey: true } });
    expect(await peutLirePieceDePriseEnCharge(DA, doc)).toBe(true);
    expect(await peutLirePieceDePriseEnCharge(DA2, doc)).toBe(true);
    expect(await peutLirePieceDePriseEnCharge(HORS, doc)).toBe(false);
  });

  it("la Direction Marketing garde sa porte d'avant : elle saisit sur SA demande", async () => {
    ACTOR = PM;
    const r = await createCareQuote(undefined, fdOf({ scope: "NATIONAL", requestId: natId, supplier: `${TAG}Hôtel`, amount: "50000" }, cellIds.slice(0, 1)));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
  });
});
