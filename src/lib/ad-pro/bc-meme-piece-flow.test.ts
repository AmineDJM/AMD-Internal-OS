import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
/**
 * LA LECTURE PAR LE MODÈLE est un service externe : le banc la REMPLACE par la lecture de LA pro forma de l'agence (trois lignes,
 * 117 250 DZD, aucune TVA imprimée) — mais pas ce qu'on en fait (lignes écrites, validées d'office quand rien ne fait douter).
 */
vi.mock("@/lib/pieces-lues/service", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/pieces-lues/service")>();
  return { ...vrai, proposerLecture: async () => ({ ok: true, proposition: {} }) };
});
const LIGNES_LUES = [
  { rang: 1, reference: "Billet Alger-Oran aller-retour", unit: "u", quantity: 2, unitPrice: 25_000, notes: [], suspecte: [] },
  { rang: 2, reference: "Billet Alger-Constantine aller-retour", unit: "u", quantity: 2, unitPrice: 28_625, notes: [], suspecte: [] },
  { rang: 3, reference: "Frais de service", unit: "u", quantity: 2, unitPrice: 5_000, notes: [], suspecte: [] },
];
vi.mock("@/lib/pieces-lues/prerempli-devis-promo", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/pieces-lues/prerempli-devis-promo")>();
  return {
    ...vrai,
    lectureDevisPromo: () => ({
      lectureId: "lecture-du-banc", noteMethode: "texte natif, banc", sansLignes: null,
      prerempli: {
        fournisseurId: null, reference: null, quoteDate: null, tvaRate: null, extraTaxLabel: null, extraTaxRate: null,
        announcedTotal: 117_250, reserves: [], lignes: LIGNES_LUES,
      },
    }),
  };
});

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { createSponsoring } from "@/lib/actions/sponsoring-actions";
import {
  addAdProItem, ajouterVoyageur, ajouterDevisVoyageur, ajouterDevisPoste, genererEtEnvoyerBcPoste, genererBonDeCommandePoste,
} from "@/lib/actions/ad-pro-item-actions";
import { devisDesPostes } from "@/lib/queries/ad-pro-devis-poste";
import { loadAdProItems } from "@/lib/queries/ad-pro-items";
import { refusMontantDuPoste, totalValideDuPoste } from "@/lib/ad-pro-bc-devis";
import { prochainPas, faitsDuPoste, type RegardPoste } from "@/lib/ad-pro/poste-etapes";
import { etatDuBC } from "@/lib/bons-de-commande/etat";
import { fichiersEmis } from "@/lib/legal/fichiers-emis";
import { devisMisAPart, doublonsProbables, memePiece, type DevisAComparer } from "@/lib/ad-pro/devis-poste";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__memepiece__";
const RUN = `${TAG}${Date.now().toString(36)}`;

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
/** UN fichier : les MÊMES octets à chaque fois — c'est la pièce de l'agence, déposée plusieurs fois. */
const PRO_FORMA = new TextEncoder().encode(`%PDF-1.4 Genius Travel — pro forma ${RUN}`);
const proForma = () => new File([PRO_FORMA], `${TAG}proforma-genius.pdf`, { type: "application/pdf" });
const autreFichier = (nom: string) => new File([new TextEncoder().encode(`%PDF-1.4 ${nom} ${RUN}`)], `${TAG}${nom}.pdf`, { type: "application/pdf" });
const REGARD_DEMANDEUR: RegardPoste = { canEdit: true, canAllocate: false, canViserBC: false, canEmettre: false, fige: false, operationDecidee: false };

// ═════════════ La règle pure : la même pièce, et les propositions concurrentes ═════════════

const devis = (pieceId: string, o: Partial<DevisAComparer> = {}): DevisAComparer => ({
  pieceId, nom: pieceId, annule: false, empreintes: [], reference: null, fournisseur: "Genius Travel",
  lignes: LIGNES_LUES.map((l) => ({ reference: l.reference, quantity: l.quantity, unitPrice: l.unitPrice })),
  aUnBc: false, nbValidees: 3, voyageur: null, ...o,
});

