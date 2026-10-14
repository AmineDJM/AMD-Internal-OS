import { versDzd, tauxDeLaDemande, type DetailTrajet } from "@/lib/care-fiches";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DEMANDE DE PARTICIPATION D'UN MEMBRE DE L'ÉQUIPE ADVENTUM (Direction, 10/2026) — les règles, PURES.
 *
 * « Inviter à participer » n'est plus une simple invitation : la personne répond par une FICHE (présence,
 * transport souhaité, qui réserve, hébergement, commentaire). Chaque partie peut accepter, refuser (motif)
 * ou modifier et contre-proposer ; chaque version est gardée, et l'écran surligne ce qui a changé. L'état
 * dit toujours « état — chez qui ». Côté Adventum tranchent l'organisateur (le demandeur de l'opération,
 * ou celui qui a invité), la Direction Marketing et le Super Admin.
 *
 * Une fois l'accord trouvé : l'ordre de mission part en un clic, pré-rempli (circuit N+1 puis RH). À son
 * émission la mission s'ouvre dans Mon espace : billet et hôtel (déposés par la plateforme quand Adventum
 * réserve), notes de frais en lignes (en USD à l'international, sauf le billet — au taux figé de la demande),
 * rapport de mission, puis la clôture.
 *
 * Module SANS IMPORT lourd (seule importation : les conversions pures des fiches voyageur) : l'écran
 * (client) et le serveur lisent les MÊMES règles, et un test les joue sans base.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type Ton = "neutral" | "info" | "success" | "warning" | "danger" | "purple";
export interface Etat { texte: string; ton: Ton }

// ─────────────────────────────── La fiche ───────────────────────────────

export const MODES_TRANSPORT = ["AVION", "TRAIN", "BUS", "VEHICULE_SERVICE", "VEHICULE_PERSONNEL"] as const;
export type ModeTransport = (typeof MODES_TRANSPORT)[number];
/** Libellés alignés sur ceux de l'ordre de mission des RH (`MODES_TRANSPORT_MISSION`). */
export const MODE_TRANSPORT_LIBELLE: Record<ModeTransport, string> = {
  AVION: "Avion", TRAIN: "Train", BUS: "Bus", VEHICULE_SERVICE: "Véhicule de service", VEHICULE_PERSONNEL: "Véhicule personnel",
};

export type QuiReserve = "ADVENTUM" | "MOI";
export const QUI_RESERVE_LIBELLE: Record<QuiReserve, string> = { ADVENTUM: "Adventum réserve", MOI: "Je réserve, note de frais" };

export type ChoixHebergement = "ADVENTUM" | "MOI" | "AUCUN";
export const HEBERGEMENT_LIBELLE: Record<ChoixHebergement, string> = {
  ADVENTUM: "Adventum réserve l'hôtel", MOI: "Je m'en occupe, note de frais", AUCUN: "Pas besoin",
};

export interface FicheParticipation {
  presenceDu: string | null;
  presenceAu: string | null;
  transport: {
    mode: ModeTransport;
    depart: string | null;
    arrivee: string | null;
    aller: string | null;
    retour: string | null;
    reservation: QuiReserve;
    precisions: string | null;
  };
  hebergement: { choix: ChoixHebergement; hotel: string | null; nuits: number | null; estimation: number | null };
  commentaire: string | null;
}

const JOUR = /^\d{4}-\d{2}-\d{2}$/;
const txt = (v: unknown, max = 300): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t.slice(0, max) : null;
};
const jourLu = (v: unknown): string | null | false => {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) return null;
  return JOUR.test(t) && !Number.isNaN(new Date(`${t}T00:00:00Z`).getTime()) ? t : false;
};
const nombreLu = (v: unknown): number | null | false => {
  if (typeof v === "number") return Number.isFinite(v) ? v : false;
  const t = typeof v === "string" ? v.trim().replace(/\s/g, "").replace(",", ".") : "";
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : false;
};

/** La fiche de départ : présence reprise de l'événement, avion, Adventum réserve, hôtel par Adventum. */
export function ficheInitiale(p: { debut: string | null; fin: string | null; ville: string | null }): FicheParticipation {
  return {
    presenceDu: p.debut, presenceAu: p.fin,
    transport: { mode: "AVION", depart: null, arrivee: p.ville, aller: p.debut, retour: p.fin, reservation: "ADVENTUM", precisions: null },
    hebergement: { choix: "ADVENTUM", hotel: null, nuits: null, estimation: null },
    commentaire: null,
  };
}

