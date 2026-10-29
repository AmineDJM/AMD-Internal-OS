import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, requireModule: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { addAdProItem, deleteAdProItem, submitAdProItem, updateAdProItem, setAdProItemBudget, linkPromoMaterial, requestAdProItemOrder, demanderPieceSecretariat } from "./actions-postes";
import { decideAdProItem } from "./actions-postes-decision";
import { demanderPaiementPoste, ajouterDevisPoste } from "./actions-postes-paiement";
import { ajouterArticleStockAuPoste, confirmerMaterielStock } from "./actions-postes-materiel";
import { cloturerSponsoring } from "./actions-sponsoring";
import { transferAdProRequest } from "./actions-transfert";
import { annulerMouvement } from "@/lib/actions/promo-stock-actions";
import { entrerLot, sousVerrou, trouverOuCreerArticle } from "@/lib/promo/stock-ecriture";
import { REFUS_CONFIRMATION_MATERIEL } from "@/lib/promo/reservations";
import { bilanCloture } from "./domaine/cloture-sponsoring";
import { contexteMaterielStock, postesPourCloture } from "./infra/requetes/postes";
import { chargerPageStock, gestionnairesDuMagasin } from "@/lib/queries/promo-stock";
import { inventorier } from "@/lib/suppression/lot";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__adprostock__";

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
 * LE MATÉRIEL DU STOCK D'UN ÉVÉNEMENT AD & PRO, DE BOUT EN BOUT (§118.167) — par les VRAIES
 * actions des postes, de la clôture, du transfert et de la corbeille.
 *
 *   dem   National Sales : il demande (sponsoring et congrès), il liste, il confirme après
 *   dir   Direction (vue globale) : elle décide des postes — l'accord RÉSERVE
 *   dm    directrice de la Direction Marketing : elle tient le magasin, le retour la prévient
 *   autre délégué médical : ni demandeur, ni magasin, ni décideur — et il ne VOIT pas CE sponsoring
 *   ns2   un autre National Sales : il voit la demande, sans être ni demandeur, ni magasin, ni décideur
 *   sa    Super Admin : clôture, transfert
 *
 * LE MAGASIN : 3 kakémonos (durables), 200 brochures en deux lots (2028 et 2030) plus 50 PÉRIMÉES,
 * 10 stylos, et un support numérique — qui ne se réserve pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Matériel du stock d'un événement — réserver à l'accord, confirmer après, le reste revient", () => {
  const ids: Record<string, string> = {};
  let kakemono = "", brochure = "", stylo = "", eadv = "";
  let lot2028 = "", lot2030 = "", lotPerime = "";
  let spo = "", congres = "";

  beforeAll(async () => {
    await nettoyer();
    const faire = (nom: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, role: role as never, passwordHash: "x" } });
    const [dem, dir, dm, autre, sa, ns2] = await Promise.all([
      faire("dem", "NATIONAL_SALES"), faire("dir", "DIRECTION"), faire("dm", "PRODUCT_MANAGER"),
      faire("autre", "MEDICAL_DELEGATE"), faire("sa", "SUPER_ADMIN"), faire("ns2", "NATIONAL_SALES"),
    ]);
    Object.assign(ids, { dem: dem.id, dir: dir.id, dm: dm.id, autre: autre.id, sa: sa.id, ns2: ns2.id });
    // La cheffe de la Direction Marketing se LIT sur l'organigramme : personne de son rôle au-dessus d'elle.
    await prisma.employee.create({ data: { fullName: `${TAG}dm`, userId: dm.id } });

    const cat = (ref: string, nom: string, famille: string) =>
      prisma.promoCatalogueArticle.create({ data: { reference: `${TAG}${ref}`, nom: `${TAG}${nom}`, famille: famille as never }, select: { id: true } });
    const [cK, cB, cS, cE] = await Promise.all([
      cat("K", "Kakémono", "DURABLE"), cat("B", "Brochure", "CONSOMMABLE"), cat("S", "Stylo", "CONSOMMABLE"), cat("E", "e-ADV", "NUMERIQUE"),
    ]);
    const article = async (catalogueId: string, nom: string) =>
      (await trouverOuCreerArticle({ companyId: null, catalogueId, produitIds: [], nom: `${TAG}${nom}`, unite: "pièce", materialType: null, auteurId: dm.id })).id;
    kakemono = await article(cK.id, "Kakémono");
    brochure = await article(cB.id, "Brochure");
    stylo = await article(cS.id, "Stylo");
    eadv = await article(cE.id, "e-ADV");

    const entrer = async (itemId: string, quantite: number, valableJusquau: Date | null) => {
      const r = await sousVerrou(itemId, (tx) => entrerLot(tx, itemId, {
        holderId: null, quantite, kind: "OPENING", origine: "OUVERTURE", valableJusquau, auteurId: dm.id,
      }));
      if ("refus" in r) throw new Error(String(r.refus));
      return r.lotId;
    };
    await entrer(kakemono, 3, null);
    lot2028 = await entrer(brochure, 100, new Date("2028-06-30"));
    lot2030 = await entrer(brochure, 100, new Date("2030-06-30"));
    lotPerime = await entrer(brochure, 50, new Date("2020-01-01"));
    await entrer(stylo, 10, null);

    spo = (await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}SPO-1`, institution: `${TAG}Société algérienne d'oncologie`, type: "Congrès", status: "PRE_VALIDATED", requesterId: dem.id },
      select: { id: true },
    })).id;
    congres = (await prisma.congressNational.create({
      data: { name: `${TAG}Journées d'hématologie`, requestStatus: "APPROVED", requesterId: dem.id },
      select: { id: true },
    })).id;
  });

  afterAll(async () => {
    await nettoyer();
  });

  async function nettoyer() {
    const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    const uids = users.map((u) => u.id);
    const spos = await prisma.sponsoringRequest.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } });
    const congs = await prisma.congressNational.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    // Les postes d'abord (ils emportent leurs lignes) — les lignes visent les articles en RESTRICT.
    await prisma.adProItem.deleteMany({ where: { OR: [{ sponsoringId: { in: spos.map((s) => s.id) } }, { congressNationalId: { in: congs.map((c) => c.id) } }] } });
    await prisma.sponsoringRequest.deleteMany({ where: { id: { in: spos.map((s) => s.id) } } });
    await prisma.congressNational.deleteMany({ where: { id: { in: congs.map((c) => c.id) } } });
    const cat = await prisma.promoCatalogueArticle.findMany({ where: { nom: { startsWith: TAG } }, select: { id: true } });
    if (cat.length) await prisma.promoStockItem.deleteMany({ where: { catalogueId: { in: cat.map((c) => c.id) } } });
    await prisma.promoCatalogueArticle.deleteMany({ where: { nom: { startsWith: TAG } } });
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } });
    if (uids.length) {
      await prisma.notification.deleteMany({ where: { userId: { in: uids } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: uids } } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: { in: uids } } });
  }

  const comme = async (qui: string) => { ACTOR = await actorFor(ids[qui]!); };
  const magasin = async (itemId: string, lotId?: string) => {
    const r = await prisma.promoStockMovement.aggregate({ where: { itemId, holderId: null, ...(lotId ? { lotId } : {}) }, _sum: { delta: true } });
    return Number(r._sum.delta ?? 0);
  };
  const lignesDe = (itemId: string) => prisma.adProStockLine.findMany({ where: { itemId }, orderBy: { createdAt: "asc" } });
  const statutPoste = async (itemId: string) => (await prisma.adProItem.findUniqueOrThrow({ where: { id: itemId } })).status;
  const nouveauPoste = async (label: string, parent: "SPONSORING" | "CONGRESS_NATIONAL" = "SPONSORING", parentId = spo) => {
    const r = await addAdProItem(undefined, form({ parent, parentId, kind: "STOCK_MATERIAL", label: `${TAG}${label}` }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    return r.ok ? (r.id ?? "") : "";
  };
  const lister = (itemId: string, stockItemId: string, quantite: string) => ajouterArticleStockAuPoste(form({ itemId, stockItemId, quantite }));
  const decider = (id: string, decision: "APPROVED" | "REJECTED" | "REVISION", note = "") => decideAdProItem(undefined, form({ id, decision, note }));

  /**
   * FORCER UN ENTRELACEMENT (§118.65, §118.164e) — la barrière bloque les ÉCRITURES du registre
   * sans bloquer ses lectures, attend que les gestes soient bloqués, puis relâche.
   */
  async function sousBarriere<T>(lancer: () => Promise<T>[], attendus = 2): Promise<T[]> {
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
            AND wait_event_type = 'Lock' AND query ILIKE ANY(${["%PromoStock%"]}::text[])`;
        if (n >= attendus) break;
        if (Date.now() - debut > 10_000) throw new Error(`les gestes n'ont pas atteint la barrière (${n} en attente sur ${attendus})`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }, { timeout: 20_000 });
    return Promise.all(gestes);
  }

  it("PRÉMISSES : qui demande, qui décide, qui tient le magasin, et qui n'est rien de tout cela", async () => {
    const dem = await actorFor(ids.dem!);
    expect(userCan(dem, "SPONSORING", "CREATE") || userCan(dem, "SPONSORING", "UPDATE"), "le demandeur décrit les postes").toBe(true);
    expect(hasGlobalView(dem) || userCan(dem, "SPONSORING", "VALIDATE"), "le demandeur ne décide pas — sinon la règle de confirmation ne prouverait rien").toBe(false);
    expect(hasGlobalView(await actorFor(ids.dir!)), "la Direction décide des postes").toBe(true);
    expect(await gestionnairesDuMagasin(), "la directrice marketing tient le magasin").toContain(ids.dm);
    const autre = await actorFor(ids.autre!);
    expect(hasGlobalView(autre) || userCan(autre, "SPONSORING", "VALIDATE")).toBe(false);
    expect(await gestionnairesDuMagasin()).not.toContain(ids.autre);
    // Les deux INTRUS ne se ressemblent pas, et c'est ce qui fait deux cas (§118.175) : le délégué
    // ne VOIT PAS la demande, le second National Sales la voit — sans pouvoir confirmer. Sans cette
    // prémisse, le refus de la règle de confirmation pourrait venir de la porte de ligne, et le cas
    // ne la garderait plus.
    //
    // Depuis le lot B de l'audit 360° (§118.185, I4), le délégué A le module Sponsoring — en portée
    // « ses demandes ». La prémisse se lit donc sur CETTE demande, déposée par un autre, et non sur
    // le module : la juger par le module la rendait fausse sans que le cas cesse d'avoir raison.
    expect(await canAccessEntity(autre, "SPONSORING", spo, "VIEW"), "le délégué ne voit pas CE sponsoring").toBe(false);
    const ns2 = await actorFor(ids.ns2!);
    expect(userCan(ns2, "SPONSORING", "VIEW"), "le second National Sales voit le sponsoring").toBe(true);
    expect(hasGlobalView(ns2) || userCan(ns2, "SPONSORING", "VALIDATE")).toBe(false);
    expect(await gestionnairesDuMagasin()).not.toContain(ids.ns2);
    expect([await magasin(brochure), await magasin(kakemono), await magasin(stylo)]).toEqual([250, 3, 10]);
  });

  let poste1 = "";
  it("UN POSTE « MATÉRIEL DU STOCK » NE PORTE PAS D'ARGENT — un montant à l'ajout est refusé", async () => {
    await comme("dem");
    const r = await addAdProItem(undefined, form({ parent: "SPONSORING", parentId: spo, kind: "STOCK_MATERIAL", label: `${TAG}Avec montant`, amountEstimated: "5000" }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/n'engage pas d'argent : un montant n'y a pas d'objet/);
    poste1 = await nouveauPoste("Matériel du stand");
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: poste1 } })).amountEstimated).toBeNull();
  });

  it("SOUMETTRE SANS ARTICLE est refusé — c'est la liste, pas un montant, qui se décide", async () => {
    await comme("dem");
    const r = await submitAdProItem(undefined, form({ id: poste1 }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/Ajoutez au moins un article du stock/);
  });

  it("LISTER ne bouge RIEN au magasin ; un support numérique ne se réserve pas", async () => {
    await comme("dem");
    expect((await lister(poste1, brochure, "150")).ok).toBe(true);
    expect((await lister(poste1, kakemono, "2")).ok).toBe(true);
    const num = await lister(poste1, eadv, "1");
    expect(num.ok).toBe(false);
    expect(num.ok ? "" : num.error).toMatch(/support numérique se présente/);
    expect(await magasin(brochure), "une liste est une demande, pas une confiscation").toBe(250);
    expect((await lignesDe(poste1)).map((l) => l.statut)).toEqual(["DEMANDEE", "DEMANDEE"]);
    // Le panneau propose le magasin, distribuable SANS les périmés, et pas le numérique.
    const ctx = await contexteMaterielStock(await actorFor(ids.dem!), "SPONSORING", spo, false);
    const b = ctx.magasin.find((a) => a.itemId === brochure);
    expect(b?.distribuable, "les 50 périmées ne se proposent pas").toBe(200);
    expect(ctx.magasin.map((a) => a.itemId)).not.toContain(eadv);
    expect(ctx.peutConfirmer, "le demandeur confirmera après l'événement").toBe(true);
    expect((await contexteMaterielStock(await actorFor(ids.autre!), "SPONSORING", spo, false)).peutConfirmer).toBe(false);
  });

  it("LES GESTES D'ARGENT sont refusés sur un poste de stock — et sa nature ne se perd pas avec des lignes", async () => {
    // LES PIÈCES ET LE PAIEMENT DE §118.204 sont des gestes d'argent comme les autres : un poste de
    // stock n'a ni devis, ni facture. Joints AVEC un fichier, pour que le refus ne puisse venir que de
    // la nature du poste — sans pièce, ils refuseraient pour une autre raison.
    const avecFichier = (champs: Record<string, string>) => {
      const f = form(champs);
      f.append("attachment", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], "piece.pdf", { type: "application/pdf" }));
      return f;
    };
    await comme("dir");
    const refus = [
      await requestAdProItemOrder(undefined, form({ id: poste1 })),
      await demanderPieceSecretariat(undefined, form({ id: poste1, nature: "DEVIS" })),
      await linkPromoMaterial(undefined, form({ id: poste1, promoMaterialId: "x" })),
      await demanderPaiementPoste(undefined, avecFichier({ id: poste1, montant: "1000" })),
      await ajouterDevisPoste(undefined, avecFichier({ id: poste1, montant: "1000" })),
    ];
    // Le budget se choisit par qui tient le SECOND temps (§118.204) — la Direction Marketing ici : c'est
    // elle qu'on fait essayer, sans quoi le refus viendrait du droit et non de la nature du poste.
    await comme("dm");
    refus.push(await setAdProItemBudget(undefined, form({ id: poste1, budgetCategoryId: "x" })));
    for (const r of refus) {
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error).toMatch(/« Matériel du stock » n'engage pas d'argent/);
    }
    const nature = await updateAdProItem(undefined, form({ id: poste1, kind: "STAND" }));
    expect(nature.ok).toBe(false);
    expect(nature.ok ? "" : nature.error).toMatch(/retirez-les d'abord/);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: poste1 } })).kind).toBe("STOCK_MATERIAL");
  });

  it("L'ACCORD RÉSERVE : les brochures sortent du lot qui expire le plus tôt, jamais du périmé, et la ligne le porte", async () => {
    await comme("dem");
    expect((await submitAdProItem(undefined, form({ id: poste1 }))).ok).toBe(true);
    await comme("dir");
    // Un montant glissé dans l'accord (le formulaire générique le permet) ne se pose PAS sur du
    // matériel du stock : il remonterait dans le montant de la demande.
    const r = await decideAdProItem(undefined, form({ id: poste1, decision: "APPROVED", note: "", amountGranted: "5000" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(await statutPoste(poste1)).toBe("APPROVED");
    expect((await lignesDe(poste1)).map((l) => l.statut)).toEqual(["RESERVEE", "RESERVEE"]);
    expect(await magasin(brochure, lot2028), "le lot de 2028 part en premier").toBe(0);
    expect(await magasin(brochure, lot2030)).toBe(50);
    expect(await magasin(brochure, lotPerime), "un lot périmé ne se réserve jamais").toBe(50);
    expect(await magasin(kakemono)).toBe(1);
    const sorties = await prisma.promoStockMovement.findMany({ where: { adProLine: { itemId: poste1 } }, select: { kind: true } });
    expect(sorties.length).toBeGreaterThan(0);
    expect(sorties.every((m) => m.kind === "RESERVATION_OUT")).toBe(true);
    // Le poste accordé n'a pas reçu de montant : il n'en porte pas.
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: poste1 } })).amountGranted).toBeNull();
    // LE MAGASIN VOIT CE QUI EST DEHORS : sorti de son solde, chez personne, mais nommé avec sa demande.
    const pageDm = await chargerPageStock(await actorFor(ids.dm!));
    const dehors = pageDm.horsMagasin.filter((h) => h.lien === `/sponsoring/${spo}`);
    expect(dehors.map((h) => h.quantite).sort((a, b) => a - b)).toEqual([2, 150]);
    expect(dehors.every((h) => h.demande === `${TAG}SPO-1`)).toBe(true);
    const pageAutre = await chargerPageStock(await actorFor(ids.autre!));
    expect(pageAutre.horsMagasin, "qui ne voit pas le magasin ne voit pas ce qui en est sorti").toEqual([]);
    // Accordé, sa liste ne change plus : ajouter un article réservé sans accord n'existe pas.
    await comme("dem");
    const ajout = await lister(poste1, stylo, "1");
    expect(ajout.ok).toBe(false);
    expect(ajout.ok ? "" : ajout.error).toMatch(/accordé et son matériel réservé/);
  });

  it("DEUX ACCORDS AU MÊME INSTANT ne réservent qu'UNE fois — la liste est relue sous le verrou", async () => {
    await comme("dem");
    const p = await nouveauPoste("Stylos du hall");
    expect((await lister(p, stylo, "2")).ok).toBe(true);
    expect((await submitAdProItem(undefined, form({ id: p }))).ok).toBe(true);
    const dir = await actorFor(ids.dir!);
    const sa = await actorFor(ids.sa!);
    const [a, b] = await sousBarriere(() => {
      ACTOR = dir;
      const p1 = decider(p, "APPROVED");
      ACTOR = sa;
      const p2 = decider(p, "APPROVED");
      return [p1, p2];
    });
    expect(a.ok && b.ok, JSON.stringify([a, b])).toBe(true);
    expect(await magasin(stylo), "2 stylos réservés, pas 4").toBe(8);
    // Remis à zéro pour la suite : la révision rend la réservation, puis le poste se retire.
    await comme("dir");
    expect((await decider(p, "REVISION", "Doublon.")).ok).toBe(true);
    await comme("dem");
    expect((await deleteAdProItem(undefined, form({ id: p }))).ok).toBe(true);
    expect(await magasin(stylo)).toBe(10);
  });

  it("AU-DELÀ DU MAGASIN, L'ACCORD EST REFUSÉ EN ENTIER — et rien n'est réservé, pas même la ligne qui tenait", async () => {
    await comme("dem");
    const p = await nouveauPoste("Trop de matériel");
    expect((await lister(p, stylo, "5")).ok).toBe(true);
    expect((await lister(p, kakemono, "5")).ok, "on peut LISTER plus que le magasin : c'est l'accord qui tranche").toBe(true);
    expect((await submitAdProItem(undefined, form({ id: p }))).ok).toBe(true);
    await comme("dir");
    const r = await decider(p, "APPROVED");
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/5 « .*Kakémono.* » à réserver, mais le magasin ne le permet pas/);
    expect(r.ok ? "" : r.error).toMatch(/Rien n'est accordé/);
    expect(await statutPoste(p), "la décision n'est pas écrite").toBe("PENDING");
    expect(await magasin(stylo), "tout ou rien : les stylos qui tenaient ne sont PAS réservés").toBe(10);
    expect((await lignesDe(p)).every((l) => l.statut === "DEMANDEE")).toBe(true);
    expect((await decider(p, "REJECTED", "Le magasin n'a plus de kakémonos.")).ok).toBe(true);
  });

  it("REVOIR UN POSTE ACCORDÉ rend sa réservation au magasin — puis il se retire librement", async () => {
    await comme("dem");
    const p = await nouveauPoste("Stylos du stand");
    expect((await lister(p, stylo, "4")).ok).toBe(true);
    expect((await submitAdProItem(undefined, form({ id: p }))).ok).toBe(true);
    await comme("dir");
    expect((await decider(p, "APPROVED")).ok).toBe(true);
    expect(await magasin(stylo)).toBe(6);
    expect((await decider(p, "REVISION", "Deux suffiront.")).ok).toBe(true);
    expect(await magasin(stylo), "la révision rend tout au magasin").toBe(10);
    expect((await lignesDe(p))[0]?.statut).toBe("DEMANDEE");
    await comme("dem");
    const del = await deleteAdProItem(undefined, form({ id: p }));
    expect(del.ok, del.ok ? "" : del.error).toBe(true);
  });

  it("DU MATÉRIEL RÉSERVÉ BLOQUE : le retrait du poste, la clôture, la corbeille — chacun en nommant le remède", async () => {
    await comme("dem");
    const del = await deleteAdProItem(undefined, form({ id: poste1 }));
    expect(del.ok).toBe(false);
    expect(del.ok ? "" : del.error).toMatch(/Ce poste ne se retire pas : du matériel du stock est réservé.*confirmez d'abord/);
    const req = await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spo } });
    const bilan = bilanCloture(req.status, await postesPourCloture(spo));
    expect(bilan.cloturable).toBe(false);
    expect(bilan.manques.join(" ")).toMatch(/attendent leur confirmation/);
    await comme("sa");
    const clo = await cloturerSponsoring(form({ id: spo }));
    expect(clo.ok).toBe(false);
    expect(clo.ok ? "" : clo.error).toMatch(/attendent leur confirmation/);
    const inv = await inventorier("SponsoringRequest", spo);
    expect(inv?.bloquants.join(" ")).toMatch(/réservé pour cet événement et n'a pas été confirmé/);
  });

  it("UNE RÉSERVATION NE S'ANNULE PAS DEPUIS LE STOCK — le refus renvoie au poste de la demande", async () => {
    await comme("sa");
    const m = await prisma.promoStockMovement.findFirstOrThrow({ where: { adProLine: { itemId: poste1 }, kind: "RESERVATION_OUT" } });
    const r = await annulerMouvement(form({ mouvementId: m.id }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/Matériel du stock/);
  });

  it("CONFIRMER : seuls le demandeur, le magasin, la Direction ou le Super Admin — et une faute ne change RIEN", async () => {
    const lignes = await lignesDe(poste1);
    const [lBrochure, lKakemono] = [lignes.find((l) => l.stockItemId === brochure)!, lignes.find((l) => l.stockItemId === kakemono)!];
    const saisieIntrus = () => form({ itemId: poste1, ligneId: [lBrochure.id, lKakemono.id], utilisee: ["120", ""], rendue: ["", "2"], abimee: ["", "0"], perdue: ["", "0"] });
    // DEUX PORTES, DEUX REFUS (§118.175). Qui ne VOIT pas la demande ne la trouve pas — la même
    // phrase que l'absence, qui ne confirme pas qu'elle existe ; qui la voit sans pouvoir confirmer
    // reçoit la règle de la confirmation.
    await comme("autre");
    const aveugle = await confirmerMaterielStock(saisieIntrus());
    expect(aveugle.ok).toBe(false);
    expect(aveugle.ok ? "" : aveugle.error).toBe("Poste introuvable.");
    await comme("ns2");
    const intrus = await confirmerMaterielStock(saisieIntrus());
    expect(intrus.ok).toBe(false);
    expect(intrus.ok ? "" : intrus.error).toBe(REFUS_CONFIRMATION_MATERIEL);
    await comme("dem");
    // Un kakémono dont on ne dit rien n'est ni rentré ni perdu : refusé, et la brochure non plus ne bouge pas.
    const faute = await confirmerMaterielStock(form({ itemId: poste1, ligneId: [lBrochure.id, lKakemono.id], utilisee: ["120", ""], rendue: ["", "1"], abimee: ["", ""], perdue: ["", ""] }));
    expect(faute.ok).toBe(false);
    expect(faute.ok ? "" : faute.error).toMatch(/prêté : rendez compte de chaque unité — 2 réservée\(s\), 1 déclarée\(s\)/);
    expect((await lignesDe(poste1)).every((l) => l.statut === "RESERVEE")).toBe(true);
    expect(await magasin(brochure, lot2030), "rien n'est revenu sur une confirmation refusée").toBe(50);
  });

  it("CONFIRMER UNE FOIS, même à deux en même temps : le reste revient UNE fois, dans le lot le plus tard périmé", async () => {
    const lignes = await lignesDe(poste1);
    const [lBrochure, lKakemono] = [lignes.find((l) => l.stockItemId === brochure)!, lignes.find((l) => l.stockItemId === kakemono)!];
    const saisie = () => form({ itemId: poste1, ligneId: [lBrochure.id, lKakemono.id], utilisee: ["120", ""], rendue: ["", "1"], abimee: ["", "1"], perdue: ["", "0"] });
    const dem = await actorFor(ids.dem!);
    const dm = await actorFor(ids.dm!);
    // Deux personnes confirment au même instant : le demandeur et la directrice du magasin.
    const [a, b] = await sousBarriere(() => {
      ACTOR = dem;
      const p1 = confirmerMaterielStock(saisie());
      ACTOR = dm;
      const p2 = confirmerMaterielStock(saisie());
      return [p1, p2];
    });
    expect([a.ok, b.ok].filter(Boolean).length, `une seule confirmation passe — ${JSON.stringify([a, b])}`).toBe(1);
    expect(await magasin(brochure, lot2030), "30 brochures reviennent, dans le lot de 2030 d'abord").toBe(80);
    expect(await magasin(brochure, lot2028)).toBe(0);
    expect(await magasin(kakemono), "1 rendu revient ; l'abîmé reste dehors").toBe(2);
    const relues = await lignesDe(poste1);
    const rb = relues.find((l) => l.stockItemId === brochure)!;
    const rk = relues.find((l) => l.stockItemId === kakemono)!;
    expect([rb.statut, Number(rb.utilisee), Number(rb.rendue)]).toEqual(["CONFIRMEE", 120, 30]);
    expect([rk.statut, Number(rk.rendue), Number(rk.abimee), Number(rk.perdue)]).toEqual(["CONFIRMEE", 1, 1, 0]);
    const retours = await prisma.promoStockMovement.count({ where: { adProLine: { itemId: poste1 }, kind: "RESERVATION_BACK" } });
    expect(retours, "un retour par lot rendu — jamais le double").toBe(2);
  });

  it("LE RETOUR PRÉVIENT LE MAGASIN, et la confirmation est à l'audit au nom de qui l'a dite", async () => {
    const n = await prisma.notification.findFirst({ where: { userId: ids.dm!, title: "Matériel revenu d'un événement" } });
    const audit = await prisma.auditLog.findFirst({ where: { entityId: spo, summary: { contains: "Matériel du stock confirmé" } } });
    // La notification part vers le magasin sauf quand c'est lui qui confirme — l'un des deux a confirmé.
    expect(n != null || audit?.actorId === ids.dm).toBe(true);
    expect(audit?.summary).toMatch(/120 remis, 30 revenu\(s\)/);
    expect(audit?.summary).toMatch(/1 rendu\(s\), 1 abîmé\(s\), 0 perdu\(s\)/);
  });

  it("REMIS AUX MÉDECINS, SECONDE PORTE (§118.173) : la remise confirmée se lit sous sa demande — le durable prêté n'y est pas, et qui ne voit pas le magasin ne reçoit pas la section", async () => {
    const pageDm = await chargerPageStock(await actorFor(ids.dm!));
    const ici = (pageDm.remisesOperations ?? []).filter((o) => o.lien === `/sponsoring/${spo}`);
    // 120 brochures REMISES ; le kakémono, prêté puis rendu ou abîmé, n'a été donné à personne.
    expect(ici.map((o) => [o.itemId, o.quantite])).toEqual([[brochure, 120]]);
    expect(ici[0]!.demande).toBe(`${TAG}SPO-1`);
    expect([ids.dem, ids.dm]).toContain(ici[0]!.confirmeeParId);
    expect(pageDm.personnes[ici[0]!.confirmeeParId!], "le nom de qui a confirmé est chargé — sinon l'écran dirait « Compte supprimé »").toBeTruthy();
    const pageAutre = await chargerPageStock(await actorFor(ids.autre!));
    expect(pageAutre.remisesOperations, "qui ne voit pas le magasin ne reçoit pas la section").toBeNull();
  });

  it("CONFIRMÉ AVEC DU REMIS : le poste ne se retire plus et la corbeille refuse — il justifie des sorties du stock", async () => {
    await comme("dem");
    const del = await deleteAdProItem(undefined, form({ id: poste1 }));
    expect(del.ok).toBe(false);
    expect(del.ok ? "" : del.error).toMatch(/remis, abîmé ou perdu/);
    const inv = await inventorier("SponsoringRequest", spo);
    expect(inv?.bloquants.join(" ")).toMatch(/remis, abîmé ou perdu/);
    // Et sa décision ne change plus : une révision « rendrait » au magasin ce qui a été distribué.
    await comme("dir");
    const rev = await decider(poste1, "REVISION", "Trop tard.");
    expect(rev.ok).toBe(false);
    expect(rev.ok ? "" : rev.error).toMatch(/déjà été confirmé après l'événement/);
    expect(await statutPoste(poste1)).toBe("APPROVED");
  });

  it("TOUT CONFIRMÉ, TOUT DÉCIDÉ : la clôture passe — sans budget ni montant exigé du poste de stock", async () => {
    await comme("sa");
    const r = await cloturerSponsoring(form({ id: spo }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const relue = await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spo } });
    expect([relue.status, Number(relue.amountGranted ?? -1)]).toEqual(["CLOSED", 0]);
  });

  it("UN CONGRÈS ACCORDÉ AVEC DU MATÉRIEL RÉSERVÉ NE SE TRANSFÈRE PAS — le matériel resterait dehors", async () => {
    await comme("dem");
    const p = await nouveauPoste("Stylos des journées", "CONGRESS_NATIONAL", congres);
    expect((await lister(p, stylo, "3")).ok).toBe(true);
    expect((await submitAdProItem(undefined, form({ id: p }))).ok).toBe(true);
    await comme("dir");
    expect((await decider(p, "APPROVED")).ok).toBe(true);
    await comme("sa");
    const t = await transferAdProRequest(undefined, form({ from: "CONGRESS_NATIONAL", to: "CONGRESS_INTERNATIONAL", sourceId: congres }));
    expect(t.ok).toBe(false);
    expect(t.ok ? "" : t.error).toMatch(/1 article\(s\) du stock sont réservés pour cette demande/);
    expect((await prisma.congressNational.findUniqueOrThrow({ where: { id: congres } })).requestStatus).toBe("APPROVED");
    // Confirmer « 0 remis » annule la réservation : tout revient, et le transfert redevient possible.
    await comme("dem");
    const l = (await lignesDe(p))[0]!;
    expect((await confirmerMaterielStock(form({ itemId: p, ligneId: [l.id], utilisee: ["0"], rendue: [""], abimee: [""], perdue: [""] }))).ok).toBe(true);
    expect(await magasin(stylo)).toBe(10);
  });
});
