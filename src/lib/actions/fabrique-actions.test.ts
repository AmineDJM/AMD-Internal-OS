/**
 * LE BOUTON DES FINANCES — éprouvé par le VRAI point d'entrée : la server action que l'écran
 * appelle, avec le formulaire tel que le composeur l'envoie (listes parallèles), sous une session
 * simulée, contre la base de test.
 *
 * Ce que ce banc tient, et le cas qui ferait tomber chaque assertion :
 *   • les Finances émettent une FACTURE et un BON DE COMMANDE — un COMMERCIAL qui a pourtant le
 *     droit d'ENGAGER la société est refusé (la porte est le module, pas la société) ;
 *   • les montants sont ceux des deux pièces de référence (3 × 2 500 000 → 8 925 000 TTC ;
 *     794 500 HT + Taxe Pub 2 % HORS base TVA → 961 345 TTC) — une taxe entrée dans la base
 *     de TVA ferait tomber le second ;
 *   • l'APERÇU n'écrit rien et ne consomme aucun numéro — un aperçu qui incrémenterait le
 *     compteur ferait sauter des numéros à chaque frappe (le composeur prévisualise en continu) ;
 *   • le motif de numérotation réglé par la papeterie (« {n:3}/FS/{aa} ») est celui de la pièce
 *     émise — `001/FS/26`, la forme exacte de la facture de référence — et les Finances ne
 *     peuvent pas le régler elles-mêmes ;
 *   • la même demande rejouée ne crée pas une seconde pièce.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { adaptateurDocx } from "@/lib/artifact/adapters/docx/adapter";
import type { DocxModel } from "@/lib/artifact/object-model/model";
import { formaterMontant } from "@/lib/artifact/factory/commercial";
import { portsArtefact } from "@/platform/ia/artifact/ports";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { apercuAvantImpressionPiece, emettrePieceCommerciale, previsualiserPieceCommerciale, reglerNumerotationPieces } from "./fabrique-actions";
import { lireTextePdf } from "@/lib/artifact/pdf/read";

const TAG = "__fabact__";
const ANNEE = new Date().getFullYear();
const AA = String(ANNEE).slice(-2);
const suite = process.env.DATABASE_URL ? describe : describe.skip;

let companyId = "";
let finance: CurrentUser;
let employe: CurrentUser;
let assistante: CurrentUser;

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, secondaryRole: null, access, mustChangePassword: false };
}

/** Le formulaire tel que le composeur l'envoie : champs simples + LISTES parallèles pour les lignes et les taxes. */
function form(champs: Record<string, string>, listes: Record<string, string[]> = {}): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(champs)) fd.set(k, v);
  for (const [k, vs] of Object.entries(listes)) for (const v of vs) fd.append(k, v);
  return fd;
}

const FACTURE = () => form(
  {
    type: "FACTURE", societe: companyId, tiersNom: `${TAG} Sarl BIOGALENIC`, tiersAdresse: "Zone industrielle, Oued Smar, Alger",
    tiersRc: "16/00-1234567B25", tiersNif: "001916012345699", tiersAi: "16012345699", numeroClient: "CL-0042",
    date: `${ANNEE}-01-12`, echeance: `${ANNEE}-02-11`, tvaDefaut: "19", modePaiement: "VIREMENT", objet: "Prestations de conseil réglementaire",
  },
  {
    ligneDesignation: ["Dossier d'enregistrement — lot 1", "Dossier d'enregistrement — lot 2", "Dossier d'enregistrement — lot 3"],
    ligneDetails: ["", "", ""], ligneQuantite: ["1", "1", "1"], lignePrix: ["2 500 000", "2500000", "2 500 000,00"], ligneRemise: ["", "", ""], ligneTva: ["", "", ""], ligneSection: ["", "", ""],
  },
);

const BON_DE_COMMANDE = () => form(
  {
    type: "BON_DE_COMMANDE", societe: companyId, tiersNom: `${TAG} INSIGNE CONSEIL`, tiersAdresse: "Hydra, Alger", date: `${ANNEE}-08-06`,
    tvaDefaut: "19", modePaiement: "VIREMENT", conditionsPaiement: "30 jours fin de mois", referenceAmont: "DEV-0021", contactNom: "M. Kaci", contactTelephone: "0550 00 00 00",
  },
  {
    ligneDesignation: ["Prestations de communication", "Conception de la campagne ARV"],
    ligneDetails: ["", "Déclinaison print et digitale\nTrois allers-retours de validation"],
    ligneQuantite: ["", "1"], lignePrix: ["", "794 500"], ligneRemise: ["", ""], ligneTva: ["", ""], ligneSection: ["1", ""],
    taxeLibelle: ["Taxe Pub"], taxeTaux: ["2"],
  },
);

