import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, requireModule: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import {
  changerStatutCasPv, declarerCasPv, enregistrerAccuseCasPv, evaluerCasPv, ouvrirEnquetePv, modifierReglagesPv, signalerCasPv, viserCasPv,
} from "@/lib/actions/pharmacovigilance-actions";
import { alerterEcheancesPv } from "./alertes";
import { listerCasPv } from "./donnees";
import { ajouterJoursPv, etatEcheancePv, jourAlgerPv, DELAIS_PV_DEFAUT } from "./declaration";
import { lignesPharmacovigilance } from "@/lib/queries/action-center-pharmacovigilance";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__pvdecl__";
const form = (fields: Record<string, string | File>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const pdf = (name: string) => new File([new Uint8Array([37, 80, 68, 70, 45, 49, Math.floor(Math.random() * 200)])], name, { type: "application/pdf" });

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role);
  return { id, name: u.name, email: u.email, role: u.role, secondaryRole: u.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DÉCLARATION À L'AUTORITÉ (Super Admin, 24/11/2026) — par les vraies actions et la vraie base :
 *   kam   délégué qui signale            reg   Responsable réglementaire (évalue, déclare)
 *   dg    Directeur général (informé)     ph    pharmacien responsable désigné (vise)
 *   admin Super Admin (règle)             autre délégué sans lien avec le cas
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Pharmacovigilance — évaluation, échéance, alertes, déclaration, visa (flux réel)", () => {
  const ids: Record<string, string> = {};
  let casGrave = "", reglageAvant: { delaiGraveJours: number; delaiNonGraveJours: number; pharmaciensResponsables: unknown } | null = null;
  let societe = "", produit = "";
  const comme = async (qui: string) => { ACTOR = await actorFor(ids[qui]!); };
  const notifs = (qui: string, contient: string) => prisma.notification.count({ where: { userId: ids[qui], title: { contains: contient } } });
  const lire = (id: string) => prisma.pharmacovigilanceCase.findUniqueOrThrow({ where: { id } });

  async function nettoyer() {
    const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    const uids = users.map((u) => u.id);
    const cas = await prisma.pharmacovigilanceCase.findMany({ where: { OR: [{ reporterId: { in: uids } }, { reference: { startsWith: TAG } }] }, select: { id: true } });
    const cids = cas.map((c) => c.id);
    const docs = await prisma.document.findMany({ where: { entityType: "PHARMACOVIGILANCE_CASE", entityId: { in: cids } }, select: { id: true } });
    await retirerDocumentsEtContenu({ where: { id: { in: docs.map((d) => d.id) } } }).catch(() => undefined);
    await prisma.comment.deleteMany({ where: { entityType: "PHARMACOVIGILANCE_CASE", entityId: { in: cids } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: cids } }, { actorId: { in: uids } }] } }).catch(() => undefined);
    await prisma.pharmacovigilanceCase.deleteMany({ where: { id: { in: cids } } });
    await prisma.medicalVisit.deleteMany({ where: { delegateId: { in: uids } } });
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.product.deleteMany({ where: { code: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { userId: { in: uids } } });
    await retirerComptesEtSemis({ where: { id: { in: uids } } });
  }

  beforeAll(async () => {
    await nettoyer();
    reglageAvant = await prisma.pvReglage.findUnique({ where: { id: "global" }, select: { delaiGraveJours: true, delaiNonGraveJours: true, pharmaciensResponsables: true } });
    await prisma.pvReglage.deleteMany({ where: { id: "global" } });
    const faire = (nom: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, role: role as never, passwordHash: "x" } });
    for (const [nom, role] of [["kam", "MEDICAL_DELEGATE"], ["reg", "HEAD_OF_REGULATORY"], ["dg", "GENERAL_MANAGER"], ["ph", "MEDICAL_INFO_PHARMACIST"], ["admin", "SUPER_ADMIN"], ["autre", "MEDICAL_DELEGATE"]] as const) {
      ids[nom] = (await faire(nom, role)).id;
    }
    societe = (await prisma.company.create({ data: { name: `${TAG}Adventum` }, select: { id: true } })).id;
    produit = (await prisma.product.create({
      data: { code: `${TAG}NIV`, canonicalName: `${TAG}Nivolex`, dci: "nivolumab", identityKey: `${TAG}nivolex`, companyId: societe }, select: { id: true },
    })).id;
  });

  afterAll(async () => {
    await nettoyer();
    await prisma.pvReglage.deleteMany({ where: { id: "global" } });
    if (reglageAvant) await prisma.pvReglage.create({ data: { id: "global", ...reglageAvant, pharmaciensResponsables: reglageAvant.pharmaciensResponsables ?? undefined } });
  });

  it("la migration imposée est appliquée (colonnes du cas, table des réglages, valeurs du statut)", async () => {
    const cols = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM information_schema.columns
       WHERE table_name = 'PharmacovigilanceCase' AND column_name IN ('dateConnaissance','citationIa','evalGrave','declareLe','declarationReference','accuseLe','visaPharmacienLe','alertePalier','dgInformeLe')`;
    expect(Number(cols[0]!.n)).toBe(9);
    const valeurs = await prisma.$queryRaw<{ v: string }[]>`SELECT unnest(enum_range(NULL::"PvCaseStatus"))::text AS v`;
    expect(valeurs.map((x) => x.v)).toEqual(expect.arrayContaining(["RECU", "EVALUE", "DECLARE", "SUIVI", "CLOS"]));
  });

  it("le KAM signale un cas GRAVE depuis sa visite : jour zéro = la visite, citation de l'IA figée, DG informé", async () => {
    const doc = await prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Achour`, delegateId: ids.kam }, select: { id: true } });
    const jourVisite = new Date(Date.now() - 2 * 86_400_000);
    const visite = await prisma.medicalVisit.create({
      data: { date: jourVisite, delegateId: ids.kam, doctorId: doc.id, status: "COMPLETED", report: `${TAG} éruption après la 2e prise`, pvIaExtrait: "éruption après la 2e prise" },
      select: { id: true },
    });
    await comme("kam");
    const r = await signalerCasPv(form({
      produitAutre: `${TAG}Nivolex`, etablissementAutre: `${TAG}CHU Mustapha`, occurredOn: jourAlgerPv(jourVisite),
      description: "Éruption cutanée généralisée, hospitalisation.", severity: "GRAVE", visitId: visite.id,
    }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    casGrave = r.ok ? r.id! : "";
    await prisma.pharmacovigilanceCase.update({ where: { id: casGrave }, data: { productId: produit } });
    const c = await lire(casGrave);
    expect(c.status).toBe("RECU");
    expect(c.citationIa).toBe("éruption après la 2e prise");
    expect(jourAlgerPv(c.dateConnaissance)).toBe(jourAlgerPv(jourVisite));
    expect(c.dgInformeLe).not.toBeNull();
    expect(await notifs("dg", "GRAVE")).toBe(1);
  });

  it("droits : le KAM n'évalue pas, ne déclare pas ; un autre délégué ne lit même pas le cas", async () => {
    await comme("kam");
    expect(await evaluerCasPv(form({ caseId: casGrave, grave: "oui", attendu: "non", imputabilite: "PROBABLE" }))).toMatchObject({ ok: false, error: expect.stringMatching(/Regulatory/) });
    await comme("autre");
    expect(await evaluerCasPv(form({ caseId: casGrave, grave: "oui", attendu: "non", imputabilite: "PROBABLE" }))).toMatchObject({ ok: false, error: "Cas introuvable." });
    await comme("reg");
    expect(await modifierReglagesPv(form({ delaiGraveJours: "15", delaiNonGraveJours: "90" }))).toMatchObject({ ok: false, error: expect.stringMatching(/Super Admin/) });
  });

  it("le Super Admin désigne le pharmacien responsable de la société et garde les délais par défaut", async () => {
    await comme("admin");
    const r = await modifierReglagesPv(form({ delaiGraveJours: "15", delaiNonGraveJours: "90", designation: `${societe}:${ids.ph}` }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(await modifierReglagesPv(form({ delaiGraveJours: "30", delaiNonGraveJours: "15" }))).toMatchObject({ ok: false });
  });

  it("déclarer avant d'évaluer est refusé ; l'évaluation GRAVE fixe l'échéance à J+15 de la connaissance", async () => {
    await comme("reg");
    expect(await declarerCasPv(form({ caseId: casGrave, declareLe: jourAlgerPv(new Date()), reference: "X", piece: pdf("decl.pdf") })))
      .toMatchObject({ ok: false, error: expect.stringMatching(/Évaluez/) });
    const r = await evaluerCasPv(form({ caseId: casGrave, grave: "oui", attendu: "non", imputabilite: "PROBABLE", note: `${TAG} évaluation` }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const c = await lire(casGrave);
    expect(c).toMatchObject({ status: "EVALUE", evalGrave: true, evalAttendu: false, evalImputabilite: "PROBABLE", evalueParId: ids.reg });
    const e = etatEcheancePv(c, DELAIS_PV_DEFAUT, new Date())!;
    expect(e.jour).toBe(ajouterJoursPv(jourAlgerPv(c.dateConnaissance), 15));
    expect(r.ok && r.message).toContain(e.jour.split("-").reverse().join("/"));
    // Le DG n'est pas informé deux fois du même cas grave.
    expect(await notifs("dg", "GRAVE")).toBe(1);
  });

  it("l'alerte part UNE fois par palier, au Responsable réglementaire et au déclarant", async () => {
    // L'échéance est J+15 de la connaissance (il y a 2 jours) : J-5 tombe à connaissance + 10.
    const c = await lire(casGrave);
    const jour0 = jourAlgerPv(c.dateConnaissance);
    const a = (j: number) => new Date(`${ajouterJoursPv(jour0, j)}T10:00:00+01:00`);
    await alerterEcheancesPv(a(9));
    expect(await notifs("reg", "déclaration à l'autorité")).toBe(0);
    await alerterEcheancesPv(a(10));
    await alerterEcheancesPv(a(10));
    await alerterEcheancesPv(a(11));
    expect(await notifs("reg", "sous 5 jours")).toBe(1);
    await alerterEcheancesPv(a(13));
    expect(await notifs("reg", "sous 48 h")).toBe(1);
    await alerterEcheancesPv(a(15));
    expect(await notifs("reg", "AUJOURD'HUI")).toBe(1);
    await alerterEcheancesPv(a(16));
    await alerterEcheancesPv(a(20));
    expect(await notifs("reg", "DÉPASSÉ")).toBe(1);
    expect((await lire(casGrave)).alertePalier).toBe("DEPASSE");
    // Le KAM qui a signalé n'est pas destinataire : il ne déclare pas.
    expect(await notifs("kam", "déclaration à l'autorité")).toBe(0);
    // « Aujourd'hui » du Responsable réglementaire : la ligne en rouge ; rien chez le KAM.
    const lignes = await lignesPharmacovigilance(await actorFor(ids.reg!), a(16));
    expect(lignes.find((l) => l.objet === `PHARMACOVIGILANCE_CASE:${casGrave}`)).toMatchObject({ statusLabel: "Délai dépassé", statusTone: "danger" });
    expect(await lignesPharmacovigilance(await actorFor(ids.kam!), a(16))).toEqual([]);
  });

  it("la déclaration enregistrée (date, référence, pièce) fait passer le cas « Déclaré » et éteint le délai", async () => {
    await comme("reg");
    expect(await declarerCasPv(form({ caseId: casGrave, declareLe: jourAlgerPv(new Date()), reference: "CNPM-118" })))
      .toMatchObject({ ok: false, error: expect.stringMatching(/pièce/) });
    const r = await declarerCasPv(form({ caseId: casGrave, declareLe: jourAlgerPv(new Date()), reference: "CNPM-118", piece: pdf(`${TAG}declaration.pdf`) }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const c = await lire(casGrave);
    expect(c).toMatchObject({ status: "DECLARE", declarationReference: "CNPM-118", declareParId: ids.reg, accuseLe: null });
    expect(await prisma.document.count({ where: { entityType: "PHARMACOVIGILANCE_CASE", entityId: casGrave, stepKey: "PV_DECLARATION" } })).toBe(1);
    expect(etatEcheancePv(c, DELAIS_PV_DEFAUT, new Date())).toBeNull();
    // Le pharmacien responsable entre dans l'échange et reçoit la demande de visa ; la ligne de déclaration sort d'« Aujourd'hui ».
    expect(await prisma.pharmacovigilanceParticipant.count({ where: { caseId: casGrave, userId: ids.ph } })).toBe(1);
    expect(await notifs("ph", "à viser")).toBe(1);
    expect((await lignesPharmacovigilance(await actorFor(ids.reg!))).some((l) => l.objet === `PHARMACOVIGILANCE_CASE:${casGrave}`)).toBe(false);
    expect((await lignesPharmacovigilance(await actorFor(ids.ph!))).some((l) => l.objet === `PHARMACOVIGILANCE_VISA:${casGrave}`)).toBe(true);
    // Une seconde déclaration est refusée.
    expect(await declarerCasPv(form({ caseId: casGrave, declareLe: jourAlgerPv(new Date()), reference: "Y", piece: pdf("y.pdf") }))).toMatchObject({ ok: false });
  });

  it("l'accusé arrive ensuite ; la clôture attend le visa du pharmacien ; seul le pharmacien désigné vise", async () => {
    await comme("reg");
    expect((await enregistrerAccuseCasPv(form({ caseId: casGrave, accuseLe: jourAlgerPv(new Date()), accuseReference: "AR-7" }))).ok).toBe(true);
    expect((await lire(casGrave)).accuseReference).toBe("AR-7");
    expect(await changerStatutCasPv(form({ caseId: casGrave, status: "CLOS", note: "Conclu." }))).toMatchObject({ ok: false, error: expect.stringMatching(/visa/) });
    expect(await viserCasPv(form({ caseId: casGrave }))).toMatchObject({ ok: false, error: expect.stringMatching(/désigné/) });
    await comme("ph");
    expect((await viserCasPv(form({ caseId: casGrave, note: "Vu." }))).ok).toBe(true);
    expect(await viserCasPv(form({ caseId: casGrave }))).toMatchObject({ ok: false });
    await comme("reg");
    // Une demande d'informations après la déclaration : suivi.
    expect((await ouvrirEnquetePv(form({ caseId: casGrave, requestedInfo: "Évolution à J30 ?" }))).ok).toBe(true);
    expect((await lire(casGrave)).status).toBe("SUIVI");
    expect((await changerStatutCasPv(form({ caseId: casGrave, status: "CLOS", note: "Évolution favorable, suivi transmis." }))).ok).toBe(true);
    // Rouvert, il revient en suivi (il a été déclaré).
    expect((await changerStatutCasPv(form({ caseId: casGrave, status: "ROUVRIR" }))).ok).toBe(true);
    expect((await lire(casGrave)).status).toBe("SUIVI");
  });

  it("un cas évalué grave ne se clôt pas sans déclaration ; avant l'évaluation, un doublon se clôt en le disant", async () => {
    await comme("kam");
    const r = await signalerCasPv(form({ produitAutre: `${TAG}Nivolex`, etablissementAutre: `${TAG}CHU`, occurredOn: jourAlgerPv(new Date()), description: "Doublon du cas précédent." }));
    expect(r.ok).toBe(true);
    const id = r.ok ? r.id! : "";
    await comme("reg");
    expect((await evaluerCasPv(form({ caseId: id, grave: "oui", attendu: "oui", imputabilite: "POSSIBLE" }))).ok).toBe(true);
    expect(await changerStatutCasPv(form({ caseId: id, status: "CLOS", note: "Doublon." }))).toMatchObject({ ok: false, error: expect.stringMatching(/grave se déclare/) });
    expect((await evaluerCasPv(form({ caseId: id, grave: "non", attendu: "oui", imputabilite: "NON_EVALUABLE", note: "Doublon de PV précédent." }))).ok).toBe(true);
    expect((await changerStatutCasPv(form({ caseId: id, status: "CLOS", note: "Doublon." }))).ok).toBe(true);
  });

  it("un cas existant (« En analyse », d'avant le circuit) migré reste lisible : « Reçu », la trace dans l'échange, la citation reprise", async () => {
    const doc = await prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Bey`, delegateId: ids.kam }, select: { id: true } });
    const visite = await prisma.medicalVisit.create({
      data: { date: new Date(Date.now() - 40 * 86_400_000), delegateId: ids.kam, doctorId: doc.id, status: "COMPLETED", report: "x", pvIaExtrait: "vertiges" },
      select: { id: true },
    });
    const ancien = await prisma.pharmacovigilanceCase.create({
      data: {
        reference: `${TAG}PV-OLD`, reporterId: ids.kam!, status: "EN_ANALYSE", productLabel: `${TAG}Ancien`, institutionName: `${TAG}CHU`, visitId: visite.id,
        occurredOn: new Date(Date.now() - 40 * 86_400_000), createdAt: new Date(Date.now() - 39 * 86_400_000), description: "Ancien cas en analyse.",
      },
      select: { id: true },
    });
    const clos = await prisma.pharmacovigilanceCase.create({
      data: {
        reference: `${TAG}PV-CLOS`, reporterId: ids.kam!, status: "CLOS", productLabel: `${TAG}Ancien`, institutionName: `${TAG}CHU`,
        occurredOn: new Date("2026-09-01"), description: "Ancien cas clos.", closedAt: new Date("2026-09-10"), closingNote: "Conclu.",
      },
      select: { id: true },
    });
    // LE CAS D'AVANT N'AVAIT PAS DE JOUR ZÉRO : on remet la colonne dans l'état d'avant la migration pour ces lignes, puis
    // on rejoue la migration (idempotente), ordre par ordre, commentaires retirés — elle le reprend de la visite.
    await prisma.$executeRawUnsafe(`ALTER TABLE "PharmacovigilanceCase" ALTER COLUMN "dateConnaissance" DROP NOT NULL`);
    await prisma.$executeRawUnsafe(`UPDATE "PharmacovigilanceCase" SET "dateConnaissance" = NULL WHERE "id" IN ('${ancien.id}', '${clos.id}')`);
    const sql = readFileSync(join(process.cwd(), "prisma/migrations/20270248600000_pv_declaration_autorite/migration.sql"), "utf8")
      .split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    for (const ordre of sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(ordre);

    const a = await lire(ancien.id);
    expect(a.status).toBe("RECU");
    expect(a.citationIa).toBe("vertiges");
    expect(jourAlgerPv(a.dateConnaissance)).toBe(jourAlgerPv(new Date(Date.now() - 40 * 86_400_000)));
    expect(await prisma.comment.count({ where: { entityType: "PHARMACOVIGILANCE_CASE", entityId: ancien.id, body: { contains: "« En analyse » devient « Reçu »" } } })).toBe(1);
    // Le cas d'avant attend sa déclaration, en retard : il entre dans le circuit, lisible dans la boîte de Regulatory.
    const reg = await actorFor(ids.reg!);
    const lignes = await listerCasPv(reg, { produit: `${TAG}Ancien` });
    expect(lignes.find((l) => l.id === ancien.id)).toMatchObject({ status: "RECU", echeance: { ton: "danger" } });
    // Le cas clos d'avant reste clos, sans délai.
    expect(lignes.find((l) => l.id === clos.id)).toMatchObject({ status: "CLOS", echeance: null });
    // Rejouer une seconde fois ne double rien.
    for (const ordre of sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(ordre);
    expect(await prisma.comment.count({ where: { entityType: "PHARMACOVIGILANCE_CASE", entityId: ancien.id } })).toBe(1);
  });
});
