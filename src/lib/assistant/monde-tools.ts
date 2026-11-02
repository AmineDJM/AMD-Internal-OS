/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'OUTIL DU MODÈLE DU MONDE (mandat 6 §45) — l'entreprise a une histoire, pas seulement un état.
 *
 * ── LES DEUX QUESTIONS QUI N'AVAIENT PAS DE RÉPONSE ─────────────────────────────────────
 *
 *   « Qui était responsable au moment de cette décision ? »
 *   « Qu'est-ce qui a changé depuis mars ? »
 *
 * L'ERP répond à la première par le responsable D'AUJOURD'HUI — c'est-à-dire à côté, avec
 * assurance. La seconde n'avait pas de réponse du tout au niveau d'un dossier : le journal
 * d'audit existait, mais il se lit ligne à ligne, pas comme une histoire.
 *
 * ── CE QUE CET OUTIL REFUSE DE FAIRE ────────────────────────────────────────────────────
 *
 * Compléter les trous. Un champ que rien ne journalise n'a pas de passé : interrogé sur mars, il
 * répond INCONNU, jamais la valeur de septembre. C'est la différence entre un modèle du monde et
 * une extrapolation — et c'est la seule qui compte le jour où quelqu'un relit une décision.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PowerTool } from "@/platform/ia/outil";
import { changementsDe, etatAuMoment, quiEtait, recitDe, vraiEtSu } from "@/platform/in-process/monde";

const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string).trim() : "");

