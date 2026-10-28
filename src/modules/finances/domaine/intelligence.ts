/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INTELLIGENCE FINANCIÈRE — des règles PURES sur des chiffres déjà lus (mandat 4 §27, Finance).
 *
 * Ce module ne lit rien : il reçoit ce que les lectures canoniques savent (une enveloppe et sa
 * consommation, une prévision, des ordres de dépense, des demandes de paiement) et en tire des
 * SIGNAUX datés et gradués : le budget qui file plus vite que le calendrier, la projection de fin
 * de période qui dépasse l'alloué, la prévision incohérente avec le réel déjà constaté, la
 * catégorie déjà dépassée, le justificatif qui manque, l'échéance de paiement qui approche
 * selon sa NATURE (fixe, importante, modérée). Chaque signal dit son calcul : entrées, règle,
 * chiffre — le lecteur peut refaire l'arithmétique.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { RANG_GRAVITE, type Gravite, type Signal } from "@/lib/utils/signaux";

// Le vocabulaire du signal est COMMUN aux trois intelligences (`src/lib/utils/signaux.ts`) ; on le
// réexporte pour que les lecteurs de ce module n'aient qu'une porte.
export { RANG_GRAVITE, resumerSignaux, trierSignaux, type Gravite, type Signal } from "@/lib/utils/signaux";

const arrondi = (n: number, d = 0): number => Math.round(n * 10 ** d) / 10 ** d;
const pct = (n: number): string => `${arrondi(n * 100)} %`;
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const JOUR = 86_400_000;

// ─────────────────────────── Budget : rythme, projection, dépassement ───────────────────────────

export interface EnveloppeLue {
  id: string;
  nom: string;
  alloue: number;
  consomme: number;
  /** Engagé (BC émis non réglés) — compte dans la projection, pas dans le consommé. */
  engage?: number;
  debut: Date | string;
  fin: Date | string;
  /** Une prévision d'atterrissage déclarée, si la société en tient une. */
  prevision?: number | null;
  categories?: { id: string; nom: string; alloue: number; consomme: number }[];
}

export interface SanteBudget {
  tauxTemps: number;
  tauxConsomme: number;
  tauxEngage: number;
  /** Projection linéaire de fin de période : consommé / temps écoulé, plus l'engagé. */
  projectionFin: number | null;
  ecartProjete: number | null;
  sante: "SAIN" | "A_RISQUE" | "DEPASSE" | "SANS_RYTHME";
  calcul: string;
}

/** LA SANTÉ d'une enveloppe : le rythme de consommation comparé au calendrier, et où l'on atterrit si rien ne change. */
export function santeBudget(e: EnveloppeLue, maintenant = new Date()): SanteBudget {
  const debut = new Date(e.debut).getTime(); const fin = new Date(e.fin).getTime(); const t = maintenant.getTime();
  const duree = Math.max(1, fin - debut);
  const tauxTemps = Math.min(1, Math.max(0, (t - debut) / duree));
  const alloue = Math.max(0, e.alloue);
  const tauxConsomme = alloue > 0 ? e.consomme / alloue : e.consomme > 0 ? Infinity : 0;
  const tauxEngage = alloue > 0 ? (e.engage ?? 0) / alloue : 0;
  // Moins de 5 % du temps écoulé : une projection dirait n'importe quoi.
  const projectionFin = tauxTemps >= 0.05 ? e.consomme / tauxTemps + (e.engage ?? 0) : null;
  const ecartProjete = projectionFin !== null && alloue > 0 ? projectionFin - alloue : null;
  let sante: SanteBudget["sante"] = "SAIN";
  if (alloue > 0 && e.consomme > alloue) sante = "DEPASSE";
  else if (projectionFin === null) sante = "SANS_RYTHME";
  else if (alloue > 0 && (projectionFin > alloue * 1.05 || tauxConsomme > tauxTemps + 0.15)) sante = "A_RISQUE";
  const calcul = alloue > 0
    ? `${pct(Math.min(tauxConsomme, 9.99))} consommé à ${pct(tauxTemps)} du temps${e.engage ? `, ${pct(tauxEngage)} engagé` : ""}${projectionFin !== null ? ` → atterrissage ${arrondi(projectionFin).toLocaleString("fr-FR")} sur ${arrondi(alloue).toLocaleString("fr-FR")}` : ""}`
    : "enveloppe sans montant alloué";
  return { tauxTemps, tauxConsomme: Number.isFinite(tauxConsomme) ? tauxConsomme : 9.99, tauxEngage, projectionFin, ecartProjete, sante, calcul };
}

