import type { AdProItemKind } from "@prisma/client";
import { jourLisible, nomComplet, porteDesVoyageurs } from "./voyageurs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'HÔTELLERIE D'UN POSTE : QUI EST LOGÉ, OÙ, QUAND (Direction, 06/10).
 *
 * « Si c'est la prise en charge de l'hôtellerie, on fait une fiche hôtellerie pour chaque
 * personne. Dans le cas où la prise en charge est dans un sponsoring indirect, les fiches
 * hôtellerie et voyageur par personne ne sont pas obligatoires. »
 *
 * Module PUR (sûr pour le navigateur) : la lecture d'une fiche saisie, les nuits, la ligne lue,
 * ce qui a changé, et la RÈGLE « une fiche par personne avant de soumettre » — partagée par
 * l'action (`canSubmitItem`) et la carte (`prochainPas`), pour que l'écran ne propose jamais
 * « Soumettre » quand l'action refuserait (§118.83).
 *
 * Même forme que le voyageur : un nom OBLIGATOIRE, tout le reste facultatif — on loge un médecin
 * avant de connaître l'hôtel. Le nom se saisit (suggestions de la demande), il ne se rattache
 * jamais à une fiche d'annuaire par ressemblance (§118.85).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les natures dont le poste porte des fiches hôtellerie. FERMÉE : la Direction a parlé de l'hôtellerie. */
export const NATURES_A_HEBERGEMENTS = ["ACCOMMODATION"] as const satisfies readonly AdProItemKind[];

export function porteDesHebergements(kind: AdProItemKind | string): boolean {
  return (NATURES_A_HEBERGEMENTS as readonly string[]).includes(kind);
}

/** Les types de chambre PROPOSÉS — un libellé libre reste accepté (l'hôtel a ses propres mots). */
export const TYPES_CHAMBRE = ["Single", "Double", "Twin", "Suite"] as const;

export interface SaisieHebergement {
  nom: string | null;
  prenom?: string | null;
  hotel?: string | null;
  ville?: string | null;
  /** AAAA-MM-JJ ; vide = pas encore connue. */
  dateArrivee?: string | null;
  dateDepart?: string | null;
  typeChambre?: string | null;
  notes?: string | null;
}

export interface HebergementLu {
  nom: string;
  prenom: string | null;
  hotel: string | null;
  ville: string | null;
  dateArrivee: Date | null;
  dateDepart: Date | null;
  typeChambre: string | null;
  notes: string | null;
}

const JOUR = /^\d{4}-\d{2}-\d{2}$/;

function lireJour(v: string | null | undefined): { ok: true; date: Date | null } | { ok: false } {
  const t = (v ?? "").trim();
  if (!t) return { ok: true, date: null };
  if (!JOUR.test(t)) return { ok: false };
  const d = new Date(`${t}T00:00:00.000Z`);
  // « 2026-02-31 » a la forme mais n'existe pas : refusé plutôt qu'écrit au 3 mars.
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? { ok: false } : { ok: true, date: d };
}

const texte = (v: string | null | undefined, max = 200) => {
  const t = (v ?? "").trim();
  return t ? t.slice(0, max) : null;
};

/** Lit une fiche hôtellerie saisie. Tout ce qui ne va pas se dit en une fois (§118.18). */
export function lireHebergement(s: SaisieHebergement): { ok: true; hebergement: HebergementLu } | { ok: false; error: string } {
  const fautes: string[] = [];
  const nom = texte(s.nom, 160);
  if (!nom) fautes.push("le nom de famille");
  const arrivee = lireJour(s.dateArrivee);
  const depart = lireJour(s.dateDepart);
  if (!arrivee.ok) fautes.push("une date d'arrivée lisible (AAAA-MM-JJ)");
  if (!depart.ok) fautes.push("une date de départ lisible (AAAA-MM-JJ)");
  if (fautes.length) return { ok: false, error: `Fiche hôtellerie incomplète — il manque ${fautes.join(", ")}.` };
  const dA = arrivee.ok ? arrivee.date : null;
  const dD = depart.ok ? depart.date : null;
  if (dA && dD && dD.getTime() < dA.getTime()) return { ok: false, error: "La date de départ de l'hôtel précède la date d'arrivée." };
  return {
    ok: true,
    hebergement: {
      nom: nom!, prenom: texte(s.prenom, 160), hotel: texte(s.hotel, 160), ville: texte(s.ville, 120),
      dateArrivee: dA, dateDepart: dD, typeChambre: texte(s.typeChambre, 60), notes: texte(s.notes, 1000),
    },
  };
}

/** Le nombre de NUITS — dérivé des deux dates, jamais saisi ; `null` tant qu'une date manque. */
export function nuitsDe(h: { dateArrivee: Date | null; dateDepart: Date | null }): number | null {
  if (!h.dateArrivee || !h.dateDepart) return null;
  return Math.max(0, Math.round((h.dateDepart.getTime() - h.dateArrivee.getTime()) / 86_400_000));
}

