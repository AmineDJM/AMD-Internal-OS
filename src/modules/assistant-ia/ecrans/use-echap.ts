"use client";

import { useEffect } from "react";

/** Échap ferme le panneau ouvert (dialogues de l'Assistant IA et d'Adventum IA). */
export function useEchap(onFermer: () => void): void {
  useEffect(() => {
    const echap = (e: KeyboardEvent) => { if (e.key === "Escape") onFermer(); };
    window.addEventListener("keydown", echap);
    return () => window.removeEventListener("keydown", echap);
  }, [onFermer]);
}
