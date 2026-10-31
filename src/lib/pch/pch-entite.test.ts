import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// Hors requête, `cookies()` lève : la sélection d'en-tête vaut « toutes les entités ».
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { createTender, updateTender, deleteTender, createOrder } from "@/lib/actions/pch-actions";
import { updateTenderLine, createOrderFromLine } from "@/lib/actions/pch-tender-line-actions";
import { runPchDeadlineSweep } from "@/lib/pch/deadline-sweep";
import { GET as exporterMarche } from "@/app/api/pch/export/route";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN MARCHÉ PCH APPARTIENT À SA SOCIÉTÉ — la fiche, l'export, les gestes, les rappels
 * (§118.184 — audit 360°, S11).
 *
 * Mesuré par l'audit : la fiche chargeait un marché par son seul identifiant, l'export ne lisait que
 * le droit de module, trente gestes aussi, et le rappel d'échéance partait chez tous les gestionnaires
 * PCH du groupe. Joué avec le VRAI rôle qui gère les marchés (gestionnaire logistique : PCH en gestion
 * complète) rattaché à UNE société — la prémisse le vérifie, sans quoi le refus pourrait venir du module.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = "__pchent__";
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

suite("PCH — un marché ne sort pas de sa société", () => {
  let A = "", B = "";
  const u: Record<string, string> = {};
  const t: Record<string, string> = {};
  const l: Record<string, string> = {};
  const acteurs: Record<string, SessionUser> = {};

  async function nettoyer() {
    const ts = await prisma.pchTender.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } });
    const ids = ts.map((x) => x.id);
    await prisma.notification.deleteMany({ where: { body: { contains: TAG }, createdAt: { gte: new Date(Date.now() - 86_400_000) } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.pchOrder.deleteMany({ where: { tenderId: { in: ids } } }).catch(() => {});
    await prisma.pchTenderLine.deleteMany({ where: { tenderId: { in: ids } } }).catch(() => {});
    await prisma.pchTender.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    [A, B] = (await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    // Le Super Admin voit tout le groupe : sa clause d'entité est VIDE — le cas où Prisma écarte un `{}`
    // placé dans un `OR` (mesuré), et où chaque geste lui était refusé.
    u.sa = (await prisma.user.create({ data: { name: `${TAG}sa`, email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } })).id;
    acteurs.sa = { id: u.sa, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(u.sa, "SUPER_ADMIN") } as unknown as SessionUser;
    for (const [k, companyId] of [["gestA", A], ["gestB", B], ["respA", A]] as const) {
      const user = await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role: "LOGISTICS_MANAGER", passwordHash: "x" } });
      u[k] = user.id;
      await prisma.employee.create({ data: { fullName: `${TAG}${k}`, companyId, userId: user.id } });
      acteurs[k] = { id: user.id, role: "LOGISTICS_MANAGER", secondaryRole: null, access: await getAccess(user.id, "LOGISTICS_MANAGER") } as unknown as SessionUser;
    }
    const dans = (jours: number) => new Date(Date.now() + jours * 86_400_000);
    t.A = (await prisma.pchTender.create({ data: { reference: `${TAG}AO-A`, title: `${TAG}Marché Alpha`, companyId: A, submissionDeadline: dans(5) } })).id;
    // Le responsable du marché de Beta est un gestionnaire d'ALPHA : il le rouvre, et il est prévenu.
    t.B = (await prisma.pchTender.create({ data: { reference: `${TAG}AO-B`, title: `${TAG}Marché Beta`, companyId: B, submissionDeadline: dans(5), responsibleId: u.respA } })).id;
    l.A = (await prisma.pchTenderLine.create({ data: { tenderId: t.A, designation: `${TAG}lot A`, status: "WON", unitPriceDzd: 100 } })).id;
    l.B = (await prisma.pchTenderLine.create({ data: { tenderId: t.B, designation: `${TAG}lot B` } })).id;
  });

  afterAll(async () => { await nettoyer(); });

  const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

  it("PRÉMISSE : le gestionnaire gère pleinement le module PCH — un refus ne peut venir que de la société", () => {
    for (const a of ["VIEW", "CREATE", "UPDATE", "DELETE"] as const) expect(acteurs.gestA.access.modules.get("PCH")?.actions.has(a)).toBe(true);
  });

  it("LA FICHE : chacun ouvre le marché de sa société, pas celui de l'autre ; le responsable rouvre le sien d'où qu'il soit", async () => {
    expect(await canAccessEntity(acteurs.gestA, "PCH_TENDER", t.A, "VIEW")).toBe(true);
    expect(await canAccessEntity(acteurs.gestA, "PCH_TENDER", t.B, "VIEW")).toBe(false);
    expect(await canAccessEntity(acteurs.gestB, "PCH_TENDER", t.B, "VIEW")).toBe(true);
    expect(await canAccessEntity(acteurs.respA, "PCH_TENDER", t.B, "VIEW")).toBe(true);
    // Le témoin de la clause VIDE : le Super Admin ouvre et modifie les deux.
    expect(await canAccessEntity(acteurs.sa, "PCH_TENDER", t.A, "UPDATE")).toBe(true);
    expect(await canAccessEntity(acteurs.sa, "PCH_TENDER", t.B, "UPDATE")).toBe(true);
  });

  it("L'EXPORT : le tableau de réponse d'un marché d'une autre société ne se télécharge pas", async () => {
    const statut = async (k: string, id: string) => {
      ACTEUR = acteurs[k];
      return (await exporterMarche(new NextRequest(`http://x/api/pch/export?id=${id}`))).status;
    };
    expect(await statut("gestA", t.B)).toBe(404);
    expect(await statut("gestA", t.A)).toBe(200);
  });

  it("MODIFIER, SUPPRIMER, COMMANDER : refusé sur le marché d'une autre société, rien n'est écrit", async () => {
    ACTEUR = acteurs.gestA;
    expect(await updateTender(fd({ id: t.B, title: "piraté" }))).toEqual({ ok: false, error: "Appel d'offres introuvable." });
    expect(await deleteTender(fd({ id: t.B }))).toEqual({ ok: false, error: "Appel d'offres introuvable." });
    expect(await createOrder(fd({ tenderId: t.B, reference: `${TAG}BC` }))).toEqual({ ok: false, error: "Appel d'offres introuvable." });
    const b = await prisma.pchTender.findUniqueOrThrow({ where: { id: t.B }, select: { title: true } });
    expect(b.title).toBe(`${TAG}Marché Beta`);
    expect(await prisma.pchOrder.count({ where: { tenderId: t.B } })).toBe(0);
    // Le témoin : sur SON marché, le même geste passe.
    expect((await updateTender(fd({ id: t.A, title: `${TAG}Marché Alpha` }))).ok).toBe(true);
  });

  it("UNE MODIFICATION PARTIELLE n'efface pas ce qu'elle ne porte pas — la date limite de dépôt survit", async () => {
    ACTEUR = acteurs.gestA;
    const avant = await prisma.pchTender.findUniqueOrThrow({ where: { id: t.A }, select: { submissionDeadline: true, cautionDeposited: true } });
    expect(avant.submissionDeadline).not.toBeNull();
    expect((await updateTender(fd({ id: t.A, notes: "relu" }))).ok).toBe(true);
    const apres = await prisma.pchTender.findUniqueOrThrow({ where: { id: t.A }, select: { submissionDeadline: true, notes: true } });
    expect(apres.submissionDeadline?.getTime()).toBe(avant.submissionDeadline?.getTime());
    expect(apres.notes).toBe("relu");
    // La case : cochée → oui ; le témoin seul → non ; absente → inchangée.
    const caution = async (f: FormData) => { await updateTender(f); return (await prisma.pchTender.findUniqueOrThrow({ where: { id: t.A }, select: { cautionDeposited: true } })).cautionDeposited; };
    const coche = fd({ id: t.A }); coche.append("cautionDeposited", "off"); coche.append("cautionDeposited", "on");
    expect(await caution(coche)).toBe(true);
    expect(await caution(fd({ id: t.A, notes: "relu" }))).toBe(true);
    expect(await caution(fd({ id: t.A, cautionDeposited: "off" }))).toBe(false);
  });

  it("LE MARCHÉ SE LIT EN BASE : la ligne de l'autre société ne se modifie pas en envoyant l'identifiant de son propre marché", async () => {
    ACTEUR = acteurs.gestA;
    expect(await updateTenderLine(fd({ id: l.B, tenderId: t.A, designation: "piraté" }))).toEqual({ ok: false, error: "Ligne introuvable." });
    expect((await prisma.pchTenderLine.findUniqueOrThrow({ where: { id: l.B } })).designation).toBe(`${TAG}lot B`);
    // Un bon ne naît pas sur le marché de Beta en portant le lot d'Alpha.
    expect(await createOrderFromLine(fd({ lineId: l.A, tenderId: t.B, quantity: "10" }))).toEqual({ ok: false, error: "Ligne introuvable." });
    expect(await prisma.pchOrder.count({ where: { tenderId: t.B } })).toBe(0);
    // Le témoin : son propre lot, sur son propre marché.
    expect((await createOrderFromLine(fd({ lineId: l.A, tenderId: t.A, quantity: "10" }))).ok).toBe(true);
  });

  it("CRÉER : un marché ne se range pas chez une société qu'on ne voit pas", async () => {
    ACTEUR = acteurs.gestA;
    expect(await createTender(undefined, fd({ reference: `${TAG}AO-forge`, companyId: B }))).toEqual({ ok: false, error: "Cette entité ne vous est pas ouverte." });
    expect(await prisma.pchTender.count({ where: { reference: `${TAG}AO-forge` } })).toBe(0);
  });

  it("LES RAPPELS D'ÉCHÉANCE ne portent un marché qu'à qui peut l'ouvrir", async () => {
    await prisma.pchTender.updateMany({ where: { id: { in: [t.A, t.B] } }, data: { deadlineRemindedAt: null } });
    await runPchDeadlineSweep(new Date());
    const recu = async (k: string, titre: string) =>
      (await prisma.notification.count({ where: { userId: u[k], body: { contains: titre } } })) > 0;
    expect(await recu("gestB", "Marché Beta")).toBe(true);
    expect(await recu("gestA", "Marché Beta")).toBe(false);
    expect(await recu("respA", "Marché Beta")).toBe(true);
    expect(await recu("gestA", "Marché Alpha")).toBe(true);
    expect(await recu("gestB", "Marché Alpha")).toBe(false);
  });

  it("POINTS D'APPEL : la fiche et l'export passent par la porte AVANT de charger le marché", () => {
    const fiche = readFileSync("src/app/(app)/pch/[id]/page.tsx", "utf8");
    const porte = fiche.indexOf('canAccessEntity(user, "PCH_TENDER", params.id, "VIEW")');
    expect(porte).toBeGreaterThan(0);
    expect(porte).toBeLessThan(fiche.indexOf("getPchTenderDetail(params.id)"));
    const route = readFileSync("src/lib/exports/appel-d-offres.ts", "utf8");
    const porteExport = route.indexOf('canAccessEntity(user, "PCH_TENDER", id, "VIEW")');
    expect(porteExport).toBeGreaterThan(0);
    expect(porteExport).toBeLessThan(route.indexOf("prisma.pchTender.findUnique"));
  });

  it("POINTS D'APPEL : chaque geste exporté des trois fichiers d'actions PCH porte une porte", () => {
    for (const fichier of ["pch-actions", "pch-market-actions", "pch-tender-line-actions"]) {
      const src = readFileSync(`src/lib/actions/${fichier}.ts`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const corps = src.split(/\nexport async function /).slice(1);
      expect(corps.length).toBeGreaterThan(5);
      for (const c of corps) {
        const nom = c.slice(0, c.indexOf("("));
        const garde = /peutAgirSurLeMarche\(|loadEditableSubmission\(user|canAccessEntity\(user, "LEGAL_DOCUMENT"|entitePermisePourFiche\(/.test(c);
        expect(garde, `${fichier}:${nom} n'a aucune porte de marché`).toBe(true);
      }
    }
  });
});
