import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * D2 (décision 0057) — LE BANC DE L'ACCÈS PAR BASE, contre la base locale : les gestes de la console (vraies actions),
 * leur annulation (K10), le garde-fou anti-verrouillage, et les attaques (employé qui s'ouvre une base, droit expiré,
 * Super Admin qui se ferme lui-même la console).
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { annulerGeste } from "@/lib/effets/annulation";
import { poserReglageBase, reglerPropresDonneesBase, revoquerReglageBase } from "@/modules/acces-bases/actions";
import { niveauPour, propresDonnees, quiVoitLaBase, reglagesVivants } from "@/modules/acces-bases/api";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zd2base${Date.now()}`;
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
const jour = (decalage = 0) => new Date(Date.now() + decalage * 86_400_000).toISOString().slice(0, 10);
const comme = async (id: string, role: CurrentUser["role"]): Promise<CurrentUser> =>
  ({ id, name: `${TAG} ${role}`, email: `${TAG}${role}@t.dz`, role, secondaryRole: null, access: await getAccess(id, role), mustChangePassword: false }) as unknown as CurrentUser;

let sa: CurrentUser;
let employe: CurrentUser;

suite("D2 — accès par base : réglages, annulation, garde-fous, attaques", () => {
  beforeAll(async () => {
    const a = await prisma.user.create({ data: { name: `${TAG} Admin`, email: `${TAG}a@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    const e = await prisma.user.create({ data: { name: `${TAG} Radia`, email: `${TAG}e@t.dz`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } });
    sa = await comme(a.id, "SUPER_ADMIN");
    employe = await comme(e.id, "DIRECTION_ASSISTANT");
  }, 60_000);

  afterAll(async () => {
    await prisma.accesBase.deleteMany({ where: { motif: { contains: TAG } } });
    await prisma.accesBaseParametre.deleteMany({ where: { base: "budgets" } });
    const ids = [sa.id, employe.id];
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: ids } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it("ATTAQUE — un employé ne s'ouvre pas une base (ni la paie, ni rien)", async () => {
    ACTOR = employe;
    const r = await poserReglageBase(fd({ base: "paie", userId: employe.id, niveau: "OUVERTE", du: jour(), motif: `Je m'ouvre la paie ${TAG}` }));
    expect(r.ok).toBe(false);
    expect((await revoquerReglageBase("x")).ok).toBe(false);
    expect((await reglerPropresDonneesBase("paie", false)).ok).toBe(false);
    expect(await prisma.accesBase.count({ where: { motif: { contains: TAG } } })).toBe(0);
  });

  it("motif et date obligatoires ; une cible, pas deux", async () => {
    ACTOR = sa;
    expect((await poserReglageBase(fd({ base: "paie", userId: employe.id, niveau: "FERMEE", du: jour(), motif: "" }))).ok).toBe(false);
    expect((await poserReglageBase(fd({ base: "paie", userId: employe.id, niveau: "FERMEE", motif: `Audit ${TAG}` }))).ok).toBe(false);
    expect((await poserReglageBase(fd({ base: "paie", userId: employe.id, role: "VIEWER", niveau: "FERMEE", du: jour(), motif: `Audit ${TAG}` }))).ok).toBe(false);
    expect((await poserReglageBase(fd({ base: "inconnue", userId: employe.id, niveau: "FERMEE", du: jour(), motif: `Audit ${TAG}` }))).ok).toBe(false);
  });

  it("poser une ouverture nominative : en vigueur, journalisée, visible dans « qui voit » ; l'annulation la retire", async () => {
    ACTOR = sa;
    const r = await poserReglageBase(fd({ base: "paie", userId: employe.id, niveau: "OUVERTE", du: jour(), au: jour(30), motif: `Audit de paie ${TAG}` }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const l = await reglagesVivants();
    expect(niveauPour({ userId: employe.id, roles: [employe.role] }, "paie", l, new Date())).toMatchObject({ niveau: "OUVERTE", source: "personne" });
    const ligne = (await quiVoitLaBase("paie"))!.find((x) => x.userId === employe.id)!;
    expect(ligne).toMatchObject({ lecture: true, ecriture: false, niveau: "OUVERTE" });
    expect(await prisma.auditLog.count({ where: { actorId: sa.id, module: "Accès par base", summary: { contains: TAG } } })).toBe(1);

    const geste = (r as { annulable?: { gesteId: string } }).annulable?.gesteId;
    expect(geste).toBeTruthy();
    const annule = await annulerGeste(geste!, sa);
    expect("refus" in annule, JSON.stringify(annule)).toBe(false);
    expect(await prisma.accesBase.count({ where: { userId: employe.id, motif: { contains: TAG } } })).toBe(0);
  });

  it("ATTAQUE — un droit expiré n'ouvre plus rien", async () => {
    ACTOR = sa;
    expect((await poserReglageBase(fd({ base: "paie", userId: employe.id, niveau: "OUVERTE", du: jour(-10), au: jour(-3), motif: `Ancien audit ${TAG}` }))).ok).toBe(true);
    expect(niveauPour({ userId: employe.id, roles: [employe.role] }, "paie", await reglagesVivants(), new Date()).niveau).toBe("NORMAL");
    expect((await quiVoitLaBase("paie"))!.find((x) => x.userId === employe.id)!.lecture).toBe(false);
  });

  it("révoquer : le réglage cesse, reste au journal ; l'annulation le rétablit", async () => {
    ACTOR = sa;
    expect((await poserReglageBase(fd({ base: "budgets", role: "DIRECTION_ASSISTANT", niveau: "LECTURE_SEULE", du: jour(), motif: `Gel des budgets ${TAG}` }))).ok).toBe(true);
    const r = await prisma.accesBase.findFirstOrThrow({ where: { base: "budgets", motif: { contains: TAG } } });
    const rev = await revoquerReglageBase(r.id);
    expect(rev.ok).toBe(true);
    expect((await prisma.accesBase.findUniqueOrThrow({ where: { id: r.id } })).revoqueLe).toBeTruthy();
    expect((await revoquerReglageBase(r.id)).ok).toBe(false);
    const annule = await annulerGeste((rev as { annulable?: { gesteId: string } }).annulable!.gesteId, sa);
    expect("refus" in annule, JSON.stringify(annule)).toBe(false);
    expect((await prisma.accesBase.findUniqueOrThrow({ where: { id: r.id } })).revoqueLe).toBeNull();
  });

  it("ses propres données : réglable par base, défaut oui pour Paie, non pour Budgets", async () => {
    ACTOR = sa;
    expect((await propresDonnees()).paie).toBe(true);
    expect((await propresDonnees()).budgets).toBe(false);
    const r = await reglerPropresDonneesBase("budgets", true);
    expect(r.ok).toBe(true);
    expect((await propresDonnees()).budgets).toBe(true);
    const annule = await annulerGeste((r as { annulable?: { gesteId: string } }).annulable!.gesteId, sa);
    expect("refus" in annule, JSON.stringify(annule)).toBe(false);
    expect((await propresDonnees()).budgets).toBe(false);
  });

  it("ATTAQUE — un réglage qui touche un Super Admin exige une confirmation ; la console ne se ferme jamais à TOUS les Super Admins", async () => {
    ACTOR = sa;
    // Sans confirmation : refusé, et la console le dit.
    const sansConfirmation = await poserReglageBase(fd({ base: "paie", userId: sa.id, niveau: "FERMEE", du: jour(), motif: `Je me ferme la paie ${TAG}` }));
    expect(sansConfirmation).toMatchObject({ ok: false, confirmation: true });
    // Confirmé : appliqué (aucune exception, la Direction l'a voulu).
    expect((await poserReglageBase(fd({ base: "paie", userId: sa.id, niveau: "FERMEE", du: jour(), motif: `Je me ferme la paie ${TAG}`, confirmeSuperAdmin: "oui" }))).ok).toBe(true);
    // Fermer « Comptes & droits » (la console) au RÔLE Super Admin : plus aucun Super Admin ne la garderait — refusé, même confirmé.
    for (const niveau of ["FERMEE", "LECTURE_SEULE"]) {
      const r = await poserReglageBase(fd({ base: "comptes-et-droits", role: "SUPER_ADMIN", niveau, du: jour(1), motif: `Gel ${TAG}`, confirmeSuperAdmin: "oui" }));
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/dernier Super Admin/);
    }
    expect(await prisma.accesBase.count({ where: { base: "comptes-et-droits", motif: { contains: TAG } } })).toBe(0);
  });
});
