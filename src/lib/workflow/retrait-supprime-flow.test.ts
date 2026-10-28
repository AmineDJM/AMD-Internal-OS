import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import type { UserRole } from "@prisma/client";
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { peutSupprimerUneDemandeAdPro } from "@/lib/queries/ad-pro-suppression";
import { getAdProRequests } from "@/lib/queries/ad-pro";
import { ensureInstance } from "@/lib/workflow/engine";
import { retirerDemandeAdPro } from "@/lib/actions/workflow-actions";
import { cancelCongressRequest } from "@/lib/actions/congress-request-actions";
import { supprimerDemandeAdPro, restoreDeletedRecord } from "@/lib/actions/admin-delete-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « QUAND JE RETIRE UNE DEMANDE AD&PRO, ELLE DOIT ÊTRE TOTALEMENT SUPPRIMÉE — ÉVIDEMMENT TOUJOURS
 * RÉCUPÉRABLE DEPUIS LA CORBEILLE PAR LE SUPER ADMIN » (Direction, 05/10).
 *
 * Le retrait (§118.186) fermait le circuit et laissait la demande « annulée » : visible dans les listes,
 * avec ses postes et ses pièces. Il passe désormais par le cœur RÉVERSIBLE (§118.162) — la même cible que
 * la suppression du Super Admin : une transaction, une entrée de corbeille, la demande et ses branches
 * (circuit, postes, pièces, ordres non réglés) partent ensemble et reviennent ensemble.
 *
 * Ce que le banc tient, par les vrais points d'entrée et des acteurs SANS vue globale (§118.104) :
 *   • retirer = la demande a disparu des listes, de la porte par enregistrement, du circuit ;
 *   • la corbeille la rend INTACTE (même identifiant, même référence, postes et circuit compris) ;
 *   • les refus restent — l'argent parti, un poste qui engage la dépense, le motif, la porte du retrait —
 *     et un refus ne laisse RIEN de fermé : le circuit n'est pas touché quand le lot refuse ;
 *   • retirer sa propre demande n'est pas le pouvoir de supprimer celle d'un autre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `__retrait${Date.now()}__`;
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const ids: Record<string, string> = {};
const roles: Record<string, UserRole> = {};
async function comme(qui: string): Promise<CurrentUser> {
  const id = ids[qui]!;
  const access = await getAccess(id, roles[qui] as SessionUser["role"]);
  ACTOR = { id, name: `${TAG}${qui}`, email: `${TAG}${qui}@t.dz`, role: roles[qui] as SessionUser["role"], secondaryRole: null, access, mustChangePassword: false } as CurrentUser;
  return ACTOR;
}
const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};

let n = 0;
async function nouveauSponsoring(nom: string) {
  n += 1;
  const spo = await prisma.sponsoringRequest.create({
    data: { reference: `${TAG}SPO${n}`, institution: `${TAG}${nom}`, type: "Congrès", requesterId: ids.kam!, status: "AWAITING_PRELIMINARY", amountRequested: 100_000 },
  });
  await ensureInstance("SPONSORING", spo.id);
  return spo;
}
const circuit = (entityType: "SPONSORING" | "EVENT" | "CONGRESS_INTERNATIONAL", entityId: string) =>
  prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType, entityId } } });
const dansLaListe = async (qui: string, id: string) => (await getAdProRequests(await comme(qui))).some((d) => d.id === id);
const retirer = (entityType: string, entityId: string, motif = "Plus d'actualité") => retirerDemandeAdPro(fd({ entityType, entityId, motif }));

