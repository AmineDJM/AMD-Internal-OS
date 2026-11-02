import type { AdProItemKind, AdProTrajet, AdProTransport } from "@prisma/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA BILLETTERIE D'UN POSTE : QUI VOYAGE, QUAND (§118.175).
 *
 * « Lorsqu'on met la prise en charge de la billetterie dans les postes d'une demande, on doit
 * pouvoir sélectionner à chaque fois le nom de la personne, la date de départ, de retour,
 * téléverser le passeport, etc. — et donner de la flexibilité : on modifie les dates plus tard,
 * ou on n'a pas les informations à l'avance. Les demandes de réservation vont à l'assistante de
 * direction et ouvrent un sujet » (Direction, 01/10).
 *
 * Module PUR : la lecture d'un voyageur saisi, ce qui manque pour réserver, et les phrases que
 * l'assistante lira dans le sujet. Aucune base, aucune session.
 *
 * ── LA FLEXIBILITÉ EST UNE PROPRIÉTÉ, PAS UN OUBLI ─────────────────────────────────────────
 *
 * Aucune date n'est obligatoire : on prend en charge un médecin avant de savoir quand il part.
 * Mais une réservation sur des dates inconnues ne se fait pas — l'assistante devrait rappeler.
 * D'où DEUX questions distinctes : « le voyageur est-il enregistré ? » (un nom suffit) et
 * « peut-on réserver ? » (ce qui manque est NOMMÉ, voyageur par voyageur, et la demande part
 * quand même — l'assistante sait alors ce qu'elle attend, au lieu de le découvrir).
 *
 * ── LE NOM SE SAISIT, IL NE SE DEVINE PAS ──────────────────────────────────────────────────
 *
 * Le formulaire propose les noms que la demande porte déjà (les médecins concernés, les
 * personnes prises en charge) — c'est la « sélection » demandée. Mais un voyageur ne se
 * RATTACHE pas à une fiche de l'annuaire d'après son nom : deux « Dr Benali » existent, et
 * rapprocher par ressemblance écrirait le voyage de l'un sur la fiche de l'autre (§118.85).
 *
 * ── TRAJET, TRANSPORT, DEVIS PAR VOYAGEUR (§118.205, Direction 04/10) ──────────────────────
 *
 * « Voir si c'est aller-retour ou que aller, le mode de transport ; pour chaque voyageur, le devis
 * ou la pro forma de l'agence ; si le demandeur en valide un, on demande le BC — tout en restant
 * ULTRA SIMPLE. » En ALLER SIMPLE la date de retour n'est ni demandée ni gardée : une date de retour
 * restée en base sur un aller simple se lirait comme un billet retour à réserver. Le devis d'un
 * voyageur est un devis du POSTE (`ajouterDevisPoste`) marqué pour lui ; la proposition RETENUE est
 * au plus une par voyageur, les autres sont écartées. Le geste visible d'un voyageur est UN SEUL —
 * le prochain qui manque (`prochainGesteVoyageur`) ; le reste vit dans un menu.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const TRAJETS = ["ALLER_RETOUR", "ALLER_SIMPLE", "MULTI_DESTINATIONS"] as const satisfies readonly AdProTrajet[];
export const TRANSPORTS = ["AVION", "TRAIN", "BUS", "TAXI"] as const satisfies readonly AdProTransport[];
export const TRAJET_LIBELLE: Record<AdProTrajet, string> = {
  ALLER_RETOUR: "aller-retour", ALLER_SIMPLE: "aller simple", MULTI_DESTINATIONS: "plusieurs destinations",
};

/** Une ÉTAPE d'un trajet à plusieurs destinations : d'où, vers où, quand. Chaque champ peut manquer (flexibilité). */
export interface EtapeTrajet {
  de: string | null;
  vers: string | null;
  /** AAAA-MM-JJ ; `null` = pas encore connue. */
  date: string | null;
}

/** Au plus autant d'étapes : un voyage de douze étapes est une erreur de saisie, pas un trajet (limite opérationnelle). */
export const ETAPES_MAX = 12;