/** Une date de question : « 2026-03-15 », ou une date ISO complète. `null` si illisible. */
function quand(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T23:59:59.999+01:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const jour = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

const direCouverture = (c: { journalises: string[]; sansHistoire: string[]; depuis: Date | null; faits: number }) => ({
  faits_lus: c.faits,
  histoire_depuis: jour(c.depuis),
  proprietes_avec_histoire: c.journalises,
  proprietes_SANS_histoire: c.sansHistoire.length
    ? `${c.sansHistoire.join(", ")} — ces champs ne sont pas journalisés : leur valeur d'aujourd'hui est connue, leur passé NON. Ne l'invente pas.`
    : "aucune",
});

export const MONDE_TOOLS: PowerTool[] = [
  {
    def: {
      name: "monde_temporel",
      description:
        "L'HISTOIRE D'UN DOSSIER, PAS SEULEMENT SON ÉTAT — la vérité à une DATE. "
        + "questions : « qui_etait » (la valeur d'une propriété à un instant précis : « qui était responsable au moment de cette décision ? », « quel était le statut le 15 mars ? ») · "
        + "« etat_a » (tout ce qu'on sait du dossier à une date, AVEC la liste de ce qui reste inconnu à cette date) · "
        + "« changements » (ce qui a changé depuis une date, avec l'AVANT et l'APRÈS de chaque propriété, qui l'a fait et quand) · "
        + "« recit » (la chronologie complète, plus les CONTRADICTIONS que le journal contient — deux valeurs pour la même propriété au même moment) · "
        + "« vrai_et_su » (ce qui était VRAI à cette date et ce qu'on en SAVAIT : une passation saisie en retard change le premier sans changer le second — c'est ce qui permet de juger équitablement une décision de l'époque). "
        + "RÈGLE : un champ non journalisé n'a PAS de passé. L'outil répond INCONNU pour les dates antérieures, et il ne faut jamais compléter par la valeur actuelle.",
      input_schema: {
        type: "object",
        properties: {
          question: { type: "string", enum: ["qui_etait", "etat_a", "changements", "recit", "vrai_et_su"] },
          dossier: { type: "string", description: "La référence, le titre ou le nom du dossier / contrat / paiement / produit / tâche." },
          date: { type: "string", description: "La date de la question (AAAA-MM-JJ). Pour « changements », c'est le DÉBUT de la période." },
          jusqua: { type: "string", description: "changements : la fin de la période (aujourd'hui par défaut)." },
          propriete: { type: "string", description: "qui_etait : la propriété cherchée (responsable, statut, priorite, montant, echeance…)." },
        },
        required: ["question", "dossier"],
      },
    },
    // Aucun droit propre : le PONT vérifie le module du dossier (`userCan(..., VIEW)`) avant de
    // rendre quoi que ce soit, et refuse en le DISANT — « pas le droit » n'est pas « rien trouvé ».
    allowed: () => true,
    label: "Histoire d'un dossier",
    run: async (input, user) => {
      const question = str(input, "question").toLowerCase() || "recit";
      const dossier = str(input, "dossier");
      if (!dossier) return JSON.stringify({ ok: false, erreur: "Précisez le dossier." });
      const d = quand(str(input, "date"));

      if (question === "qui_etait") {
        const propriete = str(input, "propriete") || "responsable";
        if (!d) return JSON.stringify({ ok: false, erreur: "Précisez la date (AAAA-MM-JJ) : c'est toute la question." });
        const r = await quiEtait(user, dossier, propriete, d);
        if ("erreur" in r) return JSON.stringify({ ok: false, ...r });
        return JSON.stringify({
          ok: true, dossier: r.libelle, propriete, date: jour(d),
          reponse: r.fait
            ? { valeur: r.fait.objet, periode: `${jour(r.fait.depuis) ?? "début inconnu"} → ${jour(r.fait.jusqua) ?? "encore en cours"}`, source: r.fait.source, pose_par: r.fait.acteur }
            : null,
          // LE POINT DE L'OUTIL : pas de valeur à cette date ⇒ on le DIT.
          ...(r.fait ? {} : { inconnu: `Le modèle ne sait pas ce que valait « ${propriete} » le ${jour(d)}. Ne réponds pas avec la valeur d'aujourd'hui.` }),
          histoire: r.histoire.map((f) => ({ valeur: f.objet, du: jour(f.depuis), au: jour(f.jusqua), par: f.acteur })),
          couverture: direCouverture(r.couverture),
        });
      }

      if (question === "etat_a") {
        if (!d) return JSON.stringify({ ok: false, erreur: "Précisez la date (AAAA-MM-JJ)." });
        const r = await etatAuMoment(user, dossier, d);
        if ("erreur" in r) return JSON.stringify({ ok: false, ...r });
        return JSON.stringify({
          ok: true, dossier: r.libelle, type: r.type, date: jour(d), lien: r.lien,
          etat: r.etat?.valeurs ?? {},
          sources: r.etat?.sources ?? {},
          inconnu_a_cette_date: r.etat?.inconnus ?? [],
          couverture: direCouverture(r.couverture),
        });
      }

      if (question === "changements") {
        if (!d) return JSON.stringify({ ok: false, erreur: "Précisez la date de début (AAAA-MM-JJ)." });
        const fin = quand(str(input, "jusqua")) ?? undefined;
        const r = await changementsDe(user, dossier, d, fin);
        if ("erreur" in r) return JSON.stringify({ ok: false, ...r });
        return JSON.stringify({
          ok: true, dossier: r.libelle, depuis: jour(d), jusqua: jour(fin ?? new Date()),
          nombre: r.changements.length,
          changements: r.changements.map((c) => ({
            propriete: c.predicat, de: c.avant ?? "(valeur antérieure inconnue)", a: c.apres,
            le: jour(c.quand), par: c.acteur, tient_depuis_jours: c.depuisJours, source: c.source,
          })),
          couverture: direCouverture(r.couverture),
        });
      }

      if (question === "vrai_et_su") {
        if (!d) return JSON.stringify({ ok: false, erreur: "Précisez la date (AAAA-MM-JJ)." });
        const r = await vraiEtSu(user, dossier, d);
        if ("erreur" in r) return JSON.stringify({ ok: false, ...r });
        return JSON.stringify({
          ok: true, dossier: r.libelle, date: jour(d),
          vrai_a_cette_date: r.vrai.map((f) => `${f.predicat} : ${f.objet}`),
          su_a_cette_date: r.su.map((f) => `${f.predicat} : ${f.objet}`),
          vrai_mais_pas_encore_su: r.vraiMaisIgnore.map((f) => `${f.predicat} : ${f.objet} (saisi le ${jour(f.constateLe)}, vrai depuis le ${jour(f.depuis)})`),
          lecture: r.vraiMaisIgnore.length
            ? "Une décision prise ce jour-là ne pouvait PAS tenir compte de ces faits : ils n'étaient pas encore saisis. C'est un fait d'organisation, pas une faute de la personne."
            : "Tout ce qui était vrai ce jour-là était déjà connu.",
          couverture: direCouverture(r.couverture),
        });
      }

      const r = await recitDe(user, dossier);
      if ("erreur" in r) return JSON.stringify({ ok: false, ...r });
      return JSON.stringify({
        ok: true, dossier: r.libelle, lien: r.lien, cree_le: jour(r.creeLe),
        chronologie: r.chronologie.map((x) => ({ le: jour(x.quand), quoi: x.texte, source: x.source })),
        contradictions: r.contradictions.map((c) => ({
          propriete: c.predicat, periode: c.periode,
          valeurs: c.faits.map((f) => `${f.objet} (${f.source})`),
          suite: c.suite,
        })),
        couverture: direCouverture(r.couverture),
      });
    },
  },
];
