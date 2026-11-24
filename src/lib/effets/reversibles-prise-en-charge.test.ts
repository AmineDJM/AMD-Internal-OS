import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * K10c — LA PRISE EN CHARGE v2, RÉVERSIBLE : la demande de paiement d'un BC et la réponse « Remboursé ? », EXÉCUTÉES
 * par leurs vraies actions puis ANNULÉES (le bouton « Annuler ») contre la base — l'état d'avant tel que la déclaration
 * (`declarations/metiers.ts`) le promet, le journal et l'audit.
 *
 * Le décor est celui du circuit d'achat (`modules/ad-pro/infra/pec-circuit-achat-flow.test.ts`) : deux professionnels
 * chiffrés, « Valider et lancer les achats » → BC n°1, signé par la Direction Marketing, visé par le centre Ad & Pro,
 * signé par les Finances, ses deux billets achetés.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));
// Les seuils globaux INJECTÉS dans ce processus (§118.132) : tout BC passe au centre, la porte du DG ne s'ouvre pas.
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), bcValidationThreshold: 1_000, adProDgThreshold: 900_000_000 }) };
});
// La signature en ligne a ses propres bancs : ici le contrôle passe et le sceau pose la place de signature, comme le vrai.
vi.mock("@/lib/signature-en-ligne/second-facteur", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/signature-en-ligne/second-facteur")>();
  return { ...vrai, controleRenforce: async () => null };
});
vi.mock("@/lib/signature-en-ligne/signer-bc", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/signature-en-ligne/signer-bc")>();
  return {
    ...vrai,
    apposerSignatureEnLigne: async (i: { legalDocumentId: string; qualite: "DIRECTION_MARKETING" | "FINANCES"; user: { id: string; name: string | null } }) => {
      const { prisma: db } = await import("@/lib/prisma");
      const jeton = `banc-${Math.random().toString(36).slice(2)}`;
      await db.signatureBC.create({ data: { legalDocumentId: i.legalDocumentId, qualite: i.qualite, userId: i.user.id, signataireNom: i.user.name ?? "?", methode: "EN_LIGNE", jeton } });
      return { ok: true as const, documentId: "", empreinte: "0".repeat(64), jeton, suppleance: false, titre: i.qualite };
    },
  };
});

import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu, retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import { annulerGeste, type CompteRenduAnnulation } from "@/lib/effets/annulation";
import { signerBonDeCommandeEnLigne } from "@/lib/actions/bc-signature-actions";
import { addCareBeneficiary, addCareCell } from "@/modules/ad-pro/actions-prise-en-charge";
import { enregistrerMontantsPec, repondreRemboursementPec, retirerProfessionnelPec, validerProfessionnelsPec } from "@/modules/ad-pro/actions-prise-en-charge-chiffrage";
import { acheterLignePec, demanderPaiementBcPec, signerBcPec } from "@/modules/ad-pro/actions-prise-en-charge-achats";
import { deciderVisaCentreAdPro } from "@/modules/ad-pro/actions-centre";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const RUN = `zk10cpec${Date.now().toString(36)}`;
const ROLES = { kam: "MEDICAL_DELEGATE", dm: "PRODUCT_MANAGER", da: "DIRECTION_ASSISTANT", dg: "GENERAL_MANAGER", fin: "FINANCE_BUDGET_MANAGER" } as const;
type Qui = keyof typeof ROLES;

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const pdf = (nom: string) => new File([new TextEncoder().encode(`%PDF-1.4\n% ${nom} ${Math.random()}\n%%EOF\n`)], nom, { type: "application/pdf" });
const ok = (r: { ok: boolean; error?: string }) => expect(r.ok, r.error ?? "").toBe(true);

