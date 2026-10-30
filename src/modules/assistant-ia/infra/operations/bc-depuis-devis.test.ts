import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";
import type { DevisLu } from "./devis-lu";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));
// LA LECTURE DU DEVIS est celle de l'ERP (testée avec elle) : ici, on fixe ce qu'elle a lu.
let LU: DevisLu | null = null;
vi.mock("./devis-lu", () => ({ lireDevis: async () => LU ?? { erreur: "non lu" } }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { BC_DEPUIS_DEVIS } from "./bc-depuis-devis";
import { executerOperationIA } from "./";

/**
 * L'ASSISTANT IA — UN BON DE COMMANDE COMPOSÉ DEPUIS UN DEVIS : les lignes viennent de la lecture,
 * une TVA non imprimée se demande, une ligne illisible se complète, puis le BC est composé en
 * pré-validation et sa demande de validation ouverte, le devis joint.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iabcd_${Date.now().toString(36)}_`;
let admin: CurrentUser;
let valideur: CurrentUser;
let societeId = "";
let devisId = "";

async function compte(nom: string, role: CurrentUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  return { id: u.id, name: u.name, email: u.email, role: u.role, access: await getAccess(u.id, u.role), mustChangePassword: false } as CurrentUser;
}

const lu = (o: Partial<DevisLu> = {}): DevisLu => ({
  piece: { id: devisId, nom: `${TAG}devis-imprimerie.pdf` }, empreinte: "e1", nature: "DEVIS", numero: "D-26/114", date: "2026-10-20",
  fournisseur: { id: null, nom: `${TAG}Imprimerie du Centre`, reconnu: "Aucune fiche", candidats: [] },
  lignes: [
    { rang: 1, designation: "Kakémono 85×200", unite: "u", quantite: 4, prixUnitaire: 12_000, aVerifier: [] },
    { rang: 2, designation: "Flyers A5 quadri", unite: "u", quantite: 2000, prixUnitaire: 15, aVerifier: [] },
  ],
  tvaPct: 19, taxe: null, totalHtImprime: 78_000, totalHtLignes: 78_000, doutes: [], reserves: [], note: "texte du fichier", sansLignes: null,
  emetteur: { nom: `${TAG}Imprimerie du Centre`, adresse: "Rue X, Blida", nif: null, rc: null, rib: null, telephone: null, email: null },
  ...o,
});

suite("Assistant IA — bon de commande depuis un devis", () => {
  beforeAll(async () => {
    admin = await compte("admin", "SUPER_ADMIN");
    valideur = await compte("valideur", "SUPER_ADMIN");
    societeId = (await prisma.company.create({ data: { name: `${TAG}Pharmagène`, shortName: `${TAG}PHG` } })).id;
    const { blobId, size } = await putBlob(Buffer.from(`%PDF-1.4 ${TAG} devis`));
    devisId = (await enregistrerFichierDrive(admin, { nodeId: null, parentId: null, spaceId: null, category: null, viewers: [], editors: [] }, { blobId, size, mimeType: "application/pdf", name: `${TAG}devis-imprimerie.pdf` })).id;
  });

  afterAll(async () => {
    const docs = await prisma.legalDocument.findMany({ where: { companyId: societeId }, select: { id: true } });
    const vr = await prisma.validationRequest.findMany({ where: { requesterId: admin?.id }, select: { id: true } });
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vr.map((v) => v.id) } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { entityId: { in: [...vr.map((v) => v.id), ...docs.map((d) => d.id)] } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vr.map((v) => v.id) } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { name: { contains: TAG } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { OR: [{ name: { contains: TAG } }, { ownerId: { in: [admin?.id ?? "", valideur?.id ?? ""] } }] } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: societeId } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: admin?.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("une TVA que le devis n'imprime pas n'est jamais supposée : elle se demande", async () => {
    LU = lu({ tvaPct: null });
    const p = await BC_DEPUIS_DEVIS.proposer({ fichier: devisId, validateur: valideur.name, societe: `${TAG}PHG` }, admin);
    expect("manque" in p && p.manque[0]).toMatch(/taux de TVA/);
  });

  it("une ligne illisible se complète par la personne ; une ligne écartée ne se commande pas", async () => {
    LU = lu({ lignes: [...lu().lignes, { rang: 3, designation: "Roll-up", unite: "u", quantite: 2, prixUnitaire: null, aVerifier: ["prix illisible"] }] });
    const incomplet = await BC_DEPUIS_DEVIS.proposer({ fichier: devisId, validateur: valideur.name, societe: `${TAG}PHG` }, admin);
    expect("manque" in incomplet && incomplet.manque[0]).toMatch(/prix unitaire HT de la ligne 3/);
    const p = await BC_DEPUIS_DEVIS.proposer({ fichier: devisId, validateur: valideur.name, societe: `${TAG}PHG`, ecarter: [2], corrections: [{ rang: 3, prixUnitaire: 9_000 }] }, admin);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    const lignes = p.carte.fields.find((f) => f.label === "Lignes")!.value;
    expect(lignes).not.toMatch(/Flyers/);
    expect(lignes).toMatch(/2 × Roll-up/);
    expect(p.carte.fields.find((f) => f.label === "Total HT")?.value).toMatch(/66\s000 DZD/);
  });

  it("confirmé : le BC est composé en pré-validation et sa demande de validation ouverte, le devis joint", async () => {
    LU = lu();
    const p = await BC_DEPUIS_DEVIS.proposer({ fichier: devisId, validateur: valideur.name, societe: `${TAG}PHG` }, admin);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    expect(p.carte.libelleBouton).toBe("Créer la demande de validation");
    expect(p.carte.warnings.join(" ")).toMatch(/SIGNATURE DES FINANCES/);
    expect(p.carte.warnings.join(" ")).toMatch(/pas dans votre annuaire/);
    ACTOR = admin;
    const r = await executerOperationIA(admin, { kind: "assistant_ia_op", op: BC_DEPUIS_DEVIS.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
    const bc = await prisma.legalDocument.findFirstOrThrow({ where: { companyId: societeId, kind: "PURCHASE_ORDER" } });
    expect(bc.bcPrevalidationRequestId).not.toBeNull();
    const vr = await prisma.validationRequest.findFirstOrThrow({ where: { id: bc.bcPrevalidationRequestId! } });
    expect(vr.requesterId).toBe(admin.id);
    expect(await prisma.document.count({ where: { entityId: vr.id } })).toBe(1);
  });

  it("le devis a changé entre la carte et la confirmation : rien n'est émis", async () => {
    LU = lu();
    const p = await BC_DEPUIS_DEVIS.proposer({ fichier: devisId, validateur: valideur.name, societe: `${TAG}PHG` }, admin);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    LU = lu({ empreinte: "e2" });
    const r = await executerOperationIA(admin, { kind: "assistant_ia_op", op: BC_DEPUIS_DEVIS.nom, args: p.args });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/a changé/);
  });
});
