import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { getMyHrDossier } from "@/modules/rh/api";
import {
  requestHrDocument, updateExpenseClaim, setExpenseClaimEditUnlocked, askHrRequestPiece,
} from "@/modules/rh/actions-documents";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__noteDeFrais__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

const recu = (nom = "recu.pdf") =>
  new File([new Uint8Array([37, 80, 68, 70])], nom, { type: "application/pdf" });

function fd(values: Record<string, string>, files: File[] = []): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  for (const file of files) f.append("files", file);
  return f;
}

const moisCourant = () => new Date().toISOString().slice(0, 7);

/**
 * LA NOTE DE FRAIS — son montant, sa pièce, ses quinze minutes, et ce que les RH en font.
 *
 * ── CE QUE CE FICHIER TIENT, ET QUE LE MODULE PUR NE PEUT PAS TENIR ─────────────────────────
 *
 * `expense-claim.test.ts` prouve que la RÈGLE est juste à partir d'un état donné. Il ne dit rien
 * des deux points qui coûtent cher :
 *
 *   • **la garde vit-elle dans le SERVEUR ?** L'écran cache le bouton passé le délai, et cela ne
 *     prouve rien : une action serveur s'appelle depuis le navigateur (§118-7) ;
 *   • **la note reste-t-elle LA MÊME ?** Toute cette mécanique existe pour éviter la seconde
 *     demande. Si corriger recréait une ligne, on aurait exactement le défaut qu'on corrige,
 *     déguisé en fonctionnalité.
 *
 * On part donc de `requestHrDocument`, `updateExpenseClaim`, `setExpenseClaimEditUnlocked` et
 * `askHrRequestPiece` — les quatre portes que les écrans poussent.
 */
