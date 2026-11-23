"use client";

import * as React from "react";
import { KpiCard } from "@/components/shared/kpi-card";
import { formatCurrency } from "@/lib/utils";
import type { CentralStatus } from "@/modules/finances/partage";
import { bilanAffiche, type BilanCentre, type DecisionLocale, type DecisionsLocales } from "./decisions-locales";

/**
 * LES DÉCISIONS DE CET ÉCRAN, PARTAGÉES ENTRE LA FILE ET LES COMPTEURS (recette sponsoring, 23/11/2026).
 *
 * La file (`centre-board.tsx`) note chaque décision que le serveur a confirmée ; les compteurs du
 * haut de page la lisent. Sans ce partage, la carte changeait d'état mais « En attente » restait au
 * même chiffre jusqu'au rechargement — deux vérités sur le même écran. La règle (quand une décision
 * locale vaut encore) est pure : `decisions-locales.ts`.
 *
 * L'état vit dans la PAGE : changer d'entité ou de section remonte la page, et repart de ce que le
 * serveur dit — une décision locale ne survit pas à l'écran qui l'a prise.
 */

interface Contexte {
  decisions: DecisionsLocales;
  noter: (id: string, d: DecisionLocale) => void;
}

const SANS_PORTEUR: Contexte = { decisions: {}, noter: () => {} };
const ContexteDecisions = React.createContext<Contexte | null>(null);

export function DecisionsDuCentre({ children }: { children: React.ReactNode }) {
  const [decisions, setDecisions] = React.useState<DecisionsLocales>({});
  const noter = React.useCallback((id: string, d: DecisionLocale) => {
    setDecisions((avant) => ({ ...avant, [id]: d }));
  }, []);
  const valeur = React.useMemo(() => ({ decisions, noter }), [decisions, noter]);
  return <ContexteDecisions.Provider value={valeur}>{children}</ContexteDecisions.Provider>;
}

/** Hors porteur (un écran qui monterait la file seule), les décisions ne se partagent pas : rien ne casse. */
export function useDecisionsDuCentre(): Contexte {
  return React.useContext(ContexteDecisions) ?? SANS_PORTEUR;
}

/** Les quatre compteurs de l'entité choisie — ceux du serveur, corrigés de ce que cet écran vient de décider. */
export function CompteursCentre({
  bilan, statuts, entite,
}: {
  bilan: BilanCentre;
  /** L'état de chaque ordre affiché, du MÊME rendu que `bilan` (voir `bilanAffiche`). */
  statuts: Record<string, CentralStatus>;
  entite: string | null;
}) {
  const { decisions } = useDecisionsDuCentre();
  const b = bilanAffiche(bilan, statuts, decisions);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <KpiCard label="En attente" value={b.enAttente} icon="Hourglass" tone={b.enAttente > 0 ? "warning" : "default"} hint={entite ?? undefined} />
      <KpiCard label="Montant en attente" value={formatCurrency(b.montantEnAttente)} icon="Coins" tone={b.enAttente > 0 ? "warning" : "default"} />
      <KpiCard label="Autorisés" value={b.autorises} icon="ShieldCheck" tone="success" />
      <KpiCard label="Refusés" value={b.refuses} icon="ShieldX" tone={b.refuses > 0 ? "danger" : "default"} />
    </div>
  );
}
