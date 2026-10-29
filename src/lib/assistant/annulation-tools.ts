/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'OUTIL D'ANNULATION (mandat 6 §48) — « annule ce qu'Adam a modifié sur ce dossier hier ».
 *
 * ── DEUX TEMPS, ET LE PREMIER N'ÉCRIT RIEN ──────────────────────────────────────────────
 *
 * « voir » compose le plan et le montre : ce qui peut être défait, ce qui ne le peut pas, et
 * pourquoi. « appliquer » exécute, et seulement ce que « voir » a montré. Ce n'est pas une
 * précaution d'usage : une annulation porte sur des gestes que la personne a oubliés — c'est
 * précisément pour cela qu'elle demande d'annuler — et lui montrer la liste est la seule
 * façon qu'elle découvre l'e-mail parti avant de croire qu'il ne l'est plus.
 *
 * ── CE QUE L'OUTIL NE DIRA JAMAIS ───────────────────────────────────────────────────────
 *
 * « C'est annulé », quand ça ne l'est qu'en partie. Le compte rendu est arithmétique et la
 * phrase de conclusion est calculée, pas rédigée : « 4 défaits, 3 non défaisables, ce n'est
 * PAS une annulation complète ». Le modèle reçoit cette phrase et n'a pas à l'inventer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PowerTool } from "@/platform/ia/outil";
import { appliquerAnnulation, preparerAnnulation } from "@/platform/in-process/annulation";

type Acteur = Parameters<PowerTool["run"]>[1];

const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string).trim() : "");

/** Une date de journal, ou un repli explicite : sept jours, et on le DIT dans la réponse. */
const depuisOu = (s: string): { date: Date; parDefaut: boolean } => {
  if (s) {
    const d = new Date(s.length === 10 ? `${s}T00:00:00.000Z` : s);
    if (!Number.isNaN(d.getTime())) return { date: d, parDefaut: false };
  }
  return { date: new Date(Date.now() - 7 * 86_400_000), parDefaut: true };
};

const rendre = (plan: Awaited<ReturnType<typeof preparerAnnulation>>) => {
  if ("erreur" in plan) return plan;
  return {
    resume: plan.plan.resume,
    a_defaire: plan.plan.gestes.map((g) => ({ id: g.changementId, quoi: g.libelle, quand: g.quand.toISOString().slice(0, 10) })),
    ne_peut_pas_etre_defait: plan.plan.ecartes.map((e) => ({
      id: e.changementId, nature: e.nature, motif: e.motif, pourquoi: e.explication,
      ...(e.compensation ? { a_la_place: e.compensation } : {}),
      ...(e.delegueA ? { delegue_a: e.delegueA } : {}),
    })),
  };
};

export const ANNULATION_TOOLS: PowerTool[] = [
  {
    def: {
      name: "annuler_changements",
      description:
        "DÉFAIRE CE QUI A ÉTÉ FAIT — « annule ce qu'Adam a modifié sur ce dossier hier ». "
        + "questions : « voir » (compose le plan SANS RIEN ÉCRIRE : ce qui peut être défait, ce qui ne le peut pas et POURQUOI, ce qu'on peut faire à la place) · "
        + "« appliquer » (exécute, en ne touchant QUE ce que « voir » a montré ; passer `changements` pour n'en reprendre qu'une partie). "
        + "GARANTIE CENTRALE : un champ que quelqu'un a modifié depuis n'est JAMAIS écrasé — le geste est refusé en nommant qui l'a changé et quand. "
        + "Un e-mail parti, un paiement exécuté, un dépôt à l'autorité ne se défont pas : l'outil le dit et propose la compensation. "
        + "Une annulation est elle-même un changement journalisé, jamais une gomme sur l'histoire.",
      input_schema: {
        type: "object",
        properties: {
          question: { type: "string", enum: ["voir", "appliquer"] },
          entite: { type: "string", enum: ["REGULATORY_PRODUCT", "TASK", "LEGAL_DOCUMENT", "EXPENSE_ORDER", "PAYMENT_REQUEST"], description: "Le type d'enregistrement visé." },
          enregistrement: { type: "string", description: "L'identifiant de l'enregistrement. Le périmètre est TOUJOURS un enregistrement : « annule tout » n'est pas une demande recevable." },
          depuis: { type: "string", description: "Début de la période (AAAA-MM-JJ). Par défaut : il y a 7 jours, et la réponse le précise." },
          jusqua: { type: "string", description: "Fin de la période (AAAA-MM-JJ). Par défaut : maintenant." },
          tout_le_monde: { type: "boolean", description: "Prendre aussi les changements faits par des personnes (défaut : seulement ceux d'Adam)." },
          changements: { type: "array", items: { type: "string" }, description: "appliquer : n'exécuter que ces identifiants de changement, pris dans « a_defaire »." },
        },
        required: ["question", "entite", "enregistrement"],
      },
    },
    // Aucun droit propre : le PONT vérifie `VIEW` sur le module de l'entité pour l'aperçu et
    // `UPDATE` pour l'écriture, module par module — la même porte que l'écran correspondant.
    allowed: () => true,
    label: "Annuler des changements",
    run: async (input: Record<string, unknown>, user: Acteur) => {
      const question = str(input, "question").toLowerCase() || "voir";
      const entite = str(input, "entite");
      const id = str(input, "enregistrement");
      if (!entite || !id) return JSON.stringify({ ok: false, erreur: "Précisez le type et l'identifiant de l'enregistrement." });

      const d = depuisOu(str(input, "depuis"));
      const fin = str(input, "jusqua");
      const portee = {
        entite, entiteId: id, depuis: d.date,
        jusqua: fin ? new Date(fin.length === 10 ? `${fin}T23:59:59.999Z` : fin) : null,
        adamSeulement: input.tout_le_monde !== true,
      };
      const periode = d.parDefaut ? { periode: "aucune date donnée : les 7 derniers jours" } : {};

      if (question === "voir") {
        const r = await preparerAnnulation(user, portee);
        if ("erreur" in r) return JSON.stringify({ ok: false, ...r });
        return JSON.stringify({
          ok: true, ...periode, ...rendre(r),
          suite: "Montre cette liste À LA PERSONNE avant d'appliquer. Ce qui ne peut pas être défait est souvent ce qu'elle a besoin de savoir.",
        });
      }

      const choisis = Array.isArray(input.changements) ? (input.changements as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
      const r = await appliquerAnnulation(user, portee, choisis);
      if ("erreur" in r) return JSON.stringify({ ok: false, ...r });
      return JSON.stringify({
        ok: true, ...periode,
        // LA PHRASE EST CALCULÉE, pas rédigée : elle ne peut pas dire « annulé » à tort.
        resultat: r.compteRendu.resume,
        defaits: r.compteRendu.defaits,
        refuses_a_l_ecriture: r.compteRendu.echoues.map((e) => e.pourquoi),
        non_defaisables: r.plan.ecartes.map((e) => `${e.explication}${e.compensation ? ` — à la place : ${e.compensation}` : ""}`),
        rappel: "Chaque annulation appliquée est elle-même journalisée : l'histoire s'allonge, elle ne se réécrit pas.",
      });
    },
  },
];
