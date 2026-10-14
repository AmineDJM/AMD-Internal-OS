import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, requireModule: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, moduleScope, userCan, type SessionUser } from "@/lib/rbac";
import { rapporterVisite, ajouterVisiteImprevue } from "./tour-visit-actions";
import { logVisit } from "./medical-actions";
import { annulerMouvement } from "./promo-stock-actions";
import { createPromoMessage } from "./promo-message-actions";
import { entrerLot, sousVerrou, trouverOuCreerArticle } from "@/lib/promo/stock-ecriture";
import { stockPourVisite, remisesDesVisites } from "@/lib/queries/promo-remises";
import { chargerPageStock } from "@/lib/queries/promo-stock";
import { DELETE_REGISTRY } from "@/lib/admin-delete-registry";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__remises__";

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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MATÉRIEL REMIS EN VISITE, DE BOUT EN BOUT (§118.166) — par les VRAIES actions du rapport
 * (planifiée, imprévue, saisie rapide), avec un délégué SANS vue globale (§118.104).
 *
 *   kam   délégué : il tient le stock, il rapporte         k2    autre délégué (hors de kam)
 *   dm    directrice de la Direction Marketing (magasin)    ops   Directeur des Opérations (vue globale)
 *   sa    Super Admin (annulation de mouvement, corbeille)
 *
 * Le décor du STOCK est posé par l'écrivain (`entrerLot`) : ce n'est pas l'objet du banc, qui
 * éprouve ce que le RAPPORT fait du stock. Un lot valide de 30 fiches et un lot PÉRIMÉ de 10.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Matériel remis en visite — déduit du stock du délégué, bloqué au-delà, corrigé sans double compte", () => {
  const ids: Record<string, string> = {};
  let produit = "", message = "";
  let doc1 = "", doc2 = "", doc3 = "", doc4 = "";
  let fiche = "", stylo = "", eadv = "", eadvPerime = "", bloc = "", brochure = "";
  let lotValide = "", lotPerime = "";

  beforeAll(async () => {
    await nettoyer();
    const faire = (nom: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, role: role as never, passwordHash: "x" } });
    const [kam, k2, dm, ops, sa] = await Promise.all([
      faire("kam", "MEDICAL_DELEGATE"), faire("k2", "MEDICAL_DELEGATE"), faire("dm", "PRODUCT_MANAGER"),
      faire("ops", "OPERATIONS_DIRECTOR"), faire("sa", "SUPER_ADMIN"),
    ]);
    Object.assign(ids, { kam: kam.id, k2: k2.id, dm: dm.id, ops: ops.id, sa: sa.id });
    await prisma.employee.create({ data: { fullName: `${TAG}dm`, userId: dm.id } });

    const bu = await prisma.businessUnit.create({ data: { name: `${TAG}Oncologie` }, select: { id: true } });
    await prisma.salesRepProfile.create({ data: { repId: kam.id, businessUnitId: bu.id } });
    const canon = await prisma.product.create({
      data: { code: `${TAG}P1`, canonicalName: `${TAG}Nivolex`, dci: `${TAG}nivolumab`, identityKey: `${TAG}nivo` } as never,
      select: { id: true },
    });
    produit = canon.id;
    await prisma.promoProduct.create({ data: { name: `${TAG}Nivolex`, businessUnitId: bu.id, productId: canon.id } });
    const docs = await Promise.all(["Achour", "Benali", "Cherif", "Djaout"].map((n) =>
      prisma.medicalDoctor.create({ data: { name: `${TAG}Dr ${n}`, delegateId: kam.id, wilaya: "Alger" }, select: { id: true } })));
    [doc1, doc2, doc3, doc4] = docs.map((d) => d.id) as [string, string, string, string];

    ACTOR = await actorFor(sa.id);
    const m = await createPromoMessage(form({ title: `${TAG}Tolérance hépatique`, businessUnitId: bu.id }));
    message = m.ok ? (m.id ?? "") : "";

    const cat = (ref: string, nom: string, famille: string, exigeProduit = false, actif = true) =>
      prisma.promoCatalogueArticle.create({ data: { reference: `${TAG}${ref}`, nom: `${TAG}${nom}`, famille: famille as never, exigeProduit, actif }, select: { id: true } });
    const [cFiche, cStylo, cEadv, cEadvP, cBloc] = await Promise.all([
      cat("C1", "Fiche posologique", "CONSOMMABLE", true), cat("C2", "Stylo logo", "CONSOMMABLE"),
      cat("C3", "e-ADV", "NUMERIQUE", true), cat("C4", "e-ADV 2024", "NUMERIQUE", true), cat("C5", "Bloc-notes", "CONSOMMABLE"),
    ]);
    const cBrochure = await cat("C6", "Brochure", "CONSOMMABLE");
    const article = async (catalogueId: string, nom: string, produitIds: string[] = []) =>
      (await trouverOuCreerArticle({ companyId: null, catalogueId, produitIds, nom: `${TAG}${nom}`, unite: "pièce", materialType: null, auteurId: dm.id })).id;
    fiche = await article(cFiche.id, "Fiche posologique Nivolex", [produit]);
    stylo = await article(cStylo.id, "Stylo logo");
    eadv = await article(cEadv.id, "e-ADV Nivolex", [produit]);
    eadvPerime = await article(cEadvP.id, "e-ADV 2024 Nivolex", [produit]);
    bloc = await article(cBloc.id, "Bloc-notes");
    brochure = await article(cBrochure.id, "Brochure");
    await prisma.promoStockItem.update({ where: { id: eadv }, data: { lien: "https://exemple.invalid/eadv", valableJusquau: new Date("2030-12-31") } });
    await prisma.promoStockItem.update({ where: { id: eadvPerime }, data: { valableJusquau: new Date("2020-01-01") } });

    // LE STOCK EN MAIN DU DÉLÉGUÉ : 30 fiches valides, 10 fiches PÉRIMÉES, 5 stylos, 15 blocs.
    const entrer = async (itemId: string, quantite: number, valableJusquau: Date | null) => {
      const r = await sousVerrou(itemId, (tx) => entrerLot(tx, itemId, {
        holderId: kam.id, quantite, kind: "OPENING", origine: "OUVERTURE", valableJusquau, auteurId: dm.id,
      }));
      if ("refus" in r) throw new Error(r.refus);
      return r.lotId;
    };
    lotValide = await entrer(fiche, 30, new Date("2030-12-31"));
    lotPerime = await entrer(fiche, 10, new Date("2020-01-01"));
    await entrer(stylo, 5, null);
    await entrer(bloc, 15, null);
    // DEUX LOTS de brochures : une remise de 12 en prend 8 au premier (qui expire le plus tôt) et
    // 4 au second — deux remises en base pour un seul article, ce qu'une correction doit reprendre
    // EN ENTIER (le sabotage qui n'en reprend qu'une est passé au vert tant que le banc n'avait
    // que des remises d'un seul lot).
    await entrer(brochure, 8, new Date("2028-06-30"));
    await entrer(brochure, 8, new Date("2030-06-30"));
  });

  afterAll(async () => {
    await nettoyer();
  });

  async function nettoyer() {
    const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    const uids = users.map((u) => u.id);
    if (uids.length) {
      // Les visites d'abord : elles emportent leurs présentations (Cascade) — sans quoi l'article
      // numérique présenté refuserait de partir (clé étrangère RESTRICT).
      const visites = await prisma.medicalVisit.findMany({ where: { delegateId: { in: uids } }, select: { id: true } });
      await prisma.fieldReport.deleteMany({ where: { visitId: { in: visites.map((v) => v.id) } } });
      await prisma.medicalVisit.deleteMany({ where: { id: { in: visites.map((v) => v.id) } } });
    }
    const cat = await prisma.promoCatalogueArticle.findMany({ where: { nom: { startsWith: TAG } }, select: { id: true } });
    if (cat.length) await prisma.promoStockItem.deleteMany({ where: { catalogueId: { in: cat.map((c) => c.id) } } });
    await prisma.promoCatalogueArticle.deleteMany({ where: { nom: { startsWith: TAG } } });
    await prisma.promoMessage.deleteMany({ where: { title: { startsWith: TAG } } });
    await prisma.promoProduct.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.product.deleteMany({ where: { code: { startsWith: TAG } } });
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } });
    if (uids.length) await prisma.salesRepProfile.deleteMany({ where: { repId: { in: uids } } });
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } });
    if (uids.length) {
      await prisma.notification.deleteMany({ where: { userId: { in: uids } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: uids } } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: { in: uids } } });
  }

  const comme = async (qui: string) => { ACTOR = await actorFor(ids[qui]!); };
  const solde = async (itemId: string, lotId?: string) => {
    const r = await prisma.promoStockMovement.aggregate({ where: { itemId, holderId: ids.kam!, ...(lotId ? { lotId } : {}) }, _sum: { delta: true } });
    return Number(r._sum.delta ?? 0);
  };
  const visitePlanifiee = async (doctorId: string) =>
    (await prisma.medicalVisit.create({
      data: { date: new Date(Date.now() - 3_600_000), doctorId, delegateId: ids.kam!, status: "PLANNED", origin: "PLAN" },
      select: { id: true },
    })).id;
  const rapport = (visitId: string, materiel: Record<string, string>, extra: Record<string, string | string[]> = {}) => form({
    visitId, report: "Bon accueil, veut l'étude.", productId: [produit], messageId: [message],
    materielItemId: Object.keys(materiel), materielQuantite: Object.values(materiel), ...extra,
  });
  const mouvementsDe = (visitId: string) =>
    prisma.promoStockMovement.findMany({ where: { visitId }, select: { id: true, itemId: true, kind: true, delta: true, annuleId: true, doctorId: true, holderId: true, lotId: true } });

  /**
   * FORCER UN ENTRELACEMENT (§118.65, §118.164e). Deux rapports lancés « en même temps » sans
   * barrière se succèdent parfois, et le banc passerait au vert sans le verrou qu'il prétend
   * éprouver. La barrière bloque les ÉCRITURES du registre sans bloquer ses lectures, attend que
   * les deux rapports soient bloqués sur le stock, puis relâche.
   */
  async function sousBarriere<T>(lancer: () => Promise<T>[], attendus = 2, motifs: string[] = ["%PromoStock%"]): Promise<T[]> {
    let gestes: Promise<T>[] = [];
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "PromoStockMovement" IN SHARE MODE`);
      gestes = lancer();
      for (const g of gestes) g.catch(() => undefined);
      const debut = Date.now();
      for (;;) {
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE ANY(${motifs}::text[])`;
        if (n >= attendus) break;
        if (Date.now() - debut > 10_000) {
          await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
          const vues = await tx.$queryRaw<{ etat: string | null; attente: string | null; requete: string }[]>`
            SELECT state AS etat, coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '') AS attente, left(query, 90) AS requete
            FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`;
          throw new Error(`les rapports n'ont pas atteint la barrière (${n} en attente sur ${attendus}) — ${JSON.stringify(vues)}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }, { timeout: 20_000 });
    return Promise.all(gestes);
  }

  it("PRÉMISSES : le délégué rapporte, sans vue globale du stock ; ce qu'il a en main sépare le distribuable du périmé", async () => {
    const kam = await actorFor(ids.kam!);
    expect(userCan(kam, "MEDICAL", "CREATE")).toBe(true);
    expect(moduleScope(kam, "PROMO_STOCK"), "sans vue globale — sinon l'historique ne prouverait aucun cloisonnement").not.toBe("ALL");
    expect(moduleScope(await actorFor(ids.ops!), "PROMO_STOCK")).toBe("ALL");
    const s = await stockPourVisite(ids.kam!);
    const f = s.articles.find((a) => a.itemId === fiche)!;
    expect([f.distribuable, f.perime]).toEqual([30, 10]);
    expect(s.articles.find((a) => a.itemId === stylo)?.distribuable).toBe(5);
    // Le support numérique VALIDE se propose ; le PÉRIMÉ non — la même lecture que l'action.
    expect(s.numeriques.map((n) => n.itemId)).toContain(eadv);
    expect(s.numeriques.map((n) => n.itemId)).not.toContain(eadvPerime);
  });

  it("AU-DELÀ DU STOCK, LA VISITE EST BLOQUÉE — et RIEN n'est écrit : ni la visite, ni ses liens, ni la remise", async () => {
    await comme("kam");
    const v = await visitePlanifiee(doc1);
    const avant = {
      mvts: await prisma.promoStockMovement.count({ where: { itemId: fiche } }),
      lastVisit: (await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: doc1 } })).lastVisit,
    };
    // 35 > 30 distribuables, alors que 40 sont « en main » : les 10 périmés ne se remettent pas.
    const r = await rapporterVisite(rapport(v, { [fiche]: "35" }));
    expect(r.ok).toBe(false);
    const e = r.ok ? "" : r.error;
    expect(e).toMatch(/35 « .*Fiche posologique.* » remis/);
    expect(e).toMatch(/Il ne reste que 30 de distribuable \(10 autre\(s\) dans un lot périmé/);
    expect(e).toMatch(/Rien n'est enregistré — ni la visite, ni la remise/);
    const relue = await prisma.medicalVisit.findUniqueOrThrow({ where: { id: v }, include: { productLinks: true, messageLinks: true } });
    expect(relue.status, "le rapport a été annulé avec la remise : tout ou rien").toBe("PLANNED");
    expect(relue.report).toBeNull();
    expect(relue.productLinks.length + relue.messageLinks.length).toBe(0);
    expect(await prisma.promoStockMovement.count({ where: { itemId: fiche } })).toBe(avant.mvts);
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: doc1 } })).lastVisit).toEqual(avant.lastVisit);
  });

  let visite1 = "";
  it("REMETTRE : la remise sort du stock du délégué, lot valide d'abord, et porte la visite ET le médecin", async () => {
    await comme("kam");
    visite1 = await visitePlanifiee(doc1);
    const r = await rapporterVisite(rapport(visite1, { [fiche]: "20", [stylo]: "5" }, { numeriqueItemId: [eadv] }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const ms = await mouvementsDe(visite1);
    expect(ms.every((m) => m.kind === "DISTRIBUTION" && m.doctorId === doc1 && m.holderId === ids.kam)).toBe(true);
    expect(await solde(fiche, lotValide)).toBe(10);
    expect(await solde(fiche, lotPerime), "un lot périmé ne se remet jamais").toBe(10);
    expect(await solde(stylo)).toBe(0);
    expect(await prisma.medicalVisitSupportNumerique.count({ where: { visitId: visite1, itemId: eadv } })).toBe(1);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: visite1, actorId: ids.kam! }, orderBy: { createdAt: "desc" } });
    expect(audit?.summary).toMatch(/remis : 20 .*Fiche posologique.*5 .*Stylo/);
    expect(audit?.summary).toMatch(/présenté en numérique : .*e-ADV/);
    expect((await prisma.medicalVisit.findUniqueOrThrow({ where: { id: visite1 } })).status).toBe("COMPLETED");
  });

  it("CORRIGER N'EST PAS RECOMPTER : un rapport renvoyé à l'identique n'écrit RIEN ; une quantité qui change est contre-passée puis remise", async () => {
    await comme("kam");
    const avant = (await mouvementsDe(visite1)).length;
    const identique = await rapporterVisite(rapport(visite1, { [fiche]: "20", [stylo]: "5" }, { numeriqueItemId: [eadv] }));
    expect(identique.ok, identique.ok ? "" : identique.error).toBe(true);
    expect((await mouvementsDe(visite1)).length, "aucune ligne de plus pour un rapport identique").toBe(avant);

    // 20 → 15 fiches, stylos retirés, support numérique décoché.
    const corrige = await rapporterVisite(rapport(visite1, { [fiche]: "15" }));
    expect(corrige.ok, corrige.ok ? "" : corrige.error).toBe(true);
    expect(await solde(fiche, lotValide)).toBe(15);
    expect(await solde(stylo), "la remise reprise revient dans le stock").toBe(5);
    const ms = await mouvementsDe(visite1);
    const reprises = ms.filter((m) => m.kind === "REVERSAL");
    expect(reprises.length).toBe(2);
    expect(reprises.every((m) => m.annuleId && m.doctorId === doc1), "une contre-passation garde le médecin : c'est l'historique").toBe(true);
    expect(await prisma.medicalVisitSupportNumerique.count({ where: { visitId: visite1 } })).toBe(0);
    const remises = (await remisesDesVisites([visite1])).get(visite1)!;
    expect(remises.materiel.map((m) => [m.itemId, m.quantite])).toEqual([[fiche, 15]]);
  });

  it("UNE REMISE PRISE SUR DEUX LOTS se reprend EN ENTIER : corriger 12 en 5 laisse 5 remises, pas 9", async () => {
    await comme("kam");
    const v = await visitePlanifiee(doc2);
    expect((await rapporterVisite(rapport(v, { [brochure]: "12" }))).ok).toBe(true);
    const parties = (await mouvementsDe(v)).filter((m) => m.kind === "DISTRIBUTION");
    expect(new Set(parties.map((m) => m.lotId)).size, "prémisse : la remise a bien pris deux lots").toBe(2);
    const r = await rapporterVisite(rapport(v, { [brochure]: "5" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await remisesDesVisites([v])).get(v)!.materiel.map((m) => m.quantite)).toEqual([5]);
    expect(await solde(brochure)).toBe(11);
    expect((await mouvementsDe(v)).filter((m) => m.kind === "REVERSAL").length, "chaque tranche reprise").toBe(2);
  });

  it("UN SUPERVISEUR QUI RAPPORTE À LA PLACE DU DÉLÉGUÉ vide la voiture du DÉLÉGUÉ, pas la sienne", async () => {
    // Le Super Admin rapporte pour kam (une absence à rattraper) : il n'a aucun stock — la remise
    // sort de celui de kam, le délégué de la visite. Sans la règle, elle sortirait du stock de
    // celui qui clique, c'est-à-dire de rien, et la visite serait refusée à tort.
    await comme("sa");
    const v = await visitePlanifiee(doc3);
    const avant = await solde(brochure);
    const r = await rapporterVisite(rapport(v, { [brochure]: "1" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const ms = await mouvementsDe(v);
    expect(ms.every((m) => m.holderId === ids.kam)).toBe(true);
    expect(await solde(brochure)).toBe(avant - 1);
  });

  it("UNE CORRECTION QUI DÉPASSE LE STOCK est refusée en entier — la reprise faite dans la même transaction est annulée avec elle", async () => {
    await comme("kam");
    const avant = (await mouvementsDe(visite1)).length;
    // 15 déjà remis + 15 en main = 30 au plus ; 40 dépasse — la reprise des 15 ne doit pas survivre.
    const r = await rapporterVisite(rapport(visite1, { [fiche]: "40" }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/Il ne reste que 30 de distribuable/);
    expect((await mouvementsDe(visite1)).length).toBe(avant);
    expect(await solde(fiche, lotValide)).toBe(15);
  });

  it("UN RAPPORT VOCAL CORRIGÉ ne crée pas un second rapport vocal : le brouillon prend la nouvelle transcription", async () => {
    await comme("kam");
    const v = await visitePlanifiee(doc3);
    expect((await rapporterVisite(form({ visitId: v, transcript: "Première dictée.", productId: [produit], messageId: [message] }))).ok).toBe(true);
    expect((await rapporterVisite(form({ visitId: v, transcript: "Dictée corrigée.", productId: [produit], messageId: [message] }))).ok).toBe(true);
    const rv = await prisma.fieldReport.findMany({ where: { visitId: v } });
    expect(rv.length).toBe(1);
    expect(rv[0]!.transcript).toBe("Dictée corrigée.");
  });

  it("LES TROIS PORTES remettent pareil : la visite IMPRÉVUE et la saisie RAPIDE déduisent, et bloquent sans rien créer", async () => {
    await comme("kam");
    const visitesAvant = await prisma.medicalVisit.count({ where: { doctorId: doc2 } });
    const tropImprevue = await ajouterVisiteImprevue(form({ doctorId: doc2, report: "Croisé en sortant.", materielItemId: [stylo], materielQuantite: ["6"] }));
    expect(tropImprevue.ok).toBe(false);
    expect(tropImprevue.ok ? "" : tropImprevue.error).toMatch(/Il ne reste que 5 de distribuable/);
    const tropRapide = await logVisit(undefined, form({ doctorId: doc2, materielItemId: [stylo], materielQuantite: ["6"] }));
    expect(tropRapide.ok).toBe(false);
    expect(await prisma.medicalVisit.count({ where: { doctorId: doc2 } }), "une visite bloquée n'est pas créée").toBe(visitesAvant);

    const imprevue = await ajouterVisiteImprevue(form({ doctorId: doc2, report: "Croisé en sortant.", materielItemId: [stylo], materielQuantite: ["2"] }));
    expect(imprevue.ok, imprevue.ok ? "" : imprevue.error).toBe(true);
    const rapide = await logVisit(undefined, form({ doctorId: doc2, materielItemId: [stylo], materielQuantite: ["1"] }));
    expect(rapide.ok, rapide.ok ? "" : rapide.error).toBe(true);
    expect(await solde(stylo)).toBe(2);
    const ms = await prisma.promoStockMovement.findMany({ where: { itemId: stylo, kind: "DISTRIBUTION", doctorId: doc2 }, select: { visitId: true } });
    expect(new Set(ms.map((m) => m.visitId))).toEqual(new Set([imprevue.ok ? imprevue.id : "", rapide.ok ? rapide.id : ""]));
  });

  it("CORRIGER N'EXIGE PAS PLUS QUE LA CRÉATION : une imprévue ou une saisie rapide se corrigent sans produit ni message", async () => {
    await comme("kam");
    const imprevue = await ajouterVisiteImprevue(form({ doctorId: doc4, report: "Rencontre.", materielItemId: [stylo], materielQuantite: ["1"] }));
    expect(imprevue.ok).toBe(true);
    const r1 = await rapporterVisite(form({ visitId: imprevue.ok ? imprevue.id! : "", report: "Rencontre.", materielItemId: [stylo], materielQuantite: ["2"] }));
    expect(r1.ok, r1.ok ? "" : r1.error).toBe(true);
    const rapide = await logVisit(undefined, form({ doctorId: doc4 }));
    expect(rapide.ok).toBe(true);
    const r2 = await rapporterVisite(form({ visitId: rapide.ok ? rapide.id! : "", report: "Saisie du soir.", materielItemId: [stylo], materielQuantite: ["0"] }));
    expect(r2.ok, r2.ok ? "" : r2.error).toBe(true);
    // Le témoin : une visite PLANIFIÉE garde ses obligations — sans lui, une règle trop large passerait.
    const v = await visitePlanifiee(doc4);
    const r3 = await rapporterVisite(form({ visitId: v, report: "x" }));
    expect(r3.ok).toBe(false);
    expect(r3.ok ? "" : r3.error).toMatch(/produits discutés/);
  });

  it("LA NATURE DE L'ARTICLE est vérifiée : un numérique ne se remet pas, un consommable ne se « présente » pas, un support périmé ne se présente plus", async () => {
    await comme("kam");
    const v = await visitePlanifiee(doc3);
    const r1 = await rapporterVisite(rapport(v, { [eadv]: "3" }));
    expect(r1.ok ? "" : r1.error).toMatch(/support numérique : il se présente, il ne se remet pas/);
    const r2 = await rapporterVisite(rapport(v, {}, { numeriqueItemId: [stylo] }));
    expect(r2.ok ? "" : r2.error).toMatch(/n'est pas un support numérique/);
    const r3 = await rapporterVisite(rapport(v, {}, { numeriqueItemId: [eadvPerime] }));
    expect(r3.ok ? "" : r3.error).toMatch(/n'est plus valide/);
    const r4 = await rapporterVisite(rapport(v, { [fiche]: "vingt" }));
    expect(r4.ok ? "" : r4.error).toMatch(/illisible/);
    expect((await prisma.medicalVisit.findUniqueOrThrow({ where: { id: v } })).status).toBe("PLANNED");
  });

  it("CONCURRENCE : deux visites du même délégué sur les 15 derniers blocs — une passe, l'autre est refusée, jamais −5", async () => {
    await comme("kam");
    const [va, vb] = await Promise.all([visitePlanifiee(doc2), visitePlanifiee(doc3)]);
    const resultats = await sousBarriere(() => [
      rapporterVisite(rapport(va, { [bloc]: "10" })),
      rapporterVisite(rapport(vb, { [bloc]: "10" })),
    ]);
    const passes = resultats.filter((r) => r.ok).length;
    expect(passes, JSON.stringify(resultats)).toBe(1);
    expect(await solde(bloc)).toBe(5);
    const refus = resultats.find((r) => !r.ok);
    expect(refus && !refus.ok ? refus.error : "").toMatch(/Il ne reste que 5 de distribuable/);
  });

  it("DEUX ENVOIS DU MÊME RAPPORT : celui qui n'a pas vu la remise de l'autre est refusé — jamais une écriture sans le verrou de son article", async () => {
    // Le premier envoi remet des FICHES, le second des BLOCS. Le second a calculé ses verrous AVANT
    // que le premier ne s'enregistre : il ne tient pas le verrou des fiches, et reprendre la remise
    // du premier l'écrirait sans lui. Il est refusé, et le dit — le premier envoi fait foi.
    // (Les deux articles ont du stock : un envoi refusé pour stock insuffisant n'atteindrait jamais
    // la barrière, et le cas ne mesurerait que l'ordre d'arrivée — mesuré, avec les stylos épuisés.)
    await comme("kam");
    const v = await visitePlanifiee(doc4);
    const fichesAvant = await solde(fiche, lotValide);
    const blocsAvant = await solde(bloc);
    expect(fichesAvant > 0 && blocsAvant > 0, "prémisse : les deux articles sont en main").toBe(true);
    // La barrière retient le premier au registre ; le second attend la ligne de la VISITE, que le
    // premier tient déjà — d'où le second motif.
    const resultats = await sousBarriere(() => [
      rapporterVisite(rapport(v, { [fiche]: "1" })),
      rapporterVisite(rapport(v, { [bloc]: "1" })),
    ], 2, ["%PromoStock%", "%MedicalVisit%"]);
    expect(resultats.filter((r) => r.ok).length, JSON.stringify(resultats)).toBe(1);
    const refus = resultats.find((r) => !r.ok);
    expect(refus && !refus.ok ? refus.error : "").toMatch(/vient d'être enregistré par ailleurs/);
    const net = (await remisesDesVisites([v])).get(v)!.materiel.map((m) => [m.itemId, m.quantite]);
    expect(net.length, "un seul envoi a écrit").toBe(1);
    const gagnant = net[0]![0] === fiche ? "fiche" : "bloc";
    expect(await solde(fiche, lotValide)).toBe(fichesAvant - (gagnant === "fiche" ? 1 : 0));
    expect(await solde(bloc)).toBe(blocsAvant - (gagnant === "bloc" ? 1 : 0));
  });

  it("UNE REMISE NE S'ANNULE PAS DEPUIS LE STOCK : le refus nomme le rapport de visite", async () => {
    await comme("sa");
    // UNE REMISE ENCORE ACTIVE — aucune contre-passation ne la vise. `annuleId` dit qu'un
    // mouvement EN ANNULE un autre, pas qu'il a été annulé : le prendre pour ce second sens
    // choisissait la remise déjà reprise, et le refus venait d'ailleurs (« déjà annulé »).
    const ms = await mouvementsDe(visite1);
    const reprises = new Set(ms.map((x) => x.annuleId).filter(Boolean));
    const m = ms.find((x) => x.kind === "DISTRIBUTION" && x.itemId === fiche && !reprises.has(x.id))!;
    const r = await annulerMouvement(form({ mouvementId: m.id, motif: "essai" }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/se corrige depuis le rapport de sa visite/);
  });

  it("L'HISTORIQUE PAR MÉDECIN : net des corrections, et chacun ne voit que ce qu'il a le droit de voir", async () => {
    const pageKam = await chargerPageStock(await actorFor(ids.kam!));
    const d1 = pageKam.remisesAuxMedecins.find((r) => r.doctorId === doc1)!;
    expect(d1, "le délégué lit ses propres remises").toBeTruthy();
    expect(d1.articles.map((a) => [a.itemId, a.quantite]), "les stylos repris ne comptent plus").toEqual([[fiche, 15]]);
    expect(d1.delegues).toEqual([ids.kam]);
    const pageK2 = await chargerPageStock(await actorFor(ids.k2!));
    expect(pageK2.remisesAuxMedecins.some((r) => r.doctorId === doc1), "un autre délégué ne lit pas les remises de kam").toBe(false);
    const pageOps = await chargerPageStock(await actorFor(ids.ops!));
    expect(pageOps.remisesAuxMedecins.find((r) => r.doctorId === doc1)?.articles.map((a) => a.quantite)).toEqual([15]);
  });

  it("UN SUPPORT PRÉSENTÉ ne s'efface pas : la corbeille refuse en nommant les présentations", async () => {
    await comme("kam");
    const v = await visitePlanifiee(doc4);
    expect((await rapporterVisite(rapport(v, {}, { numeriqueItemId: [eadv] }))).ok).toBe(true);
    const refus = await DELETE_REGISTRY.PROMO_STOCK_ITEM.refuse!(eadv);
    expect(refus).toMatch(/présentation\(s\) en visite/);
  });
});
