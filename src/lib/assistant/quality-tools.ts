/**
 * `data_quality` — Adam répond « qu'est-ce qui cloche dans nos données ? » depuis le moteur de
 * qualité (mandat 4 §23), jamais de mémoire : les constats OUVERTS, classés par criticité, sous
 * les droits de la personne (un salaire aberrant reste derrière RH), avec la date du dernier
 * balayage — « ça date de quand ? » a une réponse mesurée.
 *
 * L'outil LIT. Corriger d'un clic ou écarter se fait dans la boîte de décision ou l'écran
 * d'administration : une décision porte un nom, pas un tour de conversation.
 */

import type { PowerTool } from "@/platform/ia/outil";
import { compterConstats, derniersBalayages, lireConstats, modulesVisibles, LIBELLE_CRITICITE, LIBELLE_FAMILLE, FAMILLES, type Criticite, type FamilleQualite } from "@/platform/in-process/quality";

const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string).trim() : "");

export const QUALITY_TOOLS: PowerTool[] = [
  {
    def: {
      name: "data_quality",
      description:
        "LES ANOMALIES DE DONNÉES de l'ERP, trouvées par le moteur de qualité (balayage nocturne + horaire) : doublons "
        + "(salariés, fournisseurs, dossiers, factures), champs manquants, données périmées, incohérences entre modules, montants "
        + "contradictoires, statuts impossibles, relations cassées, e-mails invalides, documents orphelins, dates incohérentes, "
        + "valeurs aberrantes — chaque constat avec sa criticité, sa confiance, et s'il se corrige seul, d'un clic, ou par une "
        + "décision. À appeler pour « qu'est-ce qui cloche dans nos données ? », « y a-t-il des doublons de factures ? », "
        + "« nos fiches salariés sont-elles complètes ? ». Ne corrige rien : la correction se fait dans la boîte de décision "
        + "ou /admin/qualite, sous un nom.",
      input_schema: {
        type: "object",
        properties: {
          famille: { type: "string", enum: [...FAMILLES], description: "Ne montrer qu'une famille d'anomalies. Optionnel." },
          criticite: { type: "string", enum: ["CRITIQUE", "HAUTE", "NORMALE", "BASSE"], description: "Ne montrer qu'une criticité. Optionnel." },
          limite: { type: "number", description: "Nombre de constats détaillés (défaut 12, max 40)." },
        },
      },
    },
    // Le garde est celui de la LECTURE : un compte qui ne voit aucun module ne voit aucun constat —
    // ni en détail, ni en compteur. Le cloisonnement fin (un salaire aberrant reste derrière RH)
    // s'applique ensuite constat par constat dans `lireConstats`.
    allowed: (u) => { const v = modulesVisibles(u); return v === null || v.length > 0; },
    label: "Qualité des données consultée",
    run: async (input, user) => {
      const famille = FAMILLES.includes(str(input, "famille") as FamilleQualite) ? (str(input, "famille") as FamilleQualite) : null;
      const criticite = ["CRITIQUE", "HAUTE", "NORMALE", "BASSE"].includes(str(input, "criticite")) ? (str(input, "criticite") as Criticite) : null;
      const limite = typeof input.limite === "number" && input.limite > 0 ? Math.min(40, Math.round(input.limite)) : 12;
      const [compte, constats, balayages] = await Promise.all([
        compterConstats(user),
        lireConstats(user, { famille, criticite, limite }),
        derniersBalayages(),
      ]);
      const dernier = balayages.find((b) => b.mode === "FULL") ?? balayages[0] ?? null;
      return JSON.stringify({
        source: "moteur de qualité des données (règles déterministes, balayage nocturne complet + horaire léger)",
        dernierBalayage: dernier ? { mode: dernier.mode, le: dernier.startedAt.toISOString(), dureeMs: dernier.ms, constats: dernier.constats, corrigesSeuls: dernier.corriges, reglesEnErreur: dernier.erreurs } : "aucun balayage encore effectué",
        ouverts: compte.ouverts,
        parCriticite: compte.parCriticite,
        parFamille: Object.fromEntries(Object.entries(compte.parFamille).map(([f, n]) => [LIBELLE_FAMILLE[f as FamilleQualite] ?? f, n])),
        parResolution: { correctionsSeules: compte.parResolution.AUTO, aCorrigerDunClic: compte.parResolution.PROPOSE, decisionsHumaines: compte.parResolution.HUMAIN },
        filtre: [famille ? LIBELLE_FAMILLE[famille] : null, criticite ? LIBELLE_CRITICITE[criticite] : null].filter(Boolean).join(" · ") || "tout",
        constats: constats.map((c) => ({
          criticite: c.criticite, famille: LIBELLE_FAMILLE[c.famille as FamilleQualite] ?? c.famille, confiance: `${Math.round(c.confiance * 100)} %`,
          resolution: c.resolution === "AUTO" ? "correction automatique" : c.resolution === "PROPOSE" ? "correction proposée (un clic)" : "décision humaine",
          titre: c.titre, detail: c.detail, vuDepuis: c.firstSeenAt.toISOString().slice(0, 10), occurrences: c.occurrences,
          correction: c.correction?.description ?? null, lien: c.href ?? "/admin/qualite",
        })),
        lien: "/admin/qualite",
        _blocsDecoratifs: true,
        _blocs: [],
      });
    },
  },
];
