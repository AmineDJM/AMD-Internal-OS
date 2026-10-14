/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FICHES DE VOYAGE CHEZ L'ASSISTANTE — la règle, PURE (Direction, 14/10/2026).
 *
 * « Après avoir rempli les fiches d'hôtellerie et de billetterie, on doit pouvoir les envoyer à
 * l'assistante de direction en un clic, chacune indépendamment. Si on l'a déjà fait, ça indique que
 * c'est déjà chez elle ; on peut la relancer. »
 *
 * Une FICHE (un billet, ou un hôtel) a UN état, lu par les deux écrans — le poste du demandeur et
 * l'onglet « Ad & Pro » du Bureau du secrétariat :
 *
 *     Brouillon (il manque) → Prête → Chez l'assistante → Prise → Devis reçu → Réservée
 *     branches : Manque signalé (revient « à compléter »), Modifiée après l'envoi (« à renvoyer »), Retirée
 *
 * Ce module n'importe RIEN qui ait une valeur (types seulement) : l'écran client et l'action serveur
 * le lisent tous deux, et un import lourd ici casserait la compilation du navigateur (CLAUDE.md,
 * frontière client / serveur). Les faits (la base) sont lus ailleurs (`reservation-fiche/fiches.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import type { BadgeTone } from "@/lib/labels";

export type NatureFiche = "BILLET" | "HOTEL";

/** D'où vient la fiche : un voyageur d'un poste Ad & Pro, une fiche hôtellerie, ou un poste d'une prise en charge. */
export type SourceFiche = "VOYAGEUR" | "HEBERGEMENT" | "CARE_CELL";

/** L'état PERSISTÉ d'une demande (enum `EtatDemandeReservation`). */
export type EtatDemande =
  | "ENVOYEE" | "PRISE" | "DEVIS_RECU" | "RESERVEE" | "MANQUE_SIGNALE" | "MODIFIEE_APRES_ENVOI" | "RETIREE";

export const ETATS_DEMANDE: readonly EtatDemande[] = [
  "ENVOYEE", "PRISE", "DEVIS_RECU", "RESERVEE", "MANQUE_SIGNALE", "MODIFIEE_APRES_ENVOI", "RETIREE",
];

/** L'état AFFICHÉ d'une fiche : avant tout envoi, elle est un brouillon (il manque) ou prête. */
export type EtatFiche = "BROUILLON" | "PRETE" | EtatDemande;

/** Les états où la fiche est « chez l'assistante » : elle la traite, et elle se relance. */
export const ETATS_CHEZ_ELLE: readonly EtatDemande[] = ["ENVOYEE", "PRISE", "DEVIS_RECU"];

export const estChezElle = (e: EtatFiche | null | undefined): boolean => (ETATS_CHEZ_ELLE as readonly string[]).includes(e ?? "");

/** Une relance au plus par 24 h (décision du 14/10). */
export const DELAI_RELANCE_MS = 24 * 3600 * 1000;

// ───────────────────────────── Libellés ─────────────────────────────

/** Le libellé côté DEMANDEUR (« Chez l'assistante »). `qui` : le prénom de celle qui l'a prise. */
export function libelleEtat(e: EtatFiche, qui?: string | null): string {
  switch (e) {
    case "BROUILLON": return "À compléter";
    case "PRETE": return "Prête";
    case "ENVOYEE": return "Chez l'assistante";
    case "PRISE": return qui ? `Prise par ${qui}` : "Prise en charge";
    case "DEVIS_RECU": return "Devis reçu";
    case "RESERVEE": return "Réservée";
    case "MANQUE_SIGNALE": return "À compléter";
    case "MODIFIEE_APRES_ENVOI": return "Modifiée après l'envoi";
    case "RETIREE": return "Retirée";
  }
}

/** Le libellé côté ASSISTANTE : une fiche envoyée est « À prendre » chez elle. */
export function libelleEtatAssistante(e: EtatDemande, qui?: string | null): string {
  if (e === "ENVOYEE") return "À prendre";
  if (e === "MANQUE_SIGNALE") return "Manque signalé";
  if (e === "MODIFIEE_APRES_ENVOI") return "Modifiée — à renvoyer";
  return libelleEtat(e, qui);
}

export const TON_ETAT: Record<EtatFiche, BadgeTone> = {
  BROUILLON: "warning",
  PRETE: "info",
  ENVOYEE: "purple",
  PRISE: "purple",
  DEVIS_RECU: "info",
  RESERVEE: "success",
  MANQUE_SIGNALE: "warning",
  MODIFIEE_APRES_ENVOI: "danger",
  RETIREE: "neutral",
};

export const NATURE_LIBELLE: Record<NatureFiche, string> = { BILLET: "Billet", HOTEL: "Hôtel" };

// ───────────────────────────── L'empreinte : ce que la fiche disait à l'envoi ─────────────────────────────

/** Une empreinte : `{ libellé : valeur lisible }`, dans l'ordre de lecture. Une valeur vide s'écrit « — ». */
export type Empreinte = Record<string, string>;

export interface FicheBilletLue {
  nom: string;
  /** « aller-retour », « aller simple », « plusieurs destinations ». */
  trajet: string;
  villeDepart: string | null;
  villeArrivee: string | null;
  /** AAAA-MM-JJ. */
  dateDepart: string | null;
  dateRetour: string | null;
  etapes: readonly { de: string | null; vers: string | null; date: string | null }[];
  transport: string | null;
  notes: string | null;
}

export interface FicheHotelLue {
  nom: string;
  hotel: string | null;
  ville: string | null;
  /** AAAA-MM-JJ. */
  dateArrivee: string | null;
  dateDepart: string | null;
  typeChambre: string | null;
  notes: string | null;
}

const VIDE = "—";
const val = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t ? t : VIDE;
};
/** 2026-10-22 → 22/10/2026 ; vide → « — ». */
export const jourFr = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : VIDE);

/**
 * L'EMPREINTE D'UN BILLET — les seuls champs qui font le voyage : qui, d'où, vers où, quand, comment. Les pièces
 * (passeport) n'en sont pas : en joindre une après l'envoi est une bonne nouvelle, pas une raison de renvoyer.
 */
export function empreinteBillet(f: FicheBilletLue): Empreinte {
  const e: Empreinte = { Voyageur: val(f.nom), Trajet: val(f.trajet) };
  if (f.etapes.length > 0) {
    f.etapes.forEach((x, i) => { e[`Étape ${i + 1}`] = `${val(x.de)} → ${val(x.vers)} · ${jourFr(x.date)}`; });
  } else {
    e["Départ de"] = val(f.villeDepart);
    e["Arrivée à"] = val(f.villeArrivee);
    e.Aller = jourFr(f.dateDepart);
    e.Retour = jourFr(f.dateRetour);
  }
  e.Transport = val(f.transport);
  e["Précisions"] = val(f.notes);
  return e;
}

/**
 * CE QUI MANQUE POUR RÉSERVER UN HÔTEL d'une fiche hôtellerie — la règle des prises en charge (`manquesHotel`) :
 * l'hôtel (ou au moins la ville) et les deux dates. La pièce d'identité n'est pas exigée à l'envoi : l'hôtel
 * se chiffre sans elle, et l'écran dit déjà quand elle manque.
 */
export function manquesHebergement(h: { hotel: string | null; ville: string | null; dateArrivee: string | null; dateDepart: string | null }): string[] {
  const m: string[] = [];
  if (!(h.hotel ?? "").trim() && !(h.ville ?? "").trim()) m.push("hôtel ou ville");
  if (!h.dateArrivee || !h.dateDepart) m.push("dates de l'hôtel");
  return m;
}

export function empreinteHotel(f: FicheHotelLue): Empreinte {
  return {
    Personne: val(f.nom), "Hôtel": val(f.hotel), Ville: val(f.ville),
    "Arrivée": jourFr(f.dateArrivee), "Départ": jourFr(f.dateDepart), Chambre: val(f.typeChambre), "Précisions": val(f.notes),
  };
}

/** Lit une empreinte stockée (JSON) — tout ce qui n'est pas `{ texte: texte }` est ignoré ; illisible → `null`. */
export function lireEmpreinte(brut: unknown): Empreinte | null {
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) return null;
  const out: Empreinte = {};
  for (const [k, v] of Object.entries(brut as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return Object.keys(out).length > 0 ? out : null;
}

export interface ChampChange {
  champ: string;
  avant: string;
  apres: string;
}

/** CE QUI A CHANGÉ depuis l'envoi — champ par champ, dans l'ordre de la fiche actuelle, puis ce qui a disparu. */
export function diffEmpreintes(avant: Empreinte, apres: Empreinte): ChampChange[] {
  const out: ChampChange[] = [];
  for (const [champ, v] of Object.entries(apres)) {
    const a = avant[champ] ?? VIDE;
    if (a !== v) out.push({ champ, avant: a, apres: v });
  }
  for (const [champ, a] of Object.entries(avant)) {
    if (!(champ in apres) && a !== VIDE) out.push({ champ, avant: a, apres: VIDE });
  }
  return out;
}

export const phraseChangements = (l: readonly ChampChange[]): string =>
  l.map((c) => `${c.champ.toLowerCase()} : ${c.avant} → ${c.apres}`).join(" ; ");

// ───────────────────────────── La machine d'états ─────────────────────────────

export type Geste =
  | "ENVOYER" | "RELANCER" | "RETIRER"            // le demandeur
  | "PRENDRE" | "SIGNALER_MANQUE" | "JOINDRE_DEVIS" | "DEPOSER"; // l'assistante

/** Les états d'où chaque geste part. `null` = aucune demande encore (la fiche n'a jamais été envoyée). */
const DEPUIS: Record<Geste, readonly (EtatDemande | null)[]> = {
  ENVOYER: [null, "RETIREE", "MANQUE_SIGNALE", "MODIFIEE_APRES_ENVOI"],
  RELANCER: ["ENVOYEE", "PRISE", "DEVIS_RECU"],
  RETIRER: ["ENVOYEE", "PRISE", "DEVIS_RECU", "MANQUE_SIGNALE", "MODIFIEE_APRES_ENVOI"],
  PRENDRE: ["ENVOYEE"],
  SIGNALER_MANQUE: ["ENVOYEE", "PRISE", "DEVIS_RECU", "MODIFIEE_APRES_ENVOI"],
  JOINDRE_DEVIS: ["ENVOYEE", "PRISE", "DEVIS_RECU"],
  // Déposer sur une fiche RÉSERVÉE ajoute une pièce (le retour après l'aller, un second voucher).
  DEPOSER: ["ENVOYEE", "PRISE", "DEVIS_RECU", "RESERVEE"],
};

/** Les états SOURCE d'un geste, pour l'écriture conditionnelle (`updateMany where etat in …`). */
export function etatsSource(g: Geste): EtatDemande[] {
  return DEPUIS[g].filter((e): e is EtatDemande => e !== null);
}

export function gestePossible(g: Geste, etat: EtatDemande | null): boolean {
  return DEPUIS[g].includes(etat);
}

/**
 * L'ÉTAT QUI REPREND après un renvoi : la fiche revient à celle qui l'avait prise (on ne la remet pas dans
 * la pile commune), sinon dans « À prendre ». Le devis reçu avant une modification ne vaut plus forcément :
 * il faut le revoir, d'où PRISE et non DEVIS_RECU.
 */
export function etatApresRenvoi(d: { priseParId: string | null }): EtatDemande {
  return d.priseParId ? "PRISE" : "ENVOYEE";
}

/** L'état où la fiche revient quand la modification est ANNULÉE (la fiche redit ce qu'elle disait à l'envoi). */
export function etatRepris(d: { priseParId: string | null; devisRecuLe: Date | string | null }): EtatDemande {
  if (!d.priseParId) return "ENVOYEE";
  return d.devisRecuLe ? "DEVIS_RECU" : "PRISE";
}

/** L'état d'arrivée d'un geste. */
export function etatApres(g: Geste, d: { priseParId: string | null } | null): EtatDemande {
  switch (g) {
    case "ENVOYER": return d ? etatApresRenvoi(d) : "ENVOYEE";
    case "RELANCER": throw new Error("La relance ne change pas l'état.");
    case "RETIRER": return "RETIREE";
    case "PRENDRE": return "PRISE";
    case "SIGNALER_MANQUE": return "MANQUE_SIGNALE";
    case "JOINDRE_DEVIS": return "DEVIS_RECU";
    case "DEPOSER": return "RESERVEE";
  }
}

/** Pourquoi ce geste n'est pas possible depuis cet état — la phrase de l'action ET de l'écran (§118.83). */
export function refusGeste(g: Geste, etat: EtatDemande | null): string | null {
  if (gestePossible(g, etat)) return null;
  const ici = etat ? libelleEtat(etat).toLowerCase() : "pas encore envoyée";
  switch (g) {
    case "ENVOYER":
      return etat && estChezElle(etat)
        ? "Cette fiche est déjà chez l'assistante : relancez-la plutôt."
        : etat === "RESERVEE" ? "Cette fiche est déjà réservée." : `La fiche ne s'envoie pas depuis l'état « ${ici} ».`;
    case "RELANCER":
      return etat === null ? "Envoyez d'abord la fiche." : `On ne relance qu'une fiche chez l'assistante (elle est « ${ici} »).`;
    case "RETIRER":
      return etat === "RESERVEE" ? "La fiche est réservée : elle ne se retire plus. Écrivez à l'assistante dans le fil." : `Rien à retirer (la fiche est « ${ici} »).`;
    case "PRENDRE":
      return etat === "PRISE" || etat === "DEVIS_RECU" ? "Cette fiche est déjà prise." : `Cette fiche n'est plus à prendre (elle est « ${ici} »).`;
    case "SIGNALER_MANQUE":
    case "JOINDRE_DEVIS":
    case "DEPOSER":
      return `Cette fiche n'est plus chez vous (elle est « ${ici} »).`;
  }
}

