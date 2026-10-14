import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { lecteursDeLaSuite } from "@/lib/lecteurs/legal";
import { statutRetabli } from "@/lib/legal/lifecycle";
import { renewLegalDocument, cancelLegalDocument, restoreLegalDocument } from "@/lib/actions/legal-actions";
import { runLegalExpirySweep } from "@/lib/legal/expiry-sweep";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN DOCUMENT RESTREINT LE RESTE, ET UNE ANNULATION SE DÉCIDE (§118.184 — audit 360°, S7 et L04).
 *
 * Mesuré par l'audit : renouveler un contrat restreint créait une suite visible de TOUT le module (ses
 * lecteurs désignés n'étaient pas recopiés) ; les rappels d'échéance envoyaient titre et référence de
 * pièces restreintes ou d'autres sociétés à tous les gestionnaires Legal ; et la boîte « Motif de
 * l'annulation » annulait le contrat même quand on cliquait sur son bouton « Annuler ».
 * Joué avec de vrais rôles (le Directeur des Opérations contribue au module Legal) rattachés à une société.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

describe("les règles pures", () => {
  it("la suite d'un document OUVERT reste ouverte ; celle d'un document RESTREINT garde ses lecteurs, plus l'auteur d'origine", () => {
    expect(lecteursDeLaSuite([], "auteur", "renouvelle")).toEqual([]);
    expect(lecteursDeLaSuite(["x", "y"], "auteur", "x")).toEqual(["y", "auteur"]);
    expect(lecteursDeLaSuite(["x"], "x", "z")).toEqual(["x"]);
  });

  it("un document rétabli reprend l'état que sa date de fin lui donne", () => {
    const maintenant = new Date("2026-10-02T12:00:00Z");
    expect(statutRetabli(new Date("2027-01-01"), maintenant)).toBe("ACTIVE");
    expect(statutRetabli(new Date("2026-09-01"), maintenant)).toBe("EXPIRED");
    expect(statutRetabli(null, maintenant)).toBe("ACTIVE");
  });
});

const TAG = "__legrest__";
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