suite("Retirer une demande Ad & Pro la SUPPRIME — par le cœur réversible, récupérable par le Super Admin", () => {
  beforeAll(async () => {
    const quiQuoi: [string, UserRole][] = [["kam", "MEDICAL_DELEGATE"], ["autre", "MEDICAL_DELEGATE"], ["dir", "DIRECTION"], ["sa", "SUPER_ADMIN"]];
    for (const [nom, role] of quiQuoi) {
      const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, role, passwordHash: "x" } });
      ids[nom] = u.id; roles[nom] = role;
    }
  });

  afterAll(async () => {
    const spos = await prisma.sponsoringRequest.findMany({ where: { institution: { startsWith: TAG } }, select: { id: true } });
    const entites = spos.map((x) => x.id);
    await prisma.deletedRecord.deleteMany({ where: { name: { contains: TAG } } }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: { in: entites } } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: entites } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { sponsoringId: { in: entites } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { institution: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: Object.values(ids) } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("PRÉMISSES — personne n'a la vue globale sauf la Direction et le Super Admin ; l'auteur ne SUPPRIME pas sa demande, il la RETIRE", async () => {
    expect(hasGlobalView(await comme("kam")), "le KAM n'a pas la vue globale").toBe(false);
    expect(hasGlobalView(await comme("autre"))).toBe(false);
    const spo = await nouveauSponsoring("Prémisse");
    expect(await peutSupprimerUneDemandeAdPro(await comme("kam"), "SPONSORING", spo.id), "le droit de SUPPRIMER est celui d'un autre : jamais l'auteur").toBe(false);
    expect(await dansLaListe("kam", spo.id)).toBe(true);
  });

  it("RETIRER SUPPRIME : la demande, son circuit et ses postes partent, elle quitte les listes et la porte — et le motif est au journal", async () => {
    const spo = await nouveauSponsoring("À retirer");
    const poste = await prisma.adProItem.create({ data: { sponsoringId: spo.id, label: `${TAG}Poste`, kind: "OTHER", amountEstimated: 50_000 } });
    expect(await circuit("SPONSORING", spo.id), "PRÉMISSE : le circuit existe").not.toBeNull();
    await comme("kam");
    const r = await retirer("SPONSORING", spo.id, "Congrès reporté");
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.ok ? r.redirect : "", "l'écran quitte la fiche supprimée").toBe("/sponsoring");
    expect(r.ok ? r.message : "").toMatch(/corbeille/);
    expect(await prisma.sponsoringRequest.count({ where: { id: spo.id } }), "la demande est supprimée").toBe(0);
    expect(await circuit("SPONSORING", spo.id), "le circuit part avec elle").toBeNull();
    expect(await prisma.adProItem.count({ where: { id: poste.id } }), "ses postes aussi").toBe(0);
    expect(await dansLaListe("kam", spo.id), "plus dans le tableau Ad & Pro").toBe(false);
    expect(await canAccessEntity(await comme("kam"), "SPONSORING", spo.id, "VIEW"), "ni ouvrable par son identifiant").toBe(false);
    const corbeille = await prisma.deletedRecord.findFirst({ where: { kind: "SPONSORING", sourceId: spo.id } });
    expect(corbeille, "elle est à la corbeille").not.toBeNull();
    expect(corbeille?.deletedById).toBe(ids.kam);
    expect(corbeille?.lot, "avec ses branches").not.toBeNull();
    const trace = await prisma.auditLog.findFirst({ where: { entityId: spo.id, action: "DELETE" } });
    expect(trace?.summary, "le journal porte le motif et le fait que la corbeille la rend").toMatch(/Congrès reporté[\s\S]*restaurable depuis la corbeille/);
  }, 60_000);

  it("LA CORBEILLE LA RENDRA INTACTE : mêmes identifiant et référence, postes et circuit compris — et elle revient dans les listes", async () => {
    const spo = await nouveauSponsoring("À restaurer");
    const poste = await prisma.adProItem.create({ data: { sponsoringId: spo.id, label: `${TAG}Poste restauré`, kind: "OTHER", amountEstimated: 70_000 } });
    const avant = await circuit("SPONSORING", spo.id);
    await comme("kam");
    expect((await retirer("SPONSORING", spo.id)).ok).toBe(true);
    const entree = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "SPONSORING", sourceId: spo.id } });

    // Le KAM ne rend rien depuis la corbeille : c'est le Super Admin, et lui seul.
    await comme("kam");
    expect((await restoreDeletedRecord(fd({ id: entree.id }))).ok, "un KAM ne restaure pas").toBe(false);
    await comme("sa");
    const r = await restoreDeletedRecord(fd({ id: entree.id }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const revenue = await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spo.id } });
    expect(revenue.reference).toBe(spo.reference);
    expect(revenue.requesterId, "la même demandeuse").toBe(ids.kam);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: poste.id } })).label, "le poste est revenu").toBe(`${TAG}Poste restauré`);
    const apres = await circuit("SPONSORING", spo.id);
    expect(apres, "le circuit est revenu").not.toBeNull();
    expect(apres?.currentSlug).toBe(avant?.currentSlug);
    expect(apres?.status, "il reprend là où il en était : en cours, pas « annulé »").toBe("IN_PROGRESS");
    expect(await dansLaListe("kam", spo.id), "elle est de nouveau dans le tableau").toBe(true);
    expect((await prisma.deletedRecord.findUniqueOrThrow({ where: { id: entree.id } })).restoredAt).not.toBeNull();
  }, 60_000);

  it("LES REFUS RESTENT, et un refus ne ferme RIEN : sans motif, par un collègue, par un autre module, argent parti, poste qui engage la dépense", async () => {
    const spo = await nouveauSponsoring("À refuser");
    const intact = async (raison: string) => {
      expect(await prisma.sponsoringRequest.count({ where: { id: spo.id } }), `${raison} : la demande est toujours là`).toBe(1);
      expect((await circuit("SPONSORING", spo.id))?.status, `${raison} : le circuit n'est pas fermé`).toBe("IN_PROGRESS");
      expect(await prisma.deletedRecord.count({ where: { kind: "SPONSORING", sourceId: spo.id } }), `${raison} : rien à la corbeille`).toBe(0);
    };
    await comme("kam");
    const sansMotif = await retirerDemandeAdPro(fd({ entityType: "SPONSORING", entityId: spo.id }));
    expect(sansMotif.ok).toBe(false);
    await intact("sans motif");

    await comme("autre");
    const collegue = await retirer("SPONSORING", spo.id, "pas à moi");
    expect(collegue.ok).toBe(false);
    await intact("un collègue");

    // Un poste qui ENGAGE la dépense (BC demandé) : le retrait nomme le remède et ne touche à rien.
    const engage = await prisma.adProItem.create({ data: { sponsoringId: spo.id, label: `${TAG}Engagé`, kind: "OTHER", orderStage: "REQUESTED" } });
    await comme("kam");
    const refus = await retirer("SPONSORING", spo.id);
    expect(refus.ok ? "" : refus.error).toMatch(/engagent déjà la dépense/);
    await intact("un poste engagé");
    await prisma.adProItem.update({ where: { id: engage.id }, data: { orderStage: "NONE" } });

    // L'ARGENT PARTI : un ordre RÉGLÉ de cette demande. Le cœur refuse en nommant ce qui l'y oblige.
    const regle = await prisma.expenseOrder.create({
      data: { reference: `${TAG}OD`, label: `${TAG}Ordre réglé`, amount: 10_000, status: "PAID", paidDate: new Date(), sourceType: "SPONSORING", sourceId: spo.id, requestedById: ids.kam! },
    });
    const parti = await retirer("SPONSORING", spo.id);
    expect(parti.ok, "l'argent est parti : la demande en est la justification").toBe(false);
    expect(parti.ok ? "" : parti.error, "le refus nomme ce qui l'y oblige").toMatch(/r[ée]gl|pay|argent|ordre/i);
    await intact("l'argent est parti");

    // Le TÉMOIN : l'ordre disparu, le même retrait passe — sans lui, un refus de principe passerait pour juste.
    await prisma.expenseOrder.delete({ where: { id: regle.id } });
    const ok = await retirer("SPONSORING", spo.id);
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    expect(await prisma.sponsoringRequest.count({ where: { id: spo.id } })).toBe(0);
  }, 60_000);

  it("UNE DEMANDE DÉJÀ TRANCHÉE ne se retire plus : le circuit clos refuse, rien n'est supprimé — et le témoin la retire tant qu'elle est en cours", async () => {
    const spo = await nouveauSponsoring("Déjà tranchée");
    await prisma.workflowInstance.update({ where: { entityType_entityId: { entityType: "SPONSORING", entityId: spo.id } }, data: { status: "APPROVED" } });
    await comme("kam");
    const r = await retirer("SPONSORING", spo.id);
    expect(r.ok ? "" : r.error).toMatch(/déjà tranchée ou close/);
    expect(await prisma.sponsoringRequest.count({ where: { id: spo.id } }), "rien n'est supprimé").toBe(1);
    await prisma.workflowInstance.update({ where: { entityType_entityId: { entityType: "SPONSORING", entityId: spo.id } }, data: { status: "IN_PROGRESS" } });
    expect((await retirer("SPONSORING", spo.id)).ok, "le témoin : en cours, elle se retire").toBe(true);
  }, 60_000);

  it("LA DIRECTION retire la demande d'un collègue (qui tranche le module) ; la suppression du Super Admin vise la même cible", async () => {
    const a = await nouveauSponsoring("Retirée par la Direction");
    await comme("dir");
    const r = await retirer("SPONSORING", a.id, "Doublon");
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(await prisma.deletedRecord.count({ where: { kind: "SPONSORING", sourceId: a.id } })).toBe(1);

    const b = await nouveauSponsoring("Supprimée par le Super Admin");
    await comme("sa");
    const s = await supprimerDemandeAdPro(fd({ kind: "SPONSORING", id: b.id }));
    expect(s.ok, s.ok ? "" : s.error).toBe(true);
    // MÊME ENTRÉE DE CORBEILLE, même type, même forme de lot : un seul destin pour une demande retirée ou supprimée.
    const ea = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "SPONSORING", sourceId: a.id } });
    const eb = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "SPONSORING", sourceId: b.id } });
    expect(ea.kind).toBe(eb.kind);
    expect(Object.keys((ea.lot ?? {}) as object).sort()).toEqual(Object.keys((eb.lot ?? {}) as object).sort());
  }, 60_000);

  it("ANNULER UN CONGRÈS / ÉVÉNEMENT délègue au retrait : même issue (suppression), même refus sans motif", async () => {
    const e = await prisma.event.create({ data: { name: `${TAG}Événement`, createdById: ids.kam!, requesterId: ids.kam!, requestStatus: "AWAITING_PRELIMINARY", estimatedBudget: 100_000 } });
    await ensureInstance("EVENT", e.id);
    await comme("kam");
    const sans = await cancelCongressRequest(fd({ type: "EVENT", id: e.id }));
    expect(sans.ok, "sans motif").toBe(false);
    expect(await prisma.event.count({ where: { id: e.id } })).toBe(1);
    const r = await cancelCongressRequest(fd({ type: "EVENT", id: e.id, motif: "Annulé" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(await prisma.event.count({ where: { id: e.id } }), "supprimé").toBe(0);
    expect(await prisma.deletedRecord.count({ where: { kind: "EVENT", sourceId: e.id } }), "à la corbeille").toBe(1);
    await prisma.deletedRecord.deleteMany({ where: { kind: "EVENT", sourceId: e.id } });
  }, 60_000);

  // ── LES POINTS D'APPEL (§118.49) ────────────────────────────────────────────────────────────

  it("CLIQUET — le retrait SUPPRIME par le cœur réversible : l'action passe `supprimerReversible` au moteur, qui l'appelle APRÈS tous ses refus", () => {
    const sansCommentaires = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const action = sansCommentaires(readFileSync("src/lib/actions/workflow-actions.ts", "utf8"));
    const corpsAction = action.slice(action.indexOf("export async function retirerDemandeAdPro"), action.indexOf("async function demandeurDe"));
    expect(corpsAction, "l'action donne au moteur la suppression réversible").toMatch(/supprimer: \(nom\) => supprimerReversible\(/);
    const moteur = sansCommentaires(readFileSync("src/lib/workflow/engine.ts", "utf8"));
    const corps = moteur.slice(moteur.indexOf("export async function retirerDemande"), moteur.indexOf("\n}\n", moteur.indexOf("export async function retirerDemande")));
    const iAppel = corps.indexOf("input.supprimer(");
    expect(iAppel, "le moteur appelle la suppression").toBeGreaterThan(-1);
    for (const refus of ["REFUS_RETRAIT", "engagent déjà la dépense", "ne peut plus être retirée", "motif"]) {
      const i = corps.indexOf(refus);
      if (i === -1) continue;
      expect(i, `« ${refus} » est jugé AVANT la suppression : un refus ne laisse rien de fermé`).toBeLessThan(iAppel);
    }
    // L'ÉCRAN (composant client, aucun banc ne le rend) : il quitte la fiche supprimée, et le dit avant le clic.
    const panneau = readFileSync("src/components/workflow/workflow-panel.tsx", "utf8");
    expect(sansCommentaires(panneau), "après le retrait, l'écran va où l'action le dit").toMatch(/router\.push\(r\.redirect \?\? "\/ad-pro"\)/);
    expect(panneau, "la confirmation dit que la demande sera SUPPRIMÉE et récupérable").toMatch(/SUPPRIMÉE[\s\S]{0,200}corbeille/);
    // ADAM (en pause, mais une phrase fausse qu'un modèle lit se corrige) : la carte et le catalogue disent « supprimée ».
    const carte = readFileSync("src/lib/assistant/ops/impl/vague5/ad-pro.ts", "utf8");
    expect(carte, "la carte du retrait annonce la suppression").toMatch(/Retirer SUPPRIME la demande/);
    expect(readFileSync("src/lib/assistant/ops/catalogue/ad-pro.ts", "utf8"), "le catalogue dit « retire » et « supprimée »").toMatch(/Retire une demande de congrès \/ événement NON encore validée : elle est SUPPRIMÉE/);
    const adpro = sansCommentaires(readFileSync("src/lib/actions/admin-delete-actions.ts", "utf8"));
    expect(adpro, "la suppression du Super Admin revalide le tableau et Mon espace").toMatch(/revalidatePath\("\/ad-pro"\)[\s\S]{0,80}revalidatePath\("\/mon-espace"\)/);
  });
});
