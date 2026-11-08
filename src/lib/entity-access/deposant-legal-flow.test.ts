import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { deposantDuDocumentLegal, peutOuvrirDocument } from "./ouverture-pieces";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI A DÉPOSÉ UN FICHIER DANS LEGAL LE VOIT (Direction, 08/11/2026) — joué en base.
 *
 *  • le déposant, SANS le module Legal, ouvre SON fichier — pas celui d'un autre sur le même document ;
 *  • le créateur du document en ouvre tous les fichiers ;
 *  • un compte sans lien n'ouvre rien ; la fiche complète, elle, reste fermée au déposant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__deposantlegal${Date.now()}__`;

async function acteur(id: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: null, access: await getAccess(id, u.role as SessionUser["role"]), mustChangePassword: false };
}

suite("Legal — le déposant d'un fichier le voit", () => {
  let createurId = "", deposantId = "", etrangerId = "", legalId = "", fichierDeposant = "", fichierCreateur = "";

  beforeAll(async () => {
    const mk = (n: string) => prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } });
    const [c, d, e] = await Promise.all([mk("createur"), mk("deposant"), mk("etranger")]);
    createurId = c.id; deposantId = d.id; etrangerId = e.id;
    legalId = (await prisma.legalDocument.create({ data: { title: `${TAG} Facture FA-9`, kind: "INVOICE", direction: "OUT", createdById: createurId } })).id;
    const fichier = (nom: string, par: string) => prisma.document.create({
      data: { name: `${TAG}${nom}`, entityType: "LEGAL_DOCUMENT", entityId: legalId, fileKey: `${TAG}/${nom}`, mimeType: "application/pdf", sizeBytes: 10, category: "OTHER", confidentiality: "INTERNAL", uploadedById: par },
    });
    fichierCreateur = (await fichier("facture.pdf", createurId)).id;
    fichierDeposant = (await fichier("bon-livraison.pdf", deposantId)).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.document.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: legalId } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  const piece = (id: string) => ({ id, entityType: "LEGAL_DOCUMENT" as const, entityId: legalId, stepKey: null });

  it("PRÉMISSE : aucun des trois n'a le module Legal — la porte du registre leur reste fermée", async () => {
    for (const id of [createurId, deposantId, etrangerId]) {
      expect(await canAccessEntity(await acteur(id), "LEGAL_DOCUMENT", legalId, "VIEW")).toBe(false);
    }
  });

  it("le déposant ouvre SON fichier, pas celui d'un autre sur le même document", async () => {
    const d = await acteur(deposantId);
    expect(await deposantDuDocumentLegal(deposantId, legalId)).toBe("DEPOSANT");
    expect(await peutOuvrirDocument(d, piece(fichierDeposant))).toBe(true);
    expect(await peutOuvrirDocument(d, piece(fichierCreateur))).toBe(false);
  });

  it("le créateur du document en ouvre tous les fichiers ; un compte sans lien, aucun", async () => {
    const c = await acteur(createurId);
    expect(await deposantDuDocumentLegal(createurId, legalId)).toBe("CREATEUR");
    expect(await peutOuvrirDocument(c, piece(fichierCreateur))).toBe(true);
    expect(await peutOuvrirDocument(c, piece(fichierDeposant))).toBe(true);

    const e = await acteur(etrangerId);
    expect(await deposantDuDocumentLegal(etrangerId, legalId)).toBeNull();
    expect(await peutOuvrirDocument(e, piece(fichierCreateur))).toBe(false);
    expect(await peutOuvrirDocument(e, piece(fichierDeposant))).toBe(false);
  });
});
