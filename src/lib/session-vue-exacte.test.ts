import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA « VUE EXACTE » EST UNE VUE, PAS UNE USURPATION (§118.184 — audit 360°, S8).
 *
 * Le bandeau promettait « vos actions seront enregistrées au nom de l'administrateur » ; chaque action
 * partait pourtant au nom de la personne visualisée — au journal et dans les notifications. Ce banc
 * joue la VRAIE fonction de session (`build`, par `requireUser` et `getCurrentUser`) avec une vraie
 * session de Super Admin et le cookie de la vue : une lecture voit comme la personne, une écriture
 * part au nom de l'administrateur. Et il exige que chaque route d'API qui écrit le DÉCLARE.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let SESSION: unknown = null;
let EN_TETES = new Headers();
let COOKIE: string | undefined;
vi.mock("@/auth", () => ({ auth: async () => SESSION }));
// Le stockage asynchrone de Next qui marque l'exécution du CORPS d'une action serveur : on y met le même
// `AsyncLocalStorage` que Next instancie (le sien n'existe qu'une fois le serveur démarré).
const { ACTION_STORE } = vi.hoisted(() => ({ ACTION_STORE: { current: null as null | { run: <T>(s: { isAction: boolean }, f: () => T) => T; getStore: () => unknown } } }));
vi.mock("next/dist/server/app-render/action-async-storage.external", async () => {
  const { AsyncLocalStorage: ALS } = await import("node:async_hooks");
  const store = new ALS<{ isAction: boolean }>();
  ACTION_STORE.current = store as never;
  return { actionAsyncStorage: store };
});
vi.mock("next/headers", () => ({
  cookies: () => ({ get: (n: string) => (n === "amd_impersonate" && COOKIE ? { value: COOKIE } : undefined) }),
  headers: () => EN_TETES,
}));

import { prisma } from "@/lib/prisma";
import { requireUser, getCurrentUser, getCurrentUserPourEcrire } from "@/lib/session";

const TAG = "__vuex__";
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

suite("Vue exacte — qui agit", () => {
  let admin = "", cible = "";
  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
    admin = (await prisma.user.create({ data: { name: `${TAG}Admin`, email: `${TAG}admin@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } })).id;
    cible = (await prisma.user.create({ data: { name: `${TAG}Cible`, email: `${TAG}cible@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } })).id;
    SESSION = { user: { id: admin, role: "SUPER_ADMIN", name: `${TAG}Admin`, email: `${TAG}admin@t.dz` } };
    COOKIE = cible;
  });
  afterAll(async () => { await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }); });

  it("une LECTURE (page, téléchargement) voit l'OS comme la personne visualisée", async () => {
    EN_TETES = new Headers();
    const u = await getCurrentUser();
    expect(u?.id).toBe(cible);
    expect(u?.impersonatedBy?.id).toBe(admin);
  });

  it("le CORPS d'une action serveur part au nom du Super Admin — ce que le bandeau promet", async () => {
    EN_TETES = new Headers({ "next-action": "abc123" });
    const u = await ACTION_STORE.current!.run({ isAction: true }, () => requireUser());
    expect(u.id).toBe(admin);
    expect(u.impersonatedBy).toBeUndefined();
  });

  it("le RENDU qui suit une action (redirect, revalidation) lit la vue, même avec l'en-tête `Next-Action` rejoué", async () => {
    // Next rend la page cible d'un `redirect()` dans la réponse de l'action, en rejouant les en-têtes de la
    // requête — `Next-Action` compris — mais HORS du corps de l'action. C'est le défaut mesuré : la page
    // d'arrivée de « Voir comme » se rendait comme celle de l'administrateur, sans bandeau, jusqu'au prochain
    // rechargement. L'en-tête ne dit pas « le code qui tourne est une action » : il ne décide donc de rien.
    EN_TETES = new Headers({ "next-action": "abc123" });
    const u = await requireUser();
    expect(u.id).toBe(cible);
    expect(u.impersonatedBy?.id).toBe(admin);
    expect((await getCurrentUser())?.id).toBe(cible);
  });

  it("l'action TERMINÉE ne laisse rien derrière elle : la lecture suivante revoit la vue", async () => {
    EN_TETES = new Headers({ "next-action": "abc123" });
    await ACTION_STORE.current!.run({ isAction: true }, () => requireUser());
    expect((await requireUser()).id).toBe(cible);
  });

  it("une route d'API qui ÉCRIT part aussi au nom du Super Admin", async () => {
    EN_TETES = new Headers();
    expect((await getCurrentUserPourEcrire())?.id).toBe(admin);
  });

  it("le cookie forgé par quelqu'un qui n'est pas Super Admin ne change rien", async () => {
    SESSION = { user: { id: cible, role: "MEDICAL_DELEGATE", name: "x", email: "x" } };
    COOKIE = admin;
    EN_TETES = new Headers();
    expect((await getCurrentUser())?.id).toBe(cible);
    SESSION = { user: { id: admin, role: "SUPER_ADMIN", name: `${TAG}Admin`, email: `${TAG}admin@t.dz` } };
    COOKIE = cible;
  });
});