/**
 * LIRE UNE FICHE SAISIE (champs de formulaire). Un champ illisible se refuse en le nommant ; rien n'est deviné.
 * Champs : presenceDu, presenceAu, transportMode, transportDepart, transportArrivee, transportAller,
 * transportRetour, transportReservation, transportPrecisions, hebergementChoix, hebergementHotel,
 * hebergementNuits, hebergementEstimation, commentaire.
 */
export function lireFiche(c: Record<string, unknown>): { ok: true; fiche: FicheParticipation } | { ok: false; error: string } {
  const du = jourLu(c.presenceDu), au = jourLu(c.presenceAu), aller = jourLu(c.transportAller), retour = jourLu(c.transportRetour);
  if (du === false || au === false) return { ok: false, error: "Dates de présence illisibles." };
  if (aller === false || retour === false) return { ok: false, error: "Dates d'aller / retour illisibles." };
  if (!du || !au) return { ok: false, error: "Indiquez vos dates de présence." };
  if (au < du) return { ok: false, error: "La fin de présence précède son début." };
  if (aller && retour && retour < aller) return { ok: false, error: "Le retour précède l'aller." };
  const mode = MODES_TRANSPORT.find((m) => m === c.transportMode);
  if (!mode) return { ok: false, error: "Choisissez le mode de transport." };
  const reservation: QuiReserve | null = c.transportReservation === "ADVENTUM" || c.transportReservation === "MOI" ? c.transportReservation : null;
  if (!reservation) return { ok: false, error: "Dites qui réserve le transport." };
  const choix: ChoixHebergement | null = c.hebergementChoix === "ADVENTUM" || c.hebergementChoix === "MOI" || c.hebergementChoix === "AUCUN" ? c.hebergementChoix : null;
  if (!choix) return { ok: false, error: "Choisissez l'hébergement." };
  const nuits = nombreLu(c.hebergementNuits);
  const estimation = nombreLu(c.hebergementEstimation);
  if (nuits === false || (nuits != null && (nuits < 0 || !Number.isInteger(nuits)))) return { ok: false, error: "Nombre de nuits illisible." };
  if (estimation === false || (estimation != null && estimation < 0)) return { ok: false, error: "Estimation de l'hôtel illisible." };
  const avecHotel = choix !== "AUCUN";
  return {
    ok: true,
    fiche: {
      presenceDu: du, presenceAu: au,
      transport: {
        mode, depart: txt(c.transportDepart, 80), arrivee: txt(c.transportArrivee, 80), aller, retour, reservation,
        precisions: txt(c.transportPrecisions),
      },
      hebergement: {
        choix,
        hotel: avecHotel ? txt(c.hebergementHotel, 120) : null,
        nuits: avecHotel ? nuits : null,
        estimation: choix === "MOI" ? estimation : null,
      },
      commentaire: txt(c.commentaire, 1000),
    },
  };
}

/** Une fiche stockée (JSON) relue prudemment — illisible = `null`, jamais une erreur à l'affichage. */
export function ficheStockee(brut: unknown): FicheParticipation | null {
  if (!brut || typeof brut !== "object") return null;
  const o = brut as Record<string, unknown>;
  const t = (o.transport && typeof o.transport === "object" ? o.transport : {}) as Record<string, unknown>;
  const h = (o.hebergement && typeof o.hebergement === "object" ? o.hebergement : {}) as Record<string, unknown>;
  const r = lireFiche({
    presenceDu: o.presenceDu, presenceAu: o.presenceAu,
    transportMode: t.mode, transportDepart: t.depart, transportArrivee: t.arrivee, transportAller: t.aller, transportRetour: t.retour,
    transportReservation: t.reservation, transportPrecisions: t.precisions,
    hebergementChoix: h.choix, hebergementHotel: h.hotel,
    hebergementNuits: typeof h.nuits === "number" ? String(h.nuits) : h.nuits,
    hebergementEstimation: typeof h.estimation === "number" ? String(h.estimation) : h.estimation,
    commentaire: o.commentaire,
  });
  return r.ok ? r.fiche : null;
}

