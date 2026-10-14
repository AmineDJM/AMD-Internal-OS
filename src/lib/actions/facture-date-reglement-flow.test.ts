import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { userCan, type EffectiveAccess } from "@/lib/rbac";
import { updateLegalDocument } from "./legal-actions";
import { createInvoice, setInvoicePaid, updateInvoice } from "./invoice-actions";
import { REFUS_DATE_REGLEMENT_HORS_FINANCES, dateDeReglementAEcrire, peutDaterLeReglement } from "@/lib/finances/settlement";
import { legalFields } from "@/app/(app)/legal/legal-fields";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE FACTURE NE SE DÉCLARE PAS « PAYÉE » HORS DES FINANCES (audit Assistante de direction, 10/2026).
 *
 * Le défaut : avec Legal en écriture, poser une date de paiement sur une facture SANS ordre la déclarait réglée et
 * inscrivait le mouvement au livre — la facture sortait du circuit du centre de paiement sans que les Finances l'aient
 * vue. Par les VRAIES actions (le formulaire de Legal, les gestes du vocabulaire « facture »), avec une juriste qui
 * écrit dans Legal et rien d'autre, et une comptable qui règle (Finances, modifier — le droit de `settleExpenseOrder`).
 * Les accès sont construits À LA MAIN : ce qu'on vérifie est la porte, pas la matrice des rôles.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__datereglement__${Date.now()}`;

function avecModules(id: string, name: string, role: CurrentUser["role"], modules: [string, string[]][]): CurrentUser {
  const access = {
    modules: new Map(modules.map(([m, a]) => [m, { actions: new Set(a), scope: "ALL" }])),
    rowGrants: new Map(),
  } as unknown as EffectiveAccess;
  return { id, name, email: `${id}@t.dz`, role, secondaryRole: null, access, mustChangePassword: false } as CurrentUser;
}
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

