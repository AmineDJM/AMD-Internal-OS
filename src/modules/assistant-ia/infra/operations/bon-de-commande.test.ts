import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { BON_DE_COMMANDE } from "./bon-de-commande";
import { executerOperationIA, outilsOperations } from "./";

/**
 * L'ASSISTANT IA — UN BON DE COMMANDE ET SA DEMANDE DE VALIDATION, par l'assistante de direction
 * (celle qui émet les BC au quotidien), par l'action de l'écran Validations.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iabc_${Date.now().toString(36)}_`;
let assistante: CurrentUser;
let directeur: CurrentUser;
let bcPdf = "";

async function compte(nom: string, role: CurrentUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: u.role, access, mustChangePassword: false } as CurrentUser;
}

const complet = () => ({
  objet: `${TAG}Fournitures de bureau`, fournisseur: `${TAG}Papeterie du Centre`, montant: 450_000,
  fichier: bcPdf, validateur: `${TAG}directeur`,
});

suite("Assistant IA — bon de commande et demande de validation", () => {
  beforeAll(async () => {
    assistante = await compte("assistante", "DIRECTION_ASSISTANT");
    directeur = await compte("directeur", "DIRECTION");
    await prisma.companyContact.create({ data: { name: `${TAG}Papeterie du Centre` } });
    const { blobId, size } = await putBlob(Buffer.from(`%PDF-1.4 ${TAG} BC`));
    bcPdf = (await enregistrerFichierDrive(assistante, { nodeId: null, parentId: null, spaceId: null, category: null, viewers: [], editors: [] }, { blobId, size, mimeType: "application/pdf", name: `${TAG}bc.pdf` })).id;
  });

  afterAll(async () => {
    const docs = await prisma.legalDocument.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
    const ids = docs.map((d) => d.id);
    const vr = await prisma.validationRequest.findMany({ where: { entityId: { in: ids } }, select: { id: true } });
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vr.map((v) => v.id) } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vr.map((v) => v.id) } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { name: { startsWith: TAG } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("l'outil lui est offert : elle émet des BC à l'écran", () => {
    expect(outilsOperations(assistante, []).map((o) => o.def.name)).toContain(BON_DE_COMMANDE.nom);
  });

  it("ce qui manque est nommé ; un fournisseur absent de l'annuaire est DEMANDÉ avant de remplir", async () => {
    const vide = await BON_DE_COMMANDE.proposer({}, assistante);
    expect("manque" in vide && vide.manque[0]).toMatch(/objet/);
    const inconnu = await BON_DE_COMMANDE.proposer({ ...complet(), fournisseur: `${TAG}Fournisseur fantôme` }, assistante);
    expect("manque" in inconnu && inconnu.manque[0]).toMatch(/ne figure pas dans l'annuaire/);
  });

  it("la carte prévient des Finances, dit la société, et porte le bouton « Créer la demande de validation »", async () => {
    const p = await BON_DE_COMMANDE.proposer(complet(), assistante);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    expect(p.carte.warnings.join(" ")).toMatch(/SIGNATURE DES FINANCES/);
    expect(p.carte.warnings.join(" ")).toMatch(/Société inscrite/);
    expect(p.carte.libelleBouton).toBe("Créer la demande de validation");
  });

  it("confirmée : le BC est enregistré au registre et sa demande de validation part au validateur choisi", async () => {
    const p = await BON_DE_COMMANDE.proposer(complet(), assistante);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    ACTOR = assistante;
    const r = await executerOperationIA(assistante, { kind: "assistant_ia_op", op: BON_DE_COMMANDE.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
    const bc = await prisma.legalDocument.findFirstOrThrow({ where: { title: `${TAG}Fournitures de bureau` } });
    expect(bc.kind).toBe("PURCHASE_ORDER");
    const vr = await prisma.validationRequest.findFirst({ where: { entityId: bc.id }, include: { steps: true } });
    expect(vr?.steps.some((s) => s.validatorId === directeur.id)).toBe(true);
  });
});
