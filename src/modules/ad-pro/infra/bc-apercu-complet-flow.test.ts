import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import PizZip from "pizzip";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/session")>();
  return { ...vrai, requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR };
});
/** LE SEUIL DES BONS DE COMMANDE EST UN RÉGLAGE GLOBAL (§118.132) : le banc l'INJECTE dans son processus. */
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), bcValidationThreshold: 500_000 }) };
});
/** LA LECTURE PAR LE MODÈLE est un service externe : le banc la remplace par la lecture d'UN devis (deux lignes, TVA 19 %). */
vi.mock("@/lib/pieces-lues/service", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/pieces-lues/service")>();
  return { ...vrai, proposerLecture: async () => ({ ok: true, proposition: {} }) };
});
const LIGNES_LUES = [
  { rang: 1, reference: "Location salle de conférence", unit: "jour", quantity: 1, unitPrice: 200_000, notes: [], suspecte: [] },
  { rang: 2, reference: "Pause-café", unit: "pers.", quantity: 50, unitPrice: 1_500, notes: [], suspecte: [] },
];
vi.mock("@/lib/pieces-lues/prerempli-devis-promo", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/pieces-lues/prerempli-devis-promo")>();
  return {
    ...vrai,
    lectureDevisPromo: () => ({
      lectureId: "lecture-du-banc", noteMethode: "texte natif, banc", sansLignes: null,
      prerempli: {
        fournisseurId: null, reference: "DEV-HOTEL-12", quoteDate: null, tvaRate: 19, extraTaxLabel: null, extraTaxRate: null,
        announcedTotal: 327_250, reserves: [], lignes: LIGNES_LUES,
      },
    }),
  };
});

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { getBlob, putBlob } from "@/lib/drive-storage";
import { papierEnTeteDeDemonstration } from "@/lib/artifact/factory/word";
import { createSponsoring } from "../actions-sponsoring";
import { clesDesActions } from "@/lib/actions/parc";
import { addAdProItem } from "../actions-postes";
import { ajouterDevisPoste, modifierBcDuPoste } from "../actions-postes-paiement";
import { genererBonDeCommandePoste, apercuBcPoste, modifierApercuBcPoste, annulerApercuBcPoste, validerEtEnvoyerBcPoste, previsualiserApercuBcPoste, validerLignesDuDevis } from "../actions-postes-lignes";
import { devisDesPostes } from "./requetes/devis-poste";
import { etatDuBC } from "@/lib/bons-de-commande/etat";
import { fichiersEmis } from "@/lib/lecteurs/fichiers-emis";
import { pieceEmise, valeursComposables, type ValeursComposables } from "@/lib/legal/piece-emise";
import { formulaireDuComposeur } from "@/lib/bons-de-commande/composeur-test-outils";
import { etatCompletDuBC } from "@/lib/bons-de-commande/etat-bc-test-outils";
import { lireBrouillon } from "@/lib/bons-de-commande/brouillon";
import { plafondDesDevis, refusDepassement, refusMontantDesDevis } from "../domaine/devis-poste";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__apercubc__";
const RUN = `${TAG}${Date.now().toString(36)}`;
const ANNEE = new Date().getUTCFullYear();

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};
const fichier = (nom: string) => new File([new TextEncoder().encode(`%PDF-1.4 ${nom} ${RUN}`)], `${TAG}${nom}.pdf`, { type: "application/pdf" });

/** Le TEXTE de la dernière version du Word d'une pièce (corps, en-têtes, pieds). */
async function texteDuWord(nodeId: string): Promise<string> {
  const v = await prisma.fileVersion.findFirstOrThrow({ where: { nodeId }, orderBy: { version: "desc" }, select: { blobId: true } });
  const octets = await getBlob(v.blobId);
  const zip = new PizZip(octets!);
  return Object.keys(zip.files).filter((n) => /^word\/.*\.xml$/.test(n)).map((n) => zip.file(n)!.asText().replace(/<[^>]+>/g, " ")).join(" ");
}
const sansEspaces = (s: string) => s.replace(/\s+/g, "");

