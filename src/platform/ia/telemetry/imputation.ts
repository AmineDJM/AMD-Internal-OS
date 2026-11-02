/**
 * L'IMPUTATION HORS TOUR, VUE DU SOCLE (lot K8, trou E9) : un module métier qui sait au nom de qui il travaille la
 * pose ici, et les appels de la passerelle partis de là arrivent au journal avec la personne et l'usage.
 */
export { sousImputation } from "@/lib/models/telemetry";

/** Le journal d'un appel payé hors passerelle (OCR, lots, plongements) — même puits, même table (lot K8). */
export { recordProviderCall } from "@/lib/models/telemetry";
