/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « REMPLACER LE ROUGE PAR L'UNE DES COULEURS DE NOTRE CHARTE — bleu canard : R 8, V 112, B 132 » (Direction, 10/2026).
 *
 * L'accent d'une pièce vient de la CHARTE (`charteDe`) : le registre de marque de la société d'abord, sinon le bleu canard de la
 * maison. La PASTILLE de la société (`Company.color`, une couleur d'écran) ne colore plus rien — elle valait l'accent avant la
 * décision, et c'est elle qui portait le rouge. Quatre propriétés, jouées sur une VRAIE base par les VRAIS points d'entrée :
 * une société à pastille rouge émet en bleu canard ; le registre de marque l'emporte sur le défaut ; une révision repeint l'accent
 * d'une pièce émise avant la décision ; une pièce NON révisée garde sa couleur d'émission (un document émis ne se repeint pas).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import PizZip from "pizzip";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { ACCENT_DEFAUT } from "@/lib/brand/model";
import { ACCENT_MAISON } from "@/lib/artifact/factory/commercial";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import { definirMarque } from "@/platform/in-process/brand";
import { emettreDocumentDrive, reviserDocumentDrive, type DemandeDocument } from "@/platform/ia/artifact/factory";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__charte__${Date.now()}`;
const ANNEE = new Date().getUTCFullYear();
const ROUGE_ANCIEN = "DC2626";
const VERT_MARQUE = "0B6E4F";
let user: CurrentUser;
let companyId = "";

const bc = (extra: Partial<DemandeDocument> = {}): DemandeDocument => ({
  type: "BON_DE_COMMANDE", societe: companyId, tiers: { nom: `${TAG} Fournisseur` }, date: `${ANNEE}-09-05`, sansPdf: true,
  lignes: [{ designation: "Impression", quantite: 1, prixUnitaire: 1_000 }], ...extra,
});
const emettre = async (extra: Partial<DemandeDocument> = {}): Promise<{ id: string; nodeId: string; reference: string }> => {
  const r = await emettreDocumentDrive(user, bc(extra));
  if (!r.ok) throw new Error(`émission refusée : ${JSON.stringify(r)}`);
  return { id: r.legalDocumentId, nodeId: r.docx.nodeId, reference: r.reference };
};
const couleurStockee = async (legalDocumentId: string): Promise<string> => {
  const d = await prisma.legalDocument.findUniqueOrThrow({ where: { id: legalDocumentId }, select: { custom: true } });
  return String((d.custom as { fabrique: { spec: { couleur?: string | null } } }).fabrique.spec.couleur ?? "").replace("#", "").toUpperCase();
};
/** Le XML du document Word d'une version du fichier émis — ce que la personne imprime. */
const xmlDuFichier = async (nodeId: string, version = 1): Promise<string> => {
  const octets = await portsArtefact.documents.lire(user.id, nodeId, version);
  if (!octets) throw new Error(`fichier ${nodeId} v${version} illisible`);
  return new PizZip(octets).file("word/document.xml")!.asText().toUpperCase();
};

describe("la charte — l'accent par défaut est le bleu canard de la maison", () => {
  it("R 8, V 112, B 132 = #087084, déclaré une fois et lu par la charte ET par la fabrique", () => {
    expect(ACCENT_DEFAUT.toUpperCase()).toBe("087084");
    expect(ACCENT_MAISON.toUpperCase()).toBe(ACCENT_DEFAUT.toUpperCase());
    const [r, v, b] = [0, 2, 4].map((i) => parseInt(ACCENT_DEFAUT.slice(i, i + 2), 16));
    expect([r, v, b]).toEqual([8, 112, 132]);
  });
});

suite("la couleur d'une pièce émise, sur une vraie base", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG}@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    const access = await getAccess(u.id, u.role);
    user = { id: u.id, name: u.name, email: u.email, role: u.role, secondaryRole: null, access, mustChangePassword: false };
    // LA PASTILLE EST ROUGE : c'est la couleur d'écran de la société, et c'est exactement ce que la Direction ne veut plus voir sur le papier.
    const c = await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12), color: `#${ROUGE_ANCIEN.toLowerCase()}` } });
    companyId = c.id;
    await prisma.companyLegalIdentity.create({
      data: {
        companyId, legalName: `${TAG} Pharma SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
        nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
        bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Amine Djouamai", managerTitle: "Gérant",
      },
    });
  }, 60_000);

  afterAll(async () => {
    const pieces = (await prisma.legalDocument.findMany({ where: { companyId }, select: { id: true } }).catch(() => [])).map((d) => d.id);
    await prisma.validationRequest.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: pieces } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: pieces } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: user.id } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: user.id } }).catch(() => {});
    await prisma.companyDocumentProfile.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  let premiere: { id: string; nodeId: string; reference: string };

  it("une société à PASTILLE ROUGE émet en bleu canard : ni la spécification ni le fichier Word ne portent le rouge", async () => {
    premiere = await emettre();
    expect(await couleurStockee(premiere.id)).toBe(ACCENT_DEFAUT.toUpperCase());
    const xml = await xmlDuFichier(premiere.nodeId);
    expect(xml).toContain(ACCENT_DEFAUT.toUpperCase());
    expect(xml).not.toContain(ROUGE_ANCIEN);
  }, 60_000);

  it("une RÉVISION repeint l'accent d'une pièce émise avant la décision : le rouge stocké devient le bleu canard", async () => {
    // La pièce telle qu'elle était émise AVANT la décision : son accent stocké est l'ancien rouge de la pastille.
    const d = await prisma.legalDocument.findUniqueOrThrow({ where: { id: premiere.id }, select: { custom: true } });
    const custom = d.custom as { fabrique: { spec: Record<string, unknown> } } & Record<string, unknown>;
    custom.fabrique.spec.couleur = ROUGE_ANCIEN;
    await prisma.legalDocument.update({ where: { id: premiere.id }, data: { custom: custom as object } });
    expect(await couleurStockee(premiere.id)).toBe(ROUGE_ANCIEN);

    const rev = await reviserDocumentDrive(user, { legalDocumentId: premiere.id, modifications: { notes: "Livraison avant fin du mois." }, motif: "note de livraison" });
    expect(rev.ok).toBe(true);
    if (!rev.ok) return;
    expect(rev.version).toBe(2);
    expect(await couleurStockee(premiere.id)).toBe(ACCENT_DEFAUT.toUpperCase());
    const xml2 = await xmlDuFichier(premiere.nodeId, 2);
    expect(xml2).toContain(ACCENT_DEFAUT.toUpperCase());
    expect(xml2).not.toContain(ROUGE_ANCIEN);
  }, 60_000);

  it("une pièce NON révisée garde sa couleur d'émission : régler la marque ensuite ne repeint pas ce qui est émis", async () => {
    const ancienne = await emettre({ tiers: { nom: `${TAG} Ancien fournisseur` } });
    const avant = await couleurStockee(ancienne.id);
    expect(avant).toBe(ACCENT_DEFAUT.toUpperCase());
    const m = await definirMarque(user, { societe: companyId, modification: { couleurAccent: `#${VERT_MARQUE}` } });
    expect(m.ok).toBe(true);
    // Le fichier de la pièce déjà émise est resté tel qu'il a été émis.
    expect(await couleurStockee(ancienne.id)).toBe(avant);
    const xml = await xmlDuFichier(ancienne.nodeId);
    expect(xml).toContain(ACCENT_DEFAUT.toUpperCase());
    expect(xml).not.toContain(VERT_MARQUE);
  }, 60_000);

  it("le registre de marque de la société L'EMPORTE sur le bleu canard — pour une pièce neuve comme pour une pièce révisée", async () => {
    const neuve = await emettre({ tiers: { nom: `${TAG} Nouveau fournisseur` } });
    expect(await couleurStockee(neuve.id)).toBe(VERT_MARQUE);
    const xml = await xmlDuFichier(neuve.nodeId);
    expect(xml).toContain(VERT_MARQUE);
    expect(xml).not.toContain(ROUGE_ANCIEN);

    const rev = await reviserDocumentDrive(user, { legalDocumentId: premiere.id, modifications: { notes: "Livraison sous 15 jours." }, motif: "nouveau délai" });
    expect(rev.ok).toBe(true);
    expect(await couleurStockee(premiere.id)).toBe(VERT_MARQUE);
    expect(await xmlDuFichier(premiere.nodeId, 3)).toContain(VERT_MARQUE);
  }, 90_000);

  it("retirer l'accent de la marque rend la société au bleu canard — jamais à sa pastille", async () => {
    const m = await definirMarque(user, { societe: companyId, modification: { couleurAccent: null } });
    expect(m.ok).toBe(true);
    const rendue = await emettre({ tiers: { nom: `${TAG} Fournisseur de retour` } });
    expect(await couleurStockee(rendue.id)).toBe(ACCENT_DEFAUT.toUpperCase());
    expect(await xmlDuFichier(rendue.nodeId)).not.toContain(ROUGE_ANCIEN);
  }, 60_000);
});
