import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, moduleScope, type SessionUser } from "@/lib/rbac";
import { creerArticleCatalogue } from "./promo-catalogue-actions";
import { annulerDemande, demanderMateriel, entrerEnStock, servirDemande } from "./promo-stock-actions";
import { faitsStock } from "@/lib/queries/promo-stock";
import { peutServirDemande } from "@/lib/promo/stock-acces";
import type { ActionResult } from "./types";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

/** Le préfixe de CE banc (les restes d'un passage interrompu se retirent par lui), et le passage du jour. */
const PREFIXE = "__stkcourse__";
const TAG = `${PREFIXE}${Date.now().toString(36)}`;
const DOTER = "Si le matériel a déjà été remis à la personne, enregistrez-le par « Doter » sur la ligne de l'article : le stock le dira.";

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
function reussi(r: ActionResult, quoi: string): ActionResult {
  if (!r.ok) throw new Error(`${quoi} : ${r.error}`);
  return r;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SERVIR UNE DEMANDE DE MATÉRIEL, SOUS COURSE (lot D1b) — par les VRAIES actions.
 *
 * Le service relisait la demande « ouverte », faisait partir le matériel, puis la passait « servie »
 * SANS condition : une demande annulée par son auteur entre la lecture et l'écriture était servie
 * quand même — la dotation partait, et l'annulation était écrasée sans un mot. L'annulation ne prend
 * pas le verrou de l'article : seule une écriture CONDITIONNELLE sur la demande la voit. Elle est
 * désormais la PREMIÈRE écriture du service, avant tout mouvement de stock.
 *
 *   dm   directrice de la Direction Marketing — elle tient le magasin et sert
 *   k    délégué — demande, et annule sa demande (sans vue globale du stock, §118.104)
 *   sa   Super Admin — le décor seulement (l'entrée en stock lui est réservée)
 *
 * Chaque course est JOUÉE, jamais espérée (§118.65) : la transaction du banc verrouille UNE ligne de
 * ce banc (la demande, ou les lots de son article), lance les gestes un par un, attend que chacun soit
 * bloqué — par elle, ou derrière un geste bloqué par elle —, écrit au besoin le changement concurrent,
 * puis relâche.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Stock promotionnel — servir une demande que son auteur annule", () => {
  const ids: Record<string, string> = {};
  let article = "";
  let debutBanc = new Date();

  async function nettoyer(prefixe: string) {
    const users = (await prisma.user.findMany({ where: { email: { startsWith: prefixe } }, select: { id: true } })).map((x) => x.id);
    const cat = await prisma.promoCatalogueArticle.findMany({ where: { nom: { startsWith: prefixe } }, select: { id: true } });
    // L'article emporte lots, mouvements, transferts et demandes (Cascade) — c'est le seul geste de nettoyage du stock.
    if (cat.length) await prisma.promoStockItem.deleteMany({ where: { catalogueId: { in: cat.map((c) => c.id) } } });
    await prisma.promoCatalogueArticle.deleteMany({ where: { nom: { startsWith: prefixe } } });
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: prefixe } } });
    // Les avis « demande de matériel » partent à TOUTES les gestionnaires du magasin, pas seulement aux nôtres :
    // retirés par leur texte (le nom de l'article porte le préfixe), BORNÉS à ce passage (`createdAt` passe par l'index, §118.175).
    await prisma.notification.deleteMany({ where: { createdAt: { gte: debutBanc }, body: { contains: prefixe } } }).catch(() => undefined);
    if (users.length) {
      await prisma.notification.deleteMany({ where: { userId: { in: users } } });
      await prisma.userAccess.deleteMany({ where: { userId: { in: users } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }

  beforeAll(async () => {
    debutBanc = new Date(Date.now() - 1_000);
    await nettoyer(PREFIXE);
    const faire = (k: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role: role as never, passwordHash: "x" }, select: { id: true } });
    const [sa, dm, k] = await Promise.all([faire("sa", "SUPER_ADMIN"), faire("dm", "PRODUCT_MANAGER"), faire("k", "MEDICAL_DELEGATE")]);
    Object.assign(ids, { sa: sa.id, dm: dm.id, k: k.id });
    // L'ORGANIGRAMME : personne de son rôle au-dessus de dm — c'est elle qui tient le magasin (§118.164c).
    await Promise.all([
      prisma.employee.create({ data: { fullName: `${TAG} dm`, userId: dm.id }, select: { id: true } }),
      prisma.employee.create({ data: { fullName: `${TAG} k`, userId: k.id }, select: { id: true } }),
    ]);
    ACTOR = await actorFor(sa.id);
    const c = reussi(await creerArticleCatalogue(form({ nom: `${TAG} Stylo`, famille: "CONSOMMABLE", unite: "pièce" })), "créer l'article du catalogue");
    article = reussi(await entrerEnStock(form({ catalogueId: c.id!, quantite: "50", motif: "Banc de course" })), "entrer en stock").id!;
  }, 60_000);

  afterAll(async () => {
    await nettoyer(TAG);
  }, 60_000);

  const comme = async (k: string) => { ACTOR = await actorFor(ids[k]!); };
  const soldeDuMagasin = async () => {
    const r = await prisma.promoStockMovement.aggregate({ where: { itemId: article, holderId: null }, _sum: { delta: true } });
    return Number(r._sum.delta ?? 0);
  };
  const dotationsDe = (demandeId: string) => prisma.promoStockTransfer.count({ where: { demandeId } });
  const statutDe = async (demandeId: string) => (await prisma.promoStockRequest.findUniqueOrThrow({ where: { id: demandeId } })).statut;
  /** Une demande de k, ouverte. */
  async function demande(quantite: string): Promise<string> {
    await comme("k");
    return reussi(await demanderMateriel(form({ itemId: article, quantite, note: TAG })), "demander du matériel").id!;
  }

  type Verrou = (tx: Prisma.TransactionClient) => Promise<unknown>;
  const verrouDemande = (demandeId: string): Verrou => (tx) => tx.$queryRaw`SELECT id FROM "PromoStockRequest" WHERE id = ${demandeId} FOR UPDATE`;
  /** Les lots de l'article : la dotation s'y arrête (la clé étrangère de son premier mouvement), APRÈS avoir pris la demande. */
  const verrouLots = (itemId: string): Verrou => (tx) => tx.$queryRaw`SELECT id FROM "PromoStockLot" WHERE "itemId" = ${itemId} FOR UPDATE`;

  /**
   * LA COURSE FORCÉE (§118.164e) — la barrière de `promo-devis-course-flow.test.ts`. Un verrou de LIGNE sur ce que
   * vise le seul geste du banc, et `pg_blocking_pids` pour savoir qu'il est bloqué PAR NOUS (ou derrière un geste
   * bloqué par nous) : un verrou de table compterait aussi les gestes des autres fichiers de la suite (§118.65).
   */
  async function pendantQueLesGestesAttendent<T>(
    verrou: Verrou, gestes: Array<() => Promise<T>>, entretemps?: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<T[]> {
    const lances: Promise<T>[] = [];
    await prisma.$transaction(async (tx) => {
      await verrou(tx);
      for (const lancer of gestes) {
        const geste = lancer();
        geste.catch(() => undefined);
        lances.push(geste);
        const debut = Date.now();
        for (;;) {
          await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
          const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
            WITH att AS (SELECT pid, pg_blocking_pids(pid) AS par FROM pg_stat_activity WHERE datname = current_database()),
                 directs AS (SELECT pid FROM att WHERE pg_backend_pid() = ANY(par))
            SELECT count(*)::int AS n FROM att
            WHERE pg_backend_pid() = ANY(par) OR par && ARRAY(SELECT pid FROM directs)`;
          if (n >= lances.length) break;
          if (Date.now() - debut > 15_000) {
            await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
            const vues = await tx.$queryRaw<{ etat: string | null; attente: string; requete: string }[]>`
              SELECT state AS etat, coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '') AS attente, left(query, 90) AS requete
              FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`;
            throw new Error(`le geste n°${lances.length} n'a pas atteint la barrière — ${JSON.stringify(vues)}`);
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      if (entretemps) await entretemps(tx);
    }, { timeout: 30_000 });
    return Promise.all(lances);
  }

  it("PRÉMISSES : le demandeur n'a pas la vue globale du stock et ne sert pas ; la directrice tient le magasin et sert", async () => {
    const k = await actorFor(ids.k!);
    expect(moduleScope(k, "PROMO_STOCK"), "sans quoi le banc ne prouverait rien sur une porte (§118.104)").not.toBe("ALL");
    expect(peutServirDemande(await faitsStock(k))).toBe(false);
    expect(peutServirDemande(await faitsStock(await actorFor(ids.dm!)))).toBe(true);
    expect(await soldeDuMagasin()).toBe(50);
  });

  it("UNE DEMANDE ANNULÉE PAR SON AUTEUR PENDANT QU'ON LA SERT : refusée AVANT tout mouvement — rien ne part, et le refus nomme le geste qui reste (« Doter »)", async () => {
    const d = await demande("4");
    const avant = await soldeDuMagasin();
    await comme("dm");
    // Le service lit la demande ouverte, puis s'arrête sur elle (le banc la tient) ; son auteur l'annule pendant ce temps.
    const [r] = await pendantQueLesGestesAttendent(verrouDemande(d), [() => servirDemande(form({ demandeId: d }))],
      (tx) => tx.promoStockRequest.update({ where: { id: d }, data: { statut: "ANNULEE", decideParId: ids.k!, decideLe: new Date() } }));
    expect(err(r)).toBe(`Cette demande vient d'être annulée par son auteur. Rien n'est parti du magasin. ${DOTER}`);
    expect(await dotationsDe(d), "aucune dotation n'est partie").toBe(0);
    expect(await soldeDuMagasin(), "le magasin n'a rien perdu").toBe(avant);
    expect(await statutDe(d), "l'annulation de son auteur n'est pas écrasée").toBe("ANNULEE");
  }, 60_000);

  it("UNE ANNULATION LANCÉE PENDANT QU'ON SERT ATTEND, PUIS TROUVE LA DEMANDE SERVIE : une seule issue, jamais les deux", async () => {
    const d = await demande("3");
    const avant = await soldeDuMagasin();
    const dm = await actorFor(ids.dm!);
    const k = await actorFor(ids.k!);
    // L'acteur se lit à l'APPEL de chaque geste (`requireUser` est sa première instruction) : chacun garde le sien.
    // Le service prend la demande, puis s'arrête sur les lots de l'article ; l'annulation fait la queue derrière lui.
    const [servi, annule] = await pendantQueLesGestesAttendent(verrouLots(article), [
      () => { ACTOR = dm; return servirDemande(form({ demandeId: d })); },
      () => { ACTOR = k; return annulerDemande(form({ demandeId: d })); },
    ]);
    expect(servi.ok, err(servi)).toBe(true);
    expect(err(annule)).toBe("Cette demande n'est plus ouverte.");
    expect(await statutDe(d)).toBe("SERVIE");
    expect(await dotationsDe(d), "une dotation, une seule").toBe(1);
    expect(await soldeDuMagasin()).toBe(avant - 3);
  }, 60_000);

  it("UNE DEMANDE QUE LE MAGASIN NE PEUT PAS SERVIR RESTE OUVERTE — la prise de la demande s'annule avec le reste", async () => {
    const d = await demande("5");
    const avant = await soldeDuMagasin();
    await comme("dm");
    expect(err(await servirDemande(form({ demandeId: d, quantite: "9999" })))).toMatch(/^Le magasin ne peut pas servir : /);
    const apres = await prisma.promoStockRequest.findUniqueOrThrow({ where: { id: d } });
    expect({ statut: apres.statut, decidePar: apres.decideParId }, "une demande « servie » sans dotation serait un mensonge").toEqual({ statut: "OUVERTE", decidePar: null });
    expect(await dotationsDe(d)).toBe(0);
    expect(await soldeDuMagasin()).toBe(avant);
    // Restée ouverte, elle se sert ensuite pour ce qu'elle demande.
    reussi(await servirDemande(form({ demandeId: d })), "servir la demande");
    expect(await statutDe(d)).toBe("SERVIE");
  }, 60_000);

  it("UNE DEMANDE DÉJÀ ANNULÉE NE SE SERT PAS — le refus dit ce qu'elle est devenue et nomme le geste qui reste", async () => {
    const d = await demande("2");
    reussi(await annulerDemande(form({ demandeId: d })), "annuler sa demande");
    await comme("dm");
    expect(err(await servirDemande(form({ demandeId: d })))).toBe(`Cette demande vient d'être annulée par son auteur. Rien n'est parti du magasin. ${DOTER}`);
    expect(await dotationsDe(d)).toBe(0);
  }, 60_000);
});
