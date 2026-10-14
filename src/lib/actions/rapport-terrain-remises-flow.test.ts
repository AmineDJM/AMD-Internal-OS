import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, requireModule: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { createFieldReport, deleteFieldReport, reopenFieldReport, submitFieldReport } from "./field-report-actions";
import { entrerLot, sousVerrou, trouverOuCreerArticle } from "@/lib/promo/stock-ecriture";
import { remisesDuRapport } from "@/lib/queries/promo-remises";
import { DELETE_REGISTRY } from "@/lib/admin-delete-registry";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__rtremises__";

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: u.secondaryRole as SessionUser["role"] | null, access, mustChangePassword: false } as CurrentUser;
}

const form = (fields: Record<string, string | string[]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const x of v) fd.append(k, x);
    else fd.set(k, v);
  }
  return fd;
};

const AUJOURDHUI = new Date().toISOString().slice(0, 10);

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MATÉRIEL REMIS DANS UN COMPTE RENDU DE VISITE (rapport terrain, §118.204) — la QUATRIÈME porte
 * d'une visite faite, par la VRAIE action d'envoi (`submitFieldReport`) et le MÊME module que les
 * trois autres (`remises-visite.ts`). Un délégué SANS vue globale (§118.104).
 *
 *   kam   délégué : il tient le stock, il écrit ses comptes rendus
 *   sup   Manager Promotion médicale : il gère les rapports — et n'a AUCUN stock
 *   dm    Direction Marketing : l'auteur du décor du stock
 *
 * Le stock est posé par l'écrivain (`entrerLot`) : 20 fiches valides en main du KAM.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Compte rendu de visite — le matériel remis sort du stock du KAM, par le module des remises", () => {
  const ids: Record<string, string> = {};
  let doc1 = "", doc2 = "", fiche = "";

  beforeAll(async () => {
    await nettoyer();
    const faire = (nom: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, role: role as never, passwordHash: "x" } });
    const [kam, sup, dm] = await Promise.all([faire("kam", "MEDICAL_DELEGATE"), faire("sup", "MEDICAL_PROMOTION_MANAGER"), faire("dm", "PRODUCT_MANAGER")]);
    Object.assign(ids, { kam: kam.id, sup: sup.id, dm: dm.id });
    const docs = await Promise.all(["Achour", "Benali"].map((n) =>
      prisma.medicalDoctor.create({ data: { name: `${TAG}Dr ${n}`, delegateId: kam.id, wilaya: "Alger" }, select: { id: true } })));
    [doc1, doc2] = docs.map((d) => d.id) as [string, string];
    const cat = await prisma.promoCatalogueArticle.create({ data: { reference: `${TAG}C1`, nom: `${TAG}Fiche posologique`, famille: "CONSOMMABLE" as never }, select: { id: true } });
    fiche = (await trouverOuCreerArticle({ companyId: null, catalogueId: cat.id, produitIds: [], nom: `${TAG}Fiche`, unite: "pièce", materialType: null, auteurId: dm.id })).id;
    const r = await sousVerrou(fiche, (tx) => entrerLot(tx, fiche, {
      holderId: kam.id, quantite: 20, kind: "OPENING", origine: "OUVERTURE", valableJusquau: new Date("2030-12-31"), auteurId: dm.id,
    }));
    if ("refus" in r) throw new Error(r.refus);
  });

  afterAll(async () => { await nettoyer(); });

  async function nettoyer() {
    const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    const uids = users.map((u) => u.id);
    const cat = await prisma.promoCatalogueArticle.findMany({ where: { nom: { startsWith: TAG } }, select: { id: true } });
    // L'article d'abord : il emporte ses mouvements, sans quoi un rapport qui porte une remise est
    // retenu (SetNull, mais le banc veut une base propre).
    if (cat.length) await prisma.promoStockItem.deleteMany({ where: { catalogueId: { in: cat.map((c) => c.id) } } });
    await prisma.promoCatalogueArticle.deleteMany({ where: { nom: { startsWith: TAG } } });
    if (uids.length) {
      await prisma.medicalVisit.deleteMany({ where: { delegateId: { in: uids } } });
      await prisma.fieldReport.deleteMany({ where: { delegateId: { in: uids } } });
    }
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } });
    if (uids.length) {
      await prisma.notification.deleteMany({ where: { userId: { in: uids } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: uids } } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: { in: uids } } });
  }

  const comme = async (qui: string) => { ACTOR = await actorFor(ids[qui]!); };
  const solde = async (holderId: string) => {
    const r = await prisma.promoStockMovement.aggregate({ where: { itemId: fiche, holderId }, _sum: { delta: true } });
    return Number(r._sum.delta ?? 0);
  };
  const nouveauRapport = async (): Promise<string> => {
    await comme("kam");
    const r = await createFieldReport();
    if (!r.ok || !r.id) throw new Error(r.ok ? "pas d'identifiant" : r.error);
    return r.id;
  };
  const envoyer = (id: string, extra: Record<string, string | string[]>) =>
    submitFieldReport(form({ id, summary: "Visite faite, intérêt pour la posologie.", visitDate: AUJOURDHUI, ...extra }));

  let rapport1 = "";

  it("PRÉMISSE : le KAM tient 20 fiches, le superviseur aucune", async () => {
    expect(await solde(ids.kam!)).toBe(20);
    expect(await solde(ids.sup!)).toBe(0);
  });

  it("1. la remise déclarée sort du stock du KAM, porte le rapport ET le médecin de l'annuaire", async () => {
    rapport1 = await nouveauRapport();
    const r = await envoyer(rapport1, { doctorIds: doc1, materielItemId: [fiche], materielQuantite: ["5"] });
    expect(r).toEqual({ ok: true });
    expect(await solde(ids.kam!)).toBe(15);
    const ms = await prisma.promoStockMovement.findMany({ where: { fieldReportId: rapport1 }, select: { kind: true, doctorId: true, holderId: true, visitId: true } });
    expect(ms).toEqual([{ kind: "DISTRIBUTION", doctorId: doc1, holderId: ids.kam, visitId: null }]);
    expect((await prisma.fieldReport.findUniqueOrThrow({ where: { id: rapport1 } })).status).toBe("VALIDATED");
  });

  it("2. au-delà du solde : REFUSÉ, et rien n'est écrit — ni le compte rendu, ni la remise", async () => {
    const id = await nouveauRapport();
    const r = await envoyer(id, { doctorIds: doc1, materielItemId: [fiche], materielQuantite: ["50"] });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/votre stock ne le permet pas/);
    expect(await solde(ids.kam!)).toBe(15);
    expect(await prisma.promoStockMovement.count({ where: { fieldReportId: id } })).toBe(0);
    const rap = await prisma.fieldReport.findUniqueOrThrow({ where: { id } });
    expect(rap.status, "le compte rendu refusé ne passe pas « envoyé »").toBe("DRAFT");
    expect(rap.summary).toBeNull();
  });

  it("3. corriger 5 en 2 rend 3 au KAM ; renvoyer à l'identique n'écrit RIEN", async () => {
    await comme("kam");
    await reopenFieldReport(form({ id: rapport1 }));
    const r = await envoyer(rapport1, { doctorIds: doc1, materielItemId: [fiche], materielQuantite: ["2"] });
    expect(r).toEqual({ ok: true });
    expect(await solde(ids.kam!)).toBe(18);
    expect((await remisesDuRapport(rapport1)).materiel.map((m) => m.quantite)).toEqual([2]);
    const avant = await prisma.promoStockMovement.count({ where: { fieldReportId: rapport1 } });
    expect(await envoyer(rapport1, { doctorIds: doc1, materielItemId: [fiche], materielQuantite: ["2"] })).toEqual({ ok: true });
    expect(await prisma.promoStockMovement.count({ where: { fieldReportId: rapport1 } })).toBe(avant);
  });

  it("4. le superviseur qui envoie le compte rendu du KAM vide la voiture du KAM, pas la sienne", async () => {
    const id = await nouveauRapport();
    await comme("sup");
    const r = await envoyer(id, { doctorIds: doc1, materielItemId: [fiche], materielQuantite: ["3"] });
    expect(r).toEqual({ ok: true });
    expect(await solde(ids.kam!)).toBe(15);
    expect(await solde(ids.sup!)).toBe(0);
  });

  it("5. un médecin HORS annuaire : refus NOMMÉ, stock intact", async () => {
    const id = await nouveauRapport();
    const r = await envoyer(id, { doctorName: "Dr Karim Inconnu", materielItemId: [fiche], materielQuantite: ["1"] });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/« Dr Karim Inconnu » n'y est pas/);
    expect(await solde(ids.kam!)).toBe(15);
    // Sans matériel, le même compte rendu part : la règle ne porte que sur la remise.
    expect(await envoyer(id, { doctorName: "Dr Karim Inconnu" })).toEqual({ ok: true });
  });

  it("6. plusieurs médecins : la remise reste au compte rendu, sans médecin choisi à la place du KAM", async () => {
    const id = await nouveauRapport();
    expect(await envoyer(id, { doctorIds: `${doc1},${doc2}`, materielItemId: [fiche], materielQuantite: ["1"] })).toEqual({ ok: true });
    const ms = await prisma.promoStockMovement.findMany({ where: { fieldReportId: id }, select: { doctorId: true, reason: true } });
    expect(ms).toHaveLength(1);
    expect(ms[0]!.doctorId).toBeNull();
    expect(ms[0]!.reason).toMatch(/Dr Achour.*Dr Benali/);
    expect(await solde(ids.kam!)).toBe(14);
  });

  it("7. un compte rendu RATTACHÉ à une visite renvoie le matériel au rapport de la visite", async () => {
    const id = await nouveauRapport();
    const v = await prisma.medicalVisit.create({ data: { date: new Date(), doctorId: doc1, delegateId: ids.kam!, status: "COMPLETED" }, select: { id: true } });
    await prisma.fieldReport.update({ where: { id }, data: { visitId: v.id } });
    const r = await envoyer(id, { doctorIds: doc1, materielItemId: [fiche], materielQuantite: ["1"] });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/Ma journée/);
    expect(await solde(ids.kam!)).toBe(14);
    expect(await envoyer(id, { doctorIds: doc1 })).toEqual({ ok: true });
  });

  it("8. la fenêtre de 48 h : un matériel qui CHANGE est refusé hors délai ; un renvoi qui ne le change pas passe", async () => {
    await comme("kam");
    await reopenFieldReport(form({ id: rapport1 }));
    const vieux = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    const change = await submitFieldReport(form({ id: rapport1, summary: "Corrigé.", visitDate: vieux, doctorIds: doc1, materielItemId: [fiche], materielQuantite: ["4"] }));
    expect(change.ok).toBe(false);
    expect(change.ok ? "" : change.error).toMatch(/dans les 48 h/);
    expect(await solde(ids.kam!)).toBe(14);
    const identique = await submitFieldReport(form({ id: rapport1, summary: "Corrigé.", visitDate: vieux, doctorIds: doc1, materielItemId: [fiche], materielQuantite: ["2"] }));
    expect(identique).toEqual({ ok: true });
  });

  it("9. un compte rendu qui porte des remises ne se supprime pas — ni par l'action, ni par la corbeille", async () => {
    await comme("kam");
    const r = await deleteFieldReport(form({ id: rapport1 }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/porte du matériel remis/);
    expect(await prisma.fieldReport.count({ where: { id: rapport1 } })).toBe(1);
    expect(await DELETE_REGISTRY.FIELD_REPORT.refuse!(rapport1)).toMatch(/porte du matériel remis/);
    // Le témoin : un compte rendu SANS remise se supprime toujours.
    const libre = await nouveauRapport();
    expect(await DELETE_REGISTRY.FIELD_REPORT.refuse!(libre)).toBeNull();
    expect(await deleteFieldReport(form({ id: libre }))).toMatchObject({ ok: true });
  });
});
