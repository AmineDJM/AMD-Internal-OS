import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { ENTITIES, getEntity, entityScopeWhere } from "./entities";
import { porteeEntite, MODELES_CLOISONNES } from "./portee";
import { regulatoryVisibleWhere } from "@/lib/queries/regulatory-rows";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PORTE GÉNÉRIQUE NE VOIT JAMAIS PLUS QUE L'ÉCRAN.
 *
 * Ce qui ferait tomber ces essais, nommément : reposer un `entityScopeWhere` nu dans une route
 * générique, ou retirer le cloisonnement par entité de `porteeEntite`. Les deux ont été mesurés
 * ensemble — une chargée rattachée à Alpha lisait le dossier de Beta par l'API.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ROUTES_GENERIQUES = [
  "src/app/api/v1/entities/[entity]/route.ts",
  "src/app/api/v1/entities/[entity]/[id]/route.ts",
  "src/app/api/v1/entities/[entity]/[id]/[aspect]/route.ts",
  "src/app/api/v1/search/route.ts",
  // La route de contenu délègue à ce module (règle unique, testée dans `document-lisible.test.ts`).
  "src/lib/api/registry/document-lisible.ts",
];

describe("architecture — la portée composée est posée AU POINT D'APPEL", () => {
  /**
   * §118.49 : un test qui vérifie le corps d'une fonction sans vérifier son APPELANT ne teste
   * rien. `porteeEntite` peut être parfaite et n'être appelée nulle part.
   */
  it("aucune route générique n'utilise `entityScopeWhere` nu", () => {
    const fautives: string[] = [];
    for (const f of ROUTES_GENERIQUES) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      if (/entityScopeWhere\s*\(/.test(src)) fautives.push(f);
      if (!/porteeEntite\s*\(/.test(src)) fautives.push(`${f} (n'appelle pas porteeEntite)`);
    }
    expect(fautives, `Routes génériques sans portée composée :\n${fautives.join("\n")}`).toEqual([]);
  });

  it("les modèles cloisonnables sont lus DU SCHÉMA, pas d'une liste écrite à la main", () => {
    // Le fait du processus (§118.17) : le DMMF, pas un tableau que le 19ᵉ modèle oublierait.
    const attendus = Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === "companyId" && f.kind === "scalar"))
      .map((m) => m.name);
    expect([...MODELES_CLOISONNES].sort()).toEqual(attendus.sort());
    // Et la garde n'est pas vide : si elle l'était, elle ne protégerait rien en silence.
    expect(MODELES_CLOISONNES.size).toBeGreaterThan(10);
  });

  it("chaque entité du registre dont le modèle porte une entité EST cloisonnée", () => {
    const concernees = ENTITIES.filter((d) => MODELES_CLOISONNES.has(d.model));
    // On mesure la portée réelle du chantier plutôt que de l'affirmer.
    console.info(`[PORTEE] entités cloisonnées : ${concernees.length} / ${ENTITIES.length}`);
    expect(concernees.length).toBeGreaterThan(10);
  });
});

const TAG = "__portee__";
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

suite("la porte générique rend EXACTEMENT ce que rend l'écran", () => {
  let user: SessionUser;

  beforeAll(async () => {
    const [a, b] = await Promise.all([
      prisma.company.create({ data: { name: `${TAG}Alpha` } }),
      prisma.company.create({ data: { name: `${TAG}Beta` } }),
    ]);
    const u = await prisma.user.create({
      data: {
        name: `${TAG}amel`, email: `${TAG}amel@t.dz`, role: "HEAD_OF_REGULATORY", passwordHash: "x",
        // Rattachée à Alpha, et à elle seule — ce que fait l'Administration.
        companyAccess: { create: [{ companyId: a.id, canEdit: true }] },
      },
    });
    await Promise.all([
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}A-1`, dci: "Alphamol", companyId: a.id } }),
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}B-1`, dci: "Betamol", companyId: b.id } }),
      // UNE SECONDE ENTITÉ, qui ne partage RIEN avec la première (§118.21) : un courrier n'a
      // ni verrou de pipeline, ni filtre de gamme — seul le cloisonnement le sépare.
      prisma.mailEntry.create({ data: { title: `${TAG}Pli Alpha`, direction: "INCOMING", companyId: a.id } }),
      prisma.mailEntry.create({ data: { title: `${TAG}Pli Beta`, direction: "INCOMING", companyId: b.id } }),
    ]);
    user = { id: u.id, name: u.name, email: u.email, role: u.role, access: await getAccess(u.id, u.role) } as SessionUser;
  }, 120_000);

  afterAll(async () => {
    await prisma.mailEntry.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.userCompanyAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }, 120_000);

  it("REGULATORY — l'API ne montre pas le dossier d'une société qui ne la regarde pas", async () => {
    const def = getEntity("regulatory_dossier")!;
    const [ecran, api] = await Promise.all([
      prisma.regulatoryProduct.findMany({
        where: { AND: [await regulatoryVisibleWhere(user), { reference: { startsWith: TAG } }] },
        select: { reference: true },
      }),
      prisma.regulatoryProduct.findMany({
        where: { AND: [await porteeEntite(user, def), { reference: { startsWith: TAG } }] },
        select: { reference: true },
      }),
    ]);
    expect(api.map((r) => r.reference).sort()).toEqual(ecran.map((r) => r.reference).sort());
    expect(api.map((r) => r.reference)).toEqual([`${TAG}A-1`]);
  });

  it("COURRIERS — la même règle sur une entité qui ne partage rien avec la première", async () => {
    const def = getEntity("mail_entry")!;
    const api = await prisma.mailEntry.findMany({
      where: { AND: [await porteeEntite(user, def), { title: { startsWith: TAG } }] },
      select: { title: true },
    });
    expect(api.map((r) => r.title)).toEqual([`${TAG}Pli Alpha`]);
  });

  /**
   * LE SABOTAGE. Sans lui, on ne saurait pas nommer le cas qui ferait tomber les deux essais
   * ci-dessus — donc ce ne seraient pas des assertions (§118.17). La portée NUE doit voir les
   * deux sociétés : c'est exactement le défaut mesuré, et c'est ce que la composition ferme.
   */
  it("la portée NUE, elle, voyait bien les deux sociétés — c'est le défaut qu'on ferme", async () => {
    const def = getEntity("mail_entry")!;
    const nue = await prisma.mailEntry.findMany({
      where: { AND: [entityScopeWhere(user, def), { title: { startsWith: TAG } }] },
      select: { title: true },
    });
    expect(nue.map((r) => r.title).sort()).toEqual([`${TAG}Pli Alpha`, `${TAG}Pli Beta`]);
  });
});