/**
 * L'ÉTAT LU d'une demande face à la fiche ACTUELLE : une fiche chez l'assistante dont les champs ne sont plus
 * ceux de l'envoi est « modifiée après l'envoi », même si le geste de modification ne l'a pas écrit (lecture de
 * repli — un chemin de modification oublié ne fait pas mentir l'écran). Sans empreinte (reprise d'un envoi en
 * bloc d'avant), on ne compare pas : on ne déduit rien d'un trou.
 */
export function etatLu(d: { etat: EtatDemande; empreinte: Empreinte | null }, actuelle: Empreinte | null): EtatDemande {
  if (!estChezElle(d.etat) || !d.empreinte || !actuelle) return d.etat;
  return diffEmpreintes(d.empreinte, actuelle).length > 0 ? "MODIFIEE_APRES_ENVOI" : d.etat;
}

/** L'état AFFICHÉ d'une fiche : sans demande (ou retirée), « à compléter » ou « prête » selon ce qui manque. */
export function etatFiche(d: { etat: EtatDemande; empreinte: Empreinte | null } | null, manques: readonly string[], actuelle: Empreinte | null): EtatFiche {
  if (!d || d.etat === "RETIREE") return manques.length > 0 ? "BROUILLON" : "PRETE";
  return etatLu(d, actuelle);
}