suite("La date de règlement d'une facture appartient à qui règle aux Finances", () => {
  let JURISTE: CurrentUser, COMPTABLE: CurrentUser;
  let factureId = "";
  const facture = () => prisma.legalDocument.findUniqueOrThrow({ where: { id: factureId }, select: { paidDate: true, settlementTxId: true, title: true } });

  beforeAll(async () => {
    const [j, c] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}juriste`, email: `${TAG}juriste@t.dz`, role: "COORDINATOR", passwordHash: "x" }, select: { id: true } }),
      prisma.user.create({ data: { name: `${TAG}compta`, email: `${TAG}compta@t.dz`, role: "FINANCE_BUDGET_MANAGER", passwordHash: "x" }, select: { id: true } }),
    ]);
    JURISTE = avecModules(j.id, `${TAG}juriste`, "COORDINATOR", [["LEGAL", ["VIEW", "CREATE", "UPDATE"]]]);
    COMPTABLE = avecModules(c.id, `${TAG}compta`, "FINANCE_BUDGET_MANAGER", [["FINANCES", ["VIEW", "CREATE", "UPDATE"]], ["LEGAL", ["VIEW"]]]);
  });

  afterAll(async () => {
    const docs = await prisma.legalDocument.findMany({ where: { title: { startsWith: TAG } }, select: { id: true, settlementTxId: true } }).catch(() => []);
    await prisma.legalDocument.updateMany({ where: { id: { in: docs.map((d) => d.id) } }, data: { settlementTxId: null } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { id: { in: docs.map((d) => d.settlementTxId).filter((v): v is string => Boolean(v)) } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [JURISTE?.id, COMPTABLE?.id].filter(Boolean) as string[] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    ACTOR = null;
  });

  it("PRÉMISSES : la juriste écrit dans Legal sans régler aux Finances ; la comptable règle", () => {
    expect(userCan(JURISTE, "LEGAL", "UPDATE")).toBe(true);
    expect(userCan(JURISTE, "FINANCES", "UPDATE")).toBe(false);
    expect(userCan(COMPTABLE, "FINANCES", "UPDATE")).toBe(true);
  });

  it("CRÉER une facture « déjà réglée » hors Finances : refusée, et rien n'est écrit — sans date, elle s'enregistre", async () => {
    ACTOR = JURISTE;
    const refus = await createInvoice(undefined, fd({ title: `${TAG} facture refusée`, counterparty: `${TAG} Imprimerie`, amount: "45000", paidDate: "2026-10-01" }));
    expect(refus.ok === false && refus.error).toBe(REFUS_DATE_REGLEMENT_HORS_FINANCES);
    expect(await prisma.legalDocument.count({ where: { title: `${TAG} facture refusée` } })).toBe(0);

    const r = await createInvoice(undefined, fd({ title: `${TAG} facture`, counterparty: `${TAG} Imprimerie`, amount: "45000" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    factureId = r.id!;
    expect(await facture()).toMatchObject({ paidDate: null, settlementTxId: null });
  });

  it("MARQUER RÉGLÉE depuis la ligne, hors Finances : refusé — aucune écriture au livre ; la comptable, elle, la marque", async () => {
    ACTOR = JURISTE;
    const refus = await setInvoicePaid({ id: factureId, paidDate: "2026-10-02T00:00:00.000Z" });
    expect(refus.ok === false && refus.error).toBe(REFUS_DATE_REGLEMENT_HORS_FINANCES);
    expect(await facture()).toMatchObject({ paidDate: null, settlementTxId: null });

    ACTOR = COMPTABLE;
    const ok = await setInvoicePaid({ id: factureId, paidDate: "2026-10-02T00:00:00.000Z" });
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    const apres = await facture();
    expect(apres.paidDate?.toISOString().slice(0, 10)).toBe("2026-10-02");
    expect(apres.settlementTxId, "marquer réglée écrit au livre").toBeTruthy();
  });

  it("MODIFIER la facture hors Finances : le champ absent garde la date (rien ne s'efface en silence) ; la changer ou l'effacer est refusé", async () => {
    ACTOR = JURISTE;
    // Le formulaire que l'écran lui montre ne porte pas la date : l'enregistrer ne la retire pas.
    const sansChamp = await updateInvoice(fd({ id: factureId, title: `${TAG} facture corrigée`, counterparty: `${TAG} Imprimerie`, amount: "45000" }));
    expect(sansChamp.ok, sansChamp.ok ? "" : sansChamp.error).toBe(true);
    const lue = await facture();
    expect([lue.title, lue.paidDate?.toISOString().slice(0, 10), Boolean(lue.settlementTxId)]).toEqual([`${TAG} facture corrigée`, "2026-10-02", true]);

    // Le formulaire ordinaire de Legal, même chose.
    const legal = await updateLegalDocument(fd({ id: factureId, title: `${TAG} facture corrigée 2`, kind: "INVOICE", amount: "45000", direction: "OUT" }));
    expect(legal.ok, legal.ok ? "" : legal.error).toBe(true);
    expect((await facture()).paidDate?.toISOString().slice(0, 10)).toBe("2026-10-02");

    // Renvoyer la MÊME date est permis ; la changer, ou l'effacer, ne l'est pas.
    const meme = await updateLegalDocument(fd({ id: factureId, title: `${TAG} facture corrigée 3`, kind: "INVOICE", amount: "45000", direction: "OUT", paidDate: "2026-10-02" }));
    expect(meme.ok, meme.ok ? "" : meme.error).toBe(true);
    for (const paidDate of ["2026-10-05", ""]) {
      const r = await updateLegalDocument(fd({ id: factureId, title: `${TAG} facture corrigée 3`, kind: "INVOICE", amount: "45000", direction: "OUT", paidDate }));
      expect(r.ok === false && r.error, `date « ${paidDate} »`).toBe(REFUS_DATE_REGLEMENT_HORS_FINANCES);
    }
    const demarquer = await setInvoicePaid({ id: factureId, paidDate: null });
    expect(demarquer.ok === false && demarquer.error).toBe(REFUS_DATE_REGLEMENT_HORS_FINANCES);
    expect(await facture()).toMatchObject({ settlementTxId: expect.any(String) });
  });

  it("L'ÉCRAN lit la même règle : le champ « date de règlement » n'est proposé qu'à qui règle", () => {
    const noms = (dater: boolean) => legalFields({ kind: "INVOICE" }, "edit", [], [], [], false, { options: [], canCreate: false }, false, dater)
      .map((c) => ("name" in c ? c.name : null));
    expect(noms(peutDaterLeReglement({ financesModifier: true }))).toContain("paidDate");
    expect(noms(peutDaterLeReglement({ financesModifier: false }))).not.toContain("paidDate");
    // Et la règle pure, de bout en bout.
    expect(dateDeReglementAEcrire({ avant: null, demandee: null, champEnvoye: false, financesModifier: false })).toEqual({ ok: true, paidDate: null });
  });
});