/** LES SIGNAUX d'une enveloppe : dépassement, rythme à risque, catégories dépassées, prévision incohérente. */
export function signauxBudget(e: EnveloppeLue, maintenant = new Date()): Signal[] {
  const s = santeBudget(e, maintenant);
  const out: Signal[] = [];
  const ent = { type: "BudgetEnvelope", id: e.id, ref: e.nom };
  const href = `/budgets?env=${e.id}`;
  if (s.sante === "DEPASSE") {
    out.push({ domaine: "FINANCE", code: "budget_depasse", gravite: "CRITIQUE", titre: `Enveloppe « ${e.nom} » dépassée`, detail: `${arrondi(e.consomme).toLocaleString("fr-FR")} consommés pour ${arrondi(e.alloue).toLocaleString("fr-FR")} alloués (${pct(Math.min(s.tauxConsomme, 9.99))}).`, calcul: s.calcul, montant: e.consomme - e.alloue, entite: ent, href });
  } else if (s.sante === "A_RISQUE") {
    const grave = s.ecartProjete !== null && e.alloue > 0 && s.ecartProjete > e.alloue * 0.2;
    out.push({ domaine: "FINANCE", code: "budget_rythme", gravite: grave ? "HAUTE" : "NORMALE", titre: `Enveloppe « ${e.nom} » : le rythme dépasse le calendrier`, detail: `À ce rythme, l'atterrissage dépasse l'alloué de ${arrondi(s.ecartProjete ?? 0).toLocaleString("fr-FR")}.`, calcul: s.calcul, montant: s.ecartProjete, entite: ent, href });
  }
  for (const c of e.categories ?? []) {
    if (c.alloue > 0 && c.consomme > c.alloue) {
      out.push({ domaine: "FINANCE", code: "categorie_depassee", gravite: c.consomme > c.alloue * 1.25 ? "HAUTE" : "NORMALE", titre: `Catégorie « ${c.nom} » dépassée (${e.nom})`, detail: `${arrondi(c.consomme).toLocaleString("fr-FR")} pour ${arrondi(c.alloue).toLocaleString("fr-FR")} alloués.`, calcul: `${pct(c.consomme / c.alloue)} de l'alloué`, montant: c.consomme - c.alloue, entite: { type: "BudgetCategoryLine", id: c.id, ref: c.nom }, href });
    }
  }
  if (typeof e.prevision === "number" && e.prevision > 0) {
    if (e.prevision < e.consomme) out.push({ domaine: "FINANCE", code: "prevision_incoherente", gravite: "HAUTE", titre: `Prévision « ${e.nom} » sous le réel déjà constaté`, detail: `Prévision ${arrondi(e.prevision).toLocaleString("fr-FR")} < consommé ${arrondi(e.consomme).toLocaleString("fr-FR")} : la prévision n'a pas été mise à jour.`, calcul: "prévision − consommé < 0", montant: e.consomme - e.prevision, entite: ent, href });
    else if (s.projectionFin !== null && s.projectionFin > e.prevision * 1.1) out.push({ domaine: "FINANCE", code: "prevision_optimiste", gravite: "NORMALE", titre: `Prévision « ${e.nom} » optimiste`, detail: `Le rythme actuel projette ${arrondi(s.projectionFin).toLocaleString("fr-FR")}, la prévision dit ${arrondi(e.prevision).toLocaleString("fr-FR")} (+${pct(s.projectionFin / e.prevision - 1)}).`, calcul: s.calcul, montant: s.projectionFin - e.prevision, entite: ent, href });
  }
  return out;
}

// ─────────────────────────── Justificatifs et échéances ───────────────────────────

export interface OrdreLu {
  id: string; reference: string; libelle: string; montant: number; statut: string;
  /** La facture est exigée avant règlement. */
  factureExigee: boolean;
  /** Une facture est CHAÎNÉE à cet ordre (registre Legal). */
  factureLiee: boolean;
  regleLe?: Date | string | null;
  echeance?: Date | string | null;
}

