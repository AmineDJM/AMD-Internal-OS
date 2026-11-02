/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'OUTIL DE LA VÉRITÉ (mandat 6 §46) — réconcilier, tracer, et ne jamais choisir au hasard.
 *
 * ── TROIS QUESTIONS, ET LA TROISIÈME EST UNE LECTURE DE CE QUI EXISTE ───────────────────
 *
 *   · `reconcilier` — l'ERP dit 15, le classeur 17, l'e-mail 16,5. Le moteur (`lib/verite/`)
 *     répond, avec sa RAISON, ou dit ce qui manque pour trancher. Jamais une moyenne.
 *   · `lignee`      — comment ce chiffre est devenu CE chiffre : sources → nettoyage →
 *     conversion → consolidation, avec ce que chaque étape a PERDU.
 *   · `ouvertes`    — les questions encore ouvertes et les hypothèses à rejuger. Elles vivent
 *     déjà au REGISTRE DES DÉCISIONS : une décision `PROPOSED` EST une question ouverte, et une
 *     décision qui porte un résultat attendu et une date de relecture EST une hypothèse. Créer
 *     un second registre pour les mêmes objets les aurait fait diverger (§17) ; ici on les LIT.
 *
 * ── POURQUOI LES VALEURS SONT FOURNIES PAR L'APPELANT ───────────────────────────────────
 *
 * Le moteur ne va pas les chercher lui-même, et c'est délibéré : les trois chiffres viennent de
 * trois outils différents, appelés sous les droits de la personne, chacun avec sa provenance.
 * Un moteur qui irait les relire lui-même court-circuiterait ces droits et perdrait la
 * provenance. Adam lit, puis confronte — dans cet ordre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PowerTool } from "@/platform/ia/outil";
import {
  AUTORITE_CLAUSE, AUTORITE_DEFAUT, NATURES_ETAPE, NATURES_SOURCE,
  construire, detailler, direVerdict, questionsEtHypotheses, raconter, reconcilier, verifier,
  type Candidat, type Etape, type NatureEtape, type NatureSource,
} from "@/platform/in-process/verite";

/** L'acteur, tel que le registre d'outils le passe — sans importer la session côté ERP. */
type Acteur = Parameters<PowerTool["run"]>[1];

/** Le siège exécutif : le registre des décisions est déjà gardé ainsi. */
const EXEC = (u: Acteur): boolean => u.role === "SUPER_ADMIN" || u.role === "DIRECTION";

const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string).trim() : "");
const rows = (input: Record<string, unknown>, key: string): Record<string, unknown>[] =>
  Array.isArray(input[key]) ? (input[key] as unknown[]).filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object") : [];

const nature = (v: unknown): NatureSource => (typeof v === "string" && (NATURES_SOURCE as readonly string[]).includes(v) ? v as NatureSource : "EXTERNE");
const natureEtape = (v: unknown): NatureEtape => (typeof v === "string" && (NATURES_ETAPE as readonly string[]).includes(v) ? v as NatureEtape : "TRANSFORMATION");
const dateOu = (v: unknown, defaut: Date): Date => {
  if (typeof v !== "string" || !v.trim()) return defaut;
  const d = new Date(v.length === 10 ? `${v}T12:00:00.000Z` : v);
  return Number.isNaN(d.getTime()) ? defaut : d;
};
const nb = (v: unknown, defaut: number): number => (typeof v === "number" && Number.isFinite(v) ? v : defaut);
const jour = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

