import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, requireModule: async () => ACTOR,
  getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR, getUser: async () => ACTOR,
}));
/** La lecture d'une pièce par le modèle est un service externe : ici, elle échoue — les lignes se saisissent à la main. */
vi.mock("@/lib/pieces-lues/service", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/pieces-lues/service")>();
  return { ...vrai, proposerLecture: async () => ({ ok: false, error: "Lecture coupée dans ce banc." }) };
});

import bcrypt from "bcryptjs";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { deleteFileByKey } from "@/lib/storage";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { lienPosteAdPro, lienPosteAssistante } from "@/lib/chemins/ad-pro";
import { stepCreate } from "@/lib/workflow/engine";
import { defaultDefinition } from "@/lib/workflow/defaults";
import { SLUG_DIRECTION, SLUG_MARKETING, SLUG_PRELIMINAIRE } from "@/lib/workflow/parcours";
import { advanceWorkflow } from "@/lib/actions/workflow-actions";
import { commencerEnrolement, confirmerEnrolement } from "@/lib/signature-en-ligne/second-facteur";
import { codeDuPas, depuisBase32, pasDe } from "@/lib/signature-en-ligne/totp";
import { deposerVisuel } from "@/lib/signature-en-ligne/visuels";
import { signerBonDeCommandeEnLigne } from "@/lib/actions/bc-signature-actions";
import { fileBonsDeCommande } from "@/lib/queries/bons-de-commande";
import { etatDuBC } from "@/lib/bons-de-commande/etat";
import { globalSearch } from "@/lib/queries/search";
import { perimetreLegal } from "@/lib/queries/visibilite-listes";
import { statuerTotalDg } from "@/lib/actions/porte-dg-actions";
import { pharmacienAssigne } from "@/lib/medical-info";
import { decidePayment } from "@/modules/finances/actions-centre";
import { settleExpenseOrder } from "@/modules/finances/actions-depenses";
import { chargerCentre } from "@/modules/finances/api";
import { createEvent, submitEventForApproval } from "../actions-evenements";
import { addAdProItem, submitAdProItem, approveAdProItemOrder } from "../actions-postes";
import { decideAdProItem, retirerDemandeBC, annulerOrdrePoste } from "../actions-postes-decision";
import { ajouterDevisPoste, deposerFacturePoste, demanderPaiementPoste } from "../actions-postes-paiement";
import { enregistrerLignesDuDevis, preparerBrouillonPoste } from "../actions-postes-lignes";
import { transmettreDevisAgences, retenirLignesDesAgences, soumettreBcMarketing, validerSignerBcMarketing } from "../actions-postes-agence";
import { marquerBcEnvoye, envoyerBatConformite, deciderConformitePoste, signerReceptionPoste } from "../actions-postes-execution";
import { valeurDeLigne } from "../domaine/choix-agences";
import { CHAMPS_MEDECINS, CHAMPS_PRODUITS } from "../domaine/pickers";
import { etapeAgence, pasAgence, type FaitsPosteAgence, type RegardAgence } from "../domaine/parcours-agence";
import { toutEstFacture } from "../domaine/poste-etapes";
import { loadAdProItems } from "./requetes/postes";
import { demandesAuCentreAdPro } from "./requetes/centre";
import { fileAgences } from "./requetes/file-agences";
import { lirePorteDg } from "./porte-dg";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RECETTE DE BOUT EN BOUT — LE CIRCUIT AGENCE D'UNE DEMANDE AD & PRO, PHASE PAR PHASE (base réelle, 23/11/2026).
 *
 * UNE demande (un événement d'un délégué), les VRAIS rôles, les VRAIES actions des écrans — seuls `next/cache`, les
 * en-têtes et la session sont simulés ; la signature en ligne passe par le VRAI contrôle renforcé (mot de passe + code
 * TOTP d'un second facteur enrôlé par ses propres fonctions) et le vrai sceau (signature + cachet déposés).
 *
 *   1. l'événement naît sans budget ni date de fin, se soumet, et le circuit le mène à la prévalidation de la DM ;
 *   2. la DM ajoute un poste « Stand » par une agence, cahier des charges compris, en UN appel ;
 *   3. l'assistante dépose trois devis (lignes saisies) et les transmet ;
 *   4. la DM retient des lignes de DEUX devis : le poste est scindé (A > 1 000 000 TTC, B < 1 000 000), le 3e non retenu ;
 *   5. BC : finalisé, validé + signé par la DM ; A au centre (visa du DG), B direct aux Finances ; refus du DG sur une copie ;
 *   6. exécution : BC envoyé, BAT (non conforme puis conforme), PV de réception ;
 *   7. facture contrôlée contre le BC (et les doublons), demande de paiement ;
 *   8. centre de paiement : le DG autorise, les Finances règlent ; branche du refus ;
 *   9. Legal : dossier « Événements › <année> › <nom> », recherche « BC <mot> » ;
 *  10. un poste DIRECT (association) : pro forma, paiement ;
 *  11. la déclaration d'information médicale s'ouvre quand tous les postes sont prêts — accordés, devis validé (le choix de
 *      l'agence valide les lignes retenues ; le versement direct n'a pas de devis) ; un brouillon la retient : il est retiré.
 *
 * Le seuil des BC (`AppSetting.bcValidationThreshold`) est posé à 1 000 000 DZD pour la durée du banc, puis rendu.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const RUN = Date.now().toString(36);
const TAG = `__e2e${RUN}__`;
const MOT = `Quetzal${RUN}`; // le mot de l'événement que la recherche doit retrouver
const DEBUT = new Date(Date.now() - 2_000);
const MDP = "Banc-Signature-2026!";
const SEUIL_BC = 1_000_000;

const ROLES = {
  kam: "MEDICAL_DELEGATE", ns: "NATIONAL_SALES", od: "OPERATIONS_DIRECTOR", dm: "PRODUCT_MANAGER",
  ast: "DIRECTION_ASSISTANT", dg: "GENERAL_MANAGER", fin: "FINANCE_BUDGET_MANAGER", pharm: "MEDICAL_INFO_PHARMACIST",
} as const;
type Qui = keyof typeof ROLES;

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, secondaryRole: null, access: await getAccess(id, role), mustChangePassword: false } as CurrentUser;
}
const su = (u: CurrentUser) => u as unknown as SessionUser;
const fd = (c: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(c)) f.set(k, v); return f; };
/** Un fichier DISTINCT par dépôt : deux factures identiques seraient la même facture. */
const pdf = (nom: string, graine = `${Date.now()}-${Math.random()}`) =>
  new File([Buffer.from(`%PDF-1.4\n% ${nom} ${graine}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`)], nom, { type: "application/pdf" });
const msg = (r: { ok: boolean; error?: string; message?: string }) => JSON.stringify(r);

interface Ligne { ref: string; q: number; p: number }

