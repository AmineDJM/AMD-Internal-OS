import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__porteeadpro__";

/** Les droits viennent de la VRAIE matrice de rôles (`getAccess`), jamais d'un accès posé à la
 *  main : un droit fabriqué pour le banc prouverait une porte qu'aucun rôle réel ne franchit. */
async function acteur(id: string, role: SessionUser["role"]): Promise<SessionUser> {
  return { id, role, access: await getAccess(id, role) } as SessionUser;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PORTE DES PIÈCES ET DU FIL SUIT LA PORTÉE DE LA FICHE (§118.153).
 *
 * Congrès international, congrès national et matériel promotionnel ont une portée « ses lignes »
 * pour le délégué — et, depuis §118.153, pour le National Sales sur le matériel promotionnel. La
 * fiche et les listes l'appliquaient ; `canAccessEntity` — la porte qu'interrogent les pièces
 * jointes, les commentaires et le fil de discussion — ne l'appliquait pas : le raccourci « UPDATE
 * sur le module » et le `default` du dernier aiguillage ouvraient N'IMPORTE QUEL dossier à qui
 * avait le module, sur son seul identifiant. Mesuré par le banc du circuit 2 : un National Sales
 * lisait le dossier d'un KAM dont il n'est pas le N+1. Le même trou existait, avant ce lot, sur
 * les congrès de tous les délégués.
 *
 * Chaque cas part de la VRAIE porte, avec des acteurs SANS vue globale : une portée éprouvée avec
 * un Super Admin ne peut pas tomber (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("canAccessEntity — la portée de ligne des dossiers Ad & Pro", () => {
  const u: Record<string, string> = {};
  let promoA = "", congresIntlA = "", congresNatA = "";

  beforeAll(async () => {
    await nettoyer();
    const mk = async (k: string, role: SessionUser["role"]) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await mk("kamA", "MEDICAL_DELEGATE");
    await mk("kamB", "MEDICAL_DELEGATE");
    await mk("nsN1", "NATIONAL_SALES");
    await mk("nsAutre", "NATIONAL_SALES");
    await mk("dm", "PRODUCT_MANAGER");

    promoA = (await prisma.promoMaterial.create({
      data: {
        reference: `${TAG}-A`, title: `${TAG} Carnets du KAM A`, status: "PROSPECTION_REQUESTED",
        circuitState: "REVIEW_REQUEST", circuitVersion: 2, requestValidation: true, requestValidatorId: u.nsN1,
        requesterId: u.kamA, createdById: u.kamA, updatedById: u.kamA,
      },
    })).id;
    congresIntlA = (await prisma.congressInternational.create({ data: { name: `${TAG} ESMO`, requesterId: u.kamA } })).id;
    congresNatA = (await prisma.congressNational.create({ data: { name: `${TAG} Journées d'Oran`, requesterId: u.kamA } })).id;
  }, 60_000);

  afterAll(nettoyer);

  async function nettoyer() {
    await prisma.promoMaterial.deleteMany({ where: { title: { startsWith: TAG } } });
    await prisma.congressInternational.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.congressNational.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } });
  }

  const ACTIONS = ["VIEW", "UPLOAD", "UPDATE"] as const;
  const DOSSIERS = () => [
    ["PROMO_MATERIAL", promoA],
    ["CONGRESS_INTERNATIONAL", congresIntlA],
    ["CONGRESS_NATIONAL", congresNatA],
  ] as const;

  it("PRÉMISSES : les refus attendus ne peuvent venir QUE de la portée de ligne", async () => {
    // Sans elles, un refus pourrait venir d'un droit de module absent — et le cas passerait au vert
    // le jour où la porte se rouvrirait, sans plus rien garder (§118.104).
    const kamB = await acteur(u.kamB, "MEDICAL_DELEGATE");
    for (const m of ["PROMO_MATERIAL", "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL"] as const) {
      expect(userCan(kamB, m, "UPDATE"), `${m} UPDATE`).toBe(true);
      expect(kamB.access.modules.get(m)?.scope, `${m} scope`).toBe("ASSIGNED");
    }
    const nsAutre = await acteur(u.nsAutre, "NATIONAL_SALES");
    expect(userCan(nsAutre, "PROMO_MATERIAL", "UPDATE")).toBe(true);
    expect(nsAutre.access.modules.get("PROMO_MATERIAL")?.scope).toBe("ASSIGNED");
    // Et le rôle qui voit TOUT garde tout : c'est l'autre moitié, qui empêche une garde trop large
    // (refuser à tout le monde) de passer pour armée (§118.17).
    const dm = await acteur(u.dm, "PRODUCT_MANAGER");
    for (const m of ["PROMO_MATERIAL", "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL"] as const) {
      expect(dm.access.modules.get(m)?.scope, `${m} scope DM`).toBe("ALL");
    }
  });

  it("l'auteur ouvre, alimente et modifie SES dossiers", async () => {
    const kamA = await acteur(u.kamA, "MEDICAL_DELEGATE");
    for (const [type, id] of DOSSIERS()) {
      for (const a of ACTIONS) expect(await canAccessEntity(kamA, type, id, a), `${type} ${a}`).toBe(true);
    }
  });

  it("un AUTRE délégué ne lit, n'alimente ni ne modifie le dossier d'un collègue — la fuite mesurée", async () => {
    const kamB = await acteur(u.kamB, "MEDICAL_DELEGATE");
    for (const [type, id] of DOSSIERS()) {
      for (const a of ACTIONS) expect(await canAccessEntity(kamB, type, id, a), `${type} ${a}`).toBe(false);
    }
  });

  it("le N+1 NOMMÉ lit la demande de son KAM — c'est la fiche où on lui demande de trancher", async () => {
    const n1 = await acteur(u.nsN1, "NATIONAL_SALES");
    expect(await canAccessEntity(n1, "PROMO_MATERIAL", promoA, "VIEW")).toBe(true);
    // Il lit et commente (le fil passe par VIEW, §118.145) ; il ne dépose ni ne modifie rien dans
    // le dossier d'un autre. C'était déjà vrai avant ce lot — il n'avait pas le module — et ouvrir
    // le module au National Sales ne doit pas l'avoir changé.
    expect(await canAccessEntity(n1, "PROMO_MATERIAL", promoA, "UPLOAD")).toBe(false);
    expect(await canAccessEntity(n1, "PROMO_MATERIAL", promoA, "UPDATE")).toBe(false);
  });

  it("un autre National Sales, qui n'est PAS le N+1, ne lit pas le dossier du KAM", async () => {
    const autre = await acteur(u.nsAutre, "NATIONAL_SALES");
    for (const a of ACTIONS) expect(await canAccessEntity(autre, "PROMO_MATERIAL", promoA, a), a).toBe(false);
  });

  it("la Direction Marketing, en portée ALL, garde tout", async () => {
    const dm = await acteur(u.dm, "PRODUCT_MANAGER");
    for (const [type, id] of DOSSIERS()) {
      for (const a of ACTIONS) expect(await canAccessEntity(dm, type, id, a), `${type} ${a}`).toBe(true);
    }
  });
});