/** `JJ/MM` d'un jour ISO. */
export function jourCourt(iso: string | null): string {
  return iso && JOUR.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "—";
}

const plage = (a: string | null, b: string | null) => (a || b ? `${jourCourt(a)} → ${jourCourt(b)}` : null);

/** La devise d'une mission : le dollar à l'international (hors billet), le dinar sinon. */
export function deviseMission(international: boolean): "USD" | "DZD" {
  return international ? "USD" : "DZD";
}

export interface Segment { cle: string; texte: string }
export interface LigneFiche { cle: "presence" | "transport" | "hebergement" | "commentaire"; libelle: string; segments: Segment[] }

/** LA FICHE EN LIGNES LISIBLES — chaque morceau a sa clé, pour comparer deux versions morceau par morceau. */
export function lignesFiche(f: FicheParticipation, international: boolean): LigneFiche[] {
  const s = (cle: string, texte: string | null): Segment[] => (texte ? [{ cle, texte }] : []);
  const t = f.transport;
  const h = f.hebergement;
  const trajet = t.depart || t.arrivee ? `${t.depart ?? "?"} → ${t.arrivee ?? "?"}` : null;
  const out: LigneFiche[] = [
    { cle: "presence", libelle: "Présence", segments: s("presence", plage(f.presenceDu, f.presenceAu)) },
    {
      cle: "transport", libelle: "Transport",
      segments: [
        ...s("mode", MODE_TRANSPORT_LIBELLE[t.mode]), ...s("trajet", trajet), ...s("dates", plage(t.aller, t.retour)),
        ...s("reservation", QUI_RESERVE_LIBELLE[t.reservation]), ...s("precisions", t.precisions),
      ],
    },
    {
      cle: "hebergement", libelle: "Hébergement",
      segments: [
        ...s("choix", HEBERGEMENT_LIBELLE[h.choix]), ...s("hotel", h.hotel),
        ...s("nuits", h.nuits != null ? `${h.nuits} nuit${h.nuits > 1 ? "s" : ""}` : null),
        ...s("estimation", h.estimation != null ? `${h.estimation.toLocaleString("fr-FR")} ${deviseMission(international)}` : null),
      ],
    },
  ];
  if (f.commentaire) out.push({ cle: "commentaire", libelle: "Commentaire", segments: [{ cle: "commentaire", texte: `« ${f.commentaire} »` }] });
  return out;
}

export interface SegmentCompare extends Segment { avant: string | null; change: boolean }
export interface LigneCompare { cle: LigneFiche["cle"]; libelle: string; segments: SegmentCompare[] }

/**
 * CE QUI A CHANGÉ d'une version à la suivante — morceau par morceau. Un morceau changé porte sa valeur d'avant
 * (barrée à l'écran) ; un morceau disparu se montre barré, sans valeur nouvelle. Sans version d'avant : rien
 * n'est « changé ».
 */
export function comparerFiches(avant: FicheParticipation | null, apres: FicheParticipation, international: boolean): LigneCompare[] {
  const lignesAvant = avant ? lignesFiche(avant, international) : [];
  return lignesFiche(apres, international).map((l) => {
    const prec = lignesAvant.find((x) => x.cle === l.cle);
    const segments: SegmentCompare[] = l.segments.map((sg) => {
      if (!avant) return { ...sg, avant: null, change: false };
      const old = prec?.segments.find((x) => x.cle === sg.cle)?.texte ?? null;
      return { ...sg, avant: old !== sg.texte ? old : null, change: old !== sg.texte };
    });
    for (const old of prec?.segments ?? []) {
      if (!l.segments.some((x) => x.cle === old.cle)) segments.push({ cle: old.cle, texte: "", avant: old.texte, change: true });
    }
    return { cle: l.cle, libelle: l.libelle, segments };
  }).filter((l) => l.segments.length > 0);
}

/** Les clés des morceaux qui diffèrent — pour le test et le résumé « 2 changements ». */
export function changements(avant: FicheParticipation | null, apres: FicheParticipation): string[] {
  if (!avant) return [];
  return comparerFiches(avant, apres, false).flatMap((l) => l.segments.filter((s) => s.change).map((s) => s.cle));
}

// ─────────────────────────────── La négociation ───────────────────────────────

