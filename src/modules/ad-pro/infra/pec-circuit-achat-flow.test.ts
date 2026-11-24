import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));
/**
 * LES SEUILS SONT DES RÉGLAGES GLOBAUX (§118.132) : le banc les injecte. Le seuil des BC est BAS (tout BC de la prise en
 * charge passe au centre Ad & Pro) ; celui de la porte du DG sur le total est HAUT (le banc mesure le circuit d'achat).
 */
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), bcValidationThreshold: 1_000, adProDgThreshold: 900_000_000 }) };
});
/**
 * LA SIGNATURE EN LIGNE : le contrôle renforcé (mot de passe + code du téléphone) et le sceau du PDF sont éprouvés par
 * leurs propres bancs (`recette-bout-en-bout-flow`, `signataires-distincts-flow`). Ici, le contrôle passe et le sceau
 * pose la PLACE de signature telle que le vrai la pose (une `SignatureBC` par qualité) — ce que tout l'aval lit.
 */
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
import { etatDuBC } from "@/lib/bons-de-commande/etat";
import { refusRevisionBcPec, refusRevisionBcPecDuDocument, REFUS_BC_PEC_IMMUABLE } from "./prise-en-charge/bc-immuable";
import { signerBonDeCommandeEnLigne } from "@/lib/actions/bc-signature-actions";
import { addCareBeneficiary, addCareCell, setCareCellStatus } from "../actions-prise-en-charge";
import { enregistrerBilletEmis } from "../actions-prise-en-charge-logistique";
import { demanderChiffragePec, enregistrerMontantsPec, modifierMontantPec, repondreRemboursementPec, retirerProfessionnelPec, validerProfessionnelsPec } from "../actions-prise-en-charge-chiffrage";
import { acheterLignePec, demanderPaiementBcPec, signerBcPec } from "../actions-prise-en-charge-achats";
import { deciderVisaCentreAdPro } from "../actions-centre";
import { lignesBureauPecAchat, lignesBureauPecChiffrage, pageChiffrage, vueAchatsPec } from "./requetes/achats-pec";
import { refusAchatHorsBcPec } from "./prise-en-charge/achats";
import { totalDeLaDemande } from "./porte-dg";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PRISE EN CHARGE — LE CIRCUIT D'ACHAT PAR BC NUMÉROTÉS, DE BOUT EN BOUT (Super Admin, 24/11/2026), par les VRAIES actions.
 *
 *  ajout (sans poste d'office, « Demander son devis ») → chiffrage par l'assistante → « Envoyer les montants » → « Valider et
 *  lancer les achats » → BC n°1 (retenu) → signature DM → centre Ad & Pro (visa du DG) → signature des Finances → achat →
 *  facture → UN ordre de dépense ; ajout après signature → BC n°2 ; retrait avant achat (ligne barrée) ; retrait après achat +
 *  « Remboursé ? oui » (déduit) ; hausse de 8 % dans la marge, de 15 % hors marge ; billet hors BC refusé ; BC signé immuable.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const RUN = `__pecachat${Date.now().toString(36)}`;
const ROLES = { kam: "MEDICAL_DELEGATE", dm: "PRODUCT_MANAGER", da: "DIRECTION_ASSISTANT", dg: "GENERAL_MANAGER", fin: "FINANCE_BUDGET_MANAGER" } as const;
type Qui = keyof typeof ROLES;

const fd = (o: Record<string, string>, multi: Record<string, string[]> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  for (const [k, vs] of Object.entries(multi)) for (const v of vs) f.append(k, v);
  return f;
};
/** La grille « Chiffrer » : des listes alignées poste ↔ montant (et pièce ↔ poste). */
const saisie = (base: Record<string, string>, montants: [string, string][], pieces: [string, File][] = []) => {
  const f = fd(base);
  for (const [c, m] of montants) { f.append("cellIds", c); f.append("montants", m); }
  for (const [c, p] of pieces) { f.append("pieces", p); f.append("pieceCellIds", c); }
  return f;
};
const pdf = (nom: string) => new File([new TextEncoder().encode(`%PDF-1.4\n% ${nom} ${Math.random()}\n%%EOF\n`)], nom, { type: "application/pdf" });
const msg = (r: { ok: boolean; error?: string; message?: string }) => JSON.stringify(r);

suite("Prise en charge — circuit d'achat par BC numérotés (base réelle)", () => {
  const u = {} as Record<Qui, string>;
  const comme = async (qui: Qui) => {
    const x = await prisma.user.findUniqueOrThrow({ where: { id: u[qui] } });
    ACTOR = { id: x.id, name: x.name, email: x.email, role: ROLES[qui] as UserRole, secondaryRole: null, access: await getAccess(x.id, ROLES[qui] as UserRole), mustChangePassword: false } as CurrentUser;
    return ACTOR;
  };
  let companyId = "", pecId = "", catId = "", envId = "";
  const P = { a: "", b: "", c: "" };
  const C = { aBillet: "", aHotel: "", bBillet: "", cTransport: "", cBillet: "" };
  let bc1 = { id: "", legal: "" };
  let bc2 = { id: "", legal: "" };

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
    // Une demande nationale née APRÈS le circuit d'achat, prévalidée (statut d'origine, sans instance de circuit).
    pecId = (await prisma.congressNational.create({
      data: { name: `${RUN} Congrès de diabétologie`, requesterId: u.kam, productManagerId: u.dm, requestStatus: "APPROVED", companyId, city: "Oran", date: new Date("2026-12-12"), endDate: new Date("2026-12-14"), circuitAchatAt: new Date() },
      select: { id: true },
    })).id;
    envId = (await prisma.budgetEnvelope.create({ data: { name: `${RUN}Enveloppe`, modules: ["CONGRESS_NATIONAL"], totalAmount: 50_000_000, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31") }, select: { id: true } })).id;
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${RUN}Congrès`, module: "CONGRESS_NATIONAL", allocated: 10_000_000 }, select: { id: true } })).id;
  }, 60_000);

  afterAll(async () => {
    ACTOR = null;
    const ids = Object.values(u).filter(Boolean);
    const legaux = (await prisma.carePecBc.findMany({ where: { congressNationalId: pecId }, select: { legalDocumentId: true } }).catch(() => [])).map((b) => b.legalDocumentId).filter((x): x is string => Boolean(x));
    const sujet = (await prisma.congressNational.findUnique({ where: { id: pecId }, select: { careReservationDossierId: true } }).catch(() => null))?.careReservationDossierId;
    await retirerDocumentsEtContenu({ where: { entityId: { in: [pecId, ...legaux] } } }).catch(() => {});
    await prisma.signatureBC.deleteMany({ where: { legalDocumentId: { in: legaux } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityId: { in: legaux } } }).catch(() => {});
    const ordres = (await prisma.expenseOrder.findMany({ where: { sourceId: pecId }, select: { id: true } }).catch(() => [])).map((o) => o.id);
    await prisma.carePecBc.deleteMany({ where: { congressNationalId: pecId } }).catch(() => {});
    await prisma.careChiffrage.deleteMany({ where: { congressNationalId: pecId } }).catch(() => {});
    await prisma.careBeneficiary.deleteMany({ where: { congressNationalId: pecId } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres } } }).catch(() => {});
    await prisma.dossier.deleteMany({ where: { OR: [{ sourceId: { in: ordres } }, ...(sujet ? [{ id: sujet }] : [])] } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [pecId, ...legaux] } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: legaux } } }).catch(() => {});
    await prisma.adProPorteDg.deleteMany({ where: { entityId: pecId } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: pecId } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { id: catId } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { name: { contains: RUN } } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: ids } } } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { ownerId: { in: ids }, type: "FILE" } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { ownerId: { in: ids } } }).catch(() => {});
    await prisma.documentSequence.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: RUN } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.companyLegalIdentity.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
  }, 120_000);

  const ligneDe = async (bcId: string, cellId: string) => prisma.carePecBcLigne.findUniqueOrThrow({ where: { bcId_cellId: { bcId, cellId } } });

  it("1. ajout : sans billet ni hôtel d'office, « Demander son devis » ouvre UNE demande de chiffrage (bureau du secrétariat)", async () => {
    await comme("kam");
    for (const [k, nom] of [["a", "Kaci"], ["b", "Ferhat"]] as const) {
      const r = await addCareBeneficiary(undefined, fd({ scope: "NATIONAL", requestId: pecId, lastName: `${RUN} ${nom}`, firstName: "Dr", demanderDevis: "on" }));
      expect(r.ok, msg(r)).toBe(true);
      P[k] = r.id!;
    }
    expect(await prisma.careCell.count({ where: { beneficiaryId: { in: [P.a, P.b] } } }), "aucun poste d'office").toBe(0);
    const ch = await prisma.careChiffrage.findMany({ where: { congressNationalId: pecId } });
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ etat: "A_PRENDRE", tous: false });
    expect([...ch[0]!.beneficiaryIds].sort()).toEqual([P.a, P.b].sort());
    // Les postes s'ajoutent à la main.
    for (const [cle, beneficiaryId, posteType] of [["aBillet", P.a, "BILLET"], ["aHotel", P.a, "HOTEL"], ["bBillet", P.b, "BILLET"]] as const) {
      const r = await addCareCell(undefined, fd({ beneficiaryId, posteType }));
      expect(r.ok, msg(r)).toBe(true);
      C[cle] = r.id!;
    }
    const da = await comme("da");
    const bureau = await lignesBureauPecChiffrage(da);
    expect(bureau.find((l) => l.href.includes(pecId))).toMatchObject({ type: "Chiffrage", etat: "A_PRENDRE", famille: "pec-chiffrage" });
  });

  it("2. l'assistante chiffre, pièce facultative, et « Envoyer les montants » — historisé, compté dans la porte du DG", async () => {
    await comme("da");
    const grille = await pageChiffrage("NATIONAL", pecId);
    expect(grille?.lignes.map((l) => l.cellId).sort()).toEqual([C.aBillet, C.aHotel, C.bBillet].sort());
    const manque = await enregistrerMontantsPec(saisie({ scope: "NATIONAL", requestId: pecId, envoyer: "oui" }, [[C.aBillet, "46000"], [C.aHotel, ""], [C.bBillet, ""]]));
    expect(manque.ok).toBe(false);
    expect(manque.error).toMatch(/2 montants manquants/);
    const r = await enregistrerMontantsPec(saisie({ scope: "NATIONAL", requestId: pecId, envoyer: "oui" }, [[C.aBillet, "46000"], [C.aHotel, "58000"], [C.bBillet, "82000"]], [[C.aHotel, pdf("devis-hotel-oran.pdf")]]));
    expect(r.ok, msg(r)).toBe(true);
    expect((await prisma.careChiffrage.findFirstOrThrow({ where: { congressNationalId: pecId } })).etat).toBe("TERMINEE");
    expect(await prisma.carePrixHistorique.count({ where: { cellId: { in: [C.aBillet, C.aHotel, C.bBillet] } } })).toBe(3);
    expect((await prisma.careCell.findUniqueOrThrow({ where: { id: C.aHotel } })).chiffragePieceId).toBeTruthy();
    expect(await totalDeLaDemande("CONGRESS_NATIONAL", pecId)).toBe(186_000);
    const dm = await comme("dm");
    const vue = await vueAchatsPec(dm, "NATIONAL", pecId);
    expect(vue.aValider).toMatchObject({ total: 186_000 });
    expect(vue.aValider.ids.sort()).toEqual([P.a, P.b].sort());
    expect(vue.professionnels.find((p) => p.id === P.a)?.etat.libelle).toBe("Chiffré — à valider");
  });

  it("3. la DM « Valider et lancer les achats » : BC n°1 (vrai bon de commande), retenu jusqu'à sa signature", async () => {
    await comme("dm");
    const r = await validerProfessionnelsPec(fd({ scope: "NATIONAL", requestId: pecId, lancer: "oui", budgetCategoryId: catId }));
    expect(r.ok, msg(r)).toBe(true);
    expect(r.message).toMatch(/BC n°1/);
    expect((await prisma.careBeneficiary.findMany({ where: { id: { in: [P.a, P.b] } }, select: { status: true } })).every((b) => b.status === "APPROVED")).toBe(true);
    const bc = await prisma.carePecBc.findFirstOrThrow({ where: { congressNationalId: pecId, numero: 1 }, include: { lignes: true } });
    bc1 = { id: bc.id, legal: bc.legalDocumentId! };
    expect(bc.lignes).toHaveLength(3);
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: bc1.legal } });
    expect(doc).toMatchObject({ kind: "PURCHASE_ORDER", sourceType: "CONGRESS_NATIONAL", sourceId: pecId, companyId });
    expect(Number(doc.amount)).toBe(186_000);
    expect(doc.bcPrevalidationAt, "retenu : aucun centre ne le voit avant la DM").not.toBeNull();
    expect(await prisma.adProGateVisa.count({ where: { entityId: bc1.legal } })).toBe(0);
    // Rien ne s'achète avant la signature des Finances.
    await comme("da");
    const refusBillet = await enregistrerBilletEmis(undefined, fd({ id: C.aBillet, bookingRef: "PNR1" }));
    expect(refusBillet.ok).toBe(false);
    expect(refusBillet.error).toMatch(/pas encore signé par les Finances/);
  });

  it("4. signature DM → centre Ad & Pro (visa du DG) → signature des Finances ; l'assistante est prévenue ; le BC signé est immuable", async () => {
    await comme("dm");
    const s = await signerBcPec(fd({ bcId: bc1.id, lu: "oui", motDePasse: "x", code: "000000" }));
    expect(s.ok, msg(s)).toBe(true);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: bc1.legal } })).bcPrevalidationAt).toBeNull();
    expect((await prisma.adProGateVisa.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "LEGAL_DOCUMENT", entityId: bc1.legal } } })).status).toBe("PENDING");
    expect(await refusRevisionBcPecDuDocument(bc1.legal), "signé par la DM : immuable").toBe(REFUS_BC_PEC_IMMUABLE);
    expect(refusRevisionBcPec({ bcPec: true, signeDm: false, signeFinances: false }), "pas encore signé : révisable").toBeNull();
    expect(refusRevisionBcPec({ bcPec: false, signeDm: true, signeFinances: true }), "un autre BC suit ses règles").toBeNull();
    await comme("fin");
    const tot = await signerBonDeCommandeEnLigne(fd({ id: bc1.legal, lu: "oui", motDePasse: "x", code: "000000" }));
    expect(tot.ok, "pas avant le visa du centre").toBe(false);
    await comme("dg");
    const v = await deciderVisaCentreAdPro(fd({ entityType: "LEGAL_DOCUMENT", entityId: bc1.legal, decision: "VALIDER" }));
    expect(v.ok, msg(v)).toBe(true);
    expect((await etatDuBC(bc1.legal))?.etape).toBe("A_SIGNER");
    await comme("fin");
    const f = await signerBonDeCommandeEnLigne(fd({ id: bc1.legal, lu: "oui", motDePasse: "x", code: "000000" }));
    expect(f.ok, msg(f)).toBe(true);
    expect(await prisma.notification.count({ where: { userId: u.da, title: { contains: "BC n°1 signé" } } }), "l'assistante est prévenue d'acheter").toBeGreaterThan(0);
    const bureau = await lignesBureauPecAchat(await comme("da"));
    expect(bureau.find((l) => l.cle === `pec-achat:${bc1.id}`)).toMatchObject({ type: "Achat — BC n°1", etat: "A_PRENDRE" });
  });

  it("5. un ajout après signature part dans le BC n°2 ; le BC n°1 ne bouge pas", async () => {
    await comme("kam");
    const r = await addCareBeneficiary(undefined, fd({ scope: "NATIONAL", requestId: pecId, lastName: `${RUN} Haddad`, firstName: "Dr", demanderDevis: "on" }));
    expect(r.ok, msg(r)).toBe(true);
    P.c = r.id!;
    C.cTransport = (await addCareCell(undefined, fd({ beneficiaryId: P.c, posteType: "TRANSPORT" }))).id!;
    C.cBillet = (await addCareCell(undefined, fd({ beneficiaryId: P.c, posteType: "BILLET" }))).id!;
    await comme("da");
    const m = await enregistrerMontantsPec(saisie({ scope: "NATIONAL", requestId: pecId, envoyer: "oui" }, [[C.cTransport, "20000"]]));
    expect(m.ok, msg(m)).toBe(true);
    await comme("dm");
    const l = await validerProfessionnelsPec(fd({ scope: "NATIONAL", requestId: pecId, beneficiaryIds: P.c, lancer: "oui" }));
    expect(l.ok, msg(l)).toBe(true);
    const bc = await prisma.carePecBc.findFirstOrThrow({ where: { congressNationalId: pecId, numero: 2 }, include: { lignes: true } });
    bc2 = { id: bc.id, legal: bc.legalDocumentId! };
    expect(bc.lignes.map((x) => x.cellId)).toEqual([C.cTransport]);
    expect(await prisma.carePecBcLigne.count({ where: { bcId: bc1.id } })).toBe(3);
    expect(Number((await prisma.legalDocument.findUniqueOrThrow({ where: { id: bc1.legal } })).amount)).toBe(186_000);
    // Un billet hors de tout BC ne s'achète pas.
    expect(await refusAchatHorsBcPec(C.cBillet)).toMatch(/aucun bon de commande signé/);
    await comme("da");
    const horsBc = await enregistrerBilletEmis(undefined, fd({ id: C.cBillet, bookingRef: "PNR9" }));
    expect(horsBc.ok).toBe(false);
  });

  it("6. retrait AVANT achat : la ligne est barrée, l'engagement libéré", async () => {
    const avant = await totalDeLaDemande("CONGRESS_NATIONAL", pecId);
    await comme("dm");
    const r = await retirerProfessionnelPec(fd({ beneficiaryId: P.b, motif: "Visa refusé" }));
    expect(r.ok, msg(r)).toBe(true);
    expect((await ligneDe(bc1.id, C.bBillet)).statut).toBe("RETIREE_AVANT_ACHAT");
    expect(await totalDeLaDemande("CONGRESS_NATIONAL", pecId)).toBe(avant - 82_000);
    const da = await comme("da");
    const vue = await vueAchatsPec(da, "NATIONAL", pecId);
    expect(vue.professionnels.find((p) => p.id === P.b)?.etat.libelle).toBe("Retiré du BC n°1 avant achat");
  });

  it("7. la marge : +8 % corrigé sans nouveau BC ; +15 % refusé sur le BC signé, le complément mis de côté", async () => {
    await comme("da");
    const ok8 = await modifierMontantPec(fd({ cellId: C.aHotel, montant: "62640" }));
    expect(ok8.ok, msg(ok8)).toBe(true);
    expect(ok8.message).toMatch(/dans la marge/);
    expect(Number((await ligneDe(bc1.id, C.aHotel)).montantAchatDzd)).toBe(62_640);
    const h15 = await modifierMontantPec(fd({ cellId: C.aBillet, montant: "52900" }));
    expect(h15.ok, msg(h15)).toBe(true);
    expect(h15.message).toMatch(/Au-delà de la marge/);
    expect(h15.message).toMatch(/BC complémentaire/);
    const l = await ligneDe(bc1.id, C.aBillet);
    expect(Number(l.montantDzd)).toBe(46_000);
    expect(l.montantAchatDzd, "la ligne du BC signé ne bouge pas").toBeNull();
    const vue = await vueAchatsPec(await comme("dm"), "NATIONAL", pecId);
    expect(vue.professionnels.find((p) => p.id === P.a)?.etat.libelle).toBe("Complément chiffré — à valider");
    expect(Number((await prisma.legalDocument.findUniqueOrThrow({ where: { id: bc1.legal } })).amount)).toBe(186_000);
    expect(await prisma.carePrixHistorique.count({ where: { cellId: { in: [C.aHotel, C.aBillet] } } })).toBe(4);
  });

  it("8. l'assistante achète seulement ce qui est dans le BC signé ; « réglé » ne se pose pas à la main", async () => {
    await comme("da");
    const sansFichier = await acheterLignePec(fd({ ligneId: (await ligneDe(bc1.id, C.aBillet)).id }));
    expect(sansFichier.ok).toBe(false);
    for (const cellId of [C.aBillet, C.aHotel]) {
      const f = fd({ ligneId: (await ligneDe(bc1.id, cellId)).id, reference: "PNR-OR1" });
      f.append("pieces", pdf("billet.pdf"));
      const r = await acheterLignePec(f);
      expect(r.ok, msg(r)).toBe(true);
    }
    const barree = await acheterLignePec(fd({ ligneId: (await ligneDe(bc1.id, C.bBillet)).id }));
    expect(barree.ok).toBe(false);
    expect((await prisma.careCell.findUniqueOrThrow({ where: { id: C.aBillet } })).issuedDocumentId).toBeTruthy();
    const manuel = await setCareCellStatus(undefined, fd({ id: C.aHotel, status: "SETTLED" }));
    expect(manuel.ok).toBe(false);
  });

  it("9. retrait APRÈS achat : « Remboursé ? » — oui sur le billet, non sur l'hôtel ; le budget est déduit", async () => {
    await comme("dm");
    const r = await retirerProfessionnelPec(fd({ beneficiaryId: P.a, motif: "Annulation" }));
    expect(r.ok, msg(r)).toBe(true);
    expect((await ligneDe(bc1.id, C.aBillet)).statut).toBe("RETIREE_APRES_ACHAT");
    await comme("da");
    const paiementAvant = await demanderPaiementBcPec(fd({ bcId: bc1.id }));
    expect(paiementAvant.ok).toBe(false);
    expect(paiementAvant.error).toMatch(/Remboursé/);
    const oui = await repondreRemboursementPec(fd({ ligneId: (await ligneDe(bc1.id, C.aBillet)).id, rembourse: "oui" }));
    expect(oui.ok, msg(oui)).toBe(true);
    const non = await repondreRemboursementPec(fd({ ligneId: (await ligneDe(bc1.id, C.aHotel)).id, rembourse: "non" }));
    expect(non.ok, msg(non)).toBe(true);
    // Billet remboursé (0), hôtel acheté non remboursé (62 640), Dr Haddad chiffré (20 000).
    expect(await totalDeLaDemande("CONGRESS_NATIONAL", pecId)).toBe(82_640);
  });

  it("10. le paiement du BC : facture OBLIGATOIRE → UN seul ordre de dépense au total réel", async () => {
    await comme("da");
    const sans = await demanderPaiementBcPec(fd({ bcId: bc1.id }));
    expect(sans.ok).toBe(false);
    expect(sans.error).toMatch(/facture/);
    const f = fd({ bcId: bc1.id });
    f.set("facture", pdf("facture-agence.pdf"));
    const r = await demanderPaiementBcPec(f);
    expect(r.ok, msg(r)).toBe(true);
    const f2 = fd({ bcId: bc1.id });
    f2.set("facture", pdf("facture-agence-bis.pdf"));
    const deux = await demanderPaiementBcPec(f2);
    expect(deux.ok, "un seul ordre par BC").toBe(false);
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceType: "CONGRESS_NATIONAL", sourceId: pecId } });
    expect(ordres).toHaveLength(1);
    expect(Number(ordres[0]!.amount)).toBe(62_640);
    expect(ordres[0]!.budgetCategoryId).toBe(catId);
    expect((await prisma.carePecBc.findUniqueOrThrow({ where: { id: bc1.id } })).expenseOrderId).toBe(ordres[0]!.id);
    const bureau = await lignesBureauPecAchat(await comme("da"));
    expect(bureau.find((l) => l.cle === `pec-achat:${bc1.id}`)?.etat).toBe("EN_PAIEMENT");
  });

  it("11. le BC n°2 n'est pas signé par les Finances : rien ne s'y achète", async () => {
    await comme("da");
    const r = await acheterLignePec(fd({ ligneId: (await ligneDe(bc2.id, C.cTransport)).id }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/pas encore signé par les Finances/);
  });

  it("12. « Actualiser les prix » rouvre une demande de chiffrage de tout ce qui n'est pas encore acheté", async () => {
    await comme("dm");
    const r = await demanderChiffragePec(fd({ scope: "NATIONAL", requestId: pecId, tous: "on" }));
    expect(r.ok, msg(r)).toBe(true);
    const ouverte = await prisma.careChiffrage.findFirstOrThrow({ where: { congressNationalId: pecId, etat: "A_PRENDRE" } });
    expect(ouverte.tous).toBe(true);
    const grille = await pageChiffrage("NATIONAL", pecId);
    expect(grille?.lignes.map((l) => l.cellId).sort(), "le transport (BC n°2, pas acheté) et le billet sans BC de Dr Haddad").toEqual([C.cTransport, C.cBillet].sort());
  });
});
