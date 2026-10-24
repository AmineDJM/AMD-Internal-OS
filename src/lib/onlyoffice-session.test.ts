import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { peutEnregistrerOnlyoffice } from "@/lib/onlyoffice-session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RAPPEL DE L'ÉDITEUR OFFICE RELIT LE DROIT D'ENREGISTRER (audit 2026-10-24).
 *
 * Le jeton d'enregistrement vit 24 h. Sans relecture, un droit retiré pendant ce temps — ou un
 * accès qui n'a jamais été que de LECTURE — s'exerçait encore au rappel. La règle relue est la
 * même que celle qui ouvre l'éditeur en édition : « modifier » sur le Drive.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__oorappel${Date.now()}`;

suite("onlyoffice — peutEnregistrerOnlyoffice", () => {
  let proprietaire = "";
  let lecteur = "";
  let noeud = "";

  beforeAll(async () => {
    const p = await prisma.user.create({
      data: { email: `${TAG}-proprio@t.dz`, name: "Propriétaire", passwordHash: "!", role: "VIEWER", isActive: true },
      select: { id: true },
    });
    const l = await prisma.user.create({
      data: { email: `${TAG}-lecteur@t.dz`, name: "Lecteur", passwordHash: "!", role: "VIEWER", isActive: true },
      select: { id: true },
    });
    proprietaire = p.id;
    lecteur = l.id;
    const n = await prisma.driveNode.create({
      data: { name: `${TAG}-note.docx`, type: "FILE", ownerId: proprietaire, createdById: proprietaire },
      select: { id: true },
    });
    noeud = n.id;
    await prisma.driveShare.create({ data: { nodeId: noeud, userId: lecteur, access: "VIEW" } });
  }, 60_000);

  afterAll(async () => {
    await prisma.driveShare.deleteMany({ where: { nodeId: noeud } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { id: noeud } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("le propriétaire du fichier peut enregistrer", async () => {
    expect(await peutEnregistrerOnlyoffice(proprietaire, "drive", noeud)).toBe(true);
  });

  it("un partage en LECTURE ne permet pas d'enregistrer, même avec un jeton valide", async () => {
    expect(await peutEnregistrerOnlyoffice(lecteur, "drive", noeud)).toBe(false);
  });

  it("un compte désactivé depuis l'ouverture n'enregistre plus", async () => {
    await prisma.user.update({ where: { id: proprietaire }, data: { isActive: false } });
    try {
      expect(await peutEnregistrerOnlyoffice(proprietaire, "drive", noeud)).toBe(false);
    } finally {
      await prisma.user.update({ where: { id: proprietaire }, data: { isActive: true } });
    }
  });

  it("un compte inconnu ou un document inexistant ne peuvent rien enregistrer", async () => {
    expect(await peutEnregistrerOnlyoffice(`${TAG}-inconnu`, "drive", noeud)).toBe(false);
    expect(await peutEnregistrerOnlyoffice(proprietaire, "document", `${TAG}-aucun-document`)).toBe(false);
  });
});