export type Cote = "PERSONNE" | "ADVENTUM";
export type NatureVersion = "PROPOSITION" | "CONTRE_PROPOSITION";
export type StatutVersion = "EN_ATTENTE" | "ACCEPTEE" | "REFUSEE" | "REMPLACEE";
export interface VersionLite { numero: number; cote: Cote; nature: NatureVersion; statut: StatutVersion; motifDecision?: string | null }

export type EtapeParticipation =
  | "FICHE_A_REMPLIR" // invitée, aucune version
  | "CHEZ_PERSONNE" // la balle est chez la personne
  | "CHEZ_ADVENTUM" // la balle est chez l'organisateur (et les arbitres)
  | "ACCORD"
  | "DECLINEE"
  | "RETIREE"
  | "CONFIRMEE_SANS_FICHE"; // assignation d'avant la fiche (ou soi-même) : la mission est ouverte

export const autreCote = (c: Cote): Cote => (c === "PERSONNE" ? "ADVENTUM" : "PERSONNE");

/** Une version stockée (textes libres en base), lue pour les règles — une valeur inconnue retombe sur le cas sûr. */
export function versionLite(v: { numero: number; cote: string; nature: string; statut: string; motifDecision?: string | null }): VersionLite {
  const statuts: readonly StatutVersion[] = ["EN_ATTENTE", "ACCEPTEE", "REFUSEE", "REMPLACEE"];
  return {
    numero: v.numero,
    cote: v.cote === "ADVENTUM" ? "ADVENTUM" : "PERSONNE",
    nature: v.nature === "CONTRE_PROPOSITION" ? "CONTRE_PROPOSITION" : "PROPOSITION",
    statut: statuts.find((s) => s === v.statut) ?? "EN_ATTENTE",
    motifDecision: v.motifDecision ?? null,
  };
}

/**
 * OÙ EN EST LA PARTICIPATION. Une version EN ATTENTE met la balle chez l'autre côté ; une version REFUSÉE la
 * rend à son AUTEUR (à lui de reproposer) ; l'accord clôt la discussion.
 */
export function etapeParticipation(a: {
  response: "INVITEE" | "CONFIRMEE" | "DECLINEE"; archivedAt: Date | string | null; accordVersionId: string | null;
}, derniere: VersionLite | null): EtapeParticipation {
  if (a.archivedAt) return "RETIREE";
  if (a.response === "DECLINEE") return "DECLINEE";
  if (a.accordVersionId) return "ACCORD";
  if (!derniere) return a.response === "CONFIRMEE" ? "CONFIRMEE_SANS_FICHE" : "FICHE_A_REMPLIR";
  if (derniere.statut === "ACCEPTEE") return "ACCORD";
  if (derniere.statut === "REFUSEE") return derniere.cote === "PERSONNE" ? "CHEZ_PERSONNE" : "CHEZ_ADVENTUM";
  return derniere.cote === "PERSONNE" ? "CHEZ_ADVENTUM" : "CHEZ_PERSONNE";
}

/** Le côté qui doit agir — `null` quand rien n'attend personne. */
export function aQuiLeTour(e: EtapeParticipation): Cote | null {
  if (e === "FICHE_A_REMPLIR" || e === "CHEZ_PERSONNE") return "PERSONNE";
  if (e === "CHEZ_ADVENTUM") return "ADVENTUM";
  return null;
}

/** « chez vous » quand c'est son tour, sinon le nom de qui doit agir. */
export function chezQui(cote: Cote, vue: Cote | null, noms: { personne: string; organisateur: string | null }): string {
  if (vue === cote) return "chez vous";
  return cote === "PERSONNE" ? `chez ${noms.personne}` : `chez ${noms.organisateur ?? "l'organisateur"}`;
}

