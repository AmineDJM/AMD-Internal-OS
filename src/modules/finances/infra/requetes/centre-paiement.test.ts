import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { chargerCentre, LIMITE_LIGNES_CENTRE } from "./centre-paiement";
import { ENTITE_SANS } from "../../domaine/entite-centre";
import { exporterOrdresCentre } from "@/lib/exports/paiements";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CHARGEUR DU CENTRE DE PAIEMENT PAR SON VRAI POINT D'ENTRÉE — les entités en haut, UNE file
 * dessous (toutes origines confondues depuis le 24/11/2026), et rien qui s'élargisse.
 *
 * Les acteurs n'ont PAS la vue globale (§118.104) : un siège du centre rattaché à UNE société, un
 * demandeur ordinaire. Le Super Admin n'est là que comme TÉMOIN (il voit les deux sociétés) — sans
 * lui, une garde qui refuserait tout passerait pour armée (§118.17). Les sociétés du décor sont à
 * ce banc : les comptes par entité sont exacts parce qu'aucun voisin n'y écrit (§118.92).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

// UN SUFFIXE PAR RUN (§118.136) : l'étiquette fixe faisait du ménage d'ouverture (`nettoyer`) le ménage d'un AUTRE run
// du même fichier lancé à côté (un `vitest run` du fichier pendant `test:architecture`) — ses sociétés, ses comptes et
// ses ordres retirés en plein test, et des références d'ordre fixes (`OD-0001`…) en collision.
const TAG = `__cp211__${Date.now().toString(36)}`;
const session = async (id: string, role: string): Promise<SessionUser> =>
  ({ id, name: `${TAG}${role}`, email: `${TAG}${id}@t.dz`, role, secondaryRole: null, access: await getAccess(id, role as never), mustChangePassword: false }) as unknown as SessionUser;

