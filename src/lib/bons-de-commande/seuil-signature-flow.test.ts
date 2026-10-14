import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { createLegalDocument, updateLegalDocument, adresserBCAuCentre } from "@/lib/actions/legal-actions";
import { decideValidation } from "@/lib/actions/validation-actions";
import { signerBonDeCommande } from "@/lib/actions/bc-signature-actions";
import { avecCopieSignee } from "@/lib/bons-de-commande/signature-test-outils";
import { setBcValidationThreshold, setBcValidationThresholdCentre } from "@/lib/actions/settings-actions";
import { fileBonsDeCommande, REFUS_SIGNATURE_BC } from "@/lib/queries/bons-de-commande";
import { requestAdProItemOrder } from "@/lib/actions/ad-pro-item-actions";
import { completePromoTrack } from "@/lib/actions/promo-circuit-actions";
import { submitBcForFinance } from "@/lib/actions/promo-material-actions";
import { etatDuBC } from "./etat";
import { OBJET_BC, CHEMIN_BC_A_SIGNER } from "./aiguillage";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__bcseuil__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE SEUIL DES BONS DE COMMANDE, ET LA SIGNATURE DES FINANCES — par les VRAIS points d'entrée
 * (§118.149).
 *
 * « Tout BC supérieur à un montant configuré dans les centres de validations Ad&Pro devra passer
 * par la validation d'un des centres. » — « Un sous-module Bons de commande sous Finances : les
 * bons de commande à signer de leur part. Si un BC se retrouve là-bas, c'est qu'il doit être
 * signé. »
 *
 * ── LE SEUIL EST UN RÉGLAGE GLOBAL, ET LA SUITE TOURNE EN PARALLÈLE ─────────────────────────
 *
 * Le poser à 500 000 pour ce banc ferait passer sous le seuil les BC de 100 000 DZD que les bancs
 * voisins s'attendent à voir au centre (§118.115). On le pose donc à 1 DZD, et ce banc joue avec
 * des BC de 1, 2 et 5 DZD : aucun autre banc n'écrit de BC dans cette bande, et un BC de voisin
 * — 100 000 DZD, ou sans montant — exige un centre sous 1 DZD exactement comme sous « aucun
 * seuil ». Le seuil d'origine est RESTAURÉ à la fin.
 *
 * Le signataire est un gestionnaire budgétaire des Finances, PAS un Super Admin : une garde de
 * droit éprouvée avec un Super Admin ne peut pas tomber (§118.104). Les prémisses sont assertées.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Seuil des bons de commande et signature des Finances — le flux réel", () => {
  let legalId = "", financeId = "", saId = "", contactId = "", kamId = "", eventId = "", catId = "";
  let seuilDOrigine = 0;
  let seuilCentreDOrigine = 0;
  const docs: string[] = [];

  const creerBC = async (suffix: string, montant: string) => {
    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    const r = await createLegalDocument(undefined, form({
      title: `${TAG} ${suffix}`, reference: `${TAG}${suffix}`, kind: "PURCHASE_ORDER",
      counterpartyIds: contactId, amount: montant,
    }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    docs.push(r.id!);
    return r;
  };
  const validationsDe = (docId: string, status?: string) => prisma.validationRequest.findMany({
    where: { entityType: "LEGAL_DOCUMENT", entityId: docId, objectType: OBJET_BC, ...(status ? { status: status as never } : {}) },
    include: { steps: true },
  });
  const signer = async (docId: string, qui: "FINANCE" | "LEGAL" = "FINANCE") => {
    ACTOR = qui === "FINANCE" ? await actorFor(financeId, "FINANCE_BUDGET_MANAGER") : await actorFor(legalId, "DIRECTION_ASSISTANT");
    return signerBonDeCommande(avecCopieSignee(form({ id: docId })));
  };
  // UN SEUIL PAR CENTRE (Direction, 10/2026) : les BC de Legal relèvent du centre de validations, ceux d'Ad & Pro du
  // centre Ad & Pro. Le banc règle les DEUX à la même valeur, et rend la réponse du centre de validations — c'est
  // lui qui réaiguille les BC de Legal que ce banc observe.
  const reglerSeuil = async (seuil: number) => {
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const a = await setBcValidationThreshold(form({ bcValidationThreshold: String(seuil) }));
    expect(a.ok, a.ok === false ? a.error : "").toBe(true);
    const r = await setBcValidationThresholdCentre(form({ bcValidationThresholdCentre: String(seuil) }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    return r;
  };

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    legalId = (await mk("legal", "DIRECTION_ASSISTANT")).id;
    financeId = (await mk("finance", "FINANCE_BUDGET_MANAGER")).id;
    saId = (await mk("sa", "SUPER_ADMIN")).id;
    contactId = (await prisma.companyContact.create({ data: { name: `${TAG} Imprimerie`, companyId: null } })).id;
    kamId = (await mk("kam", "MEDICAL_DELEGATE")).id;
    eventId = (await prisma.event.create({
      data: { name: `${TAG}Journée`, requesterId: kamId, startDate: new Date("2026-11-02") }, select: { id: true },
    })).id;
    const env = await prisma.budgetEnvelope.create({
      data: {
        name: `${TAG}Enveloppe`, modules: ["EVENTS"], totalAmount: 5_000_000,
        periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"),
      },
      select: { id: true },
    });
    catId = (await prisma.budgetCategoryLine.create({
      data: { envelopeId: env.id, name: `${TAG}Traiteurs`, allocated: 1_000_000 }, select: { id: true },
    })).id;
    const row = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { bcValidationThreshold: true, bcValidationThresholdCentre: true } });
    seuilDOrigine = row ? Number(row.bcValidationThreshold) : 0;
    seuilCentreDOrigine = row ? Number(row.bcValidationThresholdCentre) : 0;
    // 1 DZD : voir l'en-tête — aucun BC d'un banc voisin ne change de côté. Les deux centres.
    await prisma.appSetting.upsert({
      where: { id: "global" },
      create: { id: "global", bcValidationThreshold: 1, bcValidationThresholdCentre: 1 },
      update: { bcValidationThreshold: 1, bcValidationThresholdCentre: 1 },
    });
  });

  afterAll(async () => {
    await prisma.appSetting.updateMany({ where: { id: "global" }, data: { bcValidationThreshold: seuilDOrigine, bcValidationThresholdCentre: seuilCentreDOrigine } }).catch(() => {});
    const vIds = (await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docs } }, select: { id: true } })).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docs } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docs } } }).catch(() => {});
    await prisma.legalDocumentReader.deleteMany({ where: { documentId: { in: docs } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs } } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    const postes = (await prisma.adProItem.findMany({ where: { label: { startsWith: TAG } }, select: { id: true } }).catch(() => [])).map((p) => p.id);
    await prisma.documentRequest.deleteMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: postes } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { label: { startsWith: TAG } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.promoMaterial.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    const comptes = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    const ids = comptes.map((c) => c.id);
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("PRÉMISSES : le signataire a la signature du module « Bons de commande » et n'est pas Super Admin ; l'auteur n'a PAS le droit de signer", async () => {
    // La porte de la signature est le module « Bons de commande » depuis §118.176 — plus le droit
    // des Finances. Le gestionnaire budgétaire la tient PAR DÉFAUT (le périmètre d'hier).
    const f = await actorFor(financeId, "FINANCE_BUDGET_MANAGER");
    expect(userCan(f, "PURCHASE_ORDERS", "UPDATE")).toBe(true);
    expect(f.role).not.toBe("SUPER_ADMIN");
    const l = await actorFor(legalId, "DIRECTION_ASSISTANT");
    expect(userCan(l, "LEGAL", "CREATE")).toBe(true);
    expect(userCan(l, "PURCHASE_ORDERS", "UPDATE"), "sans cela, le refus de signature ne se mesurerait pas").toBe(false);
  });

  it("SOUS LE SEUIL : aucun centre, directement dans la file des Finances — et la phrase le DIT", async () => {
    const r = await creerBC("petit", "1");
    expect(await validationsDe(r.id!), "aucune demande de validation n'est posée").toHaveLength(0);
    expect(await prisma.adProGateVisa.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: r.id! } })).toBe(0);
    const e = await etatDuBC(r.id!);
    expect(e?.etape).toBe("A_SIGNER");
    expect(r.message ?? "").toMatch(/Sous le seuil/);
    expect(r.message ?? "").toMatch(/signature des Finances/);

    // Les Finances sont PRÉVENUES — la file ne sert à rien si personne ne sait qu'elle bouge.
    const notif = await prisma.notification.findFirst({
      // La notification ouvre la file SUR la ligne du BC (`?bc=<id>`).
      where: { userId: financeId, link: { startsWith: CHEMIN_BC_A_SIGNER }, body: { contains: `${TAG}petit` } },
    });
    expect(notif, "une notification « à signer » pour les Finances").not.toBeNull();

    ACTOR = await actorFor(financeId, "FINANCE_BUDGET_MANAGER");
    const file = await fileBonsDeCommande(ACTOR);
    expect(file?.aSigner.map((l) => l.id)).toContain(r.id);
  });

  it("AU-DESSUS : au centre de validations d'abord — absent de la file, et la signature refusée en NOMMANT pourquoi", async () => {
    const r = await creerBC("grand", "5");
    expect(await validationsDe(r.id!, "PENDING")).toHaveLength(1);
    expect((await etatDuBC(r.id!))?.etape).toBe("A_VALIDER");

    ACTOR = await actorFor(financeId, "FINANCE_BUDGET_MANAGER");
    const file = await fileBonsDeCommande(ACTOR);
    expect(file?.aSigner.map((l) => l.id)).not.toContain(r.id);

    const s = await signer(r.id!);
    expect(s.ok).toBe(false);
    expect(s.ok ? "" : s.error).toMatch(/attend encore la validation/);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.id! } })).signedAt).toBeNull();
  });

  it("VALIDÉ par son centre → il passe « à signer », et les Finances en sont prévenues par la décision", async () => {
    const r = await creerBC("valide", "5");
    const [v] = await validationsDe(r.id!, "PENDING");
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const d = await decideValidation(form({ stepId: v.steps[0].id, decision: "APPROVED" }));
    expect(d.ok, d.ok === false ? d.error : "").toBe(true);
    expect((await etatDuBC(r.id!))?.etape).toBe("A_SIGNER");
    const notif = await prisma.notification.findFirst({
      where: { userId: financeId, link: { startsWith: CHEMIN_BC_A_SIGNER }, body: { contains: `${TAG}valide` } },
    });
    expect(notif, "la validation du centre prévient les Finances").not.toBeNull();
  });

  it("SIGNER : qui n'a pas la signature des bons de commande est refusé ; le signataire signe ; la signature ne se donne pas deux fois", async () => {
    const r = await creerBC("asigner", "1");
    const refus = await signer(r.id!, "LEGAL");
    expect(refus.ok).toBe(false);
    expect(refus.ok ? "" : refus.error).toBe(REFUS_SIGNATURE_BC);

    const ok = await signer(r.id!);
    expect(ok.ok, ok.ok === false ? ok.error : "").toBe(true);
    const apres = await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.id! } });
    expect(apres.signedAt).not.toBeNull();
    expect(apres.signedById).toBe(financeId);
    expect((await etatDuBC(r.id!))?.etape).toBe("SIGNE");
    // L'auteur du BC est prévenu : c'est lui qui l'envoie au fournisseur.
    expect(await prisma.notification.count({ where: { userId: legalId, link: `/legal/${r.id}`, title: { contains: "signé" } } })).toBe(1);

    const encore = await signer(r.id!);
    expect(encore.ok).toBe(false);
    expect(encore.ok ? "" : encore.error).toMatch(/déjà signé/);
  });

  it("DEUX SIGNATURES SIMULTANÉES : une seule passe — le verrou est dans l'écriture, pas dans la lecture", async () => {
    const r = await creerBC("course", "1");
    const [a, b] = await Promise.all([signer(r.id!), signer(r.id!)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it("MODIFIÉ APRÈS SIGNATURE : la signature tombe — on ne signe pas 1 et on n'envoie pas 5 « signé »", async () => {
    const r = await creerBC("resigner", "1");
    expect((await signer(r.id!)).ok).toBe(true);
    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    const u = await updateLegalDocument(form({
      id: r.id!, title: `${TAG} resigner`, reference: `${TAG}resigner`, kind: "PURCHASE_ORDER",
      counterpartyIds: contactId, amount: "5",
    }));
    expect(u.ok, u.ok === false ? u.error : "").toBe(true);
    const apres = await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.id! } });
    expect(apres.signedAt, "la signature est retirée").toBeNull();
    expect(apres.signedById).toBeNull();
    expect(u.message ?? "").toMatch(/signature est retirée/);
    // Relevé AU-DESSUS du seuil : il repart au centre, pas directement à la signature.
    expect((await etatDuBC(r.id!))?.etape).toBe("A_VALIDER");
  });

  it("UN BC D'AVANT LE CIRCUIT n'apparaît pas dans la file — et « Adresser » le fait entrer, sous le seuil, à la signature", async () => {
    const ancien = await prisma.legalDocument.create({
      data: {
        title: `${TAG} ancien`, reference: `${TAG}ancien`, kind: "PURCHASE_ORDER", amount: 1,
        counterparty: "Imprimerie", createdById: legalId, updatedById: legalId,
      },
      select: { id: true },
    });
    docs.push(ancien.id);
    expect((await etatDuBC(ancien.id))?.etape).toBe("HORS_CIRCUIT");
    ACTOR = await actorFor(financeId, "FINANCE_BUDGET_MANAGER");
    expect((await fileBonsDeCommande(ACTOR))?.aSigner.map((l) => l.id)).not.toContain(ancien.id);
    const s = await signer(ancien.id);
    expect(s.ok).toBe(false);
    expect(s.ok ? "" : s.error).toMatch(/antérieur au circuit/);

    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    const a = await adresserBCAuCentre(form({ id: ancien.id }));
    expect(a.ok, a.ok === false ? a.error : "").toBe(true);
    expect(a.ok ? a.message ?? "" : "").toMatch(/signature des Finances/);
    expect((await etatDuBC(ancien.id))?.etape).toBe("A_SIGNER");
  });

  it("UNE DATE DE SIGNATURE PAPIER ne vaut pas signature des Finances : re-qualifié en BC, le contrat n'est pas « signé »", async () => {
    const contrat = await prisma.legalDocument.create({
      data: {
        title: `${TAG} contrat`, reference: `${TAG}contrat`, kind: "CONTRACT", amount: 1,
        counterparty: "Imprimerie", counterpartyIds: [contactId], signedAt: new Date("2026-03-01"),
        createdById: legalId, updatedById: legalId,
      },
      select: { id: true },
    });
    docs.push(contrat.id);
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const u = await updateLegalDocument(form({
      id: contrat.id, title: `${TAG} contrat`, reference: `${TAG}contrat`, kind: "PURCHASE_ORDER",
      counterpartyIds: contactId, amount: "1",
    }));
    expect(u.ok, u.ok === false ? u.error : "").toBe(true);
    const e = await etatDuBC(contrat.id);
    expect(e?.etape, "sans cette garde, il serait SIGNÉ sans que les Finances l'aient vu").toBe("A_SIGNER");
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: contrat.id } })).signedAt).toBeNull();
  });

  it("CHANGER LE SEUIL RÉAIGUILLE ce qui est en vol — dans les DEUX sens, et la phrase dit combien", async () => {
    const r = await creerBC("bande", "2");
    expect(await validationsDe(r.id!, "PENDING"), "2 DZD > 1 : au centre").toHaveLength(1);

    // RELEVÉ à 3 : 2 DZD passe sous le seuil — sa validation en attente quitte le centre.
    const haut = await reglerSeuil(3);
    expect(haut.ok ? haut.message ?? "" : "").toMatch(/directement à la signature/);
    expect(await validationsDe(r.id!, "PENDING")).toHaveLength(0);
    expect((await etatDuBC(r.id!))?.etape).toBe("A_SIGNER");

    // ABAISSÉ à 1 : il repasse au-dessus — une porte est reposée, il quitte la file des Finances.
    const bas = await reglerSeuil(1);
    expect(bas.ok ? bas.message ?? "" : "").toMatch(/adressé.* au centre de validations/);
    expect(await validationsDe(r.id!, "PENDING")).toHaveLength(1);
    expect((await etatDuBC(r.id!))?.etape).toBe("A_VALIDER");
  });

  it("UN POSTE AD & PRO SOUS LE SEUIL : sa demande de BC passe aux Finances sans centre — et la fiche ne dit pas « validé par le centre »", async () => {
    const poste = await prisma.adProItem.create({
      data: {
        eventId, kind: "CATERING", label: `${TAG}Traiteur`, status: "APPROVED",
        amountGranted: 1, budgetCategoryId: catId, createdById: kamId,
      },
      select: { id: true },
    });
    ACTOR = await actorFor(kamId, "MEDICAL_DELEGATE");
    // L'assistante qui établira le BC est NOMMÉE (§118.204) : la base est partagée, et le choix
    // automatique « la seule assistante active » dépend des bancs voisins.
    const r = await requestAdProItemOrder(undefined, form({ id: poste.id, note: `${TAG}80 couverts`, assistantId: legalId }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    expect(r.ok ? r.message ?? "" : "").toMatch(/Sous le seuil/);
    const apres = await prisma.adProItem.findUniqueOrThrow({
      where: { id: poste.id }, select: { orderStage: true, orderDirectionAt: true, orderDirectionById: true, orderDecisionNote: true },
    });
    expect(apres.orderStage, "prêt à émettre, comme après un visa").toBe("DIRECTION_OK");
    // AUCUNE attestation inventée : sans visa, pas de date ni d'auteur de visa.
    expect(apres.orderDirectionAt).toBeNull();
    expect(apres.orderDirectionById).toBeNull();
    expect(apres.orderDecisionNote ?? "").toMatch(/Sous le seuil/);
  });

  it("LE CHANTIER « BON DE COMMANDE » d'un dossier promo ne se clôt qu'une fois ses BC SIGNÉS", async () => {
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const dossier = await prisma.promoMaterial.create({
      data: { reference: `${TAG}MP-1`, title: `${TAG}Kakémonos`, requesterId: saId, circuitState: "IN_EXECUTION" },
      select: { id: true },
    });
    const bc = await prisma.legalDocument.create({
      data: {
        title: `${TAG} BC kakémonos`, reference: `${TAG}BC-K1`, kind: "PURCHASE_ORDER", amount: 1,
        sourceType: "PROMO_MATERIAL", sourceId: dossier.id, createdById: saId, updatedById: saId,
      },
      select: { id: true },
    });
    docs.push(bc.id);
    // Le BC entre dans le circuit par le geste de rattrapage — sous le seuil, il va à la signature.
    const a = await adresserBCAuCentre(form({ id: bc.id }));
    expect(a.ok, a.ok === false ? a.error : "").toBe(true);
    expect((await etatDuBC(bc.id))?.etape).toBe("A_SIGNER");

    const clore = () => completePromoTrack(form({ id: dossier.id, track: "PURCHASE_ORDER" }));
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const avant = await clore();
    expect(avant.ok, "un BC à signer tient le chantier ouvert").toBe(false);
    expect(avant.ok ? "" : avant.error).toMatch(/pas encore signé/);

    expect((await signer(bc.id)).ok).toBe(true);
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const apres = await clore();
    expect(apres.ok, apres.ok === false ? apres.error : "").toBe(true);
  });

  it("LE SEUIL SE RÈGLE DEPUIS LE CENTRE : qui n'y siège pas est refusé, et rien n'est écrit", async () => {
    // La valeur de départ est LUE ici, pas supposée : ce cas ne dépend pas de l'état où les
    // précédents ont laissé le réglage (un cas qui hérite du voisin échoue pour le voisin).
    const lire = async () => Number((await prisma.appSetting.findUnique({ where: { id: "global" }, select: { bcValidationThreshold: true } }))?.bcValidationThreshold);
    const avant = await lire();
    ACTOR = await actorFor(financeId, "FINANCE_BUDGET_MANAGER");
    const r = await setBcValidationThreshold(form({ bcValidationThreshold: "500000" }));
    expect(r.ok).toBe(false);
    expect(await lire()).toBe(avant);
  });

  it("L'ANCIEN CIRCUIT DU MATÉRIEL PROMOTIONNEL applique le même seuil : sous le seuil, pas de centre ; au-dessus, le centre Ad & Pro", async () => {
    const dossier = async (ref: string, montant: number) => prisma.promoMaterial.create({
      data: { reference: `${TAG}${ref}`, title: `${TAG}${ref}`, requesterId: saId, status: "AGENCY_CHOSEN", chosenAgency: "Agence", chosenAmount: montant },
      select: { id: true },
    });
    const petit = await dossier("MP-P", 1);
    const grand = await dossier("MP-G", 5);
    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    const a = await submitBcForFinance(form({ id: petit.id }));
    expect(a.ok, a.ok === false ? a.error : "").toBe(true);
    expect(a.ok ? a.message ?? "" : "").toMatch(/Sous le seuil/);
    expect((await prisma.promoMaterial.findUniqueOrThrow({ where: { id: petit.id } })).status).toBe("BC_VALIDATED");
    const b = await submitBcForFinance(form({ id: grand.id }));
    expect(b.ok, b.ok === false ? b.error : "").toBe(true);
    expect((await prisma.promoMaterial.findUniqueOrThrow({ where: { id: grand.id } })).status, "au-dessus : il attend le centre").toBe("BC_FINANCE_REVIEW");
  });
});
