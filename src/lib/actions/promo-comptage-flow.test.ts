import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, moduleScope, userCan, type SessionUser } from "@/lib/rbac";
import { confirmerReception, declarerPerte, doter, entrerEnStock, modifierArticleStock } from "./promo-stock-actions";
import {
  annulerComptage, deciderRefonte, demanderComptage, planifierComptage, proposerRefonte, reprendreRecurrenceComptage,
  saisirComptage, suspendreRecurrenceComptage,
} from "./promo-comptage-actions";
import { chargerPageStock, faitsStock } from "@/lib/queries/promo-stock";
import { alerterStock, declencherComptagesRecurrents } from "@/lib/promo-stock-comptages";
import { articlesDuComptage, enregistrerSaisieComptage } from "@/lib/promo/comptages-ecriture";
import { REFUS_COMPTAGE } from "@/lib/promo/comptages";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__cpt__";

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

const JOUR = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const dansJours = (n: number) => { const a = new Date(); return ymd(new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate() + n))); };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * COMPTAGES, ALERTES, TABLEAU DE BORD, REFONTES — de bout en bout (§118.168), par les VRAIES
 * actions et le VRAI battement, avec des acteurs SANS vue globale (§118.104).
 *
 *   sa    Super Admin                 dm    directrice de la Direction Marketing (tient le magasin)
 *   ops   Directeur des Opérations    sup   superviseur sous ops        k1, k2  délégués sous sup
 *   sm    sous sup, SANS le module    ops2  un second directeur des opérations ; k3 sous lui
 *
 * Le battement est BORNÉ à ce banc (`seulement`) : sans la borne, il déclencherait les récurrences
 * et les alertes des autres bancs de la même base, et adresserait des demandes à des personnes qui
 * ne sont pas les siennes (§118.119d).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Stock promotionnel, étape 5 — comptages, récurrences, alertes, tableau de bord, refontes", () => {
  const ids: Record<string, string> = {};
  const emps: Record<string, string> = {};
  const art: Record<string, string> = {}; // articles de stock : fiche, stylo, bloc, kakemono, vieux
  const comptages: Record<string, string> = {};
  const recurrences: Record<string, string> = {};
  let lotFiche = "";
  let transfertKakemono = "";

  beforeAll(async () => {
    await nettoyer();
    const faire = (nom: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, role: role as never, passwordHash: "x" } });
    const [sa, dm, ops, ops2, sup, k1, k2, k3, sm] = await Promise.all([
      faire("sa", "SUPER_ADMIN"), faire("dm", "PRODUCT_MANAGER"), faire("ops", "OPERATIONS_DIRECTOR"), faire("ops2", "OPERATIONS_DIRECTOR"),
      faire("sup", "NATIONAL_SALES"), faire("k1", "MEDICAL_DELEGATE"), faire("k2", "MEDICAL_DELEGATE"), faire("k3", "MEDICAL_DELEGATE"),
      faire("sm", "HEAD_OF_REGULATORY"),
    ]);
    Object.assign(ids, { sa: sa.id, dm: dm.id, ops: ops.id, ops2: ops2.id, sup: sup.id, k1: k1.id, k2: k2.id, k3: k3.id, sm: sm.id });
    const emp = async (nom: string, userId: string, managerId?: string) => {
      const e = await prisma.employee.create({ data: { fullName: `${TAG}${nom}`, userId, managerId: managerId ?? null }, select: { id: true } });
      emps[nom] = e.id;
      return e.id;
    };
    await emp("dm", dm.id);
    const eOps = await emp("ops", ops.id);
    const eSup = await emp("sup", sup.id, eOps);
    await Promise.all([emp("k1", k1.id, eSup), emp("k2", k2.id, eSup), emp("sm", sm.id, eSup)]);
    const eOps2 = await emp("ops2", ops2.id);
    await emp("k3", k3.id, eOps2);

    const cat = (nom: string, famille: string) =>
      prisma.promoCatalogueArticle.create({ data: { reference: `${TAG}${nom}`, nom: `${TAG}${nom}`, famille: famille as never, unite: "pièce" }, select: { id: true } });
    const [fiche, stylo, bloc, kakemono, vieux] = await Promise.all([
      cat("Fiche", "CONSOMMABLE"), cat("Stylo", "CONSOMMABLE"), cat("Bloc", "CONSOMMABLE"), cat("Kakemono", "DURABLE"), cat("Vieux flyer", "CONSOMMABLE"),
    ]);
    ACTOR = await actorFor(sa.id);
    const entrer = async (catalogueId: string, quantite: string, extra: Record<string, string> = {}) => {
      const r = await entrerEnStock(form({ catalogueId, quantite, motif: "Banc des comptages", ...extra }));
      if (!r.ok) throw new Error(r.error);
      return r.id!;
    };
    art.fiche = await entrer(fiche.id, "300", { valableJusquau: dansJours(20) });
    art.stylo = await entrer(stylo.id, "100");
    art.bloc = await entrer(bloc.id, "10");
    art.kakemono = await entrer(kakemono.id, "5");
    art.vieux = await entrer(vieux.id, "10000", { coutUnitaire: "2" });
    lotFiche = (await prisma.promoStockLot.findFirstOrThrow({ where: { itemId: art.fiche } })).id;
    // DEUX ARRIVAGES ANCIENS, reçus il y a 200 jours : le vieux flyer n'est jamais sorti (dormant) ; la
    // fiche, elle, part aujourd'hui en dotation — c'est sa SORTIE qui la garde vivante, pas un arrivage
    // récent (sans cet antidatage, le banc n'éprouverait que la seconde règle).
    await prisma.promoStockLot.updateMany({ where: { itemId: { in: [art.vieux, art.fiche] } }, data: { recuLe: new Date(Date.now() - 200 * JOUR) } });

    // Les dotations, confirmées par celui qui reçoit (la vraie chaîne).
    ACTOR = await actorFor(dm.id);
    const d1 = await doter(form({ itemId: art.fiche, versId: k1.id, quantite: "100" }));
    const d2 = await doter(form({ itemId: art.stylo, versId: k1.id, quantite: "20" }));
    const d3 = await doter(form({ itemId: art.kakemono, versId: k2.id, quantite: "1" }));
    if (!d1.ok || !d2.ok || !d3.ok) throw new Error(`${d1.error ?? ""} ${d2.error ?? ""} ${d3.error ?? ""}`);
    transfertKakemono = d3.id!;
    ACTOR = await actorFor(k1.id);
    for (const t of [d1.id!, d2.id!]) {
      const r = await confirmerReception(form({ transfertId: t }));
      if (!r.ok) throw new Error(r.error);
    }
  });

  afterAll(async () => {
    await nettoyer();
  });

  async function nettoyer() {
    const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    const uids = users.map((u) => u.id);
    const cat = await prisma.promoCatalogueArticle.findMany({ where: { nom: { startsWith: TAG } }, select: { id: true } });
    const items = cat.length ? await prisma.promoStockItem.findMany({ where: { catalogueId: { in: cat.map((c) => c.id) } }, select: { id: true } }) : [];
    const cpts = uids.length
      ? await prisma.promoStockComptage.findMany({ where: { OR: [{ holderId: { in: uids } }, { demandeurId: { in: uids } }] }, select: { id: true } })
      : [];
    const miens = new Set([...items.map((i) => i.id), ...cpts.map((c) => c.id)]);
    const cles = (await prisma.promoStockAlerte.findMany({ select: { cle: true } })).map((c) => c.cle)
      .filter((cle) => miens.has(cle.split(":")[1] ?? "") || cle.includes(TAG));
    if (cles.length) await prisma.promoStockAlerte.deleteMany({ where: { cle: { in: cles } } });
    if (cpts.length) await prisma.promoStockComptage.deleteMany({ where: { id: { in: cpts.map((c) => c.id) } } });
    if (uids.length) await prisma.promoStockComptageRecurrence.deleteMany({ where: { OR: [{ auteurId: { in: uids } }, { holderId: { in: uids } }] } });
    if (items.length) await prisma.promoStockItem.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });
    await prisma.promoCatalogueArticle.deleteMany({ where: { nom: { startsWith: TAG } } });
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
  const solde = async (holderId: string | null, itemId: string) => {
    const r = await prisma.promoStockMovement.aggregate({ where: { itemId, holderId }, _sum: { delta: true } });
    return Number(r._sum.delta ?? 0);
  };
  const notifs = (qui: string, titre: string) => prisma.notification.count({ where: { userId: ids[qui]!, title: { contains: titre } } });
  const perimetre = () => ({ itemIds: Object.values(art), comptageIds: Object.values(comptages) });

  /** Forcer un entrelacement (§118.65) — même barrière que les bancs du stock (étapes 1 et 4). */
  async function sousBarriere<T>(table: string, lancer: () => Promise<T>[], attendus = 2): Promise<T[]> {
    let gestes: Promise<T>[] = [];
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "${table}" IN SHARE MODE`);
      gestes = lancer();
      for (const g of gestes) g.catch(() => undefined);
      const debut = Date.now();
      for (;;) {
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE '%PromoStock%'`;
        if (n >= attendus) break;
        if (Date.now() - debut > 10_000) {
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

  it("PRÉMISSES : ops dirige les opérations avec la vue globale ; sup voit sans gérer ; sm n'a pas le stock ; dm tient le magasin", async () => {
    const fOps = await faitsStock(await actorFor(ids.ops!));
    expect(fOps.directeurDesOperations).toBe(true);
    expect(fOps.vueGlobale).toBe(true);
    expect(fOps.module.modifier).toBe(true);
    expect([...fOps.equipe].sort()).toEqual([ids.sup, ids.k1, ids.k2, ids.sm].sort());
    const fSup = await faitsStock(await actorFor(ids.sup!));
    expect(fSup.directeurDesOperations, "un superviseur ne fait pas compter — sinon le refus ne prouverait rien").toBe(false);
    expect(fSup.equipe.has(ids.k1!)).toBe(true);
    for (const qui of ["k1", "k2", "sup"]) {
      expect(moduleScope(await actorFor(ids[qui]!), "PROMO_STOCK"), `${qui} sans vue globale`).not.toBe("ALL");
    }
    expect(userCan(await actorFor(ids.sm!), "PROMO_STOCK", "VIEW"), "sm n'a PAS le module").toBe(false);
    expect((await faitsStock(await actorFor(ids.dm!))).gereLeMagasin).toBe(true);
    expect(await solde(ids.k1!, art.fiche!)).toBe(100);
    expect(await solde(null, art.stylo!)).toBe(80);
  });

  it("demander : le directeur des opérations, pour SON équipe — pas un délégué, pas un superviseur, pas hors équipe, pas sans le stock", async () => {
    await comme("k1");
    expect(await demanderComptage(form({ cible: "PERSONNE", holderId: ids.k2!, famille: "" }))).toEqual({ ok: false, error: REFUS_COMPTAGE.demander });
    await comme("sup");
    expect(await demanderComptage(form({ cible: "PERSONNE", holderId: ids.k1!, famille: "" }))).toEqual({ ok: false, error: REFUS_COMPTAGE.demander });
    expect((await demanderComptage(form({ cible: "MAGASIN", famille: "" }))).ok, "un superviseur ne fait pas compter le magasin").toBe(false);
    await comme("ops");
    expect(await demanderComptage(form({ cible: "PERSONNE", holderId: ids.k3!, famille: "" }))).toEqual({ ok: false, error: REFUS_COMPTAGE.demander });
    const sansModule = await demanderComptage(form({ cible: "PERSONNE", holderId: ids.sm!, famille: "" }));
    expect(sansModule.ok).toBe(false);
    expect(sansModule.error).toMatch(/n'a pas accès au stock promotionnel, donc ne pourrait pas saisir son comptage/);
    const passe = await demanderComptage(form({ cible: "PERSONNE", holderId: ids.k1!, famille: "", echeance: ymd(new Date(Date.now() - 3 * JOUR)) }));
    expect(passe.ok, "une échéance passée n'est pas une échéance").toBe(false);

    const r = await demanderComptage(form({ cible: "PERSONNE", holderId: ids.k1!, famille: "CONSOMMABLE", echeance: dansJours(7), note: "Avant le séminaire" }));
    expect(r.ok, r.error).toBe(true);
    comptages.k1 = r.id!;
    const c = await prisma.promoStockComptage.findUniqueOrThrow({ where: { id: r.id! } });
    expect(c).toMatchObject({ holderId: ids.k1, famille: "CONSOMMABLE", demandeurId: ids.ops, statut: "DEMANDE", note: "Avant le séminaire" });
    expect(ymd(c.echeance)).toBe(dansJours(7));
    expect(await notifs("k1", "Comptage de stock demandé")).toBe(1);
  });

  it("pas deux comptages ouverts des mêmes articles ; « toute mon équipe » saute qui a déjà le sien et dit qui n'a pas le stock", async () => {
    await comme("ops");
    expect((await demanderComptage(form({ cible: "PERSONNE", holderId: ids.k1!, famille: "CONSOMMABLE" }))).error).toMatch(/déjà demandé/);
    expect((await demanderComptage(form({ cible: "PERSONNE", holderId: ids.k1!, famille: "" }))).ok, "« tout » recouvre les consommables").toBe(false);
    const r = await demanderComptage(form({ cible: "EQUIPE", famille: "" }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/2 comptage\(s\) demandé\(s\)/);
    expect(r.message).toMatch(/1 avai\(en\)t déjà un comptage ouvert/);
    expect(r.message).toMatch(/1 personne\(s\) de l'équipe n'ont pas accès au stock/);
    const ouverts = await prisma.promoStockComptage.findMany({ where: { demandeurId: ids.ops!, statut: "DEMANDE" }, select: { id: true, holderId: true } });
    expect(ouverts.map((o) => o.holderId).sort()).toEqual([ids.k1, ids.k2, ids.sup].sort());
    for (const o of ouverts) if (o.holderId === ids.k2) comptages.k2 = o.id; else if (o.holderId === ids.sup) comptages.sup = o.id;
  });

  it("saisir est une ATTESTATION : ni le demandeur, ni le Super Admin, ni un collègue ne comptent à la place de celui qui détient", async () => {
    for (const qui of ["ops", "sa", "k2", "dm"]) {
      await comme(qui);
      expect(await saisirComptage(form({ comptageId: comptages.k1!, itemId: [art.fiche!, art.stylo!], compte: ["1", "1"] })), qui)
        .toEqual({ ok: false, error: REFUS_COMPTAGE.saisir });
    }
  });

  it("la saisie se lit tout entière : article oublié, négatif, doublon, article d'une autre famille — refusés, et dits ensemble", async () => {
    await comme("k1");
    const oubli = await saisirComptage(form({ comptageId: comptages.k1!, itemId: [art.fiche!], compte: ["90"] }));
    expect(oubli.ok).toBe(false);
    expect(oubli.error).toMatch(/__cpt__Stylo/);
    const fautes = await saisirComptage(form({
      comptageId: comptages.k1!, itemId: [art.fiche!, art.stylo!, art.stylo!, art.kakemono!], compte: ["-1", "2", "3", "1"],
    }));
    expect(fautes.ok).toBe(false);
    expect(fautes.error).toMatch(/quantité illisible/);
    expect(fautes.error).toMatch(/apparaît deux fois/);
    expect(fautes.error, "un durable dans un comptage de consommables").toMatch(/__cpt__Kakemono » n'est pas un article qu'on peut compter ici/);
    expect(await prisma.promoStockComptageLigne.count({ where: { comptageId: comptages.k1! } }), "rien d'écrit").toBe(0);
  });

  it("l'écart se lit AU MOMENT DE LA SAISIE : une perte déclarée entre-temps n'est pas comptée deux fois ; un article trouvé entre dans un lot « retrouvé au comptage »", async () => {
    await comme("k1");
    const perte = await declarerPerte(form({ itemId: art.fiche!, detenteurId: ids.k1!, quantite: "10", motif: "Fiches mouillées" }));
    expect(perte.ok, perte.error).toBe(true);
    expect(await solde(ids.k1!, art.fiche!)).toBe(90);

    const r = await saisirComptage(form({
      comptageId: comptages.k1!, itemId: [art.fiche!, art.stylo!, art.bloc!], compte: ["85", "20", "3"], note: "Comptage du coffre",
    }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/3 article\(s\) comptés, 2 écart\(s\)/);
    const lignes = await prisma.promoStockComptageLigne.findMany({ where: { comptageId: comptages.k1! } });
    const ligne = (itemId: string) => lignes.find((l) => l.itemId === itemId)!;
    // Contre le solde du jour de la DEMANDE (100), l'écart serait −15 et retirerait les 10 fiches perdues une seconde fois.
    expect([Number(ligne(art.fiche!).attendu), Number(ligne(art.fiche!).compte), Number(ligne(art.fiche!).ecart)]).toEqual([90, 85, -5]);
    expect(Number(ligne(art.stylo!).ecart)).toBe(0);
    expect([Number(ligne(art.bloc!).attendu), Number(ligne(art.bloc!).ecart)]).toEqual([0, 3]);
    expect(await solde(ids.k1!, art.fiche!)).toBe(85);
    expect(await solde(ids.k1!, art.bloc!)).toBe(3);
    const mouvements = await prisma.promoStockMovement.findMany({ where: { comptageId: comptages.k1! }, select: { itemId: true, kind: true, delta: true } });
    // `every` sur une liste vide est VRAI : d'abord exiger que les mouvements soient là (§118.17).
    expect([...new Set(mouvements.map((m) => m.itemId))].sort(), "les deux écarts, et eux seuls, portent le comptage").toEqual([art.fiche!, art.bloc!].sort());
    expect(mouvements.every((m) => m.kind === "CORRECTION"), "chaque écart est une correction qui porte le comptage").toBe(true);
    expect(mouvements.filter((m) => m.itemId === art.stylo!), "un écart nul n'écrit rien").toHaveLength(0);
    expect(mouvements.filter((m) => m.itemId === art.fiche!).reduce((t, m) => t + Number(m.delta), 0)).toBe(-5);
    const lotTrouve = await prisma.promoStockLot.findFirstOrThrow({ where: { itemId: art.bloc!, origine: "CORRECTION" } });
    expect(lotTrouve.libelle).toBe("Retrouvé au comptage");
    const c = await prisma.promoStockComptage.findUniqueOrThrow({ where: { id: comptages.k1! } });
    expect(c.statut).toBe("SAISI");
    expect(c.saisiParId).toBe(ids.k1);
    expect(await notifs("ops", "Comptage saisi"), "le demandeur reçoit le résultat").toBe(1);
    const encore = await saisirComptage(form({ comptageId: comptages.k1!, itemId: [art.fiche!, art.stylo!, art.bloc!], compte: ["1", "1", "1"] }));
    expect(encore).toEqual({ ok: false, error: "Ce comptage est déjà saisi." });
  });

  it("deux saisies SIMULTANÉES du même comptage : une seule s'applique, l'autre le dit — jamais deux corrections", async () => {
    // k2 n'a rien en main (sa dotation est en route) : il déclare 2 stylos trouvés.
    await comme("k2");
    const saisie = () => saisirComptage(form({ comptageId: comptages.k2!, itemId: [art.stylo!], compte: ["2"] }));
    const [a, b] = await sousBarriere("PromoStockComptage", () => [saisie(), saisie()]);
    const resultats = [a!, b!];
    expect(resultats.filter((x) => x.ok), JSON.stringify(resultats)).toHaveLength(1);
    expect(resultats.find((x) => !x.ok)!.error).toMatch(/n'est plus à faire/);
    expect(await solde(ids.k2!, art.stylo!), "deux saisies, une correction").toBe(2);
    expect(await prisma.promoStockComptageLigne.count({ where: { comptageId: comptages.k2! } })).toBe(1);
  });

  it("annuler : le demandeur, avec un motif ; le détenteur en est prévenu ; un comptage annulé ne se saisit plus", async () => {
    await comme("k1");
    expect(await annulerComptage(form({ comptageId: comptages.sup!, motif: "x" }))).toEqual({ ok: false, error: REFUS_COMPTAGE.annuler });
    await comme("ops");
    expect((await annulerComptage(form({ comptageId: comptages.sup! }))).ok, "sans motif").toBe(false);
    const r = await annulerComptage(form({ comptageId: comptages.sup!, motif: "Inventaire fait la semaine dernière" }));
    expect(r.ok, r.error).toBe(true);
    expect(await notifs("sup", "Comptage annulé")).toBe(1);
    expect((await annulerComptage(form({ comptageId: comptages.sup!, motif: "encore" }))).error).toMatch(/n'est plus à faire/);
    await comme("sup");
    expect((await saisirComptage(form({ comptageId: comptages.sup!, itemId: [], compte: [] }))).error).toMatch(/annulé/);
  });

  it("le magasin se compte par sa gestionnaire — et la saisie partielle est refusée en nommant ce qui manque", async () => {
    await comme("ops");
    const r = await demanderComptage(form({ cible: "MAGASIN", famille: "CONSOMMABLE" }));
    expect(r.ok, r.error).toBe(true);
    comptages.magasin = r.id!;
    expect(await notifs("dm", "Comptage de stock demandé"), "la gestionnaire du magasin est prévenue").toBe(1);
    await comme("k1");
    expect(await saisirComptage(form({ comptageId: comptages.magasin, itemId: [art.stylo!], compte: ["1"] }))).toEqual({ ok: false, error: REFUS_COMPTAGE.saisir });
    await comme("dm");
    // LA PARTITION de l'action est celle du formulaire : nos articles du magasin y sont attendus.
    const { attendus } = await articlesDuComptage(ids.dm!, null, "CONSOMMABLE");
    for (const id of [art.fiche!, art.stylo!, art.bloc!, art.vieux!]) expect(attendus, id).toContain(id);
    // LE JUGE NE LIT PAS LE MAGASIN DES AUTRES BANCS (§118.92) : la base est partagée, le refus ne nomme
    // que TROIS oubliés, dans l'ordre de la base — attendre notre fiche parmi eux mesurait le voisinage
    // (tombé le 02/10, six oubliés dont trois d'un autre banc). On envoie donc TOUTE la partition sauf
    // notre fiche : le refus doit nommer la fiche, et jamais un article envoyé. Refusée, la saisie
    // n'écrit RIEN — les articles des autres bancs n'y sont pas corrigés.
    const envoyes = attendus.filter((id) => id !== art.fiche!);
    const partiel = await saisirComptage(form({
      comptageId: comptages.magasin, itemId: envoyes, compte: envoyes.map((id) => (id === art.stylo! ? "78" : "0")),
    }));
    expect(partiel.ok).toBe(false);
    expect(partiel.error).toMatch(/__cpt__Fiche/);
    expect(partiel.error, "un article ENVOYÉ n'est pas un oubli").not.toMatch(/__cpt__Stylo|__cpt__Bloc|__cpt__Vieux/);
    expect(await solde(null, art.stylo!), "une saisie refusée ne corrige rien").toBe(80);
    expect(attendus, "un durable n'est pas dans un comptage de consommables").not.toContain(art.kakemono!);
    // L'ÉCRITURE au magasin, par l'écrivain (la saisie complète par l'action exigerait de compter aussi
    // le magasin des AUTRES bancs de cette base partagée — on ne corrige jamais leurs articles).
    const e = await enregistrerSaisieComptage({
      comptageId: comptages.magasin, holderId: null, lignes: [{ itemId: art.stylo!, compte: 78 }],
      libelles: new Map([[art.stylo!, "Stylo"]]), auteurId: ids.dm!, motif: "Comptage du magasin", maintenant: new Date(),
    });
    expect(e.ok && e.lignes[0]).toMatchObject({ attendu: 80, compte: 78, ecart: -2 });
    expect(await solde(null, art.stylo!)).toBe(78);
  });

  it("une récurrence repart seule — une fois, à son échéance, sans empiler ni rattraper", async () => {
    await comme("ops");
    const r = await planifierComptage(form({ cible: "PERSONNE", holderId: ids.k2!, famille: "CONSOMMABLE", frequence: "MENSUEL", premiereLe: dansJours(0), delaiJours: "5" }));
    expect(r.ok, r.error).toBe(true);
    recurrences.k2 = r.id!;
    const rec = await prisma.promoStockComptageRecurrence.findUniqueOrThrow({ where: { id: r.id! } });
    expect(rec.ancreLe.toISOString()).toBe(`${dansJours(0)}T07:00:00.000Z`);
    const seulement = [r.id!];

    const t1 = new Date(rec.ancreLe.getTime() + 3_600_000);
    const b1 = await declencherComptagesRecurrents(t1, { seulement });
    expect(b1).toMatchObject({ declenchees: 1, comptagesCrees: 1 });
    const c1 = await prisma.promoStockComptage.findFirstOrThrow({ where: { recurrenceId: r.id!, statut: "DEMANDE" } });
    expect(c1).toMatchObject({ holderId: ids.k2, famille: "CONSOMMABLE", demandeurId: ids.ops });
    expect(ymd(c1.echeance)).toBe(dansJours(5));
    const apres1 = await prisma.promoStockComptageRecurrence.findUniqueOrThrow({ where: { id: r.id! } });
    expect(apres1.prochaineLe.getTime()).toBeGreaterThan(t1.getTime());
    expect(apres1.nbDeclenchements).toBe(1);
    expect((await declencherComptagesRecurrents(t1, { seulement })).comptagesCrees, "pas due : rien").toBe(0);

    // ON N'EMPILE PAS : le comptage du mois dernier n'est pas saisi ; l'échéance avance, rien ne s'ajoute.
    const t2 = new Date(apres1.prochaineLe.getTime() + 3_600_000);
    const b2 = await declencherComptagesRecurrents(t2, { seulement });
    expect(b2).toMatchObject({ comptagesCrees: 0, dejaOuverts: 1 });
    expect(await prisma.promoStockComptage.count({ where: { recurrenceId: r.id! } })).toBe(1);

    // ON NE RATTRAPE PAS : cinq mois sans battement font UN comptage, et la prochaine date est à venir.
    await prisma.promoStockComptage.update({ where: { id: c1.id }, data: { statut: "ANNULE" } });
    await prisma.promoStockComptageRecurrence.update({ where: { id: r.id! }, data: { prochaineLe: new Date(Date.now() - 150 * JOUR) } });
    const maintenant = new Date();
    const b3 = await declencherComptagesRecurrents(maintenant, { seulement });
    expect(b3.comptagesCrees).toBe(1);
    const apres3 = await prisma.promoStockComptageRecurrence.findUniqueOrThrow({ where: { id: r.id! } });
    expect(apres3.prochaineLe.getTime()).toBeGreaterThan(maintenant.getTime());
    expect(apres3.prochaineLe.getTime() - maintenant.getTime(), "la PROCHAINE, pas une du passé").toBeLessThanOrEqual(32 * JOUR);
  });

  it("deux battements SIMULTANÉS sur une récurrence due : un seul comptage", async () => {
    const rid = recurrences.k2!;
    await prisma.promoStockComptage.updateMany({ where: { recurrenceId: rid, statut: "DEMANDE" }, data: { statut: "ANNULE" } });
    await prisma.promoStockComptageRecurrence.update({ where: { id: rid }, data: { prochaineLe: new Date(Date.now() - JOUR) } });
    const avant = await prisma.promoStockComptage.count({ where: { recurrenceId: rid } });
    const maintenant = new Date();
    const [a, b] = await sousBarriere("PromoStockComptageRecurrence", () => [
      declencherComptagesRecurrents(maintenant, { seulement: [rid] }), declencherComptagesRecurrents(maintenant, { seulement: [rid] }),
    ]);
    expect(a!.comptagesCrees + b!.comptagesCrees).toBe(1);
    expect(await prisma.promoStockComptage.count({ where: { recurrenceId: rid } })).toBe(avant + 1);
    // C'est la PRISE qui arrête le second, pas le garde-fou d'empilement : sans elle, il irait jusqu'à
    // regarder les comptages ouverts — et ne serait arrêté que si le premier avait déjà écrit le sien.
    expect(a!.dejaOuverts + b!.dejaOuverts, "le second passage s'arrête à la prise").toBe(0);
  });

  it("l'AUTORITÉ est relue à chaque déclenchement : k2 sorti de l'équipe, la récurrence se met en pause — et reprend, sans rattrapage", async () => {
    const rid = recurrences.k2!;
    await prisma.promoStockComptage.updateMany({ where: { recurrenceId: rid, statut: "DEMANDE" }, data: { statut: "ANNULE" } });
    await prisma.employee.update({ where: { id: emps.k2! }, data: { managerId: null } });
    await prisma.promoStockComptageRecurrence.update({ where: { id: rid }, data: { prochaineLe: new Date(Date.now() - JOUR) } });
    const avant = await prisma.promoStockComptage.count({ where: { recurrenceId: rid } });
    const b = await declencherComptagesRecurrents(new Date(), { seulement: [rid] });
    expect(b).toMatchObject({ suspendues: 1, comptagesCrees: 0 });
    const rec = await prisma.promoStockComptageRecurrence.findUniqueOrThrow({ where: { id: rid } });
    expect(rec.actif, "en PAUSE, jamais supprimée").toBe(false);
    expect(rec.pauseMotif).toMatch(/__cpt__k2 n'est plus dans les équipes de son auteur/);
    expect(await prisma.promoStockComptage.count({ where: { recurrenceId: rid } })).toBe(avant);
    expect(await notifs("ops", "Comptage récurrent suspendu")).toBe(1);

    // La reprise relit l'autorité TOUT DE SUITE : refusée tant que k2 n'est pas revenu.
    await comme("ops");
    expect((await reprendreRecurrenceComptage(form({ recurrenceId: rid }))).error).toMatch(/n'a plus le droit/);
    await prisma.employee.update({ where: { id: emps.k2! }, data: { managerId: emps.sup! } });
    const rep = await reprendreRecurrenceComptage(form({ recurrenceId: rid }));
    expect(rep.ok, rep.error).toBe(true);
    const repris = await prisma.promoStockComptageRecurrence.findUniqueOrThrow({ where: { id: rid } });
    expect(repris.actif).toBe(true);
    expect(repris.pauseMotif).toBeNull();
    expect(repris.prochaineLe.getTime(), "pas de rattrapage : la prochaine date à venir").toBeGreaterThan(Date.now());

    // Seul l'auteur (ou le Super Admin) gère la récurrence.
    await comme("k1");
    expect(await suspendreRecurrenceComptage(form({ recurrenceId: rid }))).toEqual({ ok: false, error: REFUS_COMPTAGE.recurrence });
    await comme("sa");
    expect((await suspendreRecurrenceComptage(form({ recurrenceId: rid }))).ok).toBe(true);
  });

  it("« toute mon équipe » se relit à chaque fois ; un auteur parti n'a plus d'autorité — rien ne part « au nom de personne »", async () => {
    await comme("ops2");
    const r = await planifierComptage(form({ cible: "EQUIPE", famille: "DURABLE", frequence: "HEBDOMADAIRE", premiereLe: dansJours(0) }));
    expect(r.ok, r.error).toBe(true);
    recurrences.ops2 = r.id!;
    await prisma.promoStockComptageRecurrence.update({ where: { id: r.id! }, data: { prochaineLe: new Date(Date.now() - 60_000) } });
    // sm (SANS le stock) rejoint l'équipe d'ops2 le temps du déclenchement : il ne reçoit rien — il ne
    // pourrait pas saisir, et un comptage qu'on ne peut pas saisir passerait en retard pour toujours.
    await prisma.employee.update({ where: { id: emps.sm! }, data: { managerId: emps.ops2! } });
    let b: Awaited<ReturnType<typeof declencherComptagesRecurrents>>;
    try {
      b = await declencherComptagesRecurrents(new Date(), { seulement: [r.id!] });
    } finally {
      await prisma.employee.update({ where: { id: emps.sm! }, data: { managerId: emps.sup! } });
    }
    expect(b.comptagesCrees).toBe(1);
    expect((await prisma.promoStockComptage.findMany({ where: { recurrenceId: r.id! }, select: { holderId: true } })).map((c) => c.holderId)).toEqual([ids.k3]);

    await prisma.user.update({ where: { id: ids.ops2! }, data: { isActive: false } });
    await prisma.promoStockComptageRecurrence.update({ where: { id: r.id! }, data: { prochaineLe: new Date(Date.now() - 60_000) } });
    const b2 = await declencherComptagesRecurrents(new Date(), { seulement: [r.id!] });
    expect(b2).toMatchObject({ suspendues: 1, comptagesCrees: 0 });
    expect((await prisma.promoStockComptageRecurrence.findUniqueOrThrow({ where: { id: r.id! } })).pauseMotif).toMatch(/n'existe plus ou n'est plus actif/);
    await prisma.user.update({ where: { id: ids.ops2! }, data: { isActive: true } });
  });

  it("les ALERTES : une fois, à l'entrée dans l'état — une notification par personne ; ré-armées quand l'état cesse", async () => {
    // L'état : stylo sous son seuil au magasin, fiche qui expire dans 20 jours (magasin ET k1), un
    // kakémono en route depuis 8 jours, un comptage en retard.
    await comme("dm");
    expect((await modifierArticleStock(form({ id: art.stylo!, alertThreshold: "100" }))).ok).toBe(true);
    await prisma.promoStockTransfer.update({ where: { id: transfertKakemono }, data: { createdAt: new Date(Date.now() - 8 * JOUR) } });
    await comme("ops");
    const tard = await demanderComptage(form({ cible: "PERSONNE", holderId: ids.k1!, famille: "DURABLE" }));
    expect(tard.ok, tard.error).toBe(true);
    comptages.tard = tard.id!;
    await prisma.promoStockComptage.update({ where: { id: tard.id! }, data: { echeance: new Date(Date.now() - 3 * JOUR) } });

    const avant = { dm: await notifs("dm", "Stock promotionnel"), k1: await notifs("k1", "Stock promotionnel"), ops: await notifs("ops", "Stock promotionnel") };
    // La clé d'un AUTRE banc (hors périmètre, état révolu) : une passe bornée ne la retire pas.
    const etrangere = `seuil:${TAG}etranger`;
    await prisma.promoStockAlerte.upsert({ where: { cle: etrangere }, create: { cle: etrangere, envoyeLe: new Date() }, update: {} });
    const b1 = await alerterStock(new Date(), { seulement: perimetre(), forcer: true });
    expect(await prisma.promoStockAlerte.count({ where: { cle: etrangere } }), "une passe bornée ne retire pas la clé d'un autre").toBe(1);
    await prisma.promoStockAlerte.delete({ where: { cle: etrangere } });
    const attendues = [
      `seuil:${art.stylo}`, `peremption:${art.fiche}:${lotFiche}:magasin`, `peremption:${art.fiche}:${lotFiche}:${ids.k1}`,
      `enroute:${art.kakemono}:${transfertKakemono}`, `comptage:${comptages.tard}`,
    ].sort();
    const cles = (await prisma.promoStockAlerte.findMany({ select: { cle: true } })).map((c) => c.cle)
      .filter((c) => Object.values(art).includes(c.split(":")[1] ?? "") || Object.values(comptages).includes(c.split(":")[1] ?? ""));
    expect(cles.sort()).toEqual(attendues);
    expect(b1.envoyees).toBe(5);
    // UNE notification par personne : dm (seuil + péremption au magasin + envoi en route), k1
    // (péremption chez lui + son comptage en retard), ops (le comptage qu'il a demandé).
    expect(await notifs("dm", "Stock promotionnel") - avant.dm).toBe(1);
    expect(await notifs("k1", "Stock promotionnel") - avant.k1).toBe(1);
    expect(await notifs("ops", "Stock promotionnel") - avant.ops).toBe(1);
    const k1Notif = await prisma.notification.findFirstOrThrow({ where: { userId: ids.k1!, title: { contains: "Stock promotionnel" } }, orderBy: { createdAt: "desc" } });
    expect(k1Notif.title).toBe("Stock promotionnel — 2 alertes");

    const b2 = await alerterStock(new Date(), { seulement: perimetre(), forcer: true });
    expect(b2).toMatchObject({ envoyees: 0, notifications: 0, rearmees: 0 });

    // RÉ-ARMER : le stylo repasse au-dessus du seuil → la clé se retire ; il retombe → l'alerte repart.
    await comme("sa");
    expect((await entrerEnStock(form({ catalogueId: (await prisma.promoStockItem.findUniqueOrThrow({ where: { id: art.stylo! } })).catalogueId, quantite: "50", motif: "Réassort" }))).ok).toBe(true);
    const b3 = await alerterStock(new Date(), { seulement: perimetre(), forcer: true });
    expect(b3.rearmees).toBe(1);
    expect(b3.envoyees).toBe(0);
    await comme("dm");
    expect((await doter(form({ itemId: art.stylo!, versId: ids.k1!, quantite: "40" }))).ok).toBe(true);
    const b4 = await alerterStock(new Date(), { seulement: perimetre(), forcer: true });
    expect(b4.envoyees, "retombé sous le seuil : l'alerte repart").toBe(1);
  });

  it("deux passes SIMULTANÉES : chaque alerte part une fois", async () => {
    const miennes = (await prisma.promoStockAlerte.findMany({ select: { cle: true } })).map((c) => c.cle)
      .filter((c) => Object.values(art).includes(c.split(":")[1] ?? "") || Object.values(comptages).includes(c.split(":")[1] ?? ""));
    await prisma.promoStockAlerte.deleteMany({ where: { cle: { in: miennes } } });
    const [a, b] = await sousBarriere("PromoStockAlerte", () => [
      alerterStock(new Date(), { seulement: perimetre(), forcer: true }), alerterStock(new Date(), { seulement: perimetre(), forcer: true }),
    ]);
    expect(a!.enVigueur).toBe(miennes.length);
    expect(a!.envoyees + b!.envoyees, JSON.stringify([a, b])).toBe(miennes.length);
  });

  it("le verrou de l'heure : un passage, puis rien jusqu'à l'heure suivante", async () => {
    await prisma.promoStockAlerte.upsert({ where: { cle: "__passage__" }, create: { cle: "__passage__", envoyeLe: new Date(Date.now() - 2 * 3_600_000) }, update: { envoyeLe: new Date(Date.now() - 2 * 3_600_000) } });
    const m = new Date();
    expect((await alerterStock(m, { seulement: perimetre() })).saute).toBe(false);
    expect((await alerterStock(new Date(m.getTime() + 60_000), { seulement: perimetre() })).saute).toBe(true);
  });

  it("le TABLEAU DE BORD : les alertes du battement, les dormants valorisés — et jamais pour un délégué", async () => {
    const pOps = await chargerPageStock(await actorFor(ids.ops!));
    expect(pOps.tableau).not.toBeNull();
    const clesOps = pOps.tableau!.alertes.map((a) => a.cle);
    expect(clesOps).toContain(`peremption:${art.fiche}:${lotFiche}:${ids.k1}`);
    expect(clesOps).toContain(`peremption:${art.fiche}:${lotFiche}:magasin`);
    const dormant = pOps.tableau!.dormants.find((d) => d.itemId === art.vieux);
    expect(dormant, "reçu il y a 200 jours, jamais sorti").toMatchObject({ quantite: 10000, valeur: 20000, derniereSortie: null });
    expect(pOps.tableau!.dormants.find((d) => d.itemId === art.fiche), "arrivée il y a 200 jours, sortie aujourd'hui : vivante").toBeUndefined();
    expect(pOps.tableau!.dormantsTotal, "le total compte au moins ce qui est montré").toBeGreaterThanOrEqual(pOps.tableau!.dormants.length);

    // LA GESTIONNAIRE DU MAGASIN A LA VUE GLOBALE PAR SON RÔLE — mesuré : une portée personnalisée ne
    // rétrécit pas une portée NATIVE (`getAccess`, rbac.ts). Le filtre de périmètre du tableau de bord
    // (`peutVoirStockDe` sur chaque alerte) n'a donc AUCUN acteur réel pour l'exercer aujourd'hui ; il
    // est tenu par la règle pure, dont les cas sont éprouvés. On l'écrit plutôt que de croire l'avoir
    // éprouvé ici (§118.82) — et si la règle des portées change, cette prémisse tombera la première.
    await prisma.userAccess.create({ data: { userId: ids.dm!, module: "PROMO_STOCK", canView: true, canCreate: true, canUpdate: true, scope: "ASSIGNED" } });
    expect((await faitsStock(await actorFor(ids.dm!))).vueGlobale, "une portée « lignes » ne rétrécit pas la vue native de la Direction Marketing").toBe(true);
    await prisma.userAccess.deleteMany({ where: { userId: ids.dm!, module: "PROMO_STOCK" } });
    const pDm = await chargerPageStock(await actorFor(ids.dm!));
    expect(pDm.tableau, "la gestionnaire du magasin a son tableau de bord").not.toBeNull();
    expect(pDm.tableau!.alertes.map((a) => a.cle)).toContain(`seuil:${art.stylo}`);

    const pK1 = await chargerPageStock(await actorFor(ids.k1!));
    expect(pK1.tableau, "un délégué n'a pas de tableau de bord").toBeNull();
    expect(pK1.comptages.some((c) => c.id === comptages.tard), "son comptage en retard lui est montré").toBe(true);
    expect(pK1.comptages.find((c) => c.id === comptages.tard)!.enRetard).toBe(true);
    expect(pK1.comptages.some((c) => c.id === comptages.k2), "le comptage d'un collègue ne lui est pas montré").toBe(false);
    expect(pOps.peutFaireCompter.map((p) => p.id).sort()).toEqual([ids.sup, ids.k1, ids.k2].sort());
  });

  it("une REFONTE se propose sur un durable, une fois ; la Direction Marketing la tranche, et la personne en est prévenue", async () => {
    await comme("k1");
    expect(await proposerRefonte(form({ itemId: art.stylo!, motif: "Encre pâle" }))).toEqual({ ok: false, error: REFUS_COMPTAGE.refonte });
    expect((await proposerRefonte(form({ itemId: art.kakemono! }))).ok, "sans motif").toBe(false);
    const r = await proposerRefonte(form({ itemId: art.kakemono!, motif: "Toile usée, visuel de 2024" }));
    expect(r.ok, r.error).toBe(true);
    expect((await proposerRefonte(form({ itemId: art.kakemono!, motif: "encore" }))).error).toMatch(/déjà proposé/);
    expect(await notifs("dm", "Refonte proposée")).toBe(1);
    expect(await deciderRefonte(form({ refonteId: r.id!, decision: "RETENUE" }))).toEqual({ ok: false, error: REFUS_COMPTAGE.decider });
    await comme("dm");
    expect((await deciderRefonte(form({ refonteId: r.id!, decision: "ECARTEE" }))).ok, "écarter exige un mot").toBe(false);
    const ok = await deciderRefonte(form({ refonteId: r.id!, decision: "RETENUE", note: "Nouveau visuel au T1" }));
    expect(ok.ok, ok.error).toBe(true);
    expect(await prisma.promoStockRefonte.findUniqueOrThrow({ where: { id: r.id! } })).toMatchObject({ statut: "RETENUE", decideParId: ids.dm, noteDecision: "Nouveau visuel au T1" });
    expect(await notifs("k1", "Refonte retenue")).toBe(1);
    expect((await deciderRefonte(form({ refonteId: r.id!, decision: "ECARTEE", note: "x" }))).error).toMatch(/déjà tranchée/);
  });

  it("deux propositions SIMULTANÉES du même support (double clic) : une seule s'ouvre — c'est l'index partiel qui tient la règle", async () => {
    await comme("k2");
    const proposer = () => proposerRefonte(form({ itemId: art.kakemono!, motif: "Pieds cassés" }));
    // La barrière laisse passer les deux LECTURES (« rien d'ouvert ») et retient les deux créations :
    // sans l'index, les deux passeraient.
    const [a, b] = await sousBarriere("PromoStockRefonte", () => [proposer(), proposer()]);
    const resultats = [a!, b!];
    expect(resultats.filter((x) => x.ok), JSON.stringify(resultats)).toHaveLength(1);
    expect(resultats.find((x) => !x.ok)!.error).toMatch(/déjà proposé une refonte/);
    expect(await prisma.promoStockRefonte.count({ where: { itemId: art.kakemono!, auteurId: ids.k2!, statut: "OUVERTE" } })).toBe(1);
  });

  it("trancher une refonte se fait dans SON entité : la gestionnaire d'Adventum ne décide pas, par son identifiant, celle d'un support de Pharmagène", async () => {
    await comme("sa");
    const catB = await prisma.promoCatalogueArticle.create({
      data: { reference: `${TAG}Kakemono B`, nom: `${TAG}Kakemono B`, famille: "DURABLE", unite: "pièce" }, select: { id: true },
    });
    const e = await entrerEnStock(form({ catalogueId: catB.id, quantite: "2", motif: "Banc des comptages", companyId: "company_pharmagene" }));
    expect(e.ok, e.error).toBe(true);
    const p = await proposerRefonte(form({ itemId: e.id!, motif: "Visuel de l'ancienne marque" }));
    expect(p.ok, p.error).toBe(true);
    // dm RELÈVE d'Adventum : son périmètre d'entité est Adventum (et les lignes sans entité).
    await prisma.employee.update({ where: { id: emps.dm! }, data: { companyId: "company_adventum" } });
    try {
      await comme("dm");
      expect(await deciderRefonte(form({ refonteId: p.id!, decision: "RETENUE" })), "même phrase que l'absence")
        .toEqual({ ok: false, error: "Proposition introuvable." });
      expect((await prisma.promoStockRefonte.findUniqueOrThrow({ where: { id: p.id! } })).statut, "rien n'a bougé").toBe("OUVERTE");
      const pDm = await chargerPageStock(await actorFor(ids.dm!));
      expect(pDm.refontes.some((x) => x.id === p.id), "l'écran ne la lui montre pas non plus").toBe(false);
      // PRÉMISSE : le refus vient bien du PÉRIMÈTRE, pas de son rattachement — dans le même état, elle
      // tranche la proposition de k2 sur un support de son périmètre.
      const deK2 = await prisma.promoStockRefonte.findFirstOrThrow({ where: { itemId: art.kakemono!, auteurId: ids.k2!, statut: "OUVERTE" } });
      expect(pDm.refontes.some((x) => x.id === deK2.id)).toBe(true);
      const ok = await deciderRefonte(form({ refonteId: deK2.id, decision: "RETENUE" }));
      expect(ok.ok, ok.error).toBe(true);
    } finally {
      await prisma.employee.update({ where: { id: emps.dm! }, data: { companyId: null } });
    }
    await comme("sa");
    expect((await deciderRefonte(form({ refonteId: p.id!, decision: "ECARTEE", note: "Hors périmètre du banc" }))).ok, "le Super Admin voit tout le groupe").toBe(true);
    // Un support ARCHIVÉ ne se refait pas : la proposition n'aurait plus d'objet.
    await prisma.promoStockItem.update({ where: { id: e.id! }, data: { isActive: false } });
    expect((await proposerRefonte(form({ itemId: e.id!, motif: "Encore" }))).error).toMatch(/archivé/);
  });
});
