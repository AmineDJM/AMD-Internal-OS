import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { getEnvelopes, getBudgetOverview } from "./budget";

// Sonde DB ; suite sautée proprement sans base (CI sans Postgres).
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__budshare__";

/**
 * Le cas rapporté : « j'ai donné l'accès au budget Ad & Pro à Assia / Yacine mais ils
 * n'ont pas vraiment accès ni à ses catégories ». Reproduction : un compte SANS rôle
 * budgétaire, ajouté nommément (`accessUserIds`) à une enveloppe « Ad & Pro » qui N'EST PAS
 * l'enveloppe active la plus récente de toute la base. La vue PAR DÉFAUT de /budgets doit
 * tomber sur SON enveloppe (Ad & Pro) — et non sur l'enveloppe globale la plus récente
 * (qui lui est fermée), sinon l'écran affiche « aucune enveloppe » alors qu'il y a accès.
 */
suite("Budget partagé nommément : la vue par défaut tombe sur l'enveloppe VISIBLE", () => {
  let userId = "", adproId = "", otherId = "";
  const viewer = (): SessionUser => ({ id: userId, role: "MEDICAL_DELEGATE", access: { modules: new Map(), rowGrants: {} } as never });

  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG}assia`, email: `${TAG}assia@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } as never,
    });
    userId = u.id;

    // Enveloppe « Ad & Pro » PARTAGÉE nommément avec le compte — période plus ANCIENNE.
    const adpro = await prisma.budgetEnvelope.create({
      data: {
        name: `${TAG}Ad & Pro`,
        modules: ["SPONSORING"],
        accessUserIds: [userId],
        periodStart: new Date("2990-01-01"),
        periodEnd: new Date("2990-12-31"),
        totalAmount: 1000,
        isActive: true,
        categories: { create: [{ name: `${TAG}Congrès`, module: "SPONSORING", allocated: 400 }] },
      },
      select: { id: true },
    });
    adproId = adpro.id;

    // Enveloppe la PLUS RÉCENTE de la base, FERMÉE à ce compte : sur l'ancienne logique,
    // la vue par défaut tombait dessus → non visible → « aucune enveloppe ».
    const other = await prisma.budgetEnvelope.create({
      data: {
        name: `${TAG}Promotion médicale`,
        modules: ["MEDICAL"],
        periodStart: new Date("2999-01-01"),
        periodEnd: new Date("2999-12-31"),
        totalAmount: 2000,
        isActive: true,
      },
      select: { id: true },
    });
    otherId = other.id;
  });

  afterAll(async () => {
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("getAccess ouvre le module Budget (accès implicite via l'enveloppe partagée)", async () => {
    const a = await getAccess(userId, "MEDICAL_DELEGATE");
    expect(a.modules.has("BUDGETS")).toBe(true);
    expect(a.modules.get("BUDGETS")?.actions.has("VIEW")).toBe(true);
  });

  it("getEnvelopes ne liste QUE l'enveloppe ouverte au compte (Ad & Pro)", async () => {
    const list = await getEnvelopes(viewer());
    const ids = list.map((e) => e.id);
    expect(ids).toContain(adproId);
    expect(ids).not.toContain(otherId); // l'enveloppe fermée reste invisible
  });

  it("vue PAR DÉFAUT (aucun env) : on obtient l'enveloppe Ad & Pro AVEC ses catégories", async () => {
    // ← Le bug corrigé : l'ancienne logique renvoyait `null` (enveloppe globale la plus
    //   récente non visible), d'où l'écran « aucune enveloppe ne vous est ouverte ».
    const ov = await getBudgetOverview(viewer(), null);
    expect(ov).not.toBeNull();
    expect(ov?.envelope.id).toBe(adproId);
    expect(ov?.categories.length).toBeGreaterThan(0);
    expect(ov?.categories.some((c) => c.name === `${TAG}Congrès`)).toBe(true);
  });

  it("enveloppe explicitement demandée : visible ⇒ servie ; fermée ⇒ refusée (garde-fou)", async () => {
    const ok = await getBudgetOverview(viewer(), adproId);
    expect(ok?.envelope.id).toBe(adproId);
    const denied = await getBudgetOverview(viewer(), otherId);
    expect(denied).toBeNull(); // même explicitement, une enveloppe fermée reste refusée
  });
});
