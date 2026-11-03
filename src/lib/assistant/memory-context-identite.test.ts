import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { typedMemoryContext } from "./memory-context";

/**
 * S1 bis (décision 0048 §6 bis) — côté Adam : la même table de mémoire, la même règle. Un souvenir qui dirait qui est la
 * personne (« Prénom : Amine », retenu avant la garde) n'entre pas dans le contexte ; le reste, si.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__adamident_${Date.now().toString(36)}_`;
let userId = "";

suite("Adam — la mémoire relue ne dit jamais qui est la personne", () => {
  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { name: `${TAG}Radia`, email: `${TAG}r@t.dz`, passwordHash: "x", role: "SALES_USER" as never } })).id;
    await prisma.assistantMemoryItem.createMany({ data: [
      { userId, type: "USER_PREFERENCE", content: "Prénom : Amine", origine: "auto", confidence: 0.8 },
      { userId, type: "USER_PREFERENCE", content: "Aime les synthèses courtes", origine: "manuel", confidence: 1 },
    ] });
  });
  afterAll(async () => {
    await prisma.assistantMemoryItem.deleteMany({ where: { userId } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("le souvenir d'identité est écarté, le reste est servi", async () => {
    const ctx = await typedMemoryContext(userId);
    expect(ctx).toContain("synthèses courtes");
    expect(ctx).not.toMatch(/Amine/);
  });
});
