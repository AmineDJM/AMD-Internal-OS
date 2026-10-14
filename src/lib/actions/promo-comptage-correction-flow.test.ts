import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, moduleScope, type SessionUser } from "@/lib/rbac";
import { confirmerReception, declarerPerte, doter, entrerEnStock } from "./promo-stock-actions";
import { annulerComptage, corrigerComptage, demanderComptage, saisirComptage } from "./promo-comptage-actions";
import { faitsStock } from "@/lib/queries/promo-stock";
import { articlesDuComptage } from "@/lib/promo/comptages-ecriture";
import { REFUS_COMPTAGE } from "@/lib/promo/comptages";
import type { ActionResult } from "./types";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__cptc__";

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: u.secondaryRole as SessionUser["role"] | null, access, mustChangePassword: false } as CurrentUser;
}
const form = (fields: Record<string, string | string[]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const x of v) fd.append(k, x); else fd.set(k, v);
  }
  return fd;
};
const err = (r: ActionResult) => (r.ok ? "" : r.error ?? "");

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN COMPTAGE SAISI SE CORRIGE (audit 360°, lot C4b, R19) — par les VRAIES actions, avec des
 * acteurs SANS vue globale (§118.104).
 *
 * « 41 » tapé pour « 14 » : la seule issue était d'annuler le comptage puis d'en redemander un, et
 * l'écart faux restait au registre entre les deux. La correction porte sur ce qui a été COMPTÉ :
 * l'écart entre le nouveau compte et l'ancien s'applique au solde ACTUEL (des sorties ont pu avoir
 * lieu depuis, et elles restent vraies), chaque mouvement porte le comptage et le motif.
 *
 *   sa   Super Admin   dm  directrice marketing (tient le magasin)   ops  Directeur des Opérations
 *   sup  superviseur sous ops        k1, k2  délégués sous sup (k1 détient le stock compté)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Stock promotionnel — corriger un comptage saisi (lot C4b)", () => {
  const ids: Record<string, string> = {};
  const art: Record<string, string> = {};
  const c: Record<string, string> = {};

  beforeAll(async () => {
    await nettoyer();
    const faire = (nom: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, role: role as never, passwordHash: "x" } });
    const [sa, dm, ops, sup, k1, k2] = await Promise.all([
      faire("sa", "SUPER_ADMIN"), faire("dm", "PRODUCT_MANAGER"), faire("ops", "OPERATIONS_DIRECTOR"),
      faire("sup", "NATIONAL_SALES"), faire("k1", "MEDICAL_DELEGATE"), faire("k2", "MEDICAL_DELEGATE"),
    ]);
    Object.assign(ids, { sa: sa.id, dm: dm.id, ops: ops.id, sup: sup.id, k1: k1.id, k2: k2.id });
    const emp = async (nom: string, userId: string, managerId?: string) =>
      (await prisma.employee.create({ data: { fullName: `${TAG}${nom}`, userId, managerId: managerId ?? null }, select: { id: true } })).id;
    await emp("dm", dm.id);
    const eOps = await emp("ops", ops.id);
    const eSup = await emp("sup", sup.id, eOps);
    await Promise.all([emp("k1", k1.id, eSup), emp("k2", k2.id, eSup)]);

    const cat = (nom: string) =>
      prisma.promoCatalogueArticle.create({ data: { reference: `${TAG}${nom}`, nom: `${TAG}${nom}`, famille: "CONSOMMABLE", unite: "pièce" }, select: { id: true } });
    const [fiche, stylo, bloc] = await Promise.all([cat("Fiche"), cat("Stylo"), cat("Bloc")]);
    ACTOR = await actorFor(sa.id);
    const entrer = async (catalogueId: string, quantite: string) => {
      const r = await entrerEnStock(form({ catalogueId, quantite, motif: "Banc de la correction des comptages" }));
      if (!r.ok) throw new Error(r.error);
      return r.id!;
    };
    art.fiche = await entrer(fiche.id, "300");
    art.stylo = await entrer(stylo.id, "100");
    art.bloc = await entrer(bloc.id, "10");
    ACTOR = await actorFor(dm.id);
    const d1 = await doter(form({ itemId: art.fiche, versId: k1.id, quantite: "100" }));
    const d2 = await doter(form({ itemId: art.stylo, versId: k1.id, quantite: "20" }));
    if (!d1.ok || !d2.ok) throw new Error(`${d1.error ?? ""} ${d2.error ?? ""}`);
    ACTOR = await actorFor(k1.id);
    for (const t of [d1.id!, d2.id!]) {
      const r = await confirmerReception(form({ transfertId: t }));
      if (!r.ok) throw new Error(r.error);
    }
  }, 60_000);

  afterAll(async () => {
    await nettoyer();
  }, 60_000);

  async function nettoyer() {
    const uids = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((u) => u.id);
    const cat = await prisma.promoCatalogueArticle.findMany({ where: { nom: { startsWith: TAG } }, select: { id: true } });
    const items = cat.length ? await prisma.promoStockItem.findMany({ where: { catalogueId: { in: cat.map((x) => x.id) } }, select: { id: true } }) : [];
    if (uids.length) await prisma.promoStockComptage.deleteMany({ where: { OR: [{ holderId: { in: uids } }, { demandeurId: { in: uids } }] } });
    if (items.length) {
      const cles = (await prisma.promoStockAlerte.findMany({ select: { cle: true } })).map((x) => x.cle)
        .filter((cle) => items.some((i) => cle.includes(i.id)));
      if (cles.length) await prisma.promoStockAlerte.deleteMany({ where: { cle: { in: cles } } });
      await prisma.promoStockItem.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });
    }
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
  const ligne = async (comptageId: string, itemId: string) => {
    const l = await prisma.promoStockComptageLigne.findUniqueOrThrow({ where: { comptageId_itemId: { comptageId, itemId } } });
    return { attendu: Number(l.attendu), compte: Number(l.compte), ecart: Number(l.ecart) };
  };
  const ecartsAuRegistre = async (comptageId: string, itemId: string) => {
    const r = await prisma.promoStockMovement.aggregate({ where: { comptageId, itemId }, _sum: { delta: true }, _count: true });
    return { somme: Number(r._sum.delta ?? 0), n: r._count };
  };
  const corrige = (qui: string, fields: Record<string, string | string[]>) => comme(qui).then(() => corrigerComptage(form(fields)));

  /** Les lignes d'une saisie complète, au solde du jour pour tout sauf ce qu'on fixe. */
  async function saisieComplete(comptageId: string, fixe: Record<string, string>): Promise<FormData> {
    const { attendus } = await articlesDuComptage(ids.k1!, ids.k1!, "CONSOMMABLE");
    const itemIds: string[] = [];
    const comptes: string[] = [];
    for (const itemId of attendus) {
      itemIds.push(itemId);
      comptes.push(fixe[itemId] ?? String(await solde(ids.k1!, itemId)));
    }
    return form({ comptageId, itemId: itemIds, compte: comptes });
  }

  /** Attendre que `n` gestes soient bloqués derrière le verrou de la transaction en cours (§118.65). */
  async function bloques(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], n: number) {
    const debut = Date.now();
    for (;;) {
      await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
      const [{ k }] = await tx.$queryRaw<{ k: number }[]>`
        SELECT count(*)::int AS k FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query ILIKE '%PromoStock%'`;
      if (k >= n) return;
      if (Date.now() - debut > 10_000) throw new Error(`les gestes n'ont pas atteint la barrière (${k} sur ${n})`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("PRÉMISSES : k1 détient le stock compté, sans vue globale ; ops fait compter ; dm tient le magasin", async () => {
    expect(await solde(ids.k1!, art.fiche!)).toBe(100);
    expect(await solde(ids.k1!, art.stylo!)).toBe(20);
    for (const qui of ["k1", "k2", "sup"]) {
      expect(moduleScope(await actorFor(ids[qui]!), "PROMO_STOCK"), `${qui} sans vue globale`).not.toBe("ALL");
    }
    expect((await faitsStock(await actorFor(ids.ops!))).directeurDesOperations).toBe(true);
    expect((await faitsStock(await actorFor(ids.dm!))).gereLeMagasin).toBe(true);
  });

  it("L'ÉTAT D'ABORD : un comptage pas encore saisi, ou annulé, ne se corrige pas — et le motif n'est pas demandé avant de le dire", async () => {
    await comme("ops");
    const d1 = await demanderComptage(form({ cible: "PERSONNE", holderId: ids.k1!, famille: "CONSOMMABLE" }));
    expect(d1.ok, err(d1)).toBe(true);
    c.un = d1.id!;
    expect(err(await corrige("k1", { comptageId: c.un, itemId: [art.fiche!], compte: ["10"] })))
      .toBe("Ce comptage n'est pas encore saisi : saisissez-le, il n'y a rien à corriger.");

    await comme("ops");
    const d2 = await demanderComptage(form({ cible: "PERSONNE", holderId: ids.k2!, famille: "CONSOMMABLE" }));
    expect(d2.ok, err(d2)).toBe(true);
    expect((await annulerComptage(form({ comptageId: d2.id!, motif: "Doublon de demande" }))).ok).toBe(true);
    expect(err(await corrige("k2", { comptageId: d2.id!, itemId: [art.fiche!], compte: ["1"] }))).toBe("Ce comptage a été annulé : il n'y a rien à corriger.");
  });

  it("SEUL CELUI QUI DÉTIENT CORRIGE — ni le demandeur, ni le Super Admin, ni un collègue, ni la gestionnaire, ni le superviseur", async () => {
    await comme("k1");
    const s = await saisirComptage(await saisieComplete(c.un!, { [art.fiche!]: "41" }));
    expect(s.ok, err(s)).toBe(true);
    expect(await ligne(c.un!, art.fiche!)).toEqual({ attendu: 100, compte: 41, ecart: -59 });
    expect(await solde(ids.k1!, art.fiche!)).toBe(41);
    for (const qui of ["ops", "sa", "k2", "dm", "sup"]) {
      expect(err(await corrige(qui, { comptageId: c.un!, itemId: [art.fiche!], compte: ["14"] })), qui).toBe(REFUS_COMPTAGE.saisir);
    }
  });

  it("LA CORRECTION SE LIT ENTIÈRE : négatif, doublon, article hors du comptage, rien de changé, motif absent — refusés, et rien n'est écrit", async () => {
    expect(err(await corrige("k1", { comptageId: c.un!, itemId: [art.fiche!], compte: ["-1"], motif: "x" }))).toBe("Ligne 1 : la quantité comptée doit être un nombre positif ou nul.");
    expect(err(await corrige("k1", { comptageId: c.un!, itemId: [art.fiche!, art.fiche!], compte: ["14", "15"], motif: "x" }))).toBe("Ligne 2 : cet article figure deux fois dans la correction.");
    expect(err(await corrige("k1", { comptageId: c.un!, itemId: [art.fiche!], compte: ["14"] }))).toMatch(/^Dites pourquoi vous corrigez ce comptage/);
    expect(err(await corrige("k1", { comptageId: c.un!, itemId: [art.bloc!], compte: ["2"], motif: "x" }))).toBe(`« ${TAG}Bloc » ne faisait pas partie de ce comptage.`);
    expect(err(await corrige("k1", { comptageId: c.un!, itemId: [art.fiche!], compte: ["41"], motif: "x" }))).toBe("Rien à corriger : les nombres saisis sont ceux du comptage.");
    expect(await ligne(c.un!, art.fiche!)).toEqual({ attendu: 100, compte: 41, ecart: -59 });
    expect(await solde(ids.k1!, art.fiche!)).toBe(41);
    expect((await prisma.promoStockComptage.findUniqueOrThrow({ where: { id: c.un! } })).corrigeLe).toBeNull();
  });

  it("« 41 » TAPÉ POUR « 14 » : l'écart corrigé s'applique au solde ACTUEL — la perte déclarée depuis reste vraie", async () => {
    await comme("k1");
    expect((await declarerPerte(form({ itemId: art.fiche!, detenteurId: ids.k1!, quantite: "1", motif: "Une fiche déchirée" }))).ok).toBe(true);
    expect(await solde(ids.k1!, art.fiche!)).toBe(40);
    const r = await corrige("k1", { comptageId: c.un!, itemId: [art.fiche!], compte: ["14"], motif: "14 et non 41 — deux chiffres inversés" });
    expect(r.ok, err(r)).toBe(true);
    expect(r.message).toBe(`Comptage corrigé — ${TAG}Fiche : 41 → 14.`);
    // −27 sur le solde du jour (40), pas « 14 en main » : la fiche déchirée depuis le comptage reste sortie.
    expect(await solde(ids.k1!, art.fiche!)).toBe(13);
    expect(await ligne(c.un!, art.fiche!)).toEqual({ attendu: 100, compte: 14, ecart: -86 });
    expect(await ecartsAuRegistre(c.un!, art.fiche!), "la saisie puis la correction, chacune portant le comptage").toEqual({ somme: -86, n: 2 });
    const dernier = await prisma.promoStockMovement.findFirstOrThrow({ where: { comptageId: c.un!, itemId: art.fiche! }, orderBy: { createdAt: "desc" }, select: { kind: true, reason: true, delta: true } });
    expect(dernier).toMatchObject({ kind: "CORRECTION", reason: "Correction du comptage — 14 et non 41 — deux chiffres inversés" });
    expect(Number(dernier.delta)).toBe(-27);
    const cpt = await prisma.promoStockComptage.findUniqueOrThrow({ where: { id: c.un! } });
    expect(cpt).toMatchObject({ statut: "SAISI", corrigeParId: ids.k1, corrigeMotif: "14 et non 41 — deux chiffres inversés" });
    expect(cpt.corrigeLe).not.toBeNull();
    expect(await prisma.notification.count({ where: { userId: ids.ops!, title: "Comptage corrigé" } }), "qui a demandé le comptage en est prévenu").toBe(1);
  });

  it("TOUT OU RIEN : une ligne qui ferait passer le solde sous zéro refuse toute la correction", async () => {
    await comme("k1");
    expect((await declarerPerte(form({ itemId: art.stylo!, detenteurId: ids.k1!, quantite: "15", motif: "Stylos distribués hors visite" }))).ok).toBe(true);
    expect(await solde(ids.k1!, art.stylo!)).toBe(5);
    const r = await corrige("k1", { comptageId: c.un!, itemId: [art.fiche!, art.stylo!], compte: ["15", "2"], motif: "Recompté" });
    expect(err(r)).toBe(`« ${TAG}Stylo » : la correction ferait passer le solde sous zéro (5 en main aujourd'hui, 18 à retirer) — des sorties ont eu lieu depuis le comptage.`);
    expect(await ligne(c.un!, art.fiche!), "la fiche, pourtant juste, n'est pas corrigée").toEqual({ attendu: 100, compte: 14, ecart: -86 });
    expect(await solde(ids.k1!, art.fiche!)).toBe(13);
    expect((await ligne(c.un!, art.stylo!)).compte).toBe(20);
    expect(await solde(ids.k1!, art.stylo!)).toBe(5);
  });

  it("DEUX CORRECTIONS CROISÉES s'appliquent l'une après l'autre, la seconde à partir de la première — jamais deux fois le même écart", async () => {
    await comme("k1");
    const avant = { solde: await solde(ids.k1!, art.fiche!), compte: (await ligne(c.un!, art.fiche!)).compte, n: (await ecartsAuRegistre(c.un!, art.fiche!)).n };
    let gestes: Promise<ActionResult>[] = [];
    await prisma.$transaction(async (tx) => {
      // Les écritures de lignes attendent : le premier geste s'arrête APRÈS sa lecture, verrou de
      // l'article tenu ; le second attend ce verrou. Sans la relecture SOUS le verrou, les deux
      // partiraient du même compte.
      await tx.$executeRawUnsafe(`LOCK TABLE "PromoStockComptageLigne" IN SHARE MODE`);
      gestes = [
        corrigerComptage(form({ comptageId: c.un!, itemId: [art.fiche!], compte: ["30"], motif: "Recompté : 30" })),
        corrigerComptage(form({ comptageId: c.un!, itemId: [art.fiche!], compte: ["25"], motif: "Recompté : 25" })),
      ];
      for (const g of gestes) g.catch(() => undefined);
      await bloques(tx, 2);
    }, { timeout: 20_000 });
    const resultats = await Promise.all(gestes);
    expect(resultats.filter((r) => r.ok), JSON.stringify(resultats)).toHaveLength(2);
    const apres = await ligne(c.un!, art.fiche!);
    expect([25, 30]).toContain(apres.compte);
    expect(await solde(ids.k1!, art.fiche!) - avant.solde, "le solde a bougé d'exactement ce que le compte a bougé").toBe(apres.compte - avant.compte);
    expect(apres.ecart).toBe(-86 + (apres.compte - avant.compte));
    expect((await ecartsAuRegistre(c.un!, art.fiche!)).n).toBe(avant.n + 2);
  }, 60_000);

  it("UN COMPTAGE PLUS RÉCENT du même détenteur fait foi — y compris quand sa saisie croise la correction", async () => {
    await comme("ops");
    const d = await demanderComptage(form({ cible: "PERSONNE", holderId: ids.k1!, famille: "CONSOMMABLE" }));
    expect(d.ok, err(d)).toBe(true);
    c.deux = d.id!;
    await comme("k1");
    const saisie = await saisieComplete(c.deux, {});
    let geste: { saisie: Promise<ActionResult>; correction: Promise<ActionResult> } | null = null;
    await prisma.$transaction(async (tx) => {
      // L'ORDRE EST FORCÉ : la saisie du second comptage tient les verrous des articles quand la
      // correction du premier arrive. Lue hors du verrou, la question « un comptage plus récent ? »
      // aurait répondu non — la saisie n'était pas encore écrite.
      await tx.$executeRawUnsafe(`LOCK TABLE "PromoStockComptageLigne" IN SHARE MODE`);
      const s = saisirComptage(saisie);
      s.catch(() => undefined);
      await bloques(tx, 1);
      const k = corrigerComptage(form({ comptageId: c.un!, itemId: [art.fiche!], compte: ["20"], motif: "Encore une erreur" }));
      k.catch(() => undefined);
      await bloques(tx, 2);
      geste = { saisie: s, correction: k };
    }, { timeout: 20_000 });
    const { saisie: s, correction: k } = geste!;
    expect((await s).ok, err(await s)).toBe(true);
    expect(err(await k)).toMatch(new RegExp(`^« ${TAG}(Fiche|Stylo) » a été recompté le .* : c'est ce comptage plus récent qui fait foi — corrigez-le plutôt que celui-ci\\.$`));
    expect(err(await corrige("k1", { comptageId: c.un!, itemId: [art.stylo!], compte: ["19"], motif: "x" }))).toMatch(/plus récent qui fait foi/);
    // Le plus récent, lui, se corrige.
    const fiche = await solde(ids.k1!, art.fiche!);
    const ok = await corrige("k1", { comptageId: c.deux, itemId: [art.fiche!], compte: String(fiche + 2), motif: "Deux fiches retrouvées" });
    expect(ok.ok, err(ok)).toBe(true);
    expect(await solde(ids.k1!, art.fiche!)).toBe(fiche + 2);
  }, 60_000);
});
