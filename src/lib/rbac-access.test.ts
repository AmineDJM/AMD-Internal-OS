import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "./rbac";

// Sonde DB ; suite sautée proprement sans base (CI sans Postgres).
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__accesstest__";

suite("getAccess — un override ne rétrécit pas une portée native ALL (rôle principal ou secondaire)", () => {
  let plainId = "", overriddenId = "", primaryOnlyId = "", nsPrimaryId = "", nsStaleId = "";

  beforeAll(async () => {
    const mk = (s: string, data: Record<string, unknown>) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, passwordHash: "x", ...data } as never });
    const [a, b, c, d, e] = await Promise.all([
      // Le cas rapporté : délégué avec « autre rôle » National Sales, sans override.
      mk("plain", { role: "MEDICAL_DELEGATE", secondaryRole: "NATIONAL_SALES" }),
      // Pire cas : même profil MAIS un ancien « accès personnalisé » ASSIGNED posé
      // du temps où le compte était simple délégué.
      mk("overr", { role: "MEDICAL_DELEGATE", secondaryRole: "NATIONAL_SALES" }),
      // Témoin : délégué SANS rôle secondaire + override — le contrat « l'override
      // prime sur le rôle principal » doit rester intact (défaut délégué = ASSIGNED).
      mk("primonly", { role: "MEDICAL_DELEGATE" }),
      // Le bug « des fois ça ne s'affiche pas » : National Sales EN RÔLE PRINCIPAL dont
      // l'accès aux congrès a été « personnalisé » (override ASSIGNED) → il ne voyait
      // plus les demandes à pré-valider. Sa portée native est ALL, l'override ne doit
      // pas la rétrécir silencieusement.
      mk("nsprim", { role: "NATIONAL_SALES" }),
      // Rôle réel = National Sales, SANS override : sert à prouver que getAccess prend le
      // rôle EN DIRECT de la base même si on lui passe un indice de rôle PÉRIMÉ (JWT).
      mk("nsstale", { role: "NATIONAL_SALES" }),
    ]);
    plainId = a.id; overriddenId = b.id; primaryOnlyId = c.id; nsPrimaryId = d.id; nsStaleId = e.id;

    await prisma.userAccess.createMany({
      data: [
        { userId: overriddenId, module: "CONGRESS_INTERNATIONAL", canView: true, canCreate: true, scope: "ASSIGNED" },
        { userId: primaryOnlyId, module: "CONGRESS_INTERNATIONAL", canView: true, canCreate: true, scope: "ASSIGNED" },
        { userId: nsPrimaryId, module: "CONGRESS_INTERNATIONAL", canView: true, canCreate: true, scope: "ASSIGNED" },
      ],
    });
  });

  afterAll(async () => {
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("sans override : portée ALL sur les congrès + accès Sponsoring hérités du rôle secondaire", async () => {
    const a = await getAccess(plainId, "MEDICAL_DELEGATE");
    expect(a.secondaryRole).toBe("NATIONAL_SALES");
    expect(a.modules.get("CONGRESS_INTERNATIONAL")?.scope).toBe("ALL"); // il voit TOUTES les demandes à pré-valider
    expect(a.modules.get("CONGRESS_NATIONAL")?.scope).toBe("ALL");
    // Le délégué seul n'a pas SPONSORING ; le National Sales secondaire l'ouvre.
    expect(a.modules.get("SPONSORING")?.actions.has("CREATE")).toBe(true);
    expect(a.modules.get("SPONSORING")?.scope).toBe("ALL");
  });

  it("un ancien override ASSIGNED ne neutralise PAS le rôle secondaire (portée élargie à ALL)", async () => {
    const a = await getAccess(overriddenId, "MEDICAL_DELEGATE");
    const m = a.modules.get("CONGRESS_INTERNATIONAL");
    expect(m?.scope).toBe("ALL"); // ← le bug corrigé : l'override clampait à ASSIGNED
    expect(m?.actions.has("VIEW")).toBe(true);
    expect(m?.actions.has("CREATE")).toBe(true); // conservé de l'override
  });

  it("témoin : sans rôle secondaire, l'override garde la main sur le rôle principal (ASSIGNED)", async () => {
    const a = await getAccess(primaryOnlyId, "MEDICAL_DELEGATE");
    expect(a.modules.get("CONGRESS_INTERNATIONAL")?.scope).toBe("ASSIGNED");
  });

  it("National Sales en rôle PRINCIPAL : un override ASSIGNED ne rétrécit pas sa portée native ALL", async () => {
    const a = await getAccess(nsPrimaryId, "NATIONAL_SALES");
    const m = a.modules.get("CONGRESS_INTERNATIONAL");
    expect(m?.scope).toBe("ALL"); // ← il revoit TOUTES les demandes à pré-valider
    expect(m?.actions.has("VIEW")).toBe(true);
    expect(m?.actions.has("CREATE")).toBe(true); // conservé de l'override
  });

  it("le rôle est résolu EN DIRECT depuis la base : un indice de rôle PÉRIMÉ (JWT) est ignoré", async () => {
    // Compte RÉELLEMENT National Sales en base ; on simule un JWT périmé en passant
    // l'ancien rôle « MEDICAL_DELEGATE » comme indice. getAccess doit prendre le rôle RÉEL
    // → c'est ce qui rend l'écran du National Sales fidèle (préliminaire Ad & Pro visible,
    // libellé « National Sales », accès enveloppes par rôle) sans le forcer à se reconnecter.
    const a = await getAccess(nsStaleId, "MEDICAL_DELEGATE");
    expect(a.role).toBe("NATIONAL_SALES");
    // Preuve fonctionnelle : SPONSORING (Ad & Pro) — absent du délégué — est ouvert par le rôle réel.
    expect(a.modules.has("SPONSORING")).toBe(true);
    expect(a.modules.get("SPONSORING")?.scope).toBe("ALL");
  });
});
