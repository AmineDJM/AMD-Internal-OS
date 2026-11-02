"use client";

import { useEffect } from "react";
import { executerMesGestesSousMandat } from "@/modules/assistant-ia/actions-proactivite";
import { sansBloquer } from "@/lib/journal";

/**
 * LES GESTES SOUS MANDAT, DANS LA REQUÊTE DE LA PERSONNE (J12, décision 0024) — monté par la coque de l'ERP.
 *
 * Les actions métier exigent la session de la personne : les gestes qu'elle a confiés par mandat se font
 * donc quand elle est là, à l'ouverture d'une page puis toutes les 10 minutes tant qu'elle reste. Le serveur
 * borne lui aussi (fenêtre prise atomiquement) : plusieurs onglets ne font rien deux fois. Rien à l'écran.
 */
const FENETRE_MS = 10 * 60_000;
const CLE = "assistant-ia.gestes-sous-mandat";

export function ExecuteurMandats() {
  useEffect(() => {
    const passer = () => {
      if (document.visibilityState !== "visible") return;
      try {
        const dernier = Number(sessionStorage.getItem(CLE) ?? 0);
        if (Date.now() - dernier < FENETRE_MS) return;
        sessionStorage.setItem(CLE, String(Date.now()));
      } catch {
        // Stockage indisponible (navigation privée) : le serveur borne seul.
      }
      void executerMesGestesSousMandat().catch(sansBloquer("executeur-mandats.executerMesGestesSousMandat"));
    };
    passer();
    const t = setInterval(passer, FENETRE_MS);
    return () => clearInterval(t);
  }, []);
  return null;
}
