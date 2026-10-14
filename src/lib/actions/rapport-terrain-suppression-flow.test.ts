import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, requireModule: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { entitePermisePourFiche } from "@/lib/company";
import { createFieldReport, deleteFieldReport, submitFieldReport } from "./field-report-actions";
import { apercuDeSuppression, destroyDeletedRecord, restoreDeletedRecord } from "./admin-delete-actions";
import { getFieldReportDetail, getMyFieldReports, managesReports, viewsAllReports } from "@/lib/queries/field-reports";
import { FIELD_REPORT_OPS_IMPL } from "@/lib/assistant/ops/impl-wave6b";
import { entrerLot, sousVerrou, trouverOuCreerArticle } from "@/lib/promo/stock-ecriture";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__rtsuppr__";
const SUFFIXE = Date.now().toString(36);

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: u.secondaryRole as SessionUser["role"] | null, access, mustChangePassword: false } as CurrentUser;
}

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

const code = (p: string): string =>
  readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SUPPRIMER UN RAPPORT TERRAIN — réversible, par la corbeille (§118.212), par les VRAIS points
 * d'entrée : l'action, l'aperçu de la fenêtre de confirmation, la restauration et la destruction
 * du Super Admin, la liste, la carte d'Adam. Des acteurs SANS vue globale (§118.104) :
 *
 *   kamA  délégué, auteur des rapports du décor
 *   kamB  délégué, collègue — il ne supprime pas le rapport d'un autre
 *   sup   Manager Promotion médicale, rattaché à la société A — il gère les rapports de SON entité
 *   ns    superviseur national — il VOIT tous les rapports sans les éditer
 *   sa    Super Admin — il restaure
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Rapport terrain — la suppression est réversible, gardée par ligne et par entité", () => {
  const ids: Record<string, string> = {};
  let A = "", B = "";
  const blobs: string[] = [];

  async function nettoyer() {
    const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    const uids = users.map((u) => u.id);
    const companies = await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    const cids = companies.map((c) => c.id);
    await prisma.deletedRecord.deleteMany({ where: { kind: "FIELD_REPORT", name: { contains: TAG } } });
    const cat = await prisma.promoCatalogueArticle.findMany({ where: { nom: { startsWith: TAG } }, select: { id: true } });
    if (cat.length) await prisma.promoStockItem.deleteMany({ where: { catalogueId: { in: cat.map((c) => c.id) } } });
    await prisma.promoCatalogueArticle.deleteMany({ where: { nom: { startsWith: TAG } } });
    if (uids.length) {
      await prisma.fieldReport.deleteMany({ where: { delegateId: { in: uids } } });
      await prisma.medicalVisit.deleteMany({ where: { delegateId: { in: uids } } });
    }
    await prisma.fieldReport.deleteMany({ where: { doctorName: { startsWith: TAG } } });
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.fileBlob.deleteMany({ where: { sha256: { startsWith: TAG } } });
    if (uids.length) {
      await prisma.notification.deleteMany({ where: { userId: { in: uids } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: uids } } }).catch(() => undefined);
      await prisma.employee.deleteMany({ where: { userId: { in: uids } } });
      await prisma.user.deleteMany({ where: { id: { in: uids } } });
    }
    if (cids.length) await prisma.company.deleteMany({ where: { id: { in: cids } } });
  }

  const comme = async (qui: string) => { ACTOR = await actorFor(ids[qui]!); };

  /** Un FileBlob minimal, tenu une fois (refCount 1) — c'est ce que la libération décrémente. */
  async function blob(): Promise<string> {
    const b = await prisma.fileBlob.create({ data: { sha256: `${TAG}${SUFFIXE}${blobs.length}`, size: 3, iv: Buffer.from("iv"), data: Buffer.from("abc"), refCount: 1 } });
    blobs.push(b.id);
    return b.id;
  }

  /** Un rapport du décor, avec ses pièces jointes et son audio. */
  async function rapport(opts: { delegate: string; company: string | null; nom: string; status?: "DRAFT" | "VALIDATED"; pieces?: number; audio?: boolean; visitId?: string; doctorIds?: string[] }) {
    const audioBlobId = opts.audio ? await blob() : null;
    const r = await prisma.fieldReport.create({
      data: {
        delegateId: ids[opts.delegate]!, companyId: opts.company, doctorName: `${TAG}${opts.nom}`, institution: "CHU Test", specialty: "Cardiologie",
        summary: `Résumé ${opts.nom}`, status: opts.status ?? "DRAFT", audioBlobId, visitId: opts.visitId ?? null, doctorIds: opts.doctorIds ?? [],
      },
    });
    const pieceIds: string[] = [];
    for (let i = 0; i < (opts.pieces ?? 0); i++) {
      const blobId = await blob();
      const a = await prisma.fieldReportAttachment.create({ data: { reportId: r.id, blobId, name: `${TAG}piece${i}.pdf`, mime: "application/pdf", size: 3 } });
      pieceIds.push(a.id);
    }
    return { id: r.id, pieceIds, audioBlobId };
  }

  const refCount = async (id: string) => (await prisma.fileBlob.findUnique({ where: { id }, select: { refCount: true } }))?.refCount ?? null;
  const existe = async (id: string) => (await prisma.fieldReport.count({ where: { id } })) === 1;
  const visite = async (opts: { delegate: string; statut?: "PLANNED" | "COMPLETED" | "CANCELLED" | "POSTPONED"; joursAvant?: number; report?: string }) =>
    (await prisma.medicalVisit.create({
      data: { delegateId: ids[opts.delegate]!, date: new Date(Date.now() - (opts.joursAvant ?? 0) * 86_400_000), status: opts.statut ?? "PLANNED", report: opts.report ?? null },
    })).id;

  beforeAll(async () => {
    await nettoyer();
    const [ca, cb] = await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })));
    A = ca.id; B = cb.id;
    const faire = (nom: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, role: role as never, passwordHash: "x" } });
    const [kamA, kamB, sup, ns, sa, ancien] = await Promise.all([
      faire("kamA", "MEDICAL_DELEGATE"), faire("kamB", "MEDICAL_DELEGATE"), faire("sup", "MEDICAL_PROMOTION_MANAGER"),
      faire("ns", "NATIONAL_SALES"), faire("sa", "SUPER_ADMIN"), faire("ancien", "VIEWER"),
    ]);
    Object.assign(ids, { kamA: kamA.id, kamB: kamB.id, sup: sup.id, ns: ns.id, sa: sa.id, ancien: ancien.id });
    // L'appartenance : le manager relève de la société A — la portée d'entité qui le borne.
    await prisma.employee.create({ data: { fullName: `${TAG}sup`, companyId: A, userId: sup.id } });
  });

  afterAll(async () => { await nettoyer(); });

  it("PRÉMISSES : le manager gère les rapports sans la vue globale et sans la société B ; le national les voit sans les gérer ; le délégué ne gère rien", async () => {
    await comme("sup");
    expect(managesReports(ACTOR!)).toBe(true);
    expect(hasGlobalView(ACTOR!)).toBe(false);
    expect(await entitePermisePourFiche(ids.sup!, A)).toBe(true);
    expect(await entitePermisePourFiche(ids.sup!, B), "sans cette prémisse, le cas « autre société » ne mesurerait rien").toBe(false);
    expect(await entitePermisePourFiche(ids.sup!, null)).toBe(true);
    await comme("ns");
    expect(viewsAllReports(ACTOR!)).toBe(true);
    expect(managesReports(ACTOR!)).toBe(false);
    await comme("kamB");
    expect(managesReports(ACTOR!)).toBe(false);
    expect(viewsAllReports(ACTOR!)).toBe(false);
  });

  it("1. l'auteur supprime son brouillon : la ligne et ses pièces partent en UN lot, les fichiers RESTENT, un audit est écrit", async () => {
    const r = await rapport({ delegate: "kamA", company: A, nom: "un", pieces: 2, audio: true });
    const pieces = await prisma.fieldReportAttachment.findMany({ where: { reportId: r.id }, select: { blobId: true } });
    expect(pieces).toHaveLength(2);
    await comme("kamA");
    const res = await deleteFieldReport(form({ id: r.id }));
    // La liste vit sous Promotion médicale › Rapports (Direction, 07/10) — `/field-reports` y redirige.
    expect(res).toMatchObject({ ok: true, redirect: "/medical/rapports" });
    expect(await existe(r.id)).toBe(false);
    expect(await prisma.fieldReportAttachment.count({ where: { reportId: r.id } })).toBe(0);
    // LES FICHIERS NE SONT PAS LIBÉRÉS : la restauration doit les retrouver.
    for (const b of [r.audioBlobId!, ...pieces.map((p) => p.blobId)]) {
      expect(await refCount(b), "le blob reste tenu tant que l'entrée de corbeille existe").toBe(1);
    }
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "FIELD_REPORT", sourceId: r.id } });
    expect(rec.lot, "c'est un LOT : les pièces voyagent avec lui").not.toBeNull();
    expect(rec.deletedById).toBe(ids.kamA);
    expect(await prisma.auditLog.count({ where: { actorId: ids.kamA, action: "DELETE", entityId: r.id } })).toBe(1);
  });

  it("2. le Super Admin restaure : le rapport revient INTACT, avec ses pièces jointes et son audio", async () => {
    const r = await rapport({ delegate: "kamA", company: A, nom: "deux", status: "VALIDATED", pieces: 2, audio: true });
    const avant = await prisma.fieldReport.findUniqueOrThrow({ where: { id: r.id } });
    const piecesAvant = await prisma.fieldReportAttachment.findMany({ where: { reportId: r.id }, orderBy: { id: "asc" } });
    await comme("kamA");
    expect((await deleteFieldReport(form({ id: r.id }))).ok).toBe(true);
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "FIELD_REPORT", sourceId: r.id } });

    // Un délégué ne restaure pas : la corbeille est celle du Super Admin.
    const refus = await restoreDeletedRecord(form({ id: rec.id }));
    expect(refus.ok).toBe(false);
    expect(await existe(r.id)).toBe(false);

    await comme("sa");
    const res = await restoreDeletedRecord(form({ id: rec.id }));
    expect(res.ok, res.error).toBe(true);
    const apres = await prisma.fieldReport.findUniqueOrThrow({ where: { id: r.id } });
    expect(apres).toEqual(avant);
    const piecesApres = await prisma.fieldReportAttachment.findMany({ where: { reportId: r.id }, orderBy: { id: "asc" } });
    expect(piecesApres).toEqual(piecesAvant);
    expect(piecesApres).toHaveLength(2);
    expect(await refCount(r.audioBlobId!)).toBe(1);
    for (const p of piecesApres) expect(await refCount(p.blobId)).toBe(1);
    expect((await prisma.deletedRecord.findUniqueOrThrow({ where: { id: rec.id } })).restoredAt).not.toBeNull();
    // Restaurer deux fois ne recrée rien.
    expect((await restoreDeletedRecord(form({ id: rec.id }))).ok).toBe(false);
  });

  it("3. un collègue ne supprime pas le rapport d'un autre — ni par l'action, ni par l'aperçu de la fenêtre", async () => {
    const r = await rapport({ delegate: "kamA", company: A, nom: "trois", pieces: 1 });
    await comme("kamB");
    const res = await deleteFieldReport(form({ id: r.id }));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Non autorisé.");
    expect(await existe(r.id)).toBe(true);
    expect(await apercuDeSuppression(form({ kind: "FIELD_REPORT", id: r.id }))).toEqual({ erreur: "Réservé à qui peut supprimer cet élément." });
    // Le témoin : l'auteur, lui, lit l'aperçu — ce qui part, et rien qui l'interdise.
    await comme("kamA");
    const apercu = await apercuDeSuppression(form({ kind: "FIELD_REPORT", id: r.id }));
    expect("erreur" in apercu).toBe(false);
    if (!("erreur" in apercu)) {
      expect(apercu.lot).toBe(true);
      expect(apercu.refus).toBeNull();
      expect(apercu.emporte).toEqual(["1 pièce jointe"]);
      expect(apercu.nom).toContain(`${TAG}trois`);
    }
    // Lire l'aperçu n'écrit RIEN.
    expect(await existe(r.id)).toBe(true);
    expect(await prisma.deletedRecord.count({ where: { kind: "FIELD_REPORT", sourceId: r.id } })).toBe(0);
  });

  it("4. le manager supprime le rapport VALIDÉ d'un délégué de SON entité — et l'auteur en est prévenu", async () => {
    const r = await rapport({ delegate: "kamA", company: A, nom: "quatre", status: "VALIDATED", pieces: 1 });
    await comme("sup");
    expect((await deleteFieldReport(form({ id: r.id }))).ok).toBe(true);
    expect(await existe(r.id)).toBe(false);
    const n = await prisma.notification.findMany({ where: { userId: ids.kamA!, title: "Votre rapport terrain a été supprimé" } });
    expect(n).toHaveLength(1);
    expect(n[0]!.body).toContain(`${TAG}quatre`);
    expect(n[0]!.body).toContain("restaurer");
    // L'auteur qui supprime SON rapport ne se notifie pas lui-même.
    const avant = await prisma.notification.count({ where: { userId: ids.kamA!, title: "Votre rapport terrain a été supprimé" } });
    const r2 = await rapport({ delegate: "kamA", company: A, nom: "quatrebis" });
    await comme("kamA");
    expect((await deleteFieldReport(form({ id: r2.id }))).ok).toBe(true);
    expect(await prisma.notification.count({ where: { userId: ids.kamA!, title: "Votre rapport terrain a été supprimé" } })).toBe(avant);
  });

  it("5. le manager ne supprime PAS le rapport d'une autre société — mais celui d'une ligne sans entité, oui", async () => {
    const autre = await rapport({ delegate: "kamB", company: B, nom: "cinqB" });
    const libre = await rapport({ delegate: "kamB", company: null, nom: "cinqN" });
    await comme("sup");
    const res = await deleteFieldReport(form({ id: autre.id }));
    expect(res).toMatchObject({ ok: false, error: "Non autorisé." });
    expect(await existe(autre.id)).toBe(true);
    expect(await apercuDeSuppression(form({ kind: "FIELD_REPORT", id: autre.id }))).toEqual({ erreur: "Réservé à qui peut supprimer cet élément." });
    // Un rapport sans entité n'est le secret d'aucune société (la règle des fiches, §118.184).
    expect((await deleteFieldReport(form({ id: libre.id }))).ok).toBe(true);
    // Le Super Admin, lui, supprime celui de la société B.
    await comme("sa");
    expect((await deleteFieldReport(form({ id: autre.id }))).ok).toBe(true);
  });

  it("6. le superviseur national VOIT les rapports sans pouvoir en supprimer un — et la liste ne lui offre aucune corbeille", async () => {
    const r = await rapport({ delegate: "kamA", company: A, nom: "six" });
    await comme("ns");
    const res = await deleteFieldReport(form({ id: r.id }));
    expect(res).toMatchObject({ ok: false, error: "Non autorisé." });
    expect(await existe(r.id)).toBe(true);
    const liste = await getMyFieldReports(ACTOR as unknown as SessionUser);
    const sien = liste.find((x) => x.id === r.id);
    expect(sien, "PRÉMISSE : le national voit ce rapport dans sa liste").toBeDefined();
    expect(liste.filter((x) => x.canDelete)).toEqual([]);
  });

  it("7. la liste dit la même chose que l'action : l'auteur a la corbeille sur SES rapports, pas sur ceux d'un collègue", async () => {
    const mien = await rapport({ delegate: "kamA", company: A, nom: "septA" });
    const sien = await rapport({ delegate: "kamB", company: A, nom: "septB" });
    await comme("kamA");
    const liste = await getMyFieldReports(ACTOR as unknown as SessionUser);
    expect(liste.find((x) => x.id === mien.id)?.canDelete).toBe(true);
    expect(liste.find((x) => x.id === sien.id), "un délégué ne voit même pas le rapport d'un collègue").toBeUndefined();
    await comme("sup");
    const listeSup = await getMyFieldReports(ACTOR as unknown as SessionUser);
    expect(listeSup.find((x) => x.id === mien.id)?.canDelete).toBe(true);
    expect(listeSup.find((x) => x.id === sien.id)?.canDelete).toBe(true);
  });

  it("7 ter. la FICHE porte le même droit que l'action : l'auteur et le manager de l'entité l'ont, le national non", async () => {
    const r = await rapport({ delegate: "kamA", company: A, nom: "septter" });
    for (const [qui, attendu] of [["kamA", true], ["sup", true], ["ns", false]] as const) {
      await comme(qui);
      const d = await getFieldReportDetail(ACTOR as unknown as SessionUser, r.id);
      expect(d, `${qui} ouvre la fiche`).not.toBeNull();
      expect(d?.canDelete, qui).toBe(attendu);
    }
  });

  it("7 bis. l'auteur d'un rapport dont le rôle n'a PLUS le module Rapports terrain ne supprime plus — être l'auteur ne rend pas le droit", async () => {
    const r = await rapport({ delegate: "ancien", company: A, nom: "septbis" });
    await comme("ancien");
    expect(userCan(ACTOR as unknown as SessionUser, "FIELD_REPORTS", "VIEW"), "PRÉMISSE : ce rôle n a pas le module").toBe(false);
    expect(await deleteFieldReport(form({ id: r.id }))).toMatchObject({ ok: false, error: "Non autorisé." });
    expect(await existe(r.id)).toBe(true);
  });

  it("8. la destruction réelle depuis la corbeille libère les pièces ET l'audio — et seulement elle", async () => {
    const r = await rapport({ delegate: "kamA", company: A, nom: "huit", pieces: 2, audio: true });
    const pieces = await prisma.fieldReportAttachment.findMany({ where: { reportId: r.id }, select: { blobId: true } });
    await comme("kamA");
    expect((await deleteFieldReport(form({ id: r.id }))).ok).toBe(true);
    for (const b of [r.audioBlobId!, ...pieces.map((p) => p.blobId)]) expect(await refCount(b)).toBe(1);
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "FIELD_REPORT", sourceId: r.id } });
    await comme("kamA");
    expect((await destroyDeletedRecord(form({ id: rec.id }))).ok, "la destruction est celle du Super Admin").toBe(false);
    for (const b of [r.audioBlobId!, ...pieces.map((p) => p.blobId)]) expect(await refCount(b)).toBe(1);
    await comme("sa");
    expect((await destroyDeletedRecord(form({ id: rec.id }))).ok).toBe(true);
    for (const b of [r.audioBlobId!, ...pieces.map((p) => p.blobId)]) {
      expect(await prisma.fileBlob.count({ where: { id: b } }), "plus personne ne tient le fichier : il est libéré").toBe(0);
    }
  });

  describe("la visite que le compte rendu documente — rien ne change en silence", () => {
    it("9. le SEUL rapport d'une visite planifiée ne se supprime pas : elle repasserait de « fait » à « à faire »", async () => {
      const v = await visite({ delegate: "kamA" });
      const r = await rapport({ delegate: "kamA", company: A, nom: "neuf", visitId: v });
      await comme("kamA");
      const res = await deleteFieldReport(form({ id: r.id }));
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/seul rapport de la visite/);
      expect(res.error).toMatch(/Rapport fait/);
      expect(res.error).toMatch(/Ma journée/);
      expect(await existe(r.id)).toBe(true);
      // Le même refus s'affiche AVANT le clic, dans la fenêtre.
      const apercu = await apercuDeSuppression(form({ kind: "FIELD_REPORT", id: r.id }));
      expect("erreur" in apercu ? "" : apercu.refus).toMatch(/seul rapport de la visite/);
    });

    it("10. fenêtre de 48 h fermée : la visite deviendrait « non rapportée » — refus aussi", async () => {
      const v = await visite({ delegate: "kamA", joursAvant: 5 });
      const r = await rapport({ delegate: "kamA", company: A, nom: "dix", visitId: v });
      await comme("kamA");
      const res = await deleteFieldReport(form({ id: r.id }));
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Rapport non fait — délai dépassé/);
      expect(await existe(r.id)).toBe(true);
    });

    it("11. quand l'état de la visite ne bouge pas, le compte rendu part : visite rapportée, annulée, ou portant son propre rapport écrit", async () => {
      for (const [nom, v] of [
        ["onzeA", await visite({ delegate: "kamA", statut: "COMPLETED" })],
        ["onzeB", await visite({ delegate: "kamA", statut: "CANCELLED" })],
        ["onzeC", await visite({ delegate: "kamA", report: "Rapport écrit de la visite" })],
        ["onzeD", await visite({ delegate: "kamA", statut: "POSTPONED", joursAvant: 9 })],
      ] as const) {
        const r = await rapport({ delegate: "kamA", company: A, nom, visitId: v });
        const avant = await prisma.medicalVisit.findUniqueOrThrow({ where: { id: v }, select: { status: true, report: true, date: true } });
        await comme("kamA");
        const res = await deleteFieldReport(form({ id: r.id }));
        expect(res.ok, `${nom} : ${res.error}`).toBe(true);
        expect(await existe(r.id)).toBe(false);
        // La visite, elle, n'a pas bougé.
        expect(await prisma.medicalVisit.findUniqueOrThrow({ where: { id: v }, select: { status: true, report: true, date: true } })).toEqual(avant);
      }
    });

    it("12. deux comptes rendus pour la même visite : on peut en retirer un, pas le dernier", async () => {
      const v = await visite({ delegate: "kamA" });
      const r1 = await rapport({ delegate: "kamA", company: A, nom: "douzeA", visitId: v });
      const r2 = await rapport({ delegate: "kamA", company: A, nom: "douzeB", visitId: v });
      await comme("kamA");
      expect((await deleteFieldReport(form({ id: r1.id }))).ok).toBe(true);
      const dernier = await deleteFieldReport(form({ id: r2.id }));
      expect(dernier.ok).toBe(false);
      expect(dernier.error).toMatch(/seul rapport de la visite/);
      expect(await existe(r2.id)).toBe(true);
    });
  });

  describe("le matériel remis reste au registre du stock", () => {
    it("13. un compte rendu qui porte du matériel remis ne se supprime pas — ni par l'action, ni par l'aperçu, pas même pour le Super Admin", async () => {
      const cat = await prisma.promoCatalogueArticle.create({ data: { reference: `${TAG}C1`, nom: `${TAG}Fiche posologique`, famille: "CONSOMMABLE" as never }, select: { id: true } });
      const fiche = (await trouverOuCreerArticle({ companyId: null, catalogueId: cat.id, produitIds: [], nom: `${TAG}Fiche`, unite: "pièce", materialType: null, auteurId: ids.sa! })).id;
      const entree = await sousVerrou(fiche, (tx) => entrerLot(tx, fiche, { holderId: ids.kamA!, quantite: 10, kind: "OPENING", origine: "OUVERTURE", valableJusquau: new Date("2030-12-31"), auteurId: ids.sa! }));
      if ("refus" in entree) throw new Error(entree.refus);
      const medecin = await prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Remise`, delegateId: ids.kamA!, wilaya: "Alger" }, select: { id: true } });
      await comme("kamA");
      const cree = await createFieldReport();
      if (!cree.ok || !cree.id) throw new Error("brouillon non créé");
      const fd = new FormData();
      fd.set("id", cree.id); fd.set("summary", "Visite faite."); fd.set("visitDate", new Date().toISOString().slice(0, 10));
      fd.set("doctorIds", medecin.id); fd.append("materielItemId", fiche); fd.append("materielQuantite", "2");
      expect(await submitFieldReport(fd)).toEqual({ ok: true });
      expect(await prisma.promoStockMovement.count({ where: { fieldReportId: cree.id } }), "PRÉMISSE : le compte rendu porte une remise").toBe(1);

      const res = await deleteFieldReport(form({ id: cree.id }));
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/porte du matériel remis/);
      expect(await existe(cree.id)).toBe(true);
      const apercu = await apercuDeSuppression(form({ kind: "FIELD_REPORT", id: cree.id }));
      expect("erreur" in apercu ? "" : apercu.refus).toMatch(/porte du matériel remis/);
      // Le Super Admin non plus : la règle est celle du cœur, pas celle d'un rôle.
      await comme("sa");
      expect((await deleteFieldReport(form({ id: cree.id }))).ok).toBe(false);
    });
  });

  describe("Adam — la carte lit l'aperçu et ne supprime jamais sans clic", () => {
    const op = FIELD_REPORT_OPS_IMPL.delete_field_report!;

    it("14. la carte nomme ce qui part, dit que c'est réversible, et n'écrit RIEN", async () => {
      const r = await rapport({ delegate: "kamA", company: A, nom: "quatorze", pieces: 2 });
      await comme("kamA");
      const carte = await op.propose({ target: `${TAG}quatorze` }, ACTOR!);
      expect("error" in carte).toBe(false);
      if (!("error" in carte)) {
        expect(carte.fields.map((f) => `${f.label}: ${f.value}`).join(" | ")).toMatch(/Part aussi: 2 pièces jointes/);
        expect((carte.warnings ?? []).join(" ")).toMatch(/Réversible/);
        expect(carte.warnings!.join(" ")).not.toMatch(/DÉFINITIVE/);
        expect(carte.args).toEqual({ id: r.id });
      }
      // Proposer n'écrit rien : il faut un clic.
      expect(await existe(r.id)).toBe(true);
      expect(await prisma.deletedRecord.count({ where: { kind: "FIELD_REPORT", sourceId: r.id } })).toBe(0);
      expect(await prisma.fieldReportAttachment.count({ where: { reportId: r.id } })).toBe(2);
    });

    it("15. la carte ne nomme pas, et ne propose pas, le rapport d'un collègue", async () => {
      await rapport({ delegate: "kamA", company: A, nom: "quinze" });
      await comme("kamB");
      const carte = await op.propose({ target: `${TAG}quinze` }, ACTOR!);
      expect(carte).toEqual({ error: `Aucun rapport terrain « ${TAG}quinze ».` });
    });

    it("16. la carte refuse AVANT d'être montrée quand le registre refuse (visite) — pas un geste offert puis retiré", async () => {
      const v = await visite({ delegate: "kamA" });
      await rapport({ delegate: "kamA", company: A, nom: "seize", visitId: v });
      await comme("kamA");
      const carte = await op.propose({ target: `${TAG}seize` }, ACTOR!);
      expect("error" in carte ? carte.error : "").toMatch(/seul rapport de la visite/);
    });

    it("17. exécutée (le clic), la carte supprime par la corbeille — le rapport est restaurable", async () => {
      const r = await rapport({ delegate: "kamA", company: A, nom: "dixsept", pieces: 1 });
      await comme("kamA");
      const res = await op.execute({ id: r.id }, ACTOR!);
      expect(res.ok).toBe(true);
      expect(await existe(r.id)).toBe(false);
      expect(await prisma.deletedRecord.count({ where: { kind: "FIELD_REPORT", sourceId: r.id } })).toBe(1);
    });
  });
});

/**
 * LE POINT D'APPEL (§118.49) — un test qui vérifie le corps d'une règle sans vérifier son appelant
 * ne teste rien. Ces cliquets lisent le CODE (commentaires retirés, §118.79d) à l'endroit exact où
 * le mécanisme doit être branché : l'écran, l'action, l'aperçu, la restauration.
 */
describe("Rapport terrain — la suppression est branchée là où une personne la voit (§118.212)", () => {
  // LA LISTE est l'onglet « Rapports » de la Promotion médicale (Direction, 07/10) : une ligne ouvre la FEUILLE du rapport,
  // et c'est la feuille qui porte l'icône — armée par la règle de l'action, calculée par le chargeur.
  it("la feuille d'une ligne de la liste monte l'icône, armée par la règle de l'action — hors du lien de la fiche", () => {
    const src = code("src/app/(app)/medical/rapports/liste-rapports.tsx");
    expect(src).toMatch(/<SupprimerRapport[\s\S]{0,200}enabled=\{ligne\.suppression !== null\}/);
    // L'icône est la SŒUR du lien : un bouton dans un lien déclenche deux gestes pour un clic.
    const feuille = src.slice(src.indexOf("function FicheRapport"));
    expect(feuille.indexOf("</Link>"), "le lien existe").toBeGreaterThan(-1);
    expect(feuille.indexOf("</Link>"), "le lien est refermé AVANT l'icône").toBeLessThan(feuille.indexOf("<SupprimerRapport"));
    const chargeur = code("src/lib/queries/rapports-terrain-liste.ts");
    expect(chargeur).toMatch(/suppression: peutSupprimerLeRapport\(user, r, entitePermise\(r\.companyId\)\)/);
  });

  it("la fiche monte le même bouton, pour qui a le droit (plus pour le seul Super Admin)", () => {
    const src = code("src/app/(app)/medical/rapports/[id]/page.tsx");
    expect(src).toMatch(/<SupprimerRapport[\s\S]{0,300}enabled=\{detail\.canDelete\}/);
    expect(src).not.toContain("SuperAdminDeleteButton");
  });

  it("le bouton passe par la fenêtre commune (double confirmation) — jamais un window.confirm", () => {
    const src = code("src/app/(app)/medical/rapports/supprimer-rapport.tsx");
    expect(src).not.toContain("window.confirm(");
    expect(src).toMatch(/<ConfirmationSuppression[\s\S]{0,300}kind="FIELD_REPORT"[\s\S]{0,200}executer=\{deleteFieldReport\}/);
    const fenetre = code("src/components/shared/super-admin-delete.tsx");
    expect(fenetre, "la seconde confirmation est un bouton décisif (arme, puis confirme)").toMatch(/<BoutonDecisif[\s\S]{0,200}disabled=\{!armable\}/);
    // L'aperçu est injectable (le banc d'écran le remplace) ; son défaut EST l'action canonique.
    expect(fenetre).toMatch(/apercuer = apercuDeSuppression/);
    expect(fenetre).toContain("apercuer(fd)");
  });

  it("l'action passe par le cœur réversible : plus de `delete` sec, plus de fichiers libérés à la suppression", () => {
    const src = code("src/lib/actions/field-report-actions.ts");
    const i = src.indexOf("export async function deleteFieldReport(");
    const corps = src.slice(i, src.indexOf("export async function deleteFieldReportAttachment"));
    expect(corps).toContain('supprimerReversible("FIELD_REPORT"');
    expect(corps).not.toMatch(/prisma\.fieldReport\.delete\(/);
    expect(corps, "libérer un fichier à la suppression rend la restauration impossible").not.toContain("releaseBlob");
    expect(corps).toContain("peutSupprimerUnRapportTerrain(user, id)");
  });

  it("l'aperçu de la fenêtre lit la MÊME règle que l'action — sinon le bouton ne s'armerait pas devant un geste que l'action accepte", () => {
    const src = code("src/lib/actions/admin-delete-actions.ts");
    expect(src).toMatch(/kind === "FIELD_REPORT"\) return peutSupprimerUnRapportTerrain\(user, id\)/);
  });

  it("le type est un LOT au registre, et la destruction libère les pièces du lot", async () => {
    const { DELETE_REGISTRY } = await import("@/lib/admin-delete-registry");
    expect(DELETE_REGISTRY.FIELD_REPORT.lot).toBe(true);
    const src = code("src/lib/actions/admin-delete-actions.ts");
    expect(src).toMatch(/l\.modele === "FieldReportAttachment" && l\.donnees\.blobId\) await releaseBlob\(l\.donnees\.blobId\)/);
  });

  it("Adam : la carte résout sous la règle de suppression, lit l'aperçu avant de se montrer, et ne dit plus « définitive »", () => {
    const src = code("src/lib/assistant/ops/impl-wave6b.ts");
    const i = src.indexOf("delete_field_report: {");
    const corps = src.slice(i, src.indexOf("delete_field_report_attachment: {"));
    expect(corps).toContain("peutSupprimerUnRapportTerrain(user, id)");
    expect(corps).toContain('apercuSuppression("FIELD_REPORT", hit.id)');
    expect(corps).toMatch(/if \(apercu\.refus\) return \{ error: apercu\.refus \}/);
    expect(corps).not.toContain("DÉFINITIVE");
  });
});
