import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { createDossierRecord } from "@/lib/dossiers-core";
import { demanderReservationPriseEnCharge } from "@/modules/ad-pro/actions-prise-en-charge-logistique";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RÉSERVATION PAR FICHE, SEULE (Direction, 27/10).
 *
 * L'ancien envoi en bloc n'écrit plus rien ; ses envois déjà faits sont repris en fiches par la migration
 * `20270131120000_reservation_par_fiche_seule` — là où la base PROUVE l'envoi, et seulement là. On joue ici la
 * migration elle-même, deux fois (elle est idempotente), sur des données posées comme l'ancien mécanisme les
 * laissait.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__repriseenbloc__${Date.now()}`;
const MIGRATION = join(process.cwd(), "prisma", "migrations", "20270131120000_reservation_par_fiche_seule", "migration.sql");

/** Les INSERT de la migration, un par un (le client ne passe qu'une commande à la fois). */
function instructions(): string[] {
  const sql = readFileSync(MIGRATION, "utf8").split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  return sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
}
async function jouerMigration() {
  for (const q of instructions()) await prisma.$executeRawUnsafe(q);
}

suite("Réservation par fiche seule — l'envoi en bloc fermé, ses données reprises", () => {
  let dmId = "", natId = "", itemBloc = "", itemFiche = "", sujetCare = "", sujetBloc = "", sujetFiche = "";
  let vAvant = "", vApres = "", vFiche = "", billet = "", hotel = "", sansObjet = "", tardive = "";
  let DM: CurrentUser;
  const plusTard = new Date(Date.now() + 3600_000);

  beforeAll(async () => {
    const dm = await prisma.user.create({ data: { name: `${TAG}dm`, email: `${TAG}dm@t.dz`, role: "PRODUCT_MANAGER", passwordHash: "x" } });
    dmId = dm.id;
    DM = { id: dmId, name: dm.name, email: dm.email, role: "PRODUCT_MANAGER", secondaryRole: null, access: await getAccess(dmId, "PRODUCT_MANAGER"), mustChangePassword: false };
    const nat = await prisma.congressNational.create({ data: { name: `${TAG}Congrès`, requesterId: dmId, createdById: dmId, requestStatus: "APPROVED" } });
    natId = nat.id;

    // ── Prise en charge : un envoi en bloc, tel que l'ancien geste le laissait (sujet + trace d'audit) ──
    const b = await prisma.careBeneficiary.create({ data: { congressNationalId: natId, lastName: `${TAG}Orateur`, status: "APPROVED" } });
    const cell = (serviceKind: "TICKET" | "HOTEL", label: string, extra: Record<string, unknown> = {}) =>
      prisma.careCell.create({ data: { beneficiaryId: b.id, kind: "SERVICE", serviceKind, label, ...extra } });
    billet = (await cell("TICKET", "Billetterie")).id;
    hotel = (await cell("HOTEL", "Hôtellerie")).id;
    sansObjet = (await cell("HOTEL", "Hôtel 2", { status: "WAIVED" })).id;
    sujetCare = (await createDossierRecord({
      title: `Prise en charge — ${TAG}`, description: "Demande de réservation.", category: "Billets", priority: "HIGH",
      assignedToId: null, participantIds: [], sourceType: "CONGRESS_NATIONAL", sourceId: natId, companyId: null,
    }, dmId)).id;
    await prisma.congressNational.update({ where: { id: natId }, data: { careReservationDossierId: sujetCare } });
    await prisma.auditLog.create({
      data: { actorId: dmId, action: "UPDATE", module: "CONGRESS_NATIONAL", entityType: "CONGRESS_NATIONAL", entityId: natId, summary: "Réservation demandée pour 2 fiche(s) — sujet DOS-X." },
    });
    // Une fiche née APRÈS l'envoi : l'envoi ne pouvait pas la porter.
    tardive = (await cell("TICKET", "Billetterie 2", { createdAt: plusTard })).id;

    // ── Ad & Pro : un poste envoyé en bloc (titre propre à l'ancien geste), et un poste au fil des fiches ──
    itemBloc = (await prisma.adProItem.create({ data: { label: `${TAG}Billets`, congressNationalId: natId, createdById: dmId } })).id;
    sujetBloc = (await createDossierRecord({
      title: `Réservation billets — ${TAG} · Billets`, description: "Voyageurs…", category: "Billets", priority: "HIGH",
      assignedToId: null, participantIds: [], sourceType: "CONGRESS_NATIONAL", sourceId: natId, companyId: null,
    }, dmId)).id;
    await prisma.adProItem.update({ where: { id: itemBloc }, data: { reservationDossierId: sujetBloc } });
    vAvant = (await prisma.adProVoyageur.create({ data: { itemId: itemBloc, nom: `${TAG}Avant`, createdAt: new Date(Date.now() - 60_000) } })).id;
    vApres = (await prisma.adProVoyageur.create({ data: { itemId: itemBloc, nom: `${TAG}Après`, createdAt: plusTard } })).id;

    itemFiche = (await prisma.adProItem.create({ data: { label: `${TAG}Fiches`, congressNationalId: natId, createdById: dmId } })).id;
    sujetFiche = (await createDossierRecord({
      title: `Réservation — ${TAG} · Fiches`, description: "Fil des fiches.", category: "Billets", priority: "HIGH",
      assignedToId: null, participantIds: [], sourceType: "CONGRESS_NATIONAL", sourceId: natId, companyId: null,
    }, dmId)).id;
    await prisma.adProItem.update({ where: { id: itemFiche }, data: { reservationDossierId: sujetFiche } });
    vFiche = (await prisma.adProVoyageur.create({ data: { itemId: itemFiche, nom: `${TAG}Jamais envoyé`, createdAt: new Date(Date.now() - 60_000) } })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.demandeReservation.deleteMany({ where: { operationId: natId } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { congressNationalId: natId } }).catch(() => {});
    await prisma.careBeneficiary.deleteMany({ where: { congressNationalId: natId } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: natId } }).catch(() => {});
    await prisma.dossierMessage.deleteMany({ where: { dossierId: { in: [sujetCare, sujetBloc, sujetFiche] } } }).catch(() => {});
    await prisma.dossier.deleteMany({ where: { id: { in: [sujetCare, sujetBloc, sujetFiche] } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: dmId }, { entityId: natId }] } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    ACTOR = null;
  });

  it("l'envoi en bloc d'une prise en charge REFUSE et renvoie à la fiche — rien n'est écrit dans le sujet", async () => {
    ACTOR = DM;
    const avant = await prisma.dossierMessage.count({ where: { dossierId: sujetCare } });
    const r = await demanderReservationPriseEnCharge(undefined, (() => { const f = new FormData(); f.set("scope", "NATIONAL"); f.set("requestId", natId); return f; })());
    expect(r.ok === false ? r.error : "envoyé").toMatch(/fiche par fiche/);
    expect(await prisma.dossierMessage.count({ where: { dossierId: sujetCare } })).toBe(avant);
    expect(await prisma.demandeReservation.count({ where: { operationId: natId } })).toBe(0);
  });

  it("la migration reprend en fiches ce que la base PROUVE — et seulement cela ; rejouée, elle ne double rien", async () => {
    await jouerMigration();
    const lues = await prisma.demandeReservation.findMany({
      where: { operationId: natId },
      select: { voyageurId: true, careCellId: true, nature: true, etat: true, dossierId: true, demandeurId: true, empreinte: true },
    });
    const de = (id: string) => lues.find((d) => d.voyageurId === id || d.careCellId === id);

    // Prise en charge : le billet et l'hôtel envoyés, chez l'assistante ; ni le « sans objet » ni la fiche tardive.
    expect(de(billet)).toMatchObject({ nature: "BILLET", etat: "ENVOYEE", dossierId: sujetCare, demandeurId: dmId, empreinte: null });
    expect(de(hotel)).toMatchObject({ nature: "HOTEL", etat: "ENVOYEE", dossierId: sujetCare });
    expect(de(sansObjet)).toBeUndefined();
    expect(de(tardive)).toBeUndefined();
    // Ad & Pro : le voyageur présent à l'envoi en bloc ; ni celui ajouté après, ni celui d'un fil de fiches jamais envoyé.
    expect(de(vAvant)).toMatchObject({ nature: "BILLET", etat: "ENVOYEE", dossierId: sujetBloc, demandeurId: dmId });
    expect(de(vApres)).toBeUndefined();
    expect(de(vFiche)).toBeUndefined();

    const n = lues.length;
    await jouerMigration();
    expect(await prisma.demandeReservation.count({ where: { operationId: natId } }), "idempotente").toBe(n);
  });

  it("additive : un sujet en bloc ABOUTI se reprend « réservée » ; une demande existante n'est jamais réécrite", async () => {
    await prisma.demandeReservation.update({ where: { voyageurId: vAvant }, data: { etat: "PRISE" } });
    await prisma.dossier.update({ where: { id: sujetCare }, data: { status: "DONE" } });
    await prisma.demandeReservation.delete({ where: { careCellId: hotel } });
    await jouerMigration();
    expect((await prisma.demandeReservation.findUniqueOrThrow({ where: { voyageurId: vAvant } })).etat, "jamais réécrite").toBe("PRISE");
    expect((await prisma.demandeReservation.findUniqueOrThrow({ where: { careCellId: hotel } })).etat).toBe("RESERVEE");
    expect((await prisma.demandeReservation.findUniqueOrThrow({ where: { careCellId: billet } })).etat, "jamais réécrite").toBe("ENVOYEE");
  });
});
