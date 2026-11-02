/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'OUTIL DE VÉRIFICATION ET D'APPRENTISSAGE (mandat 6 §49).
 *
 * ── CE QUE CET OUTIL EMPÊCHE ADAM DE FAIRE ──────────────────────────────────────────────
 *
 * Se déclarer sûr. « verifier » ne rend jamais « c'est vrai » : il rend CONFIRME (« aucune des
 * méthodes appliquées ne l'a contredit »), CONTREDIT, DOUTE ou NON_VERIFIE, et il donne à
 * chaque fois les ANGLES MORTS — y compris ceux des méthodes qu'il n'a pas appliquées.
 *
 * Il empêche aussi Adam de vérifier au hasard : le programme est calculé à partir du risque, et
 * une méthode inapplicable n'est jamais proposée. Une vérification qu'on ne pouvait pas faire et
 * qu'on compte comme faite est la façon dont un tableau de bord finit par afficher 100 % de
 * couverture sans rien couvrir.
 *
 * ── « leçons » NE CHANGE RIEN ───────────────────────────────────────────────────────────
 *
 * Il LIT les échecs déjà journalisés et propose. Aucune branche de cet outil n'écrit une règle,
 * un routage ou une description. §118.12 : ce qu'Adam a observé n'est pas ce qu'un humain a
 * approuvé, et seul l'approuvé fait autorité.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PowerTool } from "@/platform/ia/outil";
import {
  apprendreDesEchecs, conclureVerification, planifierVerification,
  FICHES, SENS_ACTION, type Methode, type Resultat,
} from "@/platform/in-process/verification";

type Acteur = Parameters<PowerTool["run"]>[1];

