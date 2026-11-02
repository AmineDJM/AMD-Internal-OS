import * as React from "react";

/**
 * UN MODULE D'INTERFACE CHARGÉ APRÈS LA PAGE — pour les porteurs montés une fois pour toute la coque (`PrimitivesUI`).
 *
 * La fenêtre de confirmation et la pile d'avis ne servent qu'au premier geste : les embarquer dans la
 * coque ferait payer leur poids à chaque page (plafond `scripts/mesure-bundle.mjs`). Le module est donc
 * demandé au premier moment libre du navigateur — bien avant qu'on clique, d'ordinaire — et, au plus
 * tard, au premier besoin (`charger()`). S'il ne vient pas (réseau coupé), `charger()` rejette : chaque
 * porteur garde alors un repli qui ne dépend d'aucun téléchargement.
 */
export function useModuleDiffere<M>(importer: () => Promise<M>): { module: M | null; charger: () => Promise<M> } {
  const [module, setModule] = React.useState<M | null>(null);
  const enVol = React.useRef<Promise<M> | null>(null);
  const importerRef = React.useRef(importer);

  const charger = React.useCallback(() => {
    if (!enVol.current) {
      enVol.current = importerRef.current().then(
        (m) => { setModule(() => m); return m; },
        (e: unknown) => { enVol.current = null; throw e; },
      );
    }
    return enVol.current;
  }, []);

  React.useEffect(() => {
    const avance = async () => {
      try {
        await charger();
      } catch {
        // Hors ligne : le porteur garde son repli, nouvel essai au premier besoin.
      }
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(avance, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(avance, 1500);
    return () => clearTimeout(t);
  }, [charger]);

  return { module, charger };
}
