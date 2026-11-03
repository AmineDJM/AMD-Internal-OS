import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { ENTITIES } from "@/lib/api/registry/entities";
import { resoudreCible, direRefus, ENTITES_RESOLVABLES } from "./resoudre";

const TAG = "__cible__";
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN SEUL RÉSOLVEUR POUR LES 29 OBJETS — et il ne devine jamais.
 *
 * Ce qui ferait tomber ces essais, nommément : rendre une forme différente selon qu'on trouve
 * ou non (§118.20, le défaut des 117 résolveurs) ; collapser une liste de plusieurs sur son
 * premier élément (§118.34) ; ou chercher sans la portée, ce qui ferait exister une ligne
 * interdite le temps d'un refus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Résolveur de cible", () => {
  let user: SessionUser;
  let idAlpha = "";

  beforeAll(async () => {
    const [a, b] = await Promise.all([
      prisma.company.create({ data: { name: `${TAG}Alpha` } }),
      prisma.company.create({ data: { name: `${TAG}Beta` } }),
    ]);
    const u = await prisma.user.create({
      data: {
        name: `${TAG}chef`, email: `${TAG}chef@t.dz`, role: "HEAD_OF_REGULATORY", passwordHash: "x",
        companyAccess: { create: [{ companyId: a.id, canEdit: true }] },
      },
    });
    const [alpha] = await Promise.all([
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}REG-1`, dci: "Nivolex", companyId: a.id }, select: { id: true } }),
      // DEUX homonymes chez Alpha : de quoi rendre une désignation ambiguë POUR DE VRAI.
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}REG-2`, dci: "Trastuzex alpha", companyId: a.id } }),
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}REG-3`, dci: "Trastuzex bêta", companyId: a.id } }),
      // Chez BETA : la personne n'y a pas droit. Elle ne doit ni l'obtenir, ni le voir nommé.
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}REG-9`, dci: "Secretol", companyId: b.id } }),
    ]);
    idAlpha = alpha.id;
    user = { id: u.id, name: u.name, email: u.email, role: u.role, access: await getAccess(u.id, u.role) } as SessionUser;
  }, 120_000);

  afterAll(async () => {
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.userCompanyAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }, 120_000);

  /**
   * LE CONTRAT (§118.20). Les 117 résolveurs rendaient `Hit | { error }` : l'appelant devait
   * PARIER sur la forme avant de savoir ce que la recherche donnerait. Ici les trois clés sont
   * toujours là, sur les VINGT-NEUF objets, y compris ceux que cette personne ne voit pas.
   */
  it("rend TOUJOURS les trois mêmes clés — sur les 29 objets du registre", async () => {
    for (const e of ENTITIES) {
      const r = await resoudreCible(user, e.name, "quelque chose qui n'existe pas");
      expect(Object.keys(r).sort(), e.name).toEqual(["candidats", "cherche", "retenu"]);
      expect(Array.isArray(r.retenu), e.name).toBe(true);
      expect(Array.isArray(r.candidats), e.name).toBe(true);
      expect(r.cherche.entite, e.name).toBe(e.name);
    }
    expect(ENTITES_RESOLVABLES.length).toBe(ENTITIES.length);
  }, 60_000);

  it("une référence exacte DÉSIGNE — et le refus se tait", async () => {
    const r = await resoudreCible(user, "regulatory_dossier", `${TAG}REG-1`);
    expect(r.retenu).toHaveLength(1);
    expect(r.retenu[0]!.titre).toBe(`${TAG}REG-1`);
    expect(r.retenu[0]!.sousTitre).toBe("Nivolex");
    expect(r.candidats).toEqual([]);
    expect(direRefus(r)).toBeNull();
  });

  it("un IDENTIFIANT désigne aussi — un plan enchaîné tient déjà l'id (§118.35)", async () => {
    const r = await resoudreCible(user, "regulatory_dossier", idAlpha);
    expect(r.retenu.map((c) => c.id)).toEqual([idAlpha]);
  });

  it("un nom qui ne correspond qu'à UN dossier le désigne", async () => {
    const r = await resoudreCible(user, "regulatory_dossier", "Nivolex");
    expect(r.retenu).toHaveLength(1);
    expect(r.retenu[0]!.sousTitre).toBe("Nivolex");
  });

  /**
   * ON NE COLLAPSE PAS (§118.34). Deux Trastuzex : choisir le premier modifierait le mauvais
   * dossier en annonçant que c'est fait. Le refus les NOMME, il n'envoie pas chercher.
   */
  it("PLUSIEURS correspondances n'en désignent AUCUNE, et le refus les nomme", async () => {
    const r = await resoudreCible(user, "regulatory_dossier", "Trastuzex");
    expect(r.retenu).toEqual([]);
    expect(r.candidats.length).toBe(2);
    const refus = direRefus(r);
    expect(refus).toContain("Trastuzex alpha");
    expect(refus).toContain("Trastuzex bêta");
    expect(refus).toContain("Précisez");
  });

  it("zéro correspondance dit « dans votre périmètre », pas « n'existe pas »", async () => {
    const r = await resoudreCible(user, "regulatory_dossier", "Zzzzmolécule");
    expect(r.retenu).toEqual([]);
    expect(r.candidats).toEqual([]);
    expect(direRefus(r)).toContain("dans votre périmètre");
  });

  /**
   * LA GARDE QUI COMPTE. Un refus peut révéler autant qu'une réponse : si le résolveur
   * cherchait hors portée, « plusieurs correspondances : REG-9 — Secretol » suffirait à
   * apprendre le portefeuille d'une autre société.
   */
  it("un objet HORS PÉRIMÈTRE n'est ni désigné, ni RÉVÉLÉ par le refus", async () => {
    // Chercher « Secretol » : le refus a le droit de reprendre ce que la personne a tapé — c'est
    // SA phrase. Ce qui serait une fuite, c'est un champ de l'enregistrement qu'elle n'a PAS
    // écrit : sa référence. Un refus peut révéler autant qu'une réponse.
    const parNom = await resoudreCible(user, "regulatory_dossier", "Secretol");
    expect(parNom.retenu).toEqual([]);
    expect(parNom.candidats).toEqual([]);
    expect(direRefus(parNom)).not.toContain("REG-9");

    // Et par sa référence exacte : elle ne désigne rien non plus.
    const parRef = await resoudreCible(user, "regulatory_dossier", `${TAG}REG-9`);
    expect(parRef.retenu).toEqual([]);
    expect(JSON.stringify(parRef.candidats)).not.toContain("Secretol");
  });

  it("un texte vide ne cherche rien, et le dit sans accuser la base", async () => {
    const r = await resoudreCible(user, "regulatory_dossier", "   ");
    expect(r.retenu).toEqual([]);
    expect(direRefus(r)).toContain("Précisez");
  });

  it("un objet inconnu du registre rend la forme stable, pas une exception", async () => {
    const r = await resoudreCible(user, "licorne", "peu importe");
    expect(r.retenu).toEqual([]);
    expect(r.cherche.entite).toBe("licorne");
  });
});
