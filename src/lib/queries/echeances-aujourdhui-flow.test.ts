import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, unstable_cache: (fn: unknown) => fn }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
vi.mock("@/lib/session", () => ({ requireUser: async () => null, requireUserAuNomDeLaVue: async () => null, getUser: async () => null }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { chargerAujourdhui } from "@/lib/queries/aujourdhui-espace";
import { grouperAFaire, type CleGroupe } from "@/lib/espace/a-faire";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ÉCHÉANCES DES MODULES DANS « AUJOURD'HUI » — sur la base, dans la peau des gens (Super Admin, 24/11/2026).
 *
 * Une fin de CDD remonte chez les RH (droit d'écriture RH) et chez le N+1 du salarié à J-30 (« Plus tard »), puis à
 * J-10 dans « Aujourd'hui » ; le Super Admin et le DG ne la voient qu'à moins de 10 jours ou dépassée ; une
 * échéance d'une société qu'on ne voit pas ne parvient pas. Aucune page « échéancier » : ce sont des lignes de la file.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = "__echeances__";
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const JOUR = 86_400_000;
const MAINTENANT = new Date("2026-11-24T09:00:00Z");
const jour = (j: number) => new Date(Date.UTC(2026, 10, 24 + j));
const plus = (j: number) => new Date(MAINTENANT.getTime() + j * JOUR);

suite("échéances intégrées — « Aujourd'hui » de chacun", () => {
  const u: Record<string, string> = {};
  const e: Record<string, string> = {};
  const acteurs: Record<string, SessionUser> = {};
  let A = "", B = "";

  async function nettoyer() {
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.employee.updateMany({ where: { fullName: { startsWith: TAG } }, data: { managerId: null } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    const comptes = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    await prisma.userAccess.deleteMany({ where: { userId: { in: comptes.map((c) => c.id) } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    [A, B] = (await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    const compte = async (k: string, role: SessionUser["role"], companyId: string) => {
      const user = await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } });
      u[k] = user.id;
      e[k] = (await prisma.employee.create({ data: { fullName: `${TAG}${k}`, companyId, userId: user.id } })).id;
    };
    await compte("rh", "COORDINATOR", A); // la RH d'Alpha : droit d'écriture RH donné par la console
    await prisma.userAccess.create({ data: { userId: u.rh, module: "RH", canView: true, canUpdate: true, scope: "ALL" } });
    await compte("n1", "MEDICAL_PROMOTION_MANAGER", A);
    await compte("collegue", "MEDICAL_PROMOTION_MANAGER", A);
    await compte("sa", "SUPER_ADMIN", A);
    await compte("dg", "GENERAL_MANAGER", B);
    for (const k of Object.keys(u)) {
      const role = (await prisma.user.findUniqueOrThrow({ where: { id: u[k] } })).role as SessionUser["role"];
      acteurs[k] = { id: u[k], name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role, secondaryRole: null, access: await getAccess(u[k], role) } as unknown as SessionUser;
    }
    // Les salariés et leurs dates.
    e.cdd = (await prisma.employee.create({ data: { fullName: `${TAG}Samir CDD`, companyId: A, contractType: "CDD", contractEnd: jour(30), managerId: e.n1 } })).id;
    e.essai = (await prisma.employee.create({ data: { fullName: `${TAG}Lina essai`, companyId: A, contractType: "CDI", trialEnd: jour(20), managerId: e.n1 } })).id;
    e.visite = (await prisma.employee.create({ data: { fullName: `${TAG}Karim visite`, companyId: A, contractType: "CDI", prochaineVisiteMedicale: jour(-4) } })).id;
    e.beta = (await prisma.employee.create({ data: { fullName: `${TAG}Nadia Beta`, companyId: B, contractType: "CDD", contractEnd: jour(5) } })).id;
    e.bail = (await prisma.legalDocument.create({ data: { title: `${TAG}Bail Alpha`, kind: "LEASE", companyId: A, createdById: u.collegue, endDate: jour(25) } })).id;
    e.parti = (await prisma.employee.create({ data: { fullName: `${TAG}Omar parti`, companyId: A, contractType: "CDD", contractEnd: jour(3), isActive: false } })).id;
  }, 120_000);

  afterAll(nettoyer);

  /** Le groupe où tombe l'échéance dans « À faire » de cette personne, ou `null` si elle n'y est pas. */
  async function groupe(k: string, source: string, employe: string, maintenant: Date, chapeau = "Ressources humaines"): Promise<CleGroupe | null> {
    const jourLu = await chargerAujourdhui(acteurs[k], { maintenant });
    const objet = `ECHEANCE:${source}:${employe}`;
    const lot = jourLu.lots.find((l) => l.lignes.some((x) => x.objet === objet));
    if (!lot) return null;
    expect(lot.chapeau).toBe(chapeau);
    const cle = `echeance-${source}-${employe}`;
    // La ligne de « À faire » qui la porte : une sous-ligne d'un lot, un morceau d'une seule ligne, ou le lot entier.
    const porte = (l: { key: string; n: number; sousLignes: { key: string }[] }) =>
      l.sousLignes.some((s) => s.key === cle) || l.key.endsWith(`:${cle}`) || (l.key === lot.id && l.n === 1 && lot.lignes[0].key === cle);
    return grouperAFaire(jourLu.lots).groupes.find((x) => x.lignes.some(porte))?.cle ?? null;
  }

  it("fin de CDD à J-30 : chez la RH et chez le N+1, dans « Plus tard » ; ni chez un collègue, ni chez le Super Admin", async () => {
    expect(await groupe("rh", "rh.contrat", e.cdd, MAINTENANT)).toBe("plus-tard");
    expect(await groupe("n1", "rh.contrat", e.cdd, MAINTENANT)).toBe("plus-tard");
    expect(await groupe("collegue", "rh.contrat", e.cdd, MAINTENANT)).toBeNull();
    expect(await groupe("sa", "rh.contrat", e.cdd, MAINTENANT)).toBeNull();
  }, 120_000);

  it("la même à J-10 : elle passe dans « Aujourd'hui » de la RH et du N+1 — et le Super Admin la voit enfin", async () => {
    const j10 = plus(20);
    expect(await groupe("rh", "rh.contrat", e.cdd, j10)).toBe("aujourdhui");
    expect(await groupe("n1", "rh.contrat", e.cdd, j10)).toBe("aujourdhui");
    expect(await groupe("sa", "rh.contrat", e.cdd, j10)).toBe("aujourdhui");
    // Dépassée : en retard, en rouge.
    expect(await groupe("rh", "rh.contrat", e.cdd, plus(32))).toBe("retard");
  }, 120_000);

  it("le Super Admin ne voit que le dépassé et le < 10 jours, toutes sources ; la période d'essai à J-20 ne lui parvient pas", async () => {
    expect(await groupe("sa", "rh.visite", e.visite, MAINTENANT)).toBe("retard");
    expect(await groupe("sa", "rh.essai", e.essai, MAINTENANT)).toBeNull();
    expect(await groupe("rh", "rh.essai", e.essai, MAINTENANT)).toBe("plus-tard");
    expect(await groupe("n1", "rh.essai", e.essai, MAINTENANT)).toBe("plus-tard");
    // La visite de Karim n'a pas de N+1 désigné : la RH la porte.
    expect(await groupe("rh", "rh.visite", e.visite, MAINTENANT)).toBe("retard");
    expect(await groupe("n1", "rh.visite", e.visite, MAINTENANT)).toBeNull();
  }, 120_000);

  it("cloisonnement par société : le DG de Beta voit Beta, pas Alpha ; la RH d'Alpha ne voit pas Beta", async () => {
    expect(await groupe("dg", "rh.contrat", e.beta, MAINTENANT)).toBe("aujourdhui");
    expect(await groupe("dg", "rh.visite", e.visite, MAINTENANT)).toBeNull();
    expect(await groupe("rh", "rh.contrat", e.beta, MAINTENANT)).toBeNull();
    expect(await groupe("sa", "rh.contrat", e.beta, MAINTENANT)).toBe("aujourdhui");
  }, 120_000);

  it("Legal : le bail remonte chez celui qui l'a enregistré à J-30, sous « Legal » ; au Super Admin à J-10 seulement", async () => {
    expect(await groupe("collegue", "legal.document", e.bail, MAINTENANT, "Legal")).toBe("plus-tard");
    expect(await groupe("sa", "legal.document", e.bail, MAINTENANT, "Legal")).toBeNull();
    expect(await groupe("sa", "legal.document", e.bail, plus(16), "Legal")).toBe("aujourdhui");
    expect(await groupe("dg", "legal.document", e.bail, plus(16), "Legal")).toBeNull();
  }, 120_000);

  it("une fiche inactive (le salarié est parti) ne produit plus rien", async () => {
    expect(await groupe("rh", "rh.contrat", e.parti, MAINTENANT)).toBeNull();
    expect(await groupe("sa", "rh.contrat", e.parti, MAINTENANT)).toBeNull();
  }, 120_000);
});
