import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__blocktest__";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN BLOCAGE EXPLICITE PRIME SUR TOUT ACCÈS IMPLICITE.
 *
 * ── LE DÉFAUT QU'ON CORRIGE ──────────────────────────────────────────────────────────────────
 *
 * `getAccess` pose des accès IMPLICITES : tenir les RH ouvre le Recrutement et la lecture du
 * bureau du secrétariat, diriger un département ouvre le Recrutement, avoir une validation en
 * attente ouvre le module visé, se voir partager une enveloppe ouvre les Budgets… Aucun ne
 * consultait `blockedModules`.
 *
 * Conséquence, rapportée telle quelle : un administrateur RETIRE un module à quelqu'un dans la
 * console, et le module revient au rafraîchissement suivant. Sans message, sans trace — la règle
 * implicite le rendait, en silence, à chaque requête. On finit par croire que la console ne
 * marche pas, et l'on cesse de s'en servir.
 *
 * Le commentaire de `blockedModules` promettait pourtant l'inverse depuis toujours : « un blocage
 * qui se lèverait tout seul serait pire qu'inutile : il serait imprévisible. »
 *
 * ── POURQUOI CE FICHIER NE PARLE PLUS DES MOYENS GÉNÉRAUX ───────────────────────────────────
 *
 * Le cas d'origine était « qui tient les RH reçoit les Moyens généraux ». Cette règle-là a été
 * SUPPRIMÉE : le module ne s'accorde plus que par la matrice du rôle ou nommément depuis la
 * console (`rbac-console-authority.test.ts` le tient dans les deux sens). Il fallait donc changer
 * de sujet — pas de propriété : on éprouve la même invariance sur le RECRUTEMENT, qui part du
 * MÊME déclencheur (`rhCanUpdate`) et reste, lui, un accès implicite.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("un module BLOQUÉ ne revient pas par une règle implicite", () => {
  let userId = "";

  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG}rh`, email: `${TAG}rh@t.dz`, role: "VIEWER", passwordHash: "x" },
    });
    userId = u.id;
    // On lui donne les RH en MODIFICATION : c'est cette règle-là qui ouvre implicitement le
    // Recrutement (« qui tient les RH instruit tout »).
    await prisma.userAccess.create({
      data: { userId, module: "RH", canView: true, canUpdate: true, scope: "ALL" },
    });
  });

  afterAll(async () => {
    await prisma.userAccess.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("sans blocage, la règle implicite ouvre bien le Recrutement", async () => {
    const access = await getAccess(userId, "VIEWER");
    expect(access.modules.has("RECRUITMENT")).toBe(true);
  });

  it("LES MOYENS GÉNÉRAUX, EUX, NE S'OUVRENT PLUS DU TOUT PAR LES RH", async () => {
    // La porte dérobée est fermée : la console affichait « Aucun accès » sur cette ligne, et la
    // personne avait le module. Le test le vérifie ICI aussi, parce que c'est ce fichier qu'on
    // relira le jour où quelqu'un voudra « remettre la règle qui rendait service ».
    const access = await getAccess(userId, "VIEWER");
    expect(access.modules.has("GENERAL_MEANS")).toBe(false);
  });

  it("AVEC un blocage posé dans la console, le module NE revient PAS", async () => {
    await prisma.userAccess.create({
      data: { userId, module: "RECRUITMENT", canView: false },
    });
    const access = await getAccess(userId, "VIEWER");
    expect(access.modules.has("RECRUITMENT")).toBe(false);
    // …et le reste de ses droits n'a pas bougé : bloquer un module n'en ferme pas un autre.
    expect(access.modules.has("RH")).toBe(true);
  });
});

/**
 * LE GARDE EST-IL LE SEUL CHEMIN ?
 *
 * Le test ci-dessus prouve que la règle du Recrutement respecte les blocages. Il ne prouve
 * rien des AUTRES accès implicites — ni de celui qu'on ajoutera le mois prochain, qui est
 * précisément celui qui rouvrira le trou.
 *
 * On vérifie donc la propriété STRUCTURELLE : après la déclaration de `grantImplicit`, plus aucun
 * `modules.set(` n'existe hors de la fonction elle-même. Ajouter un accès implicite par un chemin
 * parallèle fait échouer ce test, avec la ligne fautive sous les yeux.
 */
describe("aucun accès implicite ne contourne le garde", () => {
  it("plus aucun `modules.set` hors de `grantImplicit`", () => {
    // `rbac.ts` est découpé (lot V4) : `grantImplicit` vit dans `rbac/acces.ts`, et ce qui le suivait
    // dans l'ancien fichier (vérifications, portées) est relu à la suite — la propriété reste la même.
    const src = ["acces", "verifications", "portees"]
      .map((m) => fs.readFileSync(path.join(process.cwd(), `src/lib/rbac/${m}.ts`), "utf8"))
      .join("\n");
    const debut = src.indexOf("const grantImplicit =");
    expect(debut, "`grantImplicit` a disparu de rbac/acces.ts").toBeGreaterThan(0);

    const fautives = src
      .slice(debut)
      .split("\n")
      .map((l, i) => ({ n: i, texte: l }))
      .filter((l) => l.texte.includes("modules.set(") && !l.texte.includes("modules.set(module,"));

    expect(
      fautives.map((l) => l.texte.trim()),
      "Un accès implicite est posé hors du garde : il ignorera un blocage explicite de l'administrateur. Passez par `grantImplicit`.",
    ).toEqual([]);
  });
});
