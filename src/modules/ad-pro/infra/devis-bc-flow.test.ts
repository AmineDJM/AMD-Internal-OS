import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sourceDeLaCle } from "@/lib/actions/parc";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));
/**
 * LE SEUIL DES BONS DE COMMANDE EST UN RÉGLAGE GLOBAL (§118.132) : le banc l'INJECTE dans son processus. Le seuil de la
 * PORTE DU DG sur le total d'une demande (27/10/2026) aussi — à sa valeur ordinaire, 1 000 000 DZD — : un réglage changé
 * par un autre banc au même instant ne doit pas ouvrir ni fermer la porte de celui-ci.
 */
const SEUIL = 500_000;
const SEUIL_DG = 1_000_000;
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), bcValidationThreshold: SEUIL, adProDgThreshold: SEUIL_DG }) };
});
/** Les assistantes actives sont un fait GLOBAL : le banc restreint la vraie lecture à SES comptes (voisinage fermé). */
let ASSISTANTES: string[] | null = null;
vi.mock("./pieces-poste", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("./pieces-poste")>();
  return {
    ...vrai,
    assistantesDeDirection: async () => {
      const toutes = await vrai.assistantesDeDirection();
      return ASSISTANTES ? toutes.filter((a) => ASSISTANTES!.includes(a.id)) : toutes;
    },
  };
});
/**
 * LA LECTURE PAR LE MODÈLE est un service externe : le banc la REMPLACE par une lecture déterministe, mais pas ce
 * qu'on en fait (`ingererDevisDuPoste` écrit les lignes, `lue` renseigné, un chiffre illisible reste null). `null` :
 * la lecture échoue — c'est le cas d'un dépôt sans fournisseur, et il ne doit JAMAIS faire échouer le dépôt.
 */
type LigneLue = { rang: number; reference: string; unit: string | null; quantity: number | null; unitPrice: number | null; notes: string[]; suspecte: string[] };
let LECTURE: { lignes: LigneLue[]; announced?: number } | null = null;
vi.mock("@/lib/pieces-lues/service", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/pieces-lues/service")>();
  return { ...vrai, proposerLecture: async () => (LECTURE ? { ok: true, proposition: {} } : { ok: false, error: "La lecture est coupée dans ce banc." }) };
});
vi.mock("@/lib/pieces-lues/prerempli-devis-promo", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/pieces-lues/prerempli-devis-promo")>();
  return {
    ...vrai,
    lectureDevisPromo: () => ({
      lectureId: "lecture-du-banc", noteMethode: "texte natif, banc", sansLignes: null,
      prerempli: {
        fournisseurId: null, reference: null, quoteDate: null, tvaRate: 19, extraTaxLabel: null, extraTaxRate: null,
        announcedTotal: LECTURE?.announced ?? null, reserves: [], lignes: LECTURE?.lignes ?? [],
      },
    }),
  };
});

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { canEditCompanyId } from "@/lib/company";
import { addAdProItem, submitAdProItem, requestAdProItemOrder, approveAdProItemOrder } from "../actions-postes";
import { decideAdProItem, retirerDemandeBC } from "../actions-postes-decision";
import { ajouterDevisPoste, retirerDevisDuPoste, demanderPaiementPoste } from "../actions-postes-paiement";
import { validerLignesDuDevis, enregistrerLignesDuDevis, lireLesLignesDuDevis, genererBonDeCommandePoste, validerEtEnvoyerBcPoste } from "../actions-postes-lignes";
import { signerBonDeCommande } from "@/lib/actions/bc-signature-actions";
import { avecCopieSignee } from "@/lib/bons-de-commande/signature-test-outils";
import { etatDuBC } from "@/lib/bons-de-commande/etat";
import { devisDesPostes } from "./requetes/devis-poste";
import { loadAdProItems } from "./requetes/postes";
import { piecesDesPostes } from "./pieces-poste";
import { prochainPas, faitsDuPoste, type RegardPoste } from "../domaine/poste-etapes";
import { refusGenerationBC } from "../domaine/devis-poste";
import { lirePorteDg, statuerSurLeTotal } from "./porte-dg";
import { fichiersEmis } from "@/lib/legal/fichiers-emis";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

// Un suffixe PAR RUN : un banc à étiquette fixe ne survit pas à un run interrompu (§118.136).
const TAG = "__devisbc__";
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
/**
 * « GÉNÉRER LE BC » = L'APERÇU, puis la VALIDATION par le demandeur (Direction, 10/2026) : le geste d'écran complet, sans numéro
 * ni envoi aux Finances tant que l'aperçu n'est pas validé. Quand rien n'est à générer (tout est à jour), la réponse de la
 * génération fait foi.
 */
async function genererEtValider(f: FormData) {
  const g = await genererBonDeCommandePoste(f);
  if (!g.ok || /déjà son bon de commande, à jour/.test(g.message ?? "")) return g;
  return validerEtEnvoyerBcPoste(f);
}
const pdf = (nom: string) => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), `${nom}-${Date.now()}-${Math.random()}`], nom, { type: "application/pdf" });

interface LigneSaisie { id?: string; ref: string; unite?: string; qte: string; prix: string }
/** Le formulaire de saisie des lignes tel que la carte l'envoie : une rangée par ligne, l'identifiant d'une ligne qui existe déjà. */
function formLignes(id: string, pieceId: string, lignes: LigneSaisie[], extra: Record<string, string> = {}): FormData {
  const f = fd({ id, pieceId, ...extra });
  for (const l of lignes) {
    f.append("ligneId", l.id ?? ""); f.append("ligneReference", l.ref); f.append("ligneUnite", l.unite ?? "");
    f.append("ligneQuantite", l.qte); f.append("lignePrix", l.prix);
  }
  return f;
}
/** Le formulaire de validation : les lignes COCHÉES. */
function formValider(id: string, pieceId: string, ligneIds: string[], extra: Record<string, string> = {}): FormData {
  const f = fd({ id, pieceId, ...extra });
  for (const l of ligneIds) f.append("ligneId", l);
  return f;
}
const ttc = (ht: number) => Math.round(ht * 119) / 100;