type Spec = Record<string, unknown> & {
  tiers: Record<string, unknown>; lignes: Record<string, unknown>[]; contact: Record<string, unknown> | null; livraison: Record<string, unknown> | null;
};
const fabriqueDe = (custom: unknown) => (custom as { fabrique: { version: number; spec: Spec; totaux: { totalHt: number; totalTtc: number }; papierEnTeteId: string | null } }).fabrique;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'APERÇU DU BC D'UN POSTE : OBLIGATOIRE, ET « ULTRA COMPLET » (Direction, 14/10/2026).
 *
 * « Je veux l'aperçu obligatoire ; modification et révision possibles du BC ultra complètes, chaque détail peut être modifié
 * dans le BC. » Par les VRAIS points d'entrée de l'écran (session simulée, base locale) :
 *   (i)   le bouton du poste n'émet JAMAIS sans aperçu — aucune pièce numérotée avant « Valider et envoyer » ;
 *   (ii)  un brouillon corrigé sur CHAQUE catégorie de champ → le BC émis porte exactement ces valeurs (spécification et Word) ;
 *   (iii) le plafond de l'accordé est le MÊME, en TTC, en brouillon, à la génération et à la modification (audit M-03) ;
 *   (v)   le brouillon est périmé quand les lignes validées du devis changent ;
 *   et un BC signé ne se modifie plus depuis le poste.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Poste Ad & Pro — l'aperçu du BC est obligatoire, et tout s'y corrige", () => {
  let demId = "", companyId = "", catId = "", spoId = "", posteId = "", piece = "", papierId = "", bcId = "";

  beforeAll(async () => {
    const dem = await prisma.user.create({ data: { name: `${TAG}dem`, email: `${RUN}dem@t.dz`, role: "NATIONAL_SALES", passwordHash: "x" } });
    demId = dem.id;
    const c = await prisma.company.create({ data: { name: `${RUN} Pharma`, shortName: RUN.slice(-12), color: "#1B7F79" } });
    companyId = c.id;
    await prisma.employee.create({ data: { fullName: `${TAG} dem`, userId: demId, companyId } });
    await prisma.companyLegalIdentity.create({
      data: {
        companyId, legalName: `${TAG} Pharma SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
        nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
        bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Direction", managerTitle: "Gérant",
      },
    });
    const env = await prisma.budgetEnvelope.create({
      data: {
        name: `${RUN}Ad&Pro 2026`, modules: ["SPONSORING"], periodStart: new Date(`${ANNEE}-01-01`), periodEnd: new Date(`${ANNEE}-12-31`), totalAmount: 5_000_000,
        categories: { create: [{ name: `${TAG}Congrès`, module: "SPONSORING", allocated: 5_000_000 }] },
      },
      include: { categories: true },
    });
    catId = env.categories[0]!.id;
    const octets = papierEnTeteDeDemonstration(`${TAG} Pharma`);
    const blob = await putBlob(octets);
    papierId = (await prisma.officeLetterhead.create({
      data: { name: `${TAG} Papier congrès`, kind: "word", companyId, blobId: blob.blobId, size: blob.size, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", isActive: true, uploadedById: demId },
    })).id;

    ACTOR = await acteur(demId, "NATIONAL_SALES");
    const f = new FormData();
    f.set("institution", `${TAG}Société de cardiologie`);
    f.set("doctorHorsAnnuaire", "Dr Amel Haddad");
    f.append("productIds", `${TAG}Nivolex`);
    f.set("city", "Oran"); f.set("specialty", "Cardiologie"); f.set("type", "Congrès");
    f.set("amountRequested", "500000"); f.set("amountProposed", "400000");
    f.set("nature", "DIRECT"); f.set("strategicImportance", "HIGH");
    f.append("files", fichier("demande"));
    const s = await createSponsoring(undefined, f);
    if (!s.ok) throw new Error(s.error);
    spoId = s.id!;
    // DÉCOR : la tenue est PRÉVALIDÉE par la Direction Marketing (27/10/2026) — aucun poste ne s'ajoute avant.
    await prisma.sponsoringRequest.update({ where: { id: spoId }, data: { companyId, status: "PRE_VALIDATED" } });
    const add = await addAdProItem(undefined, fd({ parent: "SPONSORING", parentId: spoId, label: `${TAG}Salle et pauses`, kind: "VENUE", amountEstimated: "400000", supplier: "Hôtel Le Méridien" }));
    if (!add.ok) throw new Error(add.error);
    posteId = add.id!;
    // DÉCOR : la Direction Marketing a accepté le poste (un seul temps, 27/10/2026) — 400 000 DZD (TTC), ligne budgétaire choisie.
    await prisma.adProItem.update({ where: { id: posteId }, data: { status: "APPROVED", amountGranted: 400_000, budgetCategoryId: catId, opsDecidedAt: new Date() } });
    const d = fd({ id: posteId });
    d.append("attachment", fichier("devis-hotel"));
    const r = await ajouterDevisPoste(undefined, d);
    if (!r.ok) throw new Error(r.error);
    piece = r.id!;
    // LE DEMANDEUR VALIDE les deux lignes lues, après les avoir comparées au papier.
    const lignes = await prisma.adProDevisLigne.findMany({ where: { devis: { legalDocumentId: piece } }, select: { id: true } });
    if (lignes.length !== 2) throw new Error(`devis lu : ${lignes.length} ligne(s)`);
    const v = fd({ id: posteId, pieceId: piece, compare: "on" });
    for (const l of lignes) v.append("ligneId", l.id);
    const val = await validerLignesDuDevis(v);
    if (!val.ok) throw new Error(val.error);
  }, 120_000);

  afterAll(async () => {
    const liens = await prisma.adProItemPiece.findMany({ where: { itemId: posteId }, select: { legalDocumentId: true } }).catch(() => []);
    const legaux = await prisma.legalDocument.findMany({ where: { OR: [{ sourceId: { in: [spoId, posteId] } }, { companyId }, { id: { in: liens.map((l) => l.legalDocumentId) } }] }, select: { id: true } }).catch(() => []);
    const lids = legaux.map((l) => l.id);
    await prisma.adProDevisLigne.updateMany({ where: { devis: { legalDocumentId: { in: lids } } }, data: { bcId: null } }).catch(() => {});
    await prisma.legalDocument.updateMany({ where: { id: { in: lids } }, data: { chainFromId: null } }).catch(() => {});
    const vIds = (await prisma.validationRequest.findMany({ where: { entityId: { in: lids } }, select: { id: true } }).catch(() => [])).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityId: { in: lids } } }).catch(() => {});
    await prisma.documentRequest.deleteMany({ where: { entityType: "AD_PRO_ITEM", entityId: posteId } }).catch(() => {});
    await prisma.document.deleteMany({ where: { entityId: { in: [spoId, posteId, ...lids] } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: posteId } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: lids } } }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: spoId } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: spoId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [spoId, posteId, ...lids] } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: spoId } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: demId } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: demId, type: "FILE" } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: demId } }).catch(() => {});
    await prisma.documentSequence.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.officeLetterhead.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: RUN } } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: demId } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: RUN } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } }).catch(() => {});
    await prisma.companyLegalIdentity.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
  }, 120_000);

  const bcsDuPoste = () => prisma.legalDocument.count({ where: { kind: "PURCHASE_ORDER", sourceType: "AD_PRO_ITEM", sourceId: posteId } });
  const brouillonEnBase = async () => lireBrouillon((await prisma.adProDevis.findFirstOrThrow({ where: { legalDocumentId: piece }, select: { bcBrouillon: true } })).bcBrouillon);
  const ouvrir = async (): Promise<ValeursComposables> => {
    const a = await apercuBcPoste(fd({ id: posteId, pieceId: piece }));
    expect(a.ok, a.ok ? "" : a.error).toBe(true);
    if (!a.ok) throw new Error(a.error);
    return a.valeurs;
  };
  const prixPause = (prix: number) => prisma.adProDevisLigne.updateMany({ where: { devis: { legalDocumentId: piece }, reference: "Pause-café" }, data: { unitPrice: prix } });
  const prixSalle = (prix: number) => prisma.adProDevisLigne.updateMany({ where: { devis: { legalDocumentId: piece }, reference: "Location salle de conférence" }, data: { unitPrice: prix } });

  it("prémisses : un devis à deux lignes validées (TVA 19 %), 327 250 DZD TTC sous les 400 000 accordés", async () => {
    const d = ((await devisDesPostes([posteId])).get(posteId) ?? []).find((x) => x.pieceId === piece)!;
    expect(d).toMatchObject({ nbValidees: 2, totalValideHt: 275_000, etat: "A_GENERER" });
    expect(d.totalValideTtc).toBeCloseTo(327_250, 2);
  });

  it("(i) LE GESTE « EN UN CLIC » N'EXISTE PLUS, et « Générer le bon de commande » n'émet RIEN : il pose l'aperçu, sans numéro", async () => {
    expect(clesDesActions().has("ad-pro-item-actions:genererEtEnvoyerBcPoste"), "l'action qui émettait sans aperçu est retirée").toBe(false);
    ACTOR = await acteur(demId, "NATIONAL_SALES");
    const r = await genererBonDeCommandePoste(fd({ id: posteId }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.message).toMatch(/Brouillon — à vérifier par le demandeur/);
    expect(await bcsDuPoste(), "aucune pièce au registre").toBe(0);
    expect(await prisma.documentSequence.count({ where: { companyId } }), "aucun numéro consommé").toBe(0);
    expect(await brouillonEnBase()).not.toBeNull();
    // L'aperçu s'ouvre prêt à relire : le composeur pré-rempli de la pièce telle qu'elle serait émise.
    const v = await ouvrir();
    expect(v.tiers.nom).toBe("Hôtel Le Méridien");
    expect(v.lignes.map((l) => [l.designation, l.unite, l.quantite, l.prix])).toEqual([["Location salle de conférence", "jour", "1", "200000"], ["Pause-café", "pers.", "50", "1500"]]);
    expect(v.champs).toMatchObject({ tvaDefaut: "19", livraisonDate: "" });
    expect(v.champs.objet).toMatch(/Salle et pauses/);
    // Les totaux suivent la saisie, à blanc.
    const t = await previsualiserApercuBcPoste(formulaireDuComposeur(v, { id: posteId, pieceId: piece }));
    expect(t.ok, t.ok ? "" : t.error).toBe(true);
    if (t.ok) expect(t.totaux?.totalTtc).toBeCloseTo(327_250, 2);
    expect(await bcsDuPoste(), "ni l'aperçu ni ses totaux n'écrivent au registre").toBe(0);
  }, 60_000);

  it("(v) LE BROUILLON PÉRIMÉ : les lignes validées du devis changent après les corrections — l'aperçu le dit, rien ne s'enregistre ni ne s'émet", async () => {
    ACTOR = await acteur(demId, "NATIONAL_SALES");
    const v = await ouvrir();
    const g = await modifierApercuBcPoste(formulaireDuComposeur(v, { id: posteId, pieceId: piece }));
    expect(g.ok, g.ok ? "" : g.error).toBe(true);
    expect((await brouillonEnBase())?.signature, "les lignes gardées portent l'empreinte du devis").toBeTruthy();
    await prixPause(1_600);
    const a = await apercuBcPoste(fd({ id: posteId, pieceId: piece }));
    expect(a.ok).toBe(false);
    expect(a.ok ? "" : a.error).toMatch(/lignes validées du devis ont changé/);
    const m = await modifierApercuBcPoste(formulaireDuComposeur(v, { id: posteId, pieceId: piece }));
    expect(m.ok).toBe(false);
    expect(m.ok ? "" : m.error).toMatch(/ont changé depuis vos corrections/);
    const val = await validerEtEnvoyerBcPoste(fd({ id: posteId, pieceId: piece }));
    expect(val.ok).toBe(false);
    expect(val.ok ? "" : val.error).toMatch(/ont changé depuis l'aperçu/);
    expect(await bcsDuPoste()).toBe(0);
    // Retirer l'aperçu périmé et le générer de nouveau : il repart des lignes d'aujourd'hui.
    expect((await annulerApercuBcPoste(fd({ id: posteId, pieceId: piece }))).ok).toBe(true);
    expect(await brouillonEnBase()).toBeNull();
    await prixPause(1_500);
  }, 60_000);

  it("(iii) LE PLAFOND EST LE MÊME, EN TTC, en brouillon et à la génération (audit M-03) : 375 000 HT = 446 250 TTC > 400 000 accordés", async () => {
    ACTOR = await acteur(demId, "NATIONAL_SALES");
    const attendu = refusDepassement(446_250, 400_000, 375_000, true);
    expect(attendu).toMatch(/s'entend TTC/);
    // EN BROUILLON : la salle corrigée à 300 000 HT.
    expect((await genererBonDeCommandePoste(fd({ id: posteId }))).ok).toBe(true);
    const v = await ouvrir();
    v.lignes[0]!.prix = "300000";
    const b = await modifierApercuBcPoste(formulaireDuComposeur(v, { id: posteId, pieceId: piece }));
    expect(b.ok, "le hors-taxe (375 000) passerait ; le TTC ne passe pas").toBe(false);
    expect(b.ok ? "" : b.error).toBe(attendu);
    // Le refus lit la MÊME règle que la carte (`refusMontantDesDevis`) et que la modification (`plafondDesDevis`).
    const p = plafondDesDevis([{ pieceId: piece, annule: false, miseAPart: null, nbValidees: 2, totalValideHt: 275_000, totalValideTtc: 327_250, entete: { tvaRate: 19 } }], new Map([[piece, { ht: 375_000, ttc: 446_250 }]]));
    expect(refusDepassement(p.ttc, 400_000, p.ht, p.tvaIndiquee)).toBe(attendu);
    expect(refusMontantDesDevis([{ annule: false, miseAPart: null, nbValidees: 2, totalValideHt: 375_000, totalValideTtc: 446_250, entete: { tvaRate: 19 } }], 400_000)).toBe(attendu);
    // À LA GÉNÉRATION : les mêmes lignes, validées au devis — le même refus, mot pour mot.
    expect((await annulerApercuBcPoste(fd({ id: posteId, pieceId: piece }))).ok).toBe(true);
    await prixSalle(300_000);
    const gen = await genererBonDeCommandePoste(fd({ id: posteId }));
    expect(gen.ok).toBe(false);
    expect(gen.ok ? "" : gen.error).toBe(attendu);
    await prixSalle(200_000);
    expect(await bcsDuPoste()).toBe(0);
  }, 60_000);

  it("(ii) CHAQUE CATÉGORIE SE CORRIGE DANS L'APERÇU, et le BC émis porte EXACTEMENT ces valeurs (spécification et Word)", async () => {
    ACTOR = await acteur(demId, "NATIONAL_SALES");
    expect((await genererBonDeCommandePoste(fd({ id: posteId }))).ok).toBe(true);
    const v = await ouvrir();
    v.tiers = {
      nom: "Hôtel Le Méridien Oran SPA", adresse: "Front de mer\nOran", telephone: "041 11 22 33", email: "commandes@meridien-oran.dz",
      rc: "31/00-9999999B26", nif: "000931099999999", ai: "31099999999", nis: "000931099999990",
    };
    v.lignes = [
      { designation: "Prestations du congrès", unite: "", details: "", quantite: "", prix: "", remise: "", tva: "", section: true },
      { designation: "Location salle de conférence", unite: "jour", details: "Salle plénière\nVidéoprojecteur", quantite: "1", prix: "200000", remise: "10", tva: "19", section: false },
      { designation: "Pause-café", unite: "pers.", details: "", quantite: "50", prix: "1500", remise: "", tva: "9", section: false },
      { designation: "Badges imprimés", unite: "u", details: "", quantite: "100", prix: "50", remise: "", tva: "", section: false },
    ];
    v.champs = {
      ...v.champs,
      date: `${ANNEE}-11-03`, objet: "Congrès de cardiologie — logistique corrigée", referenceAmont: "DEV-2026-077", referenceAmontDate: `${ANNEE}-09-28`,
      contactNom: "Mme Salima Benali", contactTelephone: "0555 12 34 56",
      livraisonAdresse: "Hôtel Sheraton, Oran", livraisonDelai: "15 jours", livraisonDate: `${ANNEE}-11-20`,
      modePaiement: "CHEQUE", conditionsPaiement: "60 jours fin de mois", tvaDefaut: "19", remiseGlobale: "5", notes: "Notes corrigées dans l'aperçu.",
    };
    v.taxes = [{ libelle: "Taxe Pub", taux: "2" }];
    v.emetteur = { adresse: "Siège corrigé, 5 rue Didouche, Alger", telephone: "021 99 99 99", email: "achats@corrige-emetteur.dz" };
    v.signataire = { nom: "Amel Haddad", qualite: "Directrice des achats" };
    v.mentions = "Livraison franco de port.\nToute réclamation sous 8 jours.";
    const formulaire = () => formulaireDuComposeur(v, { id: posteId, pieceId: piece, letterheadId: papierId });

    // ENREGISTRER LE BROUILLON : tout est gardé — et l'aperçu rouvert montre ce qui a été écrit.
    const g = await modifierApercuBcPoste(formulaire());
    expect(g.ok, g.ok ? "" : g.error).toBe(true);
    expect(await bcsDuPoste(), "un brouillon enregistré n'est pas un BC").toBe(0);
    const relu = await ouvrir();
    expect(relu.tiers).toEqual(v.tiers);
    expect(relu.champs).toMatchObject({ objet: v.champs.objet, referenceAmont: "DEV-2026-077", livraisonDate: `${ANNEE}-11-20`, modePaiement: "CHEQUE", remiseGlobale: "5", date: `${ANNEE}-11-03` });
    expect(relu.lignes.map((l) => [l.designation, l.unite, l.remise, l.tva, l.section])).toEqual(v.lignes.map((l) => [l.designation, l.unite, l.remise, l.tva, l.section]));
    expect(relu.letterheadId).toBe(papierId);
    expect(relu.signataire).toEqual(v.signataire);

    // VALIDER ET ENVOYER, depuis le composeur : ce qu'il montre est écrit, puis émis.
    const r = await validerEtEnvoyerBcPoste(formulaire());
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const bc = await prisma.legalDocument.findFirstOrThrow({ where: { kind: "PURCHASE_ORDER", sourceType: "AD_PRO_ITEM", sourceId: posteId, status: { not: "CANCELLED" } } });
    bcId = bc.id;
    expect(bc.reference, "numéroté à la validation, et seulement là").toBeTruthy();
    expect(await brouillonEnBase(), "le brouillon validé est consommé").toBeNull();
    const f = fabriqueDe(bc.custom);
    const s = f.spec;
    expect(s.tiers).toMatchObject({ nom: v.tiers.nom, adresse: "Front de mer\nOran", telephone: "041 11 22 33", email: "commandes@meridien-oran.dz", rc: "31/00-9999999B26", nif: "000931099999999", ai: "31099999999", nis: "000931099999990" });
    expect(s.lignes.map((l) => [l.designation, l.section ?? false])).toEqual([["Prestations du congrès", true], ["Location salle de conférence", false], ["Pause-café", false], ["Badges imprimés", false]]);
    expect(s.lignes[1]).toMatchObject({ unite: "jour", details: ["Salle plénière", "Vidéoprojecteur"], quantite: 1, prixUnitaire: 200_000, remise: 0.1, tva: 0.19 });
    expect(s.lignes[2]).toMatchObject({ unite: "pers.", quantite: 50, prixUnitaire: 1_500, tva: 0.09 });
    expect(s.lignes[3]).toMatchObject({ unite: "u", quantite: 100, prixUnitaire: 50 });
    expect(s).toMatchObject({
      date: `${ANNEE}-11-03`, objet: v.champs.objet, referenceAmont: "DEV-2026-077", referenceAmontDate: `${ANNEE}-09-28`,
      modePaiement: "CHEQUE", conditionsPaiement: "60 jours fin de mois", tvaDefaut: 0.19, remiseGlobale: 0.05, notes: "Notes corrigées dans l'aperçu.",
      contact: { nom: "Mme Salima Benali", telephone: "0555 12 34 56" },
      livraison: { adresse: "Hôtel Sheraton, Oran", delai: "15 jours", date: `${ANNEE}-11-20` },
      taxes: [{ libelle: "Taxe Pub", taux: 0.02 }],
      coordonneesEmetteur: { adresse: "Siège corrigé, 5 rue Didouche, Alger", telephone: "021 99 99 99", email: "achats@corrige-emetteur.dz" },
      signataire: { nom: "Amel Haddad", qualite: "Directrice des achats" },
      mentionsPiece: ["Livraison franco de port.", "Toute réclamation sous 8 jours."],
    });
    expect(f.papierEnTeteId, "le papier en-tête choisi dans l'aperçu").toBe(papierId);
    // Les totaux de la fabrique : remise de ligne, TVA 19 % et 9 %, remise globale 5 %, Taxe Pub 2 % (hors base de TVA).
    expect(f.totaux.totalHt).toBeCloseTo(247_000, 2);
    expect(f.totaux.totalTtc).toBeCloseTo(291_745, 2);
    expect(Number(bc.amount)).toBeCloseTo(291_745, 2);
    // LE WORD porte ce que l'aperçu a corrigé.
    const word = sansEspaces(await texteDuWord(fichiersEmis(bc.custom).docx!));
    for (const attendu of [
      "Hôtel Le Méridien Oran SPA", "commandes@meridien-oran.dz", "31/00-9999999B26", "000931099999999", "Prestations du congrès", "Salle plénière",
      "Badges imprimés", "Congrès de cardiologie — logistique corrigée", "DEV-2026-077", "Mme Salima Benali", "Hôtel Sheraton, Oran", "15 jours",
      "60 jours fin de mois", "Taxe Pub", "Notes corrigées dans l'aperçu.", "achats@corrige-emetteur.dz", "Amel Haddad", "Directrice des achats",
      "Livraison franco de port.", "Toute réclamation sous 8 jours.",
    ]) expect(word, attendu).toContain(sansEspaces(attendu));
    // Aiguillé : sous le seuil, il part à la signature des Finances.
    expect((await etatDuBC(bcId))?.etape).toBe("A_SIGNER");
  }, 120_000);

  it("(iii, M-03) « MODIFIER LE BC » APPLIQUE LE MÊME PLAFOND TTC — 360 000 HT (428 400 TTC) refusés pour 400 000 accordés ; sous le plafond, nouvelle version", async () => {
    ACTOR = await acteur(demId, "NATIONAL_SALES");
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: bcId }, select: { custom: true } });
    const v = valeursComposables(doc.custom)!;
    const version = pieceEmise(doc.custom)!.version;
    const trop = structuredClone(v);
    trop.lignes = [{ designation: "Location salle de conférence", unite: "jour", details: "", quantite: "1", prix: "360000", remise: "", tva: "19", section: false }];
    trop.champs.remiseGlobale = "";
    // La case des taxes est TOUJOURS là dans le composeur : vidée, elle retire la Taxe Pub.
    trop.taxes = [{ libelle: "", taux: "" }];
    const refus = await modifierBcDuPoste(formulaireDuComposeur(trop, { id: posteId, legalDocumentId: bcId, versionVue: String(version), motif: "Salle seule." }));
    expect(refus.ok, "le hors-taxe passait sous l'ancienne règle ; le TTC non").toBe(false);
    expect(refus.ok ? "" : refus.error).toBe(refusDepassement(428_400, 400_000, 360_000, true));
    expect(pieceEmise((await prisma.legalDocument.findUniqueOrThrow({ where: { id: bcId }, select: { custom: true } })).custom)!.version).toBe(version);
    const ok = await modifierBcDuPoste(formulaireDuComposeur({ ...v, champs: { ...v.champs, notes: "Livraison le matin." } }, { id: posteId, legalDocumentId: bcId, versionVue: String(version), motif: "Note." }));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    const apres = fabriqueDe((await prisma.legalDocument.findUniqueOrThrow({ where: { id: bcId }, select: { custom: true } })).custom);
    expect(apres.version).toBe(version + 1);
    expect(apres.spec.notes).toBe("Livraison le matin.");
    // Le reste du BC n'a pas bougé : la révision reprend ce que l'aperçu avait posé.
    expect(apres.spec.signataire).toEqual({ nom: "Amel Haddad", qualite: "Directrice des achats" });
    expect(apres.papierEnTeteId).toBe(papierId);
  }, 120_000);

  it("LE N° DE RÉFÉRENCE SE MODIFIE DEPUIS LE POSTE (Direction, 14/10/2026) : dans « Modifier le BC », unique, compteur jamais en arrière, tracé", async () => {
    ACTOR = await acteur(demId, "NATIONAL_SALES");
    const lire = () => prisma.legalDocument.findUniqueOrThrow({ where: { id: bcId }, select: { custom: true, reference: true } });
    const doc = await lire();
    const v = valeursComposables(doc.custom)!;
    const ancien = doc.reference!;
    const version = pieceEmise(doc.custom)!.version;
    const autre = await prisma.legalDocument.create({ data: { companyId, kind: "PURCHASE_ORDER", title: `${TAG} autre BC`, reference: `${TAG}-PRIS-1`, counterparty: "x" }, select: { id: true } });
    const formulaire = (numeroRevise: string) => formulaireDuComposeur(v, { id: posteId, legalDocumentId: bcId, versionVue: String(version), motif: "Numéro.", numeroRevise, numeroActuel: ancien });
    const pris = await modifierBcDuPoste(formulaire(`${TAG}-PRIS-1`));
    expect(pris.ok).toBe(false);
    expect(pris.ok ? "" : pris.error).toMatch(/déjà porté/);
    // Au motif de la série : le compteur monte jusqu'à lui.
    const nouveau = ancien.replace(/\d+$/, (n) => String(Number(n) + 700).padStart(n.length, "0"));
    const seq = Number(/\d+$/.exec(nouveau)![0]);
    const ok = await modifierBcDuPoste(formulaire(nouveau));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    expect((await lire()).reference).toBe(nouveau);
    expect(fabriqueDe((await lire()).custom).spec).toMatchObject({ numero: nouveau });
    const compteur = await prisma.documentSequence.findUnique({ where: { companyId_kind_year: { companyId, kind: "PURCHASE_ORDER", year: ANNEE } }, select: { last: true } });
    expect(compteur?.last ?? 0).toBeGreaterThanOrEqual(seq);
    expect(await prisma.auditLog.findFirst({ where: { entityId: bcId, field: "numero" }, select: { oldValue: true, newValue: true, actorId: true } })).toEqual({ oldValue: ancien, newValue: nouveau, actorId: demId });
    await prisma.legalDocument.delete({ where: { id: autre.id } });
  }, 120_000);

  it("UN BC SIGNÉ NE SE MODIFIE PLUS DEPUIS LE POSTE", async () => {
    ACTOR = await acteur(demId, "NATIONAL_SALES");
    await prisma.legalDocument.update({ where: { id: bcId }, data: { signedAt: new Date() } });
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: bcId }, select: { custom: true } });
    const r = await modifierBcDuPoste(formulaireDuComposeur(valeursComposables(doc.custom)!, { id: posteId, legalDocumentId: bcId, motif: "Après signature." }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/est signé : il ne se modifie plus/);
  });

  it("SIGNÉ, SEUL SON NUMÉRO SE MODIFIE (Direction, 14/10/2026) : état, étapes et signature intacts, tracé ; numéro + autre champ → refusé", async () => {
    ACTOR = await acteur(demId, "NATIONAL_SALES");
    const lire = () => prisma.legalDocument.findUniqueOrThrow({ where: { id: bcId }, select: { custom: true, reference: true } });
    const doc = await lire();
    const v = valeursComposables(doc.custom)!;
    const ancien = doc.reference!;
    const version = pieceEmise(doc.custom)!.version;
    const nouveau = `${ancien}-S`;
    const avant = await etatCompletDuBC(bcId);
    const autreChamp = await modifierBcDuPoste(formulaireDuComposeur({ ...v, champs: { ...v.champs, notes: "Autre note." } }, { id: posteId, legalDocumentId: bcId, versionVue: String(version), numeroRevise: nouveau, numeroActuel: ancien }));
    expect(autreChamp.ok).toBe(false);
    expect(autreChamp.ok ? "" : autreChamp.error).toMatch(/seul son numéro de référence peut encore changer/);
    const seul = await modifierBcDuPoste(formulaireDuComposeur(v, { id: posteId, legalDocumentId: bcId, versionVue: String(version), numeroRevise: nouveau, numeroActuel: ancien }));
    expect(seul.ok, seul.ok ? "" : seul.error).toBe(true);
    expect(seul.message).toMatch(/seul le numéro a changé/);
    expect((await lire()).reference).toBe(nouveau);
    expect(await etatCompletDuBC(bcId)).toEqual(avant);
    expect(await prisma.auditLog.findFirst({ where: { entityId: bcId, field: "numero", newValue: nouveau }, select: { oldValue: true, actorId: true } })).toEqual({ oldValue: ancien, actorId: demId });
  }, 120_000);
});
