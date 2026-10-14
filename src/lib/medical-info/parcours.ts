/**
 * OÙ EN EST UN DOSSIER, CHEZ QUI, DEPUIS QUAND — la frise et la pastille, lues une fois.
 *
 * La liste dit sur chaque ligne « état — chez qui » et depuis combien de jours ; la fiche montre la
 * frise des étapes puis LA seule chose à faire maintenant. Les deux lisent ce module : une pastille
 * qui dirait « chez la Direction » pendant que la frise montre le pharmacien serait pire que rien.
 *
 * ── LES ÉTAPES ──────────────────────────────────────────────────────────────────────────────
 *
 *   ÉVÉNEMENT : Reçu → À déclarer ? → Pièces → Dépôt ministère → Pharmacien → Directeur des Opérations
 *   MATÉRIEL  : Reçu → Pièces → Bons de versement → Dépôt ministère → Pharmacien → Directeur des Opérations
 *
 * La dernière étape garde sa clé `DIRECTION` (la validation finale) ; elle appartient au Directeur
 * des Opérations depuis 10/2026 (`decideur.ts`) — à défaut au Super Admin, que `chezDecideur` nomme.
 *
 * L'étape COURANTE est la première qui n'est ni faite ni sans objet. Les pièces sont facultatives
 * (le pharmacien en réclame quand il lui en manque) : sans demande, l'étape est « sans objet ».
 *
 * Module PUR : ni base, ni session — la frise, la pastille et l'étape courante se testent sans base.
 */
import { declareStage, type DeclareInput } from "./declare-decision";
import { slipStage, type SlipInput, type SlipsLotStage, type SlipsSummary } from "./slips";
import type { MedicalCircuit } from "./circuits";
import { RELANCE_DELAI_MS } from "@/lib/tasks/request-flow";
import { DECIDEUR_INFO_MED_LABEL } from "./decideur";

export type EtapeCle = "RECU" | "DECLARER" | "PIECES" | "BONS" | "DEPOT" | "PHARMACIEN" | "DIRECTION";
export type EtatEtape = "FAIT" | "ICI" | "A_VENIR" | "SANS_OBJET";
/** Les tons de `Badge` — repris tels quels, sans importer le fichier des libellés. */
export type TonPastille = "neutral" | "info" | "success" | "warning" | "danger" | "purple";

export const ETAPE_LABEL: Record<EtapeCle, string> = {
  RECU: "Reçu",
  DECLARER: "À déclarer ?",
  PIECES: "Pièces",
  BONS: "Bons de versement",
  DEPOT: "Dépôt ministère",
  PHARMACIEN: "Pharmacien",
  DIRECTION: DECIDEUR_INFO_MED_LABEL,
};

const ORDRE: Record<MedicalCircuit, EtapeCle[]> = {
  EVENT: ["RECU", "DECLARER", "PIECES", "DEPOT", "PHARMACIEN", "DIRECTION"],
  PROMO: ["RECU", "PIECES", "BONS", "DEPOT", "PHARMACIEN", "DIRECTION"],
};

export interface PieceLue {
  id?: string;
  status: string;
  createdAt: Date;
  fulfilledAt: Date | null;
  targetUserId: string | null;
  targetName: string | null;
}

export interface BonLu extends SlipInput {
  updatedAt?: Date | null;
}

export interface ParcoursInput {
  circuit: MedicalCircuit;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  declare: DeclareInput;
  declareRequestedAt: Date | null;
  authorityRef: string | null;
  lot: SlipsLotStage;
  slips: readonly BonLu[];
  summary: SlipsSummary;
  skipped: boolean;
  bvRequestedAt: Date | null;
  requests: readonly PieceLue[];
  pharmacistValidatedAt: Date | null;
  validatedAt: Date | null;
  pharmacistName: string | null;
  /**
   * Chez qui attendent les décisions du pharmacien — « le Directeur des Opérations », ou « le Super
   * Admin » quand aucun directeur n'est actif (`chezDecideur`). Absent : le Directeur des Opérations.
   */
  chezDecideur?: string | null;
}

export interface Etape {
  cle: EtapeCle;
  libelle: string;
  etat: EtatEtape;
  /** Le petit texte sous l'étape (« oui », « 2 sur 4 »…), ou `null`. */
  detail: string | null;
  /** La date qui accompagne le détail, formatée par l'écran. */
  date: Date | null;
}

/** Le groupe d'une ligne pour les tuiles du registre — exclusif : chaque dossier en ouvert compte une fois. */
export type GroupeTuile = "A_DECLARER" | "PIECES" | "A_VALIDER_PHARMACIEN" | "A_VALIDER_DIRECTION" | "BONS_FINANCES" | "VALIDE";

