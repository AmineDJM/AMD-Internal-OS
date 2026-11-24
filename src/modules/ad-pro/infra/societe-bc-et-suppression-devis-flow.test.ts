import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/session")>();
  return { ...vrai, requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR };
});
/**
 * LE SEUIL DES BONS DE COMMANDE ET CELUI DE LA PORTE DU DG SONT DES RÉGLAGES GLOBAUX (§118.132) : le banc les INJECTE dans son
 * processus — un réglage changé par un autre banc au même instant ne doit pas ouvrir ni fermer une porte de celui-ci.
 */
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), bcValidationThreshold: 500_000, adProDgThreshold: 1_000_000 }) };
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
        fournisseurId: null, reference: null, quoteDate: null, tvaRate: 19, extraTaxLabel: null, extraTaxRate: null,
        announcedTotal: 327_250, reserves: [], lignes: LIGNES_LUES,
      },
    }),
  };
});

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu, retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { moneyEntityOf } from "@/lib/company";
import { createSponsoring } from "../actions-sponsoring";
import { addAdProItem } from "../actions-postes";
import { ajouterDevisPoste, retirerDevisDuPoste } from "../actions-postes-paiement";
import {
  genererBonDeCommandePoste, apercuBcPoste, annulerApercuBcPoste, choisirSocieteDuBcPoste, validerEtEnvoyerBcPoste, validerLignesDuDevis,
} from "../actions-postes-lignes";
import { lireBrouillon, REFUS_MODIFICATION_BC_POSTE, ETIQUETTE_BROUILLON } from "@/lib/bons-de-commande/brouillon";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

