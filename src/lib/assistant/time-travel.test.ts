import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess } from "@/lib/rbac";
import { POWER_TOOLS } from "./power-tools";
import { parseTimeTravelDate } from "./time-travel";

/**
 * TIME TRAVEL — les invariants :
 *   • la RECONSTRUCTION est exacte : la valeur d'un champ à la date = la dernière écriture
 *     tracée AVANT la coupure, ou l'oldValue de la première écriture APRÈS (la valeur que le
 *     champ portait encore ce jour-là) ;
 *   • le « avant / maintenant » se lit d'un coup : ce qui a changé DEPUIS la date est listé ;
 *   • l'HONNÊTETÉ : un dossier créé après la date → « n'existait pas encore », jamais un état
 *     inventé ; une date future est refusée ;
 *   • STRICTEMENT LECTURE SEULE : ni le dossier ni son journal ne bougent d'un octet.
 */

const exec = (id: string): CurrentUser => ({
  id, name: "PDG", email: `${id}@t.dz`, role: "DIRECTION",
  access: { modules: new Map(), rowGrants: new Map() } as unknown as EffectiveAccess,
  mustChangePassword: false,
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__tt__${Date.now()}`;
const REF = `${TAG}-PAY`;
let ceoId = "";
let payId = "";

const tool = POWER_TOOLS.find((t) => t.def.name === "time_travel")!;

suite("time_travel — l'état passé, reconstruit du journal, sans rien toucher", () => {
  beforeAll(async () => {
    const ceo = await prisma.user.create({ data: { name: `${TAG}ceo`, email: `${TAG}c@t.dz`, passwordHash: "x", role: "DIRECTION" } });
    ceoId = ceo.id;
    // Le dossier existe depuis mai ; le journal raconte : soumis le 10/05, montant corrigé le
    // 20/05, approuvé le 03/07, bénéficiaire renommé le 05/07 (SEULE trace du champ payee).
    const pay = await prisma.paymentRequest.create({
      data: {
        reference: REF, title: `${TAG} achat seringues`, amount: 150_000, payee: "Hikma Pharma",
        requesterId: ceoId, status: "SUBMITTED", createdAt: new Date("2026-05-01T10:00:00Z"),
      },
    });
    payId = pay.id;
    await prisma.auditLog.createMany({
      data: [
        { entityType: "PAYMENT_REQUEST", entityId: payId, action: "UPDATE", module: "Finances", field: "status", oldValue: "DRAFT", newValue: "SUBMITTED", summary: "Demande soumise", actorId: ceoId, createdAt: new Date("2026-05-10T09:00:00Z") },
        { entityType: "PAYMENT_REQUEST", entityId: payId, action: "UPDATE", module: "Finances", field: "amount", oldValue: "100000", newValue: "150000", summary: "Montant corrigé", actorId: ceoId, createdAt: new Date("2026-05-20T09:00:00Z") },
        { entityType: "PAYMENT_REQUEST", entityId: payId, action: "UPDATE", module: "Finances", field: "status", oldValue: "SUBMITTED", newValue: "APPROVED", summary: "Bon à payer donné", actorId: ceoId, createdAt: new Date("2026-07-03T09:00:00Z") },
        { entityType: "PAYMENT_REQUEST", entityId: payId, action: "UPDATE", module: "Finances", field: "payee", oldValue: "Hikma", newValue: "Hikma Pharma", summary: "Bénéficiaire précisé", actorId: ceoId, createdAt: new Date("2026-07-05T09:00:00Z") },
      ],
    });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityId: payId } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { reference: REF } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("est enregistré au registre, réservé au siège exécutif", () => {
    expect(tool).toBeTruthy();
    expect(tool.allowed(exec(ceoId))).toBe(true);
    expect(tool.allowed({ ...exec(ceoId), role: "DELEGATE" as CurrentUser["role"] })).toBe(false);
  });

  it("« au 1er juin » = fin de journée Alger ; une date illisible ou future est refusée", async () => {
    expect(parseTimeTravelDate("2026-06-01")?.toISOString()).toBe("2026-06-01T22:59:59.999Z");
    expect(parseTimeTravelDate("n'importe quoi")).toBeNull();
    const future = await tool.run({ reference: REF, date: "2099-01-01" }, exec(ceoId));
    expect(future).toMatch(/futur/);
  });

  it("reconstruit l'état au 1er juin : statut SUBMITTED, montant 150000, payee = valeur d'AVANT le renommage", async () => {
    const before = await prisma.auditLog.count({ where: { entityId: payId } });
    const out = JSON.parse(await tool.run({ reference: REF, date: "2026-06-01" }, exec(ceoId)));

    // Les champs à la date : dernière écriture ≤ 01/06 pour status et amount…
    expect(out.etatReconstruitALaDate.status.valeur).toBe("SUBMITTED");
    expect(out.etatReconstruitALaDate.amount.valeur).toBe("150000");
    // …et pour payee, jamais tracé avant : l'oldValue de la PREMIÈRE écriture d'après.
    expect(out.etatReconstruitALaDate.payee.valeur).toBe("Hikma");
    expect(out.etatReconstruitALaDate.payee.source).toMatch(/après la date/);

    // Le « avant / maintenant » : ce qui a changé depuis, et l'état actuel en face.
    expect(out.changementsDepuisCetteDate.total).toBe(2);
    expect(JSON.stringify(out.changementsDepuisCetteDate.premiers)).toContain("Bon à payer");
    expect(out.etatActuel.statut).toBe("SUBMITTED"); // la ligne en base n'a jamais bougé
    expect(out.evenementsDejaSurvenus.total).toBe(2);
    expect(out.garantie).toMatch(/LECTURE SEULE/);
    expect(out.lien).toBe(`/validations/paiements/${payId}`);

    // STRICTEMENT LECTURE SEULE : ni le journal ni le dossier n'ont bougé.
    expect(await prisma.auditLog.count({ where: { entityId: payId } })).toBe(before);
    const row = await prisma.paymentRequest.findUnique({ where: { id: payId }, select: { status: true, payee: true } });
    expect(row).toEqual({ status: "SUBMITTED", payee: "Hikma Pharma" });
  });

  it("un dossier créé APRÈS la date cible : « n'existait pas encore », jamais un état inventé", async () => {
    const out = JSON.parse(await tool.run({ reference: REF, date: "2020-01-01" }, exec(ceoId)));
    expect(out.reponse).toMatch(/n'existait pas encore/);
    expect(out.etatReconstruitALaDate).toBeUndefined();
  });

  it("une référence inconnue reçoit un refus honnête, pas une reconstruction vide", async () => {
    const out = await tool.run({ reference: `${TAG}-fantome-zz`, date: "2026-06-01" }, exec(ceoId));
    expect(out).toMatch(/Aucun dossier/);
  });
});
