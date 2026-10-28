import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { createExpenseOrder } from "@/lib/expense-orders";
import { updateInvoice } from "@/lib/actions/invoice-actions";
import { updateGrantedBudget } from "@/lib/actions/congress-request-actions";
import { decidePettyCashTopUp } from "@/lib/actions/petty-cash-actions";
import { completePromoTrack } from "@/lib/actions/promo-circuit-actions";
import { decidePayment } from "@/lib/actions/payment-centre-actions";
import { canMarkPaidDirectly } from "@/lib/finances/settlement";
import { porteDuBC } from "@/lib/bons-de-commande/aiguillage";
// ⚠ ORDRE D'IMPORT (voir `assistant/capability-audit.test.ts`) : `assistant` avant `ops`.
import "@/lib/assistant";
import { DOMAIN_TOOLS } from "@/lib/assistant/ops";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PORTES QUI N'AVAIENT PAS DE BANC (§118.148).
 *
 * « Tous les paiements passent par le centre de paiements ; tous les BC par un centre de
 * validation. » Six gestes de ce lot ont été corrigés sans qu'aucun banc ne les exerce : une
 * correction qu'aucun test ne ferait tomber n'est pas une correction, c'est une intention
 * (§118.49). Chaque cas part du VRAI point d'entrée — l'action serveur, ou l'op telle qu'Adam la
 * reçoit — et porte son TÉMOIN : le même geste, dans la situation où la garde n'a rien à dire,
 * doit passer. Sans lui, une garde qui refuse TOUT passerait pour armée (§118.17).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__centreportes__";
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const session = async (id: string, role: string): Promise<SessionUser> =>
  ({ id, name: `${TAG}${role}`, email: `${TAG}${id}@t.dz`, role, secondaryRole: null, access: await getAccess(id, role as never), mustChangePassword: false }) as unknown as SessionUser;