suite("le centre de paiement : une file par entité, par le chargeur", () => {
  let aId = "", bId = "", siegeId = "", demandeurId = "", saId = "", videId = "";
  let siege: SessionUser, demandeur: SessionUser, sa: SessionUser, vide: SessionUser;
  const ids: Record<string, string> = {};
  let seq = 0;
  // Chaque ordre du décor est PLUS ANCIEN que le précédent : l'ordre de la file se vérifie à la ligne près.
  const T0 = Date.now();

  async function nettoyer() {
    const societes = await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    const socIds = societes.map((s) => s.id);
    await prisma.expenseOrder.deleteMany({ where: { OR: [{ reference: { startsWith: TAG } }, { label: { startsWith: TAG } }] } }).catch(() => {});
    await prisma.paymentCentreSeat.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.userCompanyAccess.deleteMany({ where: { companyId: { in: socIds } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: socIds } } }).catch(() => {});
  }

  /** Un ordre du décor — par la même table que le vrai écrivain, avec une référence à soi. */
  async function ordre(cle: string, o: {
    companyId: string | null; sourceType?: string | null; sourceId?: string | null;
    centralStatus?: string; amount?: number; requestedById?: string | null;
  }) {
    const n = ++seq;
    const r = await prisma.expenseOrder.create({
      data: {
        reference: `${TAG}OD-${String(n).padStart(4, "0")}`,
        label: `${TAG}${cle}`,
        amount: o.amount ?? 1000,
        category: "AUTRE",
        companyId: o.companyId,
        sourceType: (o.sourceType ?? null) as never,
        sourceId: o.sourceId ?? null,
        centralStatus: o.centralStatus ?? "AWAITING",
        requestedById: o.requestedById ?? saId,
        createdAt: new Date(T0 - n * 60_000),
      },
      select: { id: true },
    });
    ids[cle] = r.id;
    return r.id;
  }

  beforeAll(async () => {
    await nettoyer();
    const [a, b] = await Promise.all([
      prisma.company.create({ data: { name: `${TAG}A`, shortName: `${TAG}Alpha`, sortOrder: 9001 }, select: { id: true } }),
      prisma.company.create({ data: { name: `${TAG}B`, shortName: `${TAG}Beta`, sortOrder: 9002 }, select: { id: true } }),
    ]);
    aId = a.id; bId = b.id;
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, passwordHash: "x", role: role as never }, select: { id: true } });
    const [u1, u2, u3, u4] = await Promise.all([mk("siege", "DIRECTION_ASSISTANT"), mk("demandeur", "DIRECTION_ASSISTANT"), mk("sa", "SUPER_ADMIN"), mk("vide", "DIRECTION_ASSISTANT")]);
    siegeId = u1.id; demandeurId = u2.id; saId = u3.id; videId = u4.id;
    // Le siège ET le demandeur sont rattachés à UNE société (A) : la société B ne leur est pas ouverte.
    await prisma.userCompanyAccess.createMany({ data: [
      { userId: siegeId, companyId: aId }, { userId: demandeurId, companyId: aId }, { userId: videId, companyId: aId },
    ] });
    await prisma.paymentCentreSeat.create({ data: { userId: siegeId, note: `${TAG}siège` } });
    siege = await session(siegeId, "DIRECTION_ASSISTANT");
    demandeur = await session(demandeurId, "DIRECTION_ASSISTANT");
    vide = await session(videId, "DIRECTION_ASSISTANT");
    sa = await session(saId, "SUPER_ADMIN");

    // ── Société A : des origines de TOUS les pôles — Regulatory, Ad & Pro, RH, sponsoring, demande
    //    de paiement, sans origine — 7 ordres, 5 en attente, un autorisé, un refusé. Créés du plus
    //    récent au plus ancien.
    await ordre("A-regulatory", { companyId: aId, sourceType: "REGULATORY_PRODUCT", sourceId: "x-reg", amount: 100 });
    await ordre("A-adpro", { companyId: aId, sourceType: "AD_PRO_ITEM", sourceId: "x-adpro", amount: 300 });
    await ordre("A-rh", { companyId: aId, sourceType: "PAYROLL", sourceId: "x-paie", amount: 700 });
    await ordre("A-autorise", { companyId: aId, sourceType: "SPONSORING", sourceId: "x-sp", centralStatus: "APPROVED", amount: 200 });
    await ordre("A-refuse", { companyId: aId, sourceType: "PAYMENT_REQUEST", sourceId: "x-pay", centralStatus: "REFUSED", amount: 500 });
    await ordre("A-sans-source", { companyId: aId, sourceType: null, amount: 900 });
    // ── Une demande propre au demandeur (société A).
    await ordre("A-du-demandeur", { companyId: aId, sourceType: "SPONSORING", sourceId: "x-sp2", requestedById: demandeurId, amount: 50 });
    // ── Société B : jamais ouverte au siège ni au demandeur.
    await ordre("B-reg", { companyId: bId, sourceType: "REGULATORY_PRODUCT", sourceId: "x-reg", amount: 5000 });
    await ordre("B-sm", { companyId: bId, sourceType: "SPONSORING", sourceId: "x-sp", amount: 6000, centralStatus: "APPROVED" });
    // ── Sans entité : reste visible (§118.154).
    await ordre("sans-entite", { companyId: null, sourceType: null, amount: 1 });
  }, 120_000);

  afterAll(async () => { await nettoyer(); }, 60_000);

  const pastille = (c: Awaited<ReturnType<typeof chargerCentre>>, cle: string) => c.entites.find((e) => e.cle === cle);
  const DE_A = ["A-regulatory", "A-adpro", "A-rh", "A-autorise", "A-refuse", "A-sans-source", "A-du-demandeur"];

  it("PRÉMISSES : le siège siège, n'a pas la vue globale, et ne voit pas la société B — sans quoi le reste ne prouve rien", async () => {
    expect(siege.access?.paymentCentreSeat).toBe(true);
    expect(siege.role).not.toBe("SUPER_ADMIN");
    const ouvertes = await prisma.userCompanyAccess.findMany({ where: { userId: siegeId }, select: { companyId: true } });
    expect(ouvertes.map((o) => o.companyId)).toEqual([aId]);
    expect(await prisma.expenseOrder.count({ where: { companyId: bId, label: { startsWith: TAG } } }), "la société B porte bien des ordres").toBe(2);
  });

  it("le siège rattaché à A voit la pastille A — avec ses comptes EXACTS — et jamais la société B", async () => {
    const c = await chargerCentre(siege, { entite: aId });
    expect(c.canDecide).toBe(true);
    expect(c.entites.map((e) => e.cle)).toContain(aId);
    expect(c.entites.map((e) => e.cle), "la société B n'est pas ouverte à ce siège").not.toContain(bId);
    const a = pastille(c, aId)!;
    expect(a.label).toBe(`${TAG}Alpha`);
    expect([a.total, a.enAttente]).toEqual([7, 5]);
    expect(a.montantEnAttente).toBe(100 + 300 + 700 + 900 + 50);
    expect(c.entiteChoisie).toBe(aId);
    expect(c.bilan).toMatchObject({ enAttente: 5, montantEnAttente: 2050, autorises: 1, refuses: 1 });
  });

  it("UNE SEULE FILE : un ordre Regulatory, un Ad & Pro et un RH apparaissent dans la même liste, du plus récent au plus ancien", async () => {
    const c = await chargerCentre(siege, { entite: aId });
    expect(c.idsAffiches).toEqual(expect.arrayContaining([ids["A-regulatory"], ids["A-adpro"], ids["A-rh"]]));
    // Toutes les origines, et dans l'ordre de toujours — le plus récent d'abord.
    expect(c.idsAffiches).toEqual(DE_A.map((k) => ids[k]));
    expect(c.idsEntite).toEqual(c.idsAffiches);
    expect(c.nonAffiches).toBe(0);
    expect(c, "plus de sections dans ce que le chargeur rend").not.toHaveProperty("sections");
    expect(c).not.toHaveProperty("sectionChoisie");
  });

  it("LE FILTRE SOCIÉTÉ : chaque pastille ne liste QUE ses lignes", async () => {
    const a = await chargerCentre(sa, { entite: aId });
    expect([...a.idsAffiches].sort()).toEqual(DE_A.map((k) => ids[k]!).sort());
    const b = await chargerCentre(sa, { entite: bId });
    expect(b.idsAffiches).toEqual([ids["B-reg"], ids["B-sm"]]);
    expect(b.bilan).toMatchObject({ enAttente: 1, autorises: 1 });
  });

  it("une entité FORGÉE ou d'une autre société ne s'ouvre pas : le siège retombe sur la sienne, et rien de B ne sort", async () => {
    for (const forge of [bId, "n-importe-quoi", "", null]) {
      const c = await chargerCentre(siege, { entite: forge });
      expect(c.entiteChoisie, `entité demandée : ${String(forge)}`).not.toBe(bId);
      const lus = await prisma.expenseOrder.findMany({ where: { id: { in: c.idsAffiches } }, select: { companyId: true } });
      expect(lus.every((l) => l.companyId !== bId), "aucune ligne de la société B").toBe(true);
      expect(c.idsAffiches).not.toContain(ids["B-reg"]);
      expect(c.idsAffiches).not.toContain(ids["B-sm"]);
    }
  });

  it("TÉMOIN : le Super Admin voit les DEUX sociétés, avec leurs comptes — la garde ne refuse pas tout", async () => {
    const c = await chargerCentre(sa, { entite: bId });
    expect(c.entites.map((e) => e.cle)).toEqual(expect.arrayContaining([aId, bId]));
    expect(c.entiteChoisie).toBe(bId);
    expect([pastille(c, bId)!.total, pastille(c, bId)!.enAttente]).toEqual([2, 1]);
    expect(pastille(c, bId)!.montantEnAttente).toBe(5000);
  });

  it("une ligne SANS entité reste visible dans sa pastille « Sans entité »", async () => {
    const c = await chargerCentre(siege, { entite: ENTITE_SANS });
    expect(pastille(c, ENTITE_SANS)?.label).toBe("Sans entité");
    expect(c.entiteChoisie).toBe(ENTITE_SANS);
    expect(c.idsAffiches).toContain(ids["sans-entite"]);
    const sa2 = await chargerCentre(sa, { entite: ENTITE_SANS });
    expect(sa2.idsAffiches).toContain(ids["sans-entite"]);
  });

  it("le demandeur non siège ne lit QUE ses demandes : pas de décision, pas de ligne des autres", async () => {
    const c = await chargerCentre(demandeur, { entite: aId });
    expect(c.canDecide).toBe(false);
    expect(c.aucunOrdre).toBe(false);
    expect(c.idsAffiches).toEqual([ids["A-du-demandeur"]]);
    expect(pastille(c, aId)!.total).toBe(1);
  });

  it("qui ne siège pas et n'a rien demandé reçoit « aucun ordre » — l'écran dit la règle au lieu d'un tableau vide", async () => {
    const c = await chargerCentre(vide, {});
    expect([c.canDecide, c.aucunOrdre]).toEqual([false, true]);
    expect(c.idsAffiches).toEqual([]);
  });

  it("sans paramètre (ancien lien) : l'entité de la personne s'ouvre si elle n'en a qu'une ; sinon celle qui attend le plus", async () => {
    const c = await chargerCentre(siege, {});
    expect(c.entiteChoisie).toBe(aId);
    expect(c.idsAffiches).toEqual(DE_A.map((k) => ids[k]));
    const toutes = await chargerCentre(sa, {});
    const choisie = pastille(toutes, toutes.entiteChoisie!)!;
    expect(toutes.entites.length).toBeGreaterThan(1);
    expect(toutes.entites.every((e) => e.enAttente <= choisie.enAttente), "aucune pastille n'attend plus que celle qui s'ouvre").toBe(true);
  });

  it("L'EXPORT suit l'écran : toute l'entité, toutes origines — un ancien `section` n'y filtre plus rien", async () => {
    const r = await exporterOrdresCentre(siege as never, { entite: aId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fichier.resume).toMatch(/^7 ordre\(s\) du centre de paiement — /);
    // L'outil de l'assistant ne connaît plus de section : un argument périmé est ignoré, pas une erreur.
    const ancien = await exporterOrdresCentre(siege as never, { entite: aId, section: "regulatory" } as never);
    expect(ancien.ok && ancien.fichier.resume).toMatch(/^7 ordre\(s\)/);
  });

  it("la liste est coupée à la limite ET le dit : le compte reste exact, les plus anciens sont comptés non affichés", async () => {
    const trop = LIMITE_LIGNES_CENTRE + 5;
    await prisma.expenseOrder.createMany({
      data: Array.from({ length: trop }, (_, i) => ({
        reference: `${TAG}OD-gros-${String(i).padStart(4, "0")}`, label: `${TAG}gros-${i}`, amount: 1, category: "AUTRE" as const,
        companyId: bId, sourceType: null, centralStatus: "AWAITING", requestedById: saId,
        createdAt: new Date(T0 - (100 + i) * 60_000),
      })),
    });
    const c = await chargerCentre(sa, { entite: bId });
    expect(c.idsAffiches).toHaveLength(LIMITE_LIGNES_CENTRE);
    expect(c.nonAffiches).toBe(2 + trop - LIMITE_LIGNES_CENTRE);
    expect(c.idsEntite).toHaveLength(2 + trop);
    expect(pastille(c, bId)!.total, "le compte de la pastille est exact, pas celui de la liste").toBe(2 + trop);
  }, 60_000);
});

