import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { annulerGeste } from "@/lib/effets/annulation";
import { voixDuTerrain } from "@/lib/voix-terrain-luna";
import { classerLibelles, type DependancesNatures } from "@/lib/natures-depenses-ia";
import { finaliserNatures } from "@/lib/general-means/expense-lines";
import { NATURES_PAR_DEFAUT, type CategorieConnue } from "@/lib/general-means/natures";
import { fusionnerMedecinsEnDouble } from "@/lib/actions/medical-directory-crud-actions";
import { controlerCles, instantaneFinances, lireSignaux, lireTauxAcceptation, noterDecision, noterProposition, REFUS_SIGNAUX } from "@/modules/pilotage/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT « MÉMOIRE » — par les VRAIS points d'entrée, sur la base locale, IA COUPÉE (le chemin déterministe) :
 *   • la Voix du terrain calculée deux jours de suite garde LES DEUX (plus de purge) et écrit ses signaux datés ;
 *   • l'instantané quotidien des finances rattache chaque ligne à SA société, et un rejeu ne double rien ;
 *   • une proposition d'IA écartée est gardée avec son refus ; une proposition reprise est dite acceptée ;
 *   • la fusion de deux fiches médecin repointe le graphe d'influence (et l'annulation le rend) ; le contrôle des clés
 *     repointe ce qu'une fusion d'AVANT avait laissé, sans rien effacer ;
 *   • les signaux ne se lisent qu'en Super Admin.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zmemoire${Date.now()}`;
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
let sa: CurrentUser;
let socA = ""; let socB = ""; let buId = "";