/** L'ÉTAT LISIBLE — « état — chez qui » (règle des statuts), avec l'ancienneté d'une fiche attendue. */
export function etatParticipation(
  e: EtapeParticipation, derniere: VersionLite | null, vue: Cote | null,
  noms: { personne: string; organisateur: string | null }, extra: { declineReason?: string | null; depuis?: Date | string | null } = {},
  now: number = Date.now(),
): Etat {
  switch (e) {
    case "RETIREE": return { texte: "retirée", ton: "neutral" };
    case "DECLINEE": return { texte: extra.declineReason ? `déclinée — « ${extra.declineReason} »` : "déclinée", ton: "danger" };
    case "ACCORD": return { texte: "accord trouvé", ton: "success" };
    case "CONFIRMEE_SANS_FICHE": return { texte: "confirmée", ton: "success" };
    case "FICHE_A_REMPLIR": {
      const jours = extra.depuis ? Math.max(0, Math.floor((now - new Date(extra.depuis).getTime()) / 86_400_000)) : 0;
      return { texte: `fiche à remplir — ${chezQui("PERSONNE", vue, noms)}${jours > 0 ? ` · ${jours} j` : ""}`, ton: "info" };
    }
    default: {
      const cote = e === "CHEZ_PERSONNE" ? "PERSONNE" : "ADVENTUM";
      const quoi = derniere?.statut === "REFUSEE" ? "refusée, à reproposer" : derniere?.nature === "CONTRE_PROPOSITION" ? "contre-proposition" : "proposition";
      return { texte: `${quoi} — ${chezQui(cote, vue, noms)}`, ton: derniere?.statut === "REFUSEE" ? "danger" : "warning" };
    }
  }
}

/** Les rôles qui tranchent côté Adventum, en plus de l'organisateur. */
export const ROLES_ARBITRES = ["PRODUCT_MANAGER", "SUPER_ADMIN"] as const;

/**
 * QUI TRANCHE CÔTÉ ADVENTUM : l'organisateur (le demandeur de l'opération Ad & Pro, ou celui qui a invité),
 * la Direction Marketing, le Super Admin.
 */
export function estArbitre(u: { id: string; roles: readonly string[] }, organisateurs: readonly (string | null | undefined)[]): boolean {
  if (organisateurs.some((o) => o && o === u.id)) return true;
  return u.roles.some((r) => (ROLES_ARBITRES as readonly string[]).includes(r));
}

/** Le côté d'une personne sur CETTE participation — la personne invitée d'abord (même Super Admin). */
export function coteDe(userId: string, personneId: string, arbitre: boolean): Cote | null {
  if (userId === personneId) return "PERSONNE";
  return arbitre ? "ADVENTUM" : null;
}

/**
 * PROPOSER (fiche, ou « Modifier et contre-proposer ») : la personne ouvre ; ensuite, seul le côté qui a la balle.
 * Après l'accord, la discussion se rouvre tant que l'ordre de mission n'est ni en cours ni émis (`omLibre`).
 */
export function refusProposition(e: EtapeParticipation, cote: Cote | null, omLibre: boolean): string | null {
  if (!cote) return "Seuls la personne invitée, l'organisateur, la Direction Marketing et le Super Admin négocient la participation.";
  if (e === "RETIREE") return "Cette participation a été retirée.";
  if (e === "DECLINEE") return "La participation a été déclinée : l'organisateur peut réinviter.";
  if (e === "CONFIRMEE_SANS_FICHE") return "Cette mission est déjà confirmée.";
  if (e === "ACCORD") return omLibre ? null : "L'ordre de mission est demandé : l'accord ne se rediscute plus ici.";
  if (e === "FICHE_A_REMPLIR") return cote === "PERSONNE" ? null : "La personne invitée remplit d'abord sa fiche.";
  return aQuiLeTour(e) === cote ? null : "Ce n'est pas votre tour : l'autre partie doit d'abord répondre.";
}

/** ACCEPTER / REFUSER la dernière version : le côté qui a la balle, sur une version en attente ; un refus porte son motif. */
export function refusDecision(
  e: EtapeParticipation, derniere: VersionLite | null, cote: Cote | null, decision: "ACCEPTER" | "REFUSER", motif: string | null,
): string | null {
  if (!cote) return "Seuls la personne invitée, l'organisateur, la Direction Marketing et le Super Admin négocient la participation.";
  if (!derniere || derniere.statut !== "EN_ATTENTE") return "Aucune proposition n'attend de réponse.";
  if (e !== "CHEZ_PERSONNE" && e !== "CHEZ_ADVENTUM") return "La participation n'est plus en discussion.";
  if (aQuiLeTour(e) !== cote) return "Ce n'est pas votre tour : l'autre partie doit d'abord répondre.";
  if (decision === "REFUSER" && !(motif ?? "").trim()) return "Dites pourquoi vous refusez : l'autre partie doit savoir quoi changer.";
  return null;
}

