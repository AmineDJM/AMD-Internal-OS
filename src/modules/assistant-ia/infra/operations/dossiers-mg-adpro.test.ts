import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT T3 — SUIVI DE DOSSIERS, MOYENS GÉNÉRAUX, FICHES AD & PRO : les opérations de l'assistant EXÉCUTÉES contre la base
 * locale (proposer → carte → confirmer sous le journal des effets), puis ANNULÉES d'un geste.
 *
 *   • un Excel de dossiers → plan (référence, intitulé approché, ambiguë, introuvable, lecture seule, erreur) → lot
 *     appliqué → annulé : chaque dossier revient comme avant ; un dossier hors de la portée n'est jamais NOMMÉ ;
 *   • le registre des moyens généraux : création, mise à jour sans doublon, réservation (créneau pris refusé avec les
 *     salles libres), annulation ; un salarié sans le module : outil non offert, action refusée ;
 *   • les fiches hôtellerie et voyage : contrôles (dates, nuits, doublon), création des fiches, annulation ; la demande
 *     d'un autre n'est ni trouvée ni nommée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { annulerGeste } from "@/lib/effets/annulation";
import { DOSSIERS_EXCEL } from "./dossiers-excel";
import { FICHES_VOYAGE } from "./adpro-fiches-voyage";
import { MOYEN_GENERAL_ENREGISTRER, MOYEN_GENERAL_RESERVER } from "./moyens-generaux";
import { executerOperationJournalisee } from "./";
import { lecturesDossiersEtMoyens } from "../lectures-dossiers-mg";
import { reserverMoyenGeneral } from "@/modules/moyens-generaux/actions";
import { updateDossierStatus } from "@/lib/actions/dossier-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zt3${Date.now().toString(36)}`;
const ANNEE = new Date().getFullYear();
let ASSISTANTE: CurrentUser, AUTRE: CurrentUser, SANS_DROIT: CurrentUser, KAM: CurrentUser;

async function compte(nom: string, role: CurrentUser["role"], modules: Record<string, { c?: boolean; u?: boolean; scope?: "ALL" | "ASSIGNED" }> = {}): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG} ${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  for (const [module, d] of Object.entries(modules)) {
    await prisma.userAccess.create({ data: { userId: u.id, module, canView: true, canCreate: !!d.c, canUpdate: !!d.u, scope: (d.scope ?? "ASSIGNED") as never } });
  }
  return { id: u.id, name: u.name, email: u.email, role: u.role, access: await getAccess(u.id, u.role), mustChangePassword: false } as CurrentUser;
}

async function deposerExcel(u: CurrentUser, nom: string, lignes: unknown[][]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Suivi");
  for (const l of lignes) ws.addRow(l);
  const octets = Buffer.from(await wb.xlsx.writeBuffer());
  const b = await putBlob(octets);
  const { id } = await enregistrerFichierDrive(u, { parentId: null }, { blobId: b.blobId, size: b.size, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name: nom, sha256: b.sha256 });
  return id;
}

/** Confirmer une carte comme l'écran : sous le journal des effets ; rend le geste inscrit. */
async function confirmer(u: CurrentUser, op: string, args: Record<string, string | null>) {
  ACTOR = u;
  const r = await executerOperationJournalisee(u, { kind: "assistant_ia_op", op, args }, { origine: "carte" });
  const geste = await prisma.assistantGesteJournal.findFirst({ where: { principalId: u.id }, orderBy: { creeLe: "desc" }, select: { id: true } });
  return { r, gesteId: geste?.id ?? "" };
}