suite("lot « mémoire » — les signaux datés", () => {
  beforeAll(async () => {
    remplacerLecteurInterrupteurIaPourTests(async () => true); // IA COUPÉE : rien ne part chez un fournisseur.
    const u = await prisma.user.create({ data: { name: `${TAG} SA`, email: `${TAG}@banc.dz`, passwordHash: "x", role: "SUPER_ADMIN" as never } });
    sa = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", access: await getAccess(u.id, "SUPER_ADMIN" as never) } as unknown as CurrentUser;
    ACTOR = sa;
    socA = (await prisma.company.create({ data: { name: `${TAG} Adventum`, shortName: "A" } })).id;
    socB = (await prisma.company.create({ data: { name: `${TAG} Pharmagène`, shortName: "B" } })).id;
    buId = (await prisma.businessUnit.create({ data: { name: `${TAG} BU Cardio`, companyId: socA } })).id;
  });

  afterAll(async () => {
    remplacerLecteurInterrupteurIaPourTests(null);
    await prisma.signalDate.deleteMany({ where: { OR: [{ companyId: { in: [socA, socB] } }, { auteurId: sa.id }, { cle: { contains: buId } }, { source: "controle_cles" }] } });
    await prisma.voixTerrainCache.deleteMany({ where: { cle: { contains: buId } } });
    await prisma.expenseOrder.deleteMany({ where: { label: { startsWith: TAG } } });
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.decisionFusionMedecin.deleteMany({ where: { decideParId: sa.id } });
    await prisma.medicalDoctor.deleteMany({ where: { name: { contains: TAG } } });
    await prisma.businessUnit.deleteMany({ where: { id: buId } });
    await prisma.company.deleteMany({ where: { id: { in: [socA, socB] } } });
    await retirerComptesEtSemis({ where: { email: `${TAG}@banc.dz` } });
  });

  it("la Voix du terrain, deux jours de suite : les deux jours restent, et chacun a ses signaux datés (BU, société)", async () => {
    const perimetre = `mkt:bu:${buId}`;
    const rapports = [
      { id: `${TAG}r1`, texte: "Le Dr trouve le produit trop cher : objection sur le prix en pharmacie.", delegateId: null },
      { id: `${TAG}r2`, texte: "Rupture de stock signalée à la pharmacie de l'hôpital depuis deux semaines.", delegateId: null },
    ];
    const j1 = new Date("2026-11-20T09:00:00Z");
    const j2 = new Date("2026-11-21T09:00:00Z");
    const v1 = await voixDuTerrain({ perimetre, jours: 30, rapports, userId: null, maintenant: j1 });
    const v2 = await voixDuTerrain({ perimetre, jours: 30, rapports, userId: null, maintenant: j2 });
    expect(v1.parLuna).toBe(false);
    expect(v2.groupes.map((g) => g.categorie)).toEqual(expect.arrayContaining(["OBJECTION", "APPROVISIONNEMENT"]));
    // PLUS DE PURGE : le calcul du 20 est toujours là le 21.
    expect((await prisma.voixTerrainCache.findMany({ where: { cle: { startsWith: `${perimetre}|30j|` } }, select: { jour: true }, orderBy: { jour: "asc" } })).map((c) => c.jour))
      .toEqual(["2026-11-20", "2026-11-21"]);
    const signaux = await prisma.signalDate.findMany({ where: { source: "voix_terrain", cle: `perimetre:${perimetre}|30j` }, orderBy: [{ jour: "asc" }, { nature: "asc" }] });
    expect([...new Set(signaux.map((s) => s.jour))]).toEqual(["2026-11-20", "2026-11-21"]);
    const objection = signaux.find((s) => s.jour === "2026-11-21" && s.nature === "OBJECTION");
    expect(objection).toMatchObject({ buId, companyId: socA, valeur: 1, producteur: "repli", statut: "CONSTATE" });
    // Rouvrir le cockpit le même jour : le cache sert, aucune ligne de plus.
    const avant = await prisma.signalDate.count({ where: { source: "voix_terrain", cle: `perimetre:${perimetre}|30j` } });
    await voixDuTerrain({ perimetre, jours: 30, rapports, userId: null, maintenant: j2 });
    expect(await prisma.signalDate.count({ where: { source: "voix_terrain", cle: `perimetre:${perimetre}|30j` } })).toBe(avant);
  }, 60_000);

  it("l'instantané des finances : la santé de chaque enveloppe et les justificatifs manquants, chacun à SA société ; rejoué, rien ne double", async () => {
    const envA = await prisma.budgetEnvelope.create({ data: {
      name: `${TAG} Ops A`, companyId: socA, modules: ["FINANCES"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 1_000_000,
      categories: { create: [{ name: `${TAG} Frais`, module: "FINANCES", allocated: 1_000_000 }] },
    } });
    const envB = await prisma.budgetEnvelope.create({ data: {
      name: `${TAG} Ops B`, companyId: socB, modules: ["FINANCES"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 500_000,
    } });
    const ordre = await prisma.expenseOrder.create({ data: {
      reference: `${TAG}OD1`, label: `${TAG} Imprimerie`, amount: 120_000, category: "AUTRE", status: "PENDING", centralStatus: "APPROVED",
      companyId: socA, requestedById: sa.id, requiresInvoice: true,
    } });
    const maintenant = new Date("2026-11-24T08:00:00Z");
    const b = await instantaneFinances(maintenant);
    expect(b.lignes).toBeGreaterThan(0);
    const lire = () => prisma.signalDate.findMany({ where: { source: "finances", jour: "2026-11-24", companyId: { in: [socA, socB] } } });
    const lignes = await lire();
    expect(lignes.find((l) => l.nature === "sante_budget" && l.budgetEnvelopeId === envA.id)).toMatchObject({ companyId: socA, gravite: expect.any(String) });
    expect(lignes.find((l) => l.nature === "sante_budget" && l.budgetEnvelopeId === envB.id)?.companyId).toBe(socB);
    expect(lignes.find((l) => l.nature === "justificatif_manquant" && l.entiteId === ordre.id)).toMatchObject({ companyId: socA, valeur: 120_000, entiteType: "ExpenseOrder" });
    expect(lignes.find((l) => l.nature === "resume" && l.companyId === socA)?.valeur).toBeGreaterThanOrEqual(1);
    await instantaneFinances(maintenant);
    expect((await lire()).length).toBe(lignes.length);
  }, 90_000);

  it("une proposition d'IA écartée est gardée avec son refus ; une proposition reprise est dite acceptée", async () => {
    const cats: CategorieConnue[] = NATURES_PAR_DEFAUT.map((n, i) => ({ id: `${TAG}c${i}`, nom: n.nom, cle: n.cle }));
    const coupee: DependancesNatures = {
      coupee: async () => true, fonctionActive: async () => true, configure: () => true, cle: () => null,
      appeler: async () => { throw new Error("aucun appel attendu"); }, journaliser: async () => {},
    };
    const ligne = (label: string, budgetCategoryId: string | null) => ({ articleId: null, label, quantity: 1, amount: 1000, budgetCategoryId });
    // 1. « Taxi » : proposé « Transport » ; la personne enregistre une autre catégorie → REJETE.
    const p1 = await classerLibelles({ libelles: ["Taxi"], categories: cats, userId: sa.id, montree: true }, coupee);
    const propose = p1.propositions[0] && "categorieId" in p1.propositions[0] ? p1.propositions[0].categorieId : "";
    expect(propose).toBeTruthy();
    const autre = cats.find((c) => c.id !== propose)!.id;
    await finaliserNatures([ligne("Taxi", autre)] as never, { userId: sa.id, classer: false });
    const refusee = await prisma.signalDate.findFirstOrThrow({ where: { source: "nature_depense", auteurId: sa.id, charge: { path: ["propose", "Taxi"], equals: propose } } });
    expect(refusee).toMatchObject({ statut: "REJETE", producteur: "repli", decideParId: sa.id, retenu: { Taxi: autre } });
    expect(refusee.decideLe).toBeTruthy();
    // 2. « Javel » : proposé et gardé tel quel → ACCEPTE.
    const p2 = await classerLibelles({ libelles: ["Javel"], categories: cats, userId: sa.id, montree: true }, coupee);
    const garde = (p2.propositions[0] as { categorieId: string }).categorieId;
    await finaliserNatures([ligne("Javel", garde)] as never, { userId: sa.id, classer: false });
    expect((await prisma.signalDate.findFirstOrThrow({ where: { source: "nature_depense", auteurId: sa.id, charge: { path: ["propose", "Javel"], equals: garde } } })).statut).toBe("ACCEPTE");
    // 3. Un geste sans proposition ouverte n'écrit rien ; une proposition rejouée le même jour ne double pas.
    expect(await noterDecision({ source: "nature_depense", nature: "natures", auteurId: sa.id, retenu: { X: "y" }, decideurId: sa.id })).toBeNull();
    const id1 = await noterProposition({ source: "kpi", nature: "cibles", auteurId: sa.id, propose: { "Visites/jour": 6 }, producteur: "ia" });
    const id2 = await noterProposition({ source: "kpi", nature: "cibles", auteurId: sa.id, propose: { "Visites/jour": 6 }, producteur: "ia" });
    expect(id1).toBeTruthy();
    expect(id2).toBe(id1);
    expect(await noterDecision({ source: "kpi", nature: "cibles", auteurId: sa.id, retenu: { "Visites/jour": 8 }, decideurId: sa.id })).toBe("REJETE");
    const taux = await lireTauxAcceptation(sa);
    expect(taux.ok && taux.taux.find((t) => t.source === "nature_depense")?.acceptees).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("la fusion de deux fiches médecin repointe le graphe d'influence ; l'annulation le rend tel quel", async () => {
    const a = await prisma.medicalDoctor.create({ data: { name: `Samir HADDAD ${TAG}`, phone: "0551 44 55 66", wilaya: "Oran" } });
    const b = await prisma.medicalDoctor.create({ data: { name: `Dr HADDAD Samir ${TAG}`, email: "s.haddad@exemple.dz", wilaya: "Oran" } });
    const x = await prisma.medicalDoctor.create({ data: { name: `Nadia KACI ${TAG}`, wilaya: "Alger" } });
    const lien = (from: string, to: string, type: string, statut = "PROPOSEE") => prisma.praticienRelation.create({ data: { fromDoctorId: from, toDoctorId: to, type, source: "LUNA", statut } });
    const decide = await prisma.praticienRelation.create({ data: { fromDoctorId: b.id, toDoctorId: x.id, type: "SUIT_AVIS", source: "LUNA", statut: "CONFIRMEE", decideParId: sa.id, decideLe: new Date() } });
    const doublon = await lien(a.id, x.id, "SUIT_AVIS");
    const deplace = await lien(x.id, b.id, "ELEVE_DE");
    const boucle = await lien(b.id, a.id, "COMITE");

    const r = await fusionnerMedecinsEnDouble(fd({ gardeId: a.id, absorbeId: b.id }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await prisma.praticienRelation.count({ where: { OR: [{ fromDoctorId: b.id }, { toDoctorId: b.id }] } })).toBe(0);
    expect(await prisma.praticienRelation.findUniqueOrThrow({ where: { id: deplace.id } })).toMatchObject({ fromDoctorId: x.id, toDoctorId: a.id });
    // Le lien que la gardée portait déjà REPREND la décision humaine prise sur le lien absorbé.
    expect(await prisma.praticienRelation.findUniqueOrThrow({ where: { id: doublon.id } })).toMatchObject({ statut: "CONFIRMEE", decideParId: sa.id });
    expect(await prisma.praticienRelation.findUnique({ where: { id: decide.id } })).toBeNull();
    expect(await prisma.praticienRelation.findUnique({ where: { id: boucle.id } })).toBeNull();
    // La relation Prisma (L4) : la fiche gardée voit ses liens.
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: a.id }, select: { influenceRecue: { select: { id: true } } } })).influenceRecue.map((l) => l.id)).toEqual([deplace.id]);

    const g = (r as { annulable?: { gesteId?: string } }).annulable?.gesteId;
    expect(g).toBeTruthy();
    const annule = await annulerGeste(g!, sa);
    expect("refus" in annule ? annule.refus : "ok").toBe("ok");
    expect(await prisma.praticienRelation.findUniqueOrThrow({ where: { id: decide.id } })).toMatchObject({ fromDoctorId: b.id, statut: "CONFIRMEE" });
    expect(await prisma.praticienRelation.findUniqueOrThrow({ where: { id: doublon.id } })).toMatchObject({ statut: "PROPOSEE" });
    expect(await prisma.praticienRelation.findUniqueOrThrow({ where: { id: deplace.id } })).toMatchObject({ toDoctorId: b.id });
    expect(await prisma.praticienRelation.findUnique({ where: { id: boucle.id } })).not.toBeNull();
  }, 90_000);

  it("le contrôle des clés : une fusion d'AVANT ce lot a laissé un lien sur la fiche absorbée — compté, puis repointé, rien d'effacé", async () => {
    const c = await prisma.medicalDoctor.create({ data: { name: `Garde ${TAG}` } });
    const d = await prisma.medicalDoctor.create({ data: { name: `Absorbee ${TAG}`, archivedAt: new Date() } });
    const y = await prisma.medicalDoctor.create({ data: { name: `Autre ${TAG}` } });
    await prisma.decisionFusionMedecin.create({ data: { cle: `${TAG}|${c.id}|${d.id}`, medecinAId: c.id, medecinBId: d.id, decision: "FUSIONNEE", empreinte: "x", gardeId: c.id, decideParId: sa.id } });
    const reste = await prisma.praticienRelation.create({ data: { fromDoctorId: d.id, toDoctorId: y.id, type: "SUIT_AVIS", source: "LUNA" } });
    const boucle = await prisma.praticienRelation.create({ data: { fromDoctorId: c.id, toDoctorId: d.id, type: "COMITE", source: "LUNA" } });

    const lu = await controlerCles({ corriger: false });
    expect(lu.liensSurFicheAbsorbee).toBeGreaterThanOrEqual(2);
    expect(lu.bouclesSignalees).toBeGreaterThanOrEqual(1);
    expect((await prisma.praticienRelation.findUniqueOrThrow({ where: { id: reste.id } })).fromDoctorId).toBe(d.id);

    const corrige = await controlerCles({ corriger: true });
    expect(corrige.liensRepointes).toBeGreaterThanOrEqual(1);
    expect((await prisma.praticienRelation.findUniqueOrThrow({ where: { id: reste.id } })).fromDoctorId).toBe(c.id);
    // La boucle n'est PAS effacée par le contrôle : elle est signalée.
    expect(await prisma.praticienRelation.findUnique({ where: { id: boucle.id } })).not.toBeNull();
    expect((await prisma.signalDate.findFirstOrThrow({ where: { source: "controle_cles", nature: "influence_boucle_apres_fusion", jour: corrige.jour } })).valeur).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("les signaux ne se lisent qu'en Super Admin (rôle principal)", async () => {
    const refus = await lireSignaux({ role: "DIRECTION" }, { source: "voix_terrain" });
    expect(refus).toEqual({ ok: false, error: REFUS_SIGNAUX });
    expect(await lireTauxAcceptation({ role: "FINANCE_MANAGER" })).toEqual({ ok: false, error: REFUS_SIGNAUX });
    const lu = await lireSignaux(sa, { source: "voix_terrain", buId });
    expect(lu.ok && lu.lignes.length).toBeGreaterThan(0);
  });
});
