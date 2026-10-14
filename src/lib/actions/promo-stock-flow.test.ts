import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, moduleScope, userCan, type SessionUser } from "@/lib/rbac";
import { creerArticleCatalogue, modifierArticleCatalogue } from "./promo-catalogue-actions";
import {
  annulerDemande, annulerMouvement, annulerTransfert, confirmerReception, corrigerInventaire, declarerPerte, declarerSupportNumerique,
  demanderMateriel, doter, entrerEnStock, modifierArticleStock, modifierLot, poserInventaireOuverture, refuserDemande, refuserReception,
  servirDemande, transferer,
} from "./promo-stock-actions";
import { chargerPageStock, faitsStock } from "@/lib/queries/promo-stock";
import { relancerReceptionsStock, JOURS_AVANT_RAPPEL } from "@/lib/promo-stock-rappels";
import { REFUS } from "@/lib/promo/stock-acces";
import { MOTIF_ANNULATION_MOUVEMENT } from "@/lib/promo/stock-ecriture";
import { DELETE_REGISTRY } from "@/lib/admin-delete-registry";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__stock__";

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
 * LE STOCK PROMOTIONNEL DE BOUT EN BOUT (§118.164) — par les VRAIES actions, avec des acteurs SANS
 * vue globale (§118.104) : un banc joué par le Super Admin ne verrait jamais une porte se fermer.
 *
 *   sa    Super Admin                                 dm    directrice de la Direction Marketing
 *   pm2   membre de la Direction Marketing, sous dm   ops   Directeur des Opérations
 *   sup   superviseur sous ops                        k1,k2 délégués sous sup (équipe de ops)
 *   k3    délégué HORS de l'équipe de ops — mais KAM de la gamme que sup supervise
 *   fin   Finances (lecture)                          reg   Regulatory : SANS le module
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Stock promotionnel — magasin, dotations confirmées, équipes, attestations", () => {
  const ids: Record<string, string> = {};
  let fiche = "";   // article du catalogue : consommable par produit
  let stylo = "";   // article du catalogue : générique, sans produit
  let produit = "";
  let article = ""; // l'article de stock « fiche — produit » au magasin

  beforeAll(async () => {
    await nettoyer();
    const faire = (nom: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, role: role as never, passwordHash: "x" } });
    const [sa, dm, pm2, ops, sup, k1, k2, k3, fin, reg] = await Promise.all([
      faire("sa", "SUPER_ADMIN"), faire("dm", "PRODUCT_MANAGER"), faire("pm2", "PRODUCT_MANAGER"),
      faire("ops", "OPERATIONS_DIRECTOR"), faire("sup", "NATIONAL_SALES"),
      faire("k1", "MEDICAL_DELEGATE"), faire("k2", "MEDICAL_DELEGATE"), faire("k3", "MEDICAL_DELEGATE"),
      faire("fin", "FINANCE_BUDGET_MANAGER"), faire("reg", "HEAD_OF_REGULATORY"),
    ]);
    Object.assign(ids, { sa: sa.id, dm: dm.id, pm2: pm2.id, ops: ops.id, sup: sup.id, k1: k1.id, k2: k2.id, k3: k3.id, fin: fin.id, reg: reg.id });
    // L'ORGANIGRAMME : dm dirige la Direction Marketing (pm2 sous elle) ; ops → sup → k1, k2 ; k3 ailleurs.
    const emp = (nom: string, userId: string, managerId?: string) =>
      prisma.employee.create({ data: { fullName: `${TAG}${nom}`, userId, managerId: managerId ?? null }, select: { id: true } });
    const eDm = await emp("dm", dm.id);
    await emp("pm2", pm2.id, eDm.id);
    const eOps = await emp("ops", ops.id);
    const eSup = await emp("sup", sup.id, eOps.id);
    await Promise.all([emp("k1", k1.id, eSup.id), emp("k2", k2.id, eSup.id), emp("k3", k3.id)]);
    // LA GAMME : sup supervise une BU dont k3 est KAM — l'équipe se lit AUSSI par la gamme, pas
    // seulement par l'organigramme (k3 n'est sous personne).
    const bu = await prisma.businessUnit.create({ data: { name: `${TAG}BU Oncologie`, supervisorId: sup.id }, select: { id: true } });
    await prisma.salesRepProfile.create({ data: { repId: k3.id, businessUnitId: bu.id } });
    const p = await prisma.product.create({
      data: { code: `${TAG}P1`, canonicalName: `${TAG}Nivolex`, dci: `${TAG}nivolumab`, identityKey: `${TAG}nivolex` } as never,
      select: { id: true },
    });
    produit = p.id;
  });

  afterAll(async () => {
    await nettoyer();
  });

  async function nettoyer() {
    const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    const uids = users.map((u) => u.id);
    const cat = await prisma.promoCatalogueArticle.findMany({ where: { nom: { startsWith: TAG } }, select: { id: true } });
    // L'article emporte lots, mouvements, transferts et demandes (Cascade) — c'est le seul geste de nettoyage.
    if (cat.length) await prisma.promoStockItem.deleteMany({ where: { catalogueId: { in: cat.map((c) => c.id) } } });
    await prisma.promoCatalogueArticle.deleteMany({ where: { nom: { startsWith: TAG } } });
    await prisma.product.deleteMany({ where: { code: { startsWith: TAG } } });
    if (uids.length) await prisma.salesRepProfile.deleteMany({ where: { repId: { in: uids } } });
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.employee.updateMany({ where: { fullName: { startsWith: TAG } }, data: { managerId: null } });
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } });
    if (uids.length) {
      await prisma.notification.deleteMany({ where: { userId: { in: uids } } });
      await prisma.userAccess.deleteMany({ where: { userId: { in: uids } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: uids } } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: { in: uids } } });
  }

  const comme = async (qui: string) => { ACTOR = await actorFor(ids[qui]!); };
  const solde = async (holderId: string | null, itemId = article) => {
    const r = await prisma.promoStockMovement.aggregate({ where: { itemId, holderId }, _sum: { delta: true } });
    return Number(r._sum.delta ?? 0);
  };
  const transfertDe = (id: string) => prisma.promoStockTransfer.findUniqueOrThrow({ where: { id } });

  /**
   * FORCER UN ENTRELACEMENT (§118.65). Lancés « en même temps » sans barrière, deux gestes se
   * succèdent parfois — le second relit APRÈS que le premier a écrit — et un banc de concurrence
   * passe au vert sans la garde qu'il prétend éprouver (mesuré : le sabotage qui retire le verrou de
   * l'article est tombé à une série et passé au vert à la suivante). La barrière tient un verrou qui
   * bloque les ÉCRITURES de `table` sans bloquer ses lectures, lance les gestes, attend que `attendus`
   * sessions soient bloquées sur le stock, puis relâche.
   */
  async function sousBarriere<T>(table: string, lancer: () => Promise<T>[], attendus = 2): Promise<T[]> {
    let gestes: Promise<T>[] = [];
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "${table}" IN SHARE MODE`);
      gestes = lancer();
      for (const g of gestes) g.catch(() => undefined); // l'erreur se lit plus bas, pas en rejet orphelin
      const debut = Date.now();
      for (;;) {
        // Dans une transaction, Postgres FIGE la vue des sessions au premier accès : sans ce
        // rafraîchissement, la barrière regardait une photo prise avant l'arrivée des gestes.
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE '%PromoStock%'`;
        if (n >= attendus) break;
        if (Date.now() - debut > 10_000) {
          // Un échec de barrière DIT ce que faisaient les sessions : sinon on accuse le verrou au hasard.
          await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
          const vues = await tx.$queryRaw<{ etat: string | null; attente: string | null; requete: string }[]>`
            SELECT state AS etat, coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '') AS attente, left(query, 90) AS requete
            FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`;
          throw new Error(`les gestes n'ont pas atteint la barrière (${n} en attente sur ${attendus}) — ${JSON.stringify(vues)}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }, { timeout: 20_000 });
    return Promise.all(gestes);
  }

  it("PRÉMISSES : délégués et superviseur en portée « lignes », vues globales ailleurs ; dm est la cheffe, pm2 non", async () => {
    for (const qui of ["k1", "k2", "k3", "sup"]) {
      const a = await actorFor(ids[qui]!);
      expect(userCan(a, "PROMO_STOCK", "UPDATE"), qui).toBe(true);
      expect(moduleScope(a, "PROMO_STOCK"), `${qui} n'a PAS la vue globale — sinon le banc ne prouverait rien`).not.toBe("ALL");
    }
    expect(moduleScope(await actorFor(ids.ops!), "PROMO_STOCK")).toBe("ALL");
    expect(userCan(await actorFor(ids.fin!), "PROMO_STOCK", "UPDATE")).toBe(false);
    const fDm = await faitsStock(await actorFor(ids.dm!));
    const fPm2 = await faitsStock(await actorFor(ids.pm2!));
    expect(fDm.gereLeMagasin).toBe(true);
    expect(fPm2.gereLeMagasin, "pm2 a la directrice au-dessus d'elle dans l'organigramme").toBe(false);
    const fOps = await faitsStock(await actorFor(ids.ops!));
    expect([...fOps.equipe].sort()).toEqual([ids.sup, ids.k1, ids.k2].sort());
    expect(fOps.directeurDesOperations).toBe(true);
    const fSup = await faitsStock(await actorFor(ids.sup!));
    expect([...fSup.equipe].sort(), "l'équipe de sup : k1 et k2 par l'organigramme, k3 par la gamme qu'il supervise").toEqual([ids.k1, ids.k2, ids.k3].sort());
    expect(fSup.directeurDesOperations).toBe(false);
    const reg = await actorFor(ids.reg!);
    expect(userCan(reg, "PROMO_STOCK", "VIEW"), "reg n'a PAS le module — sinon le refus de destinataire ne prouverait rien").toBe(false);
  });

  it("le catalogue : le Super Admin crée ; un délégué ne le peut pas tant qu'on ne le lui ouvre pas", async () => {
    await comme("sa");
    const r1 = await creerArticleCatalogue(form({ nom: `${TAG}Fiche posologique`, famille: "CONSOMMABLE", materialType: "FICHE_POSO", exigeProduit: "on" }));
    const r2 = await creerArticleCatalogue(form({ nom: `${TAG}Stylo`, famille: "CONSOMMABLE", unite: "pièce" }));
    expect(r1.ok && r2.ok, `${r1.error ?? ""} ${r2.error ?? ""}`).toBe(true);
    fiche = r1.id!;
    stylo = r2.id!;
    const ref = await prisma.promoCatalogueArticle.findUniqueOrThrow({ where: { id: fiche }, select: { reference: true } });
    expect(ref.reference).toMatch(/^CAT-\d{4,}$/);

    await comme("k1");
    const refus = await creerArticleCatalogue(form({ nom: `${TAG}Bloc`, famille: "CONSOMMABLE" }));
    expect(refus.ok).toBe(false);
    // Le Super Admin l'ouvre en ÉCRITURE à cette personne, dans la console : la règle suit.
    await prisma.userAccess.create({ data: { userId: ids.k1!, module: "PROMO_CATALOG", canView: true, canCreate: true, canUpdate: true } });
    await comme("k1");
    const ouvert = await creerArticleCatalogue(form({ nom: `${TAG}Bloc-notes`, famille: "CONSOMMABLE" }));
    expect(ouvert.ok, ouvert.error).toBe(true);
    const corr = await modifierArticleCatalogue(form({ id: ouvert.id!, nom: `${TAG}Bloc-notes A5`, famille: "CONSOMMABLE" }));
    expect(corr.ok, corr.error).toBe(true);
    const lue = await prisma.promoCatalogueArticle.findUniqueOrThrow({ where: { id: ouvert.id! }, select: { reference: true, nom: true } });
    expect(lue.nom).toBe(`${TAG}Bloc-notes A5`);
  });

  it("CORRIGER UN SUPPORT ne touche que ce que le formulaire PORTE (§118.173) — et la case « par produit » dit oui comme non", async () => {
    await comme("sa");
    // Un support repris porte sa nature, son unité et sa description : le formulaire simple ne les
    // saisit plus. Le corriger ne doit pas les effacer (§118.152c).
    const r = await creerArticleCatalogue(form({ nom: `${TAG}Kakémono`, famille: "DURABLE", materialType: "BANNER", unite: "unité", description: "85×200", exigeProduit: "on" }));
    expect(r.ok, r.error).toBe(true);
    const lire = () => prisma.promoCatalogueArticle.findUniqueOrThrow({
      where: { id: r.id! }, select: { nom: true, famille: true, materialType: true, unite: true, description: true, exigeProduit: true },
    });
    // Le formulaire SIMPLE : le nom, la famille, et la case avec son TÉMOIN, décochée.
    const corr = await modifierArticleCatalogue(form({ id: r.id!, nom: `${TAG}Kakémono roll-up`, famille: "DURABLE", exigeProduit: "off" }));
    expect(corr.ok, corr.error).toBe(true);
    expect(await lire()).toEqual({ nom: `${TAG}Kakémono roll-up`, famille: "DURABLE", materialType: "BANNER", unite: "unité", description: "85×200", exigeProduit: false });
    // Cochée : le témoin ET la case partent — « off » puis « on » ; une seule « on » l'emporte.
    expect((await modifierArticleCatalogue(form({ id: r.id!, exigeProduit: ["off", "on"] }))).ok).toBe(true);
    expect((await lire()).exigeProduit).toBe(true);
    // Une saisie qui ne PORTE pas la case ne dit rien d'elle : la valeur reste.
    expect((await modifierArticleCatalogue(form({ id: r.id!, nom: `${TAG}Kakémono roll-up 85` }))).ok).toBe(true);
    expect(await lire()).toMatchObject({ nom: `${TAG}Kakémono roll-up 85`, exigeProduit: true, description: "85×200", unite: "unité", materialType: "BANNER" });
    // Une clé PRÉSENTE et vide efface : c'est ainsi qu'on retire une description.
    expect((await modifierArticleCatalogue(form({ id: r.id!, description: "" }))).ok).toBe(true);
    expect((await lire()).description).toBeNull();
  });

  it("entrée manuelle : le Super Admin seul ; un article « par produit » exige son produit", async () => {
    await comme("dm");
    const r0 = await entrerEnStock(form({ catalogueId: fiche, produitIds: [produit], quantite: "100", motif: "don" }));
    expect(r0).toEqual({ ok: false, error: REFUS.superAdmin });

    await comme("sa");
    const sansProduit = await entrerEnStock(form({ catalogueId: fiche, quantite: "100", motif: "don" }));
    expect(sansProduit.ok).toBe(false);
    expect(sansProduit.error).toMatch(/produit/);
    const sansMotif = await entrerEnStock(form({ catalogueId: fiche, produitIds: [produit], quantite: "100" }));
    expect(sansMotif.ok).toBe(false);

    const r = await entrerEnStock(form({ catalogueId: fiche, produitIds: [produit], quantite: "100", motif: "Impression mars", valableJusquau: "2027-12-31", coutUnitaire: "120" }));
    expect(r.ok, r.error).toBe(true);
    article = r.id!;
    expect(await solde(null)).toBe(100);
    // Une seconde entrée du même article et du même produit retombe sur le MÊME article de stock.
    const r2 = await entrerEnStock(form({ catalogueId: fiche, produitIds: [produit], quantite: "20", motif: "Réimpression" }));
    expect(r2.id).toBe(article);
    expect(await solde(null)).toBe(120);
    const lots = await prisma.promoStockLot.count({ where: { itemId: article } });
    expect(lots, "deux entrées, deux lots").toBe(2);
  });

  it("doter : la directrice marketing dote ; un membre de la direction qui n'en est pas la cheffe, non", async () => {
    await comme("pm2");
    const refus = await doter(form({ itemId: article, versId: ids.k1!, quantite: "10" }));
    expect(refus).toEqual({ ok: false, error: REFUS.magasin });

    await comme("dm");
    const sansModule = await doter(form({ itemId: article, versId: ids.reg!, quantite: "1" }));
    expect(sansModule.ok, "doter quelqu'un qui ne peut pas confirmer laisserait le matériel en route pour toujours").toBe(false);
    expect(sansModule.error).toMatch(/n'a pas accès au stock promotionnel/);
    const r = await doter(form({ itemId: article, versId: ids.k1!, quantite: "30", note: "Tournée d'octobre" }));
    expect(r.ok, r.error).toBe(true);
    const t = await transfertDe(r.id!);
    expect(t.statut).toBe("EN_ROUTE");
    expect(await solde(null)).toBe(90);
    expect(await solde(ids.k1!), "rien n'entre chez le délégué avant SA confirmation").toBe(0);
    const notif = await prisma.notification.count({ where: { userId: ids.k1!, title: { contains: "en route" } } });
    expect(notif).toBeGreaterThanOrEqual(1);
  });

  it("confirmer est une ATTESTATION : ni le Super Admin ni la directrice ne la donnent à la place du délégué", async () => {
    const t = await prisma.promoStockTransfer.findFirstOrThrow({ where: { itemId: article, versId: ids.k1!, statut: "EN_ROUTE" } });
    for (const qui of ["sa", "dm", "ops"]) {
      await comme(qui);
      const r = await confirmerReception(form({ transfertId: t.id }));
      expect(r, qui).toEqual({ ok: false, error: REFUS.confirmation });
    }
    await comme("k1");
    const sansMotif = await confirmerReception(form({ transfertId: t.id, quantiteRecue: "28" }));
    expect(sansMotif.ok, "un écart sans motif ne part pas").toBe(false);
    const r = await confirmerReception(form({ transfertId: t.id, quantiteRecue: "28", note: "Carton abîmé, 2 fiches manquantes" }));
    expect(r.ok, r.error).toBe(true);
    expect(await solde(ids.k1!)).toBe(28);
    expect(await solde(null), "le manquant n'est retiré à personne une seconde fois").toBe(90);
    const apres = await transfertDe(t.id);
    expect(apres.statut).toBe("RECU");
    expect(Number(apres.quantiteRecue)).toBe(28);
    const second = await confirmerReception(form({ transfertId: t.id }));
    expect(second.ok, "une réception ne se confirme qu'une fois").toBe(false);
  });

  it("le destinataire refuse un transfert, il ne l'annule pas ; celui qui l'a lancé, oui", async () => {
    await comme("k1");
    const r = await transferer(form({ itemId: article, versId: ids.k2!, quantite: "1" }));
    expect(r.ok, r.error).toBe(true);
    await comme("k2");
    expect((await annulerTransfert(form({ transfertId: r.id! }))).ok).toBe(false);
    await comme("k1");
    expect((await annulerTransfert(form({ transfertId: r.id!, note: "Erreur de destinataire" }))).ok).toBe(true);
    expect(await solde(ids.k1!)).toBe(28);
  });

  it("un article du catalogue déjà en stock ne devient pas numérique — on crée un article distinct", async () => {
    await comme("sa");
    const r = await modifierArticleCatalogue(form({ id: fiche, nom: `${TAG}Fiche posologique`, famille: "NUMERIQUE" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/numérique/);
  });

  it("un support numérique : un lien et une validité, déclaré une fois ; sa fiche garde ce qu'elle ne montre pas", async () => {
    await comme("sa");
    const c = await creerArticleCatalogue(form({ nom: `${TAG}E-flyer`, famille: "NUMERIQUE" }));
    expect(c.ok, c.error).toBe(true);
    await comme("dm");
    const enStock = await entrerEnStock(form({ catalogueId: c.id!, quantite: "5", motif: "x" }));
    expect(enStock.ok, "un support numérique n'a pas de quantité").toBe(false);
    const d = await declarerSupportNumerique(form({ catalogueId: c.id!, produitIds: [produit], lien: "https://exemple.dz/eflyer", valableJusquau: "2027-06-30" }));
    expect(d.ok, d.error).toBe(true);
    const deux = await declarerSupportNumerique(form({ catalogueId: c.id!, produitIds: [produit], lien: "https://autre.dz" }));
    expect(deux.ok, "déclaré deux fois ferait deux supports pour la même chose").toBe(false);
    expect((await modifierArticleStock(form({ id: d.id!, notes: "Version 2" }))).ok).toBe(true);
    const lu = await prisma.promoStockItem.findUniqueOrThrow({ where: { id: d.id! }, select: { lien: true, valableJusquau: true, notes: true } });
    expect(lu.lien, "la fiche qui ne montre que les notes n'efface pas le lien").toBe("https://exemple.dz/eflyer");
    expect(lu.valableJusquau?.toISOString().slice(0, 10)).toBe("2027-06-30");
    expect(await prisma.promoStockMovement.count({ where: { itemId: d.id! } }), "aucun mouvement pour un support numérique").toBe(0);
  });

  it("un lot : sa validité se corrige sur un consommable, jamais sur un durable", async () => {
    await comme("sa");
    const c = await creerArticleCatalogue(form({ nom: `${TAG}Banner roll-up`, famille: "DURABLE", materialType: "BANNER" }));
    const e = await entrerEnStock(form({ catalogueId: c.id!, quantite: "4", motif: "Achat salon" }));
    expect(e.ok, e.error).toBe(true);
    const lotDurable = await prisma.promoStockLot.findFirstOrThrow({ where: { itemId: e.id! } });
    await comme("dm");
    expect((await modifierLot(form({ lotId: lotDurable.id, valableJusquau: "2027-01-01" }))).ok, "un durable ne périme pas").toBe(false);
    expect((await modifierLot(form({ lotId: lotDurable.id, coutUnitaire: "15000" }))).ok).toBe(true);
    const lot1 = await prisma.promoStockLot.findFirstOrThrow({ where: { itemId: article, numero: 1 } });
    expect((await modifierLot(form({ lotId: lot1.id, valableJusquau: "2028-03-31" }))).ok).toBe(true);
    const lu = await prisma.promoStockLot.findUniqueOrThrow({ where: { id: lot1.id }, select: { valableJusquau: true, coutUnitaire: true } });
    expect(lu.valableJusquau?.toISOString().slice(0, 10)).toBe("2028-03-31");
    expect(Number(lu.coutUnitaire), "la clé omise garde le coût posé à l'entrée").toBe(120);
    await comme("pm2");
    expect((await modifierLot(form({ lotId: lot1.id, coutUnitaire: "1" }))).ok).toBe(false);
  });

  it("un délégué ne voit ni le magasin ni un collègue — la page ne les CHARGE pas", async () => {
    const page = await chargerPageStock(await actorFor(ids.k1!));
    const a = page.articles.find((x) => x.id === article)!;
    expect(a).toBeTruthy();
    expect(a.soldes.map((s) => s.detenteurId)).toEqual([ids.k1]);
    expect(a.journal.length, "k1 a déjà reçu et rendu : son journal n'est pas vide").toBeGreaterThan(0);
    expect([...new Set(a.journal.map((m) => m.detenteurId))], "le journal ne montre que SES mouvements — pas ceux du magasin").toEqual([ids.k1]);
    expect(a.total, "le total n'est rempli qu'en vue globale").toBeNull();
    expect(page.faits.vueGlobale).toBe(false);
  });

  it("transférer à un collègue, qui REFUSE : tout revient à l'envoyeur", async () => {
    await comme("k1");
    const r = await transferer(form({ itemId: article, versId: ids.k2!, quantite: "10" }));
    expect(r.ok, r.error).toBe(true);
    expect(await solde(ids.k1!)).toBe(18);
    await comme("k2");
    const sansMotif = await refuserReception(form({ transfertId: r.id! }));
    expect(sansMotif.ok).toBe(false);
    const refus = await refuserReception(form({ transfertId: r.id!, note: "Je n'en ai pas besoin" }));
    expect(refus.ok, refus.error).toBe(true);
    expect(await solde(ids.k1!)).toBe(28);
    expect(await solde(ids.k2!)).toBe(0);
    expect((await transfertDe(r.id!)).statut).toBe("REFUSE");
  });

  it("rendre au magasin : la directrice confirme le retour", async () => {
    await comme("k1");
    const r = await transferer(form({ itemId: article, versId: "", quantite: "5" }));
    expect(r.ok, r.error).toBe(true);
    await comme("k2");
    expect((await confirmerReception(form({ transfertId: r.id! }))).ok, "un délégué ne confirme pas un retour au magasin").toBe(false);
    await comme("dm");
    const c = await confirmerReception(form({ transfertId: r.id! }));
    expect(c.ok, c.error).toBe(true);
    expect(await solde(null)).toBe(95);
    expect(await solde(ids.k1!)).toBe(23);
  });

  it("le directeur des opérations déplace le matériel DANS ses équipes, et la personne touchée en est prévenue", async () => {
    await comme("ops");
    const r = await transferer(form({ itemId: article, deId: ids.k1!, versId: ids.k2!, quantite: "8" }));
    expect(r.ok, r.error).toBe(true);
    expect(await solde(ids.k1!)).toBe(15);
    const prevenu = await prisma.notification.count({ where: { userId: ids.k1!, title: { contains: "retiré de votre stock" } } });
    expect(prevenu).toBe(1);
    await comme("k2");
    expect((await confirmerReception(form({ transfertId: r.id! }))).ok).toBe(true);
    expect(await solde(ids.k2!)).toBe(8);
  });

  it("…mais pas hors de son périmètre, et un superviseur VOIT sans disposer", async () => {
    await comme("ops");
    const hors = await transferer(form({ itemId: article, deId: ids.k1!, versId: ids.k3!, quantite: "1" }));
    expect(hors).toEqual({ ok: false, error: REFUS.hors_equipe });
    const depuisHors = await transferer(form({ itemId: article, deId: ids.k3!, versId: ids.k1!, quantite: "1" }));
    expect(depuisHors).toEqual({ ok: false, error: REFUS.sortie });

    await comme("sup");
    const sup = await transferer(form({ itemId: article, deId: ids.k1!, versId: ids.k2!, quantite: "1" }));
    expect(sup).toEqual({ ok: false, error: REFUS.sortie });
    const vue = await chargerPageStock(await actorFor(ids.sup!));
    const a = vue.articles.find((x) => x.id === article)!;
    expect(a.soldes.map((s) => s.detenteurId).sort()).toEqual([ids.k1, ids.k2].sort());
  });

  it("deux dotations simultanées qui dépassent le magasin : une passe, l'autre est refusée — jamais de solde négatif", async () => {
    await comme("dm");
    expect(await solde(null)).toBe(95);
    // L'entrelacement est FORCÉ (voir `sousBarriere`) : sans le verrou de l'article, chacune a lu 95
    // avant que l'autre écrive, et les deux passent ; avec lui, la seconde attend la première sur la
    // ligne de l'article et relit 35.
    const [a, b] = await sousBarriere("PromoStockTransfer", () => [
      doter(form({ itemId: article, versId: ids.k1!, quantite: "60" })),
      doter(form({ itemId: article, versId: ids.k2!, quantite: "60" })),
    ]);
    expect([a.ok, b.ok].filter(Boolean).length, `${a.error ?? ""} | ${b.error ?? ""}`).toBe(1);
    expect(await solde(null)).toBe(35);
    const refus = a.ok ? b : a;
    expect(refus.error).toMatch(/35/);
    // On remet la dotation acceptée au magasin, en l'annulant : le banc repart d'un état connu.
    const enRoute = await prisma.promoStockTransfer.findFirstOrThrow({ where: { itemId: article, statut: "EN_ROUTE", quantite: 60 } });
    expect((await annulerTransfert(form({ transfertId: enRoute.id, note: "Doublon" }))).ok).toBe(true);
    expect(await solde(null)).toBe(95);
  });

  it("un lot PÉRIMÉ ne se distribue plus — il se déclare détruit, le premier", async () => {
    await comme("sa");
    const r = await entrerEnStock(form({ catalogueId: stylo, quantite: "10", motif: "Stock retrouvé", valableJusquau: "2020-01-31" }));
    expect(r.ok, r.error).toBe(true);
    const styloStock = r.id!;
    await comme("dm");
    const refus = await doter(form({ itemId: styloStock, versId: ids.k1!, quantite: "1" }));
    expect(refus.ok).toBe(false);
    expect(refus.error).toMatch(/périmé/);
    const perte = await declarerPerte(form({ itemId: styloStock, detenteurId: "", quantite: "10", motif: "Lot périmé détruit" }));
    expect(perte.ok, perte.error).toBe(true);
    expect(await solde(null, styloStock)).toBe(0);
  });

  it("l'inventaire d'ouverture se pose UNE fois par article et par détenteur", async () => {
    await comme("sa");
    const r1 = await poserInventaireOuverture(form({ catalogueId: fiche, produitIds: [produit], detenteurId: ids.k3!, quantite: "12" }));
    expect(r1.ok, r1.error).toBe(true);
    expect(await solde(ids.k3!)).toBe(12);
    const r2 = await poserInventaireOuverture(form({ catalogueId: fiche, produitIds: [produit], detenteurId: ids.k3!, quantite: "15" }));
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/déjà posé/);
    await comme("dm");
    expect((await poserInventaireOuverture(form({ catalogueId: fiche, produitIds: [produit], quantite: "1" }))).ok).toBe(false);
  });

  it("annuler un mouvement écrit son INVERSE ; il ne passe pas s'il creusait un lot, ni deux fois", async () => {
    // La première entrée (lot 1, 100) est déjà partie en partie : l'annuler rendrait le lot négatif.
    const premiere = await prisma.promoStockMovement.findFirstOrThrow({ where: { itemId: article, kind: "RECEIPT" }, orderBy: { createdAt: "asc" } });
    await comme("dm");
    expect(await annulerMouvement(form({ mouvementId: premiere.id }))).toEqual({ ok: false, error: REFUS.superAdmin });
    await comme("sa");
    const creuse = await annulerMouvement(form({ mouvementId: premiere.id }));
    expect(creuse.ok).toBe(false);

    const entree = await entrerEnStock(form({ catalogueId: fiche, produitIds: [produit], quantite: "7", motif: "Saisie en double" }));
    expect(entree.ok).toBe(true);
    const m = await prisma.promoStockMovement.findFirstOrThrow({ where: { itemId: article, kind: "RECEIPT", delta: 7 } });
    const avant = await solde(null);
    const r = await annulerMouvement(form({ mouvementId: m.id, motif: "Doublon" }));
    expect(r.ok, r.error).toBe(true);
    expect(await solde(null)).toBe(avant - 7);
    expect(await prisma.promoStockMovement.count({ where: { id: m.id } }), "l'original reste, marqué annulé").toBe(1);
    expect((await annulerMouvement(form({ mouvementId: m.id }))).ok, "un mouvement ne s'annule qu'une fois").toBe(false);

    // Le cas qui ISOLE la garde « déjà annulé » : une PERTE. Son inverse AJOUTE, donc le contrôle du
    // solde du lot ne la retient pas (c'est lui qui refusait la seconde annulation d'une ENTRÉE,
    // ci-dessus) ; sans la garde, la contrainte d'unicité de la base lèverait — une panne, pas un refus.
    const perte = await declarerPerte(form({ itemId: article, detenteurId: "", quantite: "1", motif: "Carton écrasé" }));
    expect(perte.ok, perte.error).toBe(true);
    const loss = await prisma.promoStockMovement.findFirstOrThrow({ where: { itemId: article, kind: "LOSS", reason: "Carton écrasé" } });
    // SANS MOTIF, un mouvement qui S'ANNULE est refusé et rien n'est écrit. Le motif est demandé APRÈS les
    // refus structurels (§118.18) : la seconde annulation, plus bas, dit « déjà annulé » sans en demander.
    expect(await annulerMouvement(form({ mouvementId: loss.id }))).toEqual({ ok: false, error: MOTIF_ANNULATION_MOUVEMENT });
    expect(await prisma.promoStockMovement.count({ where: { annuleId: loss.id } })).toBe(0);
    expect((await annulerMouvement(form({ mouvementId: loss.id, motif: "Retrouvé" }))).ok).toBe(true);
    expect(await annulerMouvement(form({ mouvementId: loss.id }))).toEqual({ ok: false, error: "Ce mouvement est déjà annulé." });
  });

  it("corriger un inventaire : la directrice au magasin, le Super Admin chez une personne, jamais le délégué", async () => {
    await comme("k1");
    expect(await corrigerInventaire(form({ itemId: article, detenteurId: ids.k1!, compte: "99", motif: "x" }))).toEqual({ ok: false, error: REFUS.correction });
    await comme("dm");
    expect(await corrigerInventaire(form({ itemId: article, detenteurId: ids.k1!, compte: "14", motif: "x" }))).toEqual({ ok: false, error: REFUS.correction });
    const r = await corrigerInventaire(form({ itemId: article, detenteurId: "", compte: "90", motif: "Comptage du 1er octobre" }));
    expect(r.ok, r.error).toBe(true);
    expect(await solde(null)).toBe(90);
    await comme("sa");
    const p = await corrigerInventaire(form({ itemId: article, detenteurId: ids.k1!, compte: "14", motif: "Comptage terrain" }));
    expect(p.ok, p.error).toBe(true);
    expect(await solde(ids.k1!)).toBe(14);
  });

  it("une demande au magasin : servie en dotation, refusée avec motif, annulée par son auteur", async () => {
    await comme("k2");
    const d = await demanderMateriel(form({ itemId: article, quantite: "5", note: "Congrès" }));
    expect(d.ok, d.error).toBe(true);
    await comme("pm2");
    expect((await servirDemande(form({ demandeId: d.id! }))).ok).toBe(false);
    await comme("dm");
    const s = await servirDemande(form({ demandeId: d.id! }));
    expect(s.ok, s.error).toBe(true);
    const t = await transfertDe(s.id!);
    expect(t.demandeId).toBe(d.id);
    await comme("k2");
    expect((await confirmerReception(form({ transfertId: t.id }))).ok).toBe(true);
    expect(await solde(ids.k2!)).toBe(13);

    const d2 = await demanderMateriel(form({ itemId: article, quantite: "500" }));
    await comme("dm");
    expect((await refuserDemande(form({ demandeId: d2.id! }))).ok, "un refus sans motif ne part pas").toBe(false);
    expect((await refuserDemande(form({ demandeId: d2.id!, note: "Réservé au congrès" }))).ok).toBe(true);

    await comme("k2");
    const d3 = await demanderMateriel(form({ itemId: article, quantite: "2" }));
    await comme("dm");
    expect((await annulerDemande(form({ demandeId: d3.id! }))).ok, "le magasin refuse une demande avec un motif ; il ne l'annule pas").toBe(false);
    await comme("k2");
    expect((await annulerDemande(form({ demandeId: d3.id! }))).ok).toBe(true);
    await comme("fin");
    expect((await demanderMateriel(form({ itemId: article, quantite: "1" }))).ok, "un droit en lecture ne demande pas").toBe(false);
  });

  it("la fiche d'un article : une clé omise garde sa valeur ; on n'archive pas un article qui a du stock", async () => {
    await comme("dm");
    expect((await modifierArticleStock(form({ id: article, location: "Étagère B3", alertThreshold: "20", notes: "Fragile" }))).ok).toBe(true);
    // Le formulaire qui ne montre que les notes ne doit pas effacer l'emplacement ni le seuil.
    expect((await modifierArticleStock(form({ id: article, notes: "Très fragile" }))).ok).toBe(true);
    const lu = await prisma.promoStockItem.findUniqueOrThrow({ where: { id: article }, select: { location: true, alertThreshold: true, notes: true } });
    expect(lu.location).toBe("Étagère B3");
    expect(Number(lu.alertThreshold)).toBe(20);
    expect(lu.notes).toBe("Très fragile");
    const archive = await modifierArticleStock(form({ id: article, isActive: "false" }));
    expect(archive.ok).toBe(false);
    expect(archive.error).toMatch(/archive/);
  });

  it("la corbeille REFUSE un article qui a servi, avant le clic ; un article jamais utilisé se supprime", async () => {
    expect(await DELETE_REGISTRY.PROMO_CATALOGUE.refuse!(fiche)).toMatch(/Archivez-le/);
    expect(await DELETE_REGISTRY.PROMO_STOCK_ITEM.refuse!(article)).toMatch(/histoire/);
    const neuf = await prisma.promoCatalogueArticle.findFirstOrThrow({ where: { nom: `${TAG}Bloc-notes A5` }, select: { id: true } });
    expect(await DELETE_REGISTRY.PROMO_CATALOGUE.refuse!(neuf.id), "un article jamais cité par un stock se supprime").toBeNull();
  });

  it("au troisième jour, une relance — une seule — vers celui qui doit confirmer", async () => {
    await comme("dm");
    const r = await doter(form({ itemId: article, versId: ids.k3!, quantite: "3" }));
    expect(r.ok, r.error).toBe(true);
    await prisma.promoStockTransfer.update({ where: { id: r.id! }, data: { createdAt: new Date(Date.now() - (JOURS_AVANT_RAPPEL + 1) * 86_400_000) } });
    const avant = await prisma.notification.count({ where: { userId: ids.k3!, title: "Réception de matériel à confirmer" } });
    // Deux battements EN MÊME TEMPS (deux instances), FORCÉS à lire tous deux avant que l'un écrive,
    // puis un troisième : une seule relance — c'est l'écriture conditionnelle qui la tient.
    await sousBarriere("PromoStockTransfer", () => [relancerReceptionsStock(), relancerReceptionsStock()]);
    await relancerReceptionsStock();
    const apres = await prisma.notification.count({ where: { userId: ids.k3!, title: "Réception de matériel à confirmer" } });
    expect(apres - avant, "trois battements, une relance").toBe(1);
    expect((await transfertDe(r.id!)).rappelEnvoyeLe).not.toBeNull();
  });

  it("l'écran ne propose « Annuler » que sur ce que l'écrivain accepte d'annuler — jamais une jambe de transfert", async () => {
    const page = await chargerPageStock(await actorFor(ids.sa!));
    const a = page.articles.find((x) => x.id === article)!;
    const jambes = a.journal.filter((m) => m.kind.startsWith("TRANSFER"));
    expect(jambes.length, "le journal porte des transferts : sinon ce cas ne prouverait rien").toBeGreaterThan(0);
    expect(jambes.filter((m) => m.annulable), "un transfert s'annule en route, pas ligne par ligne").toEqual([]);
    expect(a.journal.some((m) => m.annulable), "une correction récente reste annulable par le Super Admin").toBe(true);
    const parDm = await chargerPageStock(await actorFor(ids.dm!));
    expect(parDm.articles.find((x) => x.id === article)!.journal.some((m) => m.annulable), "la directrice n'annule pas un mouvement").toBe(false);
  });

  it("la vue globale : parc = magasin + personnes + route, chaque unité comptée une fois", async () => {
    const page = await chargerPageStock(await actorFor(ids.ops!));
    const a = page.articles.find((x) => x.id === article)!;
    const registre = await prisma.promoStockMovement.aggregate({ where: { itemId: article }, _sum: { delta: true } });
    const enRoute = await prisma.promoStockTransfer.aggregate({ where: { itemId: article, statut: "EN_ROUTE" }, _sum: { quantite: true } });
    expect(a.total).toBe(Number(registre._sum.delta ?? 0));
    expect(a.enRoute).toBe(Number(enRoute._sum.quantite ?? 0));
    const somme = a.soldes.reduce((t, s) => t + s.quantite, 0);
    expect(Math.round(somme * 1000) / 1000, "les soldes visibles en vue globale additionnent le registre").toBe(a.total);
  });
});
