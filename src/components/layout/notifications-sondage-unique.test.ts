import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * UNE ROUTE SONDÉE = UN SEUL SONDEUR DANS LA COQUE (audit performance, PERF-04).
 *
 * Le carillon (`NotificationChime`, 20 s) et la fenêtre pop-up (`NotificationPopup`, 15 s) sondaient
 * chacun `/api/notifications/poll`, montés côte à côte dans `(app)/layout.tsx` : 7 appels par minute
 * et par onglet au lieu de 4, chacun résolvant la session et TOUS les droits (12 requêtes mesurées).
 * Le pop-up sonde, le carillon écoute l'événement qu'il diffuse — comme le badge de la messagerie.
 *
 * Le cliquet porte sur toute la coque : deux composants de `components/layout` qui appellent la même
 * route d'API à intervalle régulier, c'est le défaut qui revient.
 */
const DOSSIER = join(process.cwd(), "src/components/layout");
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("coque — chaque route sondée n'a qu'un sondeur", () => {
  it("aucune route d'API n'est sondée par deux composants de la coque", () => {
    const parRoute = new Map<string, string[]>();
    for (const f of readdirSync(DOSSIER).filter((x) => x.endsWith(".tsx"))) {
      const src = sansCommentaires(readFileSync(join(DOSSIER, f), "utf8"));
      if (!/setInterval\(/.test(src)) continue;
      for (const m of src.matchAll(/fetch\(\s*["'`](\/api\/[^"'`?]+)/g)) {
        const route = m[1];
        // Seules les lectures sondées comptent : un POST ponctuel (journal, envoi) n'est pas un sondage.
        const appel = src.slice(m.index!, m.index! + 160);
        if (/method:\s*["']POST/.test(appel)) continue;
        parRoute.set(route, [...new Set([...(parRoute.get(route) ?? []), f])]);
      }
    }
    const doublons = [...parRoute].filter(([, fichiers]) => fichiers.length > 1);
    expect(doublons, JSON.stringify(doublons)).toEqual([]);
  });

  it("le carillon écoute le compteur diffusé par le pop-up", () => {
    const carillon = sansCommentaires(readFileSync(join(DOSSIER, "notification-chime.tsx"), "utf8"));
    const popup = sansCommentaires(readFileSync(join(DOSSIER, "notification-popup.tsx"), "utf8"));
    expect(carillon).not.toMatch(/fetch\(/);
    expect(carillon).toMatch(/addEventListener\(EVENEMENT_NON_LUES/);
    expect(popup).toMatch(/dispatchEvent\(new CustomEvent\(EVENEMENT_NON_LUES/);
  });
});
