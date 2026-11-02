import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { createCongressRequest } from "./actions-congres";
import { addCareBeneficiary, decideCareBeneficiary, setCareCellStatus, creerProfilProfessionnel } from "./actions-prise-en-charge";
import { demanderPiecesPriseEnCharge, deposerPiecePriseEnCharge } from "./actions-prise-en-charge-logistique";
import { addCongressBeneficiary, removeCongressBeneficiary, requestBeneficiaryIds } from "./actions-congres-beneficiaires";
import { updateAdProRequest } from "./actions-edition";
import { getCareDossier } from "./infra/requetes/prise-en-charge";
import { piecesDuProfessionnel } from "./domaine/prise-en-charge/regles";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__pec_pro__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fdOf = (o: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(o)) fd.set(k, v); return fd; };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PRISE EN CHARGE — UNE SEULE LISTE DE PROFESSIONNELS PROPOSÉS, ET LEURS PIÈCES (04/10/2026).
 *
 * Par les VRAIES actions, avec des acteurs SANS vue globale (§118.104) : la Direction Marketing,
 * qui dépose et gère les prises en charge, et un délégué qui ne voit QUE ses demandes.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Prise en charge — professionnels proposés et pièces par personne", () => {
  let pmId = "", delegueId = "", docId = "", intlId = "", natId = "";
  let PM: CurrentUser, DELEGUE: CurrentUser;

  beforeAll(async () => {
    const pm = await prisma.user.create({ data: { name: `${TAG}dm`, email: `${TAG}dm@t.dz`, role: "PRODUCT_MANAGER", passwordHash: "x" } });
    const del = await prisma.user.create({ data: { name: `${TAG}del`, email: `${TAG}del@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } });
    pmId = pm.id; delegueId = del.id;
    docId = (await prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Annuaire` } })).id;
    PM = await actorFor(pmId, "PRODUCT_MANAGER");
    DELEGUE = await actorFor(delegueId, "MEDICAL_DELEGATE");
    // LA PRÉMISSE : ni l'un ni l'autre n'a la vue globale — sinon les portes ne pourraient pas tomber.
    expect(hasGlobalView(PM) || hasGlobalView(DELEGUE)).toBe(false);

    ACTOR = PM;
    const intl = await createCongressRequest(undefined, fdOf({ type: "INTL", name: `${TAG}Intl`, startDate: "2026-11-02", endDate: "2026-11-05", invitedDoctorIds: docId }));
    const nat = await createCongressRequest(undefined, fdOf({ type: "NATIONAL", name: `${TAG}Nat`, date: "2026-11-10", endDate: "2026-11-11" }));
    expect(intl.ok && nat.ok).toBe(true);
    intlId = intl.ok ? intl.id! : ""; natId = nat.ok ? nat.id! : "";
  });

  afterAll(async () => {
    await prisma.document.deleteMany({ where: { entityId: { in: [intlId, natId].filter(Boolean) } } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [pmId, delegueId] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [pmId, delegueId] } } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    ACTOR = null;
  });

  it("le praticien choisi à la création est déjà PROPOSÉ sur la fiche — la même liste", async () => {
    const d = await getCareDossier("INTERNATIONAL", intlId);
    expect(d.beneficiaries.map((b) => [b.name, b.status, b.fromDirectory])).toEqual([[`${TAG}Dr Annuaire`, "PROPOSED", true]]);
  });

  it("créer un profil de médecin, proposer une personne libre ; un praticien déjà proposé est refusé", async () => {
    ACTOR = PM;
    const cree = await addCareBeneficiary(undefined, fdOf({ scope: "INTERNATIONAL", requestId: intlId, createDoctor: "on", doctorName: `${TAG}Dr Nouveau`, jobTitle: "Orateur" }));
    expect(cree.ok, cree.ok ? "" : cree.error).toBe(true);
    // Le profil est entré dans l'annuaire, et la ligne le DÉSIGNE (pas un nom libre).
    const fiche = await prisma.medicalDoctor.findFirstOrThrow({ where: { name: `${TAG}Dr Nouveau` } });
    const ligne = await prisma.careBeneficiary.findUniqueOrThrow({ where: { id: cree.id! } });
    expect([ligne.doctorId, ligne.jobTitle, ligne.lastName]).toEqual([fiche.id, "Orateur", null]);

    const libre = await addCareBeneficiary(undefined, fdOf({ scope: "INTERNATIONAL", requestId: intlId, lastName: `${TAG}Libre`, firstName: "Sara" }));
    expect(libre.ok).toBe(true);
    const doublon = await addCareBeneficiary(undefined, fdOf({ scope: "INTERNATIONAL", requestId: intlId, doctorId: docId }));
    expect(doublon.ok === false && doublon.error).toBe("Ce praticien est déjà proposé sur cette demande.");
  });

  it("un délégué n'ajoute PERSONNE à la prise en charge d'un collègue — la porte de la fiche, pas le module", async () => {
    // LA PRÉMISSE : le module lui est ouvert ; le refus ne peut venir que de la portée de ligne.
    expect(userCan(DELEGUE, "CONGRESS_INTERNATIONAL", "CREATE")).toBe(true);
    ACTOR = DELEGUE;
    const r = await addCareBeneficiary(undefined, fdOf({ scope: "INTERNATIONAL", requestId: intlId, lastName: `${TAG}Intrus` }));
    expect(r.ok === false && r.error).toBe("Demande introuvable.");
    const p = await demanderPiecesPriseEnCharge(undefined, fdOf({ scope: "INTERNATIONAL", requestId: intlId }));
    expect(p.ok === false && p.error).toBe("Demande introuvable.");
    expect(await prisma.careBeneficiary.count({ where: { lastName: `${TAG}Intrus` } })).toBe(0);
  });

  it("DEMANDER LES PIÈCES : international = passeport, visa, voyage pour chaque personne vivante — jamais deux fois, jamais pour un écarté", async () => {
    ACTOR = PM;
    // Une personne écartée ne reçoit rien. Le chef d'écran (VALIDATE) tranche : la Direction Marketing.
    const ecartee = await addCareBeneficiary(undefined, fdOf({ scope: "INTERNATIONAL", requestId: intlId, lastName: `${TAG}Ecartee` }));
    const dec = await decideCareBeneficiary(undefined, fdOf({ id: ecartee.id!, decision: "REJECTED" }));
    expect(dec.ok, dec.ok ? "" : dec.error).toBe(true);

    const r = await demanderPiecesPriseEnCharge(undefined, fdOf({ scope: "INTERNATIONAL", requestId: intlId }));
    expect(r.ok && r.message).toBe("9 pièce(s) demandée(s) pour 3 professionnel(s).");
    const d = await getCareDossier("INTERNATIONAL", intlId);
    for (const b of d.beneficiaries) {
      const etats = piecesDuProfessionnel("INTERNATIONAL", b.cells).map((p) => [p.label, p.etat]);
      expect(etats, b.name).toEqual(b.status === "REJECTED"
        ? [["Passeport", "MANQUANTE"], ["Visa", "MANQUANTE"], ["Informations de voyage", "MANQUANTE"]]
        : [["Passeport", "DEMANDEE"], ["Visa", "DEMANDEE"], ["Informations de voyage", "DEMANDEE"]]);
    }
    const encore = await demanderPiecesPriseEnCharge(undefined, fdOf({ scope: "INTERNATIONAL", requestId: intlId }));
    expect(encore.ok && encore.message).toMatch(/^Rien à demander/);
  });

  it("deux demandes de pièces SIMULTANÉES ne doublent aucune case", async () => {
    ACTOR = PM;
    const p = await addCareBeneficiary(undefined, fdOf({ scope: "NATIONAL", requestId: natId, lastName: `${TAG}Course` }));
    expect(p.ok).toBe(true);
    const [a, b] = await Promise.all([
      demanderPiecesPriseEnCharge(undefined, fdOf({ scope: "NATIONAL", requestId: natId })),
      demanderPiecesPriseEnCharge(undefined, fdOf({ scope: "NATIONAL", requestId: natId })),
    ]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    // NATIONAL : le passeport, une seule case.
    expect(await prisma.careCell.count({ where: { beneficiaryId: p.id!, kind: "DOCUMENT" } })).toBe(1);
  });

  it("DÉPOSER une pièce la rend REÇUE, rattachée à SA case ; validée ou sans objet, elle ne se remplace pas d'ici", async () => {
    ACTOR = PM;
    const d = await getCareDossier("INTERNATIONAL", intlId);
    const vivant = d.beneficiaries.find((b) => b.status === "PROPOSED")!;
    const [passeport, visa] = piecesDuProfessionnel("INTERNATIONAL", vivant.cells);
    const fd = fdOf({ cellId: passeport.cellId! });
    fd.set("file", new File([Buffer.from("%PDF-1.4 passeport")], "passeport.pdf", { type: "application/pdf" }));
    const r = await deposerPiecePriseEnCharge(undefined, fd);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const cell = await prisma.careCell.findUniqueOrThrow({ where: { id: passeport.cellId! } });
    expect(cell.status).toBe("PROVIDED");
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: cell.documentId! } });
    expect([doc.entityType, doc.entityId, doc.stepKey, doc.category]).toEqual(["CONGRESS_INTERNATIONAL", intlId, passeport.cellId, "ID_DOCUMENT"]);

    await setCareCellStatus(undefined, fdOf({ id: visa.cellId!, status: "WAIVED" }));
    const fd2 = fdOf({ cellId: visa.cellId! });
    fd2.set("file", new File([Buffer.from("%PDF-1.4 visa")], "visa.pdf", { type: "application/pdf" }));
    const refus = await deposerPiecePriseEnCharge(undefined, fd2);
    expect(refus.ok === false && refus.error).toBe("« Visa » est déclarée sans objet : rouvrez son état avant de la déposer.");
    expect(await prisma.document.count({ where: { stepKey: visa.cellId! } })).toBe(0);
  });

  it("les gestes d'avant (ops d'Adam) écrivent la MÊME liste — plus le JSON du congrès", async () => {
    ACTOR = PM;
    const a = await addCongressBeneficiary(fdOf({ kind: "NATIONAL", id: natId, name: `${TAG}ViaAdam`, role: "Invité" }));
    expect(a.ok, a.ok ? "" : a.error).toBe(true);
    const c = await prisma.congressNational.findUniqueOrThrow({ where: { id: natId }, include: { careBeneficiaries: true } });
    expect(c.beneficiaries).toBeNull();
    const ligne = c.careBeneficiaries.find((b) => b.lastName === `${TAG}ViaAdam`)!;
    expect(ligne.jobTitle).toBe("Invité");
    // Une personne d'une AUTRE demande ne se retire pas d'ici.
    const autre = await prisma.careBeneficiary.findFirstOrThrow({ where: { congressInternationalId: intlId } });
    const mauvais = await removeCongressBeneficiary(fdOf({ kind: "NATIONAL", id: natId, benefId: autre.id }));
    expect(mauvais.ok === false && mauvais.error).toBe("Personne introuvable sur cette demande.");
    const req = await requestBeneficiaryIds(fdOf({ kind: "NATIONAL", id: natId }));
    expect(req.ok && req.message).toBe("1 pièce(s) demandée(s) pour 1 professionnel(s).");
    const retire = await removeCongressBeneficiary(fdOf({ kind: "NATIONAL", id: natId, benefId: ligne.id }));
    expect(retire.ok).toBe(true);
    expect(await prisma.careBeneficiary.count({ where: { id: ligne.id } })).toBe(0);
  });

  it("CORRIGER : la fin ne précède pas le début, et les champs retirés ne s'écrivent plus", async () => {
    // La demande du DÉLÉGUÉ, encore dans son circuit (celle de la Direction Marketing est prévalidée
    // d'office depuis le 27/10/2026 : décidée, elle ne se corrige plus que par la Direction).
    ACTOR = DELEGUE;
    const cree = await createCongressRequest(undefined, fdOf({ type: "NATIONAL", name: `${TAG}NatDel`, date: "2026-11-10", endDate: "2026-11-11" }));
    expect(cree.ok, cree.ok ? "" : cree.error).toBe(true);
    const id = cree.ok ? cree.id! : "";
    await prisma.congressNational.update({ where: { id }, data: { presentDelegates: "Ancienne saisie", specialty: "Cardiologie" } });
    const envers = await updateAdProRequest(fdOf({ kind: "CONGRESS_NATIONAL", id, endDate: "2026-11-01" }));
    expect(envers.ok === false && envers.error).toBe("La date de fin ne peut pas précéder la date de début.");
    const r = await updateAdProRequest(fdOf({ kind: "CONGRESS_NATIONAL", id, endDate: "2026-11-12", presentDelegates: "", specialty: "" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const c = await prisma.congressNational.findUniqueOrThrow({ where: { id } });
    // Ce que le formulaire ne porte plus ne s'écrit plus — et un champ retiré n'EFFACE pas la valeur d'avant.
    expect([c.presentDelegates, c.specialty, c.endDate?.toISOString().slice(0, 10)]).toEqual(["Ancienne saisie", "Cardiologie", "2026-11-12"]);
  });

  it("créer un profil depuis le formulaire de création : réservé à qui crée une prise en charge", async () => {
    ACTOR = PM;
    const ok = await creerProfilProfessionnel(undefined, fdOf({ scope: "NATIONAL", doctorName: `${TAG}Dr Formulaire` }));
    expect(ok.ok && ok.message).toBe(`${TAG}Dr Formulaire`);
    const forge = await creerProfilProfessionnel(undefined, fdOf({ scope: "NATIONAL", doctorName: `${TAG}Dr Forge`, specialtyId: "inexistant" }));
    expect(forge.ok === false && forge.error).toBe("Spécialité introuvable dans le référentiel.");
  });

  it("LA MIGRATION reprend le JSON d'après le 06/08 et les médecins cochés — une fois, sans doublon", async () => {
    const sql = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/20270107090000_prise_en_charge_professionnels/migration.sql"), "utf8")
      .replace(/--.*$/gm, "");
    const instructions = sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean);
    const ANNULE = "annulation volontaire";
    await prisma.$transaction(async (tx) => {
      const autreDoc = await tx.medicalDoctor.create({ data: { name: `${TAG}Dr Json` } });
      const c = await tx.congressNational.create({
        data: {
          name: `${TAG}Mig`, invitedDoctorIds: [docId, autreDoc.id, "fantome"],
          beneficiaries: [
            { id: "j1", name: "Déjà repris" },
            { id: "j2", name: "Libre", role: "Orateur" },
            { id: "j3", name: "x", doctorId: autreDoc.id },
          ],
        },
      });
      // L'élément 1 avait été repris par la migration du 06/08 (`mig_<demande>_<rang>`).
      await tx.careBeneficiary.create({ data: { id: `mig_${c.id}_1`, congressNationalId: c.id, lastName: "Déjà repris" } });
      for (let tour = 0; tour < 2; tour++) for (const i of instructions) await tx.$executeRawUnsafe(i);
      const lignes = await tx.careBeneficiary.findMany({ where: { congressNationalId: c.id }, orderBy: { position: "asc" } });
      expect(lignes.map((l) => l.doctorId ?? l.lastName).sort()).toEqual([docId, autreDoc.id, "Déjà repris", "Libre"].sort());
      expect(lignes.find((l) => l.lastName === "Libre")?.jobTitle).toBe("Orateur");
      throw new Error(ANNULE);
    }).catch((e: Error) => { if (e.message !== ANNULE) throw e; });
  });
});