const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string).trim() : "");
const nb = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const VERIFICATION_TOOLS: PowerTool[] = [
  {
    def: {
      name: "verifier_avant_de_dire",
      description:
        "COMBIEN VÉRIFIER, ET COMMENT — avant d'affirmer quelque chose qui engage. "
        + "questions : « programme » (calcule le niveau de vérification à partir du RISQUE — irréversibilité, exposition, montant, échéance, et surtout la FRAGILITÉ DE L'OBTENTION — puis dit quelles méthodes appliquer et ce qu'elles ne verront PAS) · "
        + "« conclure » (combine les résultats des méthodes : un recalcul qui contredit l'emporte sur quatre confirmations ; un second modèle en désaccord ne tranche pas ; une méthode qui n'a pas pu tourner ne confirme RIEN) · "
        + "« lecons » (ce que les échecs répétés proposent de changer — un eval à écrire, une description à préciser, un routage à revoir ; PROPOSITIONS qui attendent un accord humain, rien ne s'applique tout seul). "
        + "À utiliser AVANT un chiffre qui part chez un partenaire, un montant à payer, un dépôt réglementaire. "
        + "Une vérification qui passe ne veut jamais dire « c'est vrai » : elle veut dire « rien de ce que j'ai su faire ne l'a contredit ».",
      input_schema: {
        type: "object",
        properties: {
          question: { type: "string", enum: ["programme", "conclure", "lecons"] },
          affirmation: { type: "string", description: "Ce qui va être affirmé, en français." },
          obtention: {
            type: "string",
            enum: ["LECTURE_DIRECTE", "CALCUL_DETERMINISTE", "AGREGATION", "EXTRACTION_STRUCTUREE", "LECTURE_PAR_MODELE", "ASSERTION_MODELE"],
            description: "COMMENT le résultat a été obtenu. Le facteur le plus prédictif — être honnête ici est tout l'intérêt de l'outil.",
          },
          exposition: { type: "string", enum: ["MOI", "EQUIPE", "DIRECTION", "PARTENAIRE", "AUTORITE"], description: "Qui verra le résultat." },
          reversible: { type: "boolean", description: "L'effet est-il défaisable ? Un e-mail parti ne l'est pas." },
          montant_dzd: { type: "number", description: "Le montant en jeu, s'il y en a un." },
          echeance_engagee: { type: "boolean", description: "Un délai réglementaire ou contractuel est-il engagé ?" },
          cardinalite: { type: "number", description: "Le nombre d'éléments concernés." },
          indisponibles: { type: "array", items: { type: "string" }, description: "Les méthodes qu'on ne peut pas appliquer ici — elles sortent du programme au lieu d'être comptées pour acquises." },
          resultats: {
            type: "array",
            description: "conclure : ce que chaque méthode a donné. `accord: null` = elle n'a pas pu s'exécuter.",
            items: {
              type: "object",
              properties: {
                methode: { type: "string" },
                accord: { type: "boolean" },
                non_executee: { type: "boolean", description: "Vrai si la méthode n'a pas pu tourner." },
                constat: { type: "string" },
                trouve: { type: "string" },
              },
              required: ["methode", "constat"],
            },
          },
          jours: { type: "number", description: "lecons : la fenêtre d'observation (défaut 30 jours)." },
        },
        required: ["question"],
      },
    },
    // Aucun droit propre : « programme » et « conclure » ne LISENT RIEN — ils raisonnent sur ce
    // que l'appelant décrit. « lecons » lit le journal des missions, cloisonné PAR REQUÊTE sur
    // `mission.ownerId` : on ne voit jamais les échecs des missions d'autrui.
    allowed: () => true,
    label: "Vérification proportionnée",
    run: async (input: Record<string, unknown>, user: Acteur) => {
      const question = str(input, "question").toLowerCase() || "programme";

      if (question === "lecons") {
        const f = await apprendreDesEchecs(user, nb(input.jours) ?? 30);
        return JSON.stringify({
          ok: true,
          resume: f.resume,
          assiette: `${f.periode.echecs} échec(s) classés lus depuis le ${f.periode.depuis.toISOString().slice(0, 10)}`,
          a_decider: f.aDecider.map((l) => ({
            quoi: l.proposition, action: l.action, ce_que_ca_veut_dire: SENS_ACTION[l.action],
            occurrences: l.occurrences, exemples: l.exemples,
            a_approuver_par: l.aApprouverPar,
            ...(l.corrections.length ? { corrections_humaines: l.corrections } : {}),
          })),
          observe_sans_conclure: f.sousSurveillance.map((l) => `${l.cle} — ${l.occurrences} fois (sous le seuil)`),
          evals_a_ecrire: f.evals,
          rappel: "Ce sont des PROPOSITIONS. Rien ici ne s'applique tout seul, et aucune leçon ne peut ouvrir un droit — au mieux elle propose de poser la question.",
        });
      }

      const a = {
        quoi: str(input, "affirmation") || "l'affirmation en cours",
        obtention: (str(input, "obtention") || "ASSERTION_MODELE") as never,
        exposition: (str(input, "exposition") || "EQUIPE") as never,
        reversible: input.reversible !== false,
        montantDzd: nb(input.montant_dzd),
        echeanceEngagee: input.echeance_engagee === true,
        cardinalite: nb(input.cardinalite),
      };
      const indisponibles = (Array.isArray(input.indisponibles) ? input.indisponibles : [])
        .filter((x): x is string => typeof x === "string")
        .filter((x): x is Methode => x in FICHES) as Methode[];
      const plan = planifierVerification(a, indisponibles);

      if (question === "programme") {
        return JSON.stringify({
          ok: true,
          niveau: plan.evaluation.niveau,
          pourquoi: `${plan.evaluation.score} points — facteur principal : ${plan.evaluation.principal}`,
          facteurs: plan.evaluation.facteurs,
          methodes: plan.programme.methodes.map((m) => ({
            methode: m, attrape: FICHES[m].attrape, ne_voit_pas: FICHES[m].aveugleA,
            un_echec_prouve: FICHES[m].concluantEnEchec,
          })),
          justification: plan.programme.justification,
          angles_morts: plan.programme.anglesMorts,
          ce_que_ce_ne_sera_pas: plan.evaluation.limites,
        });
      }

      const bruts = Array.isArray(input.resultats) ? (input.resultats as Record<string, unknown>[]) : [];
      const resultats: Resultat[] = bruts
        .filter((r) => typeof r.methode === "string" && (r.methode as string) in FICHES)
        .map((r) => ({
          methode: r.methode as Methode,
          accord: r.non_executee === true ? null : r.accord === true,
          constat: typeof r.constat === "string" ? r.constat : "",
          trouve: typeof r.trouve === "string" ? r.trouve : null,
        }));
      const v = conclureVerification(plan, resultats);
      return JSON.stringify({
        ok: true,
        issue: v.issue,
        // LA PHRASE EST CALCULÉE : elle ne peut pas dire « c'est vrai ».
        a_dire: v.phrase,
        desaccords: v.desaccords,
        angles_morts: v.anglesMorts,
        rappel: "Rapporte l'issue TELLE QUELLE. « CONFIRME » veut dire qu'aucune méthode ne l'a contredit — pas que c'est vrai.",
      });
    },
  },
];
