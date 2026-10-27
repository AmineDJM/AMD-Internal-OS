import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE REGISTRE DU STOCK NE S'ÉCRIT QU'À UN ENDROIT, ET NE SE RÉÉCRIT JAMAIS (§118.164).
 *
 * Un solde est la somme des mouvements. Il ne reste juste que si (1) un seul module écrit des
 * mouvements, sous le verrou de l'article, et (2) personne ne modifie ni ne supprime un mouvement :
 * une erreur s'ANNULE (son inverse s'écrit), elle ne s'efface pas. Réparer un écrivain à la main
 * ne protège pas le suivant (§118.58) : ce cliquet lit la SOURCE de toute la production.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const RACINE = path.resolve(__dirname, "../../..");
const ECRIVAIN = "src/lib/promo/stock-ecriture.ts";

function fichiers(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".next") fichiers(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** La source SANS ses commentaires : un commentaire qui CITE une écriture n'en est pas une (§118.88). */
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const PRODUCTION = fichiers(path.join(RACINE, "src")).map((f) => ({
  rel: path.relative(RACINE, f).split(path.sep).join("/"),
  src: sansCommentaires(fs.readFileSync(f, "utf8")),
}));

describe("le registre du stock promotionnel", () => {
  it("PLANCHER : l'écrivain unique écrit bien des mouvements — sans quoi le cliquet ne lirait rien", () => {
    const ecrivain = PRODUCTION.find((f) => f.rel === ECRIVAIN);
    expect(ecrivain, "l'écrivain a bougé : mettre ce banc à jour, ne pas le désarmer").toBeTruthy();
    const sites = (ecrivain!.src.match(/\.promoStockMovement\.create\(/g) ?? []).length;
    expect(sites).toBeGreaterThanOrEqual(6);
  });

  it("aucun autre fichier de production ne crée un mouvement", () => {
    const fautifs = PRODUCTION
      .filter((f) => f.rel !== ECRIVAIN && /\.promoStockMovement\.(create|createMany|upsert)\(/.test(f.src))
      .map((f) => f.rel);
    expect(fautifs, "un mouvement écrit hors de l'écrivain contourne le verrou et l'allocation par lot").toEqual([]);
  });

  it("personne ne modifie ni ne supprime un mouvement — une erreur s'annule par son inverse", () => {
    const fautifs = PRODUCTION
      .filter((f) => /\.promoStockMovement\.(update|updateMany|delete|deleteMany)\(/.test(f.src))
      .map((f) => f.rel);
    expect(fautifs).toEqual([]);
  });

  it("aucune écriture SQL brute sur le registre, les lots ou les transferts", () => {
    const fautifs = PRODUCTION
      .filter((f) => /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(PromoStockMovement|PromoStockLot|PromoStockTransfer)"?/i.test(f.src))
      .map((f) => f.rel);
    expect(fautifs).toEqual([]);
  });

  it("les actions écrivent par l'écrivain, SOUS le verrou de l'article — jamais par une transaction à côté", () => {
    const actions = PRODUCTION.find((f) => f.rel === "src/lib/actions/promo-stock-actions.ts")!;
    expect(actions.src).not.toMatch(/\$transaction\(/);
    const appels = actions.src.match(/\b(entrerLot|fairePartir|confirmerArrivee|renvoyer|sortirSansContrepartie|corrigerAuCompte|annulerMouvementEcrit)\(tx\b/g) ?? [];
    expect(appels.length, "chaque écriture reçoit le client de transaction du verrou").toBeGreaterThanOrEqual(11);
    const verrous = (actions.src.match(/\bsousVerrou\(/g) ?? []).length;
    expect(verrous).toBeGreaterThanOrEqual(11);
  });

  it("les écrans du stock lisent la RÈGLE, jamais un rôle", () => {
    // Les écrans du STOCK — le catalogue, rangé sous la même adresse depuis le §118.173, a sa propre
    // règle (le module `PROMO_CATALOG`) et n'est pas jugé ici.
    const ecrans = PRODUCTION.filter((f) => f.rel.startsWith("src/app/(app)/stock-promotionnel/") && !f.rel.startsWith("src/app/(app)/stock-promotionnel/catalogue/"));
    expect(ecrans.length).toBeGreaterThanOrEqual(4);
    for (const e of ecrans) {
      expect(e.src, `${e.rel} : un droit calculé sur un rôle diverge de celui que l'action lit`).not.toMatch(/SUPER_ADMIN|\.role\b/);
    }
    const vues = ecrans.find((e) => e.rel.endsWith("stock-vues.tsx"))!;
    expect(vues.src).toMatch(/from "@\/lib\/promo\/stock-acces"/);
  });

  it("la relance des réceptions a son POINT D'APPEL dans le battement (§118.49)", () => {
    const battement = PRODUCTION.find((f) => f.rel === "src/lib/scheduled.ts")!;
    expect(battement.src).toMatch(/executer:\s*relancerReceptionsStock\b/); // table des tâches (V2-F)
  });

  it("les comptages réguliers et les alertes ont leur POINT D'APPEL dans le battement (§118.49, §118.168)", () => {
    const battement = PRODUCTION.find((f) => f.rel === "src/lib/scheduled.ts")!;
    expect(battement.src, "sans cet appel, une récurrence planifiée ne part jamais").toMatch(/executer:\s*declencherComptagesRecurrents\b/);
    expect(battement.src, "sans cet appel, aucune alerte ne part — le tableau de bord les montrerait, personne ne les recevrait").toMatch(/executer:\s*alerterStock\b/);
  });

  it("un comptage corrige par l'écrivain, sous le verrou de TOUS ses articles, et se PREND avant toute correction (§118.168)", () => {
    const f = PRODUCTION.find((x) => x.rel === "src/lib/promo/comptages-ecriture.ts");
    expect(f, "l'enregistrement des comptages a bougé : mettre ce banc à jour, ne pas le désarmer").toBeTruthy();
    expect(f!.src).toMatch(/\bsousVerrous\(/);
    expect(f!.src, "l'écart se lit SOUS le verrou, au moment de la saisie").toMatch(/\bsoldeDe\(tx\b/);
    const prise = f!.src.search(/promoStockComptage\.updateMany\(\{\s*where:\s*\{\s*id:\s*c\.comptageId,\s*statut:\s*"DEMANDE"/);
    const correction = f!.src.search(/\bcorrigerAuCompte\(tx\b/);
    expect(prise, "la prise conditionnelle du comptage (DEMANDE → SAISI)").toBeGreaterThan(-1);
    expect(correction).toBeGreaterThan(-1);
    expect(prise, "prise APRÈS la première correction : deux saisies simultanées corrigeraient deux fois").toBeLessThan(correction);
  });

  it("les actions de comptage n'écrivent aucun mouvement elles-mêmes : elles passent par l'enregistrement sous verrou", () => {
    const a = PRODUCTION.find((x) => x.rel === "src/lib/actions/promo-comptage-actions.ts")!;
    expect(a.src).not.toMatch(/\b(entrerLot|fairePartir|confirmerArrivee|renvoyer|sortirSansContrepartie|corrigerAuCompte|annulerMouvementEcrit)\(/);
    expect(a.src).toMatch(/\benregistrerSaisieComptage\(/);
  });
});