const REGARD_DEMANDEUR: RegardPoste = { canEdit: true, canAllocate: false, canViserBC: false, canEmettre: false, fige: false, operationDecidee: false };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LIGNES DES DEVIS D'UN POSTE ET LES BONS DE COMMANDE GÉNÉRÉS D'APRÈS ELLES — par les VRAIS points d'entrée (§118.206).
 *
 * « Quand un devis est validé entièrement, dans la case Bon de commande, on peut soit GÉNÉRER avec un petit CTA, soit
 * UPLOADER. Plusieurs devis, différentes références validées dans chacun : UN BC PAR DEVIS (UNIQUEMENT les références
 * validées). S'il oublie une référence, il la coche et RÉGÉNÈRE le BC. » (Direction, 05/10.)
 *
 * Aucun acteur n'a la vue globale ni le droit d'engager la société (§118.104) — les prémisses le vérifient : sans cela,
 * la génération passerait par le droit nominatif et le banc ne mesurerait pas la DÉLÉGATION. Chaque cas NOMME son
 * acteur (§118.151f), et les juges comptent par le lien causal — les BC de CE poste —, jamais un compte global.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Ad & Pro — lignes de devis validées → un BC par devis, régénérable", () => {
  const u: Record<"kam" | "kam2" | "ops" | "dm" | "gm" | "fin" | "ast1", string> = { kam: "", kam2: "", ops: "", dm: "", gm: "", fin: "", ast1: "" };
  const ROLES = {
    kam: "MEDICAL_DELEGATE", kam2: "MEDICAL_DELEGATE", ops: "DIRECTION", dm: "PRODUCT_MANAGER",
    gm: "GENERAL_MANAGER", fin: "FINANCE_BUDGET_MANAGER", ast1: "DIRECTION_ASSISTANT",
  } as const;
  let companyId = "", congres = "", congres2 = "", catId = "", fournisseurAnnuaire = "";
  const comme = async (qui: keyof typeof ROLES) => { ACTOR = await acteur(u[qui], ROLES[qui]); return ACTOR; };
  const ok = (r: { ok: boolean; error?: string }) => expect(r.ok, r.error ?? "").toBe(true);
  const refus = (r: { ok: boolean; error?: string }) => { expect(r.ok, "le geste devait être refusé").toBe(false); return r.error ?? ""; };

  beforeAll(async () => {
    const cles = Object.keys(ROLES) as (keyof typeof ROLES)[];
    const comptes = await Promise.all(cles.map((k) =>
      prisma.user.create({ data: { name: `${TAG}${k}`, email: `${RUN}${k}@t.dz`, role: ROLES[k], passwordHash: "x" } })));
    cles.forEach((k, i) => { u[k] = comptes[i].id; });
    const c = await prisma.company.create({ data: { name: `${RUN} Pharma`, shortName: RUN.slice(-12), color: "#1B7F79" } });
    companyId = c.id;
    // Le demandeur est SALARIÉ de la société (c'est ce qui la nomme pour sa demande), sans le droit de l'engager.
    await Promise.all([
      prisma.employee.create({ data: { fullName: `${TAG} kam`, userId: u.kam, companyId } }),
      prisma.employee.create({ data: { fullName: `${TAG} kam2`, userId: u.kam2, companyId } }),
      prisma.companyLegalIdentity.create({
        data: {
          companyId, legalName: `${TAG} Pharma SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
          nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
          bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Direction", managerTitle: "Gérant",
        },
      }),
    ]);
    const [c1, c2, env, four] = await Promise.all([
      prisma.congressNational.create({ data: { name: `${RUN} Congrès de Sétif`, requesterId: u.kam, requestStatus: "APPROVED" }, select: { id: true } }),
      prisma.congressNational.create({ data: { name: `${RUN} Congrès de Tlemcen`, requesterId: u.kam2, requestStatus: "APPROVED" }, select: { id: true } }),
      prisma.budgetEnvelope.create({
        data: { name: `${RUN}Enveloppe`, modules: ["CONGRESS_NATIONAL"], totalAmount: 50_000_000, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31") },
        select: { id: true },
      }),
      prisma.companyContact.create({
        data: { name: `${TAG} Imprimerie Atlas`, address: "Zone industrielle", city: "Alger", rc: "16/00-111", nif: "0001", companyId: null },
        select: { id: true },
      }),
    ]);
    congres = c1.id; congres2 = c2.id; fournisseurAnnuaire = four.id;
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${TAG}Imprimerie`, allocated: 50_000_000 }, select: { id: true } })).id;
  }, 60_000);

  afterAll(async () => {
    const ids = Object.values(u).filter(Boolean);
    const parents = [congres, congres2].filter(Boolean);
    const postes = (await prisma.adProItem.findMany({ where: { congressNationalId: { in: parents } }, select: { id: true } }).catch(() => [])).map((p) => p.id);
    const demandes = await prisma.documentRequest.findMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: postes } }, select: { id: true, legalDocumentId: true } }).catch(() => []);
    const liens = await prisma.adProItemPiece.findMany({ where: { itemId: { in: postes } }, select: { legalDocumentId: true } }).catch(() => []);
    const aval = await prisma.legalDocument.findMany({ where: { companyId }, select: { id: true } }).catch(() => []);
    const docs = [...new Set([...demandes.map((d) => d.legalDocumentId), ...liens.map((l) => l.legalDocumentId), ...aval.map((a) => a.id)].filter((x): x is string => Boolean(x)))];
    await prisma.document.deleteMany({ where: { entityId: { in: [...docs, ...demandes.map((d) => d.id), ...postes] } } }).catch(() => {});
    await prisma.adProItemPiece.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    const aDemandes = (await prisma.administrativeRequest.findMany({ where: { linkedEntityType: "AD_PRO_ITEM", linkedEntityId: { in: postes } }, select: { id: true } }).catch(() => [])).map((r) => r.id);
    await prisma.comment.deleteMany({ where: { entityType: "ADMIN_REQUEST", entityId: { in: aDemandes } } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { id: { in: aDemandes } } }).catch(() => {});
    await prisma.documentRequest.deleteMany({ where: { id: { in: demandes.map((d) => d.id) } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityId: { in: docs } } }).catch(() => {});
    const vIds = (await prisma.validationRequest.findMany({ where: { entityId: { in: docs } }, select: { id: true } }).catch(() => [])).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...docs, ...parents, ...postes] } } }).catch(() => {});
    await prisma.adProDevisLigne.updateMany({ where: { devis: { legalDocumentId: { in: docs } } }, data: { bcId: null } }).catch(() => {});
    await prisma.legalDocument.updateMany({ where: { id: { in: docs } }, data: { chainFromId: null, expenseOrderId: null } }).catch(() => {});
    await prisma.adProItem.updateMany({ where: { id: { in: postes } }, data: { expenseOrderId: null } }).catch(() => {});
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceId: { in: parents } }, select: { id: true } }).catch(() => []);
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres.map((o) => o.id) } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres.map((o) => o.id) } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs } } }).catch(() => {});
    await prisma.adProItemDecision.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: postes } } }).catch(() => {});
    await prisma.adProPorteDg.deleteMany({ where: { entityId: { in: parents } } }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: { in: parents } } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: parents } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: { in: parents } } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: ids } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids }, type: "FILE" } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids } } }).catch(() => {});
    await prisma.documentSequence.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.officeLetterhead.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.companyLegalIdentity.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
  }, 90_000);

  // ── LES GESTES DU DÉCOR, par les vraies actions ─────────────────────────────────────────

  /**
   * LE DG VALIDE LE TOTAL de la demande quand il dépasse le seuil (27/10/2026) — par le vrai geste, sur le total qu'il
   * lit. Ce banc mesure les devis et les BC, pas la porte (éprouvée au § 8) : chaque poste ajouté au congrès change son
   * total, et le DG le revalide aussitôt — une hausse au-delà du total validé rouvre la porte.
   */
  async function dgValideLeTotal(parentId = congres) {
    const p = await lirePorteDg("CONGRESS_NATIONAL", parentId);
    if (p.etat !== "EN_ATTENTE" && p.etat !== "A_REVOIR") return;
    ok(await statuerSurLeTotal({
      user: { id: u.gm, name: `${TAG}gm`, role: "GENERAL_MANAGER" }, parent: "CONGRESS_NATIONAL", parentId,
      decision: "VALIDEE", totalVu: p.total, note: null,
    }));
  }
  async function nouveauPoste(label: string, montant: number, fournisseur = "Imprimerie Alpha", parentId = congres) {
    await comme("kam");
    const a = await addAdProItem(undefined, fd({ parent: "CONGRESS_NATIONAL", parentId, kind: "PRINTING", label: `${TAG}${label}`, amountEstimated: String(montant), supplier: fournisseur }));
    ok(a);
    await dgValideLeTotal(parentId);
    return a.id!;
  }
  /** Le poste soumis, accepté en UN temps par la Direction Marketing AVEC son budget (27/10/2026). */
  async function posteAccorde(label: string, montant: number, fournisseur = "Imprimerie Alpha") {
    const id = await nouveauPoste(label, montant, fournisseur);
    await comme("kam"); ok(await submitAdProItem(undefined, fd({ id })));
    await comme("dm"); ok(await decideAdProItem(undefined, fd({ id, decision: "APPROVED", amountGranted: String(montant), budgetCategoryId: catId })));
    return id;
  }
  /** Un devis déposé par l'écran (avec son fichier) ; rend l'identifiant de la pièce. Ce banc n'a pas de lecture : le dépôt le DIT. */
  async function deposerDevis(id: string, reference: string, fournisseur: string | null, autres: string[] = []): Promise<string> {
    await comme("kam");
    const f = fd({ id, reference: `${TAG}${reference}`, ...(fournisseur ? { fournisseur } : {}) });
    for (const a of autres) f.append("autresPostes", a);
    f.append("attachment", pdf(`${TAG}${reference}.pdf`));
    const r = await ajouterDevisPoste(undefined, f);
    ok(r);
    return r.id!;
  }
  /** Les lignes d'un devis, saisies à la main (la retranscription depuis le papier) — rend leurs identifiants dans l'ordre. */
  async function saisir(id: string, pieceId: string, lignes: LigneSaisie[], extra: Record<string, string> = {}): Promise<string[]> {
    await comme("kam");
    ok(await enregistrerLignesDuDevis(formLignes(id, pieceId, lignes, { tvaRate: "19", ...extra })));
    const base = await prisma.adProDevisLigne.findMany({ where: { devis: { legalDocumentId: pieceId } }, orderBy: { position: "asc" }, select: { id: true } });
    return base.map((l) => l.id);
  }
  const vue = async (id: string, pieceId: string) => {
    const d = ((await devisDesPostes([id])).get(id) ?? []).find((x) => x.pieceId === pieceId);
    expect(d, "le devis doit être lu par le chargeur de l'écran").toBeDefined();
    return d!;
  };
  const bcsDe = (pieceId: string) => prisma.legalDocument.findMany({
    where: { chainFromId: pieceId, kind: "PURCHASE_ORDER", status: { not: "CANCELLED" } }, orderBy: { createdAt: "asc" },
  });
  const poste = (id: string) => prisma.adProItem.findUniqueOrThrow({ where: { id } });
  const designations = (custom: unknown): string[] =>
    ((custom as { fabrique?: { spec?: { lignes?: { designation: string }[] } } })?.fabrique?.spec?.lignes ?? []).map((l) => l.designation);
  const versionDe = (custom: unknown): number => (custom as { fabrique?: { version?: number } })?.fabrique?.version ?? 0;
  const ligneP = async (parentId: string, id: string) => {
    const rows = await loadAdProItems("CONGRESS_NATIONAL", parentId);
    const r = rows.find((x) => x.id === id);
    expect(r, `le poste ${id} doit être lu par le chargeur de l'écran`).toBeDefined();
    return r!;
  };

  // Les postes et devis PARTAGÉS entre les cas (ils se suivent : chaque cas nomme son acteur).
  let p1 = "", devA = "", devB = "", a: string[] = [], b: string[] = [];

  // ═════════════ 0. LES PRÉMISSES ═════════════

  it("PRÉMISSES : le demandeur n'a ni la vue globale, ni Legal, ni le droit d'engager la société ; un autre délégué ne voit pas ce congrès", async () => {
    const kam = await acteur(u.kam, "MEDICAL_DELEGATE");
    expect(hasGlobalView(kam), "une garde éprouvée avec la vue globale ne peut pas tomber").toBe(false);
    expect(hasGlobalView(await acteur(u.kam2, "MEDICAL_DELEGATE"))).toBe(false);
    expect(userCan(kam, "LEGAL", "VIEW"), "le KAM n'a AUCUN droit sur Legal : il génère par la délégation de la demande").toBe(false);
    expect(await canEditCompanyId(u.kam, companyId), "il ne peut pas engager la société à titre personnel").toBe(false);
    expect(await canAccessEntity(kam, "CONGRESS_NATIONAL", congres, "VIEW")).toBe(true);
    expect(await canAccessEntity(await acteur(u.kam2, "MEDICAL_DELEGATE"), "CONGRESS_NATIONAL", congres, "VIEW"), "un autre délégué ne voit pas ce congrès").toBe(false);
  });

  // ═════════════ 1. LE DÉPÔT, LA SAISIE ═════════════

  it("LE DÉPÔT D'UN DEVIS NE PEUT PAS ÉCHOUER SUR LA LECTURE — et il le DIT ; les lignes se saisissent ensuite à la main", async () => {
    p1 = await posteAccorde("Imprimés du congrès", 800_000);
    LECTURE = null;
    await comme("kam");
    const f = fd({ id: p1, reference: `${TAG}DV-A`, fournisseur: "Imprimerie Alpha" });
    f.append("attachment", pdf(`${TAG}DV-A.pdf`));
    const r = await ajouterDevisPoste(undefined, f);
    ok(r);
    expect(r.message, "une lecture qui échoue se dit : « aucune ligne » sans cause se lirait comme un devis vide").toMatch(/Lecture du devis impossible/);
    devA = r.id!;
    expect(await prisma.adProItemPiece.count({ where: { itemId: p1, legalDocumentId: devA, nature: "DEVIS" } })).toBe(1);
    devB = await deposerDevis(p1, "DV-B", "Atelier Beta");
  });

  it("SAISIR LES LIGNES : référence, unité, quantité, prix unitaire ; une quantité illisible reste vide et la ligne ne se valide pas", async () => {
    a = await saisir(p1, devA, [
      { ref: "Fiche posologique", unite: "u", qte: "100", prix: "1000" },
      { ref: "Brochure produit", unite: "u", qte: "50", prix: "2000" },
      { ref: "Kakémono", unite: "u", qte: "4", prix: "25000" },
      { ref: "Affiche", unite: "u", qte: "", prix: "500" },
    ], { announcedTotal: "300000" });
    // Le devis B : un fournisseur de l'ANNUAIRE (nom, adresse, RC, NIF viendront de sa fiche) et un total imprimé faux.
    b = await saisir(p1, devB, [
      { ref: "Carnet", unite: "u", qte: "200", prix: "500" },
      { ref: "Stylos", unite: "u", qte: "1 000", prix: "100" },
      { ref: "Badge", unite: "u", qte: "10", prix: "100" },
    ], { announcedTotal: "250000", supplierId: fournisseurAnnuaire });
    const dA = await vue(p1, devA);
    expect(dA.structure).toBe(true);
    expect(dA.lignes.map((l) => l.reference)).toEqual(["Fiche posologique", "Brochure produit", "Kakémono", "Affiche"]);
    expect(dA.lignes[3].quantity).toBeNull();
    expect(dA.lignes[3].refusValidation, "une quantité illisible n'est pas devinée : la ligne attend d'être complétée").toMatch(/quantité est illisible/);
    expect(dA.ecartTotal, "avec une ligne illisible, on ne déclare pas d'écart sur ce qu'on n'a pas lu").toBeNull();
    const dB = await vue(p1, devB);
    expect(dB.lignes[1].quantity, "« 1 000 » se lit mille, avec ses espaces").toBe(1000);
    expect(dB.ecartTotal, "le total imprimé ne CONTRAINT rien : il se contrôle et se dit").toMatchObject({ annonce: 250_000, calcule: 201_000 });
    expect(dB.fournisseurId).toBe(fournisseurAnnuaire);
  });

  it("SAISIE REFUSÉE : référence vide, quantité négative, TVA absurde — chacun avec sa ligne ; rien n'est écrit", async () => {
    await comme("kam");
    const avant = await prisma.adProDevisLigne.count({ where: { devis: { legalDocumentId: devA } } });
    expect(refus(await enregistrerLignesDuDevis(formLignes(p1, devA, [{ ref: "", qte: "1", prix: "10" }])))).toMatch(/Ligne 1 : la référence/);
    expect(refus(await enregistrerLignesDuDevis(formLignes(p1, devA, [{ ref: "Poster", qte: "-2", prix: "10" }])))).toMatch(/quantité doit être un nombre supérieur à zéro/);
    expect(refus(await enregistrerLignesDuDevis(formLignes(p1, devA, [{ ref: "Poster", qte: "2", prix: "10" }], { tvaRate: "190" })))).toMatch(/TVA/);
    expect(await prisma.adProDevisLigne.count({ where: { devis: { legalDocumentId: devA } } })).toBe(avant);
  });

  // ═════════════ 2. LA VALIDATION DES LIGNES ═════════════

  it("VALIDER : une ligne incomplète est refusée (avec ce qui manque) ; un autre délégué ne valide rien ; une ligne d'un autre devis n'est pas de ce devis", async () => {
    await comme("kam");
    expect(refus(await validerLignesDuDevis(formValider(p1, devA, [a[0], a[3]])))).toMatch(/quantité est illisible/);
    expect((await vue(p1, devA)).nbValidees, "refusé en entier : la ligne complète n'a pas été validée à moitié").toBe(0);
    expect(refus(await validerLignesDuDevis(formValider(p1, devA, [b[0]])))).toMatch(/n'appartient pas à ce devis/);
    ACTOR = await acteur(u.kam2, "MEDICAL_DELEGATE");
    expect(refus(await validerLignesDuDevis(formValider(p1, devA, [a[0]])))).toMatch(/introuvable|Non autorisé/);
    expect((await vue(p1, devA)).nbValidees).toBe(0);
  });

  it("UNE LIGNE NE SE COMMANDE QU'UNE FOIS : validée pour un poste, elle est refusée pour un autre, et la carte nomme le premier", async () => {
    const pa = await nouveauPoste("Poste commun A", 300_000);
    const pb = await nouveauPoste("Poste commun B", 300_000);
    const x = await deposerDevis(pa, "DV-X", "Imprimerie Alpha", [pb]);
    const lx = await saisir(pa, x, [{ ref: "Dépliant", qte: "10", prix: "100" }, { ref: "Flyer", qte: "20", prix: "50" }]);
    await comme("kam");
    ok(await validerLignesDuDevis(formValider(pa, x, [lx[0]])));
    expect(refus(await validerLignesDuDevis(formValider(pb, x, [lx[0]])))).toMatch(/déjà validée pour le poste « .*Poste commun A.*» : une ligne ne se commande qu'une fois/);
    expect((await vue(pb, x)).lignes[0].valideeAilleurs).toContain("Poste commun A");
    ok(await validerLignesDuDevis(formValider(pb, x, [lx[1]])));
    expect((await prisma.adProDevisLigne.findMany({ where: { id: { in: lx } }, orderBy: { position: "asc" }, select: { validatedItemId: true } })).map((l) => l.validatedItemId)).toEqual([pa, pb]);
    // L'ensemble REMPLACE : décocher une ligne la retire, sans toucher à celle de l'autre poste.
    ok(await validerLignesDuDevis(formValider(pa, x, [])));
    expect((await prisma.adProDevisLigne.findMany({ where: { id: { in: lx } }, orderBy: { position: "asc" }, select: { validatedItemId: true } })).map((l) => l.validatedItemId)).toEqual([null, pb]);
  });

  it("COCHER : les lignes complètes se valident, le devis se dit « BC à générer », et décocher retire", async () => {
    await comme("kam");
    const r = await validerLignesDuDevis(formValider(p1, devA, [a[0], a[1]]));
    ok(r);
    expect(r.message).toMatch(/2 lignes validées pour ce poste \(238\s000,00 DZD TTC\)/);
    expect(r.message).toMatch(/à générer/);
    ok(await validerLignesDuDevis(formValider(p1, devB, [b[0]])));
    expect(await prisma.adProDevisLigne.count({ where: { id: { in: a }, validatedItemId: p1 } })).toBe(2);
    const dA = await vue(p1, devA);
    expect(dA).toMatchObject({ etat: "A_GENERER", nbValidees: 2, totalValideHt: 200_000, totalValideTtc: 238_000 });
    expect((await vue(p1, devB)).totalValideTtc).toBe(119_000);
    const rien = await validerLignesDuDevis(formValider(p1, devA, [a[0], a[1]]));
    expect(rien.ok && rien.message).toMatch(/Rien n'a changé/);
  });

  it("LA LIGNE LUE EST UNE PROPOSITION : elle ne se valide qu'avec l'attestation « j'ai comparé au devis » ; un chiffre illisible n'est jamais deviné", async () => {
    // La lecture du banc : quatre lignes, la troisième sans quantité lisible.
    LECTURE = {
      announced: 50_000,
      lignes: [
        { rang: 0, reference: "Dossier de presse", unit: "u", quantity: 10, unitPrice: 2000, notes: [], suspecte: [] },
        { rang: 1, reference: "Roll-up", unit: "u", quantity: 2, unitPrice: 15000, notes: [], suspecte: [] },
        { rang: 2, reference: "Sacoches", unit: null, quantity: null, unitPrice: 800, notes: ["quantité illisible"], suspecte: [] },
      ],
    };
    try {
      const p3 = await nouveauPoste("Poste lu", 300_000);
      await comme("kam");
      const f = fd({ id: p3, reference: `${TAG}DV-L`, fournisseur: "Imprimerie Alpha" });
      f.append("attachment", pdf(`${TAG}DV-L.pdf`));
      const dep = await ajouterDevisPoste(undefined, f);
      ok(dep);
      expect(dep.message).toMatch(/Devis lu \(texte natif, banc\) : 3 lignes proposées/);
      expect(dep.message, "la phrase dit que seules les lignes cochées entrent dans un BC").toMatch(/seules les lignes cochées entrent dans un bon de commande/);
      const lignes = await prisma.adProDevisLigne.findMany({ where: { devis: { legalDocumentId: dep.id! } }, orderBy: { position: "asc" } });
      expect(lignes.map((l) => l.lue)).toEqual([0, 1, 2]);
      expect(lignes[2].quantity, "un chiffre illisible reste null : jamais deviné").toBeNull();
      expect(lignes.every((l) => l.validatedItemId === null), "une lecture ne valide RIEN").toBe(true);
      const ids = lignes.map((l) => l.id);
      expect(refus(await validerLignesDuDevis(formValider(p3, dep.id!, [ids[0]])))).toMatch(/J'ai comparé ces lignes au devis/);
      expect(await prisma.adProDevisLigne.count({ where: { id: { in: ids }, validatedItemId: p3 } })).toBe(0);
      expect(refus(await validerLignesDuDevis(formValider(p3, dep.id!, [ids[2]], { compare: "1" })))).toMatch(/quantité est illisible/);
      ok(await validerLignesDuDevis(formValider(p3, dep.id!, [ids[0], ids[1]], { compare: "1" })));
      expect(await prisma.adProDevisLigne.count({ where: { id: { in: ids }, validatedItemId: p3 } })).toBe(2);
      // UNE RELECTURE NE REMPLACE PAS CE QU'UNE PERSONNE A ATTESTÉ : refusée dès qu'une ligne est validée.
      expect(refus(await lireLesLignesDuDevis(fd({ id: p3, pieceId: dep.id! })))).toMatch(/lignes de ce devis sont déjà validées/);
    } finally {
      LECTURE = null;
    }
  });

  it("CORRIGER UNE LIGNE VALIDÉE lui retire sa validation (l'attestation portait sur l'ancien prix) ; les autres gardent la leur", async () => {
    const pc = await nouveauPoste("Poste correction", 300_000);
    const x = await deposerDevis(pc, "DV-C", "Imprimerie Alpha");
    const lx = await saisir(pc, x, [{ ref: "Panneau", qte: "5", prix: "1000" }, { ref: "Totem", qte: "2", prix: "3000" }]);
    await comme("kam");
    ok(await validerLignesDuDevis(formValider(pc, x, lx)));
    const r = await enregistrerLignesDuDevis(formLignes(pc, x, [
      { id: lx[0], ref: "Panneau", qte: "5", prix: "1200" },
      { id: lx[1], ref: "Totem", qte: "2", prix: "3000" },
    ], { tvaRate: "19" }));
    ok(r);
    expect(r.message).toMatch(/1 ligne corrigée n'est plus validée : revalidez-la devant le papier/);
    const apres = await prisma.adProDevisLigne.findMany({ where: { id: { in: lx } }, orderBy: { position: "asc" }, select: { validatedItemId: true } });
    expect(apres.map((l) => l.validatedItemId)).toEqual([null, pc]);
  });

  it("RETIRER UN DEVIS DU POSTE retire les lignes qu'il y faisait valider (la validation tient au lien du devis avec le poste)", async () => {
    const pr = await nouveauPoste("Poste retrait", 300_000);
    const x = await deposerDevis(pr, "DV-R", "Imprimerie Alpha");
    const lx = await saisir(pr, x, [{ ref: "Bâche", qte: "3", prix: "2000" }]);
    await comme("kam");
    ok(await validerLignesDuDevis(formValider(pr, x, lx)));
    ok(await retirerDevisDuPoste(undefined, fd({ id: pr, pieceId: x })));
    expect((await prisma.adProDevisLigne.findUniqueOrThrow({ where: { id: lx[0] } })).validatedItemId).toBeNull();
  });

  // ═════════════ 3. LA GÉNÉRATION ═════════════

  it("GÉNÉRER REFUSÉ tant que le poste n'est pas accordé — et la carte ne propose pas le geste", async () => {
    const pd = await nouveauPoste("Poste brouillon", 300_000);
    const x = await deposerDevis(pd, "DV-D", "Imprimerie Alpha");
    const lx = await saisir(pd, x, [{ ref: "Calendrier", qte: "10", prix: "100" }]);
    await comme("kam");
    ok(await validerLignesDuDevis(formValider(pd, x, lx)));
    const phrase = refus(await genererBonDeCommandePoste(fd({ id: pd })));
    expect(phrase).toMatch(/accordé par la Direction/);
    const row = await ligneP(congres, pd);
    expect(refusGenerationBC({
      status: row.status, amountGranted: row.amountGranted, budgetCategoryId: row.budgetCategoryId, orderStage: row.orderStage,
      expenseOrderId: row.expenseOrderId, demandeChez: null, demandeOuverte: row.demandeBC !== null,
    }), "la carte lit la MÊME règle que l'action").toBe(phrase);
    expect(prochainPas(faitsDuPoste(row), REGARD_DEMANDEUR).geste?.cle).not.toBe("GENERER_BC");
    expect(await prisma.legalDocument.count({ where: { chainFromId: x, kind: "PURCHASE_ORDER" } })).toBe(0);
  });

  it("UN AUTRE DÉLÉGUÉ NE GÉNÈRE PAS le BC d'un poste qu'il ne voit pas — la même phrase que l'absence", async () => {
    ACTOR = await acteur(u.kam2, "MEDICAL_DELEGATE");
    expect(refus(await genererBonDeCommandePoste(fd({ id: p1 })))).toMatch(/Poste introuvable|Non autorisé/);
    expect(await prisma.legalDocument.count({ where: { chainFromId: { in: [devA, devB] }, kind: "PURCHASE_ORDER" } })).toBe(0);
  });

  it("LA CARTE PROPOSE « Générer les BC (2) », et le geste proposé est ACCEPTÉ : un BC PAR DEVIS, avec UNIQUEMENT les lignes validées, découlant de son devis", async () => {
    const avant = await ligneP(congres, p1);
    const pas = prochainPas(faitsDuPoste(avant), REGARD_DEMANDEUR);
    expect(pas.geste, "deux devis ont des lignes validées : un geste, pour les deux").toMatchObject({ cle: "GENERER_BC", libelle: "Générer les BC (2)" });
    expect(avant.orderStage).toBe("NONE");

    await comme("kam");
    // ÉTAPE 1 — l'APERÇU : un brouillon par devis, et RIEN d'autre (ni BC, ni numéro, ni marche, ni Finances).
    const apercu = await genererBonDeCommandePoste(fd({ id: p1 }));
    ok(apercu);
    expect(apercu.message).toMatch(/Brouillon — à vérifier par le demandeur/);
    expect(await bcsDe(devA), "aucun BC avant la validation de l'aperçu").toHaveLength(0);
    expect(await bcsDe(devB)).toHaveLength(0);
    expect((await poste(p1)).orderStage, "rien n'est parti aux Finances ni au centre").toBe("NONE");
    expect((await vue(p1, devA)).brouillon, "le brouillon est sur le devis").not.toBeNull();
    // Seul le DEMANDEUR (ou le Super Admin) valide : la Direction, qui n'a pas demandé, ne valide pas à sa place.
    await comme("ops");
    expect(refus(await validerEtEnvoyerBcPoste(fd({ id: p1 })))).toMatch(/Seul le demandeur|Non autorisé/);
    expect(await bcsDe(devA)).toHaveLength(0);
    // ÉTAPE 2 — le demandeur valide : le numéro est attribué, le BC part.
    await comme("kam");
    const r = await validerEtEnvoyerBcPoste(fd({ id: p1 }));
    ok(r);
    expect(r.message).toMatch(/2 bons de commande générés/);
    expect(r.message, "au-dessus du seuil, le centre Ad & Pro vise le poste").toMatch(/centre de validation Ad & Pro/);

    const [bcA, bcB] = [await bcsDe(devA), await bcsDe(devB)];
    expect(bcA, "UN BC par devis").toHaveLength(1);
    expect(bcB).toHaveLength(1);
    // UNIQUEMENT les lignes validées : « Kakémono » et « Affiche » (non cochées) n'y sont pas.
    expect(designations(bcA[0].custom)).toEqual(["Fiche posologique", "Brochure produit"]);
    expect(designations(bcB[0].custom)).toEqual(["Carnet"]);
    expect(Number(bcA[0].amount), "le BC porte le TTC des seules lignes validées").toBe(238_000);
    expect(Number(bcB[0].amount)).toBe(119_000);
    expect(bcA[0].chainFromId, "le BC découle de SON devis").toBe(devA);
    expect(bcB[0].chainFromId).toBe(devB);
    expect(bcA[0].reference).not.toBe(bcB[0].reference);
    // Sa porte est le visa du POSTE : la source est le poste, pas une pièce isolée.
    expect(bcA[0]).toMatchObject({ sourceType: "AD_PRO_ITEM", sourceId: p1, companyId });
    // Rattaché au poste, chacun avec son Word et son PDF (téléchargeables sous la porte de la pièce).
    expect(await prisma.adProItemPiece.count({ where: { itemId: p1, nature: "BON_DE_COMMANDE", legalDocumentId: { in: [bcA[0].id, bcB[0].id] } } })).toBe(2);
    for (const bc of [bcA[0], bcB[0]]) {
      const f = fichiersEmis(bc.custom);
      expect(f.docx, `le Word de ${bc.reference}`).not.toBeNull();
      expect(f.pdf, `le PDF de ${bc.reference}`).not.toBeNull();
    }
    // Le fournisseur de l'annuaire est celui du BC B : son nom vient de la fiche.
    expect(((bcB[0].custom as { fabrique?: { spec?: { tiers?: { nom?: string } } } }).fabrique?.spec?.tiers?.nom)).toBe(`${TAG} Imprimerie Atlas`);
    // Les lignes couvertes sont liées à leur BC — et seulement elles.
    const liees = await prisma.adProDevisLigne.findMany({ where: { id: { in: [...a, ...b] } }, select: { id: true, bcId: true } });
    const parId = new Map(liees.map((l) => [l.id, l.bcId]));
    expect([a[0], a[1]].map((l) => parId.get(l))).toEqual([bcA[0].id, bcA[0].id]);
    expect([a[2], a[3]].map((l) => parId.get(l)), "une ligne non validée n'est jamais sur un BC").toEqual([null, null]);
    expect(parId.get(b[0])).toBe(bcB[0].id);
    // Le poste a pris la marche du BC : au-dessus du seuil (800 000 > 500 000), le centre Ad & Pro vise.
    const p = await poste(p1);
    expect(p.orderStage).toBe("REQUESTED");
    expect(Number(p.amountGranted), "générer ne change jamais le montant accordé").toBe(800_000);
    expect((await etatDuBC(bcA[0].id))?.etape, "la porte du BC est le visa du poste").toBe("A_VALIDER");
    expect((await etatDuBC(bcB[0].id))?.etape).toBe("A_VALIDER");
    // Les deux devis sont à jour ; plus rien à générer.
    expect((await vue(p1, devA)).etat).toBe("A_JOUR");
    expect((await vue(p1, devB)).etat).toBe("A_JOUR");
    const apres = await ligneP(congres, p1);
    expect(prochainPas(faitsDuPoste(apres), REGARD_DEMANDEUR).geste?.cle).not.toBe("GENERER_BC");
    // La case BC du poste lit les DEUX BC ; le BC « d'ensemble » est le moins avancé.
    const pieces = (await piecesDesPostes([p1])).get(p1)!;
    expect(pieces.bcs.map((x) => x.id).sort()).toEqual([bcA[0].id, bcB[0].id].sort());
    expect(pieces.bcs.every((x) => x.emis.docx && x.emis.pdf)).toBe(true);
  }, 120_000);

  it("GÉNÉRER DEUX FOIS ne crée RIEN de plus : chaque devis a son BC, à jour — et l'action le dit", async () => {
    await comme("kam");
    const r = await genererBonDeCommandePoste(fd({ id: p1 }));
    ok(r);
    expect(r.message).toMatch(/Chaque devis validé a déjà son bon de commande, à jour/);
    expect((await bcsDe(devA)).length + (await bcsDe(devB)).length).toBe(2);
  });

  it("DEUX GÉNÉRATIONS SIMULTANÉES ne font qu'UN BC par devis (un geste à la fois sur un poste)", async () => {
    const pc = await posteAccorde("Poste simultané", 400_000);
    const x = await deposerDevis(pc, "DV-S", "Imprimerie Alpha");
    const lx = await saisir(pc, x, [{ ref: "Livret", qte: "100", prix: "300" }]);
    await comme("kam");
    ok(await validerLignesDuDevis(formValider(pc, x, lx)));
    const [r1, r2] = await Promise.all([genererEtValider(fd({ id: pc })), genererEtValider(fd({ id: pc }))]);
    // Le second clic arrive après le premier (un geste à la fois sur le poste) : il est ok (à jour) ou refusé faute d'aperçu à valider.
    expect([r1, r2].some((r) => r.ok), "un des deux clics fait le BC").toBe(true);
    expect(await bcsDe(x), "deux clics ne font pas deux commandes").toHaveLength(1);
    expect(await prisma.adProItemPiece.count({ where: { itemId: pc, nature: "BON_DE_COMMANDE" } })).toBe(1);
  }, 120_000);

  // ═════════════ 4. RÉGÉNÉRER ═════════════

  it("S'IL OUBLIE UNE RÉFÉRENCE : il la coche et RÉGÉNÈRE — le MÊME BC, même numéro, version suivante, sans toucher à l'autre devis", async () => {
    const [avantA] = await bcsDe(devA);
    const [avantB] = await bcsDe(devB);
    expect(versionDe(avantA.custom)).toBe(1);
    await comme("kam");
    const coche = await validerLignesDuDevis(formValider(p1, devA, [a[0], a[1], a[2]]));
    ok(coche);
    expect(coche.message).toMatch(/n'est plus à jour : régénérez-le/);
    expect(await vue(p1, devA)).toMatchObject({ etat: "A_REGENERER", nbAjoutees: 1, nbRetirees: 0 });

    const r = await genererEtValider(fd({ id: p1, pieceId: devA }));
    ok(r);
    expect(r.message).toMatch(/mis à jour/);
    expect(r.message).toMatch(/révisé, version 2/);
    const apres = await bcsDe(devA);
    expect(apres, "révisé, pas recréé : un seul BC pour ce devis").toHaveLength(1);
    expect(apres[0].id).toBe(avantA.id);
    expect(apres[0].reference, "même numéro").toBe(avantA.reference);
    expect(versionDe(apres[0].custom)).toBe(2);
    expect(designations(apres[0].custom)).toEqual(["Fiche posologique", "Brochure produit", "Kakémono"]);
    expect(Number(apres[0].amount)).toBe(357_000);
    // L'autre devis n'a pas bougé.
    const [apresB] = await bcsDe(devB);
    expect(versionDe(apresB.custom), "le BC du devis B reste à sa version 1").toBe(1);
    expect(apresB.id).toBe(avantB.id);
    expect((await prisma.adProDevisLigne.findUniqueOrThrow({ where: { id: a[2] } })).bcId, "la ligne ajoutée est désormais sur le BC").toBe(avantA.id);
    expect((await vue(p1, devA)).etat).toBe("A_JOUR");
    expect(await prisma.adProItemPiece.count({ where: { itemId: p1, nature: "BON_DE_COMMANDE" } }), "aucun BC de plus au poste").toBe(2);
  }, 120_000);

  it("LES LIGNES D'UN DEVIS NE SE CORRIGENT PLUS SOUS UN BC ACTIF, ni ne se relisent — le refus nomme le geste", async () => {
    await comme("kam");
    expect(refus(await enregistrerLignesDuDevis(formLignes(p1, devA, [{ id: a[0], ref: "Fiche posologique", qte: "100", prix: "900" }])))).toMatch(/porte déjà un bon de commande \(.*\).*Annuler la demande de BC/);
    expect(refus(await lireLesLignesDuDevis(fd({ id: p1, pieceId: devA })))).toMatch(/porte déjà un bon de commande/);
    expect(Number((await prisma.adProDevisLigne.findUniqueOrThrow({ where: { id: a[0] } })).unitPrice)).toBe(1000);
  });

  // ═════════════ 5. L'ARGENT, LES FOURNISSEURS, LA DEMANDE OUVERTE ═════════════

  it("LES BC NE DÉPASSENT JAMAIS L'ACCORDÉ : les deux montants sont dits, rien n'est composé, et le poste n'est pas laissé « demandé »", async () => {
    const pd = await posteAccorde("Poste plafonné", 100_000);
    const x = await deposerDevis(pd, "DV-P", "Imprimerie Alpha");
    const lx = await saisir(pd, x, [{ ref: "Catalogue", qte: "100", prix: "1000" }]);
    await comme("kam");
    ok(await validerLignesDuDevis(formValider(pd, x, lx)));
    const phrase = refus(await genererBonDeCommandePoste(fd({ id: pd })));
    expect(phrase).toMatch(/119\s000,00 DZD TTC/);
    expect(phrase).toMatch(/100\s000,00 DZD accordés/);
    // La phrase de `refusDepassement` (« le montant accordé s'entend TTC ») nomme les DEUX gestes qui lèvent l'écart.
    expect(phrase).toMatch(/demandez une révision du poste pour le relever \(ou décochez une ligne\)/);
    expect(await bcsDe(x)).toHaveLength(0);
    expect((await poste(pd)).orderStage, "le refus ne prend pas la marche du BC").toBe("NONE");
    expect(await prisma.adProItemPiece.count({ where: { itemId: pd, nature: "BON_DE_COMMANDE" } })).toBe(0);
  });

  it("UN FOURNISSEUR QUI N'EST PAS NOMMÉ ne se devine pas : le refus dit où le renseigner, et le poste n'est pas laissé « demandé »", async () => {
    const pe = await posteAccorde("Poste sans fournisseur", 300_000, "");
    const x = await deposerDevis(pe, "DV-F", null);
    const lx = await saisir(pe, x, [{ ref: "Posters", qte: "10", prix: "100" }]);
    await comme("kam");
    ok(await validerLignesDuDevis(formValider(pe, x, lx)));
    expect(refus(await genererBonDeCommandePoste(fd({ id: pe })))).toMatch(/Le fournisseur de ce devis n'est pas nommé/);
    expect(await bcsDe(x)).toHaveLength(0);
    expect((await poste(pe)).orderStage).toBe("NONE");
  });

  it("UN DEVIS QUE LE BC NE PEUT PAS PORTER : un taux hors Algérie se refuse à la saisie et AVANT la marche ; un refus de la fabrique APRÈS la marche la rend", async () => {
    const ph = await posteAccorde("Poste TVA", 300_000);
    const x = await deposerDevis(ph, "DV-T", "Imprimerie Alpha");
    const lx = await saisir(ph, x, [{ ref: "Cartes", qte: "10", prix: "100" }]);
    await comme("kam");
    expect(refus(await enregistrerLignesDuDevis(formLignes(ph, x, [{ id: lx[0], ref: "Cartes", qte: "10", prix: "100" }], { tvaRate: "13" })))).toMatch(/n'existe pas en Algérie/);
    expect(refus(await enregistrerLignesDuDevis(formLignes(ph, x, [{ id: lx[0], ref: "Cartes", qte: "10", prix: "100" }], { tvaRate: "19", extraTaxRate: "100" })))).toMatch(/sous 100/);
    ok(await validerLignesDuDevis(formValider(ph, x, lx)));
    // Une LECTURE de travers a pu écrire un taux ou une taxe que la saisie refuse : le décor le simule en base (nommé).
    await prisma.adProDevis.update({ where: { legalDocumentId: x }, data: { tvaRate: 13 } });
    expect(refus(await genererBonDeCommandePoste(fd({ id: ph })))).toMatch(/taux de TVA du devis \(13 %\) n'existe pas en Algérie/);
    expect((await poste(ph)).orderStage, "refusé AVANT la marche").toBe("NONE");
    // Une taxe de 100 % passe le pré-contrôle (rien ne la voit) : c'est la fabrique qui refuse, APRÈS la prise de la marche.
    await prisma.adProDevis.update({ where: { legalDocumentId: x }, data: { tvaRate: 19, extraTaxRate: 100, extraTaxLabel: "Taxe lue de travers" } });
    const e = refus(await genererEtValider(fd({ id: ph })));
    expect(e).toMatch(/Aucun bon de commande n'a pu être généré/);
    expect(e).toMatch(/Taxe additionnelle/);
    const apres = await poste(ph);
    expect(apres.orderStage, "la marche prise pour rien est rendue : le poste n'est pas laissé « demandé » sans BC").toBe("NONE");
    expect(apres.orderRequestedById).toBeNull();
    expect(await bcsDe(x)).toHaveLength(0);
  });

  it("DEUX CHEMINS POUR LE MÊME BC feraient deux commandes : une demande ouverte chez l'assistante ferme la génération — la carte dit la même phrase", async () => {
    const pf = await posteAccorde("Poste demande ouverte", 300_000);
    const x = await deposerDevis(pf, "DV-O", "Imprimerie Alpha");
    const lx = await saisir(pf, x, [{ ref: "Pochettes", qte: "50", prix: "100" }]);
    try {
      ASSISTANTES = [u.ast1];
      await comme("kam");
      ok(await validerLignesDuDevis(formValider(pf, x, lx)));
      ok(await requestAdProItemOrder(undefined, fd({ id: pf, note: "Je préfère que l'assistante l'établisse.", assistantId: u.ast1 })));
      const phrase = refus(await genererBonDeCommandePoste(fd({ id: pf })));
      expect(phrase).toMatch(/La demande de bon de commande est déjà chez .*Annuler la demande de BC/);
      const row = await ligneP(congres, pf);
      expect(row.demandeBC, "la demande est ouverte").not.toBeNull();
      expect(refusGenerationBC({
        status: row.status, amountGranted: row.amountGranted, budgetCategoryId: row.budgetCategoryId, orderStage: row.orderStage,
        expenseOrderId: row.expenseOrderId, demandeChez: row.demandeBC?.assistante ?? null, demandeOuverte: true,
      }), "la carte dit la même phrase que l'action").toBe(phrase);
      expect(await bcsDe(x)).toHaveLength(0);
    } finally {
      ASSISTANTES = null;
    }
  });

  // ═════════════ 6. LA SIGNATURE FIGE ═════════════

  it("UN BC SIGNÉ NE SE RÉÉCRIT PLUS : le poste n'est « signé » que quand les DEUX BC le sont, et le refus nomme les gestes qui restent", async () => {
    const [bcA] = await bcsDe(devA);
    const [bcB] = await bcsDe(devB);
    // Le centre Ad & Pro vise le poste (une fois, pour ses deux BC) — la porte des BC générés EST le visa du poste.
    await comme("gm");
    ok(await approveAdProItemOrder(undefined, fd({ id: p1, decision: "APPROVE", montantVu: "800000", prestataireVu: "Imprimerie Alpha" })));
    expect((await etatDuBC(bcA.id))?.etape).toBe("A_SIGNER");
    expect((await etatDuBC(bcB.id))?.etape, "un seul visa couvre les deux BC du poste").toBe("A_SIGNER");
    // Les Finances signent le BC B seulement.
    await comme("fin");
    ok(await signerBonDeCommande(avecCopieSignee(fd({ id: bcB.id }))));
    expect((await etatDuBC(bcB.id))?.etape).toBe("SIGNE");
    expect((await piecesDesPostes([p1])).get(p1)!.bc?.etape, "le poste n'est pas signé tant qu'un de ses BC ne l'est pas").toBe("A_SIGNER");

    await comme("kam");
    // Le BC B est signé : ses lignes ne bougent plus — ni on en coche une, ni on en décoche une.
    const gel = refus(await validerLignesDuDevis(formValider(p1, devB, [b[0], b[1]])));
    expect(gel).toMatch(/signé par les Finances.*joignez un bon de commande existant/);
    expect(gel).toMatch(/ne changent plus tant qu'il tient/);
    expect(refus(await validerLignesDuDevis(formValider(p1, devB, [])))).toMatch(/signé par les Finances/);
    expect(await prisma.adProDevisLigne.count({ where: { id: { in: b }, validatedItemId: p1 } })).toBe(1);
    // Le BC A n'est pas signé : il se régénère encore — ici une ligne retirée.
    ok(await validerLignesDuDevis(formValider(p1, devA, [a[0], a[1]])));
    expect(await vue(p1, devA)).toMatchObject({ etat: "A_REGENERER", nbRetirees: 1 });
    const r = await genererEtValider(fd({ id: p1, pieceId: devA }));
    ok(r);
    expect(versionDe((await bcsDe(devA))[0].custom)).toBe(3);
    // Payer exige les DEUX signatures : la facture ne se dépose pas après le seul BC B.
    expect(refus(await demanderPaiementPoste(undefined, (() => { const f = fd({ id: p1, montant: "300000", reference: `${TAG}FA`, argumentation: "Écart connu et accepté (banc).", confirme: "1" }); f.append("attachment", pdf(`${TAG}fa.pdf`)); return f; })())))
      .toMatch(/pas encore signé par les Finances/);
    // Les Finances signent le BC A (révisé) : le poste est signé, la facture peut être déposée.
    await comme("fin");
    ok(await signerBonDeCommande(avecCopieSignee(fd({ id: bcA.id }))));
    expect((await piecesDesPostes([p1])).get(p1)!.bc?.etape).toBe("SIGNE");
    // Les deux BC sont signés : plus aucune ligne de A ne bouge non plus.
    await comme("kam");
    expect(refus(await validerLignesDuDevis(formValider(p1, devA, [a[0]])))).toMatch(/signé par les Finances/);
    const rien = await genererEtValider(fd({ id: p1, pieceId: devA }));
    ok(rien);
    expect(rien.message, "à jour : rien à régénérer, rien n'est refait").toMatch(/déjà son bon de commande, à jour/);
  }, 180_000);

  it("PAYÉ, LE POSTE NE GÉNÈRE PLUS : la facture est déposée sur le BC le moins avancé, et la génération se ferme avec la phrase du paiement", async () => {
    await comme("kam");
    const f = fd({ id: p1, montant: "300000", reference: `${TAG}FA2`, argumentation: "Écart connu et accepté (banc).", confirme: "1" });
    f.append("attachment", pdf(`${TAG}fa2.pdf`));
    ok(await demanderPaiementPoste(undefined, f));
    expect(refus(await genererBonDeCommandePoste(fd({ id: p1 })))).toMatch(/paiement de ce poste est déjà demandé/);
    const row = await ligneP(congres, p1);
    expect(prochainPas(faitsDuPoste(row), REGARD_DEMANDEUR).geste?.cle).not.toBe("GENERER_BC");
  }, 120_000);

  // ═════════════ 7. L'ANNULATION ═════════════

  it("PLUS AUCUNE LIGNE VALIDÉE : le BC ne se vide pas, il s'annule ; annulé, le devis redevient « à générer » et un BC NEUF naît", async () => {
    const pg = await posteAccorde("Poste annulation", 300_000);
    const x = await deposerDevis(pg, "DV-G", "Imprimerie Alpha");
    const lx = await saisir(pg, x, [{ ref: "Autocollants", qte: "100", prix: "100" }, { ref: "Tampons", qte: "5", prix: "400" }]);
    await comme("kam");
    ok(await validerLignesDuDevis(formValider(pg, x, lx)));
    ok(await genererEtValider(fd({ id: pg })));
    const [premier] = await bcsDe(x);
    expect((await poste(pg)).orderStage, "sous le seuil, le poste passe à la signature des Finances").toBe("DIRECTION_OK");
    ok(await validerLignesDuDevis(formValider(pg, x, [])));
    expect(await vue(pg, x)).toMatchObject({ etat: "A_ANNULER", nbRetirees: 2 });
    expect(refus(await genererBonDeCommandePoste(fd({ id: pg })))).toMatch(/Plus aucune ligne n'est validée.*annulez-le/);
    expect(await bcsDe(x), "le BC n'a pas été vidé").toHaveLength(1);
    // Le devis ne se retire pas du poste tant qu'un BC en découle.
    expect(refus(await retirerDevisDuPoste(undefined, fd({ id: pg, pieceId: x })))).toMatch(/bon de commande ou une facture découle/);
    // « Annuler la demande de BC » annule le BC au registre et rend le poste à « BC à demander ».
    ok(await retirerDemandeBC(undefined, fd({ id: pg, motif: "Mauvais devis, on recommence." })));
    expect((await poste(pg)).orderStage).toBe("NONE");
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: premier.id } })).status).toBe("CANCELLED");
    expect(await vue(pg, x), "plus de BC actif, plus de ligne validée : rien à faire").toMatchObject({ etat: "AUCUNE_LIGNE", bc: null });
    // On recoche : le BC est à générer, et le nouveau BC n'a pas le numéro de l'ancien.
    ok(await validerLignesDuDevis(formValider(pg, x, [lx[1]])));
    expect((await vue(pg, x)).etat).toBe("A_GENERER");
    ok(await genererEtValider(fd({ id: pg })));
    const vivants = await bcsDe(x);
    expect(vivants).toHaveLength(1);
    expect(vivants[0].id).not.toBe(premier.id);
    expect(designations(vivants[0].custom)).toEqual(["Tampons"]);
  }, 180_000);

  // ═════════════ 8. LA PORTE DU DG SUR LE TOTAL DE LA DEMANDE (27/10/2026) ═════════════

  it("AU-DESSUS DU SEUIL, RIEN NE S'ENGAGE tant que le DG n'a pas validé le TOTAL : ni BC généré, ni BC demandé, ni paiement — puis le BC part ; une rallonge rouvre la porte", async () => {
    // Le congrès de Tlemcen, prévalidé (requestStatus APPROVED), à son délégué : un stand de 1 200 000 DZD, au-dessus des
    // 1 000 000 du seuil — le seuil vaut pour la SOMME des postes de la demande, pas par poste.
    ACTOR = await acteur(u.kam2, "MEDICAL_DELEGATE");
    const add = await addAdProItem(undefined, fd({ parent: "CONGRESS_NATIONAL", parentId: congres2, kind: "PRINTING", label: `${TAG}Stand de Tlemcen`, amountEstimated: "1200000", supplier: "Imprimerie Alpha" }));
    ok(add);
    const ps = add.id!;
    ok(await submitAdProItem(undefined, fd({ id: ps })));
    await comme("dm");
    ok(await decideAdProItem(undefined, fd({ id: ps, decision: "APPROVED", amountGranted: "1200000", budgetCategoryId: catId })));
    const fermee = await lirePorteDg("CONGRESS_NATIONAL", congres2);
    expect(fermee).toMatchObject({ etat: "EN_ATTENTE", total: 1_200_000, seuil: SEUIL_DG });
    // Le DG est prévenu, une fois pour ce total.
    expect(Number((await prisma.adProPorteDg.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "CONGRESS_NATIONAL", entityId: congres2 } } })).signaleMontant)).toBe(1_200_000);
    ACTOR = await acteur(u.kam2, "MEDICAL_DELEGATE");
    const f = fd({ id: ps, reference: `${TAG}DV-DG`, fournisseur: "Imprimerie Alpha" });
    f.append("attachment", pdf(`${TAG}DV-DG.pdf`));
    const dep = await ajouterDevisPoste(undefined, f);
    ok(dep);
    ok(await enregistrerLignesDuDevis(formLignes(ps, dep.id!, [{ ref: "Stand modulaire", unite: "u", qte: "1", prix: "1000000" }], { tvaRate: "19" })));
    const lignes = (await prisma.adProDevisLigne.findMany({ where: { devis: { legalDocumentId: dep.id! } }, select: { id: true } })).map((l) => l.id);
    ok(await validerLignesDuDevis(formValider(ps, dep.id!, lignes)));

    // PORTE FERMÉE : chaque geste qui engagerait de l'argent est refusé, avec la même phrase.
    const generer = refus(await genererBonDeCommandePoste(fd({ id: ps })));
    expect(generer).toMatch(/au-dessus du seuil de .* la validation du Directeur Général est requise/);
    expect(generer).toMatch(/Aucun bon de commande, engagement ni paiement n'est possible d'ici là/);
    expect(refus(await requestAdProItemOrder(undefined, fd({ id: ps, note: "BC à émettre." })))).toBe(generer);
    const paiement = fd({ id: ps, montant: "1190000", reference: `${TAG}FA-DG`, argumentation: "Banc.", confirme: "1" });
    paiement.append("attachment", pdf(`${TAG}fa-dg.pdf`));
    expect(refus(await demanderPaiementPoste(undefined, paiement))).toBe(generer);
    expect(await bcsDe(dep.id!)).toHaveLength(0);
    expect((await poste(ps)).orderStage).toBe("NONE");
    // La CARTE dit la même attente (elle lit la porte de la demande, comme l'action).
    const row = await ligneP(congres2, ps);
    const pas = prochainPas({ ...faitsDuPoste(row), porteDg: fermee.etat, porteDgPhrase: fermee.phrase }, REGARD_DEMANDEUR);
    expect(pas.geste).toBeNull();
    expect(pas.attente).toMatch(/En attente — le Directeur Général valide le total de la demande/);

    // QUI STATUE : le DG (ou le Super Admin) — pas le demandeur ; un renvoi exige son motif ; le total vu doit être le total lu.
    const kam2 = { id: u.kam2, name: `${TAG}kam2`, role: "MEDICAL_DELEGATE" };
    const gm = { id: u.gm, name: `${TAG}gm`, role: "GENERAL_MANAGER" };
    expect(refus(await statuerSurLeTotal({ user: kam2, parent: "CONGRESS_NATIONAL", parentId: congres2, decision: "VALIDEE", totalVu: 1_200_000, note: null })))
      .toMatch(/Seul le Directeur Général/);
    expect(refus(await statuerSurLeTotal({ user: gm, parent: "CONGRESS_NATIONAL", parentId: congres2, decision: "A_REVOIR", totalVu: 1_200_000, note: "  " })))
      .toMatch(/Dites ce qu'il faut revoir/);
    expect(refus(await statuerSurLeTotal({ user: gm, parent: "CONGRESS_NATIONAL", parentId: congres2, decision: "VALIDEE", totalVu: 1_100_000, note: null })))
      .toMatch(/Le total vient de changer/);
    expect((await lirePorteDg("CONGRESS_NATIONAL", congres2)).etat, "aucun de ces refus n'ouvre la porte").toBe("EN_ATTENTE");
    ok(await statuerSurLeTotal({ user: gm, parent: "CONGRESS_NATIONAL", parentId: congres2, decision: "VALIDEE", totalVu: 1_200_000, note: null }));
    expect((await lirePorteDg("CONGRESS_NATIONAL", congres2)).etat).toBe("VALIDEE");

    // PORTE OUVERTE : le BC se génère (au-dessus du seuil des BC, le centre Ad & Pro vise ensuite).
    ACTOR = await acteur(u.kam2, "MEDICAL_DELEGATE");
    ok(await genererEtValider(fd({ id: ps })));
    const [bc] = await bcsDe(dep.id!);
    expect(Number(bc.amount)).toBe(1_190_000);
    expect((await poste(ps)).orderStage).toBe("REQUESTED");

    // UNE RALLONGE ROUVRE LA PORTE : un poste de plus porte le total au-delà de ce que le DG a validé.
    ok(await addAdProItem(undefined, fd({ parent: "CONGRESS_NATIONAL", parentId: congres2, kind: "PRINTING", label: `${TAG}Rallonge`, amountEstimated: "50000", supplier: "Imprimerie Alpha" })));
    const rouverte = await lirePorteDg("CONGRESS_NATIONAL", congres2);
    expect(rouverte).toMatchObject({ etat: "EN_ATTENTE", total: 1_250_000 });
    await comme("gm");
    expect(refus(await approveAdProItemOrder(undefined, fd({ id: ps, decision: "APPROVE", montantVu: "1200000", prestataireVu: "Imprimerie Alpha" }))))
      .toMatch(/au-delà des .* validés par le Directeur Général : sa validation est de nouveau requise/);
    expect((await poste(ps)).orderStage, "le visa n'est pas posé porte fermée").toBe("REQUESTED");
  }, 180_000);

  it("LES BC D'UN POSTE ONT DES POINTS D'APPEL : la carte lit la règle de l'action, le CTA appelle l'action, la porte du BC lit le visa du poste", () => {
    const lire = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const carte = lire("src/modules/ad-pro/ecrans/postes/poste-carte.tsx");
    expect(carte, "la carte lit la règle partagée").toMatch(/refusGenerationBC\(/);
    expect(carte, "le geste principal appelle l'action").toMatch(/GENERER_BC[\s\S]{0,200}genererBonDeCommandePoste\(/);
    expect(carte, "la case BC passe par le bloc des devis").toMatch(/<BlocBonDeCommande/);
    expect(carte, "la règle lue par la carte est PASSÉE au bloc (sinon le bouton s'offrirait sans règle)").toMatch(/refusGeneration=\{refusGeneration\}/);
    const bloc = lire("src/modules/ad-pro/ecrans/devis-bc-poste.tsx");
    expect(bloc, "le CTA de la case appelle l'action").toMatch(/genererBonDeCommandePoste\(/);
    expect(bloc, "le panneau appelle les actions de validation et de saisie").toMatch(/validerLignesDuDevis\([\s\S]*enregistrerLignesDuDevis\(/);
    const actions = sourceDeLaCle("ad-pro-item-actions").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(actions.match(/refusGenerationBC\(/g)?.length, "l'action lit la règle partagée").toBeGreaterThanOrEqual(1);
    expect(actions.match(/lireLaMarcheDuBC\(/g)?.length, "demander le BC et le générer lisent la MÊME marche").toBeGreaterThanOrEqual(2);
    const genere = lire("src/modules/ad-pro/infra/bc-devis.ts");
    expect(genere, "le BC est émis sous délégation, source le poste, chaîné à son devis").toMatch(/source:\s*\{\s*type:\s*"AD_PRO_ITEM"/);
    expect(genere).toMatch(/chainFromId:\s*d\.pieceId/);
    expect(genere).toMatch(/rattacherPieceAuPoste\(/);
    expect(genere, "la régénération RÉVISE").toMatch(/reviserDocumentDrive\(/);
    const aiguillage = lire("src/lib/bons-de-commande/aiguillage.ts");
    expect(aiguillage, "la porte d'un BC né d'un poste est le visa du poste").toMatch(/sourceType\s*===\s*"AD_PRO_ITEM"/);
    const requete = lire("src/modules/ad-pro/infra/requetes/postes.ts");
    expect(requete, "le chargeur de l'écran lit les devis avec leurs lignes").toMatch(/devisDesPostes\(/);
  });
});