/** « 3 nuits », « 1 nuit », « nuits à confirmer ». */
export function nuitsLisibles(h: { dateArrivee: Date | null; dateDepart: Date | null }): string {
  const n = nuitsDe(h);
  return n == null ? "nuits à confirmer" : `${n} nuit${n > 1 ? "s" : ""}`;
}

/** LA LIGNE QU'ON LIT — une personne logée, ce qu'on sait ; ce qui manque se lit « à confirmer ». */
export function ligneHebergement(h: HebergementLu & { pieceIdentite?: boolean }): string {
  const lieu = [h.hotel, h.ville].filter(Boolean).join(", ") || "hôtel à confirmer";
  const chambre = h.typeChambre ? ` — chambre ${h.typeChambre}` : "";
  const piece = h.pieceIdentite ? " — pièce d'identité jointe" : "";
  return `• ${nomComplet(h)} — ${lieu} — du ${jourLisible(h.dateArrivee)} au ${jourLisible(h.dateDepart)} (${nuitsLisibles(h)})${chambre}${piece}${h.notes ? ` — ${h.notes}` : ""}`;
}

/** CE QUI A CHANGÉ SUR UNE FICHE — pour l'audit. Vide = rien n'a bougé. */
export function changementsHebergement(avant: HebergementLu, apres: HebergementLu): string[] {
  const out: string[] = [];
  const t = (v: string | null) => v ?? "—";
  const memeJour = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
  if (nomComplet(avant) !== nomComplet(apres)) out.push(`nom : ${nomComplet(avant)} → ${nomComplet(apres)}`);
  if (avant.hotel !== apres.hotel) out.push(`hôtel : ${t(avant.hotel)} → ${t(apres.hotel)}`);
  if (avant.ville !== apres.ville) out.push(`ville : ${t(avant.ville)} → ${t(apres.ville)}`);
  if (!memeJour(avant.dateArrivee, apres.dateArrivee)) out.push(`arrivée : ${jourLisible(avant.dateArrivee)} → ${jourLisible(apres.dateArrivee)}`);
  if (!memeJour(avant.dateDepart, apres.dateDepart)) out.push(`départ : ${jourLisible(avant.dateDepart)} → ${jourLisible(apres.dateDepart)}`);
  if (avant.typeChambre !== apres.typeChambre) out.push(`chambre : ${t(avant.typeChambre)} → ${t(apres.typeChambre)}`);
  if ((avant.notes ?? "") !== (apres.notes ?? "")) out.push(`précisions : ${apres.notes ?? "retirées"}`);
  return out;
}

/**
 * CHANGER LA NATURE D'UN POSTE QUI PORTE DES FICHES — `null` si permis. Une billetterie qui a des
 * voyageurs, une hôtellerie qui a des fiches hôtellerie gardent leur nature : sous une autre, les
 * fiches ne s'afficheraient plus (sans être perdues) et la réservation partirait sur un poste qui
 * ne les montre pas. Le refus nomme le geste qui le lève.
 */
export function refusChangementNatureFiches(
  avant: AdProItemKind | string, apres: AdProItemKind | string, n: { voyageurs: number; hebergements: number },
): string | null {
  if (avant === apres) return null;
  if (porteDesVoyageurs(avant) && !porteDesVoyageurs(apres) && n.voyageurs > 0) {
    return `Ce poste de billetterie porte ${n.voyageurs} voyageur${n.voyageurs > 1 ? "s" : ""} : retirez-les d'abord pour changer sa nature.`;
  }
  if (porteDesHebergements(avant) && !porteDesHebergements(apres) && n.hebergements > 0) {
    return `Ce poste d'hôtellerie porte ${n.hebergements} fiche${n.hebergements > 1 ? "s" : ""} hôtellerie : retirez-les d'abord pour changer sa nature.`;
  }
  return null;
}

/**
 * UNE FICHE PAR PERSONNE AVANT DE SOUMETTRE (Direction, 06/10) — `null` si le poste se soumet,
 * sinon la phrase. Une billetterie demande au moins un voyageur, une hôtellerie au moins une
 * fiche hôtellerie — SAUF dans un sponsoring indirect : la prise en charge passe par un tiers,
 * les fiches restent possibles mais ne sont pas exigées. `fichesPersonnes` inconnu (`undefined`)
 * = l'appelant ne l'a pas compté : on ne refuse pas sur un trou.
 */
export function refusFichesPersonnes(r: { kind: AdProItemKind | string; fichesPersonnes?: number; priseEnChargeIndirecte?: boolean }): string | null {
  if (r.priseEnChargeIndirecte) return null;
  if (r.fichesPersonnes === undefined || r.fichesPersonnes > 0) return null;
  if (porteDesVoyageurs(r.kind)) return "Ajoutez au moins un voyageur pour soumettre ce poste de billetterie.";
  if (porteDesHebergements(r.kind)) return "Ajoutez au moins une fiche hôtellerie pour soumettre ce poste d'hôtellerie.";
  return null;
}