const TITRES = /^(dr|dr\.|pr|pr\.|prof|prof\.|mme|mlle|m|m\.|mr|mr\.)$/i;

/**
 * COUPE UN NOM COMPLET EN PRÉNOM ET NOM pour pré-remplir le formulaire — jamais pour écrire en base.
 * Le titre (Dr, Pr…) reste avec le prénom ; le premier mot est le prénom, le reste le nom. C'est une
 * PROPOSITION que la personne corrige : « Mohamed El Amine Benali » se coupe mal, et l'écran le dit en
 * laissant les deux champs modifiables. Un seul mot est un nom, sans prénom.
 */
export function separerNom(complet: string): { prenom: string; nom: string } {
  const mots = complet.trim().split(/\s+/).filter(Boolean);
  if (mots.length <= 1) return { prenom: "", nom: mots[0] ?? "" };
  let i = 0;
  while (i < mots.length - 2 && TITRES.test(mots[i]!)) i++;
  const prenom = mots.slice(0, i + 1).join(" ");
  return { prenom, nom: mots.slice(i + 1).join(" ") };
}

/** « Prénom NOM » tel qu'on le lit (et l'écrit dans le sujet) ; un voyageur d'avant n'a que son nom complet. */
export function nomComplet(v: { prenom?: string | null; nom: string }): string {
  const p = (v.prenom ?? "").trim();
  return p ? `${p} ${v.nom}` : v.nom;
}
export const TRANSPORT_LIBELLE: Record<AdProTransport, string> = { AVION: "avion", TRAIN: "train", BUS: "bus", TAXI: "taxi" };

/** Un trajet lu dans une saisie — `null` si la valeur n'en est pas un (jamais deviné). */
export function lireTrajet(v: string | null | undefined): AdProTrajet | null {
  return (TRAJETS as readonly string[]).includes(v ?? "") ? (v as AdProTrajet) : null;
}
/** Un mode de transport lu — `null` si la valeur n'en est pas un. */
export function lireTransport(v: string | null | undefined): AdProTransport | null {
  return (TRANSPORTS as readonly string[]).includes(v ?? "") ? (v as AdProTransport) : null;
}

/**
 * Les natures dont le poste porte des voyageurs. FERMÉE : la Direction a parlé de la billetterie.
 * L'hôtellerie en porterait peut-être aussi — c'est une décision de la Direction, et elle tient
 * en une ligne ici.
 */
export const NATURES_A_VOYAGEURS = ["TICKETING"] as const satisfies readonly AdProItemKind[];

export function porteDesVoyageurs(kind: AdProItemKind | string): boolean {
  return (NATURES_A_VOYAGEURS as readonly string[]).includes(kind);
}

export interface SaisieVoyageur {
  nom: string | null;
  prenom?: string | null;
  /** Les étapes d'un trajet à plusieurs destinations : une liste, ou son JSON (le formulaire l'envoie ainsi). */
  segments?: unknown;
  villeDepart: string | null;
  villeArrivee: string | null;
  /** AAAA-MM-JJ ; vide = pas encore connue. */
  dateDepart: string | null;
  dateRetour: string | null;
  notes: string | null;
  /** « ALLER_SIMPLE » | « ALLER_RETOUR » | « MULTI_DESTINATIONS » ; vide = aller-retour (le cas d'avant). */
  trajet?: string | null;
  /** « AVION » | « TRAIN » | « BUS » | « TAXI » ; vide = pas encore dit. */
  transport?: string | null;
}

export interface VoyageurLu {
  nom: string;
  prenom: string | null;
  /** Les étapes du trajet — `[]` hors « plusieurs destinations ». */
  segments: EtapeTrajet[];
  villeDepart: string | null;
  villeArrivee: string | null;
  dateDepart: Date | null;
  dateRetour: Date | null;
  notes: string | null;
  trajet: AdProTrajet;
  transport: AdProTransport | null;
}

const JOUR = /^\d{4}-\d{2}-\d{2}$/;