describe("La même pièce ne se compte qu'une fois — la règle (devisMisAPart)", () => {
  it("LE MÊME FICHIER aux mêmes lignes est la même pièce ; les mêmes lignes SEULES ne le sont pas (deux billets au même prix)", () => {
    expect(memePiece(devis("a", { empreintes: ["x"] }), devis("b", { empreintes: ["x"] }))).toBe(true);
    expect(memePiece(devis("a", { empreintes: ["x"] }), devis("b", { empreintes: ["y"] })), "rien ne prouve que c'est la même pièce").toBe(false);
    expect(memePiece(devis("a", { reference: "PF-12" }), devis("b", { reference: "pf-12 " })), "même numéro chez le même fournisseur").toBe(true);
    expect(memePiece(devis("a", { empreintes: ["x"] }), devis("b", { empreintes: ["x"], lignes: [] })), "sans lignes, rien ne se compare").toBe(false);
    // Le doute se DIT sans se décider.
    expect(doublonsProbables([devis("a", { empreintes: ["x"] }), devis("b", { empreintes: ["y"] })]).get("b")).toBe("a");
  });

  it("CINQ COPIES, une par voyageur : une seule compte — celle qui a un BC, sinon la retenue, sinon la première", () => {
    const copies = [1, 2, 3, 4, 5].map((i) => devis(`c${i}`, { empreintes: ["x"], voyageur: { id: `v${i}`, nom: `V${i}`, retenu: i === 3 } }));
    const m = devisMisAPart(copies);
    expect(m.has("c3"), "la retenue compte").toBe(false);
    expect([...m.values()].every((x) => x.motif === "COPIE" && x.de === "c3")).toBe(true);
    expect(m.size).toBe(4);
    const avecBc = devisMisAPart(copies.map((c) => (c.pieceId === "c5" ? { ...c, aUnBc: true } : c)));
    expect(avecBc.has("c5"), "la commande déjà faite compte, telle quelle").toBe(false);
    expect(avecBc.get("c3")?.motif).toBe("COPIE");
  });

  it("DEUX PROPOSITIONS POUR UN VOYAGEUR : seule la retenue se commande ; sans choix, aucune — et la phrase nomme le geste", () => {
    const a = devis("a", { empreintes: ["x"], voyageur: { id: "v1", nom: "Dr Haddad", retenu: false } });
    const b = devis("b", { empreintes: ["y"], lignes: [{ reference: "Billet", quantity: 1, unitPrice: 90_000 }], voyageur: { id: "v1", nom: "Dr Haddad", retenu: true } });
    const m = devisMisAPart([a, b]);
    expect(m.get("a")).toMatchObject({ motif: "ECARTE", de: "b" });
    expect(m.has("b")).toBe(false);
    const sansChoix = devisMisAPart([a, { ...b, voyageur: { id: "v1", nom: "Dr Haddad", retenu: false } }]);
    expect(sansChoix.get("a")?.motif).toBe("A_CHOISIR");
    expect(sansChoix.get("a")?.phrase).toMatch(/2 propositions pour Dr Haddad : retenez-en une/);
    // Un devis du poste (sans voyageur) compte toujours.
    expect(devisMisAPart([devis("p"), devis("q", { empreintes: ["z"] })]).size).toBe(0);
  });
});

// ═════════════ Le cas de la Direction, par les vraies actions ═════════════

/**
 * « Prise en charge de la billetterie » — accordé 124 750 DZD, fournisseur Genius Travel, six voyageurs : la même pro forma de
 * l'agence (117 250 DZD, trois lignes, sans TVA) rattachée à chaque voyageur. La carte disait « 586 250 DZD, au-delà des
 * 124 750 accordés » et n'offrait que « Joindre un BC existant ». L'acteur est le demandeur, un National Sales SANS vue globale.
 */
