import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { navigationFor } from "@/lib/nav-access";
import type { NavItem } from "@/lib/labels";
import { ouvreLeCentreDeValidations } from "@/lib/validations/centre";
import { siegeAuCentreAdPro } from "@/modules/ad-pro/partage";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__modconf__";
const MIGRATIONS = [
  "prisma/migrations/20270246200000_modules_configurables/migration.sql",
  // La clé « Impôts & cotisations » (24/11/2026) recopie à son tour les accès de FINANCES.
  "prisma/migrations/20270247400000_impots_cotisations/migration.sql",
];

async function acteur(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role, secondaryRole: u.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

const destinations = (items: NavItem[]): string[] => items.flatMap((i) => [i.href, ...destinations(i.children ?? [])]);

/** Les instructions d'un script SQL — un `;` à l'intérieur d'un bloc `DO $$ … $$` ne coupe pas. */
function instructions(sql: string): string[] {
  const out: string[] = [];
  let courant = "";
  let dansBloc = false;
  for (const morceau of sql.split(/(\$\$|;)/)) {
    if (morceau === "$$") dansBloc = !dansBloc;
    if (morceau === ";" && !dansBloc) { out.push(courant.trim()); courant = ""; continue; }
    courant += morceau;
  }
  out.push(courant.trim());
  return out.filter(Boolean);
}

/** Les migrations TELLES QU'ELLES PARTENT EN PRODUCTION — lues dans leur fichier, instruction par instruction (idempotentes). */
async function jouerLaMigration() {
  for (const migration of MIGRATIONS) {
    const sql = readFileSync(join(process.cwd(), migration), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const instruction of instructions(sql)) await prisma.$executeRawUnsafe(instruction);
  }
}

const ligne = (userId: string, module: string, p: Partial<Record<"canView" | "canCreate" | "canUpdate" | "canDelete" | "canValidate" | "canExport", boolean>>) =>
  prisma.userAccess.create({ data: { userId, module, canView: true, scope: "ALL", ...p } });

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CONSOLE RÈGLE TOUT MODULE AFFICHÉ — dans la peau des gens, sur la base (Super Admin, 24/11/2026).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("modules configurables — la migration, le menu et les centres", () => {
  const u: Record<string, string> = {};

  beforeAll(async () => {
    await nettoyer();
    const mk = async (k: string, role: SessionUser["role"], secondaryRole: SessionUser["role"] | null = null) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, secondaryRole, passwordHash: "x" } })).id;
    };
    await mk("fbmBloque", "FINANCE_BUDGET_MANAGER");
    await mk("dirLecture", "DIRECTION");
    await mk("coordPaie", "COORDINATOR");
    await mk("viewerCentre", "VIEWER");
    await mk("pmDgSecond", "PRODUCT_MANAGER", "GENERAL_MANAGER");
    await mk("fbmSansDoublons", "FINANCE_BUDGET_MANAGER");
    await mk("assistanteCentre", "REGULATORY_ASSISTANT");
    await mk("dgBloque", "GENERAL_MANAGER");

    // Les réglages de console d'AVANT le déploiement.
    await ligne(u.fbmBloque, "FINANCES", { canView: false });
    await ligne(u.dirLecture, "FINANCES", { canExport: true });
    await ligne(u.coordPaie, "RH", { canUpdate: true });
    await ligne(u.viewerCentre, "VALIDATION_CENTRE", {});
    await jouerLaMigration();
    await jouerLaMigration(); // idempotente : la rejouer ne change rien

    // Les réglages d'APRÈS : la console règle chaque écran.
    await ligne(u.fbmSansDoublons, "FINANCES_DOUBLONS", { canView: false });
    await ligne(u.assistanteCentre, "VALIDATION_CENTRE", {});
    await ligne(u.dgBloque, "VALIDATION_CENTRE", { canView: false });
  }, 120_000);

  afterAll(nettoyer);

  async function nettoyer() {
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } });
  }

  it("la migration reproduit un BLOCAGE de FINANCES sur les trois écrans — rien ne s'ouvre, le groupe disparaît du menu", async () => {
    const lignes = await prisma.userAccess.findMany({ where: { userId: u.fbmBloque }, orderBy: { module: "asc" } });
    expect(lignes.map((l) => [l.module, l.canView])).toEqual([
      ["FINANCES", false], ["FINANCES_BANQUE", false], ["FINANCES_COMPTABILITE", false], ["FINANCES_DOUBLONS", false], ["FINANCES_IMPOTS", false],
    ]);
    const a = await acteur(u.fbmBloque);
    for (const m of ["FINANCES_BANQUE", "FINANCES_COMPTABILITE", "FINANCES_DOUBLONS", "FINANCES_IMPOTS"] as const) expect(userCan(a, m, "VIEW"), m).toBe(false);
    expect(destinations(await navigationFor(a)).filter((d) => d.startsWith("/finances"))).toEqual([]);
  });

  it("un accès personnalisé de FINANCES est recopié à l'identique ; la vue globale garde « examiner » les doublons", async () => {
    const a = await acteur(u.dirLecture);
    expect(userCan(a, "FINANCES_BANQUE", "VIEW")).toBe(true);
    expect(userCan(a, "FINANCES_BANQUE", "UPDATE"), "lecture seule hier, lecture seule aujourd'hui").toBe(false);
    expect(userCan(a, "FINANCES_COMPTABILITE", "EXPORT")).toBe(true);
    // Hier : la Direction examinait par la vue globale même sans « Modifier » sur FINANCES.
    expect(userCan(a, "FINANCES_DOUBLONS", "UPDATE")).toBe(true);
  });

  it("la paie reste ouverte à qui MODIFIAIT les RH par la console, sans rôle qui l'ouvre", async () => {
    const a = await acteur(u.coordPaie);
    expect(userCan(a, "RH", "UPDATE")).toBe(true);
    expect(userCan(a, "PAIE", "VIEW")).toBe(true);
    expect(destinations(await navigationFor(a))).toContain("/rh/paie");
  });

  it("un accès coché qui n'ouvrait rien hier (centre de validations hors DG) est bloqué — personne ne gagne le centre", async () => {
    expect(ouvreLeCentreDeValidations(await acteur(u.viewerCentre))).toBe(false);
    // Un DG porté en « autre rôle » n'ouvrait pas le centre (rôle principal exigé) : la migration le bloque ; il garde le
    // centre Ad & Pro, qu'il tenait déjà par son autre rôle.
    const pm = await acteur(u.pmDgSecond);
    expect(ouvreLeCentreDeValidations(pm)).toBe(false);
    expect(siegeAuCentreAdPro(pm)).toBe(true);
  });

  it("BLOQUÉ sur Doublons de factures : il ne voit plus Doublons, il voit toujours Banque & paiements et la Comptabilité", async () => {
    const a = await acteur(u.fbmSansDoublons);
    const finances = (await navigationFor(a)).find((i) => i.label === "Finances");
    expect(finances?.children?.map((c) => c.href)).toEqual(["/finances/paiements-a-faire", "/finances/comptabilite", "/finances/impots-cotisations"]);
    expect(finances?.href).toBe("/finances/paiements-a-faire");
  });

  it("un utilisateur SANS rôle de direction à qui la console donne le Centre de validations l'ouvre réellement", async () => {
    const a = await acteur(u.assistanteCentre);
    expect(ouvreLeCentreDeValidations(a)).toBe(true);
    expect(destinations(await navigationFor(a))).toContain("/centre-de-validations");
  });

  it("un Directeur Général BLOQUÉ sur le Centre de validations ne l'ouvre plus, et ne le voit plus au menu", async () => {
    const a = await acteur(u.dgBloque);
    expect(ouvreLeCentreDeValidations(a)).toBe(false);
    expect(destinations(await navigationFor(a))).not.toContain("/centre-de-validations");
  });
});