suite("Recette de bout en bout — le circuit agence d'un événement, phase par phase (base réelle)", () => {
  const u = {} as Record<Qui, string>;
  const comme = async (qui: Qui) => { ACTOR = await acteur(u[qui], ROLES[qui]); return ACTOR; };
  let societe = "", envId = "", catId = "", defId = "", eventId = "";
  let seuilAvant: number | null = null;
  let ligneReglages = false;
  const secrets: Record<string, string> = {};
  const dossiersAvant = new Set<string>();

  // Les postes et pièces du scénario, posés au fil des phases.
  const P = { stand: "", standB: "", copie: "", direct: "", brouillon: "" };
  const D = { a: "", b: "", c: "", d: "" }; // devis (pièces Legal)
  const L: Record<string, string[]> = {}; // lignes des devis, dans l'ordre
  const BC = { a: "", b: "", copie: "" };
  const ORDRE = { a: "", b1: "", b2: "", direct: "" };

  /** Les faits du parcours d'un poste, lus comme la carte du poste les lit (`faitsAgenceDuPoste`, écran) — même traduction. */
  async function faitsDe(itemId: string): Promise<FaitsPosteAgence | null> {
    const item = (await loadAdProItems("EVENT", eventId)).find((i) => i.id === itemId);
    if (!item?.agence) return null;
    return {
      status: item.status, orderStage: item.orderStage,
      bc: item.pieces.bc && !item.pieces.bc.annulee ? (item.pieces.bc.etape ?? "HORS_CIRCUIT") : null,
      factures: item.pieces.factures.length, toutFacture: toutEstFacture(item.pieces), expenseOrderId: item.expenseOrderId,
      expenseOrderStatus: item.expenseOrder?.status ?? null, expenseOrderCentral: item.expenseOrder?.centralStatus ?? null,
      orderDecisionNote: item.orderDecisionNote ?? null,
      agence: item.agence.faits,
    };
  }
  const REGARD_DM: RegardAgence = { marketing: true, assistante: false, infoMed: false, centre: false, fige: false };

  /** Le code de l'application d'authentification, maintenant — le pas déjà servi est remis à zéro (un code par signature). */
  async function code(qui: Qui): Promise<string> {
    await prisma.secondFacteur.update({ where: { userId: u[qui] }, data: { dernierPas: 0 } });
    return codeDuPas(depuisBase32(secrets[u[qui]]!), pasDe(Date.now()));
  }
  /** Prépare un signataire comme « Ma signature » : mot de passe, second facteur enrôlé, signature et cachet déposés. */
  async function signataire(qui: Qui) {
    await prisma.user.update({ where: { id: u[qui] }, data: { passwordHash: await bcrypt.hash(MDP, 4) } });
    const { secret } = await commencerEnrolement(u[qui], `${TAG}${qui}@t.dz`);
    secrets[u[qui]] = secret;
    const err = await confirmerEnrolement(u[qui], codeDuPas(depuisBase32(secret), pasDe(Date.now())));
    if (err) throw new Error(`enrôlement ${qui} : ${err}`);
    const noir = await sharp({ create: { width: 90, height: 24, channels: 3, background: "#000000" } }).png().toBuffer();
    const image = await sharp({ create: { width: 160, height: 80, channels: 3, background: "#ffffff" } })
      .composite([{ input: noir, top: 28, left: 35 }]).png().toBuffer();
    for (const nature of ["SIGNATURE", "CACHET"] as const) {
      const e = await deposerVisuel(u[qui], nature, new File([new Uint8Array(image)], `${nature}.png`, { type: "image/png" }));
      if (e) throw new Error(`visuel ${nature} ${qui} : ${e}`);
    }
  }

  /** Un devis d'agence déposé par l'assistante, puis ses lignes saisies (TVA 19 %) — comme sur sa page. */
  async function devisAgence(itemId: string, agence: string, lignes: Ligne[]): Promise<string> {
    ACTOR = await comme("ast");
    const f = fd({ id: itemId, fournisseur: agence, reference: `${TAG}DV-${agence}` });
    f.append("attachment", pdf(`devis-${agence}.pdf`));
    const r = await ajouterDevisPoste(undefined, f);
    expect(r.ok, `dépôt du devis ${agence} : ${msg(r)}`).toBe(true);
    const pieceId = r.ok ? r.id! : "";
    const g = fd({ id: itemId, pieceId, tvaRate: "19" });
    for (const l of lignes) {
      g.append("ligneId", ""); g.append("ligneReference", l.ref); g.append("ligneUnite", "u");
      g.append("ligneQuantite", String(l.q)); g.append("lignePrix", String(l.p));
    }
    const s = await enregistrerLignesDuDevis(g);
    expect(s.ok, `lignes du devis ${agence} : ${msg(s)}`).toBe(true);
    L[pieceId] = (await prisma.adProDevisLigne.findMany({ where: { devis: { legalDocumentId: pieceId } }, orderBy: { position: "asc" }, select: { id: true } })).map((x) => x.id);
    expect(L[pieceId]!.length, `${agence} : toutes ses lignes sont enregistrées`).toBe(lignes.length);
    return pieceId;
  }

  const bcActifDe = async (itemId: string) => (await prisma.adProItemPiece.findFirst({
    where: { itemId, nature: "BON_DE_COMMANDE", legalDocument: { status: { not: "CANCELLED" } } }, orderBy: { createdAt: "desc" }, select: { legalDocumentId: true },
  }))?.legalDocumentId ?? "";
  const notifs = (qui: Qui, where: Record<string, unknown>) => prisma.notification.findMany({ where: { userId: u[qui], createdAt: { gte: DEBUT }, ...where } });

  beforeAll(async () => {
    // LE SEUIL DES BC : 1 000 000 DZD pour ce banc, rendu à la fin.
    const reglages = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { bcValidationThreshold: true } });
    ligneReglages = Boolean(reglages);
    seuilAvant = reglages ? Number(reglages.bcValidationThreshold) : null;
    await prisma.appSetting.upsert({ where: { id: "global" }, create: { id: "global", bcValidationThreshold: SEUIL_BC }, update: { bcValidationThreshold: SEUIL_BC } });

    for (const qui of Object.keys(ROLES) as Qui[]) {
      u[qui] = (await prisma.user.create({ data: { name: `${TAG}${qui}`, email: `${TAG}${qui}@t.dz`, role: ROLES[qui], passwordHash: "x" } })).id;
    }
    // LA SOCIÉTÉ QUI COMMANDE : identité légale (le BC la porte), et chacun des acteurs y est salarié.
    societe = (await prisma.company.create({ data: { name: `${TAG} Labo`, shortName: `E2E${RUN.slice(-5)}`, color: "#1B7F79" } })).id;
    await prisma.companyLegalIdentity.create({
      data: {
        companyId: societe, legalName: `${TAG} Labo SARL`, legalForm: "SARL", rcNumber: "16/00-4444444B23", nif: "001916044444444", nis: "001916044444490",
        taxArticle: "16044444444", headOffice: "4 rue du Labo, Alger", phone: "021 44 44 44", email: null,
      },
    });
    for (const qui of Object.keys(ROLES) as Qui[]) await prisma.employee.create({ data: { fullName: `${TAG} ${qui}`, userId: u[qui], companyId: societe } });
    envId = (await prisma.budgetEnvelope.create({
      data: { name: `${TAG}Enveloppe`, modules: ["EVENTS"], totalAmount: 50_000_000, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31") },
      select: { id: true },
    })).id;
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Événementiel`, allocated: 50_000_000 }, select: { id: true } })).id;
    // LE CIRCUIT DU BANC : une copie PRIVÉE du circuit par défaut des événements (un voisin peut retoucher le circuit partagé).
    const d = defaultDefinition("EVENTS");
    defId = (await prisma.workflowDefinition.create({ data: { category: `${TAG}EVENTS`, name: `${TAG}${d.name}`, steps: { create: d.steps.map(stepCreate) } } })).id;
    for (const f of await prisma.legalFolder.findMany({ select: { id: true } })) dossiersAvant.add(f.id);
    await signataire("dm");
    await signataire("fin");
  }, 180_000);

  afterAll(async () => {
    const ids = Object.values(u).filter(Boolean);
    const postes = eventId ? (await prisma.adProItem.findMany({ where: { eventId }, select: { id: true, expenseOrderId: true } }).catch(() => [])) : [];
    const posteIds = postes.map((p) => p.id);
    const liens = await prisma.adProItemPiece.findMany({ where: { itemId: { in: posteIds } }, select: { legalDocumentId: true } }).catch(() => []);
    const legaux = [...new Set([
      ...liens.map((l) => l.legalDocumentId),
      ...(await prisma.legalDocument.findMany({ where: { OR: [{ sourceId: eventId || "-" }, { createdById: { in: ids } }, { companyId: societe || "-" }] }, select: { id: true } }).catch(() => [])).map((x) => x.id),
    ])];
    const ordres = (await prisma.expenseOrder.findMany({ where: { OR: [{ sourceId: eventId || "-" }, { requestedById: { in: ids } }] }, select: { id: true, transactionId: true } }).catch(() => []));
    const ordreIds = ordres.map((o) => o.id);
    await prisma.comment.deleteMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: posteIds } } }).catch(() => {});
    await retirerDocumentsEtContenu({ where: { OR: [{ entityType: "AD_PRO_ITEM", entityId: { in: posteIds } }, { entityType: "LEGAL_DOCUMENT", entityId: { in: legaux } }, { entityId: eventId || "-" }] } }).catch(() => {});
    await prisma.signatureBC.deleteMany({ where: { legalDocumentId: { in: legaux } } }).catch(() => {});
    await prisma.bcBrouillonVersion.deleteMany({ where: { itemId: { in: posteIds } } }).catch(() => {});
    await prisma.adProItemPiece.deleteMany({ where: { itemId: { in: posteIds } } }).catch(() => {});
    await prisma.adProDevisLigne.deleteMany({ where: { devis: { legalDocumentId: { in: legaux } } } }).catch(() => {});
    await prisma.adProDevis.deleteMany({ where: { legalDocumentId: { in: legaux } } }).catch(() => {});
    const vIds = (await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: legaux } }, select: { id: true } }).catch(() => [])).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: legaux } } }).catch(() => {});
    await prisma.adProItem.updateMany({ where: { id: { in: posteIds } }, data: { expenseOrderId: null } }).catch(() => {});
    await prisma.legalDocument.updateMany({ where: { id: { in: legaux } }, data: { expenseOrderId: null, chainFromId: null } }).catch(() => {});
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordreIds } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordreIds } } }).catch(() => {});
    const declarations = (await prisma.medicalInfoDeclaration.findMany({ where: { sourceId: eventId || "-" }, select: { id: true } }).catch(() => [])).map((x) => x.id);
    await prisma.notification.deleteMany({ where: { OR: [...declarations, ...posteIds].map((id) => ({ link: { contains: id } })) } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: declarations } } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { sourceId: eventId || "-" } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordreIds } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { id: { in: ordres.map((o) => o.transactionId).filter((x): x is string => Boolean(x)) } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: legaux } } }).catch(() => {});
    await prisma.documentSequence.deleteMany({ where: { companyId: societe || "-" } }).catch(() => {});
    await prisma.adProItemDecision.deleteMany({ where: { itemId: { in: posteIds } } }).catch(() => {});
    await prisma.adProExecutionPoste.deleteMany({ where: { itemId: { in: posteIds } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: posteIds } } }).catch(() => {});
    await prisma.adProPorteDg.deleteMany({ where: { entityId: eventId || "-" } }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: eventId || "-" } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: eventId || "-" } }).catch(() => {});
    await prisma.workflowStep.deleteMany({ where: { definitionId: defId || "-" } }).catch(() => {});
    await prisma.workflowDefinition.deleteMany({ where: { id: defId || "-" } }).catch(() => {});
    await prisma.adProMedecin.deleteMany({ where: { entityType: "EVENT", entityId: eventId || "-" } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: eventId || "-" } }).catch(() => {});
    // Les dossiers Legal que le banc a fait naître (la feuille de l'événement ; l'année et la racine seulement s'ils sont neufs et vides).
    const neufs = (await prisma.legalFolder.findMany({ select: { id: true, parentId: true } }).catch(() => [])).filter((f) => !dossiersAvant.has(f.id));
    for (let tour = 0; tour < 3; tour++) {
      for (const f of neufs) {
        const occupe = (await prisma.legalFolder.count({ where: { parentId: f.id } })) + (await prisma.legalDocument.count({ where: { folderId: f.id } }));
        if (occupe === 0) await prisma.legalFolder.deleteMany({ where: { id: f.id } }).catch(() => {});
      }
    }
    await prisma.budgetCategoryLine.deleteMany({ where: { envelopeId: envId || "-" } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId || "-" } }).catch(() => {});
    // Les rôles prévenus (Finances, DG, Super Admin, pharmaciens) comptent aussi des comptes permanents : on retire par le LIEN.
    await prisma.notification.deleteMany({
      where: { OR: [
        { userId: { in: ids } }, { link: { contains: eventId || "-" } }, { link: { in: posteIds.map(lienPosteAssistante) } },
        ...legaux.map((l) => ({ link: { contains: l } })), ...ordreIds.map((o) => ({ link: { contains: o } })),
        { body: { contains: TAG } }, { title: { contains: TAG } },
      ] },
    }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: [...posteIds, ...legaux, ...ordreIds, eventId || "-"] } }] } }).catch(() => {});
    // La signature en ligne : visuels (et leurs fichiers chiffrés), second facteur, compteurs d'essais.
    const visuels = await prisma.signatureVisuelle.findMany({ where: { userId: { in: ids } }, select: { fichierCle: true } }).catch(() => []);
    for (const v of visuels) await deleteFileByKey(v.fichierCle).catch(() => {});
    await prisma.signatureVisuelle.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.secondFacteur.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.loginAttempt.deleteMany({ where: { email: { in: ids.map((id) => `signature:${id}`) } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { companyId: societe || "-" } }).catch(() => {});
    await prisma.companyLegalIdentity.deleteMany({ where: { companyId: societe || "-" } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: societe || "-" } }).catch(() => {});
    // LE SEUIL DES BC, RENDU.
    if (ligneReglages && seuilAvant !== null) await prisma.appSetting.update({ where: { id: "global" }, data: { bcValidationThreshold: seuilAvant } }).catch(() => {});
    else if (!ligneReglages) await prisma.appSetting.deleteMany({ where: { id: "global" } }).catch(() => {});
  }, 180_000);

  // ═════════════════════════════ 1. L'ÉVÉNEMENT, SA SOUMISSION, LA PRÉVALIDATION ═════════════════════════════
  it("1. l'événement naît sans budget ni date de fin, se soumet, et le circuit le conduit à la prévalidation de la DM", async () => {
    await comme("kam");
    const f = fd({ name: `${TAG} Journée ${MOT}`, type: "SCIENTIFIC_DAY", scope: "NATIONAL", format: "PRESENTIAL", startDate: "2026-12-10", city: "Oran" });
    f.set(CHAMPS_MEDECINS.libre, `${TAG}Dr Benali`);
    f.set(CHAMPS_PRODUITS.libre, `${TAG}Cardiol`);
    const cree = await createEvent(f);
    expect(cree.ok, msg(cree)).toBe(true);
    eventId = cree.ok ? cree.id! : "";
    const ev = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(ev.estimatedBudget, "budget facultatif, laissé vide").toBeNull();
    expect(ev.endDate?.toISOString(), "sans date de fin, l'événement tient en une journée").toBe(ev.startDate?.toISOString());
    expect(ev.companyId, "la société qui paiera suit le demandeur").toBe(societe);

    const s = await submitEventForApproval(fd({ id: eventId }));
    expect(s.ok, msg(s)).toBe(true);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "EVENT", entityId: eventId } } });
    expect(inst.currentSlug, "un délégué passe d'abord par le National Sales").toBe(SLUG_PRELIMINAIRE);
    await prisma.workflowInstance.update({ where: { id: inst.id }, data: { definitionId: defId } });

    await comme("ns");
    const a1 = await advanceWorkflow(fd({ entityType: "EVENT", entityId: eventId, action: "APPROVE", note: "OK NS" }));
    expect(a1.ok, `National Sales : ${msg(a1)}`).toBe(true);
    expect((await prisma.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } })).currentSlug).toBe(SLUG_DIRECTION);
    await comme("od");
    const a2 = await advanceWorkflow(fd({ entityType: "EVENT", entityId: eventId, action: "APPROVE", note: "OK OD" }));
    expect(a2.ok, `Directeur des opérations : ${msg(a2)}`).toBe(true);
    expect((await prisma.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } })).currentSlug, "la prévalidation de la Direction Marketing est atteinte").toBe(SLUG_MARKETING);
    expect((await notifs("dm", { link: { contains: eventId } })).length, "la Direction Marketing est prévenue").toBeGreaterThanOrEqual(1);

    await comme("dm");
    const a3 = await advanceWorkflow(fd({ entityType: "EVENT", entityId: eventId, action: "APPROVE", note: "Prévalidé" }));
    expect(a3.ok, `Direction Marketing : ${msg(a3)}`).toBe(true);
    const fin = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(fin.status).toBe("APPROVED");
    expect((await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).requestStatus).toBe("APPROVED");
    expect(await prisma.medicalInfoDeclaration.count({ where: { sourceId: eventId } }), "aucun poste encore : aucune déclaration").toBe(0);
  }, 60_000);

  // ═════════════════════════════ 2. LE POSTE « STAND » EN UN GESTE (et les autres postes du scénario) ═════════════════════════════
  it("2. la DM ajoute le poste « Stand » par une agence avec son cahier des charges en UN appel : PENDING, prospection demandée, assistante prévenue vers /agences/<id>", async () => {
    await comme("dm");
    const r = await addAdProItem(undefined, fd({
      parent: "EVENT", parentId: eventId, kind: "STAND", label: `${TAG}Stand`, voie: "AGENCE",
      cahierDesCharges: "Stand 36 m² modulaire, comptoir d'accueil, kakémonos ; montage le 9/12.", assistanteId: u.ast,
    }));
    expect(r.ok, msg(r)).toBe(true);
    expect(r.ok ? r.message : "").toMatch(/^Poste ajouté et soumis — prospection demandée à /);
    P.stand = r.ok ? r.id! : "";
    const p = await prisma.adProItem.findUniqueOrThrow({ where: { id: P.stand }, include: { execution: true } });
    expect(p.status).toBe("PENDING");
    expect(p.voie).toBe("AGENCE");
    expect(p.conformiteRequise, "un stand passe par le contrôle de conformité").toBe(true);
    expect(p.execution?.prospectionDemandeeAt).not.toBeNull();
    expect(p.execution?.assistanteId).toBe(u.ast);
    const n = await notifs("ast", { link: lienPosteAssistante(P.stand) });
    expect(n.map((x) => x.title), "l'assistante est prévenue UNE fois, vers SA page").toEqual(["Prospection d'agences à faire"]);
    expect(n[0]!.link).toBe(`/agences/${P.stand}`);

    // LA COPIE (branche du refus du DG) : un second poste agence, ajouté de même.
    const c = await addAdProItem(undefined, fd({
      parent: "EVENT", parentId: eventId, kind: "PRINTING", label: `${TAG}Kakémonos géants`, voie: "AGENCE",
      cahierDesCharges: "10 kakémonos géants 2×5 m.", assistanteId: u.ast,
    }));
    expect(c.ok, msg(c)).toBe(true);
    P.copie = c.ok ? c.id! : "";

    // LE POSTE DIRECT (association), ajouté SANS montant par le délégué puis soumis — et un BROUILLON jamais soumis.
    await comme("kam");
    const dr = await addAdProItem(undefined, fd({ parent: "EVENT", parentId: eventId, kind: "ASSOCIATION_SUPPORT", label: `${TAG}Soutien association`, voie: "DIRECT" }));
    expect(dr.ok, msg(dr)).toBe(true);
    P.direct = dr.ok ? dr.id! : "";
    const sd = await submitAdProItem(undefined, fd({ id: P.direct }));
    expect(sd.ok, msg(sd)).toBe(true);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: P.direct } })).status).toBe("PENDING");
    const br = await addAdProItem(undefined, fd({ parent: "EVENT", parentId: eventId, kind: "CATERING", label: `${TAG}Pause café (brouillon)`, voie: "DIRECT" }));
    expect(br.ok, msg(br)).toBe(true);
    P.brouillon = br.ok ? br.id! : "";
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: P.brouillon } })).status).toBe("DRAFT");
    // Un brouillon RETIENT la déclaration (recette sponsoring, 23/11/2026) : on le retire, comme le ferait la DM.
    await prisma.adProItem.delete({ where: { id: P.brouillon } });
  }, 60_000);

  // ═════════════════════════════ 3. LES DEVIS DE L'ASSISTANTE ═════════════════════════════
  it("3. l'assistante dépose les devis de trois agences, en saisit les lignes, et les transmet", async () => {
    D.a = await devisAgence(P.stand, `${TAG}Alpha`, [
      { ref: "Stand modulaire 36 m²", q: 1, p: 900_000 }, { ref: "Comptoir d'accueil", q: 1, p: 150_000 }, { ref: "Écran LED", q: 1, p: 300_000 },
    ]);
    D.b = await devisAgence(P.stand, `${TAG}Beta`, [{ ref: "Kakémonos", q: 4, p: 25_000 }, { ref: "Roll-up", q: 2, p: 20_000 }]);
    D.c = await devisAgence(P.stand, `${TAG}Gamma`, [{ ref: "Stand clé en main", q: 1, p: 1_400_000 }]);
    D.d = await devisAgence(P.copie, `${TAG}Delta`, [{ ref: "Kakémono géant", q: 10, p: 100_000 }]);
    for (const id of [D.a, D.b, D.c, D.d]) {
      const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id } });
      expect(doc.kind).toBe("QUOTE");
    }
    await comme("ast");
    const sans = await transmettreDevisAgences(fd({ id: P.stand }));
    expect(sans.ok ? "" : sans.error, "sans l'attestation, rien ne part").toMatch(/J'ai comparé les lignes/);
    const t = await transmettreDevisAgences(fd({ id: P.stand, compare: "oui" }));
    expect(t.ok, msg(t)).toBe(true);
    expect(t.ok ? t.message : "").toMatch(/^3 devis transmis à la Direction Marketing\./);
    const t2 = await transmettreDevisAgences(fd({ id: P.copie, compare: "oui" }));
    expect(t2.ok, msg(t2)).toBe(true);
    expect((await prisma.adProExecutionPoste.findUniqueOrThrow({ where: { itemId: P.stand } })).devisTransmisAt).not.toBeNull();
    const n = await notifs("dm", { title: "Devis d'agences à comparer", link: lienPosteAdPro("EVENT", eventId, P.stand) });
    expect(n.length, "la DM est prévenue, vers le poste").toBe(1);
  }, 120_000);

  // ═════════════════════════════ 4. LE CHOIX LIGNE À LIGNE, LA SCISSION ═════════════════════════════
  it("4. la DM retient des lignes de DEUX devis : le poste est scindé — A (> 1 000 000 TTC) et B (< 1 000 000) ont chacun devis, lignes, montant ; le 3e n'est pas retenu", async () => {
    await comme("dm");
    const f = fd({ id: P.stand, budgetCategoryId: catId });
    f.append("ligne", valeurDeLigne(D.a, L[D.a]![0]!));
    f.append("ligne", valeurDeLigne(D.a, L[D.a]![1]!));
    f.append("ligne", valeurDeLigne(D.b, L[D.b]![0]!));
    const r = await retenirLignesDesAgences(f);
    expect(r.ok, msg(r)).toBe(true);
    expect(r.ok ? r.message : "").toContain("Poste scindé en 2 postes");

    // L'ORIGINE garde l'agence au plus gros total : Alpha, 1 050 000 HT → 1 249 500 TTC.
    const a = await prisma.adProItem.findUniqueOrThrow({ where: { id: P.stand }, include: { execution: true } });
    expect(a.status).toBe("APPROVED");
    expect(Number(a.amountGranted)).toBe(1_249_500);
    expect(Number(a.amountGranted)).toBeGreaterThan(SEUIL_BC);
    expect(a.supplier).toBe(`${TAG}Alpha`);
    expect(a.budgetCategoryId).toBe(catId);
    expect(a.execution?.agenceDevisId).toBe(D.a);
    const lignesA = await prisma.adProDevisLigne.findMany({ where: { devis: { legalDocumentId: D.a } }, orderBy: { position: "asc" }, select: { validatedItemId: true } });
    expect(lignesA.map((l) => l.validatedItemId)).toEqual([P.stand, P.stand, null]);

    // LE POSTE NÉ pour Beta : son devis, sa ligne, son montant (100 000 HT → 119 000 TTC).
    const lienB = await prisma.adProItemPiece.findFirstOrThrow({ where: { legalDocumentId: D.b, nature: "DEVIS" } });
    P.standB = lienB.itemId;
    expect(P.standB).not.toBe(P.stand);
    const b = await prisma.adProItem.findUniqueOrThrow({ where: { id: P.standB }, include: { execution: true } });
    expect(b.eventId).toBe(eventId);
    expect(b).toMatchObject({ status: "APPROVED", voie: "AGENCE", kind: "STAND", conformiteRequise: true, supplier: `${TAG}Beta`, budgetCategoryId: catId });
    expect(Number(b.amountGranted)).toBe(119_000);
    expect(Number(b.amountGranted)).toBeLessThan(SEUIL_BC);
    expect(b.execution).toMatchObject({ assistanteId: u.ast, agenceDevisId: D.b });
    const lignesB = await prisma.adProDevisLigne.findMany({ where: { devis: { legalDocumentId: D.b } }, orderBy: { position: "asc" }, select: { validatedItemId: true } });
    expect(lignesB.map((l) => l.validatedItemId)).toEqual([P.standB, null]);
    expect(await prisma.adProItemPiece.count({ where: { itemId: P.standB, nature: "DEVIS" } }), "le poste né ne porte que le devis de son agence").toBe(1);

    // LE DEVIS SANS LIGNE COCHÉE (Gamma) : non retenu.
    const lienC = await prisma.adProItemPiece.findUniqueOrThrow({ where: { itemId_legalDocumentId: { itemId: P.stand, legalDocumentId: D.c } } });
    expect(lienC.nonRetenuAt, "Gamma n'est pas retenu").not.toBeNull();

    // Chaque BC naît en brouillon chez l'assistante, qui est prévenue sur SA page.
    for (const [item, devis] of [[P.stand, D.a], [P.standB, D.b]] as const) {
      const brouillon = (await prisma.adProDevis.findUniqueOrThrow({ where: { legalDocumentId: devis } })).bcBrouillon as { itemId?: string } | null;
      expect(brouillon?.itemId, `brouillon du BC de ${item}`).toBe(item);
      expect((await notifs("ast", { title: "Bon de commande à finaliser", link: lienPosteAssistante(item) })).length).toBe(1);
    }

    // LA COPIE : une agence, une ligne (1 000 000 HT → 1 190 000 TTC).
    const fc = fd({ id: P.copie, budgetCategoryId: catId });
    fc.append("ligne", valeurDeLigne(D.d, L[D.d]![0]!));
    const rc = await retenirLignesDesAgences(fc);
    expect(rc.ok, msg(rc)).toBe(true);
    expect(Number((await prisma.adProItem.findUniqueOrThrow({ where: { id: P.copie } })).amountGranted)).toBe(1_190_000);
    expect(await prisma.medicalInfoDeclaration.count({ where: { sourceId: eventId } }), "le poste direct attend encore : pas de déclaration").toBe(0);
  }, 120_000);

  // ═════════════════════════════ 5. LE BON DE COMMANDE : FINALISÉ, SIGNÉ, VISÉ, SIGNÉ ═════════════════════════════
  /** L'assistante soumet le BC finalisé ; la DM le valide, le signe et le cachette (mot de passe + code). Rend le BC émis. */
  async function bcSigneParLaDm(itemId: string): Promise<string> {
    await comme("ast");
    const s = await soumettreBcMarketing(fd({ id: itemId }));
    expect(s.ok, `soumission du BC : ${msg(s)}`).toBe(true);
    expect((await notifs("dm", { title: "BC à valider, signer et cacheter", link: lienPosteAdPro("EVENT", eventId, itemId) })).length, "la DM est prévenue").toBeGreaterThanOrEqual(1);
    await comme("dm");
    const v = await validerSignerBcMarketing(fd({ id: itemId, lu: "oui", motDePasse: MDP, code: await code("dm") }));
    expect(v.ok, `validation + signature DM : ${msg(v)}`).toBe(true);
    const bc = await bcActifDe(itemId);
    expect(bc, "le BC est émis et rattaché au poste").not.toBe("");
    const sig = await prisma.signatureBC.findUnique({ where: { legalDocumentId_qualite: { legalDocumentId: bc, qualite: "DIRECTION_MARKETING" } } });
    expect(sig?.userId, "la signature de la DM est apposée").toBe(u.dm);
    expect(sig?.documentId, "le PDF signé DM est déposé").toBeTruthy();
    return bc;
  }
  async function signeParLesFinances(bc: string) {
    await comme("fin");
    const r = await signerBonDeCommandeEnLigne(fd({ id: bc, lu: "oui", motDePasse: MDP, code: await code("fin") }));
    expect(r.ok, `signature des Finances : ${msg(r)}`).toBe(true);
    expect((await etatDuBC(bc))?.etape).toBe("SIGNE");
    expect(await prisma.signatureBC.count({ where: { legalDocumentId: bc, qualite: "FINANCES" } })).toBe(1);
  }
  const notifsFinancesDuBC = async (itemId: string, bc: string) => ({
    aSigner: (await notifs("fin", { title: "Bon de commande à signer", link: { contains: bc } })).length,
    aEmettre: (await notifs("fin", { title: { contains: "à émettre" }, link: { contains: itemId } })).length,
  });

  it("5a. poste A (> 1 000 000) : BC signé par la DM → centre Ad & Pro (BC_POSTE pour le DG) → visa du DG → « À signer » des Finances, prévenues UNE fois → signé", async () => {
    BC.a = await bcSigneParLaDm(P.stand);
    const p = await prisma.adProItem.findUniqueOrThrow({ where: { id: P.stand } });
    expect(p.orderStage, "au-dessus du seuil, le poste attend le centre").toBe("REQUESTED");
    expect((await etatDuBC(BC.a))?.etape).toBe("A_VALIDER");
    expect(etapeAgence((await faitsDe(P.stand))!)).toBe("BC_CHEZ_CENTRE");
    const ligne = (await demandesAuCentreAdPro()).find((l) => l.entityId === P.stand);
    expect(ligne?.forme, "la demande est au centre Ad & Pro").toBe("BC_POSTE");
    expect(ligne?.href).toBe(lienPosteAdPro("EVENT", eventId, P.stand));
    const fin = await acteur(u.fin, ROLES.fin);
    expect((await fileBonsDeCommande(fin))?.aSigner.some((l) => l.id === BC.a), "pas « à signer » avant le visa").toBe(false);

    await comme("dg");
    const ok = await approveAdProItemOrder(undefined, fd({ id: P.stand, decision: "APPROVE", montantVu: "1249500", prestataireVu: `${TAG}Alpha` }));
    expect(ok.ok, msg(ok)).toBe(true);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: P.stand } })).orderStage).toBe("DIRECTION_OK");
    expect((await etatDuBC(BC.a))?.etape).toBe("A_SIGNER");
    expect((await fileBonsDeCommande(fin))?.aSigner.some((l) => l.id === BC.a), "le BC est dans « À signer » des Finances").toBe(true);
    expect(await notifsFinancesDuBC(P.stand, BC.a), "Finances : « à signer » une fois, jamais « à émettre »").toEqual({ aSigner: 1, aEmettre: 0 });
    expect((await demandesAuCentreAdPro()).some((l) => l.entityId === P.stand), "le centre est vidé").toBe(false);

    await signeParLesFinances(BC.a);
    expect(etapeAgence((await faitsDe(P.stand))!)).toBe("BC_A_ENVOYER");
  }, 180_000);

  it("5b. poste B (< 1 000 000) : BC signé par la DM → directement chez les Finances (jamais au centre) → signé", async () => {
    BC.b = await bcSigneParLaDm(P.standB);
    const p = await prisma.adProItem.findUniqueOrThrow({ where: { id: P.standB } });
    expect(p.orderStage, "en deçà du seuil, le centre est franchi d'office").toBe("DIRECTION_OK");
    expect(p.orderDirectionAt, "aucun visa du centre n'est inscrit").toBeNull();
    expect((await etatDuBC(BC.b))?.etape).toBe("A_SIGNER");
    expect((await demandesAuCentreAdPro()).some((l) => l.entityId === P.standB), "jamais au centre").toBe(false);
    const fin = await acteur(u.fin, ROLES.fin);
    expect((await fileBonsDeCommande(fin))?.aSigner.some((l) => l.id === BC.b)).toBe(true);
    expect(await notifsFinancesDuBC(P.standB, BC.b), "Finances : « à signer » une fois, jamais « à émettre »").toEqual({ aSigner: 1, aEmettre: 0 });
    await signeParLesFinances(BC.b);
  }, 180_000);

  it("5c. REFUS DU DG (copie > 1 000 000) : motif exigé → BC_REFUSE_DG → « Annuler la demande de BC » → un nouveau BC se prépare et repart", async () => {
    BC.copie = await bcSigneParLaDm(P.copie);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: P.copie } })).orderStage).toBe("REQUESTED");
    await comme("dg");
    const sans = await approveAdProItemOrder(undefined, fd({ id: P.copie, decision: "REFUSE" }));
    expect(sans.ok ? "" : sans.error, "un refus sans motif est refusé").toMatch(/motif/);
    const refus = await approveAdProItemOrder(undefined, fd({ id: P.copie, decision: "REFUSE", note: "Budget kakémonos à revoir" }));
    expect(refus.ok, msg(refus)).toBe(true);
    const p = await prisma.adProItem.findUniqueOrThrow({ where: { id: P.copie } });
    expect(p.orderStage).toBe("REFUSED");
    expect(p.orderDecisionNote).toBe("Budget kakémonos à revoir");
    const faits = (await faitsDe(P.copie))!;
    expect(etapeAgence(faits)).toBe("BC_REFUSE_DG");
    expect(pasAgence(faits, REGARD_DM).attente ?? "").toMatch(/BC refusé par le DG .*« Budget kakémonos à revoir ».*Annuler la demande de BC/);
    const fileDm = (await fileAgences(su(await acteur(u.dm, ROLES.dm)))) ?? [];
    expect(fileDm.find((l) => l.itemId === P.copie)?.etape, "la file de la DM le dit").toBe("BC_REFUSE_DG");
    expect((await notifs("dm", { title: "Bon de commande refusé par le centre Ad & Pro" })).length, "la DM (qui a demandé le BC) est prévenue").toBe(1);
    expect((await fileBonsDeCommande(await acteur(u.fin, ROLES.fin)))?.aSigner.some((l) => l.id === BC.copie), "un BC refusé n'est pas à signer").toBe(false);

    await comme("dm");
    const sansMotif = await retirerDemandeBC(undefined, fd({ id: P.copie }));
    expect(sansMotif.ok ? "" : sansMotif.error).toMatch(/Dites pourquoi/);
    const retrait = await retirerDemandeBC(undefined, fd({ id: P.copie, motif: "Refusé par le DG — nouveau BC à 8 kakémonos" }));
    expect(retrait.ok, msg(retrait)).toBe(true);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: P.copie } })).orderStage).toBe("NONE");
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: BC.copie } })).status, "le BC non signé par les Finances s'annule avec la demande").toBe("CANCELLED");
    const apresRetrait = etapeAgence((await faitsDe(P.copie))!);
    expect(apresRetrait, "le poste n'est plus « refusé par le DG »").not.toBe("BC_REFUSE_DG");
    expect.soft(apresRetrait, "BC annulé avec la demande : le parcours ne doit plus le lire comme un BC vivant").not.toBe("BC_A_SIGNER_FINANCES");

    // UN NOUVEAU BC SE PRÉPARE — puis repart, validé et signé, au centre.
    const prep = await preparerBrouillonPoste(fd({ id: P.copie }));
    expect(prep.ok, `préparer un nouveau BC : ${msg(prep)}`).toBe(true);
    const brouillon = (await prisma.adProDevis.findUniqueOrThrow({ where: { legalDocumentId: D.d } })).bcBrouillon as { itemId?: string } | null;
    expect(brouillon?.itemId, "un nouveau brouillon de BC existe").toBe(P.copie);
    const faitsApres = (await faitsDe(P.copie))!;
    const etapeApres = etapeAgence(faitsApres);
    // La demande retirée, le BC n'est plus « soumis » : il revient à l'assistante, qui le finalise et le soumet à nouveau.
    expect(etapeApres, `étape de la carte après la préparation du nouveau BC — attente « ${pasAgence(faitsApres, REGARD_DM).attente} »`).toBe("BC_CHEZ_ASSISTANTE");
    const ligneDm = ((await fileAgences(su(await acteur(u.dm, ROLES.dm)))) ?? []).find((l) => l.itemId === P.copie);
    expect(ligneDm?.etape, "la file de la DM après la préparation du nouveau BC").not.toBe("BC_CHEZ_FINANCES");
    await bcSigneParLaDm(P.copie);
    const nouveau = await bcActifDe(P.copie);
    expect(nouveau, "un NOUVEAU BC").not.toBe(BC.copie);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: P.copie } })).orderStage, "il repart au centre").toBe("REQUESTED");
  }, 240_000);

  // ═════════════════════════════ 6. L'EXÉCUTION : BC ENVOYÉ, BAT, RÉCEPTION ═════════════════════════════
  const bat = (n: string) => { const f = fd({}); f.append("bat", pdf(`bat-${n}.pdf`)); return f; };
  async function envoyerBat(itemId: string, n: string) {
    await comme("dm");
    const f = bat(n);
    f.set("id", itemId);
    const r = await envoyerBatConformite(f);
    expect(r.ok, `BAT ${n} : ${msg(r)}`).toBe(true);
    expect((await prisma.adProExecutionPoste.findUniqueOrThrow({ where: { itemId } })).conformiteStatut).toBe("EN_CONTROLE");
  }

  it("6. exécution : la DM envoie le BC, le BAT passe chez le pharmacien (NON CONFORME, corrigé, CONFORME), puis la DM signe la réception", async () => {
    await comme("dm");
    const env = await marquerBcEnvoye(fd({ id: P.stand }));
    expect(env.ok, msg(env)).toBe(true);
    expect(env.ok ? env.message : "").toMatch(/transmettre le BAT/);
    expect(etapeAgence((await faitsDe(P.stand))!)).toBe("BAT_A_ENVOYER");
    const tot = await signerReceptionPoste(fd({ id: P.stand }));
    expect(tot.ok ? "" : tot.error, "pas de réception avant la conformité").toMatch(/conformité n'est pas encore validée/);

    await envoyerBat(P.stand, "v1");
    expect(etapeAgence((await faitsDe(P.stand))!)).toBe("CONFORMITE");
    expect((await notifs("pharm", { title: "BAT à contrôler", link: { contains: P.stand } })).length, "le pharmacien est prévenu, vers SON écran").toBe(1);
    await comme("pharm");
    const sansNote = await deciderConformitePoste(fd({ id: P.stand, decision: "NON_CONFORME" }));
    expect(sansNote.ok ? "" : sansNote.error).toMatch(/Dites ce qu'il faut corriger/);
    const nc = await deciderConformitePoste(fd({ id: P.stand, decision: "NON_CONFORME", note: "Mention légale absente sur le kakémono" }));
    expect(nc.ok, msg(nc)).toBe(true);
    expect((await prisma.adProExecutionPoste.findUniqueOrThrow({ where: { itemId: P.stand } })).conformiteStatut).toBe("NON_CONFORME");
    expect(etapeAgence((await faitsDe(P.stand))!)).toBe("BAT_NON_CONFORME");
    expect((await notifs("dm", { title: "BAT non conforme", link: lienPosteAdPro("EVENT", eventId, P.stand) })).length).toBe(1);

    await envoyerBat(P.stand, "v2");
    expect((await notifs("pharm", { title: "BAT corrigé à contrôler", link: { contains: P.stand } })).length).toBe(1);
    await comme("pharm");
    const c = await deciderConformitePoste(fd({ id: P.stand, decision: "CONFORME" }));
    expect(c.ok, msg(c)).toBe(true);
    expect((await notifs("dm", { title: "BAT conforme", link: lienPosteAdPro("EVENT", eventId, P.stand) })).length).toBe(1);
    expect(etapeAgence((await faitsDe(P.stand))!)).toBe("RECEPTION");

    await comme("dm");
    const rec = await signerReceptionPoste(fd({ id: P.stand, note: "Stand monté, conforme au cahier des charges." }));
    expect(rec.ok, msg(rec)).toBe(true);
    expect((await prisma.adProExecutionPoste.findUniqueOrThrow({ where: { itemId: P.stand } })).receptionAt).not.toBeNull();
    expect(etapeAgence((await faitsDe(P.stand))!)).toBe("FACTURE");

    // B : le même chemin, conforme du premier coup.
    expect((await marquerBcEnvoye(fd({ id: P.standB }))).ok).toBe(true);
    await envoyerBat(P.standB, "b1");
    await comme("pharm");
    expect((await deciderConformitePoste(fd({ id: P.standB, decision: "CONFORME" }))).ok).toBe(true);
    await comme("dm");
    const recB = await signerReceptionPoste(fd({ id: P.standB }));
    expect(recB.ok, msg(recB)).toBe(true);
    expect(etapeAgence((await faitsDe(P.standB))!)).toBe("FACTURE");
  }, 120_000);

  // ═════════════════════════════ 7. LA FACTURE, LA DEMANDE DE PAIEMENT ═════════════════════════════
  const FACTURE_A = Buffer.from(`%PDF-1.4\n% facture Alpha ${RUN}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`);
  const fichierFactureA = () => new File([new Uint8Array(FACTURE_A)], "facture-alpha.pdf", { type: "application/pdf" });

  it("7. la DM dépose la facture d'Alpha (contrôlée contre le BC ; la même facture ailleurs est refusée), et demande le paiement : ordre AWAITING", async () => {
    await comme("dm");
    const f = fd({ id: P.stand, montant: "1249500", reference: `FA-${RUN}-A` });
    f.append("attachment", fichierFactureA());
    const r = await deposerFacturePoste(f);
    expect(r.ok, msg(r)).toBe(true);
    const factureA = r.ok ? r.id! : "";
    const fa = await prisma.legalDocument.findUniqueOrThrow({ where: { id: factureA } });
    expect(fa.kind).toBe("INVOICE");
    expect(fa.chainFromId, "la facture suit SON BC").toBe(BC.a);
    expect(Number(fa.amount)).toBe(1_249_500);
    const controle = (fa.custom as { facturePoste?: { controle?: { coherente?: boolean; bcIds?: string[]; ecarts?: string[] } } } | null)?.facturePoste?.controle;
    expect(controle?.bcIds, "contrôlée contre le BC d'Alpha").toEqual([BC.a]);
    expect(controle?.coherente, `contrôle : ${JSON.stringify(controle)}`).toBe(true);
    expect(r.ok ? r.message : "").toMatch(/cohérente avec le bon de commande/);
    // LA FACTURE DÉPOSÉE, LA CARTE DIT « Demander le paiement » (recette du 23/11/2026) — plus « Déposer la facture… », qui ne
    // rouvrait que la case « Facture » pendant que le vrai bouton restait sous l'onglet « Paiement ».
    const apresFacture = (await faitsDe(P.stand))!;
    expect(etapeAgence(apresFacture)).toBe("PAIEMENT_A_DEMANDER");
    expect(pasAgence(apresFacture, REGARD_DM).geste).toEqual({ cle: "DEMANDER_PAIEMENT", libelle: "Demander le paiement" });

    // LA MÊME FACTURE (même fichier, même numéro) sur le poste de Beta : refusée comme déjà connue.
    const g = fd({ id: P.standB, montant: "1249500", reference: `FA-${RUN}-A` });
    g.append("attachment", fichierFactureA());
    const dbl = await deposerFacturePoste(g);
    expect(dbl.ok, `doublon : ${msg(dbl)}`).toBe(false);
    expect(await prisma.adProItemPiece.count({ where: { itemId: P.standB, nature: "FACTURE" } }), "rien n'est déposé sur Beta").toBe(0);

    const p = await demanderPaiementPoste(undefined, fd({ id: P.stand }));
    expect(p.ok, msg(p)).toBe(true);
    ORDRE.a = p.ok ? p.id! : "";
    const o = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ORDRE.a } });
    expect(o.centralStatus).toBe("AWAITING");
    expect(o.status).toBe("PENDING");
    expect(Number(o.amount)).toBe(1_249_500);
    expect(o.beneficiary).toBe(`${TAG}Alpha`);
    expect(o.requestedById).toBe(u.dm);
    const poste = await prisma.adProItem.findUniqueOrThrow({ where: { id: P.stand } });
    expect(poste).toMatchObject({ expenseOrderId: ORDRE.a, orderStage: "ISSUED" });
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: factureA } })).expenseOrderId).toBe(ORDRE.a);
  }, 120_000);

  // ═════════════════════════════ 8. LE CENTRE DE PAIEMENT, LES FINANCES ═════════════════════════════
  it("8a. centre de paiement : le DG voit l'ordre d'Alpha et l'autorise → Finances « à régler » → réglé → la DM « Ordre de dépense réglé »", async () => {
    const dg = await acteur(u.dg, ROLES.dg);
    const centre = await chargerCentre(su(dg), { entite: societe });
    expect(centre.canDecide).toBe(true);
    expect(centre.idsEntite, "l'ordre est au centre de paiement, chez le DG").toContain(ORDRE.a);
    ACTOR = dg;
    const d = await decidePayment(fd({ id: ORDRE.a, decision: "APPROVE", montantVu: "1249500" }));
    expect(d.ok, msg(d)).toBe(true);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ORDRE.a } })).centralStatus).toBe("APPROVED");
    expect((await notifs("fin", { title: "Paiement autorisé — à régler", link: { contains: ORDRE.a } })).length, "les Finances sont prévenues, vers l'ordre").toBe(1);
    expect(pasAgence((await faitsDe(P.stand))!, REGARD_DM).attente).toBe("Paiement autorisé — chez les Finances.");

    await comme("fin");
    const s = await settleExpenseOrder(fd({ id: ORDRE.a }));
    expect(s.ok, msg(s)).toBe(true);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ORDRE.a } })).status).toBe("PAID");
    expect((await notifs("dm", { title: "Ordre de dépense réglé" })).length, "la DM, qui a demandé le paiement, est prévenue").toBe(1);
    expect(etapeAgence((await faitsDe(P.stand))!)).toBe("PAYE");
  }, 120_000);

  it("8b. REFUS du centre de paiement (Beta) : motif exigé → « Paiement refusé par le centre de paiement… » → « Annuler la demande de paiement » libère le poste → redemandé, autorisé, réglé", async () => {
    await comme("dm");
    const f = fd({ id: P.standB, montant: "119000", reference: `FA-${RUN}-B1` });
    f.append("attachment", pdf("facture-beta-1.pdf"));
    const p = await demanderPaiementPoste(undefined, f);
    expect(p.ok, msg(p)).toBe(true);
    ORDRE.b1 = p.ok ? p.id! : "";
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ORDRE.b1 } })).centralStatus).toBe("AWAITING");

    await comme("dg");
    const sans = await decidePayment(fd({ id: ORDRE.b1, decision: "REFUSE" }));
    expect(sans.ok ? "" : sans.error).toMatch(/Dites pourquoi/);
    const refus = await decidePayment(fd({ id: ORDRE.b1, decision: "REFUSE", body: "Facture sans cachet de l'agence" }));
    expect(refus.ok, msg(refus)).toBe(true);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ORDRE.b1 } })).centralStatus).toBe("REFUSED");
    const faits = (await faitsDe(P.standB))!;
    expect(pasAgence(faits, REGARD_DM).attente ?? "").toMatch(/^Paiement refusé par le centre de paiement — la Direction Marketing annule la demande de paiement du poste/);

    await comme("dm");
    const annule = await annulerOrdrePoste(undefined, fd({ id: P.standB, motif: "Refusé par le centre : facture à recacheter" }));
    expect(annule.ok, msg(annule)).toBe(true);
    const libre = await prisma.adProItem.findUniqueOrThrow({ where: { id: P.standB } });
    expect(libre.expenseOrderId, "le poste est libéré").toBeNull();
    expect(libre.orderStage).toBe("DIRECTION_OK");
    expect(await prisma.legalDocument.count({ where: { kind: "INVOICE", expenseOrderId: ORDRE.b1, status: { not: "CANCELLED" } } }), "sa facture part avec l'ordre").toBe(0);
    expect(etapeAgence((await faitsDe(P.standB))!)).toBe("FACTURE");

    const g = fd({ id: P.standB, montant: "119000", reference: `FA-${RUN}-B2` });
    g.append("attachment", pdf("facture-beta-2.pdf"));
    const p2 = await demanderPaiementPoste(undefined, g);
    expect(p2.ok, `nouvelle demande : ${msg(p2)}`).toBe(true);
    ORDRE.b2 = p2.ok ? p2.id! : "";
    expect(ORDRE.b2).not.toBe(ORDRE.b1);
    await comme("dg");
    expect((await decidePayment(fd({ id: ORDRE.b2, decision: "APPROVE" }))).ok).toBe(true);
    await comme("fin");
    const s = await settleExpenseOrder(fd({ id: ORDRE.b2 }));
    expect(s.ok, msg(s)).toBe(true);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ORDRE.b2 } })).status).toBe("PAID");
    expect(etapeAgence((await faitsDe(P.standB))!)).toBe("PAYE");
  }, 120_000);

  // ═════════════════════════════ 9. LEGAL : LE DOSSIER DE L'ÉVÉNEMENT, LA RECHERCHE ═════════════════════════════
  it("9. Legal : devis, BC et factures des postes sont dans « Événements › 2026 › <nom> » ; « BC <mot de l'événement> » retrouve le BC", async () => {
    const nom = (await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).name;
    const racine = await prisma.legalFolder.findFirst({ where: { name: "Événements", parentId: null }, orderBy: { createdAt: "asc" } });
    expect(racine, "le dossier racine « Événements »").not.toBeNull();
    const annee = await prisma.legalFolder.findFirst({ where: { name: "2026", parentId: racine!.id }, orderBy: { createdAt: "asc" } });
    expect(annee, "le dossier « 2026 »").not.toBeNull();
    const feuille = await prisma.legalFolder.findFirst({ where: { name: nom, parentId: annee!.id } });
    expect(feuille, `le dossier « ${nom} »`).not.toBeNull();
    const pieces = await prisma.adProItemPiece.findMany({
      where: { itemId: { in: [P.stand, P.standB, P.copie] } },
      select: { nature: true, legalDocument: { select: { id: true, title: true, folderId: true, kind: true } } },
    });
    const natures = new Set(pieces.map((x) => x.nature));
    expect([...natures].sort(), "devis, BC et factures sont là").toEqual(["BON_DE_COMMANDE", "DEVIS", "FACTURE"]);
    const malRangees = pieces.filter((x) => x.legalDocument.folderId !== feuille!.id).map((x) => `${x.nature} ${x.legalDocument.title}`);
    expect(malRangees, "chaque pièce est rangée dans le dossier de l'événement").toEqual([]);

    // Les Finances (qui signent les BC et lisent Legal) : « BC <mot> » rend le BC — et pas le devis.
    const fin = su(await acteur(u.fin, ROLES.fin));
    expect((await perimetreLegal(fin)).where, "PRÉMISSE : les Finances lisent le registre Legal").not.toBeNull();
    const parFin = (await globalSearch(fin, `BC ${MOT}`, 20)).filter((r) => r.group === "Legal");
    expect(parFin.map((r) => r.id), `recherche « BC ${MOT} » par les Finances`).toContain(BC.a);
    expect(parFin.map((r) => r.id), "la nature « BC » écarte le devis").not.toContain(D.a);
    expect(parFin.find((r) => r.id === BC.a)?.href).toBe(`/legal/${BC.a}`);
    // La DM : la recherche suit SA porte Legal (RBAC) — le BC seulement si son rôle ouvre le registre.
    const dm = su(await acteur(u.dm, ROLES.dm));
    const porteDm = await perimetreLegal(dm);
    const parDm = (await globalSearch(dm, `BC ${MOT}`, 20)).filter((r) => r.group === "Legal").map((r) => r.id);
    if (porteDm.where) expect.soft(parDm, `recherche « BC ${MOT} » par la DM (portée ${porteDm.portee})`).toContain(BC.a);
    else expect(parDm, `la DM n'ouvre pas Legal (portée ${porteDm.portee}) : la recherche ne lui montre aucune pièce`).toEqual([]);
  }, 60_000);

  // ═════════════════════════════ 10. LE POSTE DIRECT (association) ═════════════════════════════
  it("10. poste DIRECT : accepté par la DM avec la pro forma (montant et « payé à » d'elle) → paiement → centre (DG) → Finances", async () => {
    await comme("dm");
    const sans = await decideAdProItem(undefined, fd({ id: P.direct, decision: "APPROVED", budgetCategoryId: catId }));
    expect(sans.ok ? "" : sans.error).toBe("Indiquez le montant accordé à ce poste.");
    expect(await prisma.medicalInfoDeclaration.count({ where: { sourceId: eventId } }), "avant le dernier poste validé : pas de déclaration").toBe(0);
    const f = fd({ id: P.direct, decision: "APPROVED", budgetCategoryId: catId, amountGranted: "300000", supplier: `${TAG}Association cardio d'Oran` });
    f.append("proforma", pdf("proforma-association.pdf"));
    const d = await decideAdProItem(undefined, f);
    expect(d.ok, msg(d)).toBe(true);
    expect(d.ok ? d.message : "").toMatch(/Pro forma jointe au poste/);
    const p = await prisma.adProItem.findUniqueOrThrow({ where: { id: P.direct } });
    expect(p.status).toBe("APPROVED");
    expect(Number(p.amountGranted)).toBe(300_000);
    expect(p.supplier).toBe(`${TAG}Association cardio d'Oran`);
    const pro = await prisma.adProItemPiece.findFirst({ where: { itemId: P.direct, nature: "DEVIS" }, include: { legalDocument: { select: { kind: true, counterparty: true } } } });
    expect(pro?.legalDocument).toMatchObject({ kind: "QUOTE", counterparty: `${TAG}Association cardio d'Oran` });

    // LE VERSEMENT DIRECT n'a pas de visa de BC : la porte du DG sur le TOTAL de la demande est son passage chez le DG.
    const porte = await lirePorteDg("EVENT", eventId);
    const tot = await demanderPaiementPoste(undefined, fd({ id: P.direct, montant: "300000" }));
    expect(tot.ok, `porte du DG sur le total (${porte.etat}, total ${porte.total}, seuil ${porte.seuil}) : ${msg(tot)}`).toBe(porte.refus === null);
    if (!tot.ok) {
      expect(tot.error, "le refus est celui de la porte du DG").toBe(porte.refus);
      const total = (await prisma.adProItem.findMany({ where: { eventId, status: { not: "REJECTED" } }, select: { amountGranted: true, amountEstimated: true } }))
        .reduce((s, x) => s + Math.round(Number(x.amountGranted ?? x.amountEstimated ?? 0) * 100), 0) / 100;
      await comme("dg");
      const v = await statuerTotalDg(fd({ parent: "EVENT", parentId: eventId, decision: "VALIDEE", totalVu: String(total) }));
      expect(v.ok, `le DG valide le total (${total}) : ${msg(v)}`).toBe(true);
      await comme("dm");
    }
    const r = tot.ok ? tot : await demanderPaiementPoste(undefined, fd({ id: P.direct, montant: "300000" }));
    expect(r.ok, msg(r)).toBe(true);
    ORDRE.direct = r.ok ? r.id! : "";
    const o = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ORDRE.direct } });
    expect(o).toMatchObject({ centralStatus: "AWAITING", requiresInvoice: false, beneficiary: `${TAG}Association cardio d'Oran` });
    expect(Number(o.amount)).toBe(300_000);
    expect(await prisma.adProItemPiece.count({ where: { itemId: P.direct, nature: "BON_DE_COMMANDE" } }), "aucun BC").toBe(0);

    const dg = await acteur(u.dg, ROLES.dg);
    expect((await chargerCentre(su(dg), { entite: societe })).idsEntite).toContain(ORDRE.direct);
    ACTOR = dg;
    expect((await decidePayment(fd({ id: ORDRE.direct, decision: "APPROVE" }))).ok).toBe(true);
    await comme("fin");
    const s = await settleExpenseOrder(fd({ id: ORDRE.direct }));
    expect(s.ok, msg(s)).toBe(true);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ORDRE.direct } })).status).toBe("PAID");
  }, 120_000);

  // ═════════════════════════════ 11. LA DÉCLARATION D'INFORMATION MÉDICALE ═════════════════════════════
  it("11. la déclaration d'information médicale est ouverte (tous les postes validés), assignée au pharmacien responsable", async () => {
    const decl = await prisma.medicalInfoDeclaration.findUnique({ where: { sourceType_sourceId: { sourceType: "EVENT", sourceId: eventId } } });
    expect(decl, "la déclaration est ouverte").not.toBeNull();
    const attendu = await pharmacienAssigne();
    expect(attendu, "un pharmacien responsable actif existe").not.toBeNull();
    expect(decl!.pharmacistId, "assignée au pharmacien responsable (le plus ancien actif)").toBe(attendu);
    const ph = await prisma.user.findUniqueOrThrow({ where: { id: decl!.pharmacistId! }, select: { role: true, secondaryRole: true } });
    expect([ph.role, ph.secondaryRole]).toContain("MEDICAL_INFO_PHARMACIST");
    expect(await prisma.notification.count({ where: { userId: decl!.pharmacistId!, link: `/information-medicale/${decl!.id}` } }), "le pharmacien est prévenu").toBe(1);
    expect(decl!.requesterId).toBe(u.kam);
  }, 60_000);
});
