import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode } & Record<string, unknown>) =>
    React.createElement("a", { href, ...rest }, children),
}));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { loadLegalChain, MAILLON_HORS_PERIMETRE, AMONT_HORS_PERIMETRE } from "./legal-chain";
import { LegalChainCard } from "@/app/(app)/legal/[id]/chain-card";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__chainelecture__";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CHAÎNE D'UNE PIÈCE NE MONTRE QUE CE QUE LA PERSONNE PEUT LIRE (vague « restes »).
 *
 * `loadLegalChain` rendait le titre, la référence, le montant et les validateurs de chaque maillon sans relire
 * le droit de le lire : sur la fiche d'un bon de commande, les Finances — qui ne lisent pas les devis — lisaient
 * le devis ; une facture restreinte à ses lecteurs désignés exposait ses chiffres et son règlement sur la fiche
 * de la pièce voisine. Joué par le VRAI chargeur de l'écran, puis par la VRAIE carte, avec des acteurs SANS vue
 * globale (§118.104) et leurs prémisses vérifiées ; le témoin inverse (une lectrice Legal désignée voit tout)
 * empêche une garde qui refuserait tout de passer pour armée (§118.17).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("la chaîne d'une pièce Legal — un maillon illisible garde sa place, sans rien de ce qu'il porte", () => {
  const u: Record<string, string> = {};
  const roles: Record<string, SessionUser["role"]> = { fin: "FINANCE_BUDGET_MANAGER", asst: "DIRECTION_ASSISTANT", dep: "MEDICAL_DELEGATE" };
  const doc: Record<string, string> = {};
  let ordre = "";
  let promo = "";
  const acteur = async (k: string): Promise<SessionUser> =>
    ({ id: u[k]!, role: roles[k]!, secondaryRole: null, access: await getAccess(u[k]!, roles[k]!) }) as unknown as SessionUser;

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((x) => x.id);
    await prisma.validationRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    const pieces = (await prisma.legalDocument.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } })).map((x) => x.id);
    await prisma.legalDocument.updateMany({ where: { id: { in: pieces } }, data: { chainFromId: null, expenseOrderId: null } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: pieces } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.promoMaterial.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: comptes } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    for (const [k, role] of Object.entries(roles)) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    }
    const piece = (k: string, data: Record<string, unknown>) => prisma.legalDocument.create({
      data: { reference: `${TAG}${k}`, counterparty: "Imprimerie du Port", status: "ACTIVE", createdById: u.dep!, ...data } as never,
      select: { id: true },
    });
    // La chaîne d'achat : un devis → un bon de commande → une facture RESTREINTE à sa lectrice désignée, réglée au centre.
    doc.devis = (await piece("DV-1", { kind: "QUOTE", title: `${TAG} devis confidentiel`, amount: 90_000, startDate: new Date("2026-09-01") })).id;
    doc.bc = (await piece("BC-1", { kind: "PURCHASE_ORDER", title: `${TAG} bon de commande`, amount: 100_000, startDate: new Date("2026-09-12"), chainFromId: doc.devis })).id;
    ordre = (await prisma.expenseOrder.create({ data: { reference: `${TAG}OD-1`, label: `${TAG} règlement`, amount: 118_000, centralStatus: "AWAITING" } })).id;
    doc.facture = (await piece("FA-1", {
      kind: "INVOICE", title: `${TAG} facture restreinte`, amount: 118_000, startDate: new Date("2026-09-20"), chainFromId: doc.bc,
      expenseOrderId: ordre, readers: { create: [{ userId: u.asst! }] },
    })).id;
    // Le devis porte sa validation : qui l'a signé ne se dit pas à qui ne lit pas le devis.
    await prisma.validationRequest.create({
      data: {
        reference: `${TAG}VQ`, module: "Legal", title: `${TAG} avis sur le devis`, requesterId: u.dep!,
        entityType: "LEGAL_DOCUMENT", entityId: doc.devis, steps: { create: [{ order: 1, validatorId: u.dep!, status: "APPROVED", decidedAt: new Date() }] },
      },
    });
    // Une seconde chaîne : un devis né d'un dossier de matériel promotionnel dont la personne des Finances est la
    // DEMANDEUSE — elle le lit par exception (§118.152), sa fiche Legal reste fermée.
    promo = (await prisma.promoMaterial.create({ data: { reference: `${TAG}MP-1`, title: `${TAG} kakémonos`, requesterId: u.fin! } })).id;
    doc.devisPromo = (await piece("DV-2", { kind: "QUOTE", title: `${TAG} devis du kakémono`, amount: 30_000, sourceType: "PROMO_MATERIAL", sourceId: promo })).id;
    doc.bcPromo = (await piece("BC-2", { kind: "PURCHASE_ORDER", title: `${TAG} bon du kakémono`, amount: 30_000, chainFromId: doc.devisPromo })).id;
  });
  afterAll(async () => { await nettoyer(); });

  it("PRÉMISSES : les Finances lisent bons et factures, pas les devis ni Legal ; l'assistante lit Legal ; aucune vue globale", async () => {
    const fin = await acteur("fin");
    expect(hasGlobalView(fin.role)).toBe(false);
    expect(userCan(fin, "LEGAL", "VIEW")).toBe(false);
    expect(userCan(fin, "FINANCES", "VIEW")).toBe(true);
    const asst = await acteur("asst");
    expect(hasGlobalView(asst.role)).toBe(false);
    expect(userCan(asst, "LEGAL", "VIEW")).toBe(true);
    // Les deux libellés neutres viennent du MÊME fragment : ils ne diront jamais deux choses différentes.
    expect(MAILLON_HORS_PERIMETRE).toBe("Pièce hors de votre périmètre");
    expect(AMONT_HORS_PERIMETRE).toBe("Pièce amont actuelle (hors de votre périmètre)");
  });

  it("LES FINANCES, sur la fiche du BC : le devis et la facture restreinte gardent leur place et leur nature, rien d'autre", async () => {
    const r = await loadLegalChain(doc.bc!, await acteur("fin"));
    expect(r.links.map((l) => l.kind), "la chaîne garde ses trois maillons — sinon elle dirait « Manque encore : Devis »").toEqual(["QUOTE", "PURCHASE_ORDER", "INVOICE"]);
    const [devis, bc, facture] = r.links;
    for (const l of [devis!, facture!]) {
      expect(l).toMatchObject({ lisible: false, ouvrable: false, title: MAILLON_HORS_PERIMETRE, reference: null, amount: null, date: null, validators: [] });
    }
    expect(bc).toMatchObject({ lisible: true, ouvrable: true, isCurrent: true, title: `${TAG} bon de commande`, amount: 100_000 });
    expect(r.settlement, "le règlement d'une facture qu'on ne lit pas dirait son montant").toBeNull();
    const tout = JSON.stringify(r);
    for (const fuite of ["devis confidentiel", "facture restreinte", `${TAG}DV-1`, `${TAG}FA-1`, `${TAG}dep`]) {
      expect(tout, `« ${fuite} » ne doit pas sortir du chargeur`).not.toContain(fuite);
    }
  });

  it("TÉMOIN INVERSE : la lectrice Legal désignée lit toute la chaîne, ses validateurs et son règlement", async () => {
    const r = await loadLegalChain(doc.bc!, await acteur("asst"));
    expect(r.links.every((l) => l.lisible && l.ouvrable)).toBe(true);
    expect(r.links.map((l) => l.title)).toEqual([`${TAG} devis confidentiel`, `${TAG} bon de commande`, `${TAG} facture restreinte`]);
    expect(r.links[0]!.validators.map((v) => v.name)).toEqual([`${TAG}dep`]);
    expect(r.links[0]!.amount).toBe(90_000);
    expect(r.settlement).toMatchObject({ id: ordre, amount: 118_000 });
  });

  it("UNE EXCEPTION DE LECTURE ouvre le titre, pas la fiche : le devis du dossier promotionnel se lit SANS lien", async () => {
    const r = await loadLegalChain(doc.bcPromo!, await acteur("fin"));
    expect(r.links[0]).toMatchObject({ id: doc.devisPromo, lisible: true, ouvrable: false, title: `${TAG} devis du kakémono`, amount: 30_000 });
  });

  it("LA CARTE rend ce que le chargeur décide : libellé neutre sans lien, titre d'exception sans lien, aucune fuite", async () => {
    const fin = await acteur("fin");
    const c1 = await loadLegalChain(doc.bc!, fin);
    const html1 = renderToStaticMarkup(React.createElement(LegalChainCard, { links: c1.links, settlement: c1.settlement, canSettle: false }));
    expect(html1).toContain(MAILLON_HORS_PERIMETRE);
    expect(html1).not.toContain(`/legal/${doc.devis}`);
    expect(html1).not.toContain(`/legal/${doc.facture}`);
    expect(html1).not.toContain("devis confidentiel");
    expect(html1, "l'écart devis → facture dirait le montant du devis").not.toContain("Écart devis");
    const c2 = await loadLegalChain(doc.bcPromo!, fin);
    const html2 = renderToStaticMarkup(React.createElement(LegalChainCard, { links: c2.links, settlement: c2.settlement, canSettle: false }));
    expect(html2).toContain(`${TAG} devis du kakémono`);
    expect(html2, "un titre qui mène à une fiche refusée est un geste offert puis retiré").not.toContain(`/legal/${doc.devisPromo}`);
    // Et le maillon lisible par la fiche garde son lien, sinon la règle aurait simplement tout éteint.
    const c3 = await loadLegalChain(doc.devis!, await acteur("asst"));
    const html3 = renderToStaticMarkup(React.createElement(LegalChainCard, { links: c3.links, settlement: c3.settlement, canSettle: false }));
    expect(html3).toContain(`href="/legal/${doc.bc}"`);
  });
});
