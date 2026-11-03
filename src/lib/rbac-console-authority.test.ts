import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__consoleAutorite__";

/**
 * LA CONSOLE D'ADMINISTRATION FAIT AUTORITÉ — pour les Moyens généraux comme pour la Promotion
 * médicale.
 *
 * ── LE DÉFAUT QU'ON FERME ───────────────────────────────────────────────────────────────────
 *
 * Les Moyens généraux s'accordaient en silence à quiconque tenait les ressources humaines : une
 * ligne d'accès implicite, au motif que les RH pilotent la dotation des départements. La console
 * affichait « Aucun accès » sur cette ligne, et la personne avait le module. Retirer l'accès
 * depuis l'écran prévu pour cela ne changeait rien, et il fallait connaître la ligne de code
 * pour comprendre pourquoi.
 *
 * ── CE QUE CE FICHIER TIENT ─────────────────────────────────────────────────────────────────
 *
 * Un droit qui ne se lit pas là où on le règle n'est pas administrable. Pour ces deux modules,
 * on vérifie donc les DEUX SENS, depuis `getAccess` — la fonction que consultent les écrans, les
 * actions serveur, l'API et Adam :
 *
 *   • un BLOCAGE posé dans la console retire le module, même quand le rôle l'accorde ;
 *   • une AUTORISATION posée dans la console l'accorde, même quand le rôle ne le donne pas ;
 *   • et AUCUN détour ne le rouvre — ni les RH, ni un module voisin.
 *
 * Le test part de la vraie table d'overrides (`UserAccess`), celle que la console écrit : une
 * fabrique d'accès montée à la main dirait seulement que la fonction sait lire un objet.
 */
suite("La console d'administration fait autorité sur l'accès aux modules", () => {
  let rhId = "";
  let deleId = "";
  let assistId = "";

  const seed = async (name: string, role: SessionUser["role"]) =>
    (await prisma.user.create({
      data: { name: `${TAG} ${name}`, email: `${TAG}${name}@t.dz`, role, passwordHash: "x" },
      select: { id: true },
    })).id;

  beforeAll(async () => {
    // Un compte SANS Moyens généraux dans sa matrice, mais qui tient les RH par la console :
    // c'est exactement le profil qui recevait le module par la porte dérobée.
    rhId = await seed("rh", "MEDICAL_DELEGATE");
    await prisma.userAccess.create({
      data: {
        userId: rhId, module: "RH", canView: true, canCreate: true, canUpdate: true,
        canDelete: false, canValidate: false, canExport: true, canUpload: true, scope: "ALL",
      },
    });
    // Un délégué : son rôle lui donne la Promotion médicale.
    deleId = await seed("delegue", "MEDICAL_DELEGATE");
    // Une assistante : son rôle ne lui donne PAS la Promotion médicale.
    assistId = await seed("assistante", "DIRECTION_ASSISTANT");
  }, 60_000);

  afterAll(async () => {
    await prisma.userAccess.deleteMany({ where: { userId: { in: [rhId, deleId, assistId] } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  const asUser = async (id: string, role: SessionUser["role"]) =>
    ({ id, role, access: await getAccess(id, role) }) as unknown as SessionUser;

  it("LES MOYENS GÉNÉRAUX NE S'OUVRENT PLUS PAR LES RH — la console disait « aucun accès », et c'était faux", async () => {
    const u = await asUser(rhId, "MEDICAL_DELEGATE");
    expect(userCan(u, "RH", "UPDATE")).toBe(true);
    expect(userCan(u, "GENERAL_MEANS", "VIEW")).toBe(false);
  });

  it("…et la console les rouvre d'un clic, cette fois VISIBLEMENT", async () => {
    await prisma.userAccess.create({
      data: {
        userId: rhId, module: "GENERAL_MEANS", canView: true, canCreate: true, canUpdate: true,
        canDelete: true, canValidate: true, canExport: true, canUpload: true, scope: "ALL",
      },
    });
    const u = await asUser(rhId, "MEDICAL_DELEGATE");
    expect(userCan(u, "GENERAL_MEANS", "VIEW")).toBe(true);
    expect(userCan(u, "GENERAL_MEANS", "UPDATE")).toBe(true);
  });

  it("PROMOTION MÉDICALE : un BLOCAGE de la console retire le module que le rôle accorde", async () => {
    const avant = await asUser(deleId, "MEDICAL_DELEGATE");
    expect(userCan(avant, "MEDICAL", "VIEW")).toBe(true);

    // `canView: false` = la ligne « Bloqué » de la console. Elle est ABSOLUE.
    await prisma.userAccess.create({
      data: {
        userId: deleId, module: "MEDICAL", canView: false, canCreate: false, canUpdate: false,
        canDelete: false, canValidate: false, canExport: false, canUpload: false, scope: "ASSIGNED",
      },
    });
    const apres = await asUser(deleId, "MEDICAL_DELEGATE");
    expect(userCan(apres, "MEDICAL", "VIEW")).toBe(false);
  });

  it("PROMOTION MÉDICALE : une AUTORISATION de la console l'accorde à qui ne l'a pas par son rôle", async () => {
    const avant = await asUser(assistId, "DIRECTION_ASSISTANT");
    expect(userCan(avant, "MEDICAL", "VIEW")).toBe(false);

    await prisma.userAccess.create({
      data: {
        userId: assistId, module: "MEDICAL", canView: true, canCreate: false, canUpdate: true,
        canDelete: false, canValidate: false, canExport: true, canUpload: false, scope: "ALL",
      },
    });
    const apres = await asUser(assistId, "DIRECTION_ASSISTANT");
    expect(userCan(apres, "MEDICAL", "VIEW")).toBe(true);
    expect(userCan(apres, "MEDICAL", "UPDATE")).toBe(true);
    // Ce qui n'a pas été coché ne s'accorde pas au passage.
    expect(userCan(apres, "MEDICAL", "DELETE")).toBe(false);
  });
});
