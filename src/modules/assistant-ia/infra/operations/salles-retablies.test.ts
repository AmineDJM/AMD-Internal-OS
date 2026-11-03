import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * LES SALLES, RÉTABLIES PAR LEUR INTERRUPTEUR (lot T3, décision 0051, « Correction du 03/11 ») — la réservation de salles est
 * MISE DE CÔTÉ (Direction : « il n'y a pas de réservation de la salle »). Ce banc prouve que `SALLES_EN_SERVICE=1` la rétablit
 * intacte : déclaration, réservation, créneau pris, salle choisie, annulation — contre la base locale.
 */
vi.hoisted(() => { process.env.SALLES_EN_SERVICE = "1"; });
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import { annulerGeste } from "@/lib/effets/annulation";
import { DECLARER_SALLE, RESERVER_SALLE } from "./salles";
import { executerOperationJournalisee, OPERATIONS_IA } from "./";
import { lecturesDossiersEtMoyens } from "../lectures-dossiers-mg";
import { creerMoyenGeneral } from "@/modules/salles/actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zt3s${Date.now().toString(36)}`;
let ASSISTANTE: CurrentUser, SANS_DROIT: CurrentUser;
const lecture = (u: CurrentUser, nom: string) => lecturesDossiersEtMoyens(u).find((o) => o.def.name === nom)!;

async function compte(nom: string, role: CurrentUser["role"], modules: string[] = []): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG} ${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  for (const module of modules) await prisma.userAccess.create({ data: { userId: u.id, module, canView: true, canCreate: true, canUpdate: true, scope: "ALL" as never } });
  return { id: u.id, name: u.name, email: u.email, role: u.role, access: await getAccess(u.id, u.role), mustChangePassword: false } as CurrentUser;
}

async function confirmer(u: CurrentUser, op: string, args: Record<string, string | null>) {
  ACTOR = u;
  const r = await executerOperationJournalisee(u, { kind: "assistant_ia_op", op, args }, { origine: "carte" });
  const geste = await prisma.assistantGesteJournal.findFirst({ where: { principalId: u.id }, orderBy: { creeLe: "desc" }, select: { id: true } });
  return { r, gesteId: geste?.id ?? "" };
}

suite("T3 — les salles, rétablies par SALLES_EN_SERVICE=1", () => {
  beforeAll(async () => {
    ASSISTANTE = await compte("assistante", "DIRECTION_ASSISTANT", ["GENERAL_MEANS"]);
    SANS_DROIT = await compte("salarie", "SALES_USER");
  });

  afterAll(async () => {
    ACTOR = null;
    delete process.env.SALLES_EN_SERVICE;
    const ids = [ASSISTANTE, SANS_DROIT].filter(Boolean).map((u) => u.id);
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: ids } } }).catch(() => undefined);
    await prisma.moyenGeneral.deleteMany({ where: { libelle: { contains: TAG } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { id: { in: ids } } }).catch(() => undefined);
  });

  it("l'interrupteur remet les opérations au registre", () => {
    expect(OPERATIONS_IA.some((o) => o.nom === "reserver_salle")).toBe(true);
  });

  it("salles : déclarées par l'assistante ; réservées par TOUT employé ; prise → salles libres proposées ; annulation libère le créneau", async () => {
    expect(DECLARER_SALLE.ouverte(SANS_DROIT)).toBe(false);
    for (const [nom, capacite] of [[`Salle du conseil ${TAG}`, 14], [`Salle Atlas ${TAG}`, 8], [`Salle Tassili ${TAG}`, 20]] as const) {
      const p = await DECLARER_SALLE.proposer({ nom, capacite }, ASSISTANTE);
      if (!("carte" in p)) throw new Error(JSON.stringify(p));
      expect((await confirmer(ASSISTANTE, DECLARER_SALLE.nom, p.args)).r.ok).toBe(true);
    }
    // Un salarié SANS le module réserve (Direction, 02/11/2026).
    expect(RESERVER_SALLE.ouverte(SANS_DROIT)).toBe(true);
    const p = await RESERVER_SALLE.proposer({ salle: `conseil ${TAG}`, debut: "2027-03-12T10:00", fin: "12:00", objet: "Rendez-vous client", participants: 12 }, SANS_DROIT);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    expect(JSON.stringify(p.carte.fields)).toMatch(/12\/03\/2027 10:00 → 12\/03\/2027 12:00/);
    const c = await confirmer(SANS_DROIT, RESERVER_SALLE.nom, p.args);
    expect(c.r.ok, c.r.error).toBe(true);
    const deux = await RESERVER_SALLE.proposer({ salle: `Salle du conseil ${TAG}`, debut: "2027-03-12T11:00", fin: "13:00", objet: "Point RH", participants: 10 }, ASSISTANTE);
    expect("erreur" in deux && deux.erreur).toMatch(/déjà réservée[\s\S]*Libres sur ce créneau : [\s\S]*Tassili/);
    expect("erreur" in deux && deux.erreur).not.toMatch(/Atlas/);
    const auto = await RESERVER_SALLE.proposer({ debut: "2027-03-12T11:00", fin: "12:00", objet: "Point RH", participants: 6 }, ASSISTANTE);
    if (!("carte" in auto)) throw new Error(JSON.stringify(auto));
    expect(auto.carte.title).toContain("Atlas");
    const libres = JSON.parse(await lecture(SANS_DROIT, "lire_salles").run({ debut: "2027-03-12T10:30", fin: "11:30" }, SANS_DROIT)) as { salles_libres: string[] };
    expect(libres.salles_libres.some((x) => x.includes("Atlas"))).toBe(true);
    expect(libres.salles_libres.some((x) => x.includes(`conseil ${TAG}`))).toBe(false);
    expect("refus" in (await annulerGeste(c.gesteId, SANS_DROIT))).toBe(false);
    expect(await prisma.moyenGeneralReservation.count({ where: { moyen: { libelle: `Salle du conseil ${TAG}` }, statut: "CONFIRMEE" } })).toBe(0);
    // Le premier registre est retiré : on ne déclare plus un véhicule.
    ACTOR = ASSISTANTE;
    const fd = new FormData(); fd.set("type", "VEHICULE"); fd.set("libelle", `Kangoo ${TAG}`);
    expect((await creerMoyenGeneral(undefined, fd)).ok).toBe(false);
  });

});
