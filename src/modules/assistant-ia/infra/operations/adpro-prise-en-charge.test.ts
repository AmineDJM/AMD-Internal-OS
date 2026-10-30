import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { PRISE_EN_CHARGE_CREATION, dateIso } from "./adpro-prise-en-charge";
import { lireMedecins } from "./annuaire-medical";
import { executerOperationIA } from "./";

/**
 * L'ASSISTANT IA PRÉPARE UNE PRISE EN CHARGE — les bénéficiaires sont des fiches de l'annuaire
 * QUE LA PERSONNE VOIT ; la création passe par `createCongressRequest`.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iapec_${Date.now().toString(36)}_`;
const EVENEMENT = `${TAG}Congrès de cardiologie d'Oran`;
let admin: CurrentUser;
let sansAnnuaire: CurrentUser;

async function compte(nom: string, role: CurrentUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: u.role, access, mustChangePassword: false } as CurrentUser;
}

const complet = () => ({
  perimetre: "national", nom: EVENEMENT, debut: "2026-12-10", fin: "12/12/2026", ville: "Oran",
  initiative: "moi", beneficiaires: `${TAG}Amel Haddad`, budgetEstime: 2_500_000,
});

suite("Assistant IA — prise en charge de bout en bout", () => {
  beforeAll(async () => {
    admin = await compte("admin", "SUPER_ADMIN");
    sansAnnuaire = await compte("viewer", "VIEWER");
    await prisma.medicalDoctor.createMany({ data: [
      { name: `${TAG}Amel Haddad`, specialty: "Cardiologie", wilaya: "Oran" },
      { name: `${TAG}Karim Saidi`, specialty: "Cardiologie" },
      { name: `${TAG}Karim Saidani`, specialty: "Pneumologie" },
    ] });
  });

  afterAll(async () => {
    const pec = await prisma.congressNational.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    const ids = pec.map((p) => p.id);
    const benef = await prisma.careBeneficiary.findMany({ where: { congressNationalId: { in: ids } }, select: { id: true } });
    await prisma.careCell.deleteMany({ where: { beneficiaryId: { in: benef.map((b) => b.id) } } }).catch(() => {});
    await prisma.careBeneficiary.deleteMany({ where: { congressNationalId: { in: ids } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: admin?.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("les dates s'écrivent comme on les dit", () => {
    expect(dateIso("12/12/2026")).toBe("2026-12-12");
    expect(dateIso("2026-1-5")).toBe("2026-01-05");
    expect(dateIso("bientôt")).toBeNull();
  });

  it("ce qui manque est nommé ; le périmètre d'abord", async () => {
    const p = await PRISE_EN_CHARGE_CREATION.proposer({}, admin);
    expect("manque" in p && p.manque[0]).toMatch(/national ou international/);
  });

  it("un nom qui désigne deux praticiens revient avec ses candidats — jamais tranché en silence", async () => {
    const p = await PRISE_EN_CHARGE_CREATION.proposer({ ...complet(), beneficiaires: `${TAG}Karim Said` }, admin);
    expect("manque" in p && p.manque[0]).toMatch(/Karim Saidi.*Karim Saidani|Karim Saidani.*Karim Saidi/);
  });

  it("l'annuaire est celui que la personne VOIT : sans le module médical, aucun praticien n'est trouvé", async () => {
    const lus = await lireMedecins(sansAnnuaire, [`${TAG}Amel Haddad`]);
    expect(lus.connus).toEqual([]);
    expect(lus.inconnus).toEqual([`${TAG}Amel Haddad`]);
  });

  it("complet : la carte nomme les bénéficiaires, le seuil du DG et les pièces exigées (passeport)", async () => {
    const p = await PRISE_EN_CHARGE_CREATION.proposer(complet(), admin);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    expect(p.carte.fields.find((f) => f.label === "Bénéficiaires proposés")?.value).toBe(`${TAG}Amel Haddad`);
    const w = p.carte.warnings.join(" ");
    expect(w).toMatch(/Directeur Général validera/);
    expect(w).toMatch(/passeport/);
  });

  it("confirmée : l'action de l'écran crée la demande et la fiche du bénéficiaire", async () => {
    const p = await PRISE_EN_CHARGE_CREATION.proposer(complet(), admin);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    ACTOR = admin;
    const r = await executerOperationIA(admin, { kind: "assistant_ia_op", op: PRISE_EN_CHARGE_CREATION.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
    const pec = await prisma.congressNational.findFirstOrThrow({ where: { name: EVENEMENT }, include: { careBeneficiaries: true } });
    expect(pec.careBeneficiaries).toHaveLength(1);
    expect(pec.endDate?.toISOString().slice(0, 10)).toBe("2026-12-12");
  });
});