suite("Billetterie — la même pro forma pour plusieurs voyageurs : comptée une fois, BC généré en un clic", () => {
  let nsId = "", companyId = "", catId = "", spoId = "", posteId = "";
  const voyageurs: string[] = [];
  let piece = "";

  beforeAll(async () => {
    const ns = await prisma.user.create({ data: { name: `${TAG}ns`, email: `${RUN}ns@t.dz`, role: "NATIONAL_SALES", passwordHash: "x" } });
    nsId = ns.id;
    const c = await prisma.company.create({ data: { name: `${RUN} Pharma`, shortName: RUN.slice(-12), color: "#1B7F79" } });
    companyId = c.id;
    await prisma.employee.create({ data: { fullName: `${TAG} ns`, userId: nsId, companyId } });
    await prisma.companyLegalIdentity.create({
      data: {
        companyId, legalName: `${TAG} Pharma SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
        nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
        bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Direction", managerTitle: "Gérant",
      },
    });
    const env = await prisma.budgetEnvelope.create({
      data: {
        name: `${RUN}Ad&Pro 2026`, modules: ["SPONSORING"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 5_000_000,
        categories: { create: [{ name: `${TAG}Prise en charge Nationale`, module: "SPONSORING", allocated: 5_000_000 }] },
      },
      include: { categories: true },
    });
    catId = env.categories[0]!.id;

    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const f = new FormData();
    f.set("institution", `${TAG}Société de cardiologie`);
    f.set("doctorHorsAnnuaire", "Dr Amel Haddad");
    f.append("productIds", `${TAG}Nivolex`);
    f.set("city", "Alger"); f.set("specialty", "Cardiologie"); f.set("type", "Congrès");
    f.set("amountRequested", "300000"); f.set("amountProposed", "200000");
    f.set("nature", "DIRECT"); f.set("strategicImportance", "HIGH");
    f.append("files", autreFichier("demande"));
    const s = await createSponsoring(undefined, f);
    if (!s.ok) throw new Error(s.error);
    spoId = s.id!;
    await prisma.sponsoringRequest.update({ where: { id: spoId }, data: { companyId } });
    const add = await addAdProItem(undefined, fd({
      parent: "SPONSORING", parentId: spoId, label: `${TAG}Prise en charge de la billetterie`, kind: "TICKETING", amountEstimated: "124750", supplier: "Genius Travel",
    }));
    if (!add.ok) throw new Error(add.error);
    posteId = add.id!;
    // DÉCOR : les deux temps de validation ont accordé 124 750 DZD et choisi la ligne budgétaire.
    await prisma.adProItem.update({ where: { id: posteId }, data: { status: "APPROVED", amountGranted: 124_750, budgetCategoryId: catId, opsDecidedAt: new Date() } });
    for (const nom of ["Dr Amel Haddad", "Dr Yacine Ouali", "Dr Karim Benali", "Dr Lina Saadi"]) {
      const v = await ajouterVoyageur(undefined, fd({ itemId: posteId, nom }));
      if (!v.ok) throw new Error(v.error);
      voyageurs.push(v.id!);
    }
  }, 90_000);

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
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: nsId } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: nsId, type: "FILE" } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: nsId } }).catch(() => {});
    await prisma.documentSequence.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.officeLetterhead.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: RUN } } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: nsId } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: RUN } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } }).catch(() => {});
    await prisma.companyLegalIdentity.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
  }, 90_000);

  const devisDuPoste = async () => (await devisDesPostes([posteId])).get(posteId) ?? [];
  const nbDevis = () => prisma.adProItemPiece.count({ where: { itemId: posteId, nature: "DEVIS" } });
  const deposerPour = async (voyageurId: string, proformaCoche = true) => {
    const f = fd({ voyageurId, ...(proformaCoche ? { proforma: "on" } : {}) });
    f.append("attachment", proForma());
    const r = await ajouterDevisVoyageur(undefined, f);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    return r;
  };

  it("prémisses : le demandeur n'a pas la vue globale", () => {
    expect(hasGlobalView("NATIONAL_SALES")).toBe(false);
  });

  it("LA CAUSE : la même pro forma déposée pour un 2e voyageur n'est PAS enregistrée une seconde fois — un seul devis au poste", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const r1 = await deposerPour(voyageurs[0]!);
    piece = r1.id!;
    expect(r1.message, "les lignes lues sont validées d'office").toMatch(/3 lignes validées automatiquement/);
    const r2 = await deposerPour(voyageurs[1]!, false);
    expect(r2.id, "la pièce désignée est celle déjà déposée").toBe(piece);
    expect(r2.message).toMatch(/déjà déposée sur le poste pour Dr Amel Haddad .* n'est pas enregistrée une seconde fois/);
    expect(await nbDevis()).toBe(1);
    const d = await devisDuPoste();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ nbValidees: 3, totalValideHt: 117_250, etat: "A_GENERER", miseAPart: null });
    // Redéposer pour le même voyageur ne fait rien non plus.
    expect((await deposerPour(voyageurs[0]!)).message).toMatch(/déjà déposée pour Dr Amel Haddad/);
    expect(await nbDevis()).toBe(1);
  });

  it("UN DEVIS DU POSTE (sans voyageur) déposé avec le même fichier : le voyageur y est RATTACHÉ, sans copie", async () => {
    // Le fichier d'un AUTRE devis du poste, déposé sans voyageur (case « Devis »), puis pour un voyageur.
    const f = fd({ id: posteId, proforma: "on" });
    const fichier = autreFichier("hotel");
    f.append("attachment", fichier);
    const r = await ajouterDevisPoste(undefined, f);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const g = fd({ voyageurId: voyageurs[2]! });
    g.append("attachment", autreFichier("hotel"));
    const lie = await ajouterDevisVoyageur(undefined, g);
    expect(lie.ok, lie.ok ? "" : lie.error).toBe(true);
    expect(lie.message).toMatch(/rattachée à Dr Karim Benali, sans être enregistrée une seconde fois/);
    expect(await prisma.adProVoyageurDevis.count({ where: { voyageurId: voyageurs[2]!, piece: { legalDocumentId: r.id! } } })).toBe(1);
    expect(await nbDevis()).toBe(2);
    // Il ne servait qu'à éprouver le rattachement : retiré du poste (ses lignes, identiques, n'ont rien validé d'office).
    const d = (await devisDuPoste()).find((x) => x.pieceId === r.id);
    expect(d?.nbValidees, "un contenu identique à un autre devis, sans preuve que c'est la même pièce, ne valide rien d'office").toBe(0);
    await prisma.adProVoyageurDevis.deleteMany({ where: { piece: { legalDocumentId: r.id! } } });
    await prisma.adProItemPiece.deleteMany({ where: { itemId: posteId, legalDocumentId: r.id! } });
  });

  it("LES DONNÉES D'AVANT : quatre copies de la même pièce, une par voyageur, toutes validées — la carte ne compte que 117 250 DZD", async () => {
    // DÉCOR — ce que l'ancien dépôt par voyageur a laissé en production : la même pro forma redéposée (le chemin du dépôt
    // de poste, qui ne la reconnaissait pas), liée à chaque voyageur, ses lignes validées pour le poste.
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const copies: string[] = [];
    for (const [i, v] of [voyageurs[1]!, voyageurs[2]!, voyageurs[3]!].entries()) {
      const f = fd({ id: posteId, ...(i === 0 ? {} : { proforma: "on" }) });
      f.append("attachment", proForma());
      const r = await ajouterDevisPoste(undefined, f);
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      copies.push(r.id!);
      const lien = await prisma.adProItemPiece.findUniqueOrThrow({ where: { itemId_legalDocumentId: { itemId: posteId, legalDocumentId: r.id! } }, select: { id: true } });
      await prisma.adProVoyageurDevis.create({ data: { voyageurId: v, pieceId: lien.id, createdById: nsId } });
      await prisma.adProDevisLigne.updateMany({ where: { devis: { legalDocumentId: r.id! } }, data: { validatedItemId: posteId, validatedAt: new Date(), validatedById: nsId } });
    }
    const d = await devisDuPoste();
    expect(d).toHaveLength(4);
    expect(d.every((x) => x.nbValidees === 3 && x.totalValideHt === 117_250), "chaque copie garde ses lignes validées, lisibles").toBe(true);
    const comptees = d.filter((x) => !x.miseAPart);
    expect(comptees.map((x) => x.pieceId), "une seule pièce compte : la première déposée").toEqual([piece]);
    for (const c of copies) {
      const x = d.find((y) => y.pieceId === c)!;
      expect(x.etat).toBe("MIS_A_PART");
      expect(x.miseAPart).toMatchObject({ motif: "COPIE", de: piece });
      expect(x.miseAPart?.phrase).toMatch(/Même pièce que .*déposée pour Dr Amel Haddad.* ne se compte qu'une fois/);
    }
    expect(totalValideDuPoste(d), "117 250 DZD, pas 4 × 117 250").toBe(117_250);
    expect(refusMontantDuPoste(d, 124_750), "sous les 124 750 accordés : rien ne bloque").toBeNull();
    // LA CARTE DU POSTE propose UN geste de génération, et le total des devis retenus côté voyageurs ne compte la pièce qu'une fois.
    const ligne = (await loadAdProItems("SPONSORING", spoId)).find((r) => r.id === posteId)!;
    expect(prochainPas(faitsDuPoste(ligne), REGARD_DEMANDEUR).geste).toMatchObject({ cle: "GENERER_BC", libelle: "Générer le BC" });
    const copiesVues = ligne.voyageurs.flatMap((v) => v.devis).filter((x) => x.copieDe === piece);
    expect(copiesVues.map((x) => x.id).sort()).toEqual([...copies].sort());
  });

  it("UN CLIC : « Générer le bon de commande » compose LE BC (numéroté, Word + PDF) d'après la pièce comptée, et l'aiguille vers les Finances", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const r = await genererEtEnvoyerBcPoste(fd({ id: posteId }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.message).toMatch(/1 bon de commande généré/);
    const bcs = await prisma.legalDocument.findMany({ where: { kind: "PURCHASE_ORDER", sourceType: "AD_PRO_ITEM", sourceId: posteId, status: { not: "CANCELLED" } } });
    expect(bcs, "UN BC, pas un par copie").toHaveLength(1);
    const bc = bcs[0]!;
    expect(bc.chainFromId, "il découle de la pièce comptée").toBe(piece);
    expect(bc.reference, "numéroté").toBeTruthy();
    expect(Number(bc.amount), "117 250 DZD, sans TVA (aucune sur la pro forma)").toBe(117_250);
    const f = fichiersEmis(bc.custom);
    expect(f.docx, "le Word").not.toBeNull();
    expect(f.pdf, "le PDF").not.toBeNull();
    // AIGUILLÉ : sous le seuil, il part directement à la signature des Finances.
    expect((await etatDuBC(bc.id))?.etape).toBe("A_SIGNER");
    expect(await prisma.adProItemPiece.count({ where: { itemId: posteId, nature: "BON_DE_COMMANDE", legalDocumentId: bc.id } })).toBe(1);
    // Les copies restent sans BC, et rien n'est plus à générer.
    const d = await devisDuPoste();
    expect(d.find((x) => x.pieceId === piece)?.etat).toBe("A_JOUR");
    expect(d.filter((x) => x.pieceId !== piece).every((x) => x.bc === null && x.etat === "MIS_A_PART")).toBe(true);
    const encore = await genererEtEnvoyerBcPoste(fd({ id: posteId }));
    expect(encore.ok).toBe(true);
    expect(encore.message).toMatch(/déjà son bon de commande, à jour/);
    expect(await prisma.legalDocument.count({ where: { kind: "PURCHASE_ORDER", sourceId: posteId, status: { not: "CANCELLED" } } })).toBe(1);
  }, 120_000);

  it("AU-DELÀ DE L'ACCORDÉ, le geste refuse avec la raison et le geste qui la lève ; une copie visée seule dit pourquoi elle ne se commande pas", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const d = await devisDuPoste();
    expect(refusMontantDuPoste(d, 100_000)).toMatch(/totalisent 117.250,00 DZD \(aucune TVA indiquée sur le devis\), au-delà des 100.000,00 DZD accordés.*Demandez une révision du poste/);
    const copie = d.find((x) => x.miseAPart)!;
    const r = await genererBonDeCommandePoste(fd({ id: posteId, pieceId: copie.pieceId }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/Même pièce que/);
  });
});