/** LES JUSTIFICATIFS MANQUANTS : un ordre réglé (ou à régler) qui exigeait une facture et n'en a pas. */
export function justificatifsManquants(ordres: readonly OrdreLu[]): Signal[] {
  return ordres
    .filter((o) => o.factureExigee && !o.factureLiee && o.statut !== "CANCELLED" && o.statut !== "REJECTED")
    .map((o) => ({
      domaine: "FINANCE" as const, code: "justificatif_manquant", gravite: (o.regleLe ? "HAUTE" : "NORMALE") as Gravite,
      titre: `${o.regleLe ? "Réglé sans facture" : "Facture exigée, absente"} : ${o.reference}`,
      detail: `${o.libelle} — ${arrondi(o.montant).toLocaleString("fr-FR")} DZD${o.regleLe ? `, réglé le ${iso(new Date(o.regleLe))}` : ""}.`,
      calcul: "factureExigee ∧ ¬factureLiée", montant: o.montant, entite: { type: "ExpenseOrder", id: o.id, ref: o.reference }, href: `/finances/ordres-de-depense?ref=${encodeURIComponent(o.reference)}`,
      // CE QU'IL Y A À FAIRE, ET LE GESTE DÉCLARÉ (§118.127). Le signal voisin `facture_sans_bc`
      // — une facture sans BC — porte son action et son marqueur depuis le début ; celui-ci, qui
      // dit l'inverse (un ordre de dépense sans facture), n'en portait AUCUN. Même famille, même
      // pas suivant, et deux conduites différentes sans raison énonçable : c'est le défaut que
      // §118.5 nomme, et il se voyait en live — « 450 000 DZD réglés sans facture liée » sortait
      // en constat HAUTE et ne proposait rien.
      // Les deux cas ne demandent PAS la même chose, et la phrase le dit : réglé, la facture est
      // due et manque au dossier ; pas encore réglé, elle est la CONDITION du règlement.
      action: o.regleLe
        ? "Obtenir la facture du fournisseur et la rattacher à l'ordre de dépense."
        : "Obtenir la facture avant de régler.",
      // Une TÂCHE est bien le pas suivant : rien ne part, une ligne de suivi existe sur l'ordre
      // nommé. Ce n'est pas un arbitrage — personne n'a à décider SI la facture est due, le
      // `factureExigee` du dossier l'a déjà dit.
      tache: true as const,
    }));
}

export interface PaiementLu {
  id: string; reference: string; libelle: string; montant: number; statut: string;
  echeance: Date | string | null;
  /** FIXED (date imposée), IMPORTANT, MODERATE. */
  nature: string;
}

/** LES ÉCHÉANCES DE PAIEMENT selon leur nature : une date IMPOSÉE devient critique une semaine avant, une échéance modérée un jour avant. */
export function echeancesPaiement(paiements: readonly PaiementLu[], maintenant = new Date(), horizonJours = 30): Signal[] {
  const out: Signal[] = [];
  for (const p of paiements) {
    if (!p.echeance || ["PAID", "SETTLED", "CANCELLED", "REJECTED"].includes(p.statut)) continue;
    const d = new Date(p.echeance);
    const jours = Math.floor((d.getTime() - maintenant.getTime()) / JOUR);
    if (jours > horizonJours) continue;
    const nature = (p.nature || "MODERATE").toUpperCase();
    let gravite: Gravite = "BASSE";
    if (jours < 0) gravite = nature === "FIXED" ? "CRITIQUE" : nature === "IMPORTANT" ? "HAUTE" : "NORMALE";
    else if (nature === "FIXED") gravite = jours <= 7 ? "CRITIQUE" : jours <= 15 ? "HAUTE" : "NORMALE";
    else if (nature === "IMPORTANT") gravite = jours <= 3 ? "HAUTE" : jours <= 10 ? "NORMALE" : "BASSE";
    else gravite = jours <= 1 ? "NORMALE" : "BASSE";
    out.push({
      domaine: "FINANCE", code: jours < 0 ? "paiement_en_retard" : "paiement_echeance", gravite,
      titre: jours < 0 ? `Paiement en retard de ${-jours} j : ${p.reference}` : `Paiement dû dans ${jours} j : ${p.reference}`,
      detail: `${p.libelle} — ${arrondi(p.montant).toLocaleString("fr-FR")} DZD, échéance ${iso(d)} (${nature === "FIXED" ? "date imposée" : nature === "IMPORTANT" ? "importante" : "modérée"}).`,
      calcul: `échéance − aujourd'hui = ${jours} j`, echeance: iso(d), montant: p.montant, entite: { type: "PaymentRequest", id: p.id, ref: p.reference }, href: `/validations/paiements/${p.id}`,
    });
  }
  return out.sort((a, b) => RANG_GRAVITE[a.gravite] - RANG_GRAVITE[b.gravite] || (a.echeance ?? "").localeCompare(b.echeance ?? ""));
}
