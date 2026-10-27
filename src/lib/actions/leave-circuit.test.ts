import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { getLeavesToDecide } from "@/lib/queries/hr";
import { requestLeave, decideLeave } from "./hr-actions";
import { decideHrLeave, deleteHrRequest } from "./hr-document-actions";
import { superAdminDelete, restoreDeletedRecord } from "./admin-delete-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__leavecircuit__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * LE CIRCUIT DE CONGÉ, DEPUIS LA VRAIE PORTE.
 *
 * On ne part PAS d'un état injecté à la main : on appelle `requestLeave`, l'action que « Mon
 * espace » et « Mon dossier RH » déclenchent réellement. C'est la seule façon de prouver que la
 * demande passe bien par les trois marches — un test qui créerait la ligne lui-même ne dirait
 * rien du chemin emprunté par l'écran.
 */
suite("Congés — N+1 → RH → DG depuis « Mon espace »", () => {
  let salarieUserId = "", salarieEmpId = "", managerUserId = "", managerEmpId = "";
  let rhUserId = "", dgUserId = "", adminUserId = "", leaveId = "";

  beforeAll(async () => {
    const mkUser = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });

    const [salarie, manager, rh, dg, admin] = await Promise.all([
      mkUser("salarie", "MEDICAL_DELEGATE"),
      mkUser("manager", "MEDICAL_PROMOTION_MANAGER"),
      // Le rôle qui porte RH:MANAGE (donc VALIDATE) dans la matrice — c'est lui, la marche RH.
      mkUser("rh", "DIRECTION"),
      mkUser("dg", "GENERAL_MANAGER"),
      mkUser("admin", "SUPER_ADMIN"),
    ]);
    salarieUserId = salarie.id; managerUserId = manager.id; rhUserId = rh.id; dgUserId = dg.id; adminUserId = admin.id;

    // Le RESPONSABLE d'abord : c'est lui que l'organigramme doit résoudre.
    const mgrEmp = await prisma.employee.create({
      data: { fullName: `${TAG} Manager`, userId: managerUserId, isActive: true, position: "Directeur médical" },
    });
    managerEmpId = mgrEmp.id;
    const emp = await prisma.employee.create({
      data: {
        fullName: `${TAG}BENALI Amine`, userId: salarieUserId, isActive: true,
        position: "Délégué médical", department: "Direction Médicale",
        hireDate: new Date("2021-03-15T00:00:00Z"), phone: "021 00 00 00",
        managerId: managerEmpId, leaveBalanceDays: 30,
      },
    });
    salarieEmpId = emp.id;
  });

  afterAll(async () => {
    await prisma.leaveRequest.deleteMany({ where: { employee: { fullName: { startsWith: TAG } } } }).catch(() => {});
    await prisma.hrDocumentRequest.deleteMany({ where: { employee: { fullName: { startsWith: TAG } } } }).catch(() => {});
    await prisma.deletedRecord.deleteMany({ where: { kind: { in: ["LEAVE_REQUEST", "HR_REQUEST"] }, name: { contains: TAG } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("la demande part de « Mon espace » et entre au N+1 — pas aux RH", async () => {
    ACTOR = await actorFor(salarieUserId, "MEDICAL_DELEGATE");
    const fd = new FormData();
    fd.set("type", "ANNUAL");
    fd.set("startDate", "2026-09-01");
    fd.set("endDate", "2026-09-10");
    fd.set("days", "10");
    fd.set("reason", "Congé annuel");
    // LA FICHE : téléphone où joindre, intérimaire choisi dès la demande.
    fd.set("phone", "0555 12 34 56");
    fd.set("standInId", managerUserId);
    const r = await requestLeave(undefined, fd);
    expect(r.ok).toBe(true);
    leaveId = r.id!;

    const l = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: leaveId } });
    expect(l.stage).toBe("MANAGER");
    expect(l.status).toBe("PENDING");
    expect(l.managerId).toBe(managerEmpId);
    expect(l.phone).toBe("0555 12 34 56");
    expect(l.standInId).toBe(managerUserId);
    expect(l.standInStatus).toBe("PENDING"); // l'intérim attend les RH, comme toujours
    // Le solde n'a PAS bougé : il ne se débite qu'au bout du circuit.
    expect(Number((await prisma.employee.findUniqueOrThrow({ where: { id: salarieEmpId } })).leaveBalanceDays)).toBe(30);
  });

  it("la file de décision est résolue PAR PERSONNE — et la fiche complète y figure", async () => {
    const pourManager = await getLeavesToDecide(await actorFor(managerUserId, "MEDICAL_PROMOTION_MANAGER"));
    const mine = pourManager.find((l) => l.id === leaveId);
    expect(mine).toBeDefined();

    const v = Object.fromEntries(mine!.sheet.map((s) => [s.label, s.value]));
    expect(v["Nom"]).toBe(`${TAG}BENALI`);
    expect(v["Prénom"]).toBe("Amine");
    expect(v["Fonction"]).toBe("Délégué médical");
    expect(v["Date de recrutement"]).toBe("15/03/2021");
    expect(v["Direction"]).toBe("Direction Médicale");
    expect(v["Nombre de jours demandés"]).toBe("10");
    expect(v["Date de départ"]).toBe("01/09/2026");
    expect(v["Date de reprise"]).toBe("11/09/2026"); // le lendemain du dernier jour
    expect(v["N° de téléphone"]).toBe("0555 12 34 56");
    expect(v["Intérim choisi"]).toMatch(/en attente de validation RH/);

    // Un collègue SANS rôle dans le circuit ne la voit pas — c'est la file « par personne ».
    const pourTiers = await getLeavesToDecide(await actorFor(salarieUserId, "MEDICAL_DELEGATE"));
    expect(pourTiers.find((l) => l.id === leaveId)).toBeUndefined();

    // La Direction, elle, la voit dès la première marche : `canDecideChain` lui donne
    // explicitement la main à TOUTE étape, pour qu'une demande ne reste pas bloquée quand le
    // responsable est absent — précisément la période où elles s'accumulent.
    const pourDirection = await getLeavesToDecide(await actorFor(rhUserId, "DIRECTION"));
    expect(pourDirection.find((l) => l.id === leaveId)).toBeDefined();
  });

  it("MARCHE 1 — le N+1 approuve : la demande monte aux RH, le solde reste intact", async () => {
    ACTOR = await actorFor(managerUserId, "MEDICAL_PROMOTION_MANAGER");
    const fd = new FormData(); fd.set("id", leaveId); fd.set("decision", "APPROVED"); fd.set("note", "Équipe couverte.");
    expect((await decideLeave(fd)).ok).toBe(true);

    const l = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: leaveId } });
    expect(l.stage).toBe("HR");
    expect(l.status).toBe("PENDING");
    expect(l.managerDecidedById).toBe(managerUserId);
    expect(l.managerNote).toBe("Équipe couverte.");
    expect(Number((await prisma.employee.findUniqueOrThrow({ where: { id: salarieEmpId } })).leaveBalanceDays)).toBe(30);
  });

  it("MARCHE 2 — les RH accordent : plus de marche DG (Direction, 06/10) ; c'est LÀ que le solde se débite", async () => {
    ACTOR = await actorFor(rhUserId, "DIRECTION");
    const fd = new FormData(); fd.set("id", leaveId); fd.set("decision", "APPROVED");
    expect((await decideLeave(fd)).ok).toBe(true);

    const l = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: leaveId } });
    expect(l.status).toBe("APPROVED");
    expect(l.stage).toBe("DONE");
    expect(l.hrDecidedById).toBe(rhUserId);
    expect(Number((await prisma.employee.findUniqueOrThrow({ where: { id: salarieEmpId } })).leaveBalanceDays)).toBe(20);
  });
  it("le SUPER ADMIN supprime la demande — et le solde débité est RESTITUÉ", async () => {
    ACTOR = await actorFor(adminUserId, "SUPER_ADMIN");
    const fd = new FormData(); fd.set("kind", "LEAVE_REQUEST"); fd.set("id", leaveId);
    const r = await superAdminDelete(fd);
    expect(r.ok).toBe(true);

    expect(await prisma.leaveRequest.findUnique({ where: { id: leaveId } })).toBeNull();
    // Les 10 jours reviennent : effacer la ligne sans les rendre les ferait disparaître pour
    // une demande qui n'existe plus, sans que personne ne sache pourquoi.
    expect(Number((await prisma.employee.findUniqueOrThrow({ where: { id: salarieEmpId } })).leaveBalanceDays)).toBe(30);
  });

  it("…et la RESTAURER depuis la corbeille reprend les jours — pas l'objet ET la compensation", async () => {
    const rec = await prisma.deletedRecord.findFirstOrThrow({
      where: { kind: "LEAVE_REQUEST", sourceId: leaveId }, orderBy: { deletedAt: "desc" },
    });
    ACTOR = await actorFor(adminUserId, "SUPER_ADMIN");
    const fd = new FormData(); fd.set("id", rec.id);
    expect((await restoreDeletedRecord(fd)).ok).toBe(true);

    expect(await prisma.leaveRequest.findUnique({ where: { id: leaveId } })).not.toBeNull();
    expect(Number((await prisma.employee.findUniqueOrThrow({ where: { id: salarieEmpId } })).leaveBalanceDays)).toBe(20);

    // On repart d'un solde propre pour la suite des scénarios.
    const again = new FormData(); again.set("kind", "LEAVE_REQUEST"); again.set("id", leaveId);
    expect((await superAdminDelete(again)).ok).toBe(true);
    expect(Number((await prisma.employee.findUniqueOrThrow({ where: { id: salarieEmpId } })).leaveBalanceDays)).toBe(30);
  });

  it("un REFUS à la première marche arrête tout — inutile de faire monter au DG", async () => {
    ACTOR = await actorFor(salarieUserId, "MEDICAL_DELEGATE");
    const fd = new FormData();
    fd.set("type", "ANNUAL"); fd.set("startDate", "2026-11-02"); fd.set("endDate", "2026-11-06"); fd.set("days", "5");
    const created = await requestLeave(undefined, fd);
    expect(created.ok).toBe(true);

    ACTOR = await actorFor(managerUserId, "MEDICAL_PROMOTION_MANAGER");
    const dec = new FormData(); dec.set("id", created.id!); dec.set("decision", "REJECTED"); dec.set("note", "Période chargée.");
    expect((await decideLeave(dec)).ok).toBe(true);

    const l = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: created.id! } });
    expect(l.status).toBe("REJECTED");
    expect(l.stage).toBe("DONE");
    expect(l.hrDecidedById).toBeNull();
    expect(l.dgDecidedById).toBeNull();
    expect(Number((await prisma.employee.findUniqueOrThrow({ where: { id: salarieEmpId } })).leaveBalanceDays)).toBe(30);
  });

  it("ON NE VALIDE PAS SA PROPRE DEMANDE — sauf le sommet, qui est parfois seul au-dessus", async () => {
    // 1) Le salarié ordinaire : refus net, avec le motif qui le dit.
    ACTOR = await actorFor(salarieUserId, "MEDICAL_DELEGATE");
    const fd = new FormData();
    fd.set("type", "ANNUAL"); fd.set("startDate", "2026-10-05"); fd.set("endDate", "2026-10-07"); fd.set("days", "3");
    const sienne = await requestLeave(undefined, fd);
    expect(sienne.ok).toBe(true);
    const auto = new FormData(); auto.set("id", sienne.id!); auto.set("decision", "APPROVED");
    const refus = await decideLeave(auto);
    expect(refus.ok).toBe(false);
    expect(refus.error).toMatch(/propre demande de congé/i);

    // 2) Le DG, lui, GARDE la main sur la sienne : personne n'est au-dessus de lui, et lui
    //    interdire de signer laisserait ses congés en suspens indéfiniment. C'est écrit dans
    //    `approval-chain.ts` — on le vérifie plutôt que de le supposer.
    const dgEmp = await prisma.employee.create({
      data: { fullName: `${TAG} DG`, userId: dgUserId, isActive: true, leaveBalanceDays: 30 },
    });
    ACTOR = await actorFor(dgUserId, "GENERAL_MANAGER");
    const sa = new FormData();
    sa.set("type", "ANNUAL"); sa.set("startDate", "2026-12-01"); sa.set("endDate", "2026-12-03"); sa.set("days", "3");
    const created = await requestLeave(undefined, sa);
    expect(created.ok).toBe(true);
    const dec = new FormData(); dec.set("id", created.id!); dec.set("decision", "APPROVED");
    expect((await decideLeave(dec)).ok).toBe(true);

    await prisma.leaveRequest.deleteMany({ where: { employeeId: dgEmp.id } }).catch(() => {});
    await prisma.employee.delete({ where: { id: dgEmp.id } }).catch(() => {});
  });

  /**
   * L'AUTRE CHEMIN DU CONGÉ — la demande RH de « Mon dossier RH » (HrDocumentRequest), dont
   * l'accord DÉBITE aussi le solde (verrou `balanceAppliedAt`). La supprimer doit RENDRE les
   * jours, par les DEUX portes : l'action de l'écran (`deleteHrRequest`) et le registre du
   * Super Admin (corbeille) — et la restauration doit les REPRENDRE.
   */
  it("demande RH de congé annuel accordée : la supprimer restitue le solde (écran ET corbeille)", async () => {
    const mkReq = () => prisma.hrDocumentRequest.create({
      data: {
        employeeId: salarieEmpId, type: "ANNUAL_LEAVE", status: "PENDING",
        periodStart: new Date("2026-10-05T00:00:00Z"), periodEnd: new Date("2026-10-09T00:00:00Z"),
        periodDays: 5,
      },
    });
    const solde = async () => Number((await prisma.employee.findUniqueOrThrow({ where: { id: salarieEmpId } })).leaveBalanceDays);
    const avant = await solde();

    // 1) L'accord RH débite (le VRAI point d'entrée du débit : decideHrLeave).
    ACTOR = await actorFor(rhUserId, "DIRECTION");
    const req1 = await mkReq();
    const d1 = new FormData(); d1.set("id", req1.id); d1.set("decision", "APPROVE");
    expect((await decideHrLeave(d1)).ok).toBe(true);
    expect(await solde()).toBe(avant - 5);

    // 2) La suppression ÉCRAN (bouton de la fiche employé) rend les 5 jours.
    const del1 = new FormData(); del1.set("id", req1.id);
    expect((await deleteHrRequest(del1)).ok).toBe(true);
    expect(await solde()).toBe(avant);

    // 3) Même garantie par la porte du SUPER ADMIN (registre + corbeille)…
    const req2 = await mkReq();
    const d2 = new FormData(); d2.set("id", req2.id); d2.set("decision", "APPROVE");
    expect((await decideHrLeave(d2)).ok).toBe(true);
    expect(await solde()).toBe(avant - 5);

    ACTOR = await actorFor(adminUserId, "SUPER_ADMIN");
    const del2 = new FormData(); del2.set("kind", "HR_REQUEST"); del2.set("id", req2.id);
    expect((await superAdminDelete(del2)).ok).toBe(true);
    expect(await solde()).toBe(avant);

    // 4) …et RESTAURER reprend les jours — jamais l'objet ET sa compensation.
    const rec = await prisma.deletedRecord.findFirstOrThrow({
      where: { kind: "HR_REQUEST", sourceId: req2.id }, orderBy: { deletedAt: "desc" },
    });
    const fdRestore = new FormData(); fdRestore.set("id", rec.id);
    expect((await restoreDeletedRecord(fdRestore)).ok).toBe(true);
    expect(await solde()).toBe(avant - 5);

    // Solde propre pour la suite.
    const del3 = new FormData(); del3.set("kind", "HR_REQUEST"); del3.set("id", req2.id);
    expect((await superAdminDelete(del3)).ok).toBe(true);
    expect(await solde()).toBe(avant);
  });
  /**
   * LE NOMBRE DE JOURS NE VIENT PAS DU NAVIGATEUR (audit du 27/10/2026, RH-DOCUMENTS-COMMS-02) : `days` est un
   * champ caché du formulaire ; l'accord débite ce nombre du solde. Un `days=-15` recréditait 15 jours.
   */
  it("les jours sont recalculés par le serveur — un champ « days » forgé ne pilote pas le solde", async () => {
    ACTOR = await actorFor(salarieUserId, "MEDICAL_DELEGATE");
    const ids: string[] = [];
    for (const forge of ["-15", "1", "Infinity"]) {
      const fd = new FormData();
      fd.set("type", "ANNUAL");
      fd.set("startDate", "2026-11-02");
      fd.set("endDate", "2026-11-21"); // 20 jours calendaires
      fd.set("days", forge);
      const r = await requestLeave(undefined, fd);
      expect(r.ok).toBe(true);
      ids.push(r.id!);
      expect(Number((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: r.id! } })).days)).toBe(20);
    }
    // Un type inventé est refusé proprement (et non une erreur Prisma).
    const bad = new FormData();
    bad.set("type", "VACANCES"); bad.set("startDate", "2026-11-02"); bad.set("endDate", "2026-11-03");
    expect((await requestLeave(undefined, bad)).ok).toBe(false);
    await prisma.leaveRequest.deleteMany({ where: { id: { in: ids } } });
  });
  /**
   * UNE DÉCISION RH NE SE PREND QU'UNE FOIS, JAMAIS SUR SA PROPRE DEMANDE (audit du 27/10/2026, RH-DOCUMENTS-COMMS-03).
   */
  it("décision RH : un refus après accord est refusé (solde débité une seule fois), une demande annulée ne se valide pas, ni sa propre demande", async () => {
    const solde = async () => Number((await prisma.employee.findUniqueOrThrow({ where: { id: salarieEmpId } })).leaveBalanceDays);
    const avant = await solde();
    const mk = (status: "PENDING" | "CANCELLED", employeeId = salarieEmpId) => prisma.hrDocumentRequest.create({
      data: {
        employeeId, type: "ANNUAL_LEAVE", status,
        periodStart: new Date("2026-12-07T00:00:00Z"), periodEnd: new Date("2026-12-09T00:00:00Z"), periodDays: 3,
      },
    });
    const decide = (id: string, decision: string) => { const f = new FormData(); f.set("id", id); f.set("decision", decision); return decideHrLeave(f); };
    ACTOR = await actorFor(rhUserId, "DIRECTION");

    const r1 = await mk("PENDING");
    expect((await decide(r1.id, "APPROVE")).ok).toBe(true);
    expect(await solde()).toBe(avant - 3);
    const encore = await decide(r1.id, "REJECT");
    expect(encore.ok).toBe(false);
    expect((await prisma.hrDocumentRequest.findUniqueOrThrow({ where: { id: r1.id } })).status).toBe("APPROVED");
    expect(await decide(r1.id, "APPROVE")).toMatchObject({ ok: false });
    expect(await solde()).toBe(avant - 3);

    const annulee = await mk("CANCELLED");
    expect((await decide(annulee.id, "APPROVE")).ok).toBe(false);
    expect((await prisma.hrDocumentRequest.findUniqueOrThrow({ where: { id: annulee.id } })).status).toBe("CANCELLED");

    const rhEmp = await prisma.employee.create({ data: { fullName: `${TAG} RH`, userId: rhUserId, isActive: true } });
    const sienne = await mk("PENDING", rhEmp.id);
    expect((await decide(sienne.id, "APPROVE")).ok).toBe(false);

    await prisma.hrDocumentRequest.deleteMany({ where: { id: { in: [r1.id, annulee.id, sienne.id] } } });
    await prisma.employee.update({ where: { id: salarieEmpId }, data: { leaveBalanceDays: avant } });
  });
});