// Un suffixe PAR RUN : un banc à étiquette fixe ne survit pas à un run interrompu (§118.136).
const TAG = "__socbc__";
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
const fichier = (nom: string) => new File([new TextEncoder().encode(`%PDF-1.4 ${nom} ${RUN} ${Math.random()}`)], `${TAG}${nom}.pdf`, { type: "application/pdf" });

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA SOCIÉTÉ QUI COMMANDE SE CHOISIT DANS L'APERÇU DU BC, ET LA PERSONNE QUI A AJOUTÉ UN DEVIS LE SUPPRIME (recette 24/11/2026).
 *
 * Par les VRAIS points d'entrée de l'écran (session simulée, base locale) :
 *   1. Une demande qui ne nomme aucune société, dont le demandeur n'a pas de fiche salarié : l'aperçu ne bute plus, il PROPOSE
 *      les sociétés actives ; le retrait et la génération de l'aperçu n'exigent pas la société ; seule l'ÉMISSION l'exige.
 *      Le choix revient à la personne qui a ajouté le devis (ou au Super Admin), une société active, et une seule fois.
 *   2. « Supprimer le devis » : la personne qui l'a AJOUTÉ, sans droit d'édition sur la demande, le supprime — jusqu'à la
 *      transmission à la Direction Marketing ; un autre sans droit ne le peut pas.
 * Chaque cas NOMME son acteur (§118.151f), et les juges comptent par le lien causal — jamais un compte global.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Ad & Pro — la société qui commande se choisit dans l'aperçu du BC ; le déposant supprime son devis", () => {
  const u: Record<"dem" | "ops" | "fin1" | "fin2" | "ast", string> = { dem: "", ops: "", fin1: "", fin2: "", ast: "" };
  const ROLES = { dem: "NATIONAL_SALES", ops: "DIRECTION", fin1: "FINANCE_BUDGET_MANAGER", fin2: "FINANCE_BUDGET_MANAGER", ast: "DIRECTION_ASSISTANT" } as const;
  const comme = async (qui: keyof typeof ROLES) => { ACTOR = await acteur(u[qui], ROLES[qui]); return ACTOR; };
  const ok = (r: { ok: boolean; error?: string }) => expect(r.ok, r.error ?? "").toBe(true);
  const refus = (r: { ok: boolean; error?: string }) => { expect(r.ok, "le geste devait être refusé").toBe(false); return r.error ?? ""; };

  let c1 = "", c2 = "", c3 = "", catId = "";
  let spoA = "", posteA = "", pieceA = "";
  let spoB = "", posteB = "", devis1 = "", devis2 = "";
  const docs: string[] = [];

  /** Une demande de sponsoring par le vrai formulaire, prévalidée (DÉCOR) — sans quoi aucun poste ne s'y ajoute. */
  async function demande(nom: string, companyId: string | null): Promise<string> {
    await comme("dem");
    const f = new FormData();
    f.set("institution", `${TAG}${nom}`);
    f.set("doctorHorsAnnuaire", "Dr Amel Haddad");
    f.append("productIds", `${TAG}Nivolex`);
    f.set("city", "Oran"); f.set("specialty", "Cardiologie"); f.set("type", "Congrès");
    f.set("amountRequested", "500000"); f.set("amountProposed", "400000");
    f.set("nature", "DIRECT"); f.set("strategicImportance", "HIGH");
    f.append("files", fichier(`demande-${nom}`));
    const s = await createSponsoring(undefined, f);
    if (!s.ok) throw new Error(s.error);
    // DÉCOR : la tenue est PRÉVALIDÉE par la Direction Marketing (27/10/2026) ; la société, quand la demande en nomme une.
    await prisma.sponsoringRequest.update({ where: { id: s.id! }, data: { status: "PRE_VALIDATED", ...(companyId ? { companyId } : {}) } });
    return s.id!;
  }

  beforeAll(async () => {
    const cles = Object.keys(ROLES) as (keyof typeof ROLES)[];
    const comptes = await Promise.all(cles.map((k) =>
      prisma.user.create({ data: { name: `${TAG}${k}`, email: `${RUN}${k}@t.dz`, role: ROLES[k], passwordHash: "x" } })));
    cles.forEach((k, i) => { u[k] = comptes[i].id; });
    const [a, b, c] = await Promise.all([
      prisma.company.create({ data: { name: `${RUN} Pharma Un`, shortName: `${RUN.slice(-10)}-1`, color: "#1B7F79" } }),
      prisma.company.create({ data: { name: `${RUN} Pharma Deux`, shortName: `${RUN.slice(-10)}-2`, color: "#7F1B1B" } }),
      prisma.company.create({ data: { name: `${RUN} Pharma Fermée`, shortName: `${RUN.slice(-10)}-3`, color: "#444444", isActive: false } }),
    ]);
    c1 = a.id; c2 = b.id; c3 = c.id;
    await prisma.companyLegalIdentity.create({
      data: {
        companyId: c1, legalName: `${TAG} Pharma Un SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
        nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
        bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Direction", managerTitle: "Gérant",
      },
    });
    // Les deux gestionnaires des Finances sont SALARIÉS de la société Un (leur société les laisse lire la demande B), sans le
    // droit d'éditer les postes. Le DEMANDEUR, lui, n'a AUCUNE fiche salarié : c'est le cas de la recette.
    await Promise.all([
      prisma.employee.create({ data: { fullName: `${RUN} fin1`, userId: u.fin1, companyId: c1 } }),
      prisma.employee.create({ data: { fullName: `${RUN} fin2`, userId: u.fin2, companyId: c1 } }),
    ]);
    const env = await prisma.budgetEnvelope.create({
      data: {
        name: `${RUN}Ad&Pro`, modules: ["SPONSORING"], periodStart: new Date(`${ANNEE}-01-01`), periodEnd: new Date(`${ANNEE}-12-31`), totalAmount: 5_000_000,
        categories: { create: [{ name: `${TAG}Congrès`, module: "SPONSORING", allocated: 5_000_000 }] },
      },
      include: { categories: true },
    });
    catId = env.categories[0]!.id;

    // ── LA DEMANDE A : aucune société, un demandeur sans fiche salarié ; un poste accordé, un devis aux deux lignes validées. ──
    spoA = await demande("Société de cardiologie", null);
    await comme("dem");
    const add = await addAdProItem(undefined, fd({ parent: "SPONSORING", parentId: spoA, label: `${TAG}Salle et pauses`, kind: "VENUE", amountEstimated: "400000", supplier: "Hôtel Le Méridien" }));
    if (!add.ok) throw new Error(add.error);
    posteA = add.id!;
    // DÉCOR : la Direction Marketing a accepté le poste (un seul temps, 27/10/2026) — 400 000 DZD (TTC), ligne budgétaire choisie.
    await prisma.adProItem.update({ where: { id: posteA }, data: { status: "APPROVED", amountGranted: 400_000, budgetCategoryId: catId, opsDecidedAt: new Date() } });
    const d = fd({ id: posteA });
    d.append("attachment", fichier("devis-hotel"));
    const r = await ajouterDevisPoste(undefined, d);
    if (!r.ok) throw new Error(r.error);
    pieceA = r.id!;
    docs.push(pieceA);
    const lignes = await prisma.adProDevisLigne.findMany({ where: { devis: { legalDocumentId: pieceA } }, select: { id: true } });
    if (lignes.length !== 2) throw new Error(`devis lu : ${lignes.length} ligne(s)`);
    const v = fd({ id: posteA, pieceId: pieceA, compare: "on" });
    for (const l of lignes) v.append("ligneId", l.id);
    const val = await validerLignesDuDevis(v);
    if (!val.ok) throw new Error(val.error);

    // ── LA DEMANDE B : société Un ; un poste dont la prospection a été confiée à fin1, qui y a déposé deux devis. ──
    spoB = await demande("Société de pneumologie", c1);
    await comme("dem");
    const addB = await addAdProItem(undefined, fd({ parent: "SPONSORING", parentId: spoB, label: `${TAG}Impression des badges`, kind: "VENUE", amountEstimated: "150000", supplier: "Imprimerie Alpha" }));
    if (!addB.ok) throw new Error(addB.error);
    posteB = addB.id!;
    // DÉCOR : la prospection du poste est confiée à fin1 — c'est par là qu'il dépose (il n'a aucun droit d'éditer les postes).
    await prisma.adProExecutionPoste.create({ data: { itemId: posteB, assistanteId: u.fin1, prospectionDemandeeAt: new Date() } });
    await comme("fin1");
    for (const nom of ["devis-un", "devis-deux"]) {
      const f = fd({ id: posteB, fournisseur: "Imprimerie Alpha" });
      f.append("attachment", fichier(nom));
      const dep = await ajouterDevisPoste(undefined, f);
      if (!dep.ok) throw new Error(dep.error);
      docs.push(dep.id!);
    }
    [devis1, devis2] = docs.slice(1);
    // DÉCOR : la prospection passe à une autre assistante — fin1 n'est plus « l'assistante du poste », il reste celui qui a AJOUTÉ ses devis.
    await prisma.adProExecutionPoste.update({ where: { itemId: posteB }, data: { assistanteId: u.ast } });
  }, 180_000);

  afterAll(async () => {
    const ids = Object.values(u).filter(Boolean);
    const spos = [spoA, spoB].filter(Boolean);
    const postes = [posteA, posteB].filter(Boolean);
    const companies = [c1, c2, c3].filter(Boolean);
    const liens = await prisma.adProItemPiece.findMany({ where: { itemId: { in: postes } }, select: { legalDocumentId: true } }).catch(() => []);
    const legaux = await prisma.legalDocument.findMany({
      where: { OR: [{ sourceId: { in: [...spos, ...postes] } }, { companyId: { in: companies } }, { id: { in: [...docs, ...liens.map((l) => l.legalDocumentId)] } }] },
      select: { id: true },
    }).catch(() => []);
    const lids = [...new Set([...docs, ...legaux.map((l) => l.id)])];
    await prisma.adProDevisLigne.updateMany({ where: { devis: { legalDocumentId: { in: lids } } }, data: { bcId: null } }).catch(() => {});
    await prisma.legalDocument.updateMany({ where: { id: { in: lids } }, data: { chainFromId: null } }).catch(() => {});
    const vIds = (await prisma.validationRequest.findMany({ where: { entityId: { in: lids } }, select: { id: true } }).catch(() => [])).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityId: { in: lids } } }).catch(() => {});
    await prisma.documentRequest.deleteMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: postes } } }).catch(() => {});
    await retirerDocumentsEtContenu({ where: { entityId: { in: [...spos, ...postes, ...lids] } } }).catch(() => {});
    await prisma.bcBrouillonVersion.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProExecutionPoste.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProItemPiece.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: postes } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: lids } } }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: { in: spos } } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: spos } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...spos, ...postes, ...lids] } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: { in: spos } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: ids } } } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { ownerId: { in: ids }, type: "FILE" } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { ownerId: { in: ids } } }).catch(() => {});
    await prisma.documentSequence.deleteMany({ where: { companyId: { in: companies } } }).catch(() => {});
    await prisma.officeLetterhead.deleteMany({ where: { companyId: { in: companies } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: RUN } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    // Le dépôt d'une demande prévient des comptes PERMANENTS (Super Admin, Direction Marketing) : leurs avis sur CES demandes partent aussi.
    for (const s of spos) await prisma.notification.deleteMany({ where: { link: { contains: s } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.companyLegalIdentity.deleteMany({ where: { companyId: { in: companies } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: companies } } }).catch(() => {});
  }, 120_000);

  const societeDeA = async () => (await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spoA }, select: { companyId: true } })).companyId;
  const brouillonA = async () => lireBrouillon((await prisma.adProDevis.findFirstOrThrow({ where: { legalDocumentId: pieceA }, select: { bcBrouillon: true } })).bcBrouillon);
  const bcsDuPosteA = () => prisma.legalDocument.count({ where: { kind: "PURCHASE_ORDER", sourceType: "AD_PRO_ITEM", sourceId: posteA } });
  const choisir = (companyId: string) => choisirSocieteDuBcPoste(fd({ id: posteA, pieceId: pieceA, companyId }));

  // ═════════════ 1. LA SOCIÉTÉ QUI COMMANDE ═════════════

  it("PRÉMISSES : la demande A ne nomme aucune société, son demandeur n'a ni fiche salarié ni portée ; le devis a son BC à vérifier, ajouté par le demandeur", async () => {
    expect(await societeDeA()).toBeNull();
    expect(await prisma.employee.count({ where: { userId: u.dem } }), "aucune fiche salarié").toBe(0);
    expect(await moneyEntityOf(u.dem), "rien ne dit la société du demandeur").toBeNull();
    expect(await brouillonA(), "le BC à vérifier est né de la validation des lignes").not.toBeNull();
    expect((await prisma.adProItemPiece.findFirstOrThrow({ where: { itemId: posteA, legalDocumentId: pieceA } })).createdById).toBe(u.dem);
    const ops = await acteur(u.ops, "DIRECTION");
    expect(ops.role === "SUPER_ADMIN" || ops.secondaryRole === "SUPER_ADMIN", "la Direction n'est pas Super Admin").toBe(false);
  });

  it("(a) L'APERÇU NE BUTE PLUS : il dit que la société est à choisir et PROPOSE les sociétés actives (jamais une société fermée)", async () => {
    await comme("dem");
    const a = await apercuBcPoste(fd({ id: posteA, pieceId: pieceA }));
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.error).toMatch(/société qui commande/);
    expect(a.societes, "les sociétés à proposer").toBeDefined();
    const proposees = a.societes!;
    expect(proposees).toContainEqual({ id: c1, label: `${RUN.slice(-10)}-1` });
    expect(proposees).toContainEqual({ id: c2, label: `${RUN.slice(-10)}-2` });
    expect(proposees.map((s) => s.id), "une société fermée n'est pas proposée").not.toContain(c3);
    expect(await prisma.company.count({ where: { id: { in: proposees.map((s) => s.id) }, isActive: false } }), "rien que des sociétés actives").toBe(0);
    expect(await societeDeA(), "lire l'aperçu n'écrit rien").toBeNull();
  });

  it("(h) « VALIDER ET ENVOYER » sans société : refusé — la phrase renvoie au choix dans l'aperçu ; aucun BC, rien ne part", async () => {
    await comme("dem");
    const e = refus(await validerEtEnvoyerBcPoste(fd({ id: posteA, pieceId: pieceA })));
    expect(e).toMatch(/société qui commande n'est pas connue/);
    expect(e).toMatch(/Choisissez-la dans l'aperçu du BC/);
    expect(await bcsDuPosteA(), "aucune pièce au registre").toBe(0);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: posteA }, select: { orderStage: true } })).orderStage).toBe("NONE");
    expect(await brouillonA(), "l'aperçu reste à relire").not.toBeNull();
  });

  it("(b, g) RETIRER L'APERÇU n'exige pas la société ; « Générer le bon de commande » le refait SANS elle — sans numéro ni pièce", async () => {
    await comme("dem");
    ok(await annulerApercuBcPoste(fd({ id: posteA, pieceId: pieceA })));
    expect(await brouillonA(), "l'aperçu est retiré").toBeNull();
    const g = await genererBonDeCommandePoste(fd({ id: posteA }));
    ok(g);
    expect(g.message).toContain(ETIQUETTE_BROUILLON);
    expect(await brouillonA(), "l'aperçu est de nouveau sur le devis").not.toBeNull();
    expect(await bcsDuPosteA(), "un aperçu n'est pas un BC").toBe(0);
    expect(await societeDeA()).toBeNull();
  });

  it("(c) CHOISIR LA SOCIÉTÉ : la Direction, qui n'a pas ajouté le devis (et n'est pas Super Admin), est refusée — rien n'est écrit", async () => {
    await comme("ops");
    expect(refus(await choisir(c1))).toBe(REFUS_MODIFICATION_BC_POSTE);
    expect(await societeDeA()).toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: spoA, actorId: u.ops } }), "aucune trace d'un choix qui n'a pas eu lieu").toBe(0);
  });

  it("(d) CHOISIR LA SOCIÉTÉ : une société inconnue, ou fermée, est refusée — même par la personne qui a ajouté le devis", async () => {
    await comme("dem");
    expect(refus(await choisirSocieteDuBcPoste(fd({ id: posteA, pieceId: pieceA })))).toMatch(/Choisissez la société qui commande/);
    expect(refus(await choisir(`${RUN}-inconnue`))).toMatch(/n'existe pas ou n'est plus active/);
    expect(refus(await choisir(c3))).toMatch(/n'existe pas ou n'est plus active/);
    expect(await societeDeA()).toBeNull();
  });

  it("(e) CHOISIR LA SOCIÉTÉ : la personne qui a ajouté le devis l'inscrit sur la DEMANDE, tracé ; l'aperçu ne la redemande plus", async () => {
    await comme("dem");
    const r = await choisir(c1);
    ok(r);
    expect(r.message).toMatch(/est la société qui commande/);
    expect(await societeDeA(), "inscrite sur la demande").toBe(c1);
    expect(await prisma.auditLog.count({ where: { entityId: spoA, actorId: u.dem, summary: { contains: "Société qui commande choisie" } } })).toBe(1);
    const a = await apercuBcPoste(fd({ id: posteA, pieceId: pieceA }));
    expect("societes" in a && a.societes !== undefined, `la société est connue : plus rien à choisir (${a.ok ? "aperçu composé" : a.error})`).toBe(false);
  });

  it("(f) UNE SOCIÉTÉ DÉJÀ POSÉE ne se change pas depuis le BC : une autre est refusée, la même est un « déjà fait »", async () => {
    await comme("dem");
    expect(refus(await choisir(c2))).toMatch(/nomme déjà sa société/);
    expect(await societeDeA(), "la société de la demande n'est pas écrasée").toBe(c1);
    const meme = await choisir(c1);
    ok(meme);
    expect(meme.message).toMatch(/déjà celle de la demande/);
    expect(await societeDeA()).toBe(c1);
  });

  // ═════════════ 2. LA PERSONNE QUI A AJOUTÉ LE DEVIS LE SUPPRIME ═════════════

  it("PRÉMISSES : fin1 et fin2 lisent la demande B sans pouvoir éditer ni décider ses postes ; fin1 a ajouté les deux devis, et n'est plus l'assistante du poste", async () => {
    for (const qui of ["fin1", "fin2"] as const) {
      const f = await acteur(u[qui], ROLES[qui]);
      expect(hasGlobalView(f)).toBe(false);
      expect(userCan(f, "SPONSORING", "CREATE") || userCan(f, "SPONSORING", "UPDATE") || userCan(f, "SPONSORING", "VALIDATE"), `${qui} n'édite ni ne décide les postes`).toBe(false);
    }
    const liens = await prisma.adProItemPiece.findMany({ where: { itemId: posteB, nature: "DEVIS" }, select: { legalDocumentId: true, createdById: true } });
    expect(liens.map((l) => l.legalDocumentId).sort()).toEqual([devis1, devis2].sort());
    expect(liens.every((l) => l.createdById === u.fin1), "les deux devis sont ajoutés par fin1").toBe(true);
    expect((await prisma.adProExecutionPoste.findUniqueOrThrow({ where: { itemId: posteB } })).assistanteId).toBe(u.ast);
  });

  it("UN AUTRE, SANS DROIT, ne supprime pas le devis : « Non autorisé. » — le lien reste", async () => {
    await comme("fin2");
    expect(refus(await retirerDevisDuPoste(undefined, fd({ id: posteB, pieceId: devis1 })))).toBe("Non autorisé.");
    expect(await prisma.adProItemPiece.count({ where: { itemId: posteB, legalDocumentId: devis1 } })).toBe(1);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: devis1 }, select: { status: true } })).status).not.toBe("CANCELLED");
  });

  it("LA PERSONNE QUI A AJOUTÉ LE DEVIS le supprime : le lien part, et la pièce, qui ne couvre plus aucun poste, est annulée au registre", async () => {
    await comme("fin1");
    const r = await retirerDevisDuPoste(undefined, fd({ id: posteB, pieceId: devis1 }));
    ok(r);
    expect(r.message).toMatch(/annulé/);
    expect(await prisma.adProItemPiece.count({ where: { itemId: posteB, legalDocumentId: devis1 } })).toBe(0);
    expect(await prisma.adProItemPiece.count({ where: { legalDocumentId: devis1 } }), "il ne couvre plus aucun poste").toBe(0);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: devis1 }, select: { status: true } })).status).toBe("CANCELLED");
    expect(await prisma.adProItemPiece.count({ where: { itemId: posteB, legalDocumentId: devis2 } }), "l'autre devis reste").toBe(1);
  });

  it("APRÈS LA TRANSMISSION À LA DIRECTION MARKETING, la personne qui l'a ajouté ne le supprime plus", async () => {
    await prisma.adProExecutionPoste.update({ where: { itemId: posteB }, data: { devisTransmisAt: new Date(), devisTransmisParId: u.ast } });
    await comme("fin1");
    expect(refus(await retirerDevisDuPoste(undefined, fd({ id: posteB, pieceId: devis2 })))).toMatch(/transmis à la Direction Marketing/);
    expect(await prisma.adProItemPiece.count({ where: { itemId: posteB, legalDocumentId: devis2 } })).toBe(1);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: devis2 }, select: { status: true } })).status).not.toBe("CANCELLED");
  });
});
