import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, requireModule: async () => ACTOR }));

// LA VRAIE PASSERELLE NE DOIT JAMAIS ÊTRE APPELÉE par l'enregistrement d'un rapport : si elle l'était, elle lèverait.
const appelsPasserelle = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/models/gateway", () => ({
  askModelJson: async () => { appelsPasserelle.n += 1; throw new Error("fournisseur en panne"); },
}));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { ajouterVisiteImprevue, rapporterVisite } from "./tour-visit-actions";
import { signalerCasPv } from "./pharmacovigilance-actions";
import { relireRapportVisite } from "./relecture-visite-actions";
import { analyserComptesRendusEnAttente, type DependancesPvVisite } from "@/lib/visite-pv-ia";
import { chargerEquipeTerrain } from "@/lib/queries/equipe-terrain";
import type { LigneDelegue } from "@/lib/queries/force-de-vente";
import type { ModelReply } from "@/lib/models/contract";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__vm2pv__";

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

const CR_PV = "Le Dr présente le produit en staff. Une patiente a fait une éruption cutanée après la deuxième prise. Il redemande la fiche posologique.";

/** L'IA SIMULÉE — les portes ouvertes, une réponse donnée (ou une panne). */
function ia(reponse: unknown | Error, ouverte = true): DependancesPvVisite & { appels: number } {
  const d = {
    appels: 0,
    coupee: async () => false,
    fonctionActive: async () => ouverte,
    configure: () => true,
    cle: () => "OPENAI_API_KEY",
    appeler: async <T,>() => {
      d.appels += 1;
      if (reponse instanceof Error) throw reponse;
      return { data: reponse as T, reply: { ok: true, configured: true, blocks: [], usage: { provider: "openai", model: "simule", inputTokens: 10, outputTokens: 5 } } as unknown as ModelReply };
    },
    journaliser: async () => {},
  };
  return d;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * VISITE MÉDICALE — la pharmacovigilance rattachée à la visite, la lecture du compte rendu par l'IA (simulée), la file du
 * superviseur et la RELECTURE, par les vraies actions et la vraie base.
 *
 *   kam    délégué de la BU                 sup    superviseur de la BU (relit)
 *   autre  délégué d'ailleurs (ni son superviseur ni son N+1 : refusé partout)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Visite médicale — PV liée à la visite, détection IA hors du chemin critique, relecture du superviseur", () => {
  const ids: Record<string, string> = {};
  let doc = "", v1 = "", v2 = "", v3 = "";
  const comme = async (qui: string) => { ACTOR = await actorFor(ids[qui]!); };

  async function nettoyer() {
    const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    const uids = users.map((u) => u.id);
    if (uids.length) {
      const cas = await prisma.pharmacovigilanceCase.findMany({ where: { reporterId: { in: uids } }, select: { id: true, reference: true } });
      await prisma.pharmacovigilanceCase.deleteMany({ where: { id: { in: cas.map((c) => c.id) } } });
      for (const c of cas) await prisma.notification.deleteMany({ where: { title: { contains: c.reference } } });
      const visites = await prisma.medicalVisit.findMany({ where: { delegateId: { in: uids } }, select: { id: true } });
      await prisma.fieldReport.deleteMany({ where: { visitId: { in: visites.map((v) => v.id) } } });
      await prisma.medicalVisit.deleteMany({ where: { id: { in: visites.map((v) => v.id) } } });
      await prisma.salesRepProfile.deleteMany({ where: { repId: { in: uids } } });
      await prisma.notification.deleteMany({ where: { userId: { in: uids } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: uids } } }).catch(() => undefined);
    }
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } });
    await retirerComptesEtSemis({ where: { id: { in: uids } } });
  }

  beforeAll(async () => {
    await nettoyer();
    const faire = (nom: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, role: role as never, passwordHash: "x" } });
    const [kam, sup, autre] = await Promise.all([faire("kam", "MEDICAL_DELEGATE"), faire("sup", "NATIONAL_SALES"), faire("autre", "MEDICAL_DELEGATE")]);
    Object.assign(ids, { kam: kam.id, sup: sup.id, autre: autre.id });
    const bu = await prisma.businessUnit.create({ data: { name: `${TAG}Oncologie`, supervisorId: sup.id }, select: { id: true } });
    ids.bu = bu.id;
    await prisma.salesRepProfile.create({ data: { repId: kam.id, businessUnitId: bu.id } });
    doc = (await prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Achour`, delegateId: kam.id, wilaya: "Alger" }, select: { id: true } })).id;
  });
  afterAll(async () => { await nettoyer(); });

  it("la migration imposée est appliquée sur la base (colonnes de la visite, du cas, de la bascule)", async () => {
    const cols = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'MedicalVisit' AND column_name IN ('pvIa','pvIaRaison','pvIaExtrait','prioriteIa','analyseIaLe','reluLe','reluParId','reluCommentaire'))
         OR (table_name = 'PharmacovigilanceCase' AND column_name = 'visitId')
         OR (table_name = 'AiSetting' AND column_name = 'visitePvDetectionEnabled')`;
    expect(cols.length).toBe(10);
  });

  it("le rapport s'enregistre sans que l'IA soit sur son chemin (passerelle en panne, jamais appelée)", async () => {
    await comme("kam");
    const r = await ajouterVisiteImprevue(form({ doctorId: doc, report: CR_PV }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    v1 = r.ok ? r.id! : "";
    const r2 = await ajouterVisiteImprevue(form({ doctorId: doc, report: "Visite de courtoisie, rien de particulier." }));
    expect(r2.ok).toBe(true);
    v2 = r2.ok ? r2.id! : "";
    expect(appelsPasserelle.n).toBe(0);
    expect(await prisma.medicalVisit.findUnique({ where: { id: v1 }, select: { analyseIaLe: true, pvIa: true } })).toEqual({ analyseIaLe: null, pvIa: null });
  });

  it("bascule coupée : la tâche s'abstient et ne touche à rien", async () => {
    const d = ia({ pv: "PROBABLE", raison: "x", extrait: "", priorite: 90 }, false);
    const b = await analyserComptesRendusEnAttente({ deps: d, delegues: [ids.kam!] });
    expect(b).toMatchObject({ ignoree: expect.stringContaining("coupée") });
    expect(d.appels).toBe(0);
  });

  it("l'IA en panne n'empêche rien : la tâche ne lève pas, le rapport est daté pour un nouvel essai, personne n'est prévenu", async () => {
    const d = ia(new Error("délai dépassé"));
    const b = await analyserComptesRendusEnAttente({ deps: d, delegues: [ids.kam!] });
    expect(b).toMatchObject({ bilan: expect.stringContaining("2 échec(s)") });
    const v = await prisma.medicalVisit.findUnique({ where: { id: v1 }, select: { analyseIaLe: true, pvIa: true } });
    expect(v?.analyseIaLe).not.toBeNull();
    expect(v?.pvIa).toBeNull();
    expect(await prisma.notification.count({ where: { userId: { in: [ids.kam!, ids.sup!] } } })).toBe(0);
    // Pas de nouvel essai avant une heure.
    const encore = ia({ pv: "AUCUN", raison: "", extrait: "", priorite: 0 });
    await analyserComptesRendusEnAttente({ deps: encore, delegues: [ids.kam!] });
    expect(encore.appels).toBe(0);
  });

  it("détection simulée : PROBABLE → la visite porte la lecture ; le délégué (« Signaler », prérempli) et le superviseur sont prévenus", async () => {
    await prisma.medicalVisit.updateMany({ where: { id: { in: [v1, v2] } }, data: { analyseIaLe: null } });
    const reponses = new Map([[v1, { pv: "PROBABLE", raison: "Éruption cutanée chez une patiente.", extrait: "une patiente a fait une éruption cutanée après la deuxième prise", priorite: 92 }]]);
    const d = ia(null);
    d.appeler = async <T,>(_r: "worker", prompt: string) => {
      d.appels += 1;
      const data = prompt.includes(v1) ? reponses.get(v1) : { pv: "AUCUN", raison: "Visite de courtoisie.", extrait: "", priorite: 10 };
      return { data: data as T, reply: { ok: true, configured: true, blocks: [], usage: null } as unknown as ModelReply };
    };
    await analyserComptesRendusEnAttente({ deps: d, delegues: [ids.kam!] });
    expect(d.appels).toBe(2);
    expect(await prisma.medicalVisit.findUnique({ where: { id: v1 }, select: { pvIa: true, prioriteIa: true, pvIaExtrait: true } }))
      .toEqual({ pvIa: "PROBABLE", prioriteIa: 92, pvIaExtrait: "Une patiente a fait une éruption cutanée après la deuxième prise" });
    expect(await prisma.medicalVisit.findUnique({ where: { id: v2 }, select: { pvIa: true } })).toEqual({ pvIa: "AUCUN" });
    const auKam = await prisma.notification.findMany({ where: { userId: ids.kam }, select: { title: true, link: true } });
    expect(auKam).toEqual([{ title: "Votre compte rendu évoque peut-être un effet indésirable — Signaler", link: expect.stringContaining(`visite=${v1}`) }]);
    const auSup = await prisma.notification.findMany({ where: { userId: ids.sup }, select: { title: true, link: true } });
    expect(auSup).toEqual([{ title: expect.stringContaining("Rapport à relire en priorité"), link: `/planning?relire=${v1}` }]);
    // L'IA NE CRÉE JAMAIS UN CAS.
    expect(await prisma.pharmacovigilanceCase.count({ where: { visitId: v1 } })).toBe(0);
  });

  it("le signalement se rattache à SA visite (le superviseur entre dans l'échange) ; la visite d'un autre est refusée", async () => {
    const champs = { produitAutre: `${TAG}Nivolex`, etablissementAutre: `${TAG}CHU Mustapha`, occurredOn: new Date().toISOString().slice(0, 10), description: "Éruption cutanée après la deuxième prise." };
    await comme("autre");
    const refus = await signalerCasPv(form({ ...champs, visitId: v1 }));
    expect(refus.ok).toBe(false);
    expect(refus.ok ? "" : refus.error).toMatch(/pas la vôtre/);
    await comme("kam");
    const r = await signalerCasPv(form({ ...champs, visitId: v1 }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const cas = await prisma.pharmacovigilanceCase.findUniqueOrThrow({ where: { id: r.ok ? r.id! : "" }, select: { visitId: true, participants: { select: { userId: true } } } });
    expect(cas.visitId).toBe(v1);
    expect(cas.participants.map((p) => p.userId)).toEqual([ids.sup]);
  });

  it("la file du superviseur : les possibles cas de PV d'abord, puis la priorité de l'IA, puis les non lus", async () => {
    await comme("kam");
    const r3 = await ajouterVisiteImprevue(form({ doctorId: doc, report: "Objection forte sur le prix, il veut une comparaison." }));
    v3 = r3.ok ? r3.id! : "";
    await prisma.medicalVisit.update({ where: { id: v3 }, data: { pvIa: "AUCUN", prioriteIa: 70, analyseIaLe: new Date() } });
    const v4 = await prisma.medicalVisit.create({ data: { date: new Date(), doctorId: doc, delegateId: ids.kam, status: "COMPLETED", origin: "UNPLANNED", report: "Pas encore lu par l'IA." }, select: { id: true } });
    await comme("sup");
    const ligne = { repId: ids.kam!, nom: `${TAG}kam`, buId: ids.bu!, buNom: null, secteurNom: null, panelVide: false } as unknown as LigneDelegue;
    const e = await chargerEquipeTerrain({ user: ACTOR!, lignes: [ligne], aTraiter: { plansAValider: [], ciblesNonVues: { total: 0, decideurs: 0 }, secteursVacants: [], coachingsEnRetard: [] } });
    expect(e.aRelire.total).toBe(4);
    expect(e.aRelire.lignes.map((l) => l.visitId)).toEqual([v1, v3, v2, v4.id]);
    expect(e.aRelire.lignes[0]).toMatchObject({ pvIa: "PROBABLE", raison: "Éruption cutanée chez une patiente." });
    expect(e.casPv.total).toBe(1);
  });

  it("relecture : refusée à un autre ; le superviseur relit avec un mot, le délégué est prévenu, le rapport sort de la file", async () => {
    await comme("autre");
    const refus = await relireRapportVisite(form({ visitId: v1 }));
    expect(refus.ok).toBe(false);
    expect(refus.ok ? "" : refus.error).toMatch(/superviseur de la Business Unit/);
    await comme("kam");
    expect((await relireRapportVisite(form({ visitId: v1 }))).ok, "on ne se relit pas soi-même").toBe(false);

    await comme("sup");
    const ok = await relireRapportVisite(form({ visitId: v1, commentaire: "Bien vu : signalé dans la journée." }));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    expect(await prisma.medicalVisit.findUnique({ where: { id: v1 }, select: { reluParId: true, reluCommentaire: true } }))
      .toEqual({ reluParId: ids.sup, reluCommentaire: "Bien vu : signalé dans la journée." });
    expect(await prisma.notification.count({ where: { userId: ids.kam, title: { contains: "a relu votre rapport" } } })).toBe(1);
    const deux = await relireRapportVisite(form({ visitId: v1 }));
    expect(deux.ok ? "" : deux.error).toMatch(/déjà relu/);

    const ligne = { repId: ids.kam!, nom: `${TAG}kam`, buId: ids.bu!, panelVide: false } as unknown as LigneDelegue;
    const e = await chargerEquipeTerrain({ user: ACTOR!, lignes: [ligne], aTraiter: { plansAValider: [], ciblesNonVues: { total: 0, decideurs: 0 }, secteursVacants: [], coachingsEnRetard: [] } });
    expect(e.aRelire.total).toBe(3);
    expect(e.aRelire.lignes.map((l) => l.visitId)).not.toContain(v1);
  });

  it("un compte rendu RÉÉCRIT se relit : la lecture de l'IA et la relecture repartent de zéro", async () => {
    await comme("kam");
    const r = await rapporterVisite(form({ visitId: v1, report: `${CR_PV} Le médecin a arrêté le traitement.` }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(await prisma.medicalVisit.findUnique({ where: { id: v1 }, select: { pvIa: true, analyseIaLe: true, reluLe: true } }))
      .toEqual({ pvIa: null, analyseIaLe: null, reluLe: null });
    expect(appelsPasserelle.n).toBe(0);
  });
});