export interface Parcours {
  etapes: Etape[];
  /** L'étape où le dossier attend ; `null` une fois validé par la Direction. */
  courante: EtapeCle | null;
  /** Ce qu'on lit sur la pastille, avant le tiret. */
  etat: string;
  /** Chez qui la balle se trouve, ou `null` (dossier clos). */
  chez: string | null;
  ton: TonPastille;
  /** Depuis quand le dossier est à cette étape ; `null` une fois validé. */
  depuis: Date | null;
  groupe: GroupeTuile;
}

const pending = (r: PieceLue) => r.status === "PENDING";

/** « Amel Amarni » → « Amel A. » — la pastille tient sur une ligne. */
export function nomCourt(nom: string | null | undefined): string | null {
  const parts = (nom ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

function maxDate(...ds: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const d of ds) if (d && (!best || d.getTime() > best.getTime())) best = d;
  return best;
}

function minDate(ds: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const d of ds) if (d && (!best || d.getTime() < best.getTime())) best = d;
  return best;
}

/** Les pièces encore attendues : chez qui, nommé — une personne par son nom, plusieurs par leur nombre. */
export function chezPieces(requests: readonly PieceLue[]): string | null {
  const cibles = new Map<string, string | null>();
  for (const r of requests.filter(pending)) cibles.set(r.targetUserId ?? `?${r.targetName ?? ""}`, r.targetName);
  if (cibles.size === 0) return null;
  if (cibles.size === 1) return nomCourt([...cibles.values()][0]) ?? "la personne sollicitée";
  return `${cibles.size} personnes`;
}

/** Les bons dont le paiement est entre les mains du centre ou des Finances. */
function bonsEnPaiement(slips: readonly BonLu[]): { centre: number; finances: number } {
  let centre = 0;
  let finances = 0;
  for (const s of slips) {
    const st = slipStage(s);
    if (st === "AU_CENTRE") centre++;
    else if (st === "AUX_FINANCES" || st === "PAYE") finances++;
  }
  return { centre, finances };
}

/** Le pharmacien peut-il valider ? La même règle que le serveur (`validateDeclaration`). */
export function pharmacienPeutValider(i: Pick<ParcoursInput, "circuit" | "declare" | "authorityRef" | "summary" | "skipped"> & { declarationKind?: string | null }): boolean {
  if (i.circuit === "EVENT") {
    if (declareStage(i.declare) !== "ACCORDEE") return false;
    if (i.declare.intent === "SKIP") return true;
    return Boolean(i.authorityRef && i.authorityRef.trim());
  }
  // UNE DEMANDE DE VISA PUBLICITAIRE se valide avec SON NUMÉRO DE VISA (audit 10/2026) : valider un
  // visa qu'on n'a pas, c'est clore le dossier promotionnel « visé » sur une promesse.
  if (visaExige(i) && !(i.authorityRef && i.authorityRef.trim())) return false;
  return i.summary.allDelivered || i.skipped;
}

/** Le dossier est-il une demande de visa publicitaire (nature choisie) ? — son numéro est alors exigé. */
export function visaExige(i: { declarationKind?: string | null }): boolean {
  return i.declarationKind === "AD_VISA";
}

