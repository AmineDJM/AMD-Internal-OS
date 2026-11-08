import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { ordreGlobalALaValidation } from "@/lib/medical-info/circuits";
import { ouvrirDeclarationDepuisAdPro, validateDeclaration } from "@/lib/actions/medical-info-actions";
import { etapeDeclaration, TITRE_ETAPE_DECLARATION } from "./etape-ad-pro";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DERNIÈRE ÉTAPE AD & PRO — « Déclaration (information scientifique) » (Direction, 08/11/2026), jouée en base.
 *
 *  • l'étape LIT le dossier d'information médicale : à ouvrir, en cours, déclarée (réf.), validée ;
 *  • le pharmacien ouvre la déclaration d'une demande accordée qui n'en a pas — SANS argent : pas de montant, et
 *    rattachée à l'ordre déjà parti, si bien que sa validation finale ne paie jamais une seconde fois ;
 *  • un autre que le pharmacien ne l'ouvre pas ; le matériel promotionnel n'a pas cette étape.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__etapedecl${Date.now()}__`;
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: null, access, mustChangePassword: false };
}

suite("Ad & Pro — la dernière étape : la déclaration de l'événement (information scientifique)", () => {
  let primId = "", delegueId = "", spoId = "", ordreId = "";

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) => prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    const [prim, delegue] = await Promise.all([mk("prim", "MEDICAL_INFO_PHARMACIST"), mk("delegue", "MEDICAL_DELEGATE")]);
    primId = prim.id; delegueId = delegue.id;
    // Le pharmacien lit la fiche du sponsoring (en production, c'est d'elle qu'il agit).
    await prisma.userAccess.create({ data: { userId: primId, module: "SPONSORING", canView: true, scope: "ALL" } });
    // Une demande accordée sous l'ANCIENNE règle (montant global), son ordre déjà parti, et AUCUNE déclaration.
    const spo = await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}SPO`, institution: `${TAG}Hôpital`, type: "Congrès", status: "APPROVED", amountGranted: 1668550, requesterId: delegueId },
    });
    spoId = spo.id;
    ordreId = (await prisma.expenseOrder.create({
      data: { reference: `${TAG}OD`, label: `${TAG}ordre parti`, amount: 1668550, category: "EVENEMENT", sourceType: "SPONSORING", sourceId: spo.id },
    })).id;
  }, 120_000);

  afterAll(async () => {
    const comptes = [primId, delegueId].filter(Boolean);
    const decls = (await prisma.medicalInfoDeclaration.findMany({ where: { sourceId: spoId }, select: { id: true } })).map((d) => d.id);
    await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: comptes } }, { createdAt: { gte: new Date(Date.now() - 600_000) }, body: { contains: TAG } }] } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { id: { in: decls } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: ordreId } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: spoId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: comptes } } }).catch(() => {});
  }, 120_000);

  it("sans déclaration, l'étape est « à ouvrir » — le pharmacien seul peut l'ouvrir ; avant la pré-validation, elle est à venir", async () => {
    const prim = await actorFor(primId);
    const etape = await etapeDeclaration(prim, "SPONSORING", spoId, true);
    expect(etape).toMatchObject({ titre: TITRE_ETAPE_DECLARATION, etat: "current", detail: "à ouvrir", peutOuvrir: true, peutAgir: false, declaration: null });
    expect((await etapeDeclaration(await actorFor(delegueId), "SPONSORING", spoId, true))?.peutOuvrir).toBe(false);
    expect(await etapeDeclaration(prim, "SPONSORING", spoId, false)).toMatchObject({ etat: "todo", peutOuvrir: false });
  });

  it("un autre que le pharmacien ne l'ouvre pas ; le matériel promotionnel n'a pas cette étape", async () => {
    ACTOR = await actorFor(delegueId);
    const r = await ouvrirDeclarationDepuisAdPro(form({ sourceType: "SPONSORING", sourceId: spoId }));
    expect(r).toMatchObject({ ok: false, error: "Réservé au pharmacien responsable de l'information médicale." });
    ACTOR = await actorFor(primId);
    const promo = await ouvrirDeclarationDepuisAdPro(form({ sourceType: "PROMO_MATERIAL", sourceId: spoId }));
    expect(promo.ok).toBe(false);
    expect(promo.error).toMatch(/matériel promotionnel a son propre circuit/);
    expect(await etapeDeclaration(ACTOR, "PROMO_MATERIAL", spoId, true)).toBeNull();
    expect(await prisma.medicalInfoDeclaration.count({ where: { sourceId: spoId } })).toBe(0);
  });

  it("le pharmacien l'ouvre : SANS montant, rattachée à l'ordre déjà parti — sa validation finale ne paiera pas deux fois ; une seule, même à deux clics", async () => {
    ACTOR = await actorFor(primId);
    expect((await ouvrirDeclarationDepuisAdPro(form({ sourceType: "SPONSORING", sourceId: spoId }))).ok).toBe(true);
    expect((await ouvrirDeclarationDepuisAdPro(form({ sourceType: "SPONSORING", sourceId: spoId }))).ok).toBe(true);
    const decls = await prisma.medicalInfoDeclaration.findMany({ where: { sourceType: "SPONSORING", sourceId: spoId } });
    expect(decls).toHaveLength(1);
    expect(decls[0]).toMatchObject({ amount: null, expenseOrderId: ordreId, requesterId: delegueId });
    expect(ordreGlobalALaValidation(decls[0])).toBe(false);
  });

  it("l'étape suit le dossier : en cours (dépôt fermé tant que la lecture n'est pas accordée), déclarée (réf.), puis validée", async () => {
    const prim = await actorFor(primId);
    const decl = await prisma.medicalInfoDeclaration.findFirstOrThrow({ where: { sourceId: spoId } });

    const enCours = await etapeDeclaration(prim, "SPONSORING", spoId, true);
    expect(enCours).toMatchObject({ etat: "current", peutAgir: true, peutOuvrir: false, lienDossier: `/information-medicale/${decl.id}`, depot: { ouvert: false } });
    expect(enCours?.depot.motif).toBeTruthy();
    expect(enCours?.phrase).toMatch(/chez/);
    // La lecture « à déclarer / sans déclaration » se soumet d'ici tant qu'elle n'est pas accordée ; rien à valider encore.
    expect(enCours).toMatchObject({ decision: { peutDemander: true, validationHref: null }, validation: { peut: false } });
    expect((await etapeDeclaration(await actorFor(delegueId), "SPONSORING", spoId, true))?.decision).toBeNull();

    await prisma.medicalInfoDeclaration.update({ where: { id: decl.id }, data: { authorityRef: "MIP-2026-0412" } });
    expect(await etapeDeclaration(prim, "SPONSORING", spoId, true)).toMatchObject({
      etat: "current", detail: "réf. MIP-2026-0412", phrase: `Déclarée au ministère (réf. MIP-2026-0412) — à valider par ${TAG}prim`,
    });
    // Le pharmacien a validé : la suite est chez le Directeur des Opérations.
    await prisma.medicalInfoDeclaration.update({ where: { id: decl.id }, data: { status: "AWAITING_DIRECTION", pharmacistValidatedAt: new Date() } });
    expect((await etapeDeclaration(prim, "SPONSORING", spoId, true))?.phrase)
      .toBe("Déclarée au ministère (réf. MIP-2026-0412) — validation finale chez le Directeur des Opérations");

    // « Sans déclaration » accordée : la phrase le dit, et la référence ne se réclame pas avec un motif qui se contredit.
    await prisma.medicalInfoDeclaration.update({
      where: { id: decl.id }, data: { status: "READY", pharmacistValidatedAt: null, authorityRef: null, declareIntent: "SKIP", declareNote: "Congrès sans promotion", declareGrantedAt: new Date() },
    });
    const sans = await etapeDeclaration(prim, "SPONSORING", spoId, true);
    expect(sans).toMatchObject({ detail: "sans déclaration", phrase: `Sans déclaration (motif : Congrès sans promotion) — à valider par ${TAG}prim` });
    expect(sans?.depot.motif).toBe("Sans déclaration : rien n'est déposé au ministère, il n'y a donc pas de référence à enregistrer.");
    // Lecture accordée : plus de décision à soumettre, et « Valider et transmettre » s'offre — par la VRAIE action.
    expect(sans).toMatchObject({ decision: null, validation: { peut: true } });
    ACTOR = prim;
    const v = await validateDeclaration(form({ id: decl.id }));
    expect(v.ok, v.error).toBe(true);
    const transmise = await etapeDeclaration(prim, "SPONSORING", spoId, true);
    expect(transmise?.phrase).toBe("Sans déclaration (motif : Congrès sans promotion) — validation finale chez le Directeur des Opérations");
    expect(transmise?.validation.peut).toBe(false);
    await prisma.medicalInfoDeclaration.update({ where: { id: decl.id }, data: { declareIntent: null, declareNote: null, declareGrantedAt: null, authorityRef: "MIP-2026-0412" } });

    await prisma.medicalInfoDeclaration.update({ where: { id: decl.id }, data: { status: "VALIDATED", validatedAt: new Date() } });
    expect(await etapeDeclaration(prim, "SPONSORING", spoId, true)).toMatchObject({
      etat: "done", ton: "succes", peutAgir: false, phrase: "Validée — déclarée au ministère (réf. MIP-2026-0412)",
    });
    // Le délégué voit l'état, sans le dossier ni ses pièces.
    expect(await etapeDeclaration(await actorFor(delegueId), "SPONSORING", spoId, true)).toMatchObject({ etat: "done", peutAgir: false, lienDossier: null, pieces: [] });
  });
});
