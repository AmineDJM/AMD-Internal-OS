import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Hors requête, `cookies()` lève : la sélection d'en-tête vaut « toutes les entités ». La garde des fiches
// ne doit justement PAS dépendre de cette sélection (§118.184) — elle juge sur les droits.
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__fiches__";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE FICHE OUVERTE PAR SON LIEN NE S'OUVRE PAS PLUS LARGE QUE SA LISTE (§118.184).
 *
 * L'audit 360° l'a mesuré sur plusieurs modules : la liste composait l'entité, la fiche non — un
 * identifiant suffisait à lire, et souvent à MODIFIER, le dossier d'une société à laquelle on n'a aucun
 * droit. Ce banc joue chaque garde avec un acteur RATTACHÉ à une société (sans vue globale, §118.104),
 * contre la vraie fonction (`canAccessEntity`) que la fiche et toutes ses actions appellent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Fiches — l'entité est vérifiée sur la fiche comme sur la liste", () => {
  let A = "", B = "", C = "";
  let responsable: SessionUser, superAdmin: SessionUser;
  const ids: Record<string, string> = {};

  const acteur = async (id: string, role: string) =>
    ({ id, role, secondaryRole: null, access: await getAccess(id, role as never) } as unknown as SessionUser);

  async function nettoyer() {
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.userProductRange.deleteMany({ where: { range: { name: { startsWith: TAG } } } }).catch(() => {});
    await prisma.productRange.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    [A, B, C] = (await Promise.all(["Alpha", "Beta", "Gamma"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    const resp = await prisma.user.create({ data: { name: `${TAG}Resp`, email: `${TAG}resp@t.dz`, role: "HEAD_OF_REGULATORY", passwordHash: "x" } });
    const sa = await prisma.user.create({ data: { name: `${TAG}SA`, email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } });
    // Rattaché à Alpha, et à elle seule : c'est ce qui fait de l'entité une frontière pour lui.
    await prisma.employee.create({ data: { fullName: `${TAG}Resp`, companyId: A, userId: resp.id } });
    responsable = await acteur(resp.id, "HEAD_OF_REGULATORY");
    superAdmin = await acteur(sa.id, "SUPER_ADMIN");
    const mk = async (k: string, companyId: string | null, extra: Record<string, unknown> = {}) => {
      ids[k] = (await prisma.regulatoryProduct.create({ data: { reference: `${TAG}${k}`, dci: `${TAG}dci-${k}`, companyId, ...extra } })).id;
    };
    await mk("alpha", A);
    await mk("beta", B);
    await mk("sans", null);
    await mk("betaNomme", B, { responsibleId: resp.id });
    // UNE GAMME de Gamma lui ouvre Gamma — restreinte à cette gamme. C'est le SEUL profil pour qui la
    // gamme restreint quelque chose : une portée « par ligne » ne montre déjà que les dossiers où l'on
    // est nommé, et être nommé ouvre le dossier quelle que soit sa gamme.
    const gamme = await prisma.productRange.create({ data: { name: `${TAG}Gamme`, companyId: C } });
    await prisma.userProductRange.create({ data: { userId: resp.id, rangeId: gamme.id } });
    await mk("gammaDans", C, { rangeId: gamme.id });
    await mk("gammaHors", C);
  });

  afterAll(async () => {
    await nettoyer();
  });

  it("REGULATORY : la fiche de SA société s'ouvre ; celle d'une autre société, non — ni en lecture ni en écriture", async () => {
    expect(await canAccessEntity(responsable, "REGULATORY_PRODUCT", ids.alpha, "VIEW")).toBe(true);
    expect(await canAccessEntity(responsable, "REGULATORY_PRODUCT", ids.beta, "VIEW")).toBe(false);
    expect(await canAccessEntity(responsable, "REGULATORY_PRODUCT", ids.beta, "UPDATE")).toBe(false);
  });

  it("REGULATORY : un dossier SANS entité reste lisible — il n'est le secret d'aucune société", async () => {
    expect(await canAccessEntity(responsable, "REGULATORY_PRODUCT", ids.sans, "VIEW")).toBe(true);
  });

  it("REGULATORY : être NOMMÉ sur le dossier d'une autre société n'ouvre pas l'entité (même règle que la liste)", async () => {
    expect(await canAccessEntity(responsable, "REGULATORY_PRODUCT", ids.betaNomme, "VIEW")).toBe(false);
  });

  it("REGULATORY : une GAMME ouverte sur une autre société n'ouvre que sa gamme — pas toute la société", async () => {
    // PRÉMISSE : il voit toutes les lignes du module — sans quoi la gamme ne restreindrait rien ici.
    expect(responsable.access.modules.get("REGULATORY")?.scope).toBe("ALL");
    expect(await canAccessEntity(responsable, "REGULATORY_PRODUCT", ids.gammaDans, "VIEW")).toBe(true);
    expect(await canAccessEntity(responsable, "REGULATORY_PRODUCT", ids.gammaHors, "VIEW")).toBe(false);
  });

  it("REGULATORY : qui voit tout le groupe ouvre toutes les fiches (le témoin sans lequel la garde passerait pour juste)", async () => {
    expect(await canAccessEntity(superAdmin, "REGULATORY_PRODUCT", ids.beta, "VIEW")).toBe(true);
    expect(await canAccessEntity(superAdmin, "REGULATORY_PRODUCT", ids.alpha, "UPDATE")).toBe(true);
  });
});