suite("T3 — dossiers, moyens généraux et fiches Ad & Pro, exécutés puis annulés", () => {
  const dossiers: Record<string, string> = {};
  let congres = "";
  let congresAutrui = "";

  beforeAll(async () => {
    ASSISTANTE = await compte("assistante", "DIRECTION_ASSISTANT", { DOSSIERS: { c: true, u: true }, GENERAL_MEANS: { c: true, u: true }, DRIVE: { c: true } });
    AUTRE = await compte("autre", "SALES_USER", { DOSSIERS: { c: true, u: true } });
    SANS_DROIT = await compte("salarie", "SALES_USER", { DRIVE: { c: true } });
    KAM = await compte("delegue", "MEDICAL_DELEGATE", {});
    const mk = async (cle: string, title: string, o: { createdById: string; participantIds?: string[]; status?: "OPEN" | "IN_PROGRESS" | "ON_HOLD"; dueDate?: Date }) => {
      const d = await prisma.dossier.create({ data: { reference: `DOS-${ANNEE}-9${Math.floor(Math.random() * 9000 + 1000)}`, title: `${title} ${TAG}`, status: o.status ?? "OPEN", createdById: o.createdById, participantIds: o.participantIds ?? [], dueDate: o.dueDate ?? null } });
      dossiers[cle] = d.id;
      return d;
    };
    await mk("hotels", "Recherche prix hôtels Oran", { createdById: ASSISTANTE.id, status: "IN_PROGRESS", dueDate: new Date(Date.now() - 5 * 86_400_000) });
    await mk("iqvia", "Analyse IQVIA trimestre", { createdById: ASSISTANTE.id });
    await mk("billets", "Billets congrès SAHGE", { createdById: ASSISTANTE.id, status: "ON_HOLD" });
    await mk("lecture", "Veille concurrentielle", { createdById: AUTRE.id, participantIds: [ASSISTANTE.id] });
    await mk("cache", "Dossier confidentiel direction", { createdById: AUTRE.id });
    await mk("ambigu1", "Salon pharmaceutique Alger stand", { createdById: ASSISTANTE.id });
    await mk("ambigu2", "Salon pharmaceutique Alger badge", { createdById: ASSISTANTE.id });
    congres = (await prisma.congressNational.create({ data: { name: `${TAG} Congrès SAHGE Oran`, requestStatus: "APPROVED", requesterId: KAM.id }, select: { id: true } })).id;
    congresAutrui = (await prisma.congressNational.create({ data: { name: `${TAG} Congrès réservé`, requestStatus: "APPROVED", requesterId: AUTRE.id }, select: { id: true } })).id;
    await prisma.adProItem.create({ data: { congressNationalId: congres, kind: "TICKETING", label: `${TAG} Billetterie`, status: "PENDING" } });
  }, 60_000);

  afterAll(async () => {
    ACTOR = null;
    const ids = [ASSISTANTE, AUTRE, SANS_DROIT, KAM].filter(Boolean).map((u) => u.id);
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: ids } } }).catch(() => undefined);
    await prisma.moyenGeneral.deleteMany({ where: { libelle: { contains: TAG } } }).catch(() => undefined);
    const items = await prisma.adProItem.findMany({ where: { congressNationalId: { in: [congres, congresAutrui] } }, select: { id: true, reservationDossierId: true } });
    await prisma.adProItem.deleteMany({ where: { id: { in: items.map((i) => i.id) } } }).catch(() => undefined);
    await prisma.congressNational.deleteMany({ where: { id: { in: [congres, congresAutrui] } } }).catch(() => undefined);
    await prisma.dossier.deleteMany({ where: { OR: [{ title: { contains: TAG } }, { id: { in: items.map((i) => i.reservationDossierId).filter((x): x is string => !!x) } }] } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => undefined);
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  });

  it("Excel → aperçu exact : référence, intitulé approché, ambiguë, introuvable, lecture seule, erreur — le dossier caché n'est jamais nommé", async () => {
    const ref = async (cle: string) => (await prisma.dossier.findUniqueOrThrow({ where: { id: dossiers[cle]! } })).reference;
    await deposerExcel(ASSISTANTE, `Suivi ${TAG}.xlsx`, [
      ["Suivi des dossiers — novembre"],
      ["Référence", "Intitulé", "Statut", "Échéance"],
      [await ref("hotels"), "", "Terminé", ""],
      ["", `Analyse IQVIA du trimestre ${TAG}`, "en cours", "15/12/2026"],
      [await ref("billets"), "", "presque", ""],
      [await ref("lecture"), "", "Clôturé", ""],
      [await ref("cache"), "", "Clôturé", ""],
      ["", `Salon pharmaceutique Alger ${TAG}`, "en cours", ""],
      ["DOS-2019-001", "", "en cours", ""],
      ["", `Billets congrès SAHGE ${TAG}`, "en attente", ""],
    ]);
    const p = await DOSSIERS_EXCEL.proposer({}, ASSISTANTE);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    const texte = JSON.stringify(p.carte);
    expect(p.carte.title).toMatch(/2 dossiers/);
    expect(texte).toMatch(/En cours → Abouti/);
    expect(texte).toMatch(/Ouvert → En cours · échéance — → 15\/12\/2026 \(rapproché par l'intitulé\)/);
    expect(texte).toMatch(/ambiguë/i);
    expect(texte).toMatch(/DOS-2019-001/);
    expect(texte).toMatch(/réservé au créateur/);
    expect(texte).toMatch(/« presque » illisible/);
    expect(texte).toMatch(/déjà plus haut/);
    expect(texte).not.toContain("confidentiel");
    expect(p.carte.warnings.join(" ")).toMatch(/pris par défaut/);
    expect(JSON.parse(p.args.changements!)).toHaveLength(2);

    const avant = await prisma.dossier.findMany({ where: { id: { in: [dossiers.hotels!, dossiers.iqvia!] } }, select: { id: true, status: true, dueDate: true } });
    const { r, gesteId } = await confirmer(ASSISTANTE, DOSSIERS_EXCEL.nom, p.args);
    expect(r.ok, r.error).toBe(true);
    expect((await prisma.dossier.findUniqueOrThrow({ where: { id: dossiers.hotels! } })).status).toBe("DONE");
    const iq = await prisma.dossier.findUniqueOrThrow({ where: { id: dossiers.iqvia! } });
    expect(iq.status).toBe("IN_PROGRESS");
    expect(iq.dueDate?.toISOString().slice(0, 10)).toBe("2026-12-15");
    expect((await prisma.dossier.findUniqueOrThrow({ where: { id: dossiers.lecture! } })).status).toBe("OPEN");
    expect((await prisma.dossier.findUniqueOrThrow({ where: { id: dossiers.cache! } })).status).toBe("OPEN");

    // ANNULER LE LOT : chaque dossier revient comme avant, d'un geste.
    const a = await annulerGeste(gesteId, ASSISTANTE);
    expect("refus" in a ? a.refus : "ok").toBe("ok");
    const apres = await prisma.dossier.findMany({ where: { id: { in: [dossiers.hotels!, dossiers.iqvia!] } }, select: { id: true, status: true, dueDate: true } });
    expect(apres.sort((x, y) => x.id.localeCompare(y.id))).toEqual(avant.sort((x, y) => x.id.localeCompare(y.id)));
  });

  it("une ligne qui a bougé depuis l'aperçu est écartée, jamais écrasée ; un lot forgé hors portée est refusé en entier", async () => {
    const p = await DOSSIERS_EXCEL.proposer({ fichier: `Suivi ${TAG}.xlsx` }, ASSISTANTE);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    await prisma.dossier.update({ where: { id: dossiers.hotels! }, data: { status: "ON_HOLD" } });
    const { r } = await confirmer(ASSISTANTE, DOSSIERS_EXCEL.nom, p.args);
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/écarté/);
    expect((await prisma.dossier.findUniqueOrThrow({ where: { id: dossiers.hotels! } })).status).toBe("ON_HOLD");
    // Un lot FORGÉ (un dossier d'un autre) : rien n'est écrit, et le refus ne nomme pas le dossier.
    const forge = JSON.stringify([{ id: dossiers.cache, avant: { status: "OPEN", dueDate: null, priority: "MEDIUM" }, status: "DONE" }]);
    const f = await confirmer(ASSISTANTE, DOSSIERS_EXCEL.nom, { changements: forge, fichier: "x.xlsx" });
    expect(f.r.ok).toBe(false);
    expect(f.r.error).not.toContain("confidentiel");
    expect((await prisma.dossier.findUniqueOrThrow({ where: { id: dossiers.cache! } })).status).toBe("OPEN");
    // L'action unitaire de l'écran non plus ne confirme pas l'existence d'un sujet hors portée.
    const fdc = new FormData(); fdc.set("id", dossiers.cache!); fdc.set("status", "DONE");
    ACTOR = ASSISTANTE;
    expect(await updateDossierStatus(fdc)).toEqual({ ok: false, error: "Sujet introuvable." });
  });

  it("lire le suivi : en retard, comptes par statut, refus propre sans le module", async () => {
    const [lire] = lecturesDossiersEtMoyens(ASSISTANTE);
    const out = JSON.parse(await lire!.run({ filtre: "en_retard" }, ASSISTANTE)) as { total: number; dossiers: { intitule: string; retard_jours?: number }[] };
    expect(out.dossiers.some((d) => d.intitule.includes("hôtels") && (d.retard_jours ?? 0) >= 5)).toBe(true);
    expect(JSON.stringify(out)).not.toContain("confidentiel");
    // Le suivi de dossiers est ouvert à tout salarié (DOSSIERS_USER) — ses propres sujets ; le registre des moyens généraux, non.
    expect(lecturesDossiersEtMoyens(SANS_DROIT)[1]!.allowed(SANS_DROIT)).toBe(false);
  });

  it("moyens généraux : créer, mettre à jour SANS doublon, alertes d'échéance, puis annuler", async () => {
    const p = await MOYEN_GENERAL_ENREGISTRER.proposer({ type: "véhicule", libelle: `Renault Kangoo ${TAG}`, identifiant: `12345-116-16${TAG}`, echeance: "20/11/2026", responsable: "moi" }, ASSISTANTE);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    expect(p.carte.title).toMatch(/Nouvelle fiche — Véhicule/);
    const c = await confirmer(ASSISTANTE, MOYEN_GENERAL_ENREGISTRER.nom, p.args);
    expect(c.r.ok, c.r.error).toBe(true);
    const v = await prisma.moyenGeneral.findFirstOrThrow({ where: { libelle: `Renault Kangoo ${TAG}` } });
    expect(v.reference).toMatch(/^MG-\d{4}-\d{3,}$/);
    // L'assurance du véhicule, rattachée par l'immatriculation.
    const pa = await MOYEN_GENERAL_ENREGISTRER.proposer({ type: "assurance", libelle: `Assurance Kangoo ${TAG}`, prestataire: "SAA", montant: 85_000, periodicite: "annuel", echeance: `${ANNEE}-01-10`, rattacheA: `12345-116-16${TAG}` }, ASSISTANTE);
    if (!("carte" in pa)) throw new Error(JSON.stringify(pa));
    expect(pa.carte.warnings.join(" ")).toMatch(/dépassée/);
    expect((await confirmer(ASSISTANTE, MOYEN_GENERAL_ENREGISTRER.nom, pa.args)).r.ok).toBe(true);
    // « Enregistre le Kangoo » une seconde fois avec une nouvelle échéance : MISE À JOUR, pas un doublon.
    const pm = await MOYEN_GENERAL_ENREGISTRER.proposer({ type: "véhicule", libelle: `Renault Kangoo ${TAG}`, identifiant: `12345-116-16${TAG}`, echeance: "2026-12-31" }, ASSISTANTE);
    if (!("carte" in pm)) throw new Error(JSON.stringify(pm));
    expect(pm.carte.title).toMatch(/Mise à jour de MG-/);
    expect(JSON.stringify(pm.carte.fields)).toMatch(/20\/11\/2026 → 31\/12\/2026/);
    const m = await confirmer(ASSISTANTE, MOYEN_GENERAL_ENREGISTRER.nom, pm.args);
    expect(m.r.ok, m.r.error).toBe(true);
    expect(await prisma.moyenGeneral.count({ where: { libelle: `Renault Kangoo ${TAG}` } })).toBe(1);
    expect((await prisma.moyenGeneral.findUniqueOrThrow({ where: { id: v.id } })).echeance?.toISOString().slice(0, 10)).toBe("2026-12-31");
    // Les alertes : l'assurance dépassée y est, avec son rattachement.
    const lire = lecturesDossiersEtMoyens(ASSISTANTE)[1]!;
    const al = JSON.parse(await lire.run({ vue: "alertes" }, ASSISTANTE)) as { fiches: { libelle: string; etat: string; rattache_a: string | null }[] };
    expect(al.fiches.find((f) => f.libelle === `Assurance Kangoo ${TAG}`)?.etat).toBe("Dépassée");
    // Annuler la mise à jour : l'échéance d'avant revient.
    expect("refus" in (await annulerGeste(m.gesteId, ASSISTANTE))).toBe(false);
    expect((await prisma.moyenGeneral.findUniqueOrThrow({ where: { id: v.id } })).echeance?.toISOString().slice(0, 10)).toBe("2026-11-20");
  });

  it("réserver une salle : libre → réservée ; prise → refus qui propose les salles libres ; annulation libère le créneau", async () => {
    for (const [libelle, capacite] of [[`Salle du conseil ${TAG}`, 14], [`Salle Atlas ${TAG}`, 8], [`Salle Tassili ${TAG}`, 20]] as const) {
      const p = await MOYEN_GENERAL_ENREGISTRER.proposer({ type: "salle", libelle, capacite }, ASSISTANTE);
      if (!("carte" in p)) throw new Error(JSON.stringify(p));
      expect((await confirmer(ASSISTANTE, MOYEN_GENERAL_ENREGISTRER.nom, p.args)).r.ok).toBe(true);
    }
    const p = await MOYEN_GENERAL_RESERVER.proposer({ moyen: `Salle du conseil ${TAG}`, debut: "2027-03-12T10:00", fin: "12:00", objet: "Comité de direction", participants: 12 }, ASSISTANTE);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    expect(JSON.stringify(p.carte.fields)).toMatch(/12\/03\/2027 10:00 → 12\/03\/2027 12:00/);
    const c = await confirmer(ASSISTANTE, MOYEN_GENERAL_RESERVER.nom, p.args);
    expect(c.r.ok, c.r.error).toBe(true);
    const deux = await MOYEN_GENERAL_RESERVER.proposer({ moyen: `Salle du conseil ${TAG}`, debut: "2027-03-12T11:00", fin: "13:00", objet: "Point RH", participants: 10 }, ASSISTANTE);
    expect("erreur" in deux && deux.erreur).toMatch(/déjà réservé[\s\S]*Libres sur ce créneau : [\s\S]*Tassili/);
    expect("erreur" in deux && deux.erreur).not.toMatch(/Atlas/);
    // Sans salle désignée : la plus petite salle libre assez grande.
    const auto = await MOYEN_GENERAL_RESERVER.proposer({ debut: "2027-03-12T11:00", fin: "12:00", objet: "Point RH", participants: 6 }, ASSISTANTE);
    if (!("carte" in auto)) throw new Error(JSON.stringify(auto));
    expect(auto.carte.title).toContain("Atlas");
    expect("refus" in (await annulerGeste(c.gesteId, ASSISTANTE))).toBe(false);
    expect(await prisma.moyenGeneralReservation.count({ where: { moyen: { libelle: `Salle du conseil ${TAG}` }, statut: "CONFIRMEE" } })).toBe(0);
  });

  it("un salarié sans le module : les gestes ne lui sont pas offerts et l'action refuse", async () => {
    expect(MOYEN_GENERAL_ENREGISTRER.ouverte(SANS_DROIT)).toBe(false);
    expect(MOYEN_GENERAL_RESERVER.ouverte(SANS_DROIT)).toBe(false);
    const salle = await prisma.moyenGeneral.findFirstOrThrow({ where: { libelle: `Salle Atlas ${TAG}` } });
    ACTOR = SANS_DROIT;
    const fd = new FormData();
    fd.set("moyenId", salle.id); fd.set("debut", "2027-04-01T09:00"); fd.set("objet", "test");
    const r = await reserverMoyenGeneral(undefined, fd);
    expect(r.ok).toBe(false);
    expect(await prisma.moyenGeneralReservation.count({ where: { moyenId: salle.id } })).toBe(0);
  });

  it("fiches hôtellerie et voyage : contrôles, nuits calculées, poste hôtellerie créé, puis annulation", async () => {
    const mauvaise = await FICHES_VOYAGE.proposer({ demande: `${TAG} Congrès SAHGE Oran`, hebergements: [{ nom: "Dr Karim BENALI", hotel: "Sheraton", ville: "Oran", arrivee: "2026-12-06", depart: "2026-12-04" }] }, KAM);
    expect("erreur" in mauvaise && mauvaise.erreur).toMatch(/BENALI/);
    const p = await FICHES_VOYAGE.proposer({
      demande: `${TAG} Congrès SAHGE Oran`,
      voyageurs: [{ nom: "Dr Karim BENALI", villeDepart: "Alger", villeArrivee: "Oran", depart: "04/12/2026", retour: "2026-12-06", transport: "avion" }, { nom: "Dr Lina Haddad", villeDepart: "Constantine", villeArrivee: "Oran", depart: "2026-12-04", retour: "2026-12-06", transport: "vol" }],
      hebergements: [{ nom: "Dr Karim BENALI", hotel: "Sheraton Oran", ville: "Oran", arrivee: "2026-12-04", depart: "2026-12-06", typeChambre: "Single" }, { nom: "Dr Lina Haddad", hotel: "Sheraton Oran", ville: "Alger", arrivee: "2026-12-04", depart: "2026-12-06" }],
      budgetHotellerie: 180_000,
    }, KAM);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    const t = JSON.stringify(p.carte);
    expect(t).toMatch(/Karim BENALI — Alger → Oran — 04\/12\/2026 → 06\/12\/2026 — avion/);
    expect(t).toMatch(/\(2 nuits\)/);
    expect(t).toMatch(/Nuits au total","value":"4"/);
    expect(t).toMatch(/À CRÉER « Hôtellerie » — budget 180/);
    expect(p.carte.warnings.join(" ")).toMatch(/Haddad : hôtel à Alger, voyage vers Oran/);
    const c = await confirmer(KAM, FICHES_VOYAGE.nom, p.args);
    expect(c.r.ok, c.r.error).toBe(true);
    const postes = await prisma.adProItem.findMany({ where: { congressNationalId: congres }, select: { id: true, kind: true, amountEstimated: true } });
    const hotel = postes.find((x) => x.kind === "ACCOMMODATION");
    expect(Number(hotel?.amountEstimated)).toBe(180_000);
    expect(await prisma.adProVoyageur.count({ where: { item: { congressNationalId: congres } } })).toBe(2);
    const h = await prisma.adProHebergement.findFirstOrThrow({ where: { itemId: hotel!.id, nom: "BENALI" } });
    expect(h.prenom).toBe("Karim");
    expect(h.hotel).toBe("Sheraton Oran");
    // Une seconde fois : les doublons ne sont pas recréés.
    const encore = await FICHES_VOYAGE.proposer({ demande: `${TAG} Congrès SAHGE Oran`, voyageurs: [{ nom: "Dr Karim BENALI", villeDepart: "Alger", villeArrivee: "Oran", depart: "2026-12-04", retour: "2026-12-06" }] }, KAM);
    expect("erreur" in encore && encore.erreur).toMatch(/existent déjà/);
    // Annuler : les quatre fiches et le poste créé disparaissent.
    expect("refus" in (await annulerGeste(c.gesteId, KAM))).toBe(false);
    expect(await prisma.adProVoyageur.count({ where: { item: { congressNationalId: congres } } })).toBe(0);
    expect(await prisma.adProItem.count({ where: { congressNationalId: congres, kind: "ACCOMMODATION" } })).toBe(0);
  });

  it("LIMITE : la demande Ad & Pro d'un autre n'est ni trouvée ni nommée", async () => {
    const p = await FICHES_VOYAGE.proposer({ demande: `${TAG} Congrès réservé`, voyageurs: [{ nom: "X" }] }, KAM);
    // Jamais la demande d'autrui : ni carte sur elle, ni son identifiant (le refus peut répéter les mots de la personne).
    expect("carte" in p && p.args.parentId === congresAutrui).toBe(false);
    expect(JSON.stringify(p)).not.toContain(congresAutrui);
  });
});