suite("Note de frais : un montant, une pièce, quinze minutes, et les RH", () => {
  let salarieId = "";
  let employeId = "";
  let rhId = "";
  let noteId = "";

  beforeAll(async () => {
    const [u, rh] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} salarie`, email: `${TAG}s@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" }, select: { id: true } }),
      prisma.user.create({ data: { name: `${TAG} rh`, email: `${TAG}rh@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" }, select: { id: true } }),
    ]);
    salarieId = u.id; rhId = rh.id;
    employeId = (await prisma.employee.create({
      data: { fullName: `${TAG} salarie`, userId: salarieId, isActive: true },
      select: { id: true },
    })).id;
  }, 120_000);

  afterAll(async () => {
    await prisma.documentRequest.deleteMany({ where: { entityType: "HR_REQUEST", entityId: noteId } }).catch(() => {});
    await retirerDocumentsEtContenu({ where: { entityType: "HR_REQUEST", entityId: noteId } }).catch(() => {});
    await prisma.hrDocumentRequest.deleteMany({ where: { employeeId: employeId } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: employeId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [salarieId, rhId] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [salarieId, rhId] } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 120_000);

  // ─────────────────────────── LE DÉPÔT ───────────────────────────

  it("UNE NOTE SANS MONTANT NE PART PAS — le chiffre ne vit plus dans le motif", async () => {
    ACTOR = await actorFor(salarieId, "MEDICAL_DELEGATE");
    const r = await requestHrDocument(fd({ type: "EXPENSE_REPORT", expenseMonth: moisCourant(), details: "4 200 DZD de taxi" }, [recu()]));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/montant/i);
  });

  it("ZÉRO N'EST PAS UN MONTANT — c'est un champ qu'on a sauté", async () => {
    ACTOR = await actorFor(salarieId, "MEDICAL_DELEGATE");
    const r = await requestHrDocument(fd({ type: "EXPENSE_REPORT", expenseMonth: moisCourant(), expenseAmount: "0" }, [recu()]));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/supérieur à zéro/i);
  });

  it("UNE NOTE SANS JUSTIFICATIF NON PLUS — sinon c'est une affirmation, pas une demande", async () => {
    ACTOR = await actorFor(salarieId, "MEDICAL_DELEGATE");
    const r = await requestHrDocument(fd({ type: "EXPENSE_REPORT", expenseMonth: moisCourant(), expenseAmount: "4200" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/justificatif/i);
  });

  it("avec son montant et sa pièce, elle part — et la fenêtre de correction est POSÉE", async () => {
    ACTOR = await actorFor(salarieId, "MEDICAL_DELEGATE");
    const r = await requestHrDocument(fd({
      type: "EXPENSE_REPORT", expenseMonth: moisCourant(), expenseAmount: "4200",
      details: "Taxi et péage, PCH Alger",
    }, [recu()]));
    expect(r.ok, r.error).toBe(true);
    noteId = r.id!;

    const note = await prisma.hrDocumentRequest.findUniqueOrThrow({ where: { id: noteId } });
    expect(Number(note.expenseAmount)).toBe(4200);
    // Le motif ne porte plus le chiffre : il porte le motif.
    expect(note.details).toBe("Taxi et péage, PCH Alger");
    expect(note.editableUntil).not.toBeNull();
    expect(note.editableUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(await prisma.document.count({ where: { entityType: "HR_REQUEST", entityId: noteId } })).toBe(1);
  });

  it("LES AUTRES DEMANDES RH NE SONT PAS TOUCHÉES — une attestation n'a ni montant ni pièce", async () => {
    // La garde est bornée à la note de frais : l'étendre aurait fermé onze circuits d'un coup.
    ACTOR = await actorFor(salarieId, "MEDICAL_DELEGATE");
    const r = await requestHrDocument(fd({ type: "WORK_CERTIFICATE" }));
    expect(r.ok, r.error).toBe(true);
    const att = await prisma.hrDocumentRequest.findUniqueOrThrow({ where: { id: r.id! } });
    expect(att.editableUntil).toBeNull();
  });

  // ─────────────────────────── LES QUINZE MINUTES ───────────────────────────

  it("DANS LE DÉLAI, LA CORRECTION PASSE — et c'est la MÊME note qui change", async () => {
    ACTOR = await actorFor(salarieId, "MEDICAL_DELEGATE");
    const avant = await prisma.hrDocumentRequest.count({ where: { employeeId: employeId, type: "EXPENSE_REPORT" } });
    const r = await updateExpenseClaim(fd({ id: noteId, expenseMonth: moisCourant(), expenseAmount: "4700", details: "Taxi, péage et parking" }));
    expect(r.ok, r.error).toBe(true);

    const note = await prisma.hrDocumentRequest.findUniqueOrThrow({ where: { id: noteId } });
    expect(Number(note.expenseAmount)).toBe(4700);
    // AUCUNE SECONDE LIGNE : toute cette mécanique existe pour éviter la note en double.
    expect(await prisma.hrDocumentRequest.count({ where: { employeeId: employeId, type: "EXPENSE_REPORT" } })).toBe(avant);
    // …et la pièce déjà déposée est toujours là.
    expect(await prisma.document.count({ where: { entityType: "HR_REQUEST", entityId: noteId } })).toBe(1);
  });

  it("L'ANCIEN MONTANT PART À L'AUDIT — une correction d'argent sans trace se réécrit après lecture", async () => {
    const trace = await prisma.auditLog.findFirst({
      where: { entityType: "HR_REQUEST", entityId: noteId, field: "expenseAmount" },
      orderBy: { createdAt: "desc" },
      select: { oldValue: true, newValue: true },
    });
    expect(trace?.oldValue).toBe("4200");
    expect(trace?.newValue).toBe("4700");
  });

  it("LA NOTE D'UN AUTRE NE SE MODIFIE PAS, même par les RH", async () => {
    // Le montant est la parole du demandeur : le réécrire à sa place lui ferait porter une
    // somme qu'il n'a pas déclarée. Les RH corrigent en DEMANDANT.
    ACTOR = await actorFor(rhId, "SUPER_ADMIN");
    const r = await updateExpenseClaim(fd({ id: noteId, expenseMonth: moisCourant(), expenseAmount: "99999" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/seul le demandeur/i);
  });

  it("PASSÉ LE DÉLAI, LE SERVEUR REFUSE — et il dit quoi faire ensuite", async () => {
    // On fait vieillir la fenêtre au lieu d'attendre un quart d'heure : c'est la MÊME donnée
    // que celle posée à l'envoi, et c'est elle que la garde lit.
    await prisma.hrDocumentRequest.update({
      where: { id: noteId },
      data: { editableUntil: new Date(Date.now() - 60_000) },
    });
    ACTOR = await actorFor(salarieId, "MEDICAL_DELEGATE");
    const r = await updateExpenseClaim(fd({ id: noteId, expenseMonth: moisCourant(), expenseAmount: "5000" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/demandez aux rh/i);
    expect(Number((await prisma.hrDocumentRequest.findUniqueOrThrow({ where: { id: noteId } })).expenseAmount)).toBe(4700);
  });

  // ─────────────────────────── LES RH ───────────────────────────

  it("LES RH ROUVRENT LA MODIFICATION — et le demandeur est prévenu", async () => {
    ACTOR = await actorFor(rhId, "SUPER_ADMIN");
    const r = await setExpenseClaimEditUnlocked(fd({ id: noteId, unlock: "1" }));
    expect(r.ok, r.error).toBe(true);
    const note = await prisma.hrDocumentRequest.findUniqueOrThrow({ where: { id: noteId } });
    expect(note.editUnlockedAt).not.toBeNull();
    expect(note.editUnlockedById).toBe(rhId);
    // Rouvrir sans le dire ne sert à rien : on ne retourne pas sur l'écran par hasard.
    const notif = await prisma.notification.findFirst({
      where: { userId: salarieId, title: { contains: "corriger votre note" } },
      select: { link: true },
    });
    // …et le lien ouvre SA note dans son dossier, pas le haut de la page.
    expect(notif?.link).toBe(`/mon-dossier#demande-rh-${noteId}`);
  });

  it("…et la correction repasse HORS DÉLAI, la réouverture primant sur l'horloge", async () => {
    ACTOR = await actorFor(salarieId, "MEDICAL_DELEGATE");
    const r = await updateExpenseClaim(fd({ id: noteId, expenseMonth: moisCourant(), expenseAmount: "5100" }));
    expect(r.ok, r.error).toBe(true);
    const note = await prisma.hrDocumentRequest.findUniqueOrThrow({ where: { id: noteId } });
    expect(Number(note.expenseAmount)).toBe(5100);
    // LA RÉOUVERTURE SE CONSOMME : les RH ont dit « corrigez cette fois », pas « quand vous voulez ».
    expect(note.editUnlockedAt).toBeNull();
  });

  it("UN AUTRE SALARIÉ NE ROUVRE RIEN — le déblocage est un geste RH", async () => {
    ACTOR = await actorFor(salarieId, "MEDICAL_DELEGATE");
    expect((await setExpenseClaimEditUnlocked(fd({ id: noteId, unlock: "1" }))).ok).toBe(false);
  });

  it("LES RH RÉCLAMENT UN JUSTIFICATIF — au demandeur, avec une trace, et sans annuaire", async () => {
    ACTOR = await actorFor(rhId, "SUPER_ADMIN");
    const r = await askHrRequestPiece(fd({ requestId: noteId, label: "Le ticket de péage du 12/09" }));
    expect(r.ok, r.error).toBe(true);

    const piece = await prisma.documentRequest.findFirstOrThrow({
      where: { entityType: "HR_REQUEST", entityId: noteId },
      select: { askedToId: true, askedById: true, link: true, status: true, reference: true, kind: true },
    });
    // La pièce d'un taxi est chez celui qui l'a pris — jamais chez un tiers choisi dans une liste.
    expect(piece.askedToId).toBe(salarieId);
    expect(piece.askedById).toBe(rhId);
    // Le demandeur n'a pas le module RH : on le ramène là où SA demande vit.
    expect(piece.link).toBe("/mon-dossier");
    expect(piece.status).toBe("PENDING");
    expect(piece.reference).toMatch(/^PIE-\d{4}-/);
    expect(piece.kind).toBe("PROOF");
  });

  it("dire CE QU'ON VEUT est obligatoire — « pièce manquante » n'envoie personne nulle part", async () => {
    ACTOR = await actorFor(rhId, "SUPER_ADMIN");
    expect((await askHrRequestPiece(fd({ requestId: noteId, label: "" }))).ok).toBe(false);
  });

  it("et un salarié ordinaire ne réclame pas de pièce sur une demande RH", async () => {
    ACTOR = await actorFor(salarieId, "MEDICAL_DELEGATE");
    expect((await askHrRequestPiece(fd({ requestId: noteId, label: "Un reçu" }))).ok).toBe(false);
  });

  // ─────────────────────────── L'HISTORIQUE ───────────────────────────

  it("LA NOTE RESTE À VIE DANS L'HISTORIQUE — corrigée, elle n'a pas changé d'identité", async () => {
    ACTOR = await actorFor(salarieId, "MEDICAL_DELEGATE");
    const dossier = await getMyHrDossier(salarieId);
    const notes = dossier!.requests.filter((r) => r.type === "EXPENSE_REPORT");
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe(noteId);
    // L'écran a de quoi afficher le montant ET l'état de la fenêtre, sans recalculer la règle.
    expect(notes[0].expenseAmount).toBe(5100);
    expect(notes[0].editableUntil).not.toBeNull();
    expect(notes[0].editUnlockedAt).toBeNull();
  });

  it("UNE NOTE TRANCHÉE NE SE ROUVRE PLUS — on ne réécrit pas ce sur quoi quelqu'un s'est prononcé", async () => {
    await prisma.hrDocumentRequest.update({ where: { id: noteId }, data: { status: "DELIVERED" } });
    ACTOR = await actorFor(rhId, "SUPER_ADMIN");
    const r = await setExpenseClaimEditUnlocked(fd({ id: noteId, unlock: "1" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/déjà traitée/i);
  });
});

/**
 * LE CIRCUIT : SUPÉRIEUR HIÉRARCHIQUE, PUIS RH (Super Admin, 24/11/2026) — « les notes de frais ne relèvent pas de l'assistante
 * de direction : elles vont aux RH en passant par le supérieur hiérarchique ». Une note déposée depuis « Mon espace » (hors
 * mission) attend son N+1 (`managerGate`), qui la valide par le même geste que la note d'une mission (`deciderOrdreMissionN1`).
 */
suite("Note de frais : le supérieur hiérarchique, puis les RH", () => {
  const T = `${TAG}n1_`;
  let salarieId = "";
  let chefId = "";
  let employeId = "";
  let chefEmployeId = "";
  let noteId = "";

  beforeAll(async () => {
    const [u, chef] = await Promise.all([
      prisma.user.create({ data: { name: `${T}salarie`, email: `${T}s@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" }, select: { id: true } }),
      prisma.user.create({ data: { name: `${T}chef`, email: `${T}c@t.dz`, role: "MEDICAL_PROMOTION_MANAGER", passwordHash: "x" }, select: { id: true } }),
    ]);
    salarieId = u.id; chefId = chef.id;
    chefEmployeId = (await prisma.employee.create({ data: { fullName: `${T}chef`, userId: chefId, isActive: true }, select: { id: true } })).id;
    employeId = (await prisma.employee.create({ data: { fullName: `${T}salarie`, userId: salarieId, isActive: true, managerId: chefEmployeId }, select: { id: true } })).id;
  }, 120_000);

  afterAll(async () => {
    await retirerDocumentsEtContenu({ where: { entityType: "HR_REQUEST", entityId: noteId } }).catch(() => {});
    await prisma.hrDocumentRequest.deleteMany({ where: { employeeId: employeId } }).catch(() => {});
    await prisma.employee.updateMany({ where: { id: employeId }, data: { managerId: null } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: [employeId, chefEmployeId] } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [salarieId, chefId] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [salarieId, chefId] } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: T } } }).catch(() => {});
  }, 120_000);

  it("déposée, elle attend le N+1 — pas les RH — et la phrase le dit", async () => {
    ACTOR = await actorFor(salarieId, "MEDICAL_DELEGATE");
    const r = await requestHrDocument(fd({ type: "EXPENSE_REPORT", expenseMonth: moisCourant(), expenseAmount: "3100", details: "Parking CHU" }, [recu()]));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/supérieur hiérarchique, puis les RH/);
    noteId = r.id!;
    const note = await prisma.hrDocumentRequest.findUniqueOrThrow({ where: { id: noteId } });
    expect([note.managerGate, note.managerUserId]).toEqual(["PENDING", chefId]);
    expect(await prisma.notification.count({ where: { userId: chefId, title: "Note de frais à valider (votre équipe)" } })).toBe(1);
    // Le N+1 la trouve dans sa file (Tâches, Mes missions, centre d'actions) — le même filtre partout.
    const { ordresMissionAValider } = await import("@/lib/queries/missions");
    const file = await ordresMissionAValider(chefId);
    expect(file.find((o) => o.requestId === noteId)).toMatchObject({ nature: "NF", missionId: null, montant: 3100 });
  });

  it("le N+1 la valide : elle part aux RH", async () => {
    const { deciderOrdreMissionN1 } = await import("@/lib/actions/mission-actions");
    ACTOR = await actorFor(chefId, "MEDICAL_PROMOTION_MANAGER");
    const r = await deciderOrdreMissionN1(fd({ requestId: noteId, decision: "VALIDER" }));
    expect(r.ok, r.error).toBe(true);
    const note = await prisma.hrDocumentRequest.findUniqueOrThrow({ where: { id: noteId } });
    expect([note.managerGate, note.status]).toEqual(["APPROVED", "PENDING"]);
  });
});
