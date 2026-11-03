import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { foldOrg } from "@/lib/name-match";
import { resolveEntity, resolveMany, entityForRecord } from "./resolve";
import { linkEntitiesForItem, itemsMentioning, ENTITY_LINK_TYPE } from "./link";
import { ALIAS_WEIGHT } from "./contract";
import { contentHash } from "../text";
import { ingestFast } from "../ingest";
import { stageEntities } from "../stages";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RÉSOLVEUR SUR BASE RÉELLE — ce que les tests purs ne peuvent pas prouver.
 *
 * Les alias sont ici INSÉRÉS À LA MAIN, avec exactement la forme que la projection leur donne en
 * lisant l'ERP. C'est délibéré : ce banc éprouve la RÉSOLUTION, pas la lecture des fiches, et
 * fabriquer des produits Regulatory réels pour tester un `WHERE` polluerait une base partagée.
 *
 * Tout ce qui est créé porte le préfixe `ETEST-` et disparaît à la fin.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = "ETEST-";

/** Le couple entité + graphies, écrit comme la projection l'écrit. */
async function seed(
  kind: string,
  canonicalName: string,
  aliases: { alias: string; weight: number }[],
  opts: { companyId?: string | null; refType?: string; refId?: string } = {},
) {
  const nameFold = foldOrg(canonicalName);
  const refType = opts.refType ?? `${TAG}Type`;
  const refId = opts.refId ?? `${TAG}${canonicalName}`;
  const entity = await prisma.knowledgeEntity.create({
    data: {
      key: `${kind}:${refType}:${refId}`,
      kind, refType, refId, canonicalName, nameFold,
      companyId: opts.companyId ?? null,
    },
  });
  await prisma.knowledgeAlias.createMany({
    data: aliases.map((a) => ({
      entityId: entity.id, alias: a.alias, aliasFold: foldOrg(a.alias),
      source: "erp:test", weight: a.weight,
    })),
    skipDuplicates: true,
  });
  return entity;
}

async function cleanup() {
  await prisma.company.deleteMany({ where: { name: { startsWith: `${TAG}société` } } });
  const ents = await prisma.knowledgeEntity.findMany({
    where: { OR: [{ key: { contains: TAG } }, { refId: { startsWith: TAG } }] },
    select: { id: true },
  });
  const ids = ents.map((e) => e.id);
  if (ids.length) {
    await prisma.knowledgeLink.deleteMany({ where: { toType: ENTITY_LINK_TYPE, toId: { in: ids } } });
    await prisma.knowledgeAlias.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.knowledgeEntity.deleteMany({ where: { id: { in: ids } } });
  }
  const items = await prisma.knowledgeItem.findMany({ where: { sourceId: { startsWith: TAG } }, select: { id: true } });
  const itemIds = items.map((i) => i.id);
  if (itemIds.length) {
    await prisma.knowledgeLink.deleteMany({ where: { itemId: { in: itemIds } } });
    await prisma.knowledgeChunk.deleteMany({ where: { itemId: { in: itemIds } } });
    await prisma.knowledgeJob.deleteMany({ where: { itemId: { in: itemIds } } });
    await prisma.knowledgeItem.deleteMany({ where: { id: { in: itemIds } } });
  }
}

beforeAll(async () => {
  await cleanup();
  // LE CAS DE LA MISSION, mot pour mot : un dossier produit porte son nom commercial ET sa DCI.
  // Les deux mènent au MÊME dossier, sans qu'aucun dictionnaire pharmaceutique n'ait été écrit.
  await seed("product", "ETEST-Keytruda", [
    { alias: "ETEST-REG-2026-041", weight: ALIAS_WEIGHT.reference },
    { alias: "ETEST-Keytruda", weight: ALIAS_WEIGHT.commercial },
    { alias: "ETEST-Pembrolizumab", weight: ALIAS_WEIGHT.scientific },
  ]);
  await seed("supplier", "ETEST-Kwality Pharmaceuticals", [
    { alias: "ETEST-Kwality Pharmaceuticals", weight: ALIAS_WEIGHT.canonical },
  ]);
});

afterAll(cleanup);

