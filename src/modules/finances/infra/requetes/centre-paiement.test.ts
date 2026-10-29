import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { chargerCentre, LIMITE_LIGNES_CENTRE } from "./centre-paiement";
import { ENTITE_SANS } from "../../domaine/sections-centre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CHARGEUR DU CENTRE DE PAIEMENT PAR SON VRAI POINT D'ENTRÉE (§118.211) — les entités en haut,
 * trois sections dessous, et rien qui s'élargisse.
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

const TAG = "__cp211__";
const session = async (id: string, role: string): Promise<SessionUser> =>
  ({ id, name: `${TAG}${role}`, email: `${TAG}${id}@t.dz`, role, secondaryRole: null, access: await getAccess(id, role as never), mustChangePassword: false }) as unknown as SessionUser;

suite("le centre de paiement : entités puis sections, par le chargeur", () => {
  let aId = "", bId = "", siegeId = "", demandeurId = "", saId = "", videId = "";
  let siege: SessionUser, demandeur: SessionUser, sa: SessionUser, vide: SessionUser;
  const ids: Record<string, string> = {};
  let seq = 0;

  async function nettoyer() {
    const societes = await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    const socIds = societes.map((s) => s.id);
    await prisma.expenseOrder.deleteMany({ where: { OR: [{ reference: { startsWith: TAG } }, { label: { startsWith: TAG } }] } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.consultingContract.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.paymentCentreSeat.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.userCompanyAccess.deleteMany({ where: { companyId: { in: socIds } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: socIds } } }).catch(() => {});
  }

  /** Un ordre du décor — par la même table que le vrai écrivain, avec une référence à soi. */
  async function ordre(cle: string, o: {
    companyId: string | null; sourceType?: string | null; sourceId?: string | null;
    centralStatus?: string; amount?: number; requestedById?: string | null;
  }) {
    const r = await prisma.expenseOrder.create({
      data: {
        reference: `${TAG}OD-${String(++seq).padStart(4, "0")}`,
        label: `${TAG}${cle}`,
        amount: o.amount ?? 1000,
        category: "AUTRE",
        companyId: o.companyId,
        sourceType: (o.sourceType ?? null) as never,
        sourceId: o.sourceId ?? null,
        centralStatus: o.centralStatus ?? "AWAITING",
        requestedById: o.requestedById ?? saId,
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

    // ── Les PORTEURS, avec une vraie origine.
    const pr = await prisma.paymentRequest.create({
      data: { reference: `${TAG}PAY-1`, title: `${TAG}dem paiement`, amount: 1000, payee: "x", requesterId: saId, entityType: "SPONSORING", entityId: "x-sponsoring" }, select: { id: true },
    });
    const prMuette = await prisma.paymentRequest.create({
      data: { reference: `${TAG}PAY-2`, title: `${TAG}dem muette`, amount: 1000, payee: "x", requesterId: saId }, select: { id: true },
    });
    const ar = await prisma.administrativeRequest.create({
      data: { reference: `${TAG}REQ-1`, title: `${TAG}sec`, type: "PAYMENT" as never, linkedEntityType: "REGULATORY_PRODUCT", linkedEntityId: "x-reg", requesterId: saId } as never, select: { id: true },
    });
    const ld = await prisma.legalDocument.create({
      data: { title: `${TAG}facture promo`, kind: "INVOICE", sourceType: "PROMO_MATERIAL", sourceId: "x-promo", createdById: saId } as never, select: { id: true },
    });
    const cAdPro = await prisma.consultingContract.create({
      data: { reference: `${TAG}CONS-1`, title: `${TAG}c1`, counterparty: "x", pole: "AD_PRO" } as never, select: { id: true },
    });
    const cRh = await prisma.consultingContract.create({
      data: { reference: `${TAG}CONS-2`, title: `${TAG}c2`, counterparty: "x", pole: "RH" } as never, select: { id: true },
    });

    // ── Société A : REGULATORY 2 (1 en attente), SALES_MARKETING 4 (3 en attente), AUTRES 4 (4 en attente, 2 de repli).
    await ordre("A-reg-direct", { companyId: aId, sourceType: "REGULATORY_PRODUCT", sourceId: "x-reg", amount: 100 });
    await ordre("A-reg-secretariat", { companyId: aId, sourceType: "ADMIN_REQUEST", sourceId: ar.id, centralStatus: "APPROVED", amount: 200 });
    await ordre("A-sm-direct", { companyId: aId, sourceType: "SPONSORING", sourceId: "x-sponsoring", amount: 300 });
    await ordre("A-sm-demande", { companyId: aId, sourceType: "PAYMENT_REQUEST", sourceId: pr.id, amount: 400 });
    await ordre("A-sm-legal", { companyId: aId, sourceType: "LEGAL_DOCUMENT", sourceId: ld.id, centralStatus: "REFUSED", amount: 500 });
    await ordre("A-sm-consulting", { companyId: aId, sourceType: "CONSULTING_CONTRACT", sourceId: cAdPro.id, amount: 600 });
    await ordre("A-au-paie", { companyId: aId, sourceType: "PAYROLL", sourceId: "x-paie", amount: 700 });
    await ordre("A-au-consulting-rh", { companyId: aId, sourceType: "CONSULTING_CONTRACT", sourceId: cRh.id, amount: 800 });
    await ordre("A-au-sans-source", { companyId: aId, sourceType: null, amount: 900 });
    await ordre("A-au-demande-muette", { companyId: aId, sourceType: "PAYMENT_REQUEST", sourceId: prMuette.id, amount: 1000 });
    // ── Société B : jamais ouverte au siège ni au demandeur.
    await ordre("B-reg", { companyId: bId, sourceType: "REGULATORY_PRODUCT", sourceId: "x-reg", amount: 5000 });
    await ordre("B-sm", { companyId: bId, sourceType: "SPONSORING", sourceId: "x-sp", amount: 6000, centralStatus: "APPROVED" });
    // ── Sans entité : reste visible (§118.154).
    await ordre("sans-entite", { companyId: null, sourceType: null, amount: 1 });
    // ── Une demande propre au demandeur (société A).
    await ordre("A-du-demandeur", { companyId: aId, sourceType: "SPONSORING", sourceId: "x-sp2", requestedById: demandeurId, amount: 50 });
  }, 120_000);

  afterAll(async () => { await nettoyer(); }, 60_000);

  const pastille = (c: Awaited<ReturnType<typeof chargerCentre>>, cle: string) => c.entites.find((e) => e.cle === cle);
  const sec = (c: Awaited<ReturnType<typeof chargerCentre>>, s: string) => c.sections.find((x) => x.section === s)!;

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
    // 11 ordres en A (dont celui du demandeur), 9 en attente : un autorisé et un refusé.
    expect([a.total, a.enAttente]).toEqual([11, 9]);
    expect(a.montantEnAttente).toBe(100 + 300 + 400 + 600 + 700 + 800 + 900 + 1000 + 50);
    expect(c.entiteChoisie).toBe(aId);
  });

  it("les trois sections de A : chaque ordre est rangé d'après son ORIGINE (porteurs, consulting RH, repli compris)", async () => {
    const c = await chargerCentre(siege, { entite: aId, section: "regulatory" });
    expect(c.sectionChoisie).toBe("REGULATORY");
    expect([sec(c, "REGULATORY").total, sec(c, "REGULATORY").enAttente]).toEqual([2, 1]);
    // Sales & Marketing : sponsoring, demande de paiement liée à un sponsoring, facture d'un matériel promo, consulting Ad & Pro, + celui du demandeur.
    expect([sec(c, "SALES_MARKETING").total, sec(c, "SALES_MARKETING").enAttente]).toEqual([5, 4]);
    // Autres : paie, consulting passé aux RH, sans source, demande de paiement muette.
    expect([sec(c, "AUTRES").total, sec(c, "AUTRES").enAttente]).toEqual([4, 4]);
    expect(sec(c, "AUTRES").repli, "deux lignes y sont faute d'origine lisible : sans source, et demande muette").toBe(2);
    expect(sec(c, "REGULATORY").repli).toBe(0);
    expect(sec(c, "SALES_MARKETING").repli).toBe(0);
    expect(c.bilan).toMatchObject({ enAttente: 9, autorises: 1, refuses: 1 });
    expect(c.idsAffiches.sort()).toEqual([ids["A-reg-direct"], ids["A-reg-secretariat"]].sort());
  });

  it("chaque section ne liste QUE ses lignes", async () => {
    const sm = await chargerCentre(siege, { entite: aId, section: "sales-marketing" });
    expect(sm.sectionChoisie).toBe("SALES_MARKETING");
    expect([...sm.idsAffiches].sort()).toEqual(
      ["A-sm-direct", "A-sm-demande", "A-sm-legal", "A-sm-consulting", "A-du-demandeur"].map((k) => ids[k]!).sort(),
    );
    const au = await chargerCentre(siege, { entite: aId, section: "autres" });
    expect([...au.idsAffiches].sort()).toEqual(
      ["A-au-paie", "A-au-consulting-rh", "A-au-sans-source", "A-au-demande-muette"].map((k) => ids[k]!).sort(),
    );
  });

  it("une entité FORGÉE ou d'une autre société ne s'ouvre pas : le siège retombe sur la sienne, et rien de B ne sort", async () => {
    for (const forge of [bId, "n-importe-quoi", "", null]) {
      const c = await chargerCentre(siege, { entite: forge, section: "regulatory" });
      expect(c.entiteChoisie, `entité demandée : ${String(forge)}`).not.toBe(bId);
      const lus = await prisma.expenseOrder.findMany({ where: { id: { in: c.idsAffiches } }, select: { companyId: true } });
      expect(lus.every((l) => l.companyId !== bId), "aucune ligne de la société B").toBe(true);
    }
    // Même en demandant B pour chaque section, aucun ordre de B n'est jamais rendu.
    for (const section of ["regulatory", "sales-marketing", "autres"]) {
      const c = await chargerCentre(siege, { entite: bId, section });
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
    expect([...c.idsAffiches]).toEqual([ids["B-reg"]]);
    const sm = await chargerCentre(sa, { entite: bId, section: "sales-marketing" });
    expect(sm.idsAffiches).toEqual([ids["B-sm"]]);
    expect(sm.bilan.autorises).toBe(1);
  });

  it("une ligne SANS entité reste visible dans sa pastille « Sans entité » — et se range comme les autres", async () => {
    const c = await chargerCentre(siege, { entite: ENTITE_SANS, section: "autres" });
    expect(pastille(c, ENTITE_SANS)?.label).toBe("Sans entité");
    expect(c.entiteChoisie).toBe(ENTITE_SANS);
    expect(c.idsAffiches).toContain(ids["sans-entite"]);
    expect(sec(c, "AUTRES").repli, "sans source : un repli, et il se compte").toBeGreaterThanOrEqual(1);
    const sa2 = await chargerCentre(sa, { entite: ENTITE_SANS, section: "autres" });
    expect(sa2.idsAffiches).toContain(ids["sans-entite"]);
  });

  it("le demandeur non siège ne lit QUE ses demandes : pas de décision, pas de ligne des autres", async () => {
    const c = await chargerCentre(demandeur, { entite: aId, section: "sales-marketing" });
    expect(c.canDecide).toBe(false);
    expect(c.aucunOrdre).toBe(false);
    expect(c.idsAffiches).toEqual([ids["A-du-demandeur"]]);
    expect(pastille(c, aId)!.total).toBe(1);
    for (const s of ["regulatory", "autres"]) {
      const autre = await chargerCentre(demandeur, { entite: aId, section: s });
      expect(autre.idsAffiches).toEqual([]);
    }
  });

  it("qui ne siège pas et n'a rien demandé reçoit « aucun ordre » — l'écran dit la règle au lieu d'un tableau vide", async () => {
    const c = await chargerCentre(vide, {});
    expect([c.canDecide, c.aucunOrdre]).toEqual([false, true]);
    expect(c.idsAffiches).toEqual([]);
  });

  it("sans paramètre (ancien lien) : l'entité de la personne s'ouvre si elle n'en a qu'une ; sinon celle qui attend le plus", async () => {
    // Une seule société ouverte : c'est elle (la portée validée, jamais un identifiant lu tel quel).
    const c = await chargerCentre(siege, {});
    expect(c.entiteChoisie).toBe(aId);
    // La section ouverte est la première qui attend une décision.
    expect(c.sectionChoisie).toBe("REGULATORY");
    // Plusieurs sociétés ouvertes et aucune préférence : l'entité qui attend le plus de décisions.
    const toutes = await chargerCentre(sa, {});
    const choisie = pastille(toutes, toutes.entiteChoisie!)!;
    expect(toutes.entites.length).toBeGreaterThan(1);
    expect(toutes.entites.every((e) => e.enAttente <= choisie.enAttente), "aucune pastille n'attend plus que celle qui s'ouvre").toBe(true);
  });

  it("la liste est coupée à la limite ET le dit : le compte reste exact, les plus anciens sont comptés non affichés", async () => {
    const trop = LIMITE_LIGNES_CENTRE + 5;
    await prisma.expenseOrder.createMany({
      data: Array.from({ length: trop }, (_, i) => ({
        reference: `${TAG}OD-gros-${String(i).padStart(4, "0")}`, label: `${TAG}gros-${i}`, amount: 1, category: "AUTRE" as const,
        companyId: bId, sourceType: null, centralStatus: "AWAITING", requestedById: saId,
        createdAt: new Date(Date.now() - (i + 1) * 1000),
      })),
    });
    const c = await chargerCentre(sa, { entite: bId, section: "autres" });
    expect(sec(c, "AUTRES").total).toBe(trop);
    expect(c.idsAffiches).toHaveLength(LIMITE_LIGNES_CENTRE);
    expect(c.nonAffiches).toBe(5);
    expect(pastille(c, bId)!.total, "le compte de la pastille est exact, pas celui de la liste").toBe(2 + trop);
  }, 60_000);
});

describe("l'écran lit la règle — points d'appel (§118.49)", () => {
  const lire = (f: string) => readFileSync(join(process.cwd(), f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  it("la page passe par le chargeur, et le chargeur par la règle de classement ET par la portée de fiche", () => {
    const page = lire("src/app/(app)/centre-de-paiement/page.tsx");
    expect(page).toMatch(/chargerCentre\(\s*user\s*,/);
    expect(page, "l'adresse n'est jamais lue telle quelle : tout passe par le chargeur").not.toMatch(/searchParams\??\.entite[^,)}\n]*companyId/);
    expect(page, "la page ne recompose plus sa propre portée").not.toMatch(/companyScopedWhere/);
    const chargeur = lire("src/modules/finances/infra/requetes/centre-paiement.ts");
    expect(chargeur).toMatch(/classerOrdre\(\{/);
    expect(chargeur).toMatch(/ficheScopedWhere\(\s*user\.id/);
    expect(chargeur, "le cookie n'est lu que validé").toMatch(/myCompanyScope\(\s*user\.id\s*\)/);
    expect(chargeur, "jamais le cookie brut").not.toMatch(/getCompanyScope\(/);
    expect(chargeur).toMatch(/choisirEntite\(/);
    expect(chargeur).toMatch(/choisirSection\(/);
  });

  it("l'écran montre les entités PUIS les trois sections, et le tableau ne se recharge que par liens", () => {
    const page = lire("src/app/(app)/centre-de-paiement/page.tsx");
    expect(page).toMatch(/<BarreEntites\s+entites=\{centre\.entites\}/);
    expect(page).toMatch(/<OngletsSections\s+sections=\{centre\.sections\}/);
    expect(page.indexOf("<BarreEntites"), "les entités sont EN HAUT").toBeLessThan(page.indexOf("<OngletsSections"));
    const nav = lire("src/app/(app)/centre-de-paiement/centre-navigation.tsx");
    expect(nav).toMatch(/<Link[\s\S]{0,80}href=\{hrefCentre\(e\.cle, section\)\}/);
    expect(nav).toMatch(/aria-current/);
    const board = lire("src/app/(app)/centre-de-paiement/centre-board.tsx");
    // `useAction` (audit FRONTEND-UX-01) porte `useRafraichir` : son `busy` couvre l'appel ET le rafraîchissement.
    expect(board, "après une décision, les gestes restent fermés jusqu'à l'arrivée des nouvelles données").toMatch(/useAction\(\)/);
    expect(lire("src/components/shared/use-action.ts"), "le crochet attend le rafraîchissement").toMatch(/useRafraichir\(\)/);
    expect(board).not.toMatch(/router\.refresh\(\)/);
    expect((board.match(/disabled=\{busy\}/g) ?? []).length, "Autoriser, Refuser et Répondre se ferment pendant le rafraîchissement").toBeGreaterThanOrEqual(3);
    expect(board, "la double lecture montant/bénéficiaire reste envoyée").toMatch(/montantVu/);
    expect(board).toMatch(/beneficiaireVu/);
  });
});