function lireJour(v: string | null): { ok: true; date: Date | null } | { ok: false } {
  const t = (v ?? "").trim();
  if (!t) return { ok: true, date: null };
  if (!JOUR.test(t)) return { ok: false };
  const d = new Date(`${t}T00:00:00.000Z`);
  // « 2026-02-31 » se lit, mais n'existe pas : on refuse plutôt que d'écrire le 3 mars.
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? { ok: false } : { ok: true, date: d };
}

const texte = (v: string | null, max = 200) => {
  const t = (v ?? "").trim();
  return t ? t.slice(0, max) : null;
};

/**
 * Les ÉTAPES saisies. Une étape entièrement vide est écartée (la ligne laissée en blanc n'est pas une faute) ;
 * une date illisible est refusée ; deux étapes datées doivent se suivre dans le temps — « retour le 10, aller le
 * 8 » est une inversion qu'on dit, jamais corrigée en silence.
 */
export function lireEtapes(brut: unknown): { ok: true; etapes: EtapeTrajet[] } | { ok: false; error: string } {
  let liste: unknown = brut;
  if (typeof brut === "string") {
    const t = brut.trim();
    if (!t) return { ok: true, etapes: [] };
    try { liste = JSON.parse(t); } catch { return { ok: false, error: "Les étapes du trajet sont illisibles." }; }
  }
  if (liste == null) return { ok: true, etapes: [] };
  if (!Array.isArray(liste)) return { ok: false, error: "Les étapes du trajet sont illisibles." };
  const etapes: EtapeTrajet[] = [];
  for (const [i, e] of liste.entries()) {
    if (!e || typeof e !== "object") return { ok: false, error: `L'étape ${i + 1} du trajet est illisible.` };
    const r = e as Record<string, unknown>;
    const de = texte(typeof r.de === "string" ? r.de : null, 120);
    const vers = texte(typeof r.vers === "string" ? r.vers : null, 120);
    const date = lireJour(typeof r.date === "string" ? r.date : null);
    if (!date.ok) return { ok: false, error: `L'étape ${i + 1} du trajet : date illisible (AAAA-MM-JJ).` };
    if (!de && !vers && !date.date) continue;
    etapes.push({ de, vers, date: date.date ? date.date.toISOString().slice(0, 10) : null });
  }
  if (etapes.length > ETAPES_MAX) return { ok: false, error: `Un trajet compte ${ETAPES_MAX} étapes au plus (${etapes.length} saisies).` };
  let precedente: { date: string; rang: number } | null = null;
  for (const [i, e] of etapes.entries()) {
    if (!e.date) continue;
    if (precedente && e.date < precedente.date) {
      return { ok: false, error: `L'étape ${i + 1} (${jourLisible(new Date(`${e.date}T00:00:00.000Z`))}) précède l'étape ${precedente.rang} (${jourLisible(new Date(`${precedente.date}T00:00:00.000Z`))}).` };
    }
    precedente = { date: e.date, rang: i + 1 };
  }
  return { ok: true, etapes };
}

const versDate = (iso: string | null): Date | null => (iso ? new Date(`${iso}T00:00:00.000Z`) : null);

