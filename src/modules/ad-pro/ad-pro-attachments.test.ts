import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__adprojoin__";

async function viewerFor(id: string, role: SessionUser["role"]): Promise<SessionUser> {
  return { id, role, access: await getAccess(id, role) } as SessionUser;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * JOINDRE UNE PIÈCE À UN DOSSIER Ad&Pro — la garde SERVEUR, pas seulement le bouton.
 *
 * « On veut associer une facture à l'événement, mais je n'arrive pas à joindre de PJ. » Le droit
 * `UPLOAD` du module était exigé, et lui seul : la Direction qui valide le dossier, le chef de
 * produit qui l'a analysé ne pouvaient rien déposer dès que cette case ne leur avait pas été
 * cochée. Ils envoyaient la facture par mail, et le dossier restait vide.
 *
 * Ce qui suit part de `canAccessEntity`, la porte que l'action d'envoi interroge : afficher le
 * bouton sans ouvrir cette porte n'aurait fait que déplacer le refus après le téléversement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Ad&Pro — joindre une pièce", () => {
  let directionId = "", pmId = "", demandeurId = "", etrangerId = "", sponsoringId = "", eventId = "";

  beforeAll(async () => {
    const [direction, pm, dem, etr] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}dir`, email: `${TAG}dir@t.dz`, role: "DIRECTION", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}cp`, email: `${TAG}cp@t.dz`, role: "PRODUCT_MANAGER", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}dem`, email: `${TAG}dem@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}etr`, email: `${TAG}etr@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } }),
    ]);
    directionId = direction.id; pmId = pm.id; demandeurId = dem.id; etrangerId = etr.id;

    // UN LECTEUR SANS DROIT D'ENVOI : c'est la situation rapportée. Il voit le dossier, il ne
    // peut rien y déposer — jusqu'ici, même quand il l'instruit.
    await prisma.userAccess.create({
      data: { userId: pmId, module: "SPONSORING", canView: true, canUpdate: true, scope: "ALL" },
    });
    await prisma.userAccess.create({
      data: { userId: etrangerId, module: "SPONSORING", canView: true, scope: "ALL" },
    });

    const spo = await prisma.sponsoringRequest.create({
      data: {
        reference: `SPO-2031-${Math.floor(Math.random() * 9000 + 1000)}`,
        institution: `${TAG} CHU`, type: "Journée scientifique",
        requesterId: demandeurId, productManagerId: pmId,
      },
    });
    sponsoringId = spo.id;
    const ev = await prisma.event.create({
      data: { name: `${TAG} Symposium`, type: "CONGRESS", scope: "NATIONAL", format: "PRESENTIAL", requesterId: demandeurId },
    });
    eventId = ev.id;
  });

  afterAll(async () => {
    await prisma.event.deleteMany({ where: { id: eventId } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: sponsoringId } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: [directionId, pmId, demandeurId, etrangerId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("LA DIRECTION JOINT SA FACTURE — elle décide du dossier", async () => {
    const v = await viewerFor(directionId, "DIRECTION");
    expect(await canAccessEntity(v, "SPONSORING", sponsoringId, "UPLOAD")).toBe(true);
    expect(await canAccessEntity(v, "EVENT", eventId, "UPLOAD")).toBe(true);
  });

  it("CELUI QUI PEUT MODIFIER LE DOSSIER PEUT L'ALIMENTER — sans droit d'envoi coché", async () => {
    // Le cœur du défaut : ce Direction Marketing a `UPDATE` sur le module, pas `UPLOAD`. Il
    // instruisait le dossier et n'avait aucun moyen d'y déposer la facture.
    const v = await viewerFor(pmId, "PRODUCT_MANAGER");
    expect(userCan(v, "SPONSORING", "UPLOAD"), "le droit UPLOAD ne doit PAS être coché : c'est tout l'intérêt du test").toBe(false);
    expect(await canAccessEntity(v, "SPONSORING", sponsoringId, "UPLOAD")).toBe(true);
  });

  it("LE DEMANDEUR JOINT SUR SON PROPRE DOSSIER, comme avant", async () => {
    const v = await viewerFor(demandeurId, "MEDICAL_DELEGATE");
    expect(await canAccessEntity(v, "SPONSORING", sponsoringId, "UPLOAD")).toBe(true);
    expect(await canAccessEntity(v, "EVENT", eventId, "UPLOAD")).toBe(true);
  });

  it("UN SIMPLE LECTEUR NE JOINT TOUJOURS PAS — la règle n'ouvre rien de neuf", async () => {
    const v = await viewerFor(etrangerId, "MEDICAL_DELEGATE");
    expect(await canAccessEntity(v, "SPONSORING", sponsoringId, "UPLOAD")).toBe(false);
  });

  it("et elle n'ouvre pas la SUPPRESSION : retirer une pièce reste un geste à part", async () => {
    const v = await viewerFor(pmId, "PRODUCT_MANAGER");
    expect(await canAccessEntity(v, "SPONSORING", sponsoringId, "DELETE")).toBe(false);
  });
});