async function texteDuDocx(userId: string, nodeId: string): Promise<string> {
  const octets = await portsArtefact.documents.lire(userId, nodeId, 1);
  if (!octets) throw new Error(`fichier ${nodeId} illisible`);
  const m = (await adaptateurDocx.ouvrir(octets)).modele() as DocxModel;
  return [...m.paragraphs.map((p) => p.text), ...m.tables.flatMap((t) => t.cells.map((c) => c.text))].join("\n");
}

async function compteurs(kind: string) {
  const [pieces, seq] = await Promise.all([
    prisma.legalDocument.count({ where: { companyId } }),
    prisma.documentSequence.findUnique({ where: { companyId_kind_year: { companyId, kind, year: ANNEE } } }),
  ]);
  return { pieces, dernier: seq?.last ?? 0 };
}

suite("fabrique-actions — le bouton « Composer une pièce » des Finances", () => {
  beforeAll(async () => {
    const c = await prisma.company.create({ data: { name: `${TAG} Pharmagène`, shortName: TAG.slice(0, 12), color: "#1B7F79" } });
    companyId = c.id;
    await prisma.companyLegalIdentity.create({
      data: {
        companyId, legalName: `${TAG} Pharmagène SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-7654321B21", nif: "001916087654321",
        nis: "001916087654390", taxArticle: "16087654321", headOffice: "Lot 12, Zone d'activité, Dar El Beïda, Alger", phone: "+213 21 11 11 11", email: "contact@pharmagene.test",
        bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Amine Djouamai", managerTitle: "Gérant",
      },
    });
    const cree = async (suffixe: string, role: SessionUser["role"]) => {
      const u = await prisma.user.create({ data: { name: `${TAG}${suffixe}`, email: `${TAG}${suffixe}@t.dz`, passwordHash: "x", role } });
      // Chacun peut ENGAGER la société : ce qui distingue les trois, c'est le MODULE, pas la société.
      await prisma.userCompanyAccess.create({ data: { userId: u.id, companyId, canEdit: true } });
      return actorFor(u.id, role);
    };
    finance = await cree("fin", "FINANCE_BUDGET_MANAGER");
    employe = await cree("emp", "SALES_USER");
    assistante = await cree("ast", "DIRECTION_ASSISTANT");
  }, 60_000);

  afterAll(async () => {
    const ids = [finance?.id, employe?.id, assistante?.id].filter(Boolean) as string[];
    // Les PORTES des BC émis (§118.148) : leur demandeur est un compte du banc, et la clé
    // étrangère `requesterId` empêcherait de le supprimer.
    const pieces = (await prisma.legalDocument.findMany({ where: { companyId }, select: { id: true } }).catch(() => [])).map((d) => d.id);
    await prisma.validationRequest.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: pieces } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: pieces } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: ids } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids }, type: "FILE" } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids } } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("un COMMERCIAL qui peut engager la société est refusé quand même — la porte est le module Legal/Finances, et rien n'est écrit", async () => {
    const avant = await compteurs("INVOICE");
    ACTOR = employe;
    const r = await emettrePieceCommerciale(undefined, FACTURE());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/droit de créer dans Legal ou dans Finances/);
    expect(await compteurs("INVOICE")).toEqual(avant);
  }, 60_000);

  it("les Finances ne règlent PAS la numérotation ; la papeterie, oui — et un motif sans compteur est refusé", async () => {
    ACTOR = finance;
    const refus = await reglerNumerotationPieces(undefined, form({ type: "FACTURE", societe: companyId, motif: "{n:3}/FS/{aa}" }));
    expect(refus.ok).toBe(false);
    expect(refus.error).toMatch(/papeterie/);

    ACTOR = assistante;
    const sansCompteur = await reglerNumerotationPieces(undefined, form({ type: "FACTURE", societe: companyId, motif: "FS/{aa}" }));
    expect(sansCompteur.ok).toBe(false);

    const ok = await reglerNumerotationPieces(undefined, form({ type: "FACTURE", societe: companyId, motif: "{n:3}/FS/{aa}" }));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    expect(ok.message).toContain("{n:3}/FS/{aa}");
  }, 60_000);

  it("le PREMIER NUMÉRO de l'année se règle par la papeterie — 032/DG/<année> — sans toucher au motif ; une saisie illisible est refusée AVANT d'écrire (§118.203)", async () => {
    const BC = { type: "BON_DE_COMMANDE", societe: companyId };
    ACTOR = finance;
    const refus = await reglerNumerotationPieces(undefined, form({ ...BC, depart: "32", annee: String(ANNEE) }));
    expect(refus.ok).toBe(false);
    expect(refus.error).toMatch(/papeterie/);

    ACTOR = assistante;
    // Ni motif ni départ : rien à régler, et le refus le dit — il n'efface pas un motif par défaut.
    const vide = await reglerNumerotationPieces(undefined, form(BC));
    expect(vide.ok).toBe(false);
    expect(vide.error).toMatch(/Rien à régler/);
    for (const mauvais of ["trente-deux", "32,5", "-3", "0", "100000"]) {
      const r = await reglerNumerotationPieces(undefined, form({ ...BC, depart: mauvais, annee: String(ANNEE) }));
      expect(r.ok, `« ${mauvais} » doit être refusé`).toBe(false);
    }
    const motif = await reglerNumerotationPieces(undefined, form({ ...BC, motif: "{n:3}/DG/{aaaa}" }));
    expect(motif.ok, motif.ok ? "" : motif.error).toBe(true);
    // LE DÉPART SEUL : la clé `motif` est absente, le motif reste (§118.152c) ; le message dit le plancher.
    const depart = await reglerNumerotationPieces(undefined, form({ ...BC, depart: "32", annee: String(ANNEE) }));
    expect(depart.ok, depart.ok ? "" : depart.error).toBe(true);
    expect(depart.message).toContain(`Premier numéro de ${ANNEE} : 32`);
    expect(depart.message).not.toContain("Motif");

    ACTOR = finance;
    const a = await previsualiserPieceCommerciale(undefined, BON_DE_COMMANDE());
    expect(a.ok, a.ok ? "" : a.error).toBe(true);
    if (a.ok) { expect(a.motif).toBe("{n:3}/DG/{aaaa}"); expect(a.numeroProchain).toBe(`032/DG/${ANNEE}`); }

    // LES DEUX D'UN COUP — un seul envoi du panneau, deux réglages : le motif ne se perd pas derrière le départ.
    ACTOR = assistante;
    const ensemble = await reglerNumerotationPieces(undefined, form({ ...BC, motif: "{n:4}/DG/{aaaa}", depart: "7", annee: String(ANNEE) }));
    expect(ensemble.ok, ensemble.ok ? "" : ensemble.error).toBe(true);
    expect(ensemble.message).toContain("Motif enregistré : {n:4}/DG/{aaaa}");
    expect(ensemble.message).toContain(`Premier numéro de ${ANNEE} : 7`);
    ACTOR = finance;
    const b = await previsualiserPieceCommerciale(undefined, BON_DE_COMMANDE());
    expect(b.ok, b.ok ? "" : b.error).toBe(true);
    if (b.ok) { expect(b.motif).toBe("{n:4}/DG/{aaaa}"); expect(b.numeroProchain).toBe(`0007/DG/${ANNEE}`); }

    // On remet la série à son défaut : les cas suivants comptent leurs numéros depuis le compteur.
    ACTOR = assistante;
    const retire = await reglerNumerotationPieces(undefined, form({ ...BC, depart: "", annee: String(ANNEE), motif: "" }));
    expect(retire.ok, retire.ok ? "" : retire.error).toBe(true);
    expect(retire.message).toMatch(/retiré/);
  }, 60_000);

  it("l'APERÇU calcule tout (numéro prévu au motif, totaux, somme en lettres) et n'écrit RIEN", async () => {
    ACTOR = finance;
    const avant = await compteurs("INVOICE");
    const a = await previsualiserPieceCommerciale(undefined, FACTURE());
    expect(a.ok, a.ok ? "" : a.error).toBe(true);
    if (!a.ok) return;
    expect(a.numeroProchain).toBe(`001/FS/${AA}`);
    expect(a.motif).toBe("{n:3}/FS/{aa}");
    expect(a.totaux?.totalHt).toBe(7_500_000);
    expect(a.totaux?.totalTva).toBe(1_425_000);
    expect(a.totaux?.totalTtc).toBe(8_925_000);
    expect(a.totaux?.enLettres.toLowerCase()).toContain("huit millions");
    expect(a.peutEmettre).toBe(true);
    expect(a.bloquants).toEqual([]);
    // Rien n'a bougé : ni pièce au registre, ni numéro consommé — le composeur prévisualise à chaque frappe.
    expect(await compteurs("INVOICE")).toEqual(avant);
  }, 60_000);

  it("l'APERÇU AVANT IMPRESSION : le PDF à blanc — titre « BON DE COMMANDE », numéro prévu, taxe — sans rien écrire ni numéroter ; refusé tant que la pièce l'est", async () => {
    ACTOR = finance;
    const avant = await compteurs("PURCHASE_ORDER");
    const r = await apercuAvantImpressionPiece(undefined, BON_DE_COMMANDE());
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (!r.ok) return;
    const octets = Buffer.from(r.pdfBase64, "base64");
    expect(octets.subarray(0, 4).toString()).toBe("%PDF");
    expect(r.pages).toBeGreaterThanOrEqual(1);
    const texte = (await lireTextePdf(octets)).pages.map((p) => p.texte).join("\n");
    expect(texte).toContain("BON DE COMMANDE");
    expect(texte).toContain(r.numeroProchain);
    expect(texte).toContain("Taxe Pub");
    // RIEN n'a bougé : ni pièce au registre, ni numéro consommé — c'est un aperçu, pas une émission.
    expect(await compteurs("PURCHASE_ORDER")).toEqual(avant);
    // Une pièce refusée n'a pas d'aperçu : on ne montre pas ce qu'on ne livrerait pas.
    const sansTiers = BON_DE_COMMANDE();
    sansTiers.set("tiersNom", "");
    const refus = await apercuAvantImpressionPiece(undefined, sansTiers);
    expect(refus.ok).toBe(false);
    // Le refus NOMME ce qui bloque (c'est la phrase qu'on lit) — pas seulement « le rendu n'est pas possible ».
    if (!refus.ok) expect(refus.error).toMatch(/L'aperçu n'est pas possible : /);
    // Et qui ne peut pas émettre n'obtient pas non plus de PDF : même porte que l'aperçu des totaux.
    ACTOR = employe;
    const sansDroit = await apercuAvantImpressionPiece(undefined, BON_DE_COMMANDE());
    expect(sansDroit.ok).toBe(false);
    expect(await compteurs("PURCHASE_ORDER")).toEqual(avant);
  }, 60_000);

  it("les Finances ÉMETTENT la facture : numéro au motif, Word au format maison, PDF, pièce au registre Legal", async () => {
    ACTOR = finance;
    const r = await emettrePieceCommerciale(undefined, FACTURE());
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.reference).toBe(`001/FS/${AA}`);
    expect(r.totalTtc).toBe(8_925_000);
    expect(r.dejaEmis).toBe(false);
    expect(r.pdfNodeId).toBeTruthy();
    expect(r.pdfMethode).toMatch(/^(editeur|rendu)$/);
    expect(r.message).toMatch(/^Facture 001\/FS\/\d{2} émise au nom de/);

    const piece = await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.legalDocumentId! } });
    expect(piece.kind).toBe("INVOICE");
    expect(piece.reference).toBe(`001/FS/${AA}`);
    expect(piece.companyId).toBe(companyId);

    const texte = await texteDuDocx(finance.id, r.docxNodeId!);
    expect(texte).toMatch(/Arrêtée la présente facture à la somme de/);
    expect(texte).toContain(formaterMontant(8_925_000));
    expect(texte).toContain("HUIT MILLIONS");
    expect(texte).toContain("Numéro de client");
    expect(texte).toContain("CL-0042");
    expect((await compteurs("INVOICE")).dernier).toBe(1);
  }, 90_000);

  it("la MÊME demande rejouée rend la pièce existante — pas de seconde facture, pas de second numéro", async () => {
    ACTOR = finance;
    const avant = await compteurs("INVOICE");
    const r = await emettrePieceCommerciale(undefined, FACTURE());
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.dejaEmis).toBe(true);
    expect(r.reference).toBe(`001/FS/${AA}`);
    expect(r.message).toMatch(/existait déjà/);
    expect(await compteurs("INVOICE")).toEqual(avant);
  }, 90_000);

  it("les Finances émettent un BON DE COMMANDE avec section et Taxe Pub 2 % HORS base TVA — 961 345 TTC, comme la pièce de référence", async () => {
    ACTOR = finance;
    const a = await previsualiserPieceCommerciale(undefined, BON_DE_COMMANDE());
    expect(a.ok, a.ok ? "" : a.error).toBe(true);
    if (!a.ok) return;
    expect(a.totaux?.totalHt).toBe(794_500);
    expect(a.totaux?.taxes).toEqual([{ libelle: "Taxe Pub", taux: 0.02, montant: 15_890 }]);
    expect(a.totaux?.totalTva).toBe(150_955); // 19 % de 794 500 — la taxe n'entre PAS dans la base
    expect(a.totaux?.totalTtc).toBe(961_345);

    const r = await emettrePieceCommerciale(undefined, BON_DE_COMMANDE());
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.totalTtc).toBe(961_345);
    const piece = await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.legalDocumentId! } });
    expect(piece.kind).toBe("PURCHASE_ORDER");
    const texte = await texteDuDocx(finance.id, r.docxNodeId!);
    expect(texte).toMatch(/Arrêté le présent bon de commande à la somme de/);
    expect(texte).toContain("Prestations de communication"); // la ligne de SECTION est rendue, sans montant
    expect(texte).toContain("Taxe Pub");
    expect(texte).toContain(formaterMontant(961_345));
  }, 90_000);

  it("les Finances ne composent PAS de devis : la pièce reste à Legal", async () => {
    ACTOR = finance;
    const fd = FACTURE();
    fd.set("type", "DEVIS");
    const a = await previsualiserPieceCommerciale(undefined, fd);
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.error).toMatch(/Legal/);
  }, 60_000);
});