/** La nature d'une nouvelle version : la toute première est une proposition, toutes les autres des contre-propositions. */
export function natureNouvelleVersion(nbVersions: number): NatureVersion {
  return nbVersions === 0 ? "PROPOSITION" : "CONTRE_PROPOSITION";
}

/** L'ordre de mission se demande après l'accord (ou sur une mission d'avant la fiche, déjà confirmée). */
export function peutDemanderOmParticipation(e: EtapeParticipation): boolean {
  return e === "ACCORD" || e === "CONFIRMEE_SANS_FICHE";
}

/** Les dates de la MISSION tirées de la fiche convenue : le voyage, sinon la présence. */
export function datesConvenues(f: FicheParticipation): { depart: string | null; retour: string | null } {
  return { depart: f.transport.aller ?? f.presenceDu, retour: f.transport.retour ?? f.presenceAu };
}

/** La destination convenue : l'arrivée du transport. */
export function destinationConvenue(f: FicheParticipation, villeDemande: string | null): string {
  return f.transport.arrivee ?? villeDemande ?? "";
}

/** Le résumé de l'hébergement pour l'ordre de mission. */
export function hebergementPourOm(f: FicheParticipation): string {
  const h = f.hebergement;
  return [HEBERGEMENT_LIBELLE[h.choix], h.hotel, h.nuits != null ? `${h.nuits} nuit${h.nuits > 1 ? "s" : ""}` : null].filter(Boolean).join(" · ");
}

/** Adventum réserve-t-il quelque chose pour cette personne ? (ce qui part chez l'assistante de direction) */
export function reservationsAdventum(f: FicheParticipation): { billet: boolean; hotel: boolean } {
  const billet = f.transport.reservation === "ADVENTUM" && (f.transport.mode === "AVION" || f.transport.mode === "TRAIN" || f.transport.mode === "BUS");
  return { billet, hotel: f.hebergement.choix === "ADVENTUM" };
}

/** Les lignes envoyées à l'assistante de direction pour réserver. */
export function lignesReservation(nom: string, f: FicheParticipation): string[] {
  const r = reservationsAdventum(f);
  const t = f.transport;
  const out: string[] = [];
  if (r.billet) {
    out.push(`• ${nom} — billet ${MODE_TRANSPORT_LIBELLE[t.mode].toLowerCase()} : ${t.depart ?? "?"} → ${t.arrivee ?? "?"}, aller ${jourCourt(t.aller)}, retour ${jourCourt(t.retour)}${t.precisions ? ` (${t.precisions})` : ""}`);
  }
  if (r.hotel) {
    const h = f.hebergement;
    out.push(`• ${nom} — hôtel${h.hotel ? ` ${h.hotel}` : ""} : ${jourCourt(f.presenceDu)} → ${jourCourt(f.presenceAu)}${h.nuits != null ? `, ${h.nuits} nuit(s)` : ""}`);
  }
  return out;
}

// ─────────────────────────────── La réservation, côté plateforme ───────────────────────────────

/**
 * QUI DÉPOSE LE BILLET ÉMIS ET LA CONFIRMATION D'HÔTEL d'un membre : l'assistante de direction (qui réserve),
 * l'organisateur, la Direction Marketing, le Super Admin — comme sur les fiches voyageur.
 */
export function peutDeposerReservation(u: { id: string; roles: readonly string[] }, organisateurs: readonly (string | null | undefined)[]): boolean {
  return estArbitre(u, organisateurs) || u.roles.includes("DIRECTION_ASSISTANT");
}

/** Les deux trajets d'un billet de mission : l'aller, puis le retour. */
export const TRAJETS_BILLET = ["Aller", "Retour"] as const;

/** Un billet émis se résume : PNR, puis n° et heures de chaque trajet saisi. */
export function resumeBilletEmis(ref: string | null, trajets: readonly DetailTrajet[]): string {
  const parts = trajets.map((d, i) => {
    const bits = [d.numero, d.heureDepart && d.heureArrivee ? `${d.heureDepart} → ${d.heureArrivee}` : d.heureDepart].filter(Boolean);
    return bits.length ? `${TRAJETS_BILLET[i] ?? `Trajet ${i + 1}`} ${bits.join(" ")}` : null;
  }).filter(Boolean);
  return [ref ? `PNR ${ref}` : null, ...parts].filter(Boolean).join(" · ");
}

