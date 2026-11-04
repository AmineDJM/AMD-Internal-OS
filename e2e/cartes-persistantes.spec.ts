import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { E2E } from "./global-setup";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * C1 (décision 0068) — LES CARTES À VALIDER NE DISPARAISSENT PLUS. Serveur RÉEL (build de production), `/assistant` au
 * bureau et `/ia` sur iPhone 13.
 *
 * La Direction, 04/11 : « une carte, je ne la valide pas encore, je sors, je reviens : le bouton a disparu — je dois
 * redemander une carte ». Reproduit en vrai navigateur avec le vrai modèle (base locale) : la carte unique survit au
 * rechargement, à l'arrière-plan, à l'app, au téléphone ; elle MEURT quand on revient et qu'on en reparle (« ok pour la
 * tâche…, je la valide tout à l'heure » : retirée avant le modèle, en silence) ; et la SECONDE carte d'un tour n'apparaît
 * jamais. « Ignorer » ne vivait qu'à l'écran : au retour, la carte revenait à signer.
 *
 * LE DÉCOR est posé en base, tel que le fil l'écrit (aucun appel de modèle dans cette suite : la clé est un jalon, le tour
 * échoue au fournisseur — mais le retrait des cartes se joue AVANT le modèle, c'est lui qu'on mesure). Les colonnes de
 * rattachement (C1) sont écrites quand elles existent : la même spec joue contre le code d'avant (elle y échoue) et
 * d'après (elle y passe).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const prisma = new PrismaClient();
const fils: string[] = [];
test.afterAll(async () => {
  await prisma.assistantActionIntent.deleteMany({ where: { title: { startsWith: "__e2e__ C1" } } });
  await prisma.assistantIaFil.deleteMany({ where: { id: { in: fils } } });
  await prisma.$disconnect();
});

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(E2E.superAdminEmail);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

interface Carte { titre: string; objet: string; echeance: string; ageH?: number }

