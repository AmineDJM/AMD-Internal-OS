import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { emettreDocumentDrive, type DemandeDocument } from "@/platform/ia/artifact/factory";
import { createLegalDocument, updateLegalDocument } from "@/lib/actions/legal-actions";
import { emettreAvoir } from "@/lib/actions/fabrique-actions";
import { etatTvaDesFactures, periodeDeLaFacture, tvaAPayerDuMois, tvaDuMois } from "./api";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA TVA DES FACTURES, DE BOUT EN BOUT (lot « tva », Super Admin 24/11/2026).
 *
 * Par les VRAIS points d'entrée : la fabrique émet une facture (TVA collectée enregistrée d'office, par taux), le
 * formulaire Legal enregistre une facture d'achat (TVA déductible saisie, cohérence jugée au serveur), une facture
 * d'avant le lot reste « à compléter » — listée, jamais comptée — jusqu'à ce qu'on la complète, et `tvaDuMois` ne lit
 * que la société qu'on lui nomme.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `__tva__${Date.now()}`;
const ANNEE = new Date().getUTCFullYear();
const PERIODE = `${ANNEE}-09`;
let sa: CurrentUser;
let fin: CurrentUser;
let societeA = "";
let societeB = "";
let partie = "";
const docsCrees: string[] = [];

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, secondaryRole: null, access: await getAccess(id, role), mustChangePassword: false };
}