describe("l'écran lit la règle — points d'appel (§118.49)", () => {
  const lire = (f: string) => readFileSync(join(process.cwd(), f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  it("la page passe par le chargeur, et le chargeur par la portée de fiche", () => {
    const page = lire("src/app/(app)/centre-de-paiement/page.tsx");
    expect(page).toMatch(/chargerCentre\(\s*user\s*,/);
    expect(page, "l'adresse n'est jamais lue telle quelle : tout passe par le chargeur").not.toMatch(/searchParams\??\.entite[^,)}\n]*companyId/);
    expect(page, "la page ne recompose plus sa propre portée").not.toMatch(/companyScopedWhere/);
    const chargeur = lire("src/modules/finances/infra/requetes/centre-paiement.ts");
    expect(chargeur).toMatch(/ficheScopedWhere\(\s*user\.id/);
    expect(chargeur, "le cookie n'est lu que validé").toMatch(/myCompanyScope\(\s*user\.id\s*\)/);
    expect(chargeur, "jamais le cookie brut").not.toMatch(/getCompanyScope\(/);
    expect(chargeur).toMatch(/choisirEntite\(/);
  });

  it("UN ANCIEN LIEN `?section=regulatory` rend le centre unique : la page ne lit plus la section, n'a plus d'onglets ni de bandeau de repli", () => {
    const page = lire("src/app/(app)/centre-de-paiement/page.tsx");
    expect(page, "la section de l'adresse n'est plus lue").not.toMatch(/searchParams\??\.section/);
    expect(page).not.toMatch(/OngletsSections|sectionChoisie|\.repli\b|SECTION_CENTRE/);
    expect(page, "l'export ne porte plus de section").not.toMatch(/[?&]section=/);
    const nav = lire("src/app/(app)/centre-de-paiement/centre-navigation.tsx");
    expect(nav).not.toMatch(/OngletsSections|section/i);
    const route = lire("src/app/api/finances/centre/export/route.ts");
    expect(route, "la route d'export ignore un ancien `?section=`").not.toMatch(/get\("section"\)/);
  });

  it("l'écran montre les entités PUIS la file, et le tableau ne se recharge que par liens", () => {
    const page = lire("src/app/(app)/centre-de-paiement/page.tsx");
    expect(page).toMatch(/<BarreEntites\s+entites=\{centre\.entites\}/);
    expect(page.indexOf("<BarreEntites"), "les entités sont EN HAUT").toBeLessThan(page.indexOf("<CentreBoard"));
    const nav = lire("src/app/(app)/centre-de-paiement/centre-navigation.tsx");
    expect(nav).toMatch(/<Link[\s\S]{0,80}href=\{hrefCentre\(e\.cle\)\}/);
    expect(nav).toMatch(/aria-current/);
    const board = lire("src/app/(app)/centre-de-paiement/centre-board.tsx");
    // `useAction` (audit FRONTEND-UX-01) porte `useRafraichir` : son `busy` couvre l'appel ET le rafraîchissement.
    expect(board, "après une décision, les gestes restent fermés jusqu'à l'arrivée des nouvelles données").toMatch(/useAction\(\)/);
    expect(lire("src/components/shared/use-action.ts"), "le crochet attend le rafraîchissement").toMatch(/useRafraichir\(\)/);
    expect(board).not.toMatch(/router\.refresh\(\)/);
    expect((board.match(/disabled=\{busy\}/g) ?? []).length, "Autoriser, Refuser et Répondre se ferment pendant le rafraîchissement").toBeGreaterThanOrEqual(3);
    expect(board, "la double lecture montant/bénéficiaire reste envoyée").toMatch(/montantVu/);
    expect(board).toMatch(/beneficiaireVu/);
    expect(board, "l'origine de chaque paiement reste dite sur sa ligne").toMatch(/o\.sourceLabel/);
  });
});
