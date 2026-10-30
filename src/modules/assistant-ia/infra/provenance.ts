import { prisma } from "@/lib/prisma";
import type { PowerTool } from "@/platform/ia/outil";
import { extraireNonFiables } from "../domaine/contenu-non-fiable";
import { provenanceDeLaCarte, type ContenuTiers } from "../domaine/provenance-tierce";
import type { PropositionCarte } from "./operations";

/**
 * LA PROVENANCE TIERCE, SUR LA CARTE (J14, décision 0022) — ce que le tour a lu d'un tiers, ce que la personne a dit,
 * et, à chaque carte préparée, les valeurs d'origine tierce DITES sur la carte (« ce RIB provient du document X, à
 * vérifier »). La règle est pure (`domaine/provenance-tierce.ts`) ; ici, le recueil du tour et l'écriture sur la carte.
 */
export class ProvenanceDuTour {
  readonly tiers: ContenuTiers[] = [];
  readonly internes: string[] = [];
  constructor(readonly paroles: string[], message = "") {
    // Les pièces jointes du message arrivent ENCADRÉES (lecture des pièces) : elles sont des contenus tiers.
    this.tiers.push(...extraireNonFiables(message));
  }

  /** Une sortie d'outil telle que le modèle la reçoit : encadrée (tiers) ou non (l'ERP). */
  noter(pourModele: string): void {
    const cadres = extraireNonFiables(pourModele);
    if (cadres.length) this.tiers.push(...cadres);
    else this.internes.push(pourModele);
  }
}

/** Un geste qui prépare une carte : sa carte porte les avertissements de provenance. */
export function avecProvenance(o: PowerTool, propositions: PropositionCarte[], provenance?: ProvenanceDuTour): PowerTool {
  if (!provenance) return o;
  return {
    ...o,
    run: async (entree, u) => {
      const avant = propositions.length;
      const sortie = await o.run(entree, u);
      const p = propositions.length > avant ? propositions[propositions.length - 1] : null;
      if (p) await marquerCarte(p, provenance);
      return sortie;
    },
  };
}

async function marquerCarte(p: PropositionCarte, prov: ProvenanceDuTour): Promise<void> {
  const r = provenanceDeLaCarte({ champs: p.proposition.fields ?? [], tiers: prov.tiers, paroles: prov.paroles, internes: prov.internes });
  if (!r.avertissements.length) return;
  p.proposition.warnings = [...new Set([...(p.proposition.warnings ?? []), ...r.avertissements])];
  const i = await prisma.assistantActionIntent.findUnique({ where: { id: p.intentId }, select: { payload: true } });
  const payload = (i?.payload && typeof i.payload === "object" ? i.payload : {}) as Record<string, unknown>;
  await prisma.assistantActionIntent.update({
    where: { id: p.intentId },
    data: { payload: { ...payload, provenanceTierce: { provenances: r.provenances, injections: r.injections, avertissements: r.avertissements } } as never },
  });
}