// ─────────────────────────────── Le budget ───────────────────────────────

/** L'imputation des frais d'un membre (budget Operations & Sales) se choisit par la Direction Marketing, la Direction des opérations ou le Super Admin. */
export function peutChoisirBudgetMission(roles: readonly string[]): boolean {
  return roles.includes("PRODUCT_MANAGER") || roles.includes("OPERATIONS_DIRECTOR") || roles.includes("SUPER_ADMIN");
}

// ─────────────────────────────── Les notes de frais ───────────────────────────────

export const NATURES_FRAIS = ["TRANSPORT", "TAXI", "REPAS", "HOTEL", "AUTRE"] as const;
export type NatureFrais = (typeof NATURES_FRAIS)[number];
export const NATURE_FRAIS_LIBELLE: Record<NatureFrais, string> = {
  TRANSPORT: "Billet / transport", TAXI: "Taxi", REPAS: "Repas", HOTEL: "Hôtel", AUTRE: "Autre",
};

/** La devise d'une dépense : le dollar à l'international, sauf le billet ; le dinar sinon. */
export function deviseFrais(international: boolean, nature: NatureFrais): "USD" | "DZD" {
  return international && nature !== "TRANSPORT" ? "USD" : "DZD";
}

/** Le taux d'une mission : celui, figé, de la demande internationale (240 par défaut) ; aucun au national. */
export function tauxMission(international: boolean, stocke: number | null | undefined): number | null {
  return tauxDeLaDemande(international ? "INTERNATIONAL" : "NATIONAL", stocke);
}

export interface LigneFraisLue { date: string; nature: NatureFrais; detail: string | null; montant: number; devise: "USD" | "DZD"; montantDzd: number | null }

/** Lire une dépense saisie : date, nature, montant positif ; la devise découle de la nature et du périmètre. */
export function lireLigneFrais(
  c: { date?: unknown; nature?: unknown; detail?: unknown; montant?: unknown }, international: boolean, taux: number | null,
): { ok: true; ligne: LigneFraisLue } | { ok: false; error: string } {
  const date = jourLu(c.date);
  if (!date) return { ok: false, error: "Indiquez la date de la dépense." };
  const nature = NATURES_FRAIS.find((n) => n === c.nature);
  if (!nature) return { ok: false, error: "Choisissez la nature de la dépense." };
  const montant = nombreLu(c.montant);
  if (montant === false || montant == null) return { ok: false, error: "Indiquez le montant." };
  if (montant <= 0) return { ok: false, error: "Le montant doit être supérieur à zéro." };
  const devise = deviseFrais(international, nature);
  return { ok: true, ligne: { date, nature, detail: txt(c.detail, 200), montant, devise, montantDzd: versDzd(montant, devise, taux) } };
}

/** LE TOTAL des dépenses : par devise saisie, et l'équivalent DZD (ce qui part aux RH). */
export function totalFrais(lignes: readonly { montant: number; devise: "USD" | "DZD" }[], taux: number | null): { usd: number; dzd: number; totalDzd: number | null } {
  let usd = 0, dzd = 0;
  for (const l of lignes) { if (l.devise === "USD") usd += l.montant; else dzd += l.montant; }
  const usdEnDzd = usd > 0 ? versDzd(usd, "USD", taux) : 0;
  const r = (n: number) => Math.round(n * 100) / 100;
  return { usd: r(usd), dzd: r(dzd), totalDzd: usdEnDzd == null ? null : r(dzd + usdEnDzd) };
}

/** Le mois d'imputation de la note de frais : celui du retour (AAAA-MM). */
export function moisNoteFrais(retour: string | null, aujourdhui: string): string {
  return (retour && JOUR.test(retour) ? retour : aujourdhui).slice(0, 7);
}

// ─────────────────────────────── Le rapport et la clôture ───────────────────────────────

export interface Rapport { deroule: string | null; medecins: string | null; retombees: string | null; suites: string | null }

export function rapportRedige(r: Rapport): boolean {
  return Boolean((r.deroule ?? "").trim());
}

/**
 * CE QUI MANQUE POUR CLÔTURER : l'ordre de mission émis, la mission terminée (jour du retour atteint), le
 * rapport (au moins le déroulé), un justificatif sur chaque dépense. Une mission sans dépense se clôture :
 * seul le rapport part.
 */