suite("Legal — les vraies portes", () => {
  let A = "", B = "";
  const u: Record<string, string> = {};
  const d: Record<string, string> = {};
  const acteurs: Record<string, SessionUser> = {};

  async function nettoyer() {
    const docs = await prisma.legalDocument.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
    await prisma.notification.deleteMany({ where: { body: { contains: TAG }, createdAt: { gte: new Date(Date.now() - 86_400_000) } } }).catch(() => {});
    await prisma.legalDocument.updateMany({ where: { id: { in: docs.map((x) => x.id) } }, data: { renewedFromId: null } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs.map((x) => x.id) } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    [A, B] = (await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    for (const [k, companyId] of [["auteur", A], ["lecteur", A], ["voisin", A], ["autre", B]] as const) {
      const user = await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role: "OPERATIONS_DIRECTOR", passwordHash: "x" } });
      u[k] = user.id;
      await prisma.employee.create({ data: { fullName: `${TAG}${k}`, companyId, userId: user.id } });
      acteurs[k] = { id: user.id, role: "OPERATIONS_DIRECTOR", secondaryRole: null, access: await getAccess(user.id, "OPERATIONS_DIRECTOR") } as unknown as SessionUser;
    }
    const dans = (jours: number) => new Date(Date.now() + jours * 86_400_000);
    d.restreint = (await prisma.legalDocument.create({
      data: { title: `${TAG}Contrat restreint`, kind: "CONTRACT", companyId: A, createdById: u.auteur, endDate: dans(20), readers: { create: [{ userId: u.lecteur }] } },
    })).id;
    d.ouvert = (await prisma.legalDocument.create({
      data: { title: `${TAG}Contrat ouvert`, kind: "CONTRACT", companyId: A, createdById: u.auteur, endDate: dans(25) },
    })).id;
  });

  afterAll(async () => { await nettoyer(); });

  it("PRÉMISSE : le Directeur des Opérations contribue au module Legal (créer, modifier)", () => {
    expect(acteurs.voisin.access.modules.get("LEGAL")?.actions.has("CREATE")).toBe(true);
    expect(acteurs.voisin.access.modules.get("LEGAL")?.actions.has("UPDATE")).toBe(true);
  });

  it("RENOUVELER un document restreint : refusé à qui ne le lit pas ; la suite reste restreinte, à ses lecteurs et à son auteur d'origine", async () => {
    const fd = () => { const f = new FormData(); f.set("id", d.restreint); return f; };
    ACTEUR = acteurs.voisin;
    expect(await renewLegalDocument(fd())).toEqual({ ok: false, error: "Document introuvable." });
    ACTEUR = acteurs.lecteur;
    const r = await renewLegalDocument(fd());
    expect(r.ok).toBe(true);
    const suite_ = await prisma.legalDocument.findUniqueOrThrow({ where: { id: (r as { id: string }).id }, include: { readers: true } });
    expect(suite_.createdById).toBe(u.lecteur);
    expect(suite_.readers.map((x) => x.userId)).toEqual([u.auteur]);
  });

  it("ANNULER sans motif ne fait rien ; avec motif, le motif reste au document et au journal", async () => {
    ACTEUR = acteurs.auteur;
    const sans = new FormData(); sans.set("id", d.ouvert);
    expect(await cancelLegalDocument(sans)).toEqual({ ok: false, error: "Le motif de l'annulation est obligatoire." });
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: d.ouvert } })).status).toBe("ACTIVE");
    const avec = new FormData(); avec.set("id", d.ouvert); avec.set("reason", "Prestataire changé");
    expect(await cancelLegalDocument(avec)).toEqual({ ok: true });
    const apres = await prisma.legalDocument.findUniqueOrThrow({ where: { id: d.ouvert } });
    expect(apres.status).toBe("CANCELLED");
    expect(apres.cancelReason).toBe("Prestataire changé");
  });

  it("RÉTABLIR un document annulé : il reprend son état, une seule fois, et le motif d'avant reste au journal", async () => {
    ACTEUR = acteurs.auteur;
    const f = () => { const x = new FormData(); x.set("id", d.ouvert); return x; };
    expect(await restoreLegalDocument(f())).toEqual({ ok: true });
    expect(await restoreLegalDocument(f())).toEqual({ ok: false, error: "Seul un document annulé se rétablit." });
    const apres = await prisma.legalDocument.findUniqueOrThrow({ where: { id: d.ouvert } });
    expect(apres.status).toBe("ACTIVE");
    expect(apres.cancelReason).toBeNull();
    const trace = await prisma.auditLog.findFirst({ where: { entityId: d.ouvert, newValue: "ACTIVE" }, orderBy: { createdAt: "desc" } });
    expect(trace?.summary).toMatch(/Prestataire changé/);
    await prisma.auditLog.deleteMany({ where: { entityId: d.ouvert } });
  });

  it("LES RAPPELS D'ÉCHÉANCE ne portent un titre qu'à qui peut lire le document — lecteurs désignés, et dans sa société", async () => {
    await prisma.legalDocument.updateMany({ where: { id: { in: [d.restreint, d.ouvert] } }, data: { lastRemindedAt: null, status: "ACTIVE" } });
    await runLegalExpirySweep(new Date());
    const recu = async (k: string, titre: string) =>
      (await prisma.notification.count({ where: { userId: u[k], title: { contains: "" }, body: { contains: titre } } })) > 0;
    // Le restreint : son auteur et son lecteur désigné ; ni le voisin de la même société, ni l'autre société.
    expect(await recu("auteur", "Contrat restreint")).toBe(true);
    expect(await recu("lecteur", "Contrat restreint")).toBe(true);
    expect(await recu("voisin", "Contrat restreint")).toBe(false);
    expect(await recu("autre", "Contrat restreint")).toBe(false);
    // L'ouvert : tout gestionnaire de SA société — pas celui d'une autre.
    expect(await recu("voisin", "Contrat ouvert")).toBe(true);
    expect(await recu("autre", "Contrat ouvert")).toBe(false);
  });

  it("POINT D'APPEL : abandonner la boîte du motif ne fait rien, à l'écran", () => {
    const table = readFileSync("src/app/(app)/legal/legal-table.tsx", "utf8");
    expect(table).not.toMatch(/window\.prompt\([^)]*\) \?\? ""/);
    expect(table).toMatch(/if \(saisi === null\) return;/);
    expect(table).toMatch(/restoreLegalDocument\(fd\)/);
  });
});
