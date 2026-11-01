import { expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { executerHorsRequete, personneDuGeste } from "@/lib/contexte-geste";
import type { CurrentUser } from "@/lib/session";
import { annulerGeste } from "@/lib/effets/annulation";
import { retablirGeste } from "@/lib/effets/retablissement";
import type { CompteRenduAnnulation } from "@/lib/effets/annulation";

/**
 * LE BANC « EXÉCUTER PUIS ANNULER » DES ACTIONS DÉCLARÉES RÉVERSIBLES (lot K10, décision 0040) — tests seulement.
 *
 * `cycle` joue l'action de l'ÉCRAN (la vraie fonction, sous la personne, hors requête), retrouve son geste au journal,
 * l'ANNULE et vérifie que l'état relu est celui d'avant, puis le RÉTABLIT et vérifie qu'il est celui d'après — enfin
 * l'audit des deux gestes. Les actions couvertes sont comptées : le cliquet du périmètre les compare aux déclarations.
 */

/** UN CAS : une action déclarée réversible, jouée puis annulée. `jouer` appelle `cycle` (au moins une fois, pour `id`). */
export interface CasReversible {
  /** L'identifiant `fichier:fonction` déclaré dans `communications.ts`. */
  id: string;
  /** La phrase du test. */
  titre: string;
  jouer: (moi: CurrentUser, tag: string) => Promise<void>;
  /** Le ménage de ce que le cas a créé (lignes marquées du `tag`). */
  nettoyer?: (tag: string) => Promise<void>;
}

export const couvertes = new Set<string>();

export async function personneDeTest(tag: string, role = "SUPER_ADMIN"): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${tag}${role}`, email: `${tag}${role.toLowerCase()}@t.dz`, passwordHash: "x", role: role as never } });
  return (await personneDuGeste(u.id))!;
}

/** L'action telle que l'écran l'appelle — la personne rendue à `requireUser`. */
export const aLEcran = <T>(moi: CurrentUser, fn: () => Promise<T>): Promise<T> => executerHorsRequete(moi, "banc-k10", fn).then((r) => r.resultat);

export const fd = (o: Record<string, string | string[]>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
};

export interface Cycle<R> {
  /** L'identifiant `fichier:fonction` déclaré. */
  id: string;
  moi: CurrentUser;
  /** Joue l'action (à l'écran) — son retour est vérifié `ok`. */
  faire: () => Promise<R>;
  /** L'état observé (relu en base) — comparé avant / après / annulé / rétabli. */
  lire: () => Promise<unknown>;
  /** Le retour de l'action est-il un succès ? (défaut : `ok !== false`). */
  reussi?: (r: R) => boolean;
  /** L'issue attendue de l'annulation : complète (défaut) ou partielle assumée (compensation dite). */
  complet?: boolean;
  /** Le rétablissement est-il exigé à l'identique ? (défaut : oui). */
  retablir?: boolean;
}

export async function cycle<R>(c: Cycle<R>): Promise<{ compte: CompteRenduAnnulation; avant: unknown; apres: unknown; gesteId: string }> {
  const avant = await c.lire();
  const debut = new Date();
  const r = await aLEcran(c.moi, c.faire);
  const ok = c.reussi ? c.reussi(r) : (r as { ok?: boolean } | null)?.ok !== false;
  expect(ok, `${c.id} : ${JSON.stringify(r)}`).toBe(true);
  const apres = await c.lire();
  expect(apres, `${c.id} n'a rien changé`).not.toEqual(avant);
  const g = await prisma.assistantGesteJournal.findFirstOrThrow({ where: { principalId: c.moi.id, capaciteId: c.id, creeLe: { gte: debut } }, orderBy: { creeLe: "desc" } });
  expect(g.origine).toBe("ecran");
  const compte = await annulerGeste(g.id, c.moi);
  if ("refus" in compte) throw new Error(`${c.id} : ${compte.refus}`);
  if (c.complet !== false) {
    expect(compte.complet, `${c.id} : ${JSON.stringify(compte.details)}`).toBe(true);
    expect(await c.lire(), `${c.id} : l'annulation ne rend pas l'état d'avant`).toEqual(avant);
  }
  if (c.retablir !== false) {
    const re = await retablirGeste(g.id, c.moi);
    if ("refus" in re) throw new Error(`${c.id} : ${re.refus}`);
    expect(re.complet, `${c.id} rétablir : ${JSON.stringify(re.details)}`).toBe(true);
    expect(await c.lire(), `${c.id} : le rétablissement ne rend pas l'état d'après`).toEqual(apres);
    // Et le rétabli se ré-annule (une annulation est elle-même annulable, dans les deux sens).
    const encore = await annulerGeste(g.id, c.moi);
    if ("refus" in encore) throw new Error(`${c.id} : ${encore.refus}`);
    if (c.complet !== false) expect(await c.lire()).toEqual(avant);
  }
  expect(await prisma.auditLog.count({ where: { actorId: c.moi.id, entityId: g.id, module: "ASSISTANT_IA" } })).toBeGreaterThanOrEqual(c.retablir !== false ? 3 : 1);
  couvertes.add(c.id);
  return { compte, avant, apres, gesteId: g.id };
}

/** Le ménage : les gestes et l'audit de la personne de test. */
export async function nettoyer(ids: string[]): Promise<void> {
  await prisma.effetSortantDiffere.deleteMany({ where: { principalId: { in: ids } } }).catch(() => undefined);
  await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: ids } } }).catch(() => undefined);
}
