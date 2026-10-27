import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import PizZip from "pizzip";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { getBlob, putBlob } from "@/lib/drive-storage";
import { papierEnTeteDeDemonstration } from "@/lib/artifact/factory/word";
import { DOCUMENT_MODELE, corpsEnBlocs } from "@/lib/agent/operations/document-modele";
import { executerOperationIA } from "@/lib/agent/operations";

/**
 * L'ASSISTANT IA — UNE LETTRE SUR LE PAPIER EN-TÊTE DE LA BONNE SOCIÉTÉ, dans le Drive.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iadoc_${Date.now().toString(36)}_`;
let admin: CurrentUser;
let societeId = "";

suite("Assistant IA — document depuis un modèle", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}admin`, email: `${TAG}admin@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    admin = { id: u.id, name: u.name, email: u.email, role: u.role, access: await getAccess(u.id, u.role), mustChangePassword: false } as CurrentUser;
    societeId = (await prisma.company.create({ data: { name: `${TAG}Pharmagène`, shortName: `${TAG}PHG` } })).id;
    const { blobId, size } = await putBlob(papierEnTeteDeDemonstration(`${TAG}Pharmagène`));
    await prisma.officeLetterhead.create({ data: { name: `${TAG}Papier officiel`, kind: "word", companyId: societeId, blobId, size, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", isActive: true, uploadedById: admin.id } });
  });

  afterAll(async () => {
    await prisma.fileVersion.deleteMany({ where: { node: { name: { contains: TAG } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { name: { contains: TAG } } }).catch(() => {});
    await prisma.officeLetterhead.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: societeId } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: admin?.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("le texte dicté devient des paragraphes, intertitres et puces", () => {
    const b = corpsEnBlocs("Madame,\n\n## Contexte\nNous avons reçu votre courrier.\n\n- point un\n- point deux");
    expect(b).toHaveLength(5);
    expect(b[1]).toContain("Heading2");
    expect(b[3]).toContain("•  point un");
  });

  it("une lettre : objet, destinataire, société — puis le .docx sur le papier en-tête, dans le Drive", async () => {
    const p = await DOCUMENT_MODELE.proposer({
      modele: "lettre", objet: `${TAG}Confirmation de participation`, destinataire: "Pr. Benali\nCHU Oran",
      contenu: "Professeur,\n\nNous confirmons notre participation au congrès.", societe: `${TAG}Pharmagène`,
    }, admin);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    expect(p.carte.fields.find((f) => f.label === "Papier en-tête")?.value).toBe(`${TAG}Papier officiel`);
    const r = await executerOperationIA(admin, { kind: "assistant_ia_op", op: DOCUMENT_MODELE.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/papier en-tête/);
    const node = await prisma.driveNode.findFirstOrThrow({ where: { name: { contains: `${TAG}Confirmation` } } });
    const v = await prisma.fileVersion.findFirstOrThrow({ where: { nodeId: node.id } });
    const xml = new PizZip(await getBlob(v.blobId)).file("word/document.xml")!.asText();
    expect(xml).toContain("Nous confirmons notre participation");
    expect(xml).toContain("Objet : ");
  });

  it("une société absente des siennes est refusée — jamais émis au nom d'une autre", async () => {
    const p = await DOCUMENT_MODELE.proposer({ modele: "note", objet: "x", contenu: "y", societe: `${TAG}Société inconnue` }, admin);
    expect("erreur" in p && p.erreur).toMatch(/Aucune société/);
  });
});
