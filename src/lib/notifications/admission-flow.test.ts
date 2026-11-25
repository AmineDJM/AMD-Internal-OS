import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

class Redirection extends Error {
  constructor(readonly vers: string) { super(`redirect ${vers}`); }
}
vi.mock("next/navigation", () => ({
  redirect: (vers: string) => { throw new Redirection(vers); },
  notFound: () => { throw new Error("notFound"); },
  useRouter: () => ({ push: () => {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, requireModule: async () => ACTOR,
}));

import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import { createExpenseOrder, chargerCentre } from "@/modules/finances/api";
import { decidePayment } from "@/modules/finances/actions-centre";
import { exporterOrdresCentre } from "@/lib/exports/paiements";
import { notifyRoles, notifyUser } from "@/lib/notify";
import { clauseNotificationsOuvrables, clauseOuvrablesDe } from "./admission";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

// Un suffixe par passage (§118.136) : le ménage d'un passage voisin ne retire pas nos comptes en plein test.
const TAG = `__notifsAcces__${Date.now().toString(36)}`;

async function acteur(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role: u.role, secondaryRole: u.secondaryRole, access: await getAccess(id, u.role), mustChangePassword: false } as CurrentUser;
}

/**
 * « AUCUNE NOTIFICATION D'UN MODULE À QUELQU'UN QUI N'Y A PAS ACCÈS, ET AUCUN ACCÈS ANORMAL » (Super Admin, 25/11/2026).
 *
 * Le cas constaté : le Directeur des opérations, à qui le centre de paiement n'est pas donné, recevait « Autorisation de
 * paiement demandée » avec `/centre-de-paiement?entite=…`, et l'ouvrait. Ce banc part des VRAIS gestes : un ordre naît au
 * centre (`createExpenseOrder`), le centre décide (`decidePayment`), l'écran, l'export et le dossier sont ouverts.
 */
suite("Notifications — seuls ceux qui ont le module ; le centre de paiement à la Direction générale seule", () => {
  const u: Record<string, string> = {};
  const ordres: string[] = [];
  let ordreOd = "", dossierOd = "", ordreSa = "", dossierSa = "";

  beforeAll(async () => {
    const mk = (cle: string, role: UserRole) =>
      prisma.user.create({ data: { name: `${TAG}${cle}`, email: `${TAG}${cle}@t.dz`, role, passwordHash: "x" }, select: { id: true } });
    const [gm, gmBloque, od, odConsole, sa, delegue] = await Promise.all([
      mk("gm", "GENERAL_MANAGER"), mk("gm-bloque", "GENERAL_MANAGER"), mk("od", "OPERATIONS_DIRECTOR"),
      mk("od-console", "OPERATIONS_DIRECTOR"), mk("sa", "SUPER_ADMIN"), mk("delegue", "MEDICAL_DELEGATE"),
    ]);
    Object.assign(u, { gm: gm.id, gmBloque: gmBloque.id, od: od.id, odConsole: odConsole.id, sa: sa.id, delegue: delegue.id });
    await prisma.userAccess.createMany({
      data: [
        // La console FERME le centre à un Directeur Général…
        { userId: u.gmBloque, module: "PAYMENT_CENTRE", canView: false },
        // … et ne l'OUVRE à personne d'autre : la case cochée au Directeur des opérations n'en fait pas un siège.
        { userId: u.odConsole, module: "PAYMENT_CENTRE", canView: true, canValidate: true },
      ],
    });
    const nouvelOrdre = async (label: string, requestedById: string) => {
      const o = await createExpenseOrder({
        label: `${TAG} ${label}`, amount: 12_000, category: "AUTRE",
        sourceType: "ADMIN_REQUEST", sourceId: `ar-${Math.random().toString(36).slice(2)}`, requestedById,
        justificatif: { fichier: new File([`proforma ${Math.random()}`], "proforma.pdf", { type: "application/pdf" }), nature: "PROFORMA" },
      });
      ordres.push(o.id);
      const d = await prisma.paymentRequest.findFirstOrThrow({ where: { expenseOrderId: o.id }, select: { id: true } });
      return [o.id, d.id] as const;
    };
    [ordreOd, dossierOd] = await nouvelOrdre("ordre du directeur des opérations", u.od);
    [ordreSa, dossierSa] = await nouvelOrdre("ordre du super admin", u.sa);
  }, 120_000);

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { OR: [{ user: { email: { startsWith: TAG } } }, { body: { contains: TAG } }] } }).catch(() => {});
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } }).catch(() => {});
    const dossiers = await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ordres } }, select: { id: true } });
    await prisma.paymentPiece.deleteMany({ where: { requestId: { in: dossiers.map((d) => d.id) } } }).catch(() => {});
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers.map((d) => d.id) } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  const notifiesDe = async (titre: string, ref: string) =>
    (await prisma.notification.findMany({ where: { title: titre, body: { contains: ref } }, select: { userId: true } })).map((n) => n.userId);

  it("un ordre qui entre au centre ne prévient QUE la Direction générale (Super Admin et Directeur Général non bloqué)", async () => {
    const o = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreOd }, select: { reference: true, centralStatus: true } });
    expect(o.centralStatus).toBe("AWAITING");
    const ids = await notifiesDe("Autorisation de paiement demandée", o.reference);
    expect(ids).toContain(u.gm);
    expect(ids).toContain(u.sa);
    expect(ids).not.toContain(u.gmBloque);
    expect(ids).not.toContain(u.od);
    expect(ids).not.toContain(u.odConsole);
    // Et PERSONNE d'autre dans toute la base : chaque destinataire est de la Direction générale.
    const roles = await prisma.user.findMany({ where: { id: { in: ids } }, select: { role: true, secondaryRole: true } });
    expect(roles.every((r) => ["SUPER_ADMIN", "GENERAL_MANAGER"].includes(r.role) || ["SUPER_ADMIN", "GENERAL_MANAGER"].includes(r.secondaryRole ?? ""))).toBe(true);
  });

  it("un envoi par RÔLE vers le centre (l'ancien défaut) retire le Directeur des opérations, sans bruit pour l'appelant", async () => {
    await notifyRoles(["GENERAL_MANAGER", "OPERATIONS_DIRECTOR"], {
      type: "VALIDATION_REQUIRED", title: `${TAG} par rôle`, body: TAG, link: "/centre-de-paiement?entite=company_adventum",
    });
    const ids = (await prisma.notification.findMany({ where: { title: `${TAG} par rôle` }, select: { userId: true } })).map((n) => n.userId);
    expect(ids).toContain(u.gm);
    expect(ids).not.toContain(u.od);
    expect(ids).not.toContain(u.odConsole);
    expect(ids).not.toContain(u.gmBloque);
  });

  it("le Directeur des opérations n'est pas admis : l'écran le renvoie vers ses demandes, le chargeur et l'export ne lui rendent rien", async () => {
    for (const qui of [u.od, u.odConsole]) {
      ACTOR = await acteur(qui);
      const { default: Page } = await import("@/app/(app)/centre-de-paiement/page");
      let vers: string | null = null;
      try { await Page({ searchParams: Promise.resolve({ entite: "company_adventum" }) }); } catch (e) { if (e instanceof Redirection) vers = e.vers; else throw e; }
      expect(vers).toBe("/validations/paiements");
      // Même demandeur de l'ordre ordreOd : le centre ne lui rend rien.
      const c = await chargerCentre(ACTOR, {});
      expect([c.canDecide, c.aucunOrdre, c.idsEntite.length]).toEqual([false, true, 0]);
      expect((await exporterOrdresCentre(ACTOR, {})).ok).toBe(false);
    }
  }, 120_000);

  it("le dossier d'un autre ne s'ouvre pas au Directeur des opérations ; le sien, si", async () => {
    ACTOR = await acteur(u.od);
    const { default: Dossier } = await import("@/app/(app)/validations/paiements/[id]/page");
    let vers: string | null = null;
    try { await Dossier({ params: Promise.resolve({ id: dossierSa }) }); } catch (e) { if (e instanceof Redirection) vers = e.vers; else throw e; }
    expect(vers).toBe("/validations/paiements");
    // Le sien : la garde du dossier le laisse entrer (le rendu va au-delà de la garde).
    vi.stubGlobal("React", await import("react"));
    await expect(Dossier({ params: Promise.resolve({ id: dossierOd }) })).resolves.toBeTruthy();
  }, 120_000);

  it("le DEMANDEUR garde la notification de SA demande : la décision du centre lui arrive, vers son dossier — jamais vers le centre", async () => {
    ACTOR = await acteur(u.sa);
    const fd = new FormData();
    fd.set("id", ordreOd); fd.set("decision", "REFUSE"); fd.set("body", `${TAG} non prioritaire`);
    const r = await decidePayment(fd);
    expect(r.ok, r.error).toBe(true);
    const n = await prisma.notification.findFirst({ where: { userId: u.od, title: { startsWith: "Centre de paiement" }, body: { contains: TAG } }, select: { link: true } });
    expect(n?.link).toBe(`/validations/paiements/${dossierOd}`);
  });

  it("l'exception du demandeur, nommée : une fiche adressée À LUI passe sans le module ; la même par rôle, non", async () => {
    const lien = "/rh/demandes?demande=abc";
    await notifyUser({ userId: u.delegue, type: "GENERIC", title: `${TAG} sa demande RH`, body: TAG, link: lien });
    await notifyRoles(["MEDICAL_DELEGATE"], { type: "GENERIC", title: `${TAG} file RH`, body: TAG, link: lien });
    expect(await prisma.notification.count({ where: { userId: u.delegue, title: `${TAG} sa demande RH` } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: u.delegue, title: `${TAG} file RH` } })).toBe(0);
    // Un écran de module nu, même adressé nommément : non.
    await notifyUser({ userId: u.delegue, type: "GENERIC", title: `${TAG} file nue`, body: TAG, link: "/rh/demandes" });
    expect(await prisma.notification.count({ where: { userId: u.delegue, title: `${TAG} file nue` } })).toBe(0);
  });

  it("une notification ANCIENNE vers le centre disparaît de sa cloche, de sa page et d'« Aujourd'hui » — sans être effacée", async () => {
    const ancienne = await prisma.notification.create({
      data: {
        userId: u.od, type: "VALIDATION_REQUIRED", title: `${TAG} Validation requise — Autorisation de paiement demandée`,
        body: `OD-2026-047 ${TAG}`, link: "/centre-de-paiement?entite=company_adventum",
      },
    });
    const sienne = await prisma.notification.create({
      data: { userId: u.od, type: "GENERIC", title: `${TAG} sa demande`, body: TAG, link: `/validations/paiements/${dossierOd}` },
    });
    const od = await acteur(u.od);
    const non = (w: object) => prisma.notification.findMany({ where: { AND: [{ userId: u.od, isRead: false, body: { contains: TAG } }, w] }, select: { id: true } });
    const ids = (await non(clauseNotificationsOuvrables(od))).map((n) => n.id);
    expect(ids).not.toContain(ancienne.id);
    expect(ids).toContain(sienne.id);
    // Le sondage de la cloche (sans accès résolu) lit la même règle.
    const parSondage = (await non(await clauseOuvrablesDe(u.od, "OPERATIONS_DIRECTOR"))).map((n) => n.id);
    expect(parSondage).not.toContain(ancienne.id);
    expect(parSondage).toContain(sienne.id);
    // Rien d'effacé : la ligne est toujours en base, et le Super Admin, lui, la verrait s'il en était le destinataire.
    expect(await prisma.notification.count({ where: { id: ancienne.id } })).toBe(1);

    // La page des notifications.
    ACTOR = od;
    vi.stubGlobal("React", await import("react"));
    const { default: PageNotifs } = await import("@/app/(app)/notifications/page");
    const items = trouverItems(await PageNotifs()) ?? [];
    expect(items.map((i) => i.id)).not.toContain(ancienne.id);
    expect(items.map((i) => i.id)).toContain(sienne.id);

    // « Aujourd'hui » (le centre d'actions).
    const { getActionCenter } = await import("@/lib/queries/action-center");
    const centre = await getActionCenter(od);
    expect(centre.notifications.map((n) => n.id)).not.toContain(ancienne.id);
  }, 120_000);
});

/** Les `items` passés à la liste, dans l'arbre rendu par la page. */
function trouverItems(noeud: unknown): { id: string }[] | null {
  if (!noeud || typeof noeud !== "object") return null;
  const props = (noeud as { props?: Record<string, unknown> }).props;
  if (props && Array.isArray(props.items)) return props.items as { id: string }[];
  const enfants = props?.children;
  for (const e of Array.isArray(enfants) ? enfants : [enfants]) {
    const t = trouverItems(e);
    if (t) return t;
  }
  return null;
}