/** Lit un voyageur saisi. Tout ce qui ne va pas se dit en une fois (§118.18). */
export function lireVoyageur(s: SaisieVoyageur): { ok: true; voyageur: VoyageurLu } | { ok: false; error: string } {
  const fautes: string[] = [];
  const nom = texte(s.nom, 160);
  if (!nom) fautes.push("le nom de famille");
  const trajetBrut = (s.trajet ?? "").trim();
  const trajet = trajetBrut ? lireTrajet(trajetBrut) : "ALLER_RETOUR";
  if (!trajet) fautes.push("un trajet reconnu (aller simple, aller-retour ou plusieurs destinations)");
  const transportBrut = (s.transport ?? "").trim();
  const transport = transportBrut ? lireTransport(transportBrut) : null;
  if (transportBrut && !transport) fautes.push("un mode de transport reconnu (avion, train, bus, taxi)");
  const multi = trajet === "MULTI_DESTINATIONS";
  // PLUSIEURS DESTINATIONS : les étapes font foi, les champs « départ / retour » en sont DÉRIVÉS (première
  // étape, dernière) — les lecteurs d'avant (liste, sujet, « manque pour réserver ») continuent de s'y fier.
  const lues: ReturnType<typeof lireEtapes> = multi ? lireEtapes(s.segments) : { ok: true, etapes: [] };
  if (!lues.ok) return { ok: false, error: lues.error };
  const depart = multi ? ({ ok: true, date: versDate(lues.etapes[0]?.date ?? null) } as const) : lireJour(s.dateDepart);
  // EN ALLER SIMPLE, la date de retour n'est ni lue ni gardée : elle est vidée.
  const retour = multi
    ? ({ ok: true, date: lues.etapes.length > 1 ? versDate(lues.etapes[lues.etapes.length - 1]!.date) : null } as const)
    : trajet === "ALLER_SIMPLE" ? ({ ok: true, date: null } as const) : lireJour(s.dateRetour);
  if (!depart.ok) fautes.push("une date de départ lisible (AAAA-MM-JJ)");
  if (!retour.ok) fautes.push("une date de retour lisible (AAAA-MM-JJ)");
  if (fautes.length) return { ok: false, error: `Voyageur incomplet — il manque ${fautes.join(", ")}.` };
  const dDepart = depart.ok ? depart.date : null;
  const dRetour = retour.ok ? retour.date : null;
  if (!multi && dDepart && dRetour && dRetour.getTime() < dDepart.getTime()) {
    return { ok: false, error: "La date de retour précède la date de départ." };
  }
  return {
    ok: true,
    voyageur: {
      nom: nom!, prenom: texte(s.prenom ?? null, 160),
      villeDepart: multi ? (lues.etapes[0]?.de ?? null) : texte(s.villeDepart, 120),
      villeArrivee: multi ? (lues.etapes[lues.etapes.length - 1]?.vers ?? null) : texte(s.villeArrivee, 120),
      dateDepart: dDepart, dateRetour: dRetour, notes: texte(s.notes, 1000),
      trajet: trajet!, transport, segments: multi ? lues.etapes : [],
    },
  };
}

export interface VoyageurPourReservation {
  nom: string;
  prenom?: string | null;
  segments?: EtapeTrajet[];
  villeDepart: string | null;
  villeArrivee: string | null;
  dateDepart: Date | null;
  dateRetour: Date | null;
  passeport: boolean;
  notes: string | null;
  trajet?: AdProTrajet;
  transport?: AdProTransport | null;
}

/** CE QUI MANQUE POUR RÉSERVER — nommé voyageur par voyageur. Vide = tout est là. */
export function manquesPourReserver(v: VoyageurPourReservation): string[] {
  const m: string[] = [];
  // Le prénom manque quand le nom ne tient qu'en UN mot sans prénom : un voyageur d'avant la séparation porte
  // son nom complet dans `nom` (« Amel Haddad »), et le lui reprocher serait du bruit (§118.32).
  if (!(v.prenom ?? "").trim() && !/\s/.test(v.nom.trim())) m.push("prénom");
  if (v.trajet === "MULTI_DESTINATIONS") {
    // Chaque étape doit dire d'où, vers où et quand : l'assistante réserve étape par étape.
    const etapes = v.segments ?? [];
    if (etapes.length === 0 || etapes.some((e) => !e.date)) m.push("date de chaque étape");
    if (etapes.length === 0 || etapes.some((e) => !e.de || !e.vers)) m.push("villes de chaque étape");
  } else {
    if (!v.dateDepart) m.push("date de départ");
    if (!v.villeDepart || !v.villeArrivee) m.push("trajet");
  }
  if (v.transport === null) m.push("mode de transport");
  if (!v.passeport) m.push("passeport");
  return m;
}

/** Un jour lu par une personne : JJ/MM/AAAA, ou « à confirmer » — jamais un vide qui se lirait « rien ». */
export function jourLisible(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10).split("-").reverse().join("/") : "à confirmer";
}

