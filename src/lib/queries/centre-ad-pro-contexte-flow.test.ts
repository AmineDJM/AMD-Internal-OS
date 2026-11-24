import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { decisionsRecentesCentreAdPro, demandesAuCentreAdPro } from "@/modules/ad-pro/api";
import { alertesDeLaLigne, cleLigne } from "@/modules/ad-pro/partage";
import { contexteDuCentreAdPro } from "./centre-ad-pro-contexte";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__ctradpro${Date.now().toString(36)}__`;

async function personne(id: string): Promise<SessionUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: u.secondaryRole, access } as SessionUser;
}

/**
 * LE CENTRE AD & PRO MONTRE CE QU'IL FAUT POUR DÉCIDER (maquette du 24/11/2026), lu sur la base réelle : pour le BC
 * d'un poste, la société, l'opération, la ligne budgétaire et son disponible, les devis (le retenu, l'écarté), ce qui
 * est déjà validé et le fil du poste ; et « Déjà décidés » relit un visa donné. Lecture seule : aucune action appelée.
 */
suite("Centre Ad & Pro — le contexte de chaque ligne (base réelle)", () => {
  let saId = "", pmId = "", eventId = "", envId = "", catId = "", posteA = "", posteB = "", companyId: string | null = null;
  let montant = 900_000;
  const docs: string[] = [];

  beforeAll(async () => {
    const reglage = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { bcValidationThreshold: true } });
    const seuilBC = reglage ? toNumber(reglage.bcValidationThreshold) : 0;
    // Au-dessus du seuil des BC en vigueur, quel qu'il soit : sinon la ligne n'atteindrait pas le centre.
    if (seuilBC > 0) montant = Math.ceil(seuilBC * 3);
    companyId = (await prisma.company.findFirst({ select: { id: true } }))?.id ?? null;
    const mk = async (n: string, role: SessionUser["role"]) =>
      (await prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } })).id;
    saId = await mk("sa", "SUPER_ADMIN");
    pmId = await mk("pm", "PRODUCT_MANAGER");
    eventId = (await prisma.event.create({ data: { name: `${TAG}Journées`, requesterId: pmId, requestStatus: "APPROVED", companyId } })).id;
    envId = (await prisma.budgetEnvelope.create({
      data: { name: `${TAG}Marketing`, periodStart: new Date("2026-01-01T00:00:00Z"), periodEnd: new Date("2026-12-31T23:59:59Z"), totalAmount: montant * 4, companyId },
    })).id;
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Événements`, allocated: montant * 2 } })).id;
    posteA = (await prisma.adProItem.create({
      data: {
        label: `${TAG}Restauration`, eventId, kind: "CATERING", status: "APPROVED", amountGranted: montant, supplier: "Traiteur Zitouna", voie: "AGENCE",
        budgetCategoryId: catId, decidedAt: new Date(), orderStage: "REQUESTED", orderRequestedAt: new Date(), orderRequestedById: pmId, orderNote: "Conforme au devis retenu.",
      },
    })).id;
    posteB = (await prisma.adProItem.create({
      data: { label: `${TAG}Stand`, eventId, kind: "OTHER", status: "APPROVED", amountGranted: 100, orderStage: "DIRECTION_OK", orderDirectionAt: new Date(), orderDirectionById: saId },
    })).id;
    // Deux devis : le retenu, et un moins cher ÉCARTÉ — la fiche doit le signaler.
    const retenu = (await prisma.legalDocument.create({ data: { title: "Traiteur Zitouna", kind: "QUOTE", amount: montant } })).id;
    const ecarte = (await prisma.legalDocument.create({ data: { title: "Traiteur Atlas", kind: "QUOTE", amount: montant - 50_000 } })).id;
    docs.push(retenu, ecarte);
    await prisma.adProItemPiece.create({ data: { itemId: posteA, legalDocumentId: retenu, nature: "DEVIS" } });
    await prisma.adProItemPiece.create({ data: { itemId: posteA, legalDocumentId: ecarte, nature: "DEVIS", nonRetenuAt: new Date(), nonRetenuParId: pmId } });
    await prisma.comment.create({ data: { entityType: "AD_PRO_ITEM", entityId: posteA, body: `${TAG} le stand inclut l'écran`, authorId: pmId } });
  }, 60_000);

  afterAll(async () => {
    await prisma.comment.deleteMany({ where: { entityId: { in: [posteA, posteB] } } }).catch(() => {});
    await prisma.adProItemPiece.deleteMany({ where: { itemId: { in: [posteA, posteB] } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: [posteA, posteB] } } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { envelopeId: envId } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: eventId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [saId, pmId] } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("le BC d'un poste porte sa société, son opération, son budget, ses devis, sa chaîne et son fil", async () => {
    const lignes = await demandesAuCentreAdPro();
    const ligne = lignes.find((l) => l.entityId === posteA);
    expect(ligne?.forme, "PRÉMISSE : la demande de BC du poste attend le centre").toBe("BC_POSTE");
    const charge = await contexteDuCentreAdPro(lignes, await personne(saId));
    expect(charge.lignes.some((l) => l.entityId === posteA), "le Super Admin voit tout le groupe").toBe(true);
    const c = charge.contextes[cleLigne(ligne!)];
    expect(c.societeId).toBe(companyId);
    if (companyId) expect(charge.societes.some((s) => s.id === companyId)).toBe(true);
    expect(c.operation).toBe(`${TAG}Journées`);
    expect(c.poste).toBe(`${TAG}Restauration`);
    expect(c.accorde).toBe(montant);
    expect(c.budget?.ligne).toBe(`${TAG}Marketing › ${TAG}Événements`);
    // Le disponible de l'écran Budgets : jamais plus que l'alloué.
    expect(c.budget!.disponible).toBeLessThanOrEqual(montant * 2);
    expect(c.devis.map((d) => [d.prestataire, d.retenu])).toEqual([["Traiteur Zitouna", true], ["Traiteur Atlas", false]]);
    expect(c.pieces.filter((p) => p.nature === "DEVIS")).toHaveLength(2);
    expect(c.chaine.map((e) => e.etape)).toEqual([`Poste accordé — ${TAG}Restauration`, "Demande de BC"]);
    expect(c.fil.map((m) => m.texte)).toEqual([`${TAG} le stand inclut l'écran`]);
    expect(c.filCible).toEqual({ entityType: "AD_PRO_ITEM", entityId: posteA });
    expect(alertesDeLaLigne(ligne!, c).map((a) => a.titre)).toContain("Devis le moins cher écarté");
  });

  it("le total d'une demande porte ses postes (devis retenu, voie) et la ligne budgétaire qui porte le plus d'argent", async () => {
    const total = {
      kind: "EVENT" as const, entityType: "EVENT", entityId: eventId, reference: null, intitule: `${TAG}Journées`, demandeur: `${TAG}pm`,
      montant: montant + 100, seuil: null, forme: "TOTAL_DG" as const, depuis: new Date().toISOString(), href: `/events/${eventId}`,
    };
    const charge = await contexteDuCentreAdPro([total], await personne(saId));
    const c = charge.contextes[cleLigne(total)];
    expect(c.postes.map((p) => [p.libelle, p.voie, p.devis, p.montant])).toEqual([
      [`${TAG}Restauration`, "AGENCE", "Traiteur Zitouna · 1 écarté", montant],
      [`${TAG}Stand`, null, null, 100],
    ]);
    expect(c.budget?.ligne).toBe(`${TAG}Marketing › ${TAG}Événements`);
    expect(c.filCible).toEqual({ entityType: "EVENT", entityId: eventId });
    expect(c.operation, "une demande n'a pas d'« opération » : elle EST l'opération").toBeNull();
  });

  it("« Déjà décidés » relit le visa d'un BC de poste, avec son opération et son décideur", async () => {
    const d = (await decisionsRecentesCentreAdPro()).find((x) => x.entityId === posteB);
    expect(d).toMatchObject({ etat: "VISE", decideur: `${TAG}sa`, montant: 100, reexaminable: false });
    expect(d?.objet).toBe(`BC — ${TAG}Stand — ${TAG}Journées`);
  });
});
