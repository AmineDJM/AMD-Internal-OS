import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { papierEnTeteDeDemonstration } from "@/lib/artifact/factory/word";
import { putBlob, releaseBlob } from "@/lib/drive-storage";
import { definirModeleDePiece, televerserModele, televerserModeleDePiece } from "@/lib/actions/direction-artistique-actions";
import { deleteLetterhead } from "@/lib/actions/letterhead-actions";
import { profilDocumentaire } from "@/platform/in-process/artifact/factory";
import { lireModelesParType } from "./modeles";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__dirart__${Date.now()}`;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const form = (fields: Record<string, string | File>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const docx = (nom: string, societe: string) => new File([new Uint8Array(papierEnTeteDeDemonstration(societe))], nom, { type: DOCX });

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DIRECTION ARTISTIQUE, PAR LES VRAIS POINTS D'ENTRÉE — l'assistante de direction dépose le
 * modèle de bon de commande de l'entité A, et la fabrique, quand elle habille un BC de A, le
 * prend. Jamais le papier d'une autre entité ; jamais un dépôt hors périmètre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Direction artistique — le modèle de BC déposé est celui que la fabrique applique", () => {
  let assistanteId = "", commercialId = "", delegueId = "", aId = "", bId = "", papierBId = "";

  beforeAll(async () => {
    aId = (await prisma.company.create({ data: { name: `${TAG} A`, shortName: `${TAG}A`.slice(-12) } })).id;
    bId = (await prisma.company.create({ data: { name: `${TAG} B`, shortName: `${TAG}B`.slice(-12) } })).id;
    const mk = (n: string, role: SessionUser["role"]) => prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    assistanteId = (await mk("assistante", "DIRECTION_ASSISTANT")).id;
    commercialId = (await mk("commercial", "SALES_USER")).id;
    delegueId = (await mk("delegue", "SALES_USER")).id;
    // L'assistante et les deux comptes de contrôle voient A, et seulement A.
    for (const userId of [assistanteId, commercialId, delegueId]) await prisma.userCompanyAccess.create({ data: { userId, companyId: aId, canEdit: true } });
    // Le Super Admin ouvre le module à UNE personne, dans la console.
    await prisma.userAccess.create({ data: { userId: delegueId, module: "ART_DIRECTION", canView: true, canCreate: true, canUpdate: true, canDelete: true, canUpload: true, scope: "ALL" } });
    // Le papier de B, déposé par ailleurs : il ne doit jamais habiller une pièce de A.
    const { blobId, size } = await putBlob(papierEnTeteDeDemonstration(`${TAG} B`));
    papierBId = (await prisma.officeLetterhead.create({ data: { name: `${TAG} papier B`, kind: "word", companyId: bId, blobId, size, mime: DOCX, uploadedById: assistanteId } })).id;
  }, 60_000);

  afterAll(async () => {
    const papiers = await prisma.officeLetterhead.findMany({ where: { companyId: { in: [aId, bId] } }, select: { blobId: true } });
    await prisma.officeLetterhead.deleteMany({ where: { companyId: { in: [aId, bId] } } }).catch(() => {});
    for (const p of papiers) await releaseBlob(p.blobId).catch(() => {});
    await prisma.companyDocumentProfile.deleteMany({ where: { companyId: { in: [aId, bId] } } }).catch(() => {});
    const comptes = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes.map((c) => c.id) } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: [aId, bId] } } }).catch(() => {});
  }, 60_000);

  it("l'assistante dépose le modèle de BC de A ; un BC de A le porte, un devis de A garde le papier par défaut", async () => {
    ACTOR = await actorFor(assistanteId, "DIRECTION_ASSISTANT");
    const general = await televerserModele(undefined, form({ companyId: aId, kind: "word", name: "Papier général A", parDefaut: "on", file: docx("general.docx", `${TAG} A`) }));
    expect(general.ok, general.error).toBe(true);
    const bc = await televerserModeleDePiece(undefined, form({ companyId: aId, type: "BON_DE_COMMANDE", file: docx("bc.docx", `${TAG} A`) }));
    expect(bc.ok, bc.error).toBe(true);

    const lh = await prisma.officeLetterhead.findUniqueOrThrow({ where: { id: bc.id! } });
    expect(lh).toMatchObject({ companyId: aId, kind: "word", isActive: true });
    const profil = await prisma.companyDocumentProfile.findUniqueOrThrow({ where: { companyId: aId } });
    expect(profil.letterheadId).toBe(general.id);
    expect(lireModelesParType(profil.settings).BON_DE_COMMANDE).toBe(bc.id);

    const pBC = await profilDocumentaire(ACTOR, aId, { type: "BON_DE_COMMANDE" });
    expect(pBC.ok).toBe(true);
    if (pBC.ok) { expect(pBC.profil.papierEnTete?.id).toBe(bc.id); expect(pBC.papierOctets?.length).toBeGreaterThan(0); }

    const pDevis = await profilDocumentaire(ACTOR, aId, { type: "DEVIS" });
    if (pDevis.ok) expect(pDevis.profil.papierEnTete?.id).toBe(general.id);
    else throw new Error(pDevis.motif);

    // Un papier choisi à la main sur la pièce passe toujours avant.
    const pChoisi = await profilDocumentaire(ACTOR, aId, { type: "BON_DE_COMMANDE", papierEnTeteId: general.id });
    if (pChoisi.ok) expect(pChoisi.profil.papierEnTete?.id).toBe(general.id);
    else throw new Error(pChoisi.motif);
  }, 60_000);

  it("jamais l'entité d'un autre : dépôt hors périmètre refusé, papier de B refusé comme modèle de A, et ignoré s'il y est écrit", async () => {
    ACTOR = await actorFor(assistanteId, "DIRECTION_ASSISTANT");
    const horsPerimetre = await televerserModeleDePiece(undefined, form({ companyId: bId, type: "BON_DE_COMMANDE", file: docx("bc-b.docx", `${TAG} B`) }));
    expect(horsPerimetre.ok).toBe(false);
    expect(horsPerimetre.error).toMatch(/périmètre/);

    const designerB = await definirModeleDePiece(form({ companyId: aId, type: "BON_DE_COMMANDE", letterheadId: papierBId }));
    expect(designerB.ok).toBe(false);
    expect(designerB.error).toMatch(/autre entité/);

    // Même écrit à la main dans le profil, le papier de B n'habille pas un BC de A.
    const profil = await prisma.companyDocumentProfile.findUniqueOrThrow({ where: { companyId: aId } });
    const settings = { ...(profil.settings as Record<string, unknown>), modelesParType: { BON_DE_COMMANDE: papierBId } };
    await prisma.companyDocumentProfile.update({ where: { companyId: aId }, data: { settings } });
    const p = await profilDocumentaire(ACTOR, aId, { type: "BON_DE_COMMANDE" });
    if (!p.ok) throw new Error(p.motif);
    expect(p.profil.papierEnTete?.id).not.toBe(papierBId);
    expect(p.profil.papierEnTete?.id).toBe(profil.letterheadId);

    // Et la suppression d'un papier hors périmètre est « introuvable ».
    const suppr = await deleteLetterhead(form({ id: papierBId }));
    expect(suppr.ok).toBe(false);
    expect(await prisma.officeLetterhead.findUnique({ where: { id: papierBId } })).not.toBeNull();
  }, 60_000);

  it("le module ouvert par la console suffit pour agir ; sans lui (ni rôle de papeterie), refus", async () => {
    ACTOR = await actorFor(commercialId, "SALES_USER");
    const refus = await televerserModele(undefined, form({ companyId: aId, kind: "slide", file: new File([new Uint8Array([1, 2, 3])], "x.pptx") }));
    expect(refus.ok).toBe(false);
    const refusChoix = await definirModeleDePiece(form({ companyId: aId, type: "DEVIS", letterheadId: "" }));
    expect(refusChoix.ok).toBe(false);

    ACTOR = await actorFor(delegueId, "SALES_USER");
    const ok = await televerserModeleDePiece(undefined, form({ companyId: aId, type: "DEVIS", file: docx("devis.docx", `${TAG} A`) }));
    expect(ok.ok, ok.error).toBe(true);
    const p = await profilDocumentaire(ACTOR, aId, { type: "DEVIS" });
    if (!p.ok) throw new Error(p.motif);
    expect(p.profil.papierEnTete?.id).toBe(ok.id);
  }, 60_000);
});