/** Les dates d'un voyage : « aller simple 12/10/2026 », ou « aller …, retour … ». */
export function datesLisibles(v: { dateDepart: Date | null; dateRetour: Date | null; trajet?: AdProTrajet }): string {
  if (v.trajet === "MULTI_DESTINATIONS") return `du ${jourLisible(v.dateDepart)} au ${v.dateRetour ? jourLisible(v.dateRetour) : "à confirmer"}`;
  return v.trajet === "ALLER_SIMPLE"
    ? `aller simple ${jourLisible(v.dateDepart)}`
    : `aller ${jourLisible(v.dateDepart)}, retour ${jourLisible(v.dateRetour)}`;
}

/** LA LIGNE QUE L'ASSISTANTE LIT dans le sujet — un voyageur, ce qu'on sait, ce qui manque. */
export function ligneVoyageur(v: VoyageurPourReservation): string {
  if (v.trajet === "MULTI_DESTINATIONS") {
    const etapes = (v.segments ?? []).map((e, i) => `${i + 1}. ${e.de ?? "?"} → ${e.vers ?? "?"} le ${e.date ? jourLisible(new Date(`${e.date}T00:00:00.000Z`)) : "à confirmer"}`);
    const manque = manquesPourReserver(v);
    const mode = v.transport ? ` — ${TRANSPORT_LIBELLE[v.transport]}` : "";
    return `• ${nomComplet(v)} — plusieurs destinations${mode} :\n${etapes.length ? etapes.map((l) => `    ${l}`).join("\n") : "    étapes à confirmer"}${v.passeport ? "\n    passeport joint" : ""}${manque.length ? `\n    (manque : ${manque.join(", ")})` : ""}${v.notes ? `\n    ${v.notes}` : ""}`;
  }
  const trajet = v.villeDepart || v.villeArrivee ? `${v.villeDepart ?? "?"} → ${v.villeArrivee ?? "?"}` : "trajet à confirmer";
  const dates = datesLisibles(v);
  const mode = v.transport ? ` — ${TRANSPORT_LIBELLE[v.transport]}` : "";
  const manque = manquesPourReserver(v);
  return `• ${nomComplet(v)} — ${trajet}${mode} — ${dates}${v.passeport ? " — passeport joint" : ""}${manque.length ? ` (manque : ${manque.join(", ")})` : ""}${v.notes ? ` — ${v.notes}` : ""}`;
}

/**
 * CE QUI A CHANGÉ SUR UN VOYAGEUR — la phrase écrite dans le sujet de réservation quand on
 * modifie un voyageur après la demande (« on modifie les dates plus tard »). Vide = rien n'a
 * bougé : un enregistrement à l'identique ne dérange personne. Les précisions comptent — elles
 * sont dans la ligne que l'assistante lit (`ligneVoyageur`).
 */
export function changementsVoyageur(avant: VoyageurLu, apres: VoyageurLu): string[] {
  const out: string[] = [];
  const t = (v: string | null) => v ?? "—";
  if (nomComplet(avant) !== nomComplet(apres)) out.push(`nom : ${nomComplet(avant)} → ${nomComplet(apres)}`);
  if (avant.villeDepart !== apres.villeDepart || avant.villeArrivee !== apres.villeArrivee) {
    out.push(`trajet : ${t(avant.villeDepart)} → ${t(avant.villeArrivee)} devient ${t(apres.villeDepart)} → ${t(apres.villeArrivee)}`);
  }
  const memeJour = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
  if (!memeJour(avant.dateDepart, apres.dateDepart)) out.push(`aller : ${jourLisible(avant.dateDepart)} → ${jourLisible(apres.dateDepart)}`);
  if (!memeJour(avant.dateRetour, apres.dateRetour)) out.push(`retour : ${jourLisible(avant.dateRetour)} → ${jourLisible(apres.dateRetour)}`);
  const etapes = (l: EtapeTrajet[]) => l.map((e) => `${e.de ?? "?"}→${e.vers ?? "?"} ${e.date ?? "?"}`).join(" ; ");
  if (apres.trajet === "MULTI_DESTINATIONS" && etapes(avant.segments) !== etapes(apres.segments)) {
    out.push(`étapes : ${etapes(avant.segments) || "—"} devient ${etapes(apres.segments) || "—"}`);
  }
  if (avant.trajet !== apres.trajet) out.push(`trajet : ${TRAJET_LIBELLE[avant.trajet]} → ${TRAJET_LIBELLE[apres.trajet]}`);
  if (avant.transport !== apres.transport) {
    out.push(`transport : ${avant.transport ? TRANSPORT_LIBELLE[avant.transport] : "—"} → ${apres.transport ? TRANSPORT_LIBELLE[apres.transport] : "—"}`);
  }
  if ((avant.notes ?? "") !== (apres.notes ?? "")) out.push(`précisions : ${apres.notes ?? "retirées"}`);
  return out;
}

