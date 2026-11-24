import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { fileConformite } from "@/modules/ad-pro/api";
import { deciderConformitePoste } from "@/modules/ad-pro/actions-postes-execution";
import { requestDeclareDecision } from "@/lib/actions/medical-info-actions";
import { decideValidation } from "@/lib/actions/validation-actions";
import { lignesInformationMedicale } from "@/lib/queries/action-center-info-med";
import { declarationsAFaire } from "@/lib/queries/information-medicale-a-faire";
import { etapeDeclaration } from "./etape-ad-pro";
import { declarationsAVenir, ouvrirDeclarationSiPostesValides, postesPourDeclaration } from "./declaration-postes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « À FAIRE — INFORMATION MÉDICALE », JOUÉ EN BASE (Direction, 23/11/2026 — « qu'Alaa sache quoi faire et le fasse
 * facilement ») :
 *   • le pharmacien décide le BAT d'un poste d'une « Autre demande » — dont il n'a pas le module — et rien de plus ne
 *     lui est ouvert ; la file garde tous les BAT et le motif du « non conforme » ;
 *   • ses déclarations se rangent par TOUR, et « Mon espace » comme la carte Ad & Pro ne disent « à vous » que quand
 *     c'est à lui (pas pendant que sa lecture attend le Directeur des Opérations) ;
 *   • un poste resté en brouillon retient la déclaration, et « À venir » dit ce qui la retient ; un sponsoring direct à
 *     l'association (sans devis) est prêt dès son accord (recette 24/11/2026) ;
 *   • l'accord du Directeur des Opérations sur sa lecture le prévient avec le lien du dossier et le geste suivant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__afaireim${Date.now()}__`;
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: null, access, mustChangePassword: false };
}

