"use client";

import * as React from "react";
import { estTriMesDemandes, TRI_PAR_DEFAUT, type TriMesDemandes } from "@/modules/finances/partage";

/** Où ce navigateur retient le dernier tri choisi — le même pour les trois listes de « Mes demandes ». */
const CLE = "amd.mes-demandes-paiement.tri";

/**
 * LE TRI CHOISI, RETENU (Direction, 10/11/2026 : on revient sur la liste telle qu'on l'a laissée). Une préférence de
 * ce navigateur : stockage illisible ou bloqué (navigation privée), on retombe sur « Plus récentes » sans rien casser.
 */
export function useTriMesDemandes(): [TriMesDemandes, (t: TriMesDemandes) => void] {
  const [tri, setTri] = React.useState<TriMesDemandes>(TRI_PAR_DEFAUT);
  React.useEffect(() => {
    try {
      const lu = window.localStorage.getItem(CLE);
      if (estTriMesDemandes(lu)) setTri(lu);
    } catch { /* stockage indisponible : le tri par défaut */ }
  }, []);
  const choisir = React.useCallback((t: TriMesDemandes) => {
    setTri(t);
    try { window.localStorage.setItem(CLE, t); } catch { /* stockage indisponible : le choix vaut pour cette page */ }
  }, []);
  return [tri, choisir];
}