suite("les portes du centre, par leurs vrais points d'entrée", () => {
  let saId = "", dirId = "", autreId = "";
  let sa: SessionUser, dir: SessionUser;

  beforeAll(async () => {
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, passwordHash: "x", role: role as never }, select: { id: true } });
    const [a, b, c] = await Promise.all([mk("sa", "SUPER_ADMIN"), mk("dir", "DIRECTION"), mk("autre", "DIRECTION_ASSISTANT")]);
    saId = a.id; dirId = b.id; autreId = c.id;
    sa = await session(saId, "SUPER_ADMIN");
    dir = await session(dirId, "DIRECTION");
  });

  afterAll(async () => {
    const ordres = await prisma.expenseOrder.findMany({ where: { OR: [{ label: { startsWith: TAG } }, { requestedById: { in: [saId, dirId, autreId] } }] }, select: { id: true } });
    const ids = ordres.map((o) => o.id);
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    const dossiers = await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ids } }, select: { id: true } });
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers.map((d) => d.id) } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers.map((d) => d.id) } } }).catch(() => {});
    await prisma.legalDocument.updateMany({ where: { title: { startsWith: TAG } }, data: { expenseOrderId: null } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { OR: [{ label: { contains: TAG } }, { createdById: { in: [saId, dirId, autreId] } }] } }).catch(() => {});
    const docs = await prisma.legalDocument.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
    const docIds = docs.map((d) => d.id);
    const vIds = (await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docIds } }, select: { id: true } })).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docIds } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docIds } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docIds } } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.promoMaterial.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.pettyCashTopUpRequest.deleteMany({ where: { reason: { startsWith: TAG } } }).catch(() => {});
    await prisma.pettyCashAllotment.deleteMany({ where: { note: { startsWith: TAG } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { code: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [saId, dirId, autreId] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [saId, dirId, autreId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  // ── 1. UNE FACTURE PARTIE AU CENTRE NE SE MARQUE PAS RÉGLÉE DEPUIS SON FORMULAIRE ─────────────
  it("`updateInvoice` refuse une date de règlement sur une facture partie au centre — la phrase EXACTE de la garde", async () => {
    ACTEUR = sa;
    const ordre = await createExpenseOrder({ label: `${TAG}facture partie`, amount: 120_000, category: "AUTRE", requestedById: saId });
    const partie = await prisma.legalDocument.create({
      data: { title: `${TAG}Facture partie`, kind: "INVOICE", amount: 120_000, expenseOrderId: ordre.id, createdById: saId },
      select: { id: true },
    });
    const r = await updateInvoice(fd({ id: partie.id, title: `${TAG}Facture partie`, paidDate: "2026-09-20" }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toBe(canMarkPaidDirectly({ paidDate: new Date(), expenseOrderId: "x" }).ok ? "" : (canMarkPaidDirectly({ paidDate: new Date(), expenseOrderId: "x" }) as { error: string }).error);
    const apres = await prisma.legalDocument.findUnique({ where: { id: partie.id }, select: { paidDate: true, settlementTxId: true } });
    expect(apres?.paidDate, "aucune date n'est posée").toBeNull();
    expect(apres?.settlementTxId, "aucune écriture de règlement en plus de celle que l'ordre écrira").toBeNull();

    // TÉMOIN : la même saisie sur une facture qui n'est PAS partie au circuit passe — c'est le
    // chemin qu'on garde pour ENREGISTRER un règlement fait avant l'enregistrement de la pièce.
    const libre = await prisma.legalDocument.create({
      data: { title: `${TAG}Facture libre`, kind: "INVOICE", amount: 80_000, createdById: saId },
      select: { id: true },
    });
    const ok = await updateInvoice(fd({ id: libre.id, title: `${TAG}Facture libre`, paidDate: "2026-09-20" }));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    const libreApres = await prisma.legalDocument.findUnique({ where: { id: libre.id }, select: { paidDate: true } });
    expect(libreApres?.paidDate).not.toBeNull();
  }, 60_000);

  // ── 2. RELEVER LE BUDGET D'UN CONGRÈS RENVOIE SON ORDRE AU CENTRE ─────────────────────────────
  it("`updateGrantedBudget` : relever un montant AUTORISÉ le renvoie au centre ; le baisser ne rouvre rien", async () => {
    ACTEUR = sa;
    const ordre = await createExpenseOrder({ label: `${TAG}congrès`, amount: 500_000, category: "EVENEMENT", requestedById: dirId });
    // Le centre autorise — par SON action, pas par une ligne posée à la main.
    const autorise = await decidePayment(fd({ id: ordre.id, decision: "APPROVE" }));
    expect(autorise.ok, autorise.ok ? "" : autorise.error).toBe(true);
    const congres = await prisma.congressNational.create({
      data: { name: `${TAG}Congrès SAHO`, requestStatus: "APPROVED" as never, finalAmount: 500_000, expenseOrderId: ordre.id },
      select: { id: true },
    });
    // Sa déclaration d'information médicale, pas encore validée : elle suit le budget accordé.
    const decl = await prisma.medicalInfoDeclaration.create({
      data: { reference: `${TAG}DIM-1`, sourceType: "CONGRESS_NATIONAL", sourceId: congres.id, label: `${TAG}Congrès SAHO`, amount: 500_000, expenseOrderId: ordre.id },
      select: { id: true },
    });

    // BAISSER : un geste qui réduit ne rouvre rien — l'autorisation couvre un montant plus petit.
    const baisse = await updateGrantedBudget(fd({ type: "NATIONAL", id: congres.id, finalAmount: "400000" }));
    expect(baisse.ok, baisse.ok ? "" : baisse.error).toBe(true);
    const apresBaisse = await prisma.expenseOrder.findUnique({ where: { id: ordre.id }, select: { centralStatus: true, amount: true } });
    expect(apresBaisse?.centralStatus).toBe("APPROVED");
    expect(Number(apresBaisse?.amount)).toBe(400_000);
    const declApres = await prisma.medicalInfoDeclaration.findUnique({ where: { id: decl.id }, select: { amount: true } });
    expect(Number(declApres?.amount), "la déclaration non validée suit le budget accordé").toBe(400_000);

    // RELEVER : l'autorisation portait sur 400 000 ; 900 000 est un engagement neuf.
    const hausse = await updateGrantedBudget(fd({ type: "NATIONAL", id: congres.id, finalAmount: "900000" }));
    expect(hausse.ok, hausse.ok ? "" : hausse.error).toBe(true);
    const apresHausse = await prisma.expenseOrder.findUnique({ where: { id: ordre.id }, select: { centralStatus: true, amount: true, centralDecidedById: true } });
    expect(apresHausse?.centralStatus, "le centre doit redonner son autorisation").toBe("AWAITING");
    expect(apresHausse?.centralDecidedById, "l'ancienne décision ne vaut plus pour ce montant").toBeNull();
    expect(Number(apresHausse?.amount)).toBe(900_000);
    // La raison voyage dans le FIL du centre, là où le prochain arbitre la lira.
    const fil = await prisma.paymentCentreMessage.findMany({ where: { orderId: ordre.id }, select: { body: true } });
    expect(fil.some((m) => /relevé de 400.000 à 900.000/.test(m.body.replace(/\s/g, " ").replace(/[  ]/g, " ")))).toBe(true);
  }, 60_000);

  // ── 2 bis. CE QUI NE SUIT PAS SE DIT (§118.191) ───────────────────────────────────────────────
  it("`updateGrantedBudget` : un ordre REFUSÉ ou RÉGLÉ ne suit pas le nouveau budget — et la phrase le dit", async () => {
    ACTEUR = sa;
    // REFUSÉ par le centre — par SON action. Le chiffre refusé reste celui que le centre a vu.
    const refuse = await createExpenseOrder({ label: `${TAG}congrès refusé`, amount: 300_000, category: "EVENEMENT", requestedById: dirId });
    const non = await decidePayment(fd({ id: refuse.id, decision: "REFUSE", body: "Pas de budget cette année." }));
    expect(non.ok, non.ok ? "" : non.error).toBe(true);
    const c1 = await prisma.congressNational.create({
      data: { name: `${TAG}Congrès refusé`, requestStatus: "APPROVED" as never, finalAmount: 300_000, expenseOrderId: refuse.id },
      select: { id: true },
    });
    const r1 = await updateGrantedBudget(fd({ type: "NATIONAL", id: c1.id, finalAmount: "350000" }));
    expect(r1.ok, r1.ok ? "" : r1.error).toBe(true);
    expect(r1.ok ? r1.message : "").toMatch(/refusé par le centre de paiement : il ne suit pas ce montant/);
    const o1 = await prisma.expenseOrder.findUnique({ where: { id: refuse.id }, select: { amount: true, centralStatus: true } });
    expect(Number(o1?.amount), "le chiffre refusé n'est pas réécrit").toBe(300_000);
    expect(o1?.centralStatus).toBe("REFUSED");

    // RÉGLÉ : l'argent est parti au montant d'avant.
    const regle = await createExpenseOrder({ label: `${TAG}congrès réglé`, amount: 200_000, category: "EVENEMENT", requestedById: dirId });
    await prisma.expenseOrder.update({ where: { id: regle.id }, data: { status: "PAID", centralStatus: "APPROVED" } });
    const c2 = await prisma.congressNational.create({
      data: { name: `${TAG}Congrès réglé`, requestStatus: "APPROVED" as never, finalAmount: 200_000, expenseOrderId: regle.id },
      select: { id: true },
    });
    // Sa déclaration est VALIDÉE : elle ne bouge plus — le pharmacien a déclaré un montant, on ne le réécrit pas sous lui.
    const decl2 = await prisma.medicalInfoDeclaration.create({
      data: { reference: `${TAG}DIM-2`, sourceType: "CONGRESS_NATIONAL", sourceId: c2.id, label: `${TAG}Congrès réglé`, amount: 200_000, status: "VALIDATED", expenseOrderId: regle.id },
      select: { id: true },
    });
    const r2 = await updateGrantedBudget(fd({ type: "NATIONAL", id: c2.id, finalAmount: "250000" }));
    expect(r2.ok, r2.ok ? "" : r2.error).toBe(true);
    expect(r2.ok ? r2.message : "").toMatch(/déjà réglé : il ne suit pas ce montant/);
    const o2 = await prisma.expenseOrder.findUnique({ where: { id: regle.id }, select: { amount: true } });
    expect(Number(o2?.amount)).toBe(200_000);
    expect(Number((await prisma.medicalInfoDeclaration.findUnique({ where: { id: decl2.id }, select: { amount: true } }))?.amount), "une déclaration validée ne se réécrit pas").toBe(200_000);
    // TÉMOIN : le budget, lui, a bien changé — la phrase ne remplace pas l'écriture.
    const congresApres = await prisma.congressNational.findUnique({ where: { id: c2.id }, select: { finalAmount: true } });
    expect(Number(congresApres?.finalAmount)).toBe(250_000);
  }, 60_000);

  // ── 3. LA RALLONGE DE CAISSE S'ÉCRIT AU LIVRE ────────────────────────────────────────────────
  it("`decidePettyCashTopUp` : une rallonge accordée part au CENTRE (une remise et son ordre en attente), rien au livre ; une seule fois ; refusée, rien", async () => {
    ACTEUR = sa;
    const dept = await prisma.department.create({ data: { name: `${TAG}Moyens généraux`, code: `${TAG}MG` }, select: { id: true } });
    const caisse = await prisma.pettyCashAllotment.create({
      data: { departmentId: dept.id, period: "2026-09", amount: 50_000, holderId: autreId, note: `${TAG}caisse` },
      select: { id: true },
    });
    const [accordee, refusee] = await Promise.all([
      prisma.pettyCashTopUpRequest.create({ data: { allotmentId: caisse.id, amountRequested: 20_000, reason: `${TAG}rallonge`, requestedById: autreId }, select: { id: true } }),
      prisma.pettyCashTopUpRequest.create({ data: { allotmentId: caisse.id, amountRequested: 5_000, reason: `${TAG}rallonge refusée`, requestedById: autreId }, select: { id: true } }),
    ]);
    const livreAvant = await prisma.financeTransaction.count({ where: { createdById: saId } });

    const r = await decidePettyCashTopUp(fd({ id: accordee.id, decision: "APPROVED", amountGranted: "15000" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(await prisma.financeTransaction.count({ where: { createdById: saId } }), "rien au livre avant le versement").toBe(livreAvant);
    expect(Number((await prisma.pettyCashAllotment.findUnique({ where: { id: caisse.id }, select: { amount: true } }))?.amount), "le fond d'origine n'est pas gonflé avant le versement").toBe(50_000);
    const remises = await prisma.pettyCashAllotment.findMany({ where: { departmentId: dept.id, id: { not: caisse.id } }, select: { amount: true, holderId: true, expenseOrderId: true } });
    expect(remises).toHaveLength(1);
    expect(Number(remises[0]!.amount)).toBe(15_000);
    expect(remises[0]!.holderId).toBe(autreId);
    const ordre = await prisma.expenseOrder.findUnique({ where: { id: remises[0]!.expenseOrderId! }, select: { centralStatus: true, amount: true, label: true } });
    expect(ordre?.centralStatus, "l'ordre attend le centre").toBe("AWAITING");
    expect(Number(ordre?.amount)).toBe(15_000);
    expect(ordre?.label).toContain("Rallonge");

    // UNE SEULE FOIS : le même accord rejoué ne crée ni seconde remise ni second ordre.
    expect((await decidePettyCashTopUp(fd({ id: accordee.id, decision: "APPROVED", amountGranted: "15000" }))).ok).toBe(false);
    expect(await prisma.pettyCashAllotment.count({ where: { departmentId: dept.id } })).toBe(2);

    // TÉMOIN : une rallonge REFUSÉE ne crée rien.
    const non = await decidePettyCashTopUp(fd({ id: refusee.id, decision: "REJECTED" }));
    expect(non.ok, non.ok ? "" : non.error).toBe(true);
    expect(await prisma.pettyCashAllotment.count({ where: { departmentId: dept.id } })).toBe(2);
    expect(await prisma.financeTransaction.count({ where: { createdById: saId } })).toBe(livreAvant);
    await prisma.expenseOrder.delete({ where: { id: remises[0]!.expenseOrderId! } }).catch(() => undefined);
  }, 60_000);

  it("`decidePettyCashTopUp` : deux accords SIMULTANÉS n'envoient qu'une rallonge au centre (course forcée)", async () => {
    ACTEUR = sa;
    const dept = await prisma.department.create({ data: { name: `${TAG}MG course`, code: `${TAG}MGC` }, select: { id: true } });
    const caisse = await prisma.pettyCashAllotment.create({ data: { departmentId: dept.id, period: "2026-09", amount: 10_000, holderId: autreId }, select: { id: true } });
    const dem = await prisma.pettyCashTopUpRequest.create({ data: { allotmentId: caisse.id, amountRequested: 7_000, reason: `${TAG}course`, requestedById: autreId }, select: { id: true } });
    // Le banc tient la ligne de la demande : les deux accords LISENT « en attente » (une lecture
    // ne se bloque pas), puis attendent tous deux à l'écriture ; relâchés, un seul doit passer.
    let liberer!: () => void; const libere = new Promise<void>((r) => { liberer = r; });
    let signaler!: (pid: number) => void; const acquis = new Promise<number>((r) => { signaler = r; });
    const tenu = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT 1 FROM "PettyCashTopUpRequest" WHERE id = $1 FOR UPDATE`, dem.id);
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      signaler(pid); await libere;
    }, { timeout: 120_000, maxWait: 30_000 });
    const pid = await acquis;
    const gestes = [1, 2].map(() => decidePettyCashTopUp(fd({ id: dem.id, decision: "APPROVED", amountGranted: "7000" })));
    const debut = Date.now();
    for (;;) {
      // Le second accord attend derrière le PREMIER (verrou de tuple), pas derrière le banc : on
      // compte toute la chaîne d'attente qui remonte au banc.
      const r = await prisma.$queryRaw<{ n: number }[]>`
        WITH RECURSIVE chaine(pid) AS (
          SELECT ${pid}::int4
          UNION SELECT a.pid FROM pg_stat_activity a, chaine c WHERE c.pid = ANY(pg_blocking_pids(a.pid))
        ) SELECT (count(*) - 1)::int AS n FROM chaine`;
      if ((r[0]?.n ?? 0) >= 2) break;
      if (Date.now() - debut > 60_000) throw new Error("barrière non atteinte : les deux accords ne se sont pas bloqués");
      await new Promise((ok) => setTimeout(ok, 25));
    }
    liberer(); await tenu;
    const res = await Promise.all(gestes);
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    const remises = await prisma.pettyCashAllotment.findMany({ where: { departmentId: dept.id, id: { not: caisse.id } }, select: { expenseOrderId: true } });
    expect(remises, "une seule rallonge part au centre").toHaveLength(1);
    await prisma.expenseOrder.deleteMany({ where: { id: { in: remises.map((x) => x.expenseOrderId!).filter(Boolean) } } }).catch(() => undefined);
  }, 120_000);

  // ── 4. LE CHANTIER « PAIEMENT » NE SE CLÔT QUE SUR UN PAIEMENT RÉGLÉ ─────────────────────────
  it("`completePromoTrack(PAYMENT)` : refusé sans règlement, refusé tant que l'ordre attend le centre, clos une fois payé", async () => {
    ACTEUR = sa;
    const dossier = await prisma.promoMaterial.create({
      data: { reference: `${TAG}MP-1`, title: `${TAG}Kakémonos`, requesterId: saId, circuitState: "IN_EXECUTION" },
      select: { id: true },
    });
    const clore = () => completePromoTrack(fd({ id: dossier.id, track: "PAYMENT" }));

    const sansRien = await clore();
    expect(sansRien.ok).toBe(false);
    expect(sansRien.ok ? "" : sansRien.error).toMatch(/Aucun règlement n'est rattaché/);

    const ordre = await createExpenseOrder({ label: `${TAG}kakémonos`, amount: 90_000, category: "AUTRE", sourceType: "PROMO_MATERIAL", sourceId: dossier.id, requestedById: autreId });
    const enAttente = await clore();
    expect(enAttente.ok).toBe(false);
    expect(enAttente.ok ? "" : enAttente.error).toContain(ordre.reference);
    expect(enAttente.ok ? "" : enAttente.error).toMatch(/en attente du centre de paiement/);

    const autorise = await decidePayment(fd({ id: ordre.id, decision: "APPROVE" }));
    expect(autorise.ok, autorise.ok ? "" : autorise.error).toBe(true);
    const autoriseSeul = await clore();
    expect(autoriseSeul.ok, "autorisé n'est pas payé").toBe(false);
    expect(autoriseSeul.ok ? "" : autoriseSeul.error).toMatch(/à régler par les Finances/);

    // Le règlement lui-même exige facture et budget (`settleExpenseOrder`, couvert ailleurs) :
    // ici l'état PAYÉ est posé directement, parce que ce cas juge la LECTURE du chantier.
    await prisma.expenseOrder.update({ where: { id: ordre.id }, data: { status: "PAID", paidDate: new Date() } });
    const clos = await clore();
    expect(clos.ok, clos.ok ? "" : clos.error).toBe(true);
    const lu = await prisma.promoMaterial.findUnique({ where: { id: dossier.id }, select: { tracksDone: true } });
    expect(lu?.tracksDone ?? "").toContain("PAYMENT");
  }, 60_000);

  // ── 5. ADAM NE TROUVE PAS UN DOCUMENT QU'IL N'A PAS LE DROIT DE LIRE ─────────────────────────
  it("l'op Legal ne résout pas une pièce RESTREINTE pour qui n'en est pas lecteur — sans même nommer son titre", async () => {
    const restreint = await prisma.legalDocument.create({
      data: { title: `${TAG}BC confidentiel Hetero`, reference: `${TAG}BC-SECRET`, kind: "PURCHASE_ORDER", createdById: saId, readers: { create: [{ userId: autreId }] } },
      select: { id: true },
    });
    const op = DOMAIN_TOOLS.legal_operation.ops.submit_purchase_order;
    expect(op, "legal_operation/submit_purchase_order absente du registre de production").toBeDefined();

    ACTEUR = dir;
    const refus = await op.impl.propose({ reference: `${TAG}BC-SECRET` }, dir as never);
    expect("error" in refus ? refus.error : "", "la pièce restreinte a été résolue pour un non-lecteur").toMatch(/Aucun document légal/);
    expect(JSON.stringify(refus)).not.toContain("confidentiel");

    // TÉMOIN : le Super Admin, lui, la voit — c'est la PORTÉE qui a refusé, pas la recherche.
    ACTEUR = sa;
    const vu = await op.impl.propose({ reference: `${TAG}BC-SECRET` }, sa as never);
    expect("error" in vu ? vu.error : "", "le Super Admin doit la trouver").toBe("");
    await prisma.legalDocumentReader.deleteMany({ where: { documentId: restreint.id } });
  }, 60_000);

  // ── 6. « ADRESSE LE BC AU CENTRE » DEPUIS LA CONVERSATION ────────────────────────────────────
  it("l'op `submit_purchase_order` : la carte nomme le BC, `execute` pose la porte, un second envoi ne renvoie rien", async () => {
    ACTEUR = sa;
    const bc = await prisma.legalDocument.create({
      data: { title: `${TAG}BC traiteur`, reference: `${TAG}BC-T1`, kind: "PURCHASE_ORDER", amount: 150_000, createdById: saId },
      select: { id: true },
    });
    expect(await porteDuBC(bc.id), "un BC d'avant la règle n'a pas de porte").toBeNull();
    const op = DOMAIN_TOOLS.legal_operation.ops.submit_purchase_order.impl;

    const carte = await op.propose({ reference: `${TAG}BC-T1` }, sa as never);
    expect("error" in carte ? carte.error : "").toBe("");
    if ("error" in carte) return;
    expect(carte.fields.map((f) => f.value).join(" ")).toContain(`${TAG}BC traiteur`);

    const r = await op.execute(carte.args, sa as never);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const porte = await porteDuBC(bc.id);
    expect(porte?.centre, "un BC sans origine Ad & Pro va au centre de validations").toBe("VALIDATION");
    expect(porte?.etat).toBe("EN_ATTENTE");

    const encore = await op.execute(carte.args, sa as never);
    expect(encore.ok).toBe(true);
    expect(encore.ok ? encore.message ?? "" : "").toMatch(/déjà au centre de validations/);
    expect(
      await prisma.validationRequest.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: bc.id, status: "PENDING" } }),
      "une seule porte, jamais deux",
    ).toBe(1);

    // Un BC ANNULÉ n'a plus rien à faire valider : la carte le dit AVANT le clic.
    await prisma.legalDocument.update({ where: { id: bc.id }, data: { status: "CANCELLED" } });
    const annule = await op.propose({ reference: `${TAG}BC-T1` }, sa as never);
    expect("error" in annule ? annule.error : "").toMatch(/annulé/);
  }, 60_000);
});