suite("K10c — prise en charge v2 : demande de paiement d'un BC et « Remboursé ? », exécutées puis annulées", () => {
  const u = {} as Record<Qui, string>;
  let moi: CurrentUser;
  const comme = async (qui: Qui) => {
    const x = await prisma.user.findUniqueOrThrow({ where: { id: u[qui] } });
    ACTOR = { id: x.id, name: x.name, email: x.email, role: ROLES[qui] as UserRole, secondaryRole: null, access: await getAccess(x.id, ROLES[qui] as UserRole), mustChangePassword: false } as CurrentUser;
    moi = ACTOR;
    return ACTOR;
  };
  let companyId = "", pecId = "", catId = "", envId = "";
  const P = { a: "", b: "" };
  const C = { a: "", b: "" };
  let bc = { id: "", legal: "" };

  /** Le geste que l'action vient d'inscrire — `annulable.gesteId` rendu à l'écran. */
  const gesteDe = (r: unknown): string => {
    const g = (r as { annulable?: { gesteId?: string } }).annulable?.gesteId;
    expect(g, JSON.stringify(r)).toBeTruthy();
    return g!;
  };
  const annuler = async (gesteId: string): Promise<CompteRenduAnnulation> => {
    const r = await annulerGeste(gesteId, moi);
    if ("refus" in r) throw new Error(r.refus);
    return r;
  };
  /** Tout ce qui est en base est défait ou compensé : seuls les effets SORTIS (une poussée affichée) restent « impossibles ». */
  const toutDefaitEnBase = async (gesteId: string, c: CompteRenduAnnulation) => {
    const externes = new Set((await prisma.assistantEffet.findMany({ where: { gesteId, type: "EXTERNE" }, select: { id: true } })).map((e) => e.id));
    expect(c.details.filter((d) => d.issue === "IMPOSSIBLE" && !externes.has(d.effetId))).toEqual([]);
  };
  const traceeDe = async (gesteId: string) => {
    const g = await prisma.assistantGesteJournal.findUniqueOrThrow({ where: { id: gesteId } });
    expect(g.annuleParId).toBe(moi.id);
    expect(g.annuleLe).toBeTruthy();
    expect(await prisma.auditLog.count({ where: { entityId: gesteId, summary: { contains: "Annulation" } } })).toBe(1);
  };
  const ligneDe = (cellId: string) => prisma.carePecBcLigne.findUniqueOrThrow({ where: { bcId_cellId: { bcId: bc.id, cellId } } });
  const etatBc = () => prisma.carePecBc.findUniqueOrThrow({ where: { id: bc.id }, select: { expenseOrderId: true, paiementDemandeLe: true, paiementDemandeParId: true } });
  const ordresDesPostes = async () => (await prisma.careCell.findMany({ where: { id: { in: [C.a, C.b] } }, select: { id: true, expenseOrderId: true }, orderBy: { id: "asc" } }));
  const payer = async (nom: string) => {
    await comme("da");
    const f = fd({ bcId: bc.id });
    f.set("facture", pdf(nom));
    return demanderPaiementBcPec(f);
  };

  beforeAll(async () => {
    const cles = Object.keys(ROLES) as Qui[];
    const comptes = await Promise.all(cles.map((k) => prisma.user.create({ data: { name: `${RUN}${k}`, email: `${RUN}${k}@t.dz`, role: ROLES[k], passwordHash: "x" } })));
    cles.forEach((k, i) => { u[k] = comptes[i]!.id; });
    companyId = (await prisma.company.create({ data: { name: `${RUN} Pharma`, shortName: RUN.slice(-12), color: "#1B7F79" } })).id;
    await Promise.all([
      ...cles.map((k) => prisma.employee.create({ data: { fullName: `${RUN} ${k}`, userId: u[k], companyId } })),
      prisma.companyLegalIdentity.create({
        data: {
          companyId, legalName: `${RUN} Pharma SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
          nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
          bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Direction", managerTitle: "Gérant",
        },
      }),
    ]);
    pecId = (await prisma.congressNational.create({
      data: { name: `${RUN} Congrès de cardiologie`, requesterId: u.kam, productManagerId: u.dm, requestStatus: "APPROVED", companyId, city: "Oran", date: new Date("2026-12-12"), endDate: new Date("2026-12-14"), circuitAchatAt: new Date() },
      select: { id: true },
    })).id;
    envId = (await prisma.budgetEnvelope.create({ data: { name: `${RUN}Enveloppe`, modules: ["CONGRESS_NATIONAL"], totalAmount: 50_000_000, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31") }, select: { id: true } })).id;
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${RUN}Congrès`, module: "CONGRESS_NATIONAL", allocated: 10_000_000 }, select: { id: true } })).id;

    // Deux professionnels, un billet chacun, chiffrés par l'assistante.
    await comme("kam");
    for (const [k, nom] of [["a", "Kaci"], ["b", "Ferhat"]] as const) {
      const r = await addCareBeneficiary(undefined, fd({ scope: "NATIONAL", requestId: pecId, lastName: `${RUN} ${nom}`, firstName: "Dr", demanderDevis: "on" }));
      ok(r);
      P[k] = r.id!;
      const c = await addCareCell(undefined, fd({ beneficiaryId: P[k], posteType: "BILLET" }));
      ok(c);
      C[k] = c.id!;
    }
    await comme("da");
    const grille = fd({ scope: "NATIONAL", requestId: pecId, envoyer: "oui" });
    for (const [c, m] of [[C.a, "46000"], [C.b, "82000"]]) { grille.append("cellIds", c!); grille.append("montants", m!); }
    ok(await enregistrerMontantsPec(grille));
    // BC n°1 : lancé et signé par la Direction Marketing, visé par le centre Ad & Pro, signé par les Finances.
    await comme("dm");
    ok(await validerProfessionnelsPec(fd({ scope: "NATIONAL", requestId: pecId, lancer: "oui", budgetCategoryId: catId })));
    const b = await prisma.carePecBc.findFirstOrThrow({ where: { congressNationalId: pecId, numero: 1 } });
    bc = { id: b.id, legal: b.legalDocumentId! };
    ok(await signerBcPec(fd({ bcId: bc.id, lu: "oui", motDePasse: "x", code: "000000" })));
    await comme("dg");
    ok(await deciderVisaCentreAdPro(fd({ entityType: "LEGAL_DOCUMENT", entityId: bc.legal, decision: "VALIDER" })));
    await comme("fin");
    ok(await signerBonDeCommandeEnLigne(fd({ id: bc.legal, lu: "oui", motDePasse: "x", code: "000000" })));
    // L'assistante achète les deux billets.
    await comme("da");
    for (const cellId of [C.a, C.b]) {
      const f = fd({ ligneId: (await ligneDe(cellId)).id, reference: "PNR-BANC" });
      f.append("pieces", pdf("billet.pdf"));
      ok(await acheterLignePec(f));
    }
  }, 180_000);

  afterAll(async () => {
    ACTOR = null;
    const ids = Object.values(u).filter(Boolean);
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: ids } } }).catch(() => undefined);
    const legaux = (await prisma.carePecBc.findMany({ where: { congressNationalId: pecId }, select: { legalDocumentId: true } }).catch(() => [])).map((x) => x.legalDocumentId).filter((x): x is string => Boolean(x));
    const sujet = (await prisma.congressNational.findUnique({ where: { id: pecId }, select: { careReservationDossierId: true } }).catch(() => null))?.careReservationDossierId;
    await retirerDocumentsEtContenu({ where: { entityId: { in: [pecId, ...legaux] } } }).catch(() => undefined);
    await prisma.signatureBC.deleteMany({ where: { legalDocumentId: { in: legaux } } }).catch(() => undefined);
    await prisma.adProGateVisa.deleteMany({ where: { entityId: { in: legaux } } }).catch(() => undefined);
    const ordres = (await prisma.expenseOrder.findMany({ where: { sourceId: pecId }, select: { id: true } }).catch(() => [])).map((o) => o.id);
    await prisma.carePecBc.deleteMany({ where: { congressNationalId: pecId } }).catch(() => undefined);
    await prisma.careChiffrage.deleteMany({ where: { congressNationalId: pecId } }).catch(() => undefined);
    await prisma.careBeneficiary.deleteMany({ where: { congressNationalId: pecId } }).catch(() => undefined);
    const dossiers = (await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ordres } }, select: { id: true } }).catch(() => [])).map((d) => d.id);
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers } } }).catch(() => undefined);
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers } } }).catch(() => undefined);
    await prisma.dossier.deleteMany({ where: { OR: [{ sourceId: { in: ordres } }, ...(sujet ? [{ id: sujet }] : [])] } }).catch(() => undefined);
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [pecId, ...legaux] } } }).catch(() => undefined);
    await prisma.legalDocument.deleteMany({ where: { id: { in: legaux } } }).catch(() => undefined);
    await prisma.adProPorteDg.deleteMany({ where: { entityId: pecId } }).catch(() => undefined);
    await prisma.congressNational.deleteMany({ where: { id: pecId } }).catch(() => undefined);
    await prisma.budgetCategoryLine.deleteMany({ where: { id: catId } }).catch(() => undefined);
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => undefined);
    await prisma.medicalDoctor.deleteMany({ where: { name: { contains: RUN } } }).catch(() => undefined);
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: ids } } } }).catch(() => undefined);
    await retirerNoeudsDriveEtContenu({ where: { ownerId: { in: ids }, type: "FILE" } }).catch(() => undefined);
    await retirerNoeudsDriveEtContenu({ where: { ownerId: { in: ids } } }).catch(() => undefined);
    await prisma.documentSequence.deleteMany({ where: { companyId } }).catch(() => undefined);
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: RUN } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { id: { in: ids } } }).catch(() => undefined);
    await prisma.companyLegalIdentity.deleteMany({ where: { companyId } }).catch(() => undefined);
    await prisma.company.delete({ where: { id: companyId } }).catch(() => undefined);
  }, 120_000);

  it("demanderPaiementBcPec : l'ordre est compensé, le BC redevient « paiement à demander », la facture reste dans les pièces", async () => {
    const avant = await etatBc();
    const postesAvant = await ordresDesPostes();
    expect(avant.expenseOrderId).toBeNull();
    const r = await payer("facture-agence.pdf");
    ok(r);
    const g = gesteDe(r);
    const ordre = r.id!;
    const apres = await prisma.carePecBc.findUniqueOrThrow({ where: { id: bc.id }, select: { expenseOrderId: true, factureDocumentId: true } });
    expect(apres.expenseOrderId).toBe(ordre);
    const facture = apres.factureDocumentId!;
    expect(facture).toBeTruthy();
    expect((await ordresDesPostes()).every((p) => p.expenseOrderId === ordre)).toBe(true);

    const c = await annuler(g);
    await toutDefaitEnBase(g, c);
    // L'ordre né de ce geste : retiré (intact) ou passé à ANNULÉ.
    const o = await prisma.expenseOrder.findUnique({ where: { id: ordre }, select: { status: true } });
    expect(o === null || o.status === "CANCELLED").toBe(true);
    // Le BC redevient « paiement à demander » ; les postes ne portent plus l'ordre.
    expect(await etatBc()).toEqual(avant);
    expect(await ordresDesPostes()).toEqual(postesAvant);
    // La facture reste dans les pièces de la demande.
    expect(await prisma.document.findUnique({ where: { id: facture }, select: { entityId: true, category: true } })).toEqual({ entityId: pecId, category: "INVOICE" });
    await traceeDe(g);

    // La preuve par le geste : le paiement se demande de nouveau, un nouvel ordre naît.
    const encore = await payer("facture-agence-bis.pdf");
    ok(encore);
    expect(encore.id).not.toBe(ordre);
    expect((await etatBc()).expenseOrderId).toBe(encore.id);
    expect(Number((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: encore.id! } })).amount)).toBe(128_000);
  });

  it("repondreRemboursementPec : la réponse est effacée (la ligne attend de nouveau), l'ordre non réglé reprend son montant d'avant", async () => {
    const ordre = (await etatBc()).expenseOrderId!;
    expect(ordre).toBeTruthy();
    // Le professionnel B est retiré APRÈS l'achat : sa ligne attend « Remboursé ? ».
    await comme("dm");
    ok(await retirerProfessionnelPec(fd({ beneficiaryId: P.b, motif: "Annulation" })));
    const ligne = await ligneDe(C.b);
    expect(ligne.statut).toBe("RETIREE_APRES_ACHAT");
    const montantAvant = Number((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre } })).amount);
    expect(montantAvant).toBe(128_000);

    await comme("da");
    const oui = await repondreRemboursementPec(fd({ ligneId: ligne.id, rembourse: "oui" }));
    ok(oui);
    const g = gesteDe(oui);
    expect((await ligneDe(C.b)).rembourse).toBe(true);
    expect(Number((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre } })).amount), "le billet remboursé est déduit").toBe(46_000);

    const c = await annuler(g);
    await toutDefaitEnBase(g, c);
    const lue = await ligneDe(C.b);
    expect([lue.statut, lue.rembourse, lue.rembourseDzd, lue.rembourseRepondLe, lue.rembourseRepondParId]).toEqual(["RETIREE_APRES_ACHAT", null, null, null, null]);
    const o = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre }, select: { amount: true, status: true } });
    expect(Number(o.amount)).toBe(montantAvant);
    expect(o.status).not.toBe("CANCELLED");
    await traceeDe(g);

    // « Non » : rien à réviser — l'annulation efface la réponse, la ligne attend de nouveau.
    const non = await repondreRemboursementPec(fd({ ligneId: ligne.id, rembourse: "non" }));
    ok(non);
    const gn = gesteDe(non);
    expect((await ligneDe(C.b)).rembourse).toBe(false);
    await toutDefaitEnBase(gn, await annuler(gn));
    expect((await ligneDe(C.b)).rembourse).toBeNull();
    expect(Number((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre } })).amount)).toBe(montantAvant);
    await traceeDe(gn);
  });
});
