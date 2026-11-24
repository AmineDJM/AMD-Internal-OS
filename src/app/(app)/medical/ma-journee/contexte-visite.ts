import type { Lettre } from "@/lib/segmentation/regles";
import type { ContexteVisite, DerniereVisiteVue } from "./types-visite";

/** La fréquence d'un praticien du panel, ce mois (`loadMyFieldDay().frequences`). */
export interface FrequenceVue {
  doctorId: string;
  faites: number;
  attendues: number;
  lettre: string | null;
}

/**
 * CE QUE LA FEUILLE « VISITE » SAIT EN PLUS D'UN PRATICIEN — sa lettre, « n / m visites ce mois », ses deux
 * dernières visites rapportées. Indexé une fois pour toute la liste ; la liste du jour et les onglets secondaires
 * lisent le même index, donc la même feuille.
 */
export function indexerContextes(frequences: readonly FrequenceVue[], dernieres: readonly DerniereVisiteVue[]) {
  const parFrequence = new Map(frequences.map((f) => [f.doctorId, f]));
  const parPraticien = new Map<string, DerniereVisiteVue[]>();
  for (const d of dernieres) parPraticien.set(d.doctorId, [...(parPraticien.get(d.doctorId) ?? []), d]);
  const lettreDe = (doctorId: string | null | undefined): Lettre | null =>
    (doctorId ? (parFrequence.get(doctorId)?.lettre as Lettre | null | undefined) : null) ?? null;
  const contexteDe = (doctorId: string | null | undefined, lettre: Lettre | null = null): ContexteVisite => {
    const f = doctorId ? parFrequence.get(doctorId) : undefined;
    return {
      lettre: lettre ?? lettreDe(doctorId),
      frequence: f ? { faites: f.faites, attendues: f.attendues } : null,
      dernieres: doctorId ? parPraticien.get(doctorId) ?? [] : [],
    };
  };
  return { lettreDe, contexteDe };
}