/** La fiche peut-elle partir (ou repartir) maintenant ? Rien ne manque, et elle est prête, complétée ou modifiée. */
export function peutEnvoyer(etat: EtatFiche, manques: readonly string[]): boolean {
  if (manques.length > 0) return false;
  return etat === "PRETE" || etat === "MANQUE_SIGNALE" || etat === "MODIFIEE_APRES_ENVOI";
}

// ───────────────────────────── La relance ─────────────────────────────

/** Le moment à partir duquel la fiche se relance : 24 h après le dernier envoi ou la dernière relance. */
export function prochaineRelance(d: { envoyeeLe: Date | string; derniereRelanceLe: Date | string | null }): Date {
  const t = Math.max(new Date(d.envoyeeLe).getTime(), d.derniereRelanceLe ? new Date(d.derniereRelanceLe).getTime() : 0);
  return new Date(t + DELAI_RELANCE_MS);
}

/** Pourquoi la relance est refusée MAINTENANT (`null` : elle part). */
export function refusRelance(
  d: { etat: EtatDemande; envoyeeLe: Date | string; derniereRelanceLe: Date | string | null }, maintenant: Date,
): string | null {
  const refus = refusGeste("RELANCER", d.etat);
  if (refus) return refus;
  const quand = prochaineRelance(d);
  if (maintenant.getTime() < quand.getTime()) {
    const h = Math.ceil((quand.getTime() - maintenant.getTime()) / 3600_000);
    return `Une relance par 24 h au plus : la prochaine est possible dans ${h} h.`;
  }
  return null;
}

