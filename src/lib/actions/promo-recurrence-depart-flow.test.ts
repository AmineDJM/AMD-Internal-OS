import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { reprendreRecurrenceComptage } from "./promo-comptage-actions";
import { declencherComptagesRecurrents } from "@/lib/promo-stock-comptages";
import { faitsStockDe } from "@/lib/queries/promo-stock";
import { decouperActions, sansCommentaires } from "@/lib/actions/contrat";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__recdep__";
const JOUR = 86_400_000;

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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « UNE RÉCURRENCE DE COMPTAGE PEUT-ELLE PARTIR ? » — LE BATTEMENT ET LA REPRISE SE RENCONTRENT
 * (vague « restes 2 »).
 *
 * La règle était écrite deux fois : le battement (`declencherComptagesRecurrents`) suspend une récurrence
 * dont l'auteur a perdu le droit ; la reprise (`reprendreRecurrenceComptage`) refuse de reprendre une
 * récurrence que le battement suspendrait aussitôt. Ce banc les fait se rencontrer, cause par cause, sur
 * la MÊME récurrence : suspendue, on tente de la reprendre ; puis, rendue active et due, on laisse battre.
 * Une seule règle : la reprise refuse EXACTEMENT ce que le battement suspend, et le dit avec les mêmes
 * mots ; ce que la reprise accepte, le battement le fait partir. Par les VRAIS points d'entrée.
 *
 *   ops   Directeur des Opérations — équipe : sup → k1, sm        k2   délégué hors de toute équipe
 *   sm    dans l'équipe, SANS le module du stock                  ex   ancien directeur (rôle changé)
 *   solo  Directeur des Opérations SANS équipe                    parti  directeur désactivé
 *   sa    Super Admin — gère les récurrences dont l'auteur ne le peut plus
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Une récurrence de comptage — la reprise refuse ce que le battement suspend, avec les mêmes mots", () => {
  const ids: Record<string, string> = {};
  const recurrences: string[] = [];

  async function nettoyer() {
    const uids = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((u) => u.id);
    if (uids.length) {
      await prisma.promoStockComptage.deleteMany({ where: { OR: [{ holderId: { in: uids } }, { demandeurId: { in: uids } }] } });
      await prisma.promoStockComptageRecurrence.deleteMany({ where: { OR: [{ auteurId: { in: uids } }, { holderId: { in: uids } }] } });
      await prisma.notification.deleteMany({ where: { userId: { in: uids } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: uids } } }).catch(() => undefined);
    }
    await prisma.employee.updateMany({ where: { fullName: { startsWith: TAG } }, data: { managerId: null } });
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { id: { in: uids } } });
  }

  beforeAll(async () => {
    await nettoyer();
    const faire = (nom: string, role: string, isActive = true) =>
      prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, role: role as never, passwordHash: "x", isActive } });
    const [sa, ops, sup, k1, k2, sm, ex, solo, parti] = await Promise.all([
      faire("sa", "SUPER_ADMIN"), faire("ops", "OPERATIONS_DIRECTOR"), faire("sup", "NATIONAL_SALES"),
      faire("k1", "MEDICAL_DELEGATE"), faire("k2", "MEDICAL_DELEGATE"), faire("sm", "HEAD_OF_REGULATORY"),
      faire("ex", "NATIONAL_SALES"), faire("solo", "OPERATIONS_DIRECTOR"), faire("parti", "OPERATIONS_DIRECTOR", false),
    ]);
    Object.assign(ids, { sa: sa.id, ops: ops.id, sup: sup.id, k1: k1.id, k2: k2.id, sm: sm.id, ex: ex.id, solo: solo.id, parti: parti.id });
    const emp = (nom: string, userId: string, managerId: string | null = null) =>
      prisma.employee.create({ data: { fullName: `${TAG}${nom}`, userId, managerId }, select: { id: true } }).then((e) => e.id);
    const eOps = await emp("ops", ops.id);
    const eSup = await emp("sup", sup.id, eOps);
    await Promise.all([emp("k1", k1.id, eSup), emp("sm", sm.id, eSup), emp("k2", k2.id), emp("solo", solo.id), emp("ex", ex.id)]);
  });

  afterAll(async () => { await nettoyer(); });

  /** Une récurrence SUSPENDUE, telle que le battement la laisse — c'est elle qu'on tente de reprendre. */
  async function suspendue(data: { cible: "PERSONNE" | "EQUIPE" | "MAGASIN"; holderId: string | null; auteur: string }): Promise<string> {
    const r = await prisma.promoStockComptageRecurrence.create({
      data: {
        cible: data.cible, holderId: data.holderId, frequence: "MENSUEL", famille: "CONSOMMABLE",
        ancreLe: new Date(Date.now() - 40 * JOUR), prochaineLe: new Date(Date.now() - JOUR),
        auteurId: ids[data.auteur]!, actif: false, pauseLe: new Date(), pauseMotif: "Suspendue pour le banc.",
      },
      select: { id: true },
    });
    recurrences.push(r.id);
    return r.id;
  }

  /** LA RENCONTRE : la reprise tentée par `gerant`, puis — rendue active et due — le battement. */
  async function rencontre(id: string, gerant: string) {
    ACTOR = await actorFor(ids[gerant]!);
    const reprise = await reprendreRecurrenceComptage(form({ recurrenceId: id }));
    await prisma.promoStockComptageRecurrence.update({
      where: { id },
      data: { actif: true, pauseLe: null, pauseMotif: null, prochaineLe: new Date(Date.now() - JOUR) },
    });
    const bilan = await declencherComptagesRecurrents(new Date(), { seulement: [id] });
    const apres = await prisma.promoStockComptageRecurrence.findUniqueOrThrow({ where: { id }, select: { actif: true, pauseMotif: true } });
    return { reprise, bilan, apres };
  }

  it("PRÉMISSES : k1 et sm dans l'équipe d'ops, k2 hors de toute équipe ; sm sans le stock ; ex n'est plus directeur ; solo sans équipe ; parti désactivé", async () => {
    const fOps = (await faitsStockDe(ids.ops!))!;
    expect(fOps.directeurDesOperations && fOps.module.modifier, "ops demande des comptages").toBe(true);
    expect([...fOps.equipe].sort()).toEqual([ids.k1!, ids.sm!, ids.sup!].sort());
    expect(userCan(await actorFor(ids.sm!), "PROMO_STOCK", "VIEW"), "sm n'a PAS le module du stock").toBe(false);
    expect(userCan(await actorFor(ids.k1!), "PROMO_STOCK", "VIEW"), "k1 a le module du stock").toBe(true);
    expect((await faitsStockDe(ids.ex!))!.directeurDesOperations).toBe(false);
    expect((await faitsStockDe(ids.solo!))!.equipe.size).toBe(0);
    expect(await faitsStockDe(ids.parti!), "un compte désactivé n'a plus d'autorité").toBeNull();
  });

  const CAUSES: { cas: string; cible: "PERSONNE" | "EQUIPE" | "MAGASIN"; holder: string | null; auteur: string; gerant: string; motif: RegExp }[] = [
    { cas: "son auteur est parti", cible: "PERSONNE", holder: "k1", auteur: "parti", gerant: "sa", motif: /^Son auteur n'existe plus ou n'est plus actif/ },
    { cas: "la personne a quitté l'équipe de l'auteur", cible: "PERSONNE", holder: "k2", auteur: "ops", gerant: "ops", motif: /^__recdep__k2 n'est plus dans les équipes de son auteur/ },
    { cas: "la personne n'a plus le stock", cible: "PERSONNE", holder: "sm", auteur: "ops", gerant: "ops", motif: /^__recdep__sm n'a pas accès au stock promotionnel/ },
    { cas: "la personne n'est plus désignée", cible: "PERSONNE", holder: null, auteur: "ops", gerant: "ops", motif: /^La personne qui devait compter n'est plus désignée/ },
    { cas: "l'auteur n'est plus directeur — le magasin", cible: "MAGASIN", holder: null, auteur: "ex", gerant: "sa", motif: /^Son auteur ne peut plus faire compter le magasin/ },
    { cas: "l'auteur n'a plus d'équipe — « toute mon équipe »", cible: "EQUIPE", holder: null, auteur: "solo", gerant: "sa", motif: /^Son auteur ne gère plus le matériel d'une équipe/ },
  ];

  // Une boucle et non `it.each` : le nom de chaque cas reste lisible tel quel (`it.each` cite et tronque `$cas`).
  for (const { cas, cible, holder, auteur, gerant, motif } of CAUSES) it(`${cas} : la reprise refuse, le battement suspend — et c'est la même phrase`, async () => {
    const id = await suspendue({ cible, holderId: holder ? ids[holder]! : null, auteur });
    const { reprise, bilan, apres } = await rencontre(id, gerant);
    expect(reprise.ok, "la reprise d'une récurrence que le battement suspendrait aussitôt").toBe(false);
    expect(bilan).toMatchObject({ suspendues: 1, comptagesCrees: 0 });
    expect(apres.actif, "en PAUSE, jamais supprimée").toBe(false);
    expect(apres.pauseMotif ?? "").toMatch(motif);
    // LA RENCONTRE : la reprise dit POURQUOI avec les mots exacts de la pause, puis ce qu'il reste à faire.
    expect(reprise.error ?? "", "la reprise et le battement ne disent pas la même chose").toContain(apres.pauseMotif!);
    expect((reprise.error ?? "").length, "le refus nomme aussi le remède").toBeGreaterThan(apres.pauseMotif!.length);
  });

  it("TÉMOIN : rien n'a changé — la reprise accepte, et le battement fait partir le comptage au lieu de suspendre", async () => {
    const id = await suspendue({ cible: "PERSONNE", holderId: ids.k1!, auteur: "ops" });
    const { reprise, bilan, apres } = await rencontre(id, "ops");
    expect(reprise.ok, reprise.error).toBe(true);
    expect(bilan).toMatchObject({ suspendues: 0, comptagesCrees: 1 });
    expect(apres).toEqual({ actif: true, pauseMotif: null });
    expect(await prisma.promoStockComptage.findFirst({ where: { recurrenceId: id }, select: { holderId: true, demandeurId: true } }))
      .toEqual({ holderId: ids.k1, demandeurId: ids.ops });
  });

  it("RÈGLE DE POINT D'APPEL : le battement et la reprise lisent LA règle — ni l'un ni l'autre ne la recopie", () => {
    const racine = join(process.cwd(), "src/lib");
    const reprise = decouperActions("promo-comptage-actions.ts", readFileSync(join(racine, "actions/promo-comptage-actions.ts"), "utf8"))
      .find((a) => a.fonction === "reprendreRecurrenceComptage")!;
    const battementSrc = sansCommentaires(readFileSync(join(racine, "promo-stock-comptages.ts"), "utf8"));
    const debut = battementSrc.indexOf("export async function declencherComptagesRecurrents");
    const battement = battementSrc.slice(debut, battementSrc.indexOf("\nexport ", debut + 1));
    expect(debut, "le battement a changé de nom : ce cliquet ne lit plus rien").toBeGreaterThan(-1);
    for (const [nom, corps] of [["la reprise", sansCommentaires(reprise.corps)], ["le battement", battement]] as const) {
      expect(corps, `${nom} n'appelle pas la règle`).toMatch(/\bpeutDeclencherRecurrence\(r\)/);
      // Une copie de la règle se reconnaît à ses ingrédients : les prédicats de l'auteur et de la personne visée.
      expect(corps, `${nom} recopie la règle au lieu de la lire`).not.toMatch(/\b(?:peutDemanderComptage|peutDemanderAEquipe|peutRecevoirDuStock|faitsStockDe)\(/);
    }
  });
});
