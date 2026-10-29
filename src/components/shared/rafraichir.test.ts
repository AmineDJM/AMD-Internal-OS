import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════
 * UN RAFRAÎCHISSEMENT QU'ON NE SUIT PAS LAISSE ROUVRIR UNE FICHE PÉRIMÉE (§118.172).
 *
 * Trouvé par le banc navigateur des annuaires : décocher « actif », enregistrer, rouvrir la fiche
 * aussitôt → la case est encore cochée, et enregistrer RÉACTIVE l'établissement. Entre la fin d'une
 * action et l'arrivée des nouvelles données, un écran qui appelle `router.refresh()` « à nu » montre
 * l'état d'AVANT avec des boutons déjà cliquables. `useRafraichir` place le rafraîchissement dans
 * une transition et dit quand il est fini ; l'écran garde ses gestes fermés jusque-là.
 *
 * Deux règles, et elles ne gardent pas la même chose :
 *   1. les écrans de ce lot passent par le crochet — vérifié à leur POINT D'APPEL (§118.49) ;
 *   2. le parc ne grandit plus en appels nus — CLIQUET au chiffre MESURÉ (§118.79c). Il en reste
 *      beaucoup, et la plupart n'ouvrent aucune fiche ; les convertir tous d'un coup élargirait ce
 *      lot sans rien prouver. Un écran AJOUTÉ demain, lui, n'a plus le choix.
 * ═══════════════════════════════════════════════════════════
 */

const SRC = join(process.cwd(), "src");

function fichiers(dir: string, acc: string[] = []): string[] {
  for (const nom of readdirSync(dir)) {
    const chemin = join(dir, nom);
    if (statSync(chemin).isDirectory()) fichiers(chemin, acc);
    else if (/\.tsx?$/.test(nom) && !/\.test\.tsx?$/.test(nom)) acc.push(chemin);
  }
  return acc;
}

/** Commentaires de bloc et de ligne retirés : un cliquet ne doit pas s'accrocher à la prose (§118.79d). */
function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

const APPEL_NU = /\brouter\.refresh\(\)/g;

/**
 * Mesuré au §118.172, après conversion des écrans de ce lot : 355 appels nus (commentaires retirés).
 * Ramené à 353 au §118.175 — les postes Ad & Pro et la suppression d'une demande suivent leur
 * rafraîchissement ; laissé à 355, le cliquet accepterait deux appels neufs sans rien dire (§118.79c).
 * Ramené à 350 au §118.176 — l'ancien écran des soldes d'ouverture (deux appels) a cédé la place
 * aux comptes de trésorerie ancrés, et la feuille de paie a perdu son « transfert au budget » ; le
 * panneau qui envoie la paie au centre suit son rafraîchissement. Il ne peut que baisser.
 * Ramené à 349 au §118.186 — le panneau des circuits Ad & Pro (approuver, renvoyer, resoumettre,
 * retirer) suit son rafraîchissement : un second clic sur l'état d'avant renverrait deux fois.
 * Ramené à 348 au §118.187 — l'encart du demandeur au secrétariat ouvre « Corriger » sur un instantané :
 * ouvert avant la fin du rafraîchissement, il réécrirait la demande d'avant.
 * Ramené à 347 au §118.190 — la carte du circuit d'un dossier promotionnel (valider, renvoyer, refuser,
 * resoumettre) suit son rafraîchissement : renvoyer sur l'état d'avant partirait une seconde fois.
 * Ramené à 343 au §118.191 — le dossier d'une demande de paiement (trois appels : ses gestes, la
 * relance, la demande d'une pièce) et les gestes du secrétariat suivent leur rafraîchissement : la
 * correction d'une demande s'ouvre sur un instantané, et l'ouvrir sur l'état d'avant réécrirait
 * l'ancien montant par-dessus le nouveau.
 * Ramené à 341 au §118.193 — le planificateur de tournée (demander une révision s'ouvre sur l'état
 * qu'il montre) et l'emploi du temps de « Ma journée » (« N'a pas eu lieu » sur une visite que l'état
 * d'avant montrerait encore à faire) suivent leur rafraîchissement.
 * Ramené à 340 au §118.197 — les boutons d'une approbation d'achat suivent leur rafraîchissement.
 * Ramené à 332 au §118.211 — le tableau du centre de paiement (autoriser, refuser, répondre) suit le sien : 334 appels mesurés avant, 332 après (le plafond de 340 laissait six crans de marge — un écran neuf en aurait ajouté six sans rien dire, §118.79c).
 * Ramené à 328 le 07/10 — la Paie, les Demandes RH et le plan de tournée passent par `useRafraichir`.
 * Ramené à 326 le 20/10 — les lots suivants avaient porté le parc à 332 (intégration Ad & Pro, pièces, références…) ;
 * le compositeur de pièces (six appels : émettre, réviser, brouillon, retirer, fermer) suit son rafraîchissement — une
 * révision rouverte sur l'état d'avant partirait avec une `versionVue` dépassée.
 * Ramené à 1 le 28/10/2026 (V3-B, primitives UI) — tout le parc passe par `useRafraichir` (ou `useAction`, qui
 * l'appelle) ; le seul appel restant est celui du crochet lui-même (`use-rafraichir.ts`).
 */
const PLAFOND_APPELS_NUS = 1;