/** Une conversation où Adam a répondu par `cartes` (plusieurs dans le même tour) — écrites comme le fil les écrit. */
async function decor(userId: string, nom: string, cartes: Carte[]) {
  const fil = await prisma.assistantIaFil.create({ data: { userId, titre: `__e2e__ C1 ${nom}`, titreSource: "manuel", depuisLe: new Date(Date.now() - 3 * 86_400_000) } });
  fils.push(fil.id);
  const avant = Math.max(...cartes.map((c) => c.ageH ?? 0)) * 3_600_000 + 60_000;
  const q = await prisma.assistantIaTour.create({ data: { filId: fil.id, userId, role: "user", contenu: `Prépare ${cartes.length > 1 ? "ces tâches" : "cette tâche"}, je validerai.`, etat: "TRAITE", createdAt: new Date(Date.now() - avant) } });
  const r = await prisma.assistantIaTour.create({ data: { filId: fil.id, userId, role: "assistant", contenu: "Les cartes attendent votre confirmation.", etat: "TERMINE", repondA: q.id, createdAt: new Date(Date.now() - avant + 1_000) } });
  const colonnesC1 = (await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'AssistantActionIntent' AND column_name IN ('filId', 'tourId', 'carte')`)[0]!.n === 3n;
  const ids: string[] = [];
  for (const c of cartes) {
    const fields = [{ label: "Titre", value: c.objet }, { label: "Échéance", value: c.echeance }];
    const i = await prisma.assistantActionIntent.create({
      data: {
        userId, kind: "create_task", module: "Tasks", title: c.titre, summary: `${c.titre} — Titre : ${c.objet} · Échéance : ${c.echeance}`,
        payload: { titre: c.objet }, status: "PROPOSED", origin: "text", events: [{ status: "PROPOSED", at: new Date().toISOString() }],
        proposedAt: new Date(Date.now() - (c.ageH ?? 0) * 3_600_000),
      },
    });
    const affichee = { id: i.id, kind: "create_task", title: c.titre, fields, status: "PROPOSED" };
    if (colonnesC1) await prisma.$executeRaw`UPDATE "AssistantActionIntent" SET "filId" = ${fil.id}, "tourId" = ${r.id}, "carte" = ${JSON.stringify(affichee)}::jsonb WHERE id = ${i.id}`;
    // Le tour garde la PREMIÈRE carte (`intent`), comme le fil l'a toujours fait.
    if (ids.length === 0) await prisma.assistantIaTour.update({ where: { id: r.id }, data: { intent: affichee } });
    ids.push(i.id);
  }
  return { fil: fil.id, ids };
}

/** La carte elle-même : le cadre « glass » le plus intérieur qui porte ce titre (la bulle de la réponse l'est aussi). */
const carte = (page: Page, titre: string) => page.locator("[data-glass='true']:not(:has([data-glass='true']))").filter({ hasText: titre });
const statut = async (id: string) => (await prisma.assistantActionIntent.findUniqueOrThrow({ where: { id } })).status;

/** La carte est là, AVEC ses boutons. */
async function aSigner(page: Page, titre: string) {
  await expect(carte(page, titre)).toHaveCount(1, { timeout: 30_000 });
  await expect(carte(page, titre).getByRole("button", { name: "Ignorer" })).toBeVisible();
  await expect(carte(page, titre).getByRole("button", { name: "Confirmer" })).toBeVisible();
}

/** Envoyer un message dans la conversation, et attendre que le tour soit joué (il échoue au fournisseur : pas de modèle). */
async function dire(page: Page, fil: string, texte: string) {
  await page.getByLabel("Votre message").fill(texte);
  await page.getByRole("button", { name: "Envoyer", exact: true }).click();
  await expect.poll(async () => (await prisma.assistantIaTour.findFirst({ where: { filId: fil, role: "user", contenu: texte } }))?.etat ?? null, { timeout: 90_000 })
    .toMatch(/TRAITE|ECHEC/);
}

test("C1 bureau (/assistant) — sortir, revenir, recharger, en reparler : les cartes gardent leurs boutons ; un retrait se dit", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const moi = await prisma.user.findUniqueOrThrow({ where: { email: E2E.superAdminEmail }, select: { id: true } });
  const A = { titre: "__e2e__ C1 Relancer le fournisseur des étiquettes Nivolex", objet: "Relancer le fournisseur des étiquettes Nivolex", echeance: "vendredi" };
  const B = { titre: "__e2e__ C1 Appeler Biopharm pour le devis de stabilité", objet: "Appeler Biopharm pour le devis de stabilité", echeance: "lundi" };
  const C = { titre: "__e2e__ C1 Préparer la note de frais du congrès d'Oran", objet: "Préparer la note de frais du congrès d'Oran", echeance: "mardi" };
  const { fil, ids: [idA, idB, idC] } = await decor(moi.id, "bureau", [A, B, C]);
  const vieux = await decor(moi.id, "expirée", [{ titre: "__e2e__ C1 Commander les cartons de Daclavir", objet: "Commander les cartons de Daclavir", echeance: "jeudi", ageH: 26 }]);

  await login(page);
  await page.goto(`/assistant?c=${fil}`);
  // 1. TROIS cartes dans la même réponse : les trois sont à l'écran, chacune avec ses boutons (avant C1 : une seule).
  for (const x of [A, B, C]) await aSigner(page, x.titre);

  // 2. Sortir, revenir ; recharger ; passer en arrière-plan et revenir — rien ne bouge.
  await page.goto("/");
  await page.goto(`/assistant?c=${fil}`);
  await page.reload();
  await page.evaluate(() => {
    for (const v of ["hidden", "visible"]) {
      Object.defineProperty(document, "visibilityState", { value: v, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
  for (const x of [A, B, C]) await aSigner(page, x.titre);

  // 3. Revenir et EN REPARLER sans la corriger, puis écrire un message SANS RAPPORT : rien n'est retiré (avant C1 : la
  //    carte A passait « retirée » avant même que le modèle réponde, et son bouton disparaissait).
  await dire(page, fil, "Ok pour la tâche de relance du fournisseur des étiquettes Nivolex, je la valide tout à l'heure.");
  await dire(page, fil, "Au fait, combien de jours y a-t-il en février 2028 ?");
  expect([await statut(idA), await statut(idB), await statut(idC)]).toEqual(["PROPOSED", "PROPOSED", "PROPOSED"]);
  await page.reload();
  for (const x of [A, B, C]) await aSigner(page, x.titre);
  await page.screenshot({ path: "e2e-screenshots/c1-bureau-1-cartes-gardees.png" });

  // 4. « Ignorer » vaut POUR DE BON (avant C1 : l'écran seul, la carte revenait au rechargement) — et se dit.
  await carte(page, B.titre).getByRole("button", { name: "Ignorer" }).click();
  await expect.poll(() => statut(idB), { timeout: 15_000 }).toBe("CANCELLED");
  await page.reload();
  await expect(carte(page, B.titre)).toContainText("Carte ignorée — rien n'a été exécuté.", { timeout: 30_000 });
  await expect(carte(page, B.titre).getByRole("button", { name: "Confirmer" })).toHaveCount(0);

  // 5. Une vraie CORRECTION retire la carte — et l'écran dit pourquoi, à la place des boutons.
  await dire(page, fil, "Non, finalement la note de frais du congrès d'Oran c'est pour Amel, et l'échéance c'est jeudi.");
  expect(await statut(idC)).toBe("CANCELLED");
  await page.reload();
  await expect(carte(page, C.titre)).toContainText("Carte retirée : vous l'avez corrigée", { timeout: 30_000 });
  await aSigner(page, A.titre);
  await page.screenshot({ path: "e2e-screenshots/c1-bureau-2-retraits-dits.png" });

  // 6. Une carte EXPIRÉE le dit, au lieu de disparaître.
  await page.goto(`/assistant?c=${vieux.fil}`);
  await expect(carte(page, "__e2e__ C1 Commander les cartons de Daclavir")).toContainText("Carte expirée : non confirmée dans les 24 h", { timeout: 30_000 });
  expect(await statut(vieux.ids[0]!)).toBe("EXPIRED");
});

test("C1 iPhone 13 (/ia) — l'app Adventum IA montre toutes les cartes du tour, avec leurs boutons, après fermeture de l'onglet", async ({ page, context }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const moi = await prisma.user.findUniqueOrThrow({ where: { email: E2E.superAdminEmail }, select: { id: true } });
  const A = { titre: "__e2e__ C1 Valider le planning des visites d'Annaba", objet: "Valider le planning des visites d'Annaba", echeance: "mercredi" };
  const B = { titre: "__e2e__ C1 Envoyer le bon de commande Imprimerie El Djazair", objet: "Envoyer le bon de commande Imprimerie El Djazair", echeance: "jeudi" };
  const { fil } = await decor(moi.id, "iphone", [A, B]);
  await login(page);
  await page.goto(`/ia?c=${fil}`);
  for (const x of [A, B]) await aSigner(page, x.titre);
  // Fermer l'onglet, en rouvrir un autre : les cartes sont toujours là.
  await page.close();
  const p2 = await context.newPage();
  await p2.setViewportSize({ width: 390, height: 844 });
  await p2.goto(`/ia?c=${fil}`);
  for (const x of [A, B]) await aSigner(p2, x.titre);
  await p2.screenshot({ path: "e2e-screenshots/c1-iphone-cartes.png" });
  expect(await p2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