async function societe(nom: string): Promise<string> {
  const id = (await prisma.company.create({ data: { name: `${TAG} ${nom}`, shortName: `${nom}${Date.now()}`.slice(0, 12), color: "#1B7F79" } })).id;
  await prisma.companyLegalIdentity.create({
    data: {
      companyId: id, legalName: `${TAG} ${nom} SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
      nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
      bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Amine Djouamai", managerTitle: "Gérant",
    },
  });
  return id;
}

/** Le formulaire Legal d'une facture, tel que l'écran l'envoie (champs de la TVA compris). */
function formulaireFacture(champs: Record<string, string>): FormData {
  const fd = new FormData();
  const base = { title: `${TAG} Facture fournisseur`, kind: "INVOICE", counterpartyIds: partie, direction: "OUT", startDate: `${PERIODE}-12`, tvaSaisie: "1" };
  for (const [k, v] of Object.entries({ ...base, ...champs })) fd.set(k, v);
  return fd;
}

/** La facture créée par le formulaire : rattachée à la société A du banc (le formulaire prend la société de la personne). */
async function rattacherA(id: string): Promise<void> {
  docsCrees.push(id);
  await prisma.legalDocument.update({ where: { id }, data: { companyId: societeA } });
}

suite("La TVA des factures — collectée, déductible, à compléter, par société", () => {
  beforeAll(async () => {
    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG} ${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" }, select: { id: true } });
    const [s1, f1] = await Promise.all([mk("pdg", "SUPER_ADMIN"), mk("fin", "FINANCE_BUDGET_MANAGER")]);
    [societeA, societeB] = await Promise.all([societe("A"), societe("B")]);
    await prisma.userCompanyAccess.create({ data: { userId: f1.id, companyId: societeA, canEdit: true } });
    partie = (await prisma.companyContact.create({ data: { name: `${TAG} Imprimerie`, kind: "Fournisseur", createdById: s1.id }, select: { id: true } })).id;
    [sa, fin] = await Promise.all([acteur(s1.id, "SUPER_ADMIN"), acteur(f1.id, "FINANCE_BUDGET_MANAGER")]);
  }, 60_000);

  afterAll(async () => {
    const pieces = await prisma.legalDocument.findMany({ where: { OR: [{ companyId: { in: [societeA, societeB] } }, { id: { in: docsCrees } }] }, select: { id: true } }).catch(() => []);
    const ids = pieces.map((p) => p.id);
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.legalDocument.updateMany({ where: { id: { in: ids } }, data: { chainFromId: null } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { id: partie } }).catch(() => {});
    const comptes = [sa?.id, fin?.id].filter(Boolean) as string[];
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: comptes } } } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { ownerId: { in: comptes }, type: "FILE" } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { ownerId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.userCompanyAccess.deleteMany({ where: { companyId: { in: [societeA, societeB] } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 90_000);

  it("une facture ÉMISE par la fabrique enregistre sa TVA COLLECTÉE, par taux — sans ressaisie", async () => {
    // 100 × 1 000 à 19 % + 10 × 1 000 à 9 % : 110 000 HT, 19 000 + 900 de TVA → 129 900 TTC.
    const lignes: DemandeDocument["lignes"] = [
      { designation: "Conception de la campagne", quantite: 100, prixUnitaire: 1_000 },
      { designation: "Brochures (taux réduit)", quantite: 10, prixUnitaire: 1_000, tva: 0.09 },
    ];
    const r = await emettreDocumentDrive(sa, {
      type: "FACTURE", societe: societeA, tiers: { nom: `${TAG} Pharmacie Centrale`, adresse: "Alger", nif: "000016098765432" },
      lignes, date: `${PERIODE}-05`, echeance: `${PERIODE}-30`, modePaiement: "VIREMENT",
    });
    expect(r.ok, r.ok ? "" : r.motif).toBe(true);
    if (!r.ok) return;
    const tva = await prisma.factureTva.findUniqueOrThrow({
      where: { legalDocumentId: r.legalDocumentId },
      select: { source: true, sens: true, montantHt: true, montantTva: true, montantTtc: true, taux: { select: { taux: true, baseHt: true, montantTva: true }, orderBy: { taux: "desc" } } },
    });
    expect({ source: tva.source, sens: tva.sens, ht: Number(tva.montantHt), tva: Number(tva.montantTva), ttc: Number(tva.montantTtc) })
      .toEqual({ source: "FABRIQUE", sens: "COLLECTEE", ht: 110_000, tva: 19_900, ttc: 129_900 });
    expect(tva.taux.map((l) => [Number(l.taux), Number(l.baseHt), Number(l.montantTva)])).toEqual([[19, 100_000, 19_000], [9, 10_000, 900]]);

    const mois = await tvaDuMois(societeA, PERIODE);
    expect({ collectee: mois.collectee, deductible: mois.deductible, aPayer: mois.aPayer }).toEqual({ collectee: 19_900, deductible: 0, aPayer: 19_900 });
    expect(mois.detailParTaux.find((d) => d.taux === 9)?.collectee).toEqual({ base: 10_000, tva: 900 });
  }, 120_000);

  it("un AVOIR émis sur cette facture retranche sa TVA de la collectée", async () => {
    const facture = await prisma.legalDocument.findFirstOrThrow({ where: { companyId: societeA, kind: "INVOICE", tva: { source: "FABRIQUE" } }, select: { id: true } });
    ACTOR = fin;
    const fd = new FormData();
    fd.set("factureId", facture.id);
    for (const [k, v] of Object.entries({ ligneDesignation: "Retour de 10 conceptions", ligneDetails: "", ligneQuantite: "10", lignePrix: "1000", ligneRemise: "", ligneTva: "", ligneSection: "0" })) fd.append(k, v);
    fd.set("motif", "Prestation partiellement annulée.");
    const r = await emettreAvoir(undefined, fd);
    expect(r.ok, r.error).toBe(true);
    // L'avoir compte au mois de SA date d'émission (aujourd'hui), pas à celui de la facture : 10 000 HT à 19 % → 1 900
    // de TVA retranchés de la collectée de ce mois-là — seul, un crédit de TVA.
    const av = await prisma.legalDocument.findFirstOrThrow({ where: { chainFromId: facture.id, kind: "CREDIT_NOTE" }, select: { startDate: true } });
    const moisAvoir = periodeDeLaFacture(av.startDate!);
    const m = await tvaDuMois(societeA, moisAvoir);
    expect({ collectee: m.collectee, aPayer: m.aPayer, credit: m.credit }).toEqual({ collectee: -1_900, aPayer: -1_900, credit: 1_900 });
    if (moisAvoir !== PERIODE) expect((await tvaDuMois(societeA, PERIODE)).collectee).toBe(19_900);
  }, 120_000);

  it("une facture REÇUE saisie dans Legal enregistre sa TVA DÉDUCTIBLE ; une saisie incohérente est refusée, rien n'est écrit", async () => {
    ACTOR = fin;
    const incoherente = await createLegalDocument(undefined, formulaireFacture({ amount: "120000", tvaHt_19: "100000", tvaMontant_19: "19000" }));
    expect(incoherente.ok).toBe(false);
    expect(incoherente.ok ? "" : incoherente.error).toMatch(/HT \+ TVA = 119.000,00.DZD, mais le TTC de la facture est 120.000,00.DZD/);

    // La TVA laissée vide se calcule ; le timbre se saisit à part : 50 000 + 9 500 + 595 = 60 095.
    const r = await createLegalDocument(undefined, formulaireFacture({ amount: "60095", tvaHt_19: "50000", tvaMontant_19: "", tvaAutres: "595" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    await rattacherA(r.id!);
    const tva = await prisma.factureTva.findUniqueOrThrow({ where: { legalDocumentId: r.id! }, select: { source: true, montantTva: true, autresTaxes: true, saisieParId: true } });
    expect({ source: tva.source, tva: Number(tva.montantTva), autres: Number(tva.autresTaxes), par: tva.saisieParId }).toEqual({ source: "SAISIE", tva: 9_500, autres: 595, par: fin.id });

    const mois = await tvaDuMois(societeA, PERIODE);
    expect({ collectee: mois.collectee, deductible: mois.deductible, aPayer: mois.aPayer }).toEqual({ collectee: 19_900, deductible: 9_500, aPayer: 10_400 });
    expect(await tvaAPayerDuMois(societeA, PERIODE)).toBe(10_400);
  }, 120_000);

  it("une facture d'AVANT le lot (montant seul) est listée « à compléter », jamais comptée — puis complétée depuis sa fiche", async () => {
    const ancienne = await prisma.legalDocument.create({
      data: { companyId: societeA, kind: "INVOICE", title: `${TAG} Facture ancienne`, direction: "OUT", amount: 23_800, startDate: new Date(`${PERIODE}-20T00:00:00Z`), counterpartyIds: [partie], counterparty: `${TAG} Imprimerie`, createdById: sa.id },
      select: { id: true },
    });
    const mois = await tvaDuMois(societeA, PERIODE);
    expect(mois.facturesIncompletes.map((f) => [f.id, f.raison])).toEqual([[ancienne.id, "TVA_NON_RENSEIGNEE"]]);
    expect(mois.deductible).toBe(9_500);
    // Une pièce du mois à compléter : la G50 ne reçoit pas de chiffre partiel.
    expect(await tvaAPayerDuMois(societeA, PERIODE)).toBeNull();
    expect((await etatTvaDesFactures([ancienne.id])).get(ancienne.id)).toMatchObject({ aCompleter: "TVA_NON_RENSEIGNEE", ht: null });

    // La fiche la complète : 20 000 HT à 19 %, 3 800 de TVA = 23 800, son montant d'origine.
    ACTOR = fin;
    const fd = formulaireFacture({ id: ancienne.id, title: `${TAG} Facture ancienne`, amount: "23800", startDate: `${PERIODE}-20`, tvaHt_19: "20000", tvaMontant_19: "3800" });
    const r = await updateLegalDocument(fd);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const apres = await tvaDuMois(societeA, PERIODE);
    expect(apres.facturesIncompletes).toEqual([]);
    expect({ deductible: apres.deductible, aPayer: apres.aPayer }).toEqual({ deductible: 13_300, aPayer: 6_600 });
    expect(await tvaAPayerDuMois(societeA, PERIODE)).toBe(6_600);

    // Son montant change sans sa TVA : elle redevient « à revoir » au lieu de compter un HT qui ne correspond plus.
    await prisma.legalDocument.update({ where: { id: ancienne.id }, data: { amount: 30_000 } });
    expect((await tvaDuMois(societeA, PERIODE)).facturesIncompletes.map((f) => f.raison)).toEqual(["TTC_MODIFIE"]);
    await prisma.legalDocument.update({ where: { id: ancienne.id }, data: { amount: 23_800 } });

    // Les champs envoyés VIDES effacent la TVA : la facture redevient à compléter.
    const vide = await updateLegalDocument(formulaireFacture({ id: ancienne.id, title: `${TAG} Facture ancienne`, amount: "23800", startDate: `${PERIODE}-20`, tvaHt_19: "", tvaMontant_19: "" }));
    expect(vide.ok, vide.ok ? "" : vide.error).toBe(true);
    expect(await prisma.factureTva.count({ where: { legalDocumentId: ancienne.id } })).toBe(0);
  }, 120_000);

  it("CLOISONNEMENT : la TVA d'une société ne compte jamais dans celle d'une autre", async () => {
    const r = await emettreDocumentDrive(sa, {
      type: "FACTURE", societe: societeB, tiers: { nom: `${TAG} Client B`, adresse: "Oran", nif: "000016098765433" },
      lignes: [{ designation: "Prestation B", quantite: 1, prixUnitaire: 1_000_000 }], date: `${PERIODE}-15`, echeance: `${PERIODE}-30`, modePaiement: "VIREMENT",
    });
    expect(r.ok, r.ok ? "" : r.motif).toBe(true);
    const [a, b] = await Promise.all([tvaDuMois(societeA, PERIODE), tvaDuMois(societeB, PERIODE)]);
    expect(a.collectee).toBe(19_900);
    expect({ collectee: b.collectee, deductible: b.deductible, incompletes: b.facturesIncompletes.length }).toEqual({ collectee: 190_000, deductible: 0, incompletes: 0 });
    // Un autre mois, la même société : rien.
    expect((await tvaDuMois(societeB, `${ANNEE}-08`)).facturesComptees).toBe(0);
  }, 120_000);
});
