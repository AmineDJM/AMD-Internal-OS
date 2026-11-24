import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE REGISTRE DES AVANTAGES AUX PROFESSIONNELS DE SANTÉ — sur la base réelle (Super Admin seul, 24/11/2026).
 *
 *  • une prise en charge achetée (BC n°1 : billet acheté, hôtel dans le BC, inscription validée pas encore en BC, un poste
 *    seulement chiffré) + un sponsoring en partie réglé → les totaux payé / engagé non payé de chaque professionnel ;
 *  • une fiche absorbée par une fusion remonte à sa survivante ; un homonyme reste une autre ligne ; un nom libre (prise en
 *    charge, sponsoring) va aux « non rattachés » avec son nom ; une personne écartée et une demande refusée ne comptent pas ;
 *  • la Direction et le Directeur général sont refusés (lecture et page), le Super Admin lit ;
 *  • le cloisonnement société : chaque société ne montre que ses avantages.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

class Redirection extends Error {
  constructor(readonly vers: string) { super(`redirect ${vers}`); }
}
vi.mock("next/navigation", () => ({
  redirect: (vers: string) => { throw new Redirection(vers); },
  notFound: () => { throw new Error("notFound"); },
  useRouter: () => ({ push: () => {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: { id: string; name: string; email: string; role: string; access: Record<string, unknown>; mustChangePassword: boolean } | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, requireModule: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { registreAvantages } from "./avantages";
import { CLE_NON_RATTACHES, FILTRES_AVANTAGES_VIDES } from "@/modules/ad-pro/partage";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const RUN = `__avant${Date.now().toString(36)}`;
const ROLES = { sa: "SUPER_ADMIN", dir: "DIRECTION", dg: "GENERAL_MANAGER", kam: "MEDICAL_DELEGATE" } as const;
type Qui = keyof typeof ROLES;

suite("Registre des avantages aux professionnels de santé (base réelle)", () => {
  const u = {} as Record<Qui, string>;
  const S = { a: "", b: "" };
  const D = { d1: "", d2: "", d3: "" };
  let pecId = "";
  const spo: string[] = [];
  const ordres: string[] = [];
  const acteur = (qui: Qui) => ({ id: u[qui], name: qui, email: `${RUN}${qui}@t.dz`, role: ROLES[qui], access: {}, mustChangePassword: false });

  beforeAll(async () => {
    const cles = Object.keys(ROLES) as Qui[];
    const comptes = await Promise.all(cles.map((k) => prisma.user.create({ data: { name: `${RUN}${k}`, email: `${RUN}${k}@t.dz`, role: ROLES[k], passwordHash: "x" } })));
    cles.forEach((k, i) => { u[k] = comptes[i]!.id; });
    S.a = (await prisma.company.create({ data: { name: `${RUN} Alpha`, shortName: `${RUN}A`.slice(-12) } })).id;
    S.b = (await prisma.company.create({ data: { name: `${RUN} Beta`, shortName: `${RUN}B`.slice(-12) } })).id;

    // d1 et d3 sont HOMONYMES (deux fiches) ; d2 a été FUSIONNÉE dans d1 (archivée, ses prises en charge restent sur elle).
    const doc = (o: Record<string, unknown> = {}) => prisma.medicalDoctor.create({ data: { name: `${RUN} Dr Amrani`, specialty: "Cardiologie", wilaya: "Alger", institution: "CHU Mustapha", companyId: S.a, ...o }, select: { id: true } }).then((d) => d.id);
    D.d1 = await doc();
    D.d2 = await doc({ archivedAt: new Date(), name: `${RUN} Dr Amrani (doublon)` });
    D.d3 = await doc({ wilaya: "Oran", specialty: "Oncologie" });
    await prisma.decisionFusionMedecin.create({ data: { cle: `${RUN}|fusion`, medecinAId: D.d2, medecinBId: D.d1, decision: "FUSIONNEE", empreinte: "x", gardeId: D.d1, decideParId: u.sa } });

    // ── Une prise en charge (société A) au circuit d'achat par BC ──
    pecId = (await prisma.congressNational.create({
      data: { name: `${RUN} Diabétologie`, requesterId: u.kam, requestStatus: "APPROVED", companyId: S.a, date: new Date("2026-05-10T08:00:00Z"), circuitAchatAt: new Date() },
      select: { id: true },
    })).id;
    const bc = await prisma.carePecBc.create({ data: { congressNationalId: pecId, numero: 1, fournisseur: "Agence Voyages" }, select: { id: true } });
    const benef = (o: Record<string, unknown>) => prisma.careBeneficiary.create({ data: { congressNationalId: pecId, status: "APPROVED", ...o }, select: { id: true } }).then((b) => b.id);
    const cellule = (beneficiaryId: string, serviceKind: "TICKET" | "HOTEL" | "REGISTRATION" | "OTHER", o: Record<string, unknown> = {}) =>
      prisma.careCell.create({ data: { beneficiaryId, kind: "SERVICE", serviceKind, label: serviceKind, ...o }, select: { id: true } }).then((c) => c.id);
    const ligne = (cellId: string, statut: "ACTIVE" | "ACHETEE", montantDzd: number, montantAchatDzd?: number) =>
      prisma.carePecBcLigne.create({ data: { bcId: bc.id, cellId, libelle: "ligne", montantDzd, montantAchatDzd, statut } });

    const b1 = await benef({ doctorId: D.d1 });
    await ligne(await cellule(b1, "TICKET", { label: "Billet Alger → Oran", amountDzd: 82_000, montantValideDzd: 80_000 }), "ACHETEE", 80_000, 82_000);
    await ligne(await cellule(b1, "HOTEL", { label: "Hôtel 2 nuits", amountDzd: 40_000, montantValideDzd: 40_000 }), "ACTIVE", 40_000);
    await cellule(b1, "REGISTRATION", { label: "Inscription", amountDzd: 15_000, montantValideDzd: 15_000 });
    await cellule(b1, "OTHER", { label: "Dîner (chiffré seulement)", amountDzd: 5_000 });
    const b2 = await benef({ doctorId: D.d2 });
    await ligne(await cellule(b2, "TICKET", { label: "Billet (fiche absorbée)", montantValideDzd: 60_000 }), "ACHETEE", 60_000);
    const bLibre = await benef({ firstName: "Pr", lastName: `${RUN}Libre` });
    await ligne(await cellule(bLibre, "HOTEL", { label: "Hôtel", montantValideDzd: 30_000 }), "ACHETEE", 30_000);
    const bEcarte = await benef({ doctorId: D.d3, status: "REJECTED" });
    await ligne(await cellule(bEcarte, "TICKET", { label: "Billet écarté" }), "ACHETEE", 70_000);

    // ── Un sponsoring (société B) : accordé 200 000, réglé 100 000 ; d1 nommé pour 100 000, d3 sans part ──
    const ordrePaye = await prisma.expenseOrder.create({ data: { reference: `${RUN}-OD1`, label: "Sponsoring", amount: 100_000, status: "PAID", companyId: S.b }, select: { id: true } });
    ordres.push(ordrePaye.id);
    const s1 = await prisma.sponsoringRequest.create({ data: { reference: `${RUN}-SPO1`, institution: "Société de cardiologie", type: "Congrès", requestDate: new Date("2026-04-01T09:00:00Z"), status: "PRE_VALIDATED", companyId: S.b, requesterId: u.kam }, select: { id: true } });
    spo.push(s1.id);
    await prisma.adProItem.create({ data: { sponsoringId: s1.id, label: "Appui", status: "APPROVED", amountGranted: 200_000, expenseOrderId: ordrePaye.id } });
    await prisma.adProMedecin.create({ data: { entityType: "SPONSORING", entityId: s1.id, doctorId: D.d1, montant: 100_000, createdById: u.kam } });
    await prisma.adProMedecin.create({ data: { entityType: "SPONSORING", entityId: s1.id, doctorId: D.d3, createdById: u.kam } });

    // Un sponsoring REFUSÉ (A) : rien d'accordé. Un sponsoring à médecin en TEXTE LIBRE (A) : non rattaché, engagé non payé.
    const s2 = await prisma.sponsoringRequest.create({ data: { reference: `${RUN}-SPO2`, institution: "Refusée", type: "Don", requestDate: new Date("2026-04-02T09:00:00Z"), status: "REFUSED", companyId: S.a }, select: { id: true } });
    spo.push(s2.id);
    await prisma.adProItem.create({ data: { sponsoringId: s2.id, label: "Appui", status: "APPROVED", amountGranted: 999_000 } });
    await prisma.adProMedecin.create({ data: { entityType: "SPONSORING", entityId: s2.id, doctorId: D.d1, montant: 999_000, createdById: u.kam } });
    const s3 = await prisma.sponsoringRequest.create({ data: { reference: `${RUN}-SPO3`, institution: "Service de cardiologie", type: "Matériel", doctor: `Dr ${RUN}Texte`, requestDate: new Date("2026-07-01T09:00:00Z"), status: "PRE_VALIDATED", companyId: S.a }, select: { id: true } });
    spo.push(s3.id);
    await prisma.adProItem.create({ data: { sponsoringId: s3.id, label: "Appui", status: "APPROVED", amountGranted: 50_000 } });
  }, 60_000);

  afterAll(async () => {
    ACTOR = null;
    await prisma.adProMedecin.deleteMany({ where: { entityId: { in: spo } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: { in: spo } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    if (pecId) await prisma.congressNational.delete({ where: { id: pecId } }).catch(() => {});
    await prisma.decisionFusionMedecin.deleteMany({ where: { cle: `${RUN}|fusion` } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { id: { in: Object.values(D).filter(Boolean) } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: Object.values(S).filter(Boolean) } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: Object.values(u).filter(Boolean) } } }).catch(() => {});
  }, 60_000);

  const tout2026 = { ...FILTRES_AVANTAGES_VIDES, annee: 2026 };

  it("la Direction et le Directeur général sont refusés : rien n'est lu, la page les renvoie", async () => {
    for (const qui of ["dir", "dg"] as const) {
      expect(await registreAvantages(acteur(qui), tout2026)).toBeNull();
      ACTOR = acteur(qui);
      const { default: Page } = await import("@/app/(app)/admin/avantages/page");
      let vers: string | null = null;
      try { await Page({ searchParams: Promise.resolve({}) }); } catch (e) { if (e instanceof Redirection) vers = e.vers; else throw e; }
      expect(vers).toBe("/dashboard?denied=ADMIN");
    }
  });

  it("le Super Admin lit : prise en charge achetée + sponsoring → payé et engagé non payé exacts, fusion et homonyme respectés", async () => {
    ACTOR = acteur("sa");
    // Le banc compile le JSX en mode classique : la page du Super Admin, elle, va jusqu'au rendu.
    vi.stubGlobal("React", await import("react"));
    const { default: Page } = await import("@/app/(app)/admin/avantages/page");
    await expect(Page({ searchParams: Promise.resolve({ annee: "2026" }) })).resolves.toBeTruthy();

    const v = (await registreAvantages(acteur("sa"), tout2026))!;
    expect(v).not.toBeNull();
    const d1 = v.registre.lignes.find((l) => l.cle === D.d1)!;
    // PEC : billet acheté 82 000 (achat réel) + billet de la fiche absorbée 60 000 → payé 142 000 ; sponsoring : 100 000 × ½ réglé = 50 000.
    // Engagé non payé : hôtel dans le BC 40 000 + inscription validée 15 000 + reste du sponsoring 50 000. Le dîner seulement chiffré ne compte pas.
    expect(d1).toMatchObject({ nombre: 5, payeDzd: 192_000, resteDzd: 105_000, specialite: "Cardiologie", wilaya: "Alger" });
    expect(v.registre.lignes.some((l) => l.cle === D.d2)).toBe(false);
    // L'homonyme reste sa propre ligne : le sponsoring le nomme sans part (compté, sans montant) ; sa prise en charge écartée ne compte pas.
    const d3 = v.registre.lignes.find((l) => l.cle === D.d3)!;
    expect(d3).toMatchObject({ nombre: 1, payeDzd: 0, resteDzd: 0, sansMontant: 1 });
    // Les noms libres : la prise en charge « Pr …Libre » et le sponsoring « Dr …Texte » — jamais perdus.
    const libres = v.registre.lignes.find((l) => l.cle === CLE_NON_RATTACHES)!;
    expect(libres.noms).toEqual(expect.arrayContaining([`Pr ${RUN}Libre`, `Dr ${RUN}Texte`]));
    expect(v.societes.map((s) => s.id)).toEqual(expect.arrayContaining([S.a, S.b]));
  });

  it("cloisonnement société : chaque société ne montre que ses avantages, la fiche aussi", async () => {
    const a = (await registreAvantages(acteur("sa"), { ...tout2026, societeId: S.a }, D.d1))!;
    const d1a = a.registre.lignes.find((l) => l.cle === D.d1)!;
    expect(d1a).toMatchObject({ nombre: 4, payeDzd: 142_000, resteDzd: 55_000 });
    expect(a.registre.lignes.some((l) => l.cle === D.d3)).toBe(false);
    const libresA = a.registre.lignes.find((l) => l.cle === CLE_NON_RATTACHES)!;
    expect(libresA).toMatchObject({ payeDzd: 30_000, resteDzd: 50_000 });
    expect(libresA.noms).toEqual([`Dr ${RUN}Texte`, `Pr ${RUN}Libre`]);
    // Une société qui n'est que la nôtre : le total ne contient que ces lignes.
    expect(a.registre.payeDzd).toBe(172_000);
    expect(a.registre.resteDzd).toBe(105_000);

    // La fiche de d1 dans la société A : 4 avantages de prise en charge, liés à la demande, BC n°1.
    expect(a.fiche).not.toBeNull();
    const chrono = a.fiche!.fiche.chronologie;
    expect(chrono).toHaveLength(4);
    expect(chrono.every((x) => x.href === `/congress-national/${pecId}` && x.societeId === S.a && x.demandeur === `${RUN}kam`)).toBe(true);
    expect(chrono.filter((x) => x.reference === "BC n°1")).toHaveLength(3);
    expect(a.fiche!.fiche.parNature.map((n) => [n.nature, n.payeDzd, n.resteDzd])).toEqual([
      ["PEC_BILLET", 142_000, 0], ["PEC_HOTEL", 0, 40_000], ["PEC_INSCRIPTION", 0, 15_000],
    ]);
    expect(a.fiche!.fiche.parAnnee).toEqual([{ annee: 2026, nombre: 4, payeDzd: 142_000, resteDzd: 55_000 }]);

    const b = (await registreAvantages(acteur("sa"), { ...tout2026, societeId: S.b }))!;
    expect(b.registre.lignes.find((l) => l.cle === D.d1)).toMatchObject({ nombre: 1, payeDzd: 50_000, resteDzd: 50_000 });
    expect(b.registre.payeDzd).toBe(50_000);
    expect(b.registre.lignes.some((l) => l.cle === CLE_NON_RATTACHES)).toBe(false);

    // Une autre année : rien de ce banc.
    const avant = (await registreAvantages(acteur("sa"), { ...FILTRES_AVANTAGES_VIDES, annee: 2025, societeId: S.a }))!;
    expect(avant.registre.nombre).toBe(0);
  });
});