export function parcoursOf(i: ParcoursInput): Parcours {
  const valide = i.status === "VALIDATED";
  const chezDirection = i.status === "AWAITING_DIRECTION";
  const pharmacienFait = valide || chezDirection;
  const stage = declareStage(i.declare);
  const total = i.requests.length;
  const recues = i.requests.filter((r) => r.status === "FULFILLED").length;
  const attendues = i.requests.filter(pending);
  const intentSkip = i.declare.intent === "SKIP";

  const brut = (cle: EtapeCle): Omit<Etape, "libelle"> => {
    switch (cle) {
      case "RECU":
        return { cle, etat: "FAIT", detail: null, date: i.createdAt };
      case "DECLARER": {
        if (stage === "ACCORDEE") return { cle, etat: "FAIT", detail: intentSkip ? "non" : "oui", date: null };
        const detail = stage === "EN_VALIDATION" ? "en validation" : stage === "A_REVOIR" ? "à revoir" : stage === "REFUSEE" ? "refusée" : null;
        return { cle, etat: "A_VENIR", detail, date: stage === "A_DEMANDER" ? null : i.declareRequestedAt };
      }
      case "PIECES":
        if (total === 0) return { cle, etat: "SANS_OBJET", detail: "aucune", date: null };
        return { cle, etat: attendues.length === 0 ? "FAIT" : "A_VENIR", detail: `${recues} sur ${total}`, date: null };
      case "BONS": {
        if (i.skipped) return { cle, etat: "SANS_OBJET", detail: "sans versement", date: null };
        if (i.summary.allDelivered) return { cle, etat: "FAIT", detail: `${i.summary.count} remis`, date: null };
        const detail =
          i.summary.count === 0 ? "à séparer"
          : i.lot === "EN_VALIDATION" ? "en validation"
          : i.lot === "VALIDATION_A_REVOIR" ? "à revoir"
          : i.lot === "VALIDATION_REFUSEE" ? "refusé"
          : i.lot === "QUITTANCE_A_DEMANDER" ? `${i.summary.delivered} sur ${i.summary.count} remis`
          : `${i.summary.count} matériel${i.summary.count > 1 ? "s" : ""}`;
        return { cle, etat: "A_VENIR", detail, date: null };
      }
      case "DEPOT":
        if (i.circuit === "EVENT" && stage === "ACCORDEE" && intentSkip) return { cle, etat: "SANS_OBJET", detail: "sans objet", date: null };
        if (i.authorityRef && i.authorityRef.trim()) return { cle, etat: "FAIT", detail: i.authorityRef.trim(), date: null };
        return { cle, etat: "A_VENIR", detail: null, date: null };
      case "PHARMACIEN":
        return pharmacienFait
          ? { cle, etat: "FAIT", detail: null, date: i.pharmacistValidatedAt }
          : { cle, etat: "A_VENIR", detail: null, date: null };
      case "DIRECTION":
        return valide
          ? { cle, etat: "FAIT", detail: null, date: i.validatedAt }
          : { cle, etat: "A_VENIR", detail: null, date: null };
    }
  };

  const etapes: Etape[] = ORDRE[i.circuit].map((cle) => ({ ...brut(cle), libelle: ETAPE_LABEL[cle] }));

  // Le pharmacien a validé : ce qui restait en amont ne bloque plus rien (une pièce jamais reçue,
  // un dépôt non enregistré au circuit matériel) — c'est passé, pas « à venir ».
  if (pharmacienFait) {
    for (const e of etapes) if (e.etat === "A_VENIR" && e.cle !== "DIRECTION") e.etat = "SANS_OBJET";
  }

  const courante = valide ? null : (etapes.find((e) => e.etat === "A_VENIR")?.cle ?? null);
  for (const e of etapes) if (e.cle === courante) e.etat = "ICI";

  const pharmacien = nomCourt(i.pharmacistName) ?? "le pharmacien";
  const dernierMouvementBons = maxDate(i.bvRequestedAt, ...i.slips.map((s) => s.updatedAt ?? null));
  const dernierePiece = maxDate(...i.requests.map((r) => r.fulfilledAt));

  let etat: string;
  let chez: string | null;
  let ton: TonPastille;
  let depuis: Date | null;
  let groupe: GroupeTuile;

  switch (courante) {
    case null:
      etat = "Validé"; chez = null; ton = "success"; depuis = null; groupe = "VALIDE";
      break;
    case "DIRECTION":
      etat = "À valider"; chez = i.chezDecideur ?? `le ${DECIDEUR_INFO_MED_LABEL}`; ton = "purple";
      depuis = i.pharmacistValidatedAt ?? i.updatedAt; groupe = "A_VALIDER_DIRECTION";
      break;
    case "PHARMACIEN":
      etat = "À valider"; chez = pharmacien; ton = "purple";
      depuis = maxDate(i.createdAt, i.declareRequestedAt, dernierePiece, ...i.slips.map((s) => s.deliveredAt), i.authorityRef ? i.updatedAt : null);
      groupe = "A_VALIDER_PHARMACIEN";
      break;
    case "DECLARER":
      if (stage === "EN_VALIDATION") { etat = "Décision en validation"; chez = i.chezDecideur ?? `le ${DECIDEUR_INFO_MED_LABEL}`; ton = "info"; }
      else if (stage === "A_REVOIR" || stage === "REFUSEE") { etat = "Décision à reprendre"; chez = pharmacien; ton = "warning"; }
      else { etat = "À déclarer ?"; chez = pharmacien; ton = "warning"; }
      depuis = stage === "A_DEMANDER" ? i.createdAt : (i.declareRequestedAt ?? i.createdAt);
      groupe = "A_DECLARER";
      break;
    case "PIECES":
      etat = "Pièces attendues"; chez = chezPieces(i.requests); ton = "warning";
      depuis = minDate(attendues.map((r) => r.createdAt)) ?? i.createdAt;
      groupe = "PIECES";
      break;
    case "BONS": {
      const paiement = bonsEnPaiement(i.slips);
      const resteChezPharmacien = i.lot !== "EN_VALIDATION" && (i.lot !== "QUITTANCE_A_DEMANDER" || i.summary.toRequest > 0
        || i.slips.some((s) => slipStage(s) === "RENVOYE"));
      depuis = dernierMouvementBons ?? i.createdAt;
      if (i.lot === "EN_VALIDATION") {
        etat = "Bons en validation"; chez = i.chezDecideur ?? `le ${DECIDEUR_INFO_MED_LABEL}`; ton = "info"; groupe = "A_DECLARER";
      } else if (resteChezPharmacien) {
        etat = "Bons de versement"; chez = pharmacien; ton = "warning"; groupe = "A_DECLARER";
      } else if (paiement.finances > 0) {
        etat = "Bon de versement"; chez = "les Finances"; ton = "info"; groupe = "BONS_FINANCES";
      } else {
        etat = "Bon de versement"; chez = "le centre de paiement"; ton = "info"; groupe = "BONS_FINANCES";
      }
      break;
    }
    case "DEPOT":
      etat = "Dépôt au ministère"; chez = pharmacien; ton = "warning";
      depuis = maxDate(i.createdAt, i.declareRequestedAt, dernierePiece, ...i.slips.map((s) => s.deliveredAt), i.skipped ? i.updatedAt : null);
      groupe = "A_DECLARER";
      break;
    default:
      etat = "En cours"; chez = pharmacien; ton = "neutral"; depuis = i.updatedAt; groupe = "A_DECLARER";
  }

  return { etapes, courante, etat, chez, ton, depuis, groupe };
}

