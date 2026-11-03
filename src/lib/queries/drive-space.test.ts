import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { getDriveSpacesForUser, getDriveListing, getDriveTabs } from "./drive";

// Sonde DB ; suite sautée proprement sans base (CI sans Postgres).
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__drvspace__";

/**
 * « Catégorie » de Drive (espace partagé, type Promotion Médicale) : un compte SANS accès
 * Drive par défaut, ajouté nommément à la catégorie, doit pouvoir OUVRIR le module (accès
 * implicite), voir l'onglet, consulter le contenu partagé — mais pas y déposer s'il n'est
 * que lecteur. Un gestionnaire, lui, peut éditer. Un non-membre ne voit rien.
 */
suite("Catégories Drive : accès partagé (consultation vs gestion) + isolement du perso", () => {
  let readerId = "", managerId = "", outsiderId = "", spaceId = "", nodeId = "";
  const viewer = (id: string, role: SessionUser["role"] = "MEDICAL_DELEGATE"): SessionUser =>
    ({ id, role, access: { modules: new Map(), rowGrants: {} } as never });

  beforeAll(async () => {
    const mk = (s: string) => prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } as never });
    const [r, m, o] = await Promise.all([mk("reader"), mk("manager"), mk("outsider")]);
    readerId = r.id; managerId = m.id; outsiderId = o.id;

    const space = await prisma.driveSpace.create({
      data: {
        name: `${TAG}Promotion Médicale`,
        accessUserIds: [readerId],
        managerUserIds: [managerId],
        // Un fichier déjà déposé dans la catégorie (partagé entre membres).
        nodes: { create: [{ name: `${TAG}Brochure.pdf`, type: "FILE", ownerId: managerId, size: 10, mimeType: "application/pdf" }] },
      },
      select: { id: true, nodes: { select: { id: true } } },
    });
    spaceId = space.id;
    nodeId = space.nodes[0].id;
  });

  afterAll(async () => {
    await prisma.driveSpace.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("getAccess ouvre le module Drive (accès implicite via la catégorie partagée)", async () => {
    const a = await getAccess(readerId, "MEDICAL_DELEGATE");
    expect(a.modules.has("DRIVE")).toBe(true);
    const b = await getAccess(managerId, "MEDICAL_DELEGATE");
    expect(b.modules.has("DRIVE")).toBe(true);
  });

  it("les onglets contiennent la catégorie pour ses membres, pas pour un tiers", async () => {
    const readerTabs = await getDriveTabs(viewer(readerId));
    expect(readerTabs.some((t) => t.href === `/drive/espace/${spaceId}`)).toBe(true);
    const outsiderSpaces = await getDriveSpacesForUser(viewer(outsiderId));
    expect(outsiderSpaces.some((s) => s.id === spaceId)).toBe(false);
  });

  it("lecteur : consultation (VIEW) ; gestionnaire : édition (EDIT)", async () => {
    const reader = await getDriveSpacesForUser(viewer(readerId));
    expect(reader.find((s) => s.id === spaceId)?.canManage).toBe(false);
    const manager = await getDriveSpacesForUser(viewer(managerId));
    expect(manager.find((s) => s.id === spaceId)?.canManage).toBe(true);

    const readerListing = await getDriveListing(viewer(readerId), null, false, spaceId);
    expect(readerListing?.level).toBe("VIEW");
    expect(readerListing?.nodes.some((n) => n.id === nodeId)).toBe(true);
    expect(readerListing?.nodes.every((n) => n.canEdit === false)).toBe(true); // lecteur : rien d'éditable

    const managerListing = await getDriveListing(viewer(managerId), null, false, spaceId);
    expect(managerListing?.level).toBe("EDIT");
    expect(managerListing?.nodes.some((n) => n.id === nodeId && n.canEdit)).toBe(true);
  });

  it("un non-membre ne peut pas ouvrir la catégorie", async () => {
    const listing = await getDriveListing(viewer(outsiderId), null, false, spaceId);
    expect(listing).toBeNull();
  });

  it("les fichiers d'une catégorie n'apparaissent PAS dans le Drive personnel du propriétaire", async () => {
    // Le fichier appartient au gestionnaire mais vit dans la catégorie (spaceId) : sa racine
    // PERSONNELLE (spaceId null) ne doit pas le lister.
    const personal = await getDriveListing(viewer(managerId), null, false, null);
    expect(personal?.nodes.some((n) => n.id === nodeId)).toBe(false);
  });
});
