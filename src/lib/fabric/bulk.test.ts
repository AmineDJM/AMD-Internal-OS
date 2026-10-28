import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { creerLoteur } from "@/lib/fabric/bulk";
import { indexDriveNodeText } from "@/lib/assistant/document-discovery";
import { POWER_TOOLS } from "@/lib/assistant/power-tools";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE LOTEUR DE LECTURES (fabric F6) — N logiques → K physiques, MESURÉ, et branché.
 *
 * Deux familles : le MÉCANISME (rassemblement par microtâche, dédoublonnage, découpage,
 * pas de cache entre tours, erreurs propagées) et le BRANCHEMENT RÉEL — `find_documents`
 * hydrate ses candidats par le loteur, et sa couverture DIT la mesure : si quelqu'un
 * revient aux `findUnique` à la pièce, le test de mesure tombe.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

describe("fabric/bulk — le mécanisme (sans base)", () => {
  it("dix demandes d'un même tour partent en UNE requête — et la mesure le dit", async () => {
    const vus: string[][] = [];
    const loteur = creerLoteur<number>(async (ids) => {
      vus.push([...ids]);
      return new Map(ids.map((id) => [id, Number(id)]));
    });
    const resultats = await Promise.all(
      Array.from({ length: 10 }, (_, i) => loteur.charger(String(i))),
    );
    expect(resultats).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(vus).toHaveLength(1);
    expect(loteur.mesure()).toEqual({ logiques: 10, physiques: 1, lots: 1 });
  });

  it("un identifiant demandé deux fois dans le même tour n'est chargé qu'une fois", async () => {
    const vus: string[][] = [];
    const loteur = creerLoteur<string>(async (ids) => {
      vus.push([...ids]);
      return new Map(ids.map((id) => [id, `v-${id}`]));
    });
    const [a, b] = await Promise.all([loteur.charger("x"), loteur.charger("x")]);
    expect(a).toBe("v-x");
    expect(b).toBe("v-x");
    expect(vus).toEqual([["x"]]);
    expect(loteur.mesure().logiques).toBe(2);
  });

  it("au-delà de tailleMax, le lot se DÉCOUPE — jamais un IN de dix mille éléments", async () => {
    const loteur = creerLoteur<number>(
      async (ids) => new Map(ids.map((id) => [id, 1])),
      { tailleMax: 100 },
    );
    await Promise.all(Array.from({ length: 250 }, (_, i) => loteur.charger(String(i))));
    expect(loteur.mesure()).toEqual({ logiques: 250, physiques: 3, lots: 1 });
  });

  it("PAS un cache : deux tours différents refont deux lectures — la fraîcheur ne se négocie pas ici", async () => {
    let physiques = 0;
    const loteur = creerLoteur<number>(async (ids) => {
      physiques += 1;
      return new Map(ids.map((id) => [id, physiques]));
    });
    expect(await loteur.charger("a")).toBe(1);
    expect(await loteur.charger("a")).toBe(2);
  });

  it("un identifiant absent rend null ; une erreur du chargeur se PROPAGE à toutes les attentes", async () => {
    const ok = creerLoteur<number>(async () => new Map());
    expect(await ok.charger("inconnu")).toBeNull();

    const casse = creerLoteur<number>(async () => { throw new Error("panne"); });
    const attentes = [casse.charger("a"), casse.charger("b")];
    await expect(attentes[0]).rejects.toThrow("panne");
    await expect(attentes[1]).rejects.toThrow("panne");
  });
});

function userWith(perms: Partial<Record<Module, Action[]>>, role: CurrentUser["role"], id: string): CurrentUser {
  const modules = new Map(
    Object.entries(perms).map(([m, actions]) => [
      m as Module,
      { module: m as Module, actions: new Set(actions as Action[]), scope: "ALL" as const },
    ]),
  );
  return {
    id, name: "PDG", email: `${id}@t.dz`, role,
    access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

const TAG = `__fablot_${Date.now().toString(36)}`;

suite("fabric/bulk — branché dans find_documents (le vrai point d'entrée, §14)", () => {
  let ownerId = "";
  const noeuds: string[] = [];

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { name: `${TAG}o`, email: `${TAG}o@t.dz`, passwordHash: "x", role: "DIRECTION" },
    });
    ownerId = owner.id;
    // Huit documents portant le même terme rare : la recherche rendra HUIT candidats.
    for (let i = 0; i < 8; i += 1) {
      const n = await prisma.driveNode.create({
        data: { name: `${TAG}_doc${i}.txt`, type: "FILE", ownerId, size: 10 },
        select: { id: true },
      });
      noeuds.push(n.id);
      await indexDriveNodeText(n.id, "v1", `note numero ${i} sur le sujet ${TAG}terme partage.`, null, `${TAG}_doc${i}.txt`);
    }
  }, 60_000);

  afterAll(async () => {
    await prisma.entityMention.deleteMany({ where: { nodeId: { in: noeuds } } }).catch(() => {});
    await prisma.driveTextIndex.deleteMany({ where: { nodeId: { in: noeuds } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { id: { in: noeuds } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("MESURE — huit candidats hydratés en UNE requête, et la couverture le DIT", async () => {
    const tool = POWER_TOOLS.find((t) => t.def.name === "find_documents")!;
    const out = JSON.parse(await tool.run(
      { query: `${TAG}terme`, max_reads: 0 },
      userWith({ DRIVE: ["VIEW"] }, "DIRECTION", ownerId),
    ));
    const ids = (out.resultats as { driveNodeId: string }[]).map((r) => r.driveNodeId);
    for (const n of noeuds) expect(ids).toContain(n);
    // La mesure logique/physique de CETTE recherche, dite dans la couverture. Revenir aux
    // findUnique à la pièce ferait disparaître (ou exploser) ce chiffre — c'est le sabotage.
    expect(out.couverture.hydratation).toMatch(/^8 candidat\(s\) hydratés en 1 requête\(s\)/);
  });
});