// ───────────────────────────── Les phrases ─────────────────────────────

/** « à l'instant », « 3 h », « 2 j » — depuis quand. */
export function depuisLisible(depuis: Date | string, maintenant: Date): string {
  const ms = Math.max(0, maintenant.getTime() - new Date(depuis).getTime());
  const h = Math.floor(ms / 3600_000);
  if (h < 1) return "à l'instant";
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} j`;
}

/** LE SOUS-ÉTAT d'une fiche chez l'assistante : « depuis 2 j · relancée 1 fois ». */
export function sousEtat(
  d: { etat: EtatDemande; envoyeeLe: Date | string; relances: number; reserveeLe?: Date | string | null; manqueMotif?: string | null },
  etatAffiche: EtatFiche, maintenant: Date,
): string {
  if (etatAffiche === "RESERVEE") return d.reserveeLe ? `réservée le ${jourFr(new Date(d.reserveeLe).toISOString())}` : "";
  if (etatAffiche === "MANQUE_SIGNALE") return d.manqueMotif ? `il manque : ${d.manqueMotif}` : "";
  if (etatAffiche === "MODIFIEE_APRES_ENVOI") return "changée après l'envoi — à renvoyer";
  if (!estChezElle(etatAffiche)) return "";
  const depuis = depuisLisible(d.envoyeeLe, maintenant);
  const base = depuis === "à l'instant" ? "envoyée à l'instant" : `depuis ${depuis}`;
  return d.relances > 0 ? `${base} · relancée ${d.relances} fois` : base;
}

// ───────────────────────────── Les comptes ─────────────────────────────

/** LE BANDEAU DU POSTE : « Chez l'assistante : 3 fiches · réservées : 1 · à compléter : 1 · prêtes : 2 ». */
export interface ResumeEnvois {
  chezElle: number;
  reservees: number;
  aCompleter: number;
  aRenvoyer: number;
  pretes: number;
}

export function resumeEnvois(etats: readonly EtatFiche[]): ResumeEnvois {
  const r: ResumeEnvois = { chezElle: 0, reservees: 0, aCompleter: 0, aRenvoyer: 0, pretes: 0 };
  for (const e of etats) {
    if (estChezElle(e)) r.chezElle += 1;
    else if (e === "RESERVEE") r.reservees += 1;
    else if (e === "BROUILLON" || e === "MANQUE_SIGNALE") r.aCompleter += 1;
    else if (e === "MODIFIEE_APRES_ENVOI") r.aRenvoyer += 1;
    else if (e === "PRETE") r.pretes += 1;
  }
  return r;
}

/** Les fiches que « Envoyer les fiches prêtes » emporte : prêtes, ou à renvoyer, sans rien qui manque. */
export function fichesAEnvoyer<T extends { etat: EtatFiche; manques: readonly string[] }>(fiches: readonly T[]): T[] {
  return fiches.filter((f) => f.manques.length === 0 && (f.etat === "PRETE" || f.etat === "MODIFIEE_APRES_ENVOI"));
}

/** LES TUILES DE L'ASSISTANTE (billets et hôtels) — à prendre, en cours, relancées. */
export interface TuilesFiches {
  aPrendre: number;
  enCours: number;
  relancees: number;
}

export function tuilesFiches(demandes: readonly { etat: EtatDemande; relances: number }[]): TuilesFiches {
  const t: TuilesFiches = { aPrendre: 0, enCours: 0, relancees: 0 };
  for (const d of demandes) {
    if (d.etat === "ENVOYEE") t.aPrendre += 1;
    else if (d.etat === "PRISE" || d.etat === "DEVIS_RECU" || d.etat === "MODIFIEE_APRES_ENVOI") t.enCours += 1;
    if (estChezElle(d.etat) && d.relances > 0) t.relancees += 1;
  }
  return t;
}

// ───────────────────────────── La vue d'une fiche (écran du demandeur) ─────────────────────────────

/** Ce que l'écran du demandeur montre d'une fiche — calculé au serveur, sérialisable. */
export interface EnvoiVue {
  source: SourceFiche;
  ficheId: string;
  nature: NatureFiche;
  demandeId: string | null;
  etat: EtatFiche;
  libelle: string;
  ton: BadgeTone;
  /** « depuis 2 j · relancée 1 fois », « il manque : … », « réservée le … ». */
  sousEtat: string;
  manques: string[];
  relances: number;
  /** Pourquoi la relance n'est pas possible maintenant (`null` : elle l'est, si la fiche est chez l'assistante). */
  refusRelance: string | null;
  /** Le motif est exigé pour retirer (l'assistante avait pris la fiche). */
  motifRetraitRequis: boolean;
  priseParNom: string | null;
  /** Ce qui a changé depuis l'envoi (fiche « modifiée après l'envoi »). */
  changements: ChampChange[];
  /** Le billet / la confirmation déposés. */
  pieces: { id: string; name: string }[];
  reference: string | null;
}

export interface DemandeLue {
  id: string;
  etat: EtatDemande;
  empreinte: unknown;
  envoyeeLe: Date | string;
  relances: number;
  derniereRelanceLe: Date | string | null;
  priseParId: string | null;
  reserveeLe: Date | string | null;
  manqueMotif: string | null;
  referenceReservation: string | null;
}

/** LA VUE D'UNE FICHE — une lecture, la même règle que les actions (§118.83). */
export function versEnvoiVue(
  i: {
    source: SourceFiche; ficheId: string; nature: NatureFiche; manques: readonly string[]; empreinte: Empreinte;
    demande: DemandeLue | null; priseParNom: string | null; pieces: { id: string; name: string }[];
  },
  maintenant: Date,
): EnvoiVue {
  const d = i.demande;
  const stockee = d ? lireEmpreinte(d.empreinte) : null;
  const etat = etatFiche(d ? { etat: d.etat, empreinte: stockee } : null, i.manques, i.empreinte);
  const changements = etat === "MODIFIEE_APRES_ENVOI" && stockee ? diffEmpreintes(stockee, i.empreinte) : [];
  const prenomPrise = i.priseParNom ? i.priseParNom.trim().split(/\s+/)[0] ?? null : null;
  return {
    source: i.source, ficheId: i.ficheId, nature: i.nature, demandeId: d?.id ?? null, etat,
    libelle: libelleEtat(etat, prenomPrise), ton: TON_ETAT[etat],
    sousEtat: d && d.etat !== "RETIREE" ? sousEtat(d, etat, maintenant)
      : etat === "BROUILLON" ? `il manque : ${i.manques.join(", ")}` : d ? "retirée de chez l'assistante — elle se renvoie d'un clic" : "",
    manques: [...i.manques],
    relances: d?.relances ?? 0,
    refusRelance: d && estChezElle(etat) ? refusRelance({ etat: d.etat, envoyeeLe: d.envoyeeLe, derniereRelanceLe: d.derniereRelanceLe }, maintenant) : null,
    motifRetraitRequis: Boolean(d?.priseParId),
    priseParNom: d?.priseParId ? i.priseParNom : null,
    changements,
    pieces: i.pieces,
    reference: d?.referenceReservation ?? null,
  };
}

/** La réservation (dépôt du billet / de la confirmation) attend l'ACCORD du poste — décision du 14/10. */
export const REFUS_AVANT_ACCORD =
  "Le poste n'est pas encore accordé par la Direction : préparez le devis, mais ne réservez qu'après l'accord.";