describe("§10 — une mention, une entité", () => {
  it("le nom commercial et la DCI mènent au MÊME dossier", async () => {
    const byBrand = await resolveEntity("ETEST-Keytruda");
    const byMolecule = await resolveEntity("ETEST-Pembrolizumab");
    expect(byBrand.kind).toBe("decisive");
    expect(byMolecule.kind).toBe("decisive");
    expect(byMolecule.best!.entityId).toBe(byBrand.best!.entityId);
  });

  it("la référence interne résout aussi, et se dit en clair", async () => {
    const r = await resolveEntity("ETEST-REG-2026-041");
    expect(r.kind).toBe("decisive");
    expect(r.best!.canonicalName).toBe("ETEST-Keytruda");
    // La justification NOMME l'alias qui a servi : une résolution muette ne se conteste pas.
    expect(r.best!.why).toContain("désigne");
  });

  it("rattrape une faute de frappe sur un nom assez long", async () => {
    const r = await resolveEntity("ETEST-Kwlaity Pharmaceuticals");
    expect(r.best?.canonicalName).toBe("ETEST-Kwality Pharmaceuticals");
  });

  it("refuse de répondre à une chaîne trop courte pour désigner quoi que ce soit", async () => {
    expect((await resolveEntity("a")).kind).toBe("none");
    expect((await resolveEntity("")).kind).toBe("none");
  });

  it("restreint aux familles demandées", async () => {
    const r = await resolveEntity("ETEST-Keytruda", { kinds: ["supplier"] });
    expect(r.kind).toBe("none");
  });

  it("ne rend qu'UN candidat par entité, même quand trois alias collent", async () => {
    const r = await resolveEntity("ETEST-Keytruda");
    const ids = r.candidates.map((c) => c.entityId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("dédoublonne les mentions répétées au lieu de réinterroger", async () => {
    const m = await resolveMany(["ETEST-Keytruda", "ETEST-KEYTRUDA", "ETEST-keytruda"]);
    expect(m.size).toBe(1);
  });

  it("retrouve l'entité d'une fiche ERP par le chemin inverse", async () => {
    const e = await entityForRecord(`${TAG}Type`, `${TAG}ETEST-Keytruda`);
    expect(e?.canonicalName).toBe("ETEST-Keytruda");
  });
});

describe("cloisonnement", () => {
  it("une entité rattachée à une autre société n'est pas proposée", async () => {
    // La société est À CE BANC : empruntée, c'était souvent celle d'un voisin, retirée en cours de route avec ce qu'elle tient.
    const company = await prisma.company.create({ data: { name: `${TAG}société-${Date.now().toString(36)}` }, select: { id: true } });

    await seed("organization", "ETEST-Cloisonnee", [{ alias: "ETEST-Cloisonnee", weight: 1 }], {
      companyId: company.id,
      refId: `${TAG}cloisonnee`,
    });

    // Vue depuis SA société : visible.
    expect((await resolveEntity("ETEST-Cloisonnee", { companyId: company.id })).kind).toBe("decisive");
    // Vue depuis une autre : absente. Une homonymie ne doit jamais franchir la cloison.
    expect((await resolveEntity("ETEST-Cloisonnee", { companyId: "autre-entite-inexistante" })).kind).toBe("none");
  });

  it("une entité SANS société reste commune au groupe", async () => {
    const r = await resolveEntity("ETEST-Keytruda", { companyId: "n-importe-quelle-entite" });
    expect(r.kind).toBe("decisive");
  });
});

describe("§22 — tisser des liens sans jamais deviner", () => {
  async function ingestText(name: string, text: string) {
    const r = await ingestFast({
      sourceType: "drive_file",
      sourceId: `${TAG}${name}`,
      contentHash: contentHash(text),
      title: name,
      text,
      chunks: [{ kind: "whole" as const, ord: 0, text }],
    });
    return r!.itemId;
  }

  it("écrit une arête vers l'entité citée, avec la mention qui l'a produite", async () => {
    const itemId = await ingestText(
      "contrat",
      "Le présent contrat concerne le dossier ETEST-REG-2026-041 et son approvisionnement.",
    );
    const r = await linkEntitiesForItem(itemId);
    expect(r.written).toBeGreaterThan(0);

    const links = await prisma.knowledgeLink.findMany({ where: { itemId }, select: { predicate: true, mention: true, toType: true } });
    // `mentions` et jamais `concerns` : trouver un nom prouve qu'on en PARLE, pas que le document
    // PORTE dessus. Le prédicat fort viendrait d'un champ structuré, pas d'un texte.
    expect(links[0].predicate).toBe("mentions");
    expect(links[0].toType).toBe(ENTITY_LINK_TYPE);
    expect(links[0].mention).toContain("ETEST-REG-2026-041");
  });

  it("rejouer le tissage ne double pas les arêtes", async () => {
    const itemId = await ingestText("rejeu", "Dossier ETEST-REG-2026-041, seconde lecture.");
    await linkEntitiesForItem(itemId);
    const first = await prisma.knowledgeLink.count({ where: { itemId } });
    await linkEntitiesForItem(itemId);
    expect(await prisma.knowledgeLink.count({ where: { itemId } })).toBe(first);
  });

  it("un document qui ne cite rien de connu n'écrit AUCUNE arête — et ce n'est pas une panne", async () => {
    const itemId = await ingestText("inconnu", "Réunion hebdomadaire, points divers, rien à signaler.");
    const r = await linkEntitiesForItem(itemId);
    expect(r.written).toBe(0);
    // L'étage le déclare quand même terminé : le retenir ferait passer un document sain pour bloqué.
    await stageEntities(itemId);
    const item = await prisma.knowledgeItem.findUnique({ where: { id: itemId }, select: { stage: true } });
    expect(item!.stage).toBe("READY");
  });

  it("répond à « qu'avons-nous sur cette entité ? »", async () => {
    const itemId = await ingestText("retour", "Note interne au sujet de ETEST-REG-2026-041.");
    await linkEntitiesForItem(itemId);
    const target = await resolveEntity("ETEST-Keytruda");
    const items = await itemsMentioning(target.best!.entityId);
    expect(items.some((i) => i.item.sourceId === `${TAG}retour`)).toBe(true);
  });
});