describe("le rafraîchissement suivi", () => {
  const parc = fichiers(SRC).map((f) => ({ f, src: sansCommentaires(readFileSync(f, "utf8")) }));

  it("la garde lit bien le parc (plancher de fichiers)", () => {
    expect(parc.length).toBeGreaterThan(1000);
  });

  it("les écrans de ce lot appellent `useRafraichir`, et n'appellent plus `router.refresh()` à nu", () => {
    const ecrans = [
      "src/app/(app)/annuaires/etablissements/etablissements-table.tsx",
      "src/app/(app)/annuaires/etablissements/services-panel.tsx",
      "src/app/(app)/business-units/bu-manager.tsx",
      "src/components/shared/use-action.ts",
      // §118.175 : la carte d'un poste ouvre des fiches (modifier le poste, un voyageur) sur
      // l'état qu'elle montre — ouvertes avant la fin du rafraîchissement, elles réécriraient
      // l'état d'avant.
      "src/modules/ad-pro/ecrans/items-panel.tsx",
      "src/modules/ad-pro/ecrans/supprimer-demande.tsx",
      // §118.176 : envoyer la paie au centre, puis renvoyer sur l'état d'avant, partirait deux fois ;
      // supprimer des écritures « à imputer » rouvrirait une sélection sur des lignes disparues.
      "src/app/(app)/rh/paie/virements-paie.tsx",
      "src/app/(app)/budgets/suppression-a-imputer.tsx",
      // §118.186 : le panneau des circuits — renvoyer puis resoumettre sur l'état d'avant agirait deux fois.
      "src/components/workflow/workflow-panel.tsx",
      // §118.187 : « Corriger ma demande » s'ouvre sur l'état qu'il montre — corrigée puis rouverte trop tôt,
      // elle réécrirait la version d'avant.
      "src/app/(app)/demandes/[id]/requester-window.tsx",
      // §118.190 : la carte du circuit d'un dossier promotionnel — un renvoi parti, l'état d'avant
      // offrirait encore « Renvoyer », que l'action refuserait.
      "src/app/(app)/promo-material/[id]/circuit-card.tsx",
      // §118.193 : le planificateur — rouvrir un plan validé puis le rouvrir encore sur l'état d'avant ; l'emploi
      // du temps — dire une visite non tenue, puis la rapporter sur l'état d'avant.
      "src/app/(app)/medical/plan-de-tournee/planificateur.tsx",
      "src/app/(app)/medical/ma-journee/emploi-du-temps.tsx",
      // §118.197 : les boutons d'une approbation d'achat — trancher puis retrancher sur l'état d'avant
      // reposerait une décision qu'une autre personne vient de prendre.
      "src/app/(app)/demandes/approval-buttons.tsx",
      // §118.211 : le centre de paiement — autoriser puis ré-autoriser sur l'état d'avant, ou répondre
      // deux fois, ferait partir deux décisions sur le même paiement.
      "src/app/(app)/centre-de-paiement/centre-board.tsx",
    ];
    for (const e of ecrans) {
      const src = sansCommentaires(readFileSync(join(process.cwd(), e), "utf8"));
      // `useAction()` / `useKeyedAction()` rafraîchissent PAR `useRafraichir` (`use-action.ts`, dans
      // cette liste) : un écran qui passe par eux suit son rafraîchissement (audit 27/10/2026). Leurs options
      // (`useAction({ signalerErreurs })`) et `useFormAction(…)`, bâti sur `useAction`, comptent aussi (V3-B).
      expect(src, `${e} doit appeler useRafraichir()`).toMatch(/useRafraichir\(\)|\buse(Keyed|Form)?Action\(/);
      expect(src.match(APPEL_NU) ?? [], `${e} rafraîchit encore à nu`).toEqual([]);
    }
    // La feuille des praticiens : le composant PRINCIPAL suit son rafraîchissement ; les deux
    // petits formulaires qu'il héberge (ajout de ligne, colonnes) n'ouvrent aucune fiche.
    const grille = sansCommentaires(readFileSync(join(process.cwd(), "src/app/(app)/medical/annuaire/annuaire-grid.tsx"), "utf8"));
    const principal = grille.slice(grille.indexOf("export function AnnuaireGrid("), grille.indexOf("function AddDoctorRow("));
    expect(principal).toMatch(/useRafraichir\(\)/);
    expect(principal.match(APPEL_NU) ?? []).toEqual([]);
  });

  it("le crochet place bien le rafraîchissement DANS une transition", () => {
    const src = sansCommentaires(readFileSync(join(process.cwd(), "src/components/shared/use-rafraichir.ts"), "utf8"));
    expect(src).toMatch(/useTransition\(\)/);
    expect(src).toMatch(/demarrer\(\(\)\s*=>\s*\{\s*router\.refresh\(\);\s*\}\)/);
  });

  it("le parc ne grandit pas en appels nus (cliquet au chiffre mesuré)", () => {
    const parFichier = parc
      .map(({ f, src }) => ({ f: relative(process.cwd(), f), n: (src.match(APPEL_NU) ?? []).length }))
      .filter((x) => x.n > 0);
    const total = parFichier.reduce((a, x) => a + x.n, 0);
    expect(total, `${total} appels à router.refresh() à nu (plafond ${PLAFOND_APPELS_NUS}) — un écran neuf passe par useRafraichir()`).toBeLessThanOrEqual(PLAFOND_APPELS_NUS);
  });
});