export const VERITE_TOOLS: PowerTool[] = [
  {
    def: {
      name: "verite_reconcilier",
      description:
        "QUAND DEUX SOURCES NE DISENT PAS LA MÊME CHOSE — et quand il faut prouver un chiffre. "
        + "questions : « reconcilier » (confronte des valeurs venues de sources différentes : le moteur regarde d'abord si c'est bien la MÊME question — HT contre TTC n'est pas une contradiction —, puis l'autorité de la source SUR CE FAIT, puis la fraîcheur ; il rend une valeur AVEC sa raison, ou dit précisément ce qui manque pour trancher, ou pose la question à une personne. Il ne fait JAMAIS de moyenne et ne choisit jamais au hasard) · "
        + "« lignee » (comment un chiffre a été fabriqué : sources → extraction → nettoyage → transformation → calcul → consolidation, avec les lignes perdues à chaque étape ; refuse un résultat qui ne remonte à aucune source) · "
        + "« ouvertes » (les questions encore ouvertes et les hypothèses à rejuger, lues au registre des décisions). "
        + "À utiliser dès que deux chiffres divergent, et avant d'affirmer un chiffre consolidé.",
      input_schema: {
        type: "object",
        properties: {
          question: { type: "string", enum: ["reconcilier", "lignee", "ouvertes"] },
          fait: { type: "string", description: "reconcilier : de quel fait il s'agit (« chiffre d'affaires 2026 », « préavis du contrat X »)." },
          type_de_fait: { type: "string", enum: ["ordinaire", "clause_contractuelle"], description: "reconcilier : « clause_contractuelle » inverse l'autorité — le document SIGNÉ prime sur l'ERP." },
          valeurs: {
            type: "array",
            description: "reconcilier : une entrée par source.",
            items: {
              type: "object",
              properties: {
                valeur: { type: "string", description: "La valeur telle que la source la porte." },
                source: { type: "string", description: "Le nom de la source (« ERP Finance », « classeur budget 2026 », « e-mail de Khaled du 12/07 »)." },
                nature: { type: "string", enum: [...NATURES_SOURCE], description: "ERP, DOCUMENT_SIGNE, DOCUMENT, TABLEUR, EMAIL, PERSONNE, CALCUL, EXTERNE." },
                arrete_le: { type: "string", description: "La date à laquelle CETTE valeur a été arrêtée (AAAA-MM-JJ)." },
                contexte: { type: "string", description: "TRÈS IMPORTANT : HT / TTC, périmètre, date d'arrêté. C'est ce qui distingue une contradiction d'une question mal posée." },
                transformation: { type: "string", description: "Ce qui a été appliqué pour obtenir la valeur (« × 1,19 », « somme de 4 lignes »)." },
                derive_de: { type: "string", description: "Le nom d'une autre source dont celle-ci DÉRIVE : une dérivée n'est pas un témoin indépendant." },
                confiance: { type: "number", description: "0 à 1 — la confiance dans la LECTURE (OCR douteux, saisie manuelle…)." },
              },
              required: ["valeur", "source"],
            },
          },
          etapes: {
            type: "array",
            description: "lignee : la chaîne, une entrée par étape.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                nature: { type: "string", enum: [...NATURES_ETAPE] },
                libelle: { type: "string", description: "Ce qui a été fait, en français." },
                entrees: { type: "array", items: { type: "string" }, description: "Les identifiants des étapes dont celle-ci découle. Vide pour une SOURCE." },
                valeur: { type: "string" },
                lignes_entrantes: { type: "number" },
                lignes_sortantes: { type: "number" },
                perte: { type: "string", description: "Ce que l'étape a écarté, et pourquoi." },
              },
              required: ["id", "nature", "libelle"],
            },
          },
          limite: { type: "number" },
        },
        required: ["question"],
      },
    },
    // `reconcilier` et `lignee` ne lisent RIEN : ils raisonnent sur ce qu'Adam vient de lire sous
    // les droits de la personne. `ouvertes` lit le registre des décisions, filtré sur le
    // propriétaire — le même cloisonnement que `list_decisions`.
    allowed: () => true,
    label: "Réconciliation et lignée",
    run: async (input, user) => {
      const question = str(input, "question").toLowerCase() || "reconcilier";

      if (question === "ouvertes") {
        if (!EXEC(user)) return JSON.stringify({ ok: false, erreur: "Le registre des décisions est réservé à la direction." });
        const limite = Math.min(50, Math.max(1, nb(input.limite, 20)));
        const { questions, hypotheses } = await questionsEtHypotheses(user, limite);
        return JSON.stringify({
          ok: true,
          questions_ouvertes: questions.map((q) => ({
            id: q.id, question: q.probleme ?? q.titre, titre: q.titre,
            options: q.options, recommandation: q.recommandation,
            ouverte_depuis: jour(q.ouverteDepuis), entites: q.entites,
          })),
          hypotheses_a_rejuger: hypotheses.map((h) => ({
            id: h.id, decision: h.decision, attendu: h.attendu,
            a_revoir_le: jour(h.aRevoirLe), echue: h.echue, decidee_le: jour(h.decideeLe),
          })),
          lecture: "Une décision « à l'étude » EST une question ouverte ; une décision avec un résultat attendu et une date de relecture EST une hypothèse. Pour en refermer une, utilise `update_decision_outcome` avec le résultat RÉEL.",
        });
      }

      if (question === "lignee") {
        const brut = rows(input, "etapes");
        if (brut.length === 0) return JSON.stringify({ ok: false, erreur: "Donnez les étapes de la chaîne (`etapes`)." });
        const etapes: Etape[] = brut.map((e) => ({
          id: String(e.id ?? ""), nature: natureEtape(e.nature), libelle: String(e.libelle ?? ""),
          entrees: Array.isArray(e.entrees) ? (e.entrees as unknown[]).map(String) : [],
          valeur: e.valeur === undefined ? null : String(e.valeur),
          lignesEntrantes: typeof e.lignes_entrantes === "number" ? e.lignes_entrantes : null,
          lignesSortantes: typeof e.lignes_sortantes === "number" ? e.lignes_sortantes : null,
          perte: typeof e.perte === "string" && e.perte.trim() ? e.perte : null,
        }));
        const l = construire(etapes);
        const v = verifier(l);
        return JSON.stringify({
          ok: true,
          phrase: raconter(l),
          prouve: v.valide,
          ...(v.valide ? {} : { avertissement: "Cette chaîne ne PROUVE pas le chiffre : ne le présente pas comme établi." }),
          sources: v.sources.map((s) => s.libelle),
          profondeur: v.profondeur,
          anomalies: v.anomalies,
          detail: detailler(l),
        });
      }

      // ── reconcilier ─────────────────────────────────────────────────────────────────
      const brut = rows(input, "valeurs");
      if (brut.length === 0) return JSON.stringify({ ok: false, erreur: "Donnez au moins une valeur (`valeurs`)." });
      const maintenant = new Date();
      const candidats: Candidat[] = brut.map((v, i) => ({
        valeur: String(v.valeur ?? ""),
        source: { id: String(v.source ?? `source-${i + 1}`), nature: nature(v.nature), libelle: String(v.source ?? `source ${i + 1}`) },
        observeLe: dateOu(v.arrete_le, maintenant),
        confiance: Math.min(1, Math.max(0, nb(v.confiance, 0.9))),
        contexte: typeof v.contexte === "string" && v.contexte.trim() ? v.contexte : null,
        transformation: typeof v.transformation === "string" && v.transformation.trim() ? v.transformation : null,
        derivéDe: typeof v.derive_de === "string" && v.derive_de.trim() ? v.derive_de : null,
      }));

      const verdict = reconcilier(candidats, {
        autorite: str(input, "type_de_fait") === "clause_contractuelle" ? AUTORITE_CLAUSE : AUTORITE_DEFAUT,
      });

      return JSON.stringify({
        ok: true,
        fait: str(input, "fait") || null,
        issue: verdict.issue,
        phrase: direVerdict(verdict),
        detail: verdict,
        a_faire: verdict.issue === "A_CHERCHER"
          ? "Va chercher ce qui est nommé, puis relance la réconciliation. Ne donne PAS de chiffre en attendant."
          : verdict.issue === "A_TRANCHER"
            ? "Pose la question telle quelle, avec les options. N'en choisis aucune."
            : verdict.issue === "PAS_LA_MEME_QUESTION"
              ? "Ne dis pas qu'il y a contradiction : dis que les chiffres ne portent pas sur le même périmètre, et demande lequel est voulu."
              : "Donne la valeur AVEC sa raison et les valeurs écartées — jamais le chiffre seul.",
      });
    },
  },
];