export function manquesCloture(m: {
  cloturee: boolean; omEmis: boolean; terminee: boolean; rapport: Rapport; lignes: readonly { justificatif: boolean }[];
}): string[] {
  if (m.cloturee) return ["La mission est déjà clôturée."];
  const out: string[] = [];
  if (!m.omEmis) out.push("L'ordre de mission n'est pas encore émis.");
  if (!m.terminee) out.push("La mission n'est pas terminée (jour du retour).");
  if (!rapportRedige(m.rapport)) out.push("Rédigez le rapport de mission (au moins le déroulé).");
  const sans = m.lignes.filter((l) => !l.justificatif).length;
  if (sans > 0) out.push(`Joignez le justificatif de chaque dépense (${sans} manquant${sans > 1 ? "s" : ""}).`);
  return out;
}

/** Une dépense ne se modifie plus après la clôture. */
export function refusModifFrais(m: { cloturee: boolean; omEmis: boolean }, estLaPersonne: boolean): string | null {
  if (!estLaPersonne) return "Seule la personne en mission saisit ses dépenses.";
  if (m.cloturee) return "La mission est clôturée : ses dépenses ne se modifient plus.";
  if (!m.omEmis) return "Les dépenses se saisissent une fois l'ordre de mission émis.";
  return null;
}

/** La décision du N+1 sur la note de frais d'une mission : la sienne, ouverte, et un refus porte son motif. */
export function refusDecisionN1NoteFrais(
  req: { type: string; status: string; managerGate: string | null; missionAssignmentId: string | null },
  estN1: boolean, decision: "VALIDER" | "REFUSER", motif: string | null,
): string | null {
  if (req.type !== "EXPENSE_REPORT" || !req.missionAssignmentId) return "Cette demande n'est pas une note de frais de mission.";
  if (req.managerGate !== "PENDING" || req.status !== "PENDING") return "Cette note de frais n'attend plus la décision du N+1.";
  if (!estN1) return "Seul le N+1 de la personne valide sa note de frais.";
  if (decision === "REFUSER" && !(motif ?? "").trim()) return "Dites pourquoi vous refusez : la personne doit savoir quoi faire.";
  return null;
}

/** La note de frais d'une mission, relue « état — chez qui » : N+1, puis RH. */
export function etatNoteFraisMission(statut: string, gate: string | null, motif: string | null = null): Etat {
  if (gate === "PENDING") return { texte: "note de frais — chez votre N+1", ton: "warning" };
  if (gate === "REJECTED") return { texte: motif ? `refusée par le N+1 — « ${motif} »` : "refusée par le N+1", ton: "danger" };
  if (statut === "PENDING" || statut === "IN_PROGRESS") return { texte: "note de frais — chez les RH", ton: "info" };
  if (statut === "READY" || statut === "DELIVERED" || statut === "APPROVED") return { texte: "note de frais validée", ton: "success" };
  if (statut === "REJECTED") return { texte: "refusée par les RH", ton: "danger" };
  return { texte: "note de frais annulée", ton: "neutral" };
}

/** La phase de la mission, pour l'écran : participation, ordre de mission, mission ouverte, clôturée. */
export type PhaseMission = "PARTICIPATION" | "ORDRE" | "MISSION" | "CLOTUREE";
export function phaseMission(e: EtapeParticipation, omEmis: boolean, cloturee: boolean): PhaseMission {
  if (cloturee) return "CLOTUREE";
  if (omEmis && (e === "ACCORD" || e === "CONFIRMEE_SANS_FICHE")) return "MISSION";
  if (e === "ACCORD" || e === "CONFIRMEE_SANS_FICHE") return "ORDRE";
  return "PARTICIPATION";
}

/** L'état d'une mission ouverte : « en préparation » avant le retour, « à clôturer — chez … » ensuite. */
export function etatMissionOuverte(phase: PhaseMission, terminee: boolean, vue: Cote | null, personne: string): Etat {
  if (phase === "CLOTUREE") return { texte: "clôturée", ton: "success" };
  if (phase !== "MISSION") return { texte: "en préparation", ton: "info" };
  return terminee ? { texte: `à clôturer — ${vue === "PERSONNE" ? "chez vous" : `chez ${personne}`}`, ton: "warning" } : { texte: "en préparation", ton: "info" };
}
