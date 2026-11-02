/**
 * DEMANDER AU TERRAIN — le PLAN de mission, construit par le code (lot T2, décision 0051). Pur.
 *
 * Une étape DEMANDE par personne (échéance, relance avant l'échéance, abandon 5 jours après), puis un LIVRABLE qui
 * consolide les réponses. Les délais sont relatifs au dépôt des demandes (règle J8 du moteur des travaux).
 */

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const plier = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** « vendredi », « 2026-11-06 », « demain », « dans 4 jours » → un nombre de jours (≥ 1) ; illisible → null. */
export function joursJusqua(echeance: string, maintenant: Date): number | null {
  const e = plier(echeance);
  if (!e) return null;
  if (e === "demain") return 1;
  const dans = /dans\s+(\d+)\s+jours?/.exec(e);
  if (dans) return Math.max(1, Number(dans[1]));
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(e);
  if (iso) {
    const cible = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    const auj = Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), maintenant.getUTCDate());
    return Math.max(1, Math.round((cible - auj) / 86_400_000));
  }
  const j = JOURS.findIndex((x) => e.includes(x));
  if (j >= 0) return ((j - maintenant.getUTCDay() + 7) % 7) || 7;
  return null;
}

export interface DemandesTerrain {
  destinataires: string[];
  question: string;
  jours: number;
  relanceJours?: number | null;
  format: "xlsx" | "docx" | "md";
  titre?: string | null;
}

export function planDemandesTerrain(d: DemandesTerrain) {
  const relanceJours = Math.max(1, Math.min(d.relanceJours ?? (d.jours > 2 ? 2 : 1), d.jours));
  const cles = d.destinataires.map((_, i) => `demande-${i + 1}`);
  const court = d.question.length > 60 ? `${d.question.slice(0, 57)}…` : d.question;
  return {
    relanceJours,
    plan: {
      titre: (d.titre || `Demande terrain — ${court}`).slice(0, 120),
      objectif: `Obtenir de ${d.destinataires.join(", ")} : ${d.question} Relancer sans réponse, puis consolider toutes les réponses.`,
      etapes: [
        ...d.destinataires.map((a, i) => ({
          cle: cles[i], titre: `Demander à ${a}`, type: "DEMANDE",
          demande: { a, question: d.question, jours: d.jours, ...(relanceJours < d.jours ? { relance: { jours: relanceJours } } : {}), abandon: { jours: 5 } },
        })),
        {
          cle: "consolider", titre: "Consolider les réponses", type: "LIVRABLE", apres: cles, format: d.format,
          consigne: `Consolide les réponses reçues en un tableau : une ligne par personne (${d.destinataires.join(", ")}), sa réponse exacte, la date ; marque « sans réponse » qui n'a pas répondu. Question posée : ${d.question}`,
        },
      ],
    },
  };
}
