import { observer, type Observation } from "./contrat";
import { lectureDeSortie } from "./projecteurs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONTRÔLE FINAL D'UNE MISSION (lot I4, décision 0067 ; amorce du lot I5) — PUR, sur le contrat Observation d'I1.
 *
 * Production, 04/11/2026 : « Cartographie des chefs de service d'infectiologie » livrée en un tableur d'UNE ligne « Non
 * disponible » partout, alors que l'annuaire portait les praticiens. Rien ne comparait ce qui était LIVRÉ à ce qui avait été
 * LU. La règle, ici, est dans le code : un livrable dont aucune ligne ne vient d'une lecture RÉUSSIE est un ÉCHEC, avec sa
 * raison (quelle lecture, combien de lignes, quel droit manquait) — jamais « livré ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce qu'une étape LECTURE a rendu, tel que le moteur l'a gardé. */
export interface LectureDeMission { cle: string; titre: string; outil: string; statut: string; sortie: unknown; erreur?: string | null }

/** L'OBSERVATION d'une lecture de mission : LU (avec son nombre de lignes) ou ÉCHEC (avec sa raison). */
export function observerLecture(l: LectureDeMission, maintenant = new Date()): Observation {
  if (l.statut !== "DONE") return observer("lecture", { type: "lecture", id: l.cle, lien: null }, "ECHEC", { titre: l.titre, source: l.outil, erreur: l.erreur ?? "lecture non aboutie" }, maintenant);
  const o = lectureDeSortie(l.outil, l.titre, typeof l.sortie === "string" ? l.sortie : JSON.stringify(l.sortie ?? null));
  const filtres = (l.sortie as { filtresAppliques?: unknown } | null)?.filtresAppliques;
  return observer("lecture", { type: "lecture", id: l.cle, lien: null }, "LU", {
    titre: l.titre, source: l.outil,
    // Une sortie qui n'est pas un tableau : pas une lecture tabulaire (un texte, une recherche web) — elle ne compte pas de lignes.
    lignes: o ? Number(o.projection.lignes ?? 0) : typeof (l.sortie as { total?: unknown })?.total === "number" ? Number((l.sortie as { total: number }).total) : null,
    filtres: Array.isArray(filtres) ? filtres.map(String) : undefined,
  }, maintenant);
}

export type VerdictLivrable = { ok: true; lignesLues: number } | { ok: false; raison: string };

/**
 * LE VERDICT : un tableur doit porter des lignes LUES ; et dès qu'une mission a des lectures tabulaires, l'une au moins doit
 * avoir rendu une ligne. Sinon : échec, dit lecture par lecture.
 */
export function controlerLivrable(lectures: readonly Observation[], livrable: { format: string; lignes: number | null }): VerdictLivrable {
  const tabulaires = lectures.filter((o) => typeof o.projection.lignes === "number" || o.etat === "ECHEC");
  const lues = tabulaires.reduce((s, o) => s + (o.etat === "LU" ? Number(o.projection.lignes ?? 0) : 0), 0);
  const exigeDesLignes = livrable.format === "xlsx" || tabulaires.length > 0;
  if (!exigeDesLignes || (lues > 0 && (livrable.format !== "xlsx" || (livrable.lignes ?? 0) > 0))) return { ok: true, lignesLues: lues };
  const detail = tabulaires.length
    ? tabulaires.map((o) => `« ${String(o.projection.titre ?? o.objet.id)} » (${String(o.projection.source ?? "?")}) : ${o.etat === "ECHEC" ? `échec — ${String(o.projection.erreur ?? "")}` : `${Number(o.projection.lignes ?? 0)} ligne(s)${Array.isArray(o.projection.filtres) && o.projection.filtres.length ? ` (filtres : ${o.projection.filtres.join(" · ")})` : ""}`}`).join(" ; ")
    : "aucune étape LECTURE n'a rendu de tableau";
  return { ok: false, raison: `Livrable refusé : aucune ligne issue d'une lecture réussie — ${detail}. Élargissez les filtres ou demandez le droit qui manque ; rien n'est déclaré livré.` };
}
