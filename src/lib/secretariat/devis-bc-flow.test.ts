import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

// ⚠ ORDRE D'IMPORT : `assistant` se charge le PREMIER, comme dans l'application — la fabrique remonte sinon le cycle
// d'initialisation `ops/index.ts` ↔ `lib/assistant.ts` par l'autre bout (`assistant/capability-audit.test.ts`).
import "@/lib/assistant";
import { prisma } from "@/lib/prisma";
import { getAccess, userCan } from "@/lib/rbac";
import { getAppSettings } from "@/lib/settings";
import { canAccessEntity } from "@/lib/entity-access";
import { createRequest, finishRequest } from "@/lib/actions/admin-request-actions";
import {
  deposerDevisDemande, enregistrerLignesDevisDemande, retenirLignesDevisDemande, genererBonDeCommandeDemande, deposerBonDeCommandeDemande, relancerDemande,
  ouvrirApercuBcDemande, previsualiserApercuBcDemande,
} from "@/lib/actions/secretariat-devis-actions";
import { previsualiserPieceCommerciale, reviserPieceCommerciale } from "@/lib/actions/fabrique-actions";
import { formulaireDuComposeur } from "@/lib/bons-de-commande/composeur-test-outils";
import { pieceEmise, valeursComposables } from "@/lib/legal/piece-emise";
import { decideValidation } from "@/lib/actions/validation-actions";
import { signerBonDeCommande } from "@/lib/actions/bc-signature-actions";
import { avecCopieSignee } from "@/lib/bons-de-commande/signature-test-outils";
import { etatDuBC } from "@/lib/bons-de-commande/etat";
import { porteDuBC, OBJET_BC } from "@/lib/bons-de-commande/aiguillage";
import { devisDeLaDemande } from "./devis-natif-serveur";
import { LIBELLE_BC_DEMANDE } from "./devis-natif";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__devisnatif__${Date.now().toString(36)}`;

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role);
  return { id, name: u.name, email: u.email, role: u.role, secondaryRole: u.secondaryRole, access, mustChangePassword: false };
}
const form = (fields: Record<string, string | string[] | File>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const x of v) fd.append(k, x); else fd.set(k, v);
  }
  return fd;
};
const pdf = (nom: string) => new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52])], nom, { type: "application/pdf" });

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DEVIS NATIFS → BON DE COMMANDE, AU BUREAU DU SECRÉTARIAT — par les VRAIS points d'entrée.
 *
 * « Quand l'assistante met ou upload des devis, le demandeur peut valider les références de chaque
 * devis […] ; ensuite le demandeur peut générer le bon de commande, ou le télécharger ; dans tous
 * les cas il est visible par l'assistante. Ce BC va dans le centre de validation ; une fois validé,
 * il va dans le module Bons de commande ; il est signé, puis il revient ici, signé et validé. »
 *
 *   asst  assistante de direction (dépose, retranscrit, termine)   dem   demandeur — délégué, SANS Legal
 *   fin   Finances (signent les BC)                                 autre un délégué sans rapport
 *   gm/sa le siège du centre de validations
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Bureau du secrétariat — devis natifs, lignes retenues, BC généré ou déposé, centre, signature", () => {
  const u: Record<string, string> = {};
  let companyId = "", fournisseur = "", fournisseur2 = "", departementId = "";
  let prix = 0;
  const demandes: string[] = [];

  beforeAll(async () => {
    const mk = async (k: string, role: "DIRECTION_ASSISTANT" | "MEDICAL_DELEGATE" | "FINANCE_BUDGET_MANAGER" | "GENERAL_MANAGER" | "SUPER_ADMIN") => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await mk("asst", "DIRECTION_ASSISTANT");
    await mk("dem", "MEDICAL_DELEGATE");
    await mk("autre", "MEDICAL_DELEGATE");
    await mk("fin", "FINANCE_BUDGET_MANAGER");
    await mk("gm", "GENERAL_MANAGER");
    await mk("sa", "SUPER_ADMIN");
    companyId = (await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12), color: "#1B7F79" } })).id;
    for (const k of ["asst", "dem", "autre", "fin"]) {
      await prisma.employee.create({ data: { fullName: `${TAG} ${k}`, userId: u[k], companyId } });
    }
    await prisma.companyLegalIdentity.create({
      data: {
        companyId, legalName: `${TAG} Pharma SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
        nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
        bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Direction", managerTitle: "Gérant",
      },
    });
    fournisseur = (await prisma.companyContact.create({ data: { name: `${TAG} Papeterie Atlas`, address: "Rue 7", city: "Alger", rc: "16/00-111", nif: "0001", companyId: null } })).id;
    fournisseur2 = (await prisma.companyContact.create({ data: { name: `${TAG} Bureau Plus`, address: "Rue 9", city: "Oran", rc: "31/00-222", nif: "0002", companyId: null } })).id;
    departementId = (await prisma.department.create({ data: { name: `${TAG} Marketing`, code: TAG.slice(-10) } })).id;
    // Au-dessus du seuil du centre de validations, quel qu'il soit : le BC DOIT y passer.
    const seuil = (await getAppSettings()).bcValidationThresholdCentre;
    prix = Math.max(100_000, Math.ceil((seuil || 0) / 10) + 1000);
  }, 60_000);

  afterAll(async () => {
    const pieces = (await prisma.legalDocument.findMany({ where: { OR: [{ companyId }, { sourceType: "ADMIN_REQUEST", sourceId: { in: demandes } }] }, select: { id: true } })).map((d) => d.id);
    const vIds = (await prisma.validationRequest.findMany({ where: { OR: [{ entityType: "LEGAL_DOCUMENT", entityId: { in: pieces } }, { entityType: "ADMIN_REQUEST", entityId: { in: demandes } }] }, select: { id: true } })).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: pieces } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { OR: [{ entityType: "LEGAL_DOCUMENT", entityId: { in: pieces } }, { entityType: "ADMIN_REQUEST", entityId: { in: demandes } }] } }).catch(() => {});
    await prisma.legalDocument.updateMany({ where: { id: { in: pieces } }, data: { chainFromId: null } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: pieces } } }).catch(() => {});
    await prisma.departmentBudgetExpense.deleteMany({ where: { adminRequestId: { in: demandes } } }).catch(() => {});
    await prisma.comment.deleteMany({ where: { entityType: "ADMIN_REQUEST", entityId: { in: demandes } } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { id: { in: demandes } } }).catch(() => {});
    const ids = Object.values(u);
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: ids } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids }, type: "FILE" } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids } } }).catch(() => {});
    await prisma.documentSequence.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityType: "ADMIN_REQUEST", entityId: { in: demandes } }] } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.companyLegalIdentity.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
  }, 60_000);

  const comme = async (k: string) => { ACTOR = await actorFor(u[k]!); };
  async function nouvelleDemande(titre: string): Promise<string> {
    await comme("dem");
    const r = await createRequest(undefined, form({ type: "PURCHASE", title: `${TAG} ${titre}`, priority: "MEDIUM", departmentId: departementId }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    demandes.push(r.id!);
    await prisma.administrativeRequest.update({ where: { id: r.id! }, data: { companyId } });
    return r.id!;
  }
  const lignes = (l: { designation: string; reference?: string; quantite: number; prixUnitaire: number; tva?: number }[]) =>
    JSON.stringify(l.map((x) => ({ ...x, tva: x.tva ?? 19 })));
  const notifs = (k: string, titre: string) => prisma.notification.count({ where: { userId: u[k], title: titre } });

  let demandeId = "", devisA = "", devisB = "", bcId = "";

  it("PRÉMISSES : le demandeur n'a ni Legal ni le droit de gérer le bureau ; l'assistante gère", async () => {
    const dem = await actorFor(u.dem);
    expect(userCan(dem, "LEGAL", "CREATE")).toBe(false);
    expect(userCan(dem, "ADMIN_REQUESTS", "UPDATE")).toBe(false);
    expect(userCan(await actorFor(u.asst), "ADMIN_REQUESTS", "UPDATE")).toBe(true);
  });

  it("l'assistante dépose deux devis (fichier exigé) et les retranscrit ; le demandeur est prévenu", async () => {
    demandeId = await nouvelleDemande("Fournitures du 2e étage");
    await comme("asst");
    const sansFichier = await deposerDevisDemande(form({ id: demandeId, supplierId: fournisseur }));
    expect(sansFichier.ok).toBe(false);

    const a = await deposerDevisDemande(form({
      id: demandeId, supplierId: fournisseur, reference: "26/0576", quoteDate: "2026-10-08", attachment: pdf("devis-atlas.pdf"),
      lignes: lignes([{ designation: "Ramette A4 80 g", reference: "RA4", quantite: 10, prixUnitaire: prix / 10 }, { designation: "Toner HP 26A", reference: "T26A", quantite: 2, prixUnitaire: 12_000 }]),
    }));
    expect(a.ok, a.ok ? "" : a.error).toBe(true);
    devisA = a.id!;
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: devisA } });
    expect(doc).toMatchObject({ kind: "QUOTE", sourceType: "ADMIN_REQUEST", sourceId: demandeId, counterpartyIds: [fournisseur] });
    expect(await prisma.document.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: devisA, category: "QUOTE" } })).toBe(1);
    expect(await notifs("dem", "Devis à retenir")).toBe(1);

    // Un second devis, d'abord déposé seul, puis retranscrit depuis sa carte.
    const b = await deposerDevisDemande(form({ id: demandeId, supplierId: fournisseur2, attachment: pdf("devis-bureau-plus.pdf") }));
    expect(b.ok, b.ok ? "" : b.error).toBe(true);
    devisB = b.id!;
    const lb = await enregistrerLignesDevisDemande(form({ id: demandeId, devisId: devisB, lignes: lignes([{ designation: "Classeurs", quantite: 20, prixUnitaire: 450, tva: 19 }]) }));
    expect(lb.ok, lb.ok ? "" : lb.error).toBe(true);

    const lu = await devisDeLaDemande(demandeId);
    expect(lu.devis.map((d) => d.natif.lignes.length)).toEqual([2, 1]);
    expect(lu.aGenerer).toEqual([]);
  });

  it("GARDES : le demandeur ne retranscrit pas ; l'assistante ne retient pas à sa place ; un tiers ne lit pas le devis", async () => {
    await comme("dem");
    expect((await enregistrerLignesDevisDemande(form({ id: demandeId, devisId: devisA, lignes: lignes([{ designation: "x", quantite: 1, prixUnitaire: 1 }]) }))).ok).toBe(false);
    expect(await canAccessEntity(await actorFor(u.dem), "LEGAL_DOCUMENT", devisA, "VIEW"), "le demandeur lit le devis de SA demande").toBe(true);
    expect(await canAccessEntity(await actorFor(u.autre), "LEGAL_DOCUMENT", devisA, "VIEW"), "un tiers ne le lit pas").toBe(false);
    await comme("asst");
    const lu = await devisDeLaDemande(demandeId);
    const r = await retenirLignesDevisDemande(form({ id: demandeId, devisId: devisA, ligneId: [lu.devis[0].natif.lignes[0].id] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/demandeur/);
  });

  it("le demandeur RETIENT des lignes sur les deux devis : un BC à générer PAR FOURNISSEUR", async () => {
    await comme("dem");
    const lu = await devisDeLaDemande(demandeId);
    const [la, lb] = [lu.devis[0].natif.lignes, lu.devis[1].natif.lignes];
    const r1 = await retenirLignesDevisDemande(form({ id: demandeId, devisId: devisA, ligneId: [la[0].id] }));
    expect(r1.ok, r1.ok ? "" : r1.error).toBe(true);
    const r2 = await retenirLignesDevisDemande(form({ id: demandeId, devisId: devisB, ligneId: [lb[0].id] }));
    expect(r2.ok, r2.ok ? "" : r2.error).toBe(true);
    const apres = await devisDeLaDemande(demandeId);
    expect(apres.aGenerer.map((g) => g.fournisseurId).sort()).toEqual([fournisseur, fournisseur2].sort());
    expect(apres.aGenerer.find((g) => g.fournisseurId === fournisseur)!.lignes.map((l) => l.designation)).toEqual(["Ramette A4 80 g"]);
  });

  it("le demandeur GÉNÈRE le BC du fournisseur : la fabrique l'émet (chaîné au devis), l'aiguillage l'envoie au centre ; l'assistante le voit", async () => {
    await comme("asst");
    const refus = await genererBonDeCommandeDemande(form({ id: demandeId, fournisseur: `id:${fournisseur}` }));
    expect(refus.ok, "l'assistante ne génère pas à la place du demandeur").toBe(false);

    expect((await ouvrirApercuBcDemande(form({ id: demandeId, fournisseur: `id:${fournisseur}` }))).ok, "ni n'ouvre son aperçu").toBe(false);

    await comme("dem");
    // L'APERÇU OBLIGATOIRE (Direction, 14/10/2026) : sans l'aperçu, rien ne s'émet ; l'aperçu, ses totaux et son PDF n'écrivent RIEN.
    const bcsDeLaDemande = () => prisma.legalDocument.count({ where: { kind: "PURCHASE_ORDER", sourceType: "ADMIN_REQUEST", sourceId: demandeId } });
    const sansApercu = await genererBonDeCommandeDemande(form({ id: demandeId, fournisseur: `id:${fournisseur}` }));
    expect(sansApercu.ok, "un BC que personne n'a relu ne s'émet pas").toBe(false);
    expect(sansApercu.ok ? "" : sansApercu.error).toMatch(/s'émet depuis son aperçu/);
    const ouvert = await ouvrirApercuBcDemande(form({ id: demandeId, fournisseur: `id:${fournisseur}` }));
    expect(ouvert.ok, ouvert.ok ? "" : ouvert.error).toBe(true);
    if (!ouvert.ok) return;
    expect(ouvert.valeurs.lignes.map((l) => l.designation)).toEqual(["Ramette A4 80 g"]);
    expect(ouvert.valeurs.champs.objet).toMatch(/Fournitures du 2e étage/);
    // Le demandeur corrige l'aperçu — tout se corrige, comme à la révision : contact, livraison, notes, mentions.
    const v = structuredClone(ouvert.valeurs);
    v.champs = { ...v.champs, contactNom: "M. Karim Saadi", contactTelephone: "0661 00 00 00", livraisonAdresse: "Siège, 2e étage", livraisonDate: `${new Date().getUTCFullYear()}-12-15`, notes: "Livrer le matin." };
    v.mentions = "Livraison franco de port.";
    const t = await previsualiserApercuBcDemande(formulaireDuComposeur(v, { id: demandeId, fournisseur: `id:${fournisseur}` }));
    expect(t.ok, t.ok ? "" : t.error).toBe(true);
    if (t.ok) expect(t.totaux?.totalTtc).toBeCloseTo(prix * 1.19, 0);
    expect(await bcsDeLaDemande(), "l'aperçu n'écrit rien : ni pièce, ni numéro").toBe(0);

    const r = await genererBonDeCommandeDemande(formulaireDuComposeur(v, { id: demandeId, fournisseur: `id:${fournisseur}` }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    bcId = r.id!;
    const spec = (await prisma.legalDocument.findUniqueOrThrow({ where: { id: bcId }, select: { custom: true } })).custom as { fabrique: { spec: Record<string, unknown> } };
    expect(spec.fabrique.spec, "le BC émis porte ce que l'aperçu a corrigé").toMatchObject({
      contact: { nom: "M. Karim Saadi", telephone: "0661 00 00 00" }, livraison: { adresse: "Siège, 2e étage", date: `${new Date().getUTCFullYear()}-12-15` },
      notes: "Livrer le matin.", mentionsPiece: ["Livraison franco de port."],
    });
    const bc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: bcId } });
    expect(bc).toMatchObject({ kind: "PURCHASE_ORDER", sourceType: "ADMIN_REQUEST", sourceId: demandeId, chainFromId: devisA, companyId });
    expect(Number(bc.amount)).toBeCloseTo(prix * 1.19, 0);
    expect(await porteDuBC(bcId)).toMatchObject({ centre: "VALIDATION", etat: "EN_ATTENTE" });
    expect(await notifs("asst", "Bon de commande généré par le demandeur")).toBe(1);

    const lu = await devisDeLaDemande(demandeId);
    expect(lu.devis[0].natif.lignes.find((l) => l.retenue)!.bcId).toBe(bcId);
    expect(lu.aGenerer.map((g) => g.fournisseurId), "Atlas est commandé ; Bureau Plus reste à générer").toEqual([fournisseur2]);
    expect(lu.bcs.find((b) => b.id === bcId)?.etape).toBe("A_VALIDER");
    // Une ligne commandée ne se décoche plus, et le devis ne se retranscrit plus.
    const decocher = await retenirLignesDevisDemande(form({ id: demandeId, devisId: devisA }));
    expect(decocher.ok).toBe(false);
    await comme("asst");
    expect((await enregistrerLignesDevisDemande(form({ id: demandeId, devisId: devisA, lignes: lignes([{ designation: "x", quantite: 1, prixUnitaire: 1 }]) }))).ok).toBe(false);
  });

  it("RÉVISER LE BC DEPUIS LA DEMANDE (Direction, 14/10/2026) : le demandeur, sans Legal, le modifie de A à Z tant qu'il n'est pas signé — un tiers non", async () => {
    await comme("dem");
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: bcId }, select: { custom: true } });
    const v = valeursComposables(doc.custom)!;
    const version = pieceEmise(doc.custom)!.version;
    v.champs = { ...v.champs, notes: "Livrer au 3e étage, le matin.", conditionsPaiement: "30 jours fin de mois" };
    v.tiers = { ...v.tiers, email: "commandes@atlas.dz" };
    const formulaire = () => formulaireDuComposeur(v, { legalDocumentId: bcId, revisionDe: bcId, versionVue: String(version), motif: "Étage et e-mail du fournisseur." });
    // L'aperçu de la révision et la révision : le composeur de la fiche Legal, sous la délégation de la demande.
    const apercu = await previsualiserPieceCommerciale(undefined, formulaire());
    expect(apercu.ok, apercu.ok ? "" : apercu.error).toBe(true);
    const r = await reviserPieceCommerciale(undefined, formulaire());
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const apres = (await prisma.legalDocument.findUniqueOrThrow({ where: { id: bcId }, select: { custom: true } })).custom as { fabrique: { version: number; spec: { notes: string; conditionsPaiement: string; tiers: { email: string } } } };
    expect(apres.fabrique.version).toBe(version + 1);
    expect(apres.fabrique.spec).toMatchObject({ notes: "Livrer au 3e étage, le matin.", conditionsPaiement: "30 jours fin de mois", tiers: { email: "commandes@atlas.dz" } });
    // Le BC révisé reste dans son circuit : le centre de validations l'attend toujours.
    expect((await etatDuBC(bcId))?.etape).toBe("A_VALIDER");
    // Un délégué sans rapport avec la demande n'a pas cette délégation.
    ACTOR = await actorFor(u.autre);
    const tiers = await reviserPieceCommerciale(undefined, formulaireDuComposeur(v, { legalDocumentId: bcId, versionVue: String(version + 1), motif: "Tentative." }));
    expect(tiers.ok).toBe(false);
  });

  it("LE N° DE RÉFÉRENCE SE MODIFIE DANS LA MÊME RÉVISION (Direction, 14/10/2026) : unique dans la série, tracé, le circuit inchangé", async () => {
    await comme("dem");
    const lire = () => prisma.legalDocument.findUniqueOrThrow({ where: { id: bcId }, select: { custom: true, reference: true } });
    const doc = await lire();
    const v = valeursComposables(doc.custom)!;
    const ancien = doc.reference!;
    const autre = await prisma.legalDocument.create({ data: { companyId, kind: "PURCHASE_ORDER", title: `${TAG} autre BC`, reference: `${TAG}-BC-PRIS`, counterparty: "x" }, select: { id: true } });
    const formulaire = (numeroRevise: string) => formulaireDuComposeur(v, {
      legalDocumentId: bcId, revisionDe: bcId, versionVue: String(pieceEmise(doc.custom)!.version), motif: "Numéro de la série papier.", numeroRevise, numeroActuel: ancien,
    });
    const pris = await reviserPieceCommerciale(undefined, formulaire(`${TAG}-bc-pris`));
    expect(pris.ok).toBe(false);
    expect(pris.ok ? "" : pris.error).toMatch(/déjà porté/);
    // L'aperçu imprime déjà le nouveau numéro ; la révision l'écrit.
    const nouveau = ancien.replace(/\d+$/, (n) => String(Number(n) + 500).padStart(n.length, "0"));
    const ap = await previsualiserPieceCommerciale(undefined, formulaire(nouveau));
    expect(ap.ok && ap.numeroProchain).toBe(nouveau);
    const r = await reviserPieceCommerciale(undefined, formulaire(nouveau));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await lire()).reference).toBe(nouveau);
    expect(await prisma.auditLog.findFirst({ where: { entityId: bcId, field: "numero" }, select: { oldValue: true, newValue: true } })).toEqual({ oldValue: ancien, newValue: nouveau });
    // Seulement le numéro : le BC reste où il était dans son circuit.
    expect((await etatDuBC(bcId))?.etape).toBe("A_VALIDER");
    await prisma.legalDocument.delete({ where: { id: autre.id } });
  });

  it("« Terminer » attend la signature : refusé tant que le BC est au centre", async () => {
    await comme("asst");
    const r = await finishRequest(form({ id: demandeId, budgetDepartmentId: departementId, budgetAmount: "1000", facture: pdf("facture.pdf") }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/pas encore signé et validé/);
    // La facture n'est pas déposée par un geste refusé.
    expect(await prisma.document.count({ where: { entityType: "ADMIN_REQUEST", entityId: demandeId, category: "INVOICE" } })).toBe(0);
  });

  it("le centre VALIDE → à signer ; les Finances SIGNENT → « Signé et validé » sur la demande, l'assistante et le demandeur prévenus", async () => {
    await comme("dem");
    const relance = await relancerDemande(form({ id: demandeId }));
    expect(relance.ok, relance.ok ? "" : relance.error).toBe(true);
    if (relance.ok) expect(relance.message).toMatch(/centre de validations/);
    expect((await relancerDemande(form({ id: demandeId }))).ok, "une relance par jour").toBe(false);

    const porte = await prisma.validationRequest.findFirstOrThrow({ where: { entityType: "LEGAL_DOCUMENT", entityId: bcId, objectType: OBJET_BC, status: "PENDING" }, include: { steps: true } });
    ACTOR = await actorFor(porte.steps[0].validatorId);
    const v = await decideValidation(form({ stepId: porte.steps[0].id, decision: "APPROVED" }));
    expect(v.ok, v.ok ? "" : v.error).toBe(true);
    expect((await etatDuBC(bcId))?.etape).toBe("A_SIGNER");

    await comme("fin");
    const s = await signerBonDeCommande(avecCopieSignee(form({ id: bcId })));
    expect(s.ok, s.ok ? "" : s.error).toBe(true);
    const lu = await devisDeLaDemande(demandeId);
    const etat = lu.bcs.find((b) => b.id === bcId)!;
    expect(etat.etape).toBe("SIGNE");
    expect(LIBELLE_BC_DEMANDE[etat.etape]).toBe("Signé et validé");
    expect(await notifs("asst", "Bon de commande signé et validé")).toBe(1);
    expect(await notifs("dem", "Bon de commande signé et validé")).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: "ADMIN_REQUEST", entityId: demandeId, summary: { contains: "signé et validé" } } })).toBe(1);
  });

  it("le BC signé : « Terminer » passe — facture jointe DANS la même fenêtre, imputation au budget", async () => {
    // Le second fournisseur n'a pas de BC : rien n'est en route, la demande peut se terminer.
    await comme("asst");
    const r = await finishRequest(form({ id: demandeId, budgetDepartmentId: departementId, budgetAmount: String(prix), facture: pdf("facture-atlas.pdf") }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: demandeId } })).status).toBe("DONE");
    expect(await prisma.document.count({ where: { entityType: "ADMIN_REQUEST", entityId: demandeId, category: "INVOICE" } })).toBe(1);
    // Une demande terminée ne génère plus de BC.
    await comme("dem");
    expect((await genererBonDeCommandeDemande(form({ id: demandeId, fournisseur: `id:${fournisseur2}` }))).ok).toBe(false);
  });

  it("OU LE TÉLÉCHARGER : le demandeur dépose un BC déjà fait — chaîné au devis, ses lignes retenues portées, même porte", async () => {
    const id = await nouvelleDemande("Café et gobelets");
    await comme("asst");
    const d = await deposerDevisDemande(form({
      id, supplierId: fournisseur, attachment: pdf("devis-cafe.pdf"),
      lignes: lignes([{ designation: "Café moulu 1 kg", quantite: 10, prixUnitaire: prix / 10 }]),
    }));
    expect(d.ok, d.ok ? "" : d.error).toBe(true);
    await comme("dem");
    const ligne = (await devisDeLaDemande(id)).devis[0].natif.lignes[0];
    expect((await retenirLignesDevisDemande(form({ id, devisId: d.id!, ligneId: [ligne.id] }))).ok).toBe(true);

    const sansMontant = await deposerBonDeCommandeDemande(form({ id, devisId: d.id!, attachment: pdf("bc.pdf") }));
    expect(sansMontant.ok).toBe(false);
    const autre = await actorFor(u.autre);
    ACTOR = autre;
    expect((await deposerBonDeCommandeDemande(form({ id, devisId: d.id!, amount: String(prix * 1.19), attachment: pdf("bc.pdf") }))).ok, "un tiers ne dépose pas").toBe(false);

    await comme("dem");
    const r = await deposerBonDeCommandeDemande(form({ id, devisId: d.id!, reference: "BC-EXT-7", amount: String(prix * 1.19), attachment: pdf("bc-signe-fournisseur.pdf") }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const bc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.id! } });
    expect(bc).toMatchObject({ kind: "PURCHASE_ORDER", sourceType: "ADMIN_REQUEST", sourceId: id, chainFromId: d.id, reference: "BC-EXT-7", counterpartyIds: [fournisseur] });
    expect(await prisma.document.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: bc.id, category: "PURCHASE_ORDER" } })).toBe(1);
    expect(await porteDuBC(bc.id)).toMatchObject({ centre: "VALIDATION", etat: "EN_ATTENTE" });
    const lu = await devisDeLaDemande(id);
    expect(lu.devis[0].natif.lignes[0].bcId).toBe(bc.id);
    expect(lu.aGenerer, "la ligne est portée par le BC déposé : rien à générer").toEqual([]);
    expect(await notifs("asst", "Bon de commande déposé")).toBe(1);
  });
});