/** Un devis d'un voyageur, vu par la règle : son montant, et s'il est la proposition retenue. */
export interface DevisDeVoyageur {
  montant: number | null;
  retenu: boolean;
  annule?: boolean;
}

export type GesteVoyageur = "PASSEPORT" | "DEVIS" | "VALIDER" | null;

/**
 * LE SEUL GESTE VISIBLE D'UN VOYAGEUR — le prochain qui manque, dans l'ordre : son passeport, puis le
 * devis de l'agence, puis valider une proposition. `null` : rien ne manque (un devis est retenu), ou
 * la personne ne peut rien faire ici. Un devis ANNULÉ au registre ne compte pas.
 */
export function prochainGesteVoyageur(v: { passeport: boolean; devis: readonly DevisDeVoyageur[] }, peutEditer: boolean): GesteVoyageur {
  if (!peutEditer) return null;
  if (!v.passeport) return "PASSEPORT";
  const vivants = v.devis.filter((d) => !d.annule);
  if (vivants.length === 0) return "DEVIS";
  if (!vivants.some((d) => d.retenu)) return "VALIDER";
  return null;
}

/**
 * LA SOMME DES PROPOSITIONS RETENUES face au montant accordé du poste. Le montant accordé reste celui
 * des deux temps de validation : un dépassement se DIT, il ne bloque rien et ne réécrit rien.
 * Rend la phrase, ou `null` quand rien ne dépasse — ou que l'on ne sait pas (un montant accordé
 * inconnu, ou un devis retenu sans montant : on ne compare pas à un trou).
 */
export function depassementDevisRetenus(montantsRetenus: readonly (number | null)[], accorde: number | null): string | null {
  if (accorde == null || montantsRetenus.length === 0) return null;
  if (montantsRetenus.some((m) => m == null)) return null;
  const centimes = montantsRetenus.reduce<number>((s, m) => s + Math.round((m as number) * 100), 0);
  const accordeC = Math.round(accorde * 100);
  if (centimes <= accordeC) return null;
  const f = (c: number) => (c / 100).toLocaleString("fr-FR");
  return `Les devis retenus totalisent ${f(centimes)} DZD, au-delà des ${f(accordeC)} DZD accordés au poste (+${f(centimes - accordeC)} DZD). Le montant accordé ne change pas : demandez une révision du poste si l'écart doit être couvert.`;
}

/**
 * RETIRER LA DEMANDE DE RÉSERVATION — `null` si elle se retire, sinon la raison (audit du 04/10,
 * constat 37 : « on annule sa demande tant que l'autre ne l'a pas exécutée »). La réservation est
 * EXÉCUTÉE quand son sujet est clos (abouti ou archivé), ou quand le bon de commande des billets est
 * demandé : là, l'agence est engagée, et la demande de BC s'annule d'abord par son propre geste. Une
 * lecture pour l'action et pour la carte (§118.83).
 */
export function refusRetraitReservation(r: { sujet: string | null; orderStage: string }): string | null {
  if (!r.sujet) return "Aucune demande de réservation n'est en cours pour ce poste.";
  if (r.sujet === "DONE" || r.sujet === "ARCHIVED") {
    return "La réservation est traitée — son sujet est clos : elle ne se retire plus. Écrivez à l'assistante de direction dans le sujet si quelque chose change.";
  }
  if (r.orderStage !== "NONE" && r.orderStage !== "REFUSED") {
    return "Le bon de commande des billets est déjà demandé : la réservation est engagée. Annulez d'abord la demande de BC (« Annuler la demande de BC »), puis la réservation.";
  }
  return null;
}