/** « État — chez qui », tel que la pastille l'écrit. */
export function libellePastille(p: Pick<Parcours, "etat" | "chez">): string {
  return p.chez ? `${p.etat} — chez ${p.chez}` : p.etat;
}

const JOUR_MS = 24 * 60 * 60 * 1000;

/** Jours entiers écoulés — 0 le jour même. */
export function joursDepuis(d: Date | null, now: Date = new Date()): number | null {
  if (!d) return null;
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / JOUR_MS));
}

/** Orange au-delà d'une semaine, rouge au-delà de deux. */
export function tonDelai(jours: number | null): "normal" | "attention" | "retard" {
  if (jours === null) return "normal";
  if (jours > 14) return "retard";
  if (jours > 7) return "attention";
  return "normal";
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// « CE QU'IL RESTE À FAIRE » — pour CELUI QUI REGARDE
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** Les blocs que la carte d'action sait montrer — chacun est un composant d'action existant. */
export type BlocAction =
  | "PIECES_A_DEPOSER"     // la personne sollicitée dépose sa pièce
  | "PIECES_ATTENDUES"     // le pharmacien suit (et relance) les pièces demandées
  | "DECLARER"             // la décision « faut-il déclarer ? »
  | "BONS"                 // le tableau des bons avec les gestes du lot
  | "DEPOT"                // le dépôt au ministère
  | "VALIDER_PHARMACIEN"
  | "VALIDER_DIRECTION"
  | "REMETTRE_QUITTANCE";  // les Finances remettent une quittance réglée

export interface Spectateur {
  /** Pharmacien responsable, Direction, admin — qui instruit le dossier. */
  gestionnaire: boolean;
  /** Qui donne la validation finale — le Directeur des Opérations (à défaut le Super Admin). */
  direction: boolean;
  /** Les Finances, hors gestionnaires, quand un bon leur est parvenu. */
  finances: boolean;
  /** Combien de pièces attendues LUI sont demandées. */
  aDeposer: number;
  /** Une quittance réglée attend-elle d'être remise ? */
  aRemettre: boolean;
}

export interface CarteAction {
  /** Ce qu'il fait maintenant — le plus souvent un seul bloc. */
  principal: BlocAction[];
  /** Le geste suivant, possible sans attendre (replié sous la carte), ou `null`. */
  aussi: { bloc: BlocAction; libelle: string } | null;
  /** Rien pour lui : « En attente — chez X ». */
  attente: string | null;
}

const BLOC_DE_L_ETAPE: Partial<Record<EtapeCle, BlocAction>> = {
  DECLARER: "DECLARER",
  PIECES: "PIECES_ATTENDUES",
  BONS: "BONS",
  DEPOT: "DEPOT",
  PHARMACIEN: "VALIDER_PHARMACIEN",
};

/**
 * LA SEULE CHOSE À FAIRE MAINTENANT, CHEZ CELUI QUI REGARDE — orchestrée par l'étape courante.
 *
 * Les pièces sont facultatives et n'arrêtent pas le circuit : quand elles sont l'étape courante, le
 * geste suivant reste à portée (« continuer sans attendre »). Le circuit matériel ne demande pas de
 * référence de dépôt pour valider : le dépôt en cours, la validation reste à portée elle aussi.
 * Les droits ne se décident pas ici — chaque bloc garde ceux du composant qu'il affiche.
 */
export function carteAction(
  p: Pick<Parcours, "etapes" | "courante" | "etat" | "chez">,
  v: Spectateur,
  regles: { pharmacienPeutValider: boolean; autoritesOuvertes: boolean },
): CarteAction {
  const principal: BlocAction[] = [];
  let aussi: CarteAction["aussi"] = null;

  if (v.aDeposer > 0) principal.push("PIECES_A_DEPOSER");

  if (p.courante && p.courante !== "DIRECTION" && v.gestionnaire) {
    const bloc = BLOC_DE_L_ETAPE[p.courante];
    if (bloc) principal.push(bloc);
    if (p.courante === "PIECES") {
      const i = p.etapes.findIndex((e) => e.cle === "PIECES");
      const suivante = p.etapes.slice(i + 1).find((e) => e.etat === "A_VENIR");
      const blocSuivant = suivante ? BLOC_DE_L_ETAPE[suivante.cle] : undefined;
      const possible = blocSuivant === "VALIDER_PHARMACIEN" ? regles.pharmacienPeutValider
        : blocSuivant === "DEPOT" ? regles.autoritesOuvertes
        : Boolean(blocSuivant);
      if (blocSuivant && possible) aussi = { bloc: blocSuivant, libelle: "Continuer sans attendre les pièces" };
    } else if (p.courante === "DEPOT" && regles.pharmacienPeutValider) {
      aussi = { bloc: "VALIDER_PHARMACIEN", libelle: "Valider sans référence de dépôt" };
    } else if (p.courante === "PHARMACIEN" && regles.autoritesOuvertes) {
      aussi = { bloc: "DEPOT", libelle: "Modifier le dépôt au ministère" };
    }
  }

  if (p.courante === "DIRECTION" && v.direction) principal.push("VALIDER_DIRECTION");
  // Transmis au Directeur des Opérations, le dépôt se corrige encore (une référence mal saisie) — replié.
  if (p.courante === "DIRECTION" && v.gestionnaire && regles.autoritesOuvertes) {
    aussi = { bloc: "DEPOT", libelle: "Modifier le dépôt au ministère" };
  }
  if (v.finances && v.aRemettre) principal.push("REMETTRE_QUITTANCE");

  const attente = principal.length === 0
    ? (p.courante === null ? null : libellePastille({ etat: "En attente", chez: p.chez }))
    : null;
  return { principal, aussi, attente };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// RELANCER UNE PIÈCE ATTENDUE
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * QUI peut relancer une pièce, et QUAND — la règle des tâches (`RELANCE_DELAI_MS`, quatre heures
 * depuis la demande ou la dernière relance) : on peut relancer le matin puis le soir, pas marteler.
 *
 * Relance qui a la main sur le dossier (le pharmacien, la Direction) ou qui a fait la demande ;
 * jamais la personne sollicitée elle-même.
 */
export function peutRelancerPiece(
  r: { status: string; createdAt: Date; targetUserId: string | null; requestedById: string | null },
  ctx: { userId: string; gestionnaire: boolean; derniereRelance: Date | null; now?: number },
): { ok: true } | { ok: false; raison: string } {
  if (r.status !== "PENDING") return { ok: false, raison: "Cette pièce n'est plus attendue." };
  if (!r.targetUserId) return { ok: false, raison: "Personne n'est sollicité pour cette pièce." };
  if (r.targetUserId === ctx.userId) return { ok: false, raison: "Cette pièce vous est demandée — vous n'avez personne à relancer." };
  if (!ctx.gestionnaire && r.requestedById !== ctx.userId) return { ok: false, raison: "Seul le pharmacien responsable ou l'auteur de la demande peut relancer." };
  const now = ctx.now ?? Date.now();
  const base = Math.max(r.createdAt.getTime(), ctx.derniereRelance?.getTime() ?? 0);
  const prochaine = base + RELANCE_DELAI_MS;
  if (now < prochaine) {
    const heures = Math.max(1, Math.ceil((prochaine - now) / 3_600_000));
    return { ok: false, raison: `Trop tôt : vous pourrez relancer dans ${heures} h.` };
  }
  return { ok: true };
}