suite("Information médicale — l'écran « À faire » d'Alaa", () => {
  let primId = "", dmId = "", doId = "", delegueId = "";
  let autreId = "", autreSansBatId = "", posteBatId = "", defId = "", spoId = "", catId = "";
  const decls: Record<string, string> = {};

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) => prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    const [prim, dm, od, delegue] = await Promise.all([mk("prim", "MEDICAL_INFO_PHARMACIST"), mk("dm", "PRODUCT_MANAGER"), mk("od", "OPERATIONS_DIRECTOR"), mk("delegue", "MEDICAL_DELEGATE")]);
    primId = prim.id; dmId = dm.id; doId = od.id; delegueId = delegue.id;
    // NOTRE PHARMACIEN NE PREND PAS LES DOSSIERS DES BANCS VOISINS : `pharmacienAssigne` choisit le plus ancien ACTIF.
    await prisma.user.update({ where: { id: primId }, data: { isActive: false } });

    // UNE « AUTRE DEMANDE » dont un poste d'impression attend le contrôle de son BAT — envoyé deux fois (le premier refusé).
    autreId = (await prisma.adProOtherRequest.create({ data: { reference: `${TAG}AUT`, title: `${TAG}Brochure`, product: "Produit X", requesterId: dmId } })).id;
    autreSansBatId = (await prisma.adProOtherRequest.create({ data: { reference: `${TAG}AUT2`, title: `${TAG}Sans BAT`, requesterId: dmId } })).id;
    posteBatId = (await prisma.adProItem.create({
      data: { otherRequestId: autreId, kind: "PRINTING", label: `${TAG}Brochures`, status: "APPROVED", voie: "AGENCE", conformiteRequise: true },
    })).id;
    await prisma.adProItem.create({ data: { otherRequestId: autreSansBatId, kind: "PRINTING", label: `${TAG}Rien`, status: "APPROVED", voie: "AGENCE", conformiteRequise: true } });
    const t0 = new Date(Date.now() - 3 * 86_400_000);
    const tDecision = new Date(Date.now() - 2 * 86_400_000);
    await prisma.document.create({ data: { name: `${TAG}bat-v1.pdf`, entityType: "AD_PRO_ITEM", entityId: posteBatId, stepKey: "BAT_CONFORMITE", createdAt: t0 } });
    await prisma.auditLog.create({
      data: { actorId: primId, action: "UPDATE", module: "Ad & Pro", entityType: "AD_PRO_OTHER", entityId: autreId, summary: `Conformité du poste « ${TAG}Brochures » : non conforme — logo trop petit.`, createdAt: tDecision },
    });
    await prisma.document.create({ data: { name: `${TAG}bat-v2.pdf`, entityType: "AD_PRO_ITEM", entityId: posteBatId, stepKey: "BAT_CONFORMITE" } });
    await prisma.adProExecutionPoste.create({
      data: { itemId: posteBatId, bcEnvoyeAt: t0, conformiteStatut: "EN_CONTROLE", conformiteDemandeeAt: new Date(), conformiteDemandeeParId: dmId, cahierDesCharges: "500 brochures A5" },
    });

    // LES DÉCLARATIONS, une par tour (sources inventées : une déclaration par source).
    const dossier = async (cle: string, extra: Record<string, unknown> = {}) => {
      decls[cle] = (await prisma.medicalInfoDeclaration.create({
        data: { reference: `${TAG}${cle}`, sourceType: "EVENT", sourceId: `${TAG}src-${cle}`, label: `${TAG}${cle}`, pharmacistId: primId, ...extra },
      })).id;
    };
    const enValidation = await prisma.validationRequest.create({ data: { reference: `${TAG}VAL`, module: "Information médicale", title: `${TAG}lecture`, requesterId: primId } });
    await dossier("lecture");
    await dossier("chezDo", { declareValidationId: enValidation.id, declareIntent: "DECLARE", declareRequestedAt: new Date() });
    await dossier("depot", { declareGrantedAt: new Date(), declareIntent: "DECLARE" });
    await dossier("valider", { declareGrantedAt: new Date(), declareIntent: "DECLARE", authorityRef: "ANPP-2026-77" });
    await dossier("finale", { declareGrantedAt: new Date(), declareIntent: "DECLARE", authorityRef: "ANPP-2026-78", status: "AWAITING_DIRECTION", pharmacistValidatedAt: new Date() });

    // UNE DEMANDE ACCORDÉE dont un poste est en attente et un autre resté en brouillon. Le poste en attente est le VERSEMENT
    // d'un sponsoring direct à l'association : sans devis, il est prêt dès qu'il est accordé (recette 24/11/2026).
    defId = (await prisma.workflowDefinition.create({ data: { category: `${TAG}WF`, name: `${TAG}circuit` } })).id;
    spoId = (await prisma.sponsoringRequest.create({ data: { reference: `${TAG}SPO`, institution: `${TAG}Hôpital`, type: "Congrès", status: "APPROVED", requesterId: dmId } })).id;
    await prisma.workflowInstance.create({ data: { definitionId: defId, entityType: "SPONSORING", entityId: spoId, category: `${TAG}WF`, status: "APPROVED" } });
    await prisma.adProItem.create({ data: { sponsoringId: spoId, kind: "ASSOCIATION_SUPPORT", label: `${TAG}Versement association`, status: "PENDING", amountEstimated: 50000 } });
    await prisma.adProItem.create({ data: { sponsoringId: spoId, kind: "OTHER", label: `${TAG}Brouillon`, status: "DRAFT", amountEstimated: 9000 } });
    // LE BUDGET QUE LA DIRECTION MARKETING CHOISIT APRÈS LA VALIDATION (recette 24/11/2026) — la déclaration l'attend.
    const env = await prisma.budgetEnvelope.create({
      data: { name: `${TAG}Enveloppe`, modules: ["SPONSORING"], totalAmount: 1_000_000, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31") },
    });
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${TAG}Sponsoring`, allocated: 1_000_000 }, select: { id: true } })).id;
  }, 120_000);

  afterAll(async () => {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((u) => u.id);
    const ids = (await prisma.medicalInfoDeclaration.findMany({ where: { OR: [{ label: { startsWith: TAG } }, { sourceId: spoId }] }, select: { id: true } })).map((d) => d.id);
    const demandes = (await prisma.validationRequest.findMany({ where: { OR: [{ entityType: "MEDICAL_INFO_DECLARATION", entityId: { in: ids } }, { requesterId: { in: comptes } }] }, select: { id: true } })).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { OR: [{ requestId: { in: demandes } }, { validatorId: { in: comptes } }] } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: demandes } } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.adProOtherRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { definitionId: defId } }).catch(() => {});
    await prisma.workflowDefinition.deleteMany({ where: { id: defId } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { sponsoringId: spoId } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: comptes } }, { entityId: { in: [autreId, spoId, ...ids] } }] } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: comptes } } }).catch(() => {});
  }, 120_000);

  it("le pharmacien LIT le poste dont il contrôle le BAT, et sa demande « autre » — rien de plus", async () => {
    const prim = await actorFor(primId);
    expect(await canAccessEntity(prim, "AD_PRO_OTHER", autreId, "VIEW")).toBe(true);
    expect(await canAccessEntity(prim, "AD_PRO_ITEM", posteBatId, "VIEW")).toBe(true);
    expect(await canAccessEntity(prim, "AD_PRO_OTHER", autreId, "UPDATE"), "en lecture seulement").toBe(false);
    expect(await canAccessEntity(prim, "AD_PRO_OTHER", autreSansBatId, "VIEW"), "aucun BAT envoyé : pas de porte").toBe(false);
    expect(await canAccessEntity(await actorFor(delegueId), "AD_PRO_OTHER", autreId, "VIEW"), "le rôle de pharmacien seul").toBe(false);
  });

  it("la file des BAT : tous les fichiers, le plus récent d'abord, le premier avec son « non conforme » ; la demande et son produit", async () => {
    const file = await fileConformite(await actorFor(primId));
    const ligne = file?.aControler.find((l) => l.itemId === posteBatId);
    expect(ligne).toMatchObject({ ref: `${TAG}AUT`, demande: `${TAG}Brochure`, produits: "Produit X", cahierDesCharges: "500 brochures A5", statut: "EN_CONTROLE", lienPoste: null });
    expect(ligne?.fichiers.map((f) => f.nom)).toEqual([`${TAG}bat-v2.pdf`, `${TAG}bat-v1.pdf`]);
    expect(ligne?.fichiers[0]).toMatchObject({ tour: 2, verdict: null });
    expect(ligne?.fichiers[1]).toMatchObject({ tour: 1, verdict: { conforme: false, note: "logo trop petit" } });
  });

  it("il décide SUR LA LIGNE, même pour une « Autre demande » : motif exigé, la Direction Marketing prévenue", async () => {
    ACTOR = await actorFor(primId);
    expect(await deciderConformitePoste(form({ id: posteBatId, decision: "NON_CONFORME" }))).toMatchObject({ ok: false });
    const r = await deciderConformitePoste(form({ id: posteBatId, decision: "NON_CONFORME", note: "visa absent" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await prisma.adProExecutionPoste.findUniqueOrThrow({ where: { itemId: posteBatId } })).conformiteStatut).toBe("NON_CONFORME");
    expect(await prisma.notification.count({ where: { userId: dmId, title: "BAT non conforme" } })).toBe(1);
    const file = await fileConformite(await actorFor(primId));
    expect(file?.aControler.some((l) => l.itemId === posteBatId)).toBe(false);
    const attente = file?.enAttenteCorrection.find((l) => l.itemId === posteBatId);
    expect(attente?.fichiers[0].verdict).toMatchObject({ conforme: false, note: "visa absent" });
    expect(file?.decides.some((l) => l.itemId === posteBatId)).toBe(true);
  });

  it("les déclarations se rangent par TOUR — la lecture en validation est chez le Directeur des Opérations", async () => {
    const { tours } = await declarationsAFaire(await actorFor(primId));
    const tourDe = (id: string) => tours.find((t) => t.lignes.some((l) => l.id === id))?.tour;
    expect(tourDe(decls.lecture)).toBe("LECTURE");
    expect(tourDe(decls.chezDo)).toBe("CHEZ_DO");
    expect(tourDe(decls.depot)).toBe("DEPOT");
    expect(tourDe(decls.valider)).toBe("VALIDER");
    expect(tourDe(decls.finale)).toBe("CHEZ_DO");
    const depot = tours.flatMap((t) => t.lignes).find((l) => l.id === decls.depot);
    expect(depot?.consigne).toBe("Déposez la déclaration à l'ANPP, joignez le récépissé, enregistrez la référence, puis validez.");
  });

  it("« Mon espace » et la carte Ad & Pro ne disent « à vous » que quand c'est à lui", async () => {
    const prim = await actorFor(primId);
    const lignes = await lignesInformationMedicale(prim);
    const de = (id: string) => lignes.find((l) => l.objet === `MEDICAL_INFO_DECLARATION:${id}`);
    expect(de(decls.lecture)?.statusLabel).toBe("Soumettre ma lecture");
    expect(de(decls.depot)?.statusLabel).toBe("Déposer à l'ANPP");
    expect(de(decls.valider)).toMatchObject({ statusLabel: "Valider", statut: "READY" });
    expect(de(decls.chezDo), "sa lecture attend le Directeur des Opérations : pas de ligne").toBeUndefined();
    expect(de(decls.finale), "la validation finale n'est pas sa file").toBeUndefined();
    expect((await etapeDeclaration(prim, "EVENT", `${TAG}src-chezDo`, true))?.aVous).toBe(false);
    expect((await etapeDeclaration(prim, "EVENT", `${TAG}src-finale`, true))?.aVous).toBe(false);
    expect((await etapeDeclaration(prim, "EVENT", `${TAG}src-lecture`, true))?.aVous).toBe(true);
    expect((await etapeDeclaration(prim, "EVENT", `${TAG}src-depot`, true))?.aVous).toBe(true);
  });

  it("UN BROUILLON RETIENT LA DÉCLARATION — « À venir » dit ce qui la retient ; supprimé, elle s'ouvre (le versement direct à l'association, sans devis, est prêt dès son accord)", async () => {
    const avant = (await declarationsAVenir()).find((v) => v.id === spoId);
    expect(avant).toMatchObject({ ouvrable: false, postes: { total: 2, valides: 0, brouillons: 1, blocages: ["1 poste en brouillon — à soumettre ou à supprimer", "1 poste en attente de la Direction Marketing"] } });
    expect(await ouvrirDeclarationSiPostesValides("SPONSORING", spoId)).toBeNull();
    await prisma.adProItem.updateMany({ where: { sponsoringId: spoId, status: "PENDING" }, data: { status: "APPROVED", amountGranted: 50000 } });
    expect(await ouvrirDeclarationSiPostesValides("SPONSORING", spoId), "le brouillon la retient").toBeNull();
    await prisma.adProItem.deleteMany({ where: { sponsoringId: spoId, status: "DRAFT" } });
    // LE BUDGET D'ABORD (recette 24/11/2026) : validé au montant, le versement attend encore son budget.
    expect(await ouvrirDeclarationSiPostesValides("SPONSORING", spoId), "validé sans budget : elle attend").toBeNull();
    expect((await postesPourDeclaration("SPONSORING", spoId)).blocages).toEqual(["1 poste accordé sans budget choisi"]);
    await prisma.adProItem.updateMany({ where: { sponsoringId: spoId }, data: { budgetCategoryId: catId } });
    const ouverte = await ouvrirDeclarationSiPostesValides("SPONSORING", spoId);
    expect(ouverte, "le brouillon retiré et le budget choisi, elle s'ouvre").toBeTruthy();
    expect(await postesPourDeclaration("SPONSORING", spoId)).toMatchObject({ total: 1, valides: 1, prets: true, brouillons: 0, montant: 50000 });
    expect((await declarationsAVenir()).some((v) => v.id === spoId), "ouverte : plus « à venir »").toBe(false);
  });

  it("l'accord du Directeur des Opérations sur sa lecture le prévient : le dossier, et le geste suivant", async () => {
    ACTOR = await actorFor(primId);
    const r = await requestDeclareDecision(undefined, form({ id: decls.lecture, intent: "DECLARE" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const vId = (await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id: decls.lecture } })).declareValidationId!;
    const etape = await prisma.validationStep.findFirstOrThrow({ where: { requestId: vId, validatorId: doId } });
    ACTOR = await actorFor(doId);
    const ok = await decideValidation(form({ stepId: etape.id, decision: "APPROVED" }));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    const notif = await prisma.notification.findFirst({ where: { userId: primId, title: "Validation acceptée" }, orderBy: { createdAt: "desc" } });
    expect(notif?.link).toBe(`/information-medicale/${decls.lecture}`);
    expect(notif?.body).toContain("Déposez la déclaration à l'ANPP, enregistrez la référence, puis validez.");
    const { tours } = await declarationsAFaire(await actorFor(primId));
    expect(tours.find((t) => t.lignes.some((l) => l.id === decls.lecture))?.tour, "et la ligne passe au dépôt").toBe("DEPOT");
  });
});