/** Les fichiers de route sous un dossier, récursivement. */
function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? routes(p) : n === "route.ts" ? [p] : [];
  });
}

describe("Vue exacte — chaque route d'API qui écrit le déclare", () => {
  // Adam (assistant, voix) : visible du seul Super Admin PRINCIPAL. En vue exacte, la session rend une
  // autre personne, qu'Adam refuse déjà — elles n'écrivent donc jamais au nom de la personne visualisée.
  const ADAM = /src[\\/]app[\\/]api[\\/]assistant[\\/]/;
  const fichiers = routes("src/app/api").filter((f) => /export (async )?function (POST|PUT|PATCH|DELETE)/.test(readFileSync(f, "utf8")));

  it("PRÉMISSE : le parcours trouve les routes qui écrivent", () => {
    expect(fichiers.length).toBeGreaterThan(20);
  });

  it("aucune route qui écrit ne lit l'identité par `getCurrentUser` dans un gestionnaire d'écriture", () => {
    const fautives: string[] = [];
    for (const f of fichiers) {
      if (ADAM.test(f)) continue;
      const src = readFileSync(f, "utf8");
      const aussiGet = /export (async )?function GET/.test(src);
      // Une route qui n'a QUE des gestionnaires d'écriture ne doit jamais appeler `getCurrentUser()` ;
      // une route mixte doit choisir l'identité selon la méthode.
      if (!aussiGet && /\bgetCurrentUser\(\)/.test(src)) fautives.push(f);
      if (aussiGet && /\bgetCurrentUser\(\)/.test(src) && !/req\.method === "GET" \? await getCurrentUser\(\) : await getCurrentUserPourEcrire\(\)/.test(src)) fautives.push(f);
      if (/\brequireUser\(\)/.test(src)) fautives.push(f);
    }
    expect(fautives).toEqual([]);
  });
});

describe("Vue exacte — la session ne décide plus sur l'en-tête (§118.49 : le point d'appel, pas le corps)", () => {
  const src = readFileSync("src/lib/session.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("`build` consulte l'exécution de l'action (stockage de Next) ET le rendu en cours avant d'ignorer la vue", () => {
    // Le rendu qui SUIT une action qui revalide tourne dans le même stockage `isAction` (Next 14.2) : sans le
    // second critère, la coque se rendait pour l'administrateur au milieu de l'écran visualisé (Direction, 06/10).
    expect(src).toMatch(/actionServeur: actionServeurEnCours\(\)/);
    expect(src).toMatch(/rendu: rendreEnCours\(\)/);
    expect(src).toMatch(/actionAsyncStorage\.getStore\(\)\?\.isAction === true/);
  });

  it("aucune lecture de l'en-tête `next-action` pour décider de la vue", () => {
    expect(src).not.toMatch(/next-action/i);
    expect(src).not.toMatch(/headers\(\)/);
  });
});
