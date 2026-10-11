/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE LIVRET DE SÉJOUR (Direction, 10/2026) — CE QUI VA DANS LE LIVRET, sans le dessiner.
 *
 * Deux livrets par prise en charge (congrès national ou international) :
 *   • le LIVRET INDIVIDUEL d'un professionnel : couverture, lettre d'invitation sur le papier à en-tête, son
 *     voyage (vols, transferts), son hébergement (hôtel, repas, accès), son programme jour par jour, ses contacts ;
 *   • le LIVRET GÉNÉRAL de la délégation : couverture, lettre « Mesdames et Messieurs », participants et vols,
 *     hébergement et chambres (avec les repas du groupe), programme commun, l'équipe Adventum, le dos.
 *
 * Les RÈGLES qui comptent, toutes ici (testées) :
 *   • une donnée absente s'écrit « à confirmer » — jamais devinée ;
 *   • un poste « sans objet » (WAIVED) se dit « sans billet », « sans hôtel », et ne paraît pas au planning ;
 *   • le planning trie tout ce qui a une date (vols, transferts, repas, accès, dates de l'événement) par jour puis heure ;
 *   • AUCUN MONTANT, aucun devis, aucun numéro de passeport : les entrées de ce module n'en portent pas — `versPoste`
 *     RECOPIE champ par champ ce qu'il garde, si bien qu'une case qui porte un montant le laisse à la porte.
 *
 * Module PUR : aucune importation (ni base, ni fichier, ni police) — le rendu PDF (`rendu-pdf.ts`) le dessine, le
 * serveur (`serveur.ts`) le nourrit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const A_CONFIRMER = "à confirmer";

// ───────────────────────────── Les entrées ─────────────────────────────

export interface EtapeLivret { de: string | null; vers: string | null; date: string | null }
export interface DetailLivret { numero: string | null; heureDepart: string | null; heureArrivee: string | null; reference: string | null }

/** Un poste d'une fiche voyageur, réduit à ce que le livret imprime (dates AAAA-MM-JJ, heures HH:MM). */
export interface PosteLivret {
  id: string;
  kind: string;
  serviceKind: string | null;
  label: string;
  status: string;
  dateStart: string | null;
  dateEnd: string | null;
  trajet: string | null;
  transport: string | null;
  fromCity: string | null;
  toCity: string | null;
  segments: EtapeLivret[];
  hotelName: string | null;
  city: string | null;
  roomType: string | null;
  bookingRef: string | null;
  legDetails: DetailLivret[];
  timeStart: string | null;
  address: string | null;
  /** Un billet émis / un voucher a-t-il été déposé ? (le fichier lui-même ne va pas dans le livret). */
  emis: boolean;
}

export type Civilite = "PR" | "DR" | null;

export interface PersonneLivret {
  id: string;
  nom: string;
  civilite: Civilite;
  fonction: string | null;
  service: string | null;
  etablissement: string | null;
  statut: string;
  postes: PosteLivret[];
}

export interface PosteGroupeLivret {
  id: string;
  serviceKind: string;
  label: string;
  date: string | null;
  timeStart: string | null;
  address: string | null;
  exclus: string[];
  status: string;
}

export interface EvenementLivret {
  nom: string;
  ville: string | null;
  pays: string | null;
  /** Hôpital, association, salle — le lieu précis quand il est connu. */
  lieu: string | null;
  debut: string | null;
  fin: string | null;
  international: boolean;
}

export interface ContactLivret { nom: string; fonction: string | null; telephone: string | null }

/** Un membre de l'équipe Adventum qui accompagne (une mission acceptée), avec ses dates convenues et son billet. */
export interface MembreLivret extends ContactLivret {
  du: string | null;
  au: string | null;
  billetReference: string | null;
  trajets: DetailLivret[];
  hotelNom: string | null;
  hotelConfirmation: string | null;
}

export interface EntreeLivret {
  evenement: EvenementLivret;
  personnes: PersonneLivret[];
  groupe: PosteGroupeLivret[];
  equipe: MembreLivret[];
  /** Qui a porté la demande (contact sur place, s'il n'est pas déjà de l'équipe). */
  demandeur: ContactLivret | null;
  /** L'assistante de direction, à Alger. */
  assistante: ContactLivret | null;
  /** Jour d'édition, AAAA-MM-JJ. */
  edition: string;
}

/** Une case lue par l'écran (`CellRow`) — on n'en RECOPIE que ce que le livret imprime : jamais un montant. */
export interface CaseLue {
  id: string; kind: string; serviceKind: string | null; label: string; status: string;
  dateStart: string | null; dateEnd: string | null; trajet: string | null; transport: string | null;
  fromCity: string | null; toCity: string | null; segments: readonly EtapeLivret[];
  hotelName: string | null; city: string | null; roomType: string | null; bookingRef: string | null;
  legDetails: readonly DetailLivret[]; timeStart: string | null; address: string | null; issuedDocumentId: string | null;
}

export function versPoste(c: CaseLue): PosteLivret {
  return {
    id: c.id, kind: c.kind, serviceKind: c.serviceKind, label: c.label, status: c.status,
    dateStart: c.dateStart, dateEnd: c.dateEnd, trajet: c.trajet, transport: c.transport,
    fromCity: c.fromCity, toCity: c.toCity, segments: c.segments.map((s) => ({ de: s.de, vers: s.vers, date: s.date })),
    hotelName: c.hotelName, city: c.city, roomType: c.roomType, bookingRef: c.bookingRef,
    legDetails: c.legDetails.map((d) => ({ numero: d.numero, heureDepart: d.heureDepart, heureArrivee: d.heureArrivee, reference: d.reference })),
    timeStart: c.timeStart, address: c.address, emis: Boolean(c.issuedDocumentId),
  };
}

// ───────────────────────────── Le modèle produit ─────────────────────────────

export interface LigneInfo { cle: string; valeur: string; fort?: boolean }
export interface CelluleTable { fort?: string | null; texte: string }
export interface ItemJour { heure: string; texte: string }

export type Bloc =
  | { t: "vol"; etiquette: string; de: string; vers: string; sousDe: string; sousVers: string; lignes: LigneInfo[] }
  | { t: "lignes"; etiquette?: string; lignes: LigneInfo[] }
  | { t: "h3"; texte: string }
  | { t: "texte"; texte: string }
  | { t: "table"; colonnes: { titre: string; part: number }[]; lignes: CelluleTable[][] }
  | { t: "jour"; numero: string; semaine: string; items: ItemJour[] }
  | { t: "contacts"; cartes: { titre: string; lignes: string[] }[] }
  | { t: "puces"; items: string[] };

export interface Section { titre: string; sousTitre: string | null; blocs: Bloc[] }

export interface Livret {
  type: "INDIVIDUEL" | "GENERAL";
  nomFichier: string;
  /** Le pied des pages intérieures : « Congrès SFLS 2026 · Pr Nadia Exemple ». */
  pied: string;
  couverture: { surtitre: string; titre: string; lieu: string; pourEtiquette: string; pourNom: string };
  lettre: { date: string; destinataire: string[] | null; objet: string; salutation: string; paragraphes: string[]; formule: string };
  sections: Section[];
  dos: boolean;
}

// ───────────────────────────── Dates et noms ─────────────────────────────

const JOUR = /^\d{4}-\d{2}-\d{2}$/;
const dateUtc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const valide = (iso: string | null | undefined): iso is string => Boolean(iso && JOUR.test(iso) && !Number.isNaN(dateUtc(iso).getTime()));
const fr = (iso: string, o: Intl.DateTimeFormatOptions) => dateUtc(iso).toLocaleDateString("fr-FR", { timeZone: "UTC", ...o });

/** « jeudi 26 novembre » */
export function jourLong(iso: string | null): string {
  return valide(iso) ? fr(iso, { weekday: "long", day: "numeric", month: "long" }) : `date ${A_CONFIRMER}`;
}
/** « 26/11 » */
export function jourCourt(iso: string | null): string {
  return valide(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : A_CONFIRMER;
}
/** « Ven. 27 » */
export function jourAbrege(iso: string): string {
  const s = fr(iso, { weekday: "short", day: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** « 14 octobre 2026 » */
export function dateLettre(iso: string): string {
  return valide(iso) ? fr(iso, { day: "numeric", month: "long", year: "numeric" }) : iso;
}

/** « du 26 au 29 novembre 2026 », « du 30 novembre au 2 décembre 2026 », « le 26 novembre 2026 ». */
export function plageDates(debut: string | null, fin: string | null): string {
  const a = valide(debut) ? debut : null;
  const b = valide(fin) ? fin : null;
  if (!a && !b) return `dates ${A_CONFIRMER}`;
  if (!a || !b || a === b) return `le ${dateLettre((a ?? b)!)}`;
  const [ya, ma] = [a.slice(0, 4), a.slice(5, 7)];
  const [yb, mb] = [b.slice(0, 4), b.slice(5, 7)];
  if (ya === yb && ma === mb) return `du ${Number(a.slice(8, 10))} au ${dateLettre(b)}`;
  if (ya === yb) return `du ${fr(a, { day: "numeric", month: "long" })} au ${dateLettre(b)}`;
  return `du ${dateLettre(a)} au ${dateLettre(b)}`;
}

/** Nuits entre deux jours ; `null` si l'un manque ou s'ils sont à l'envers. */
export function nuits(a: string | null, b: string | null): number | null {
  if (!valide(a) || !valide(b)) return null;
  const n = Math.round((dateUtc(b).getTime() - dateUtc(a).getTime()) / 86_400_000);
  return n > 0 ? n : null;
}

const DEJA_TITRE = /^(pr|dr|prof|professeur|professeure|docteur|docteure)\.?\s/i;

/** Le nom imprimé : « Pr Nadia Exemple » — sans doubler un titre déjà écrit dans le nom. */
export function nomImprime(p: Pick<PersonneLivret, "nom" | "civilite">): string {
  const nom = p.nom.trim();
  if (!p.civilite || DEJA_TITRE.test(nom)) return nom;
  return `${p.civilite === "PR" ? "Pr" : "Dr"} ${nom}`;
}

/** La civilité d'un grade de l'annuaire : Professeur → Pr ; les grades médicaux et le pharmacien → Dr ; « autre » → rien. */
export function civiliteDuGrade(grade: string | null | undefined, fonction?: string | null): Civilite {
  if (grade === "PROFESSEUR") return "PR";
  if (grade && grade !== "AUTRE") return "DR";
  const f = (fonction ?? "").toLowerCase();
  if (/\b(pr|prof|professeur|professeure)\b/.test(f)) return "PR";
  if (/\b(dr|docteur|docteure|médecin|medecin|pharmacien)\b/.test(f)) return "DR";
  return null;
}

const plein = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
const ou = (v: string | null | undefined) => plein(v) ?? A_CONFIRMER;

export function lieuEvenement(e: EvenementLivret): string {
  const lieu = [plein(e.ville), plein(e.pays)].filter(Boolean).join(", ");
  return [lieu || `lieu ${A_CONFIRMER}`, plageDates(e.debut, e.fin)].join(" · ");
}

/** Nom de fichier sûr : « Livret — Pr Nadia Exemple — Congrès SFLS 2026.pdf ». */
export function nomDuLivret(qui: string, evenement: string): string {
  const net = (s: string) => s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
  return `Livret — ${net(qui)} — ${net(evenement)}.pdf`;
}

// ───────────────────────────── Les postes ─────────────────────────────

const SANS = "WAIVED";
const actif = (p: { status: string }) => p.status !== SANS;
const services = (p: PersonneLivret) => p.postes.filter((c) => c.kind === "SERVICE");
const deNature = (p: PersonneLivret, k: string) => services(p).filter((c) => c.serviceKind === k);

const MODE: Record<string, string> = { AVION: "Vol", TRAIN: "Train", BUS: "Car", TAXI: "Taxi" };

/** Les trajets d'un billet, dans l'ordre du voyage — la règle de `etapesDuBillet` (fiches voyageur). */
export function trajetsDuBillet(b: Pick<PosteLivret, "trajet" | "segments" | "fromCity" | "toCity" | "dateStart" | "dateEnd">): EtapeLivret[] {
  const t = b.trajet ?? "ALLER_RETOUR";
  if (t === "MULTI_DESTINATIONS") return b.segments;
  const aller = { de: b.fromCity, vers: b.toCity, date: b.dateStart };
  if (t === "ALLER_SIMPLE") return [aller];
  return [aller, { de: b.toCity, vers: b.fromCity, date: b.dateEnd }];
}

const libelleTrajet = (b: PosteLivret, i: number, n: number) =>
  (b.trajet ?? "ALLER_RETOUR") === "MULTI_DESTINATIONS" ? `Étape ${i + 1}` : n > 1 && i === n - 1 ? "Retour" : "Aller";

export interface VolLu {
  posteId: string;
  libelle: string;
  de: string | null;
  vers: string | null;
  date: string | null;
  mode: string;
  numero: string | null;
  heureDepart: string | null;
  heureArrivee: string | null;
  reference: string | null;
}

/** Tous les trajets émis (ou prévus) d'une personne — les billets « sans objet » n'en ont pas. */
export function volsDe(p: PersonneLivret): VolLu[] {
  return deNature(p, "TICKET").filter(actif).flatMap((b) => {
    const ts = trajetsDuBillet(b);
    return ts.map((t, i) => {
      const d = b.legDetails[i];
      return {
        posteId: b.id, libelle: libelleTrajet(b, i, ts.length), de: plein(t.de), vers: plein(t.vers), date: valide(t.date) ? t.date : null,
        mode: MODE[b.transport ?? ""] ?? "Vol",
        numero: plein(d?.numero), heureDepart: plein(d?.heureDepart), heureArrivee: plein(d?.heureArrivee),
        reference: plein(d?.reference) ?? plein(b.bookingRef),
      };
    });
  });
}

/** Les postes de groupe qui s'appliquent à cette personne (non exclue, non « sans objet »). */
export function groupeDe(p: PersonneLivret, groupe: readonly PosteGroupeLivret[]): PosteGroupeLivret[] {
  return groupe.filter((g) => actif(g) && !g.exclus.includes(p.id));
}

/** Un rendez-vous daté (repas, transfert, accès…) d'une fiche ou du groupe. */
interface RendezVous { date: string | null; heure: string | null; label: string; lieu: string | null }

const rdvPoste = (c: PosteLivret): RendezVous => ({ date: valide(c.dateStart) ? c.dateStart : null, heure: plein(c.timeStart), label: c.label, lieu: plein(c.address) });
const rdvGroupe = (g: PosteGroupeLivret): RendezVous => ({ date: valide(g.date) ? g.date : null, heure: plein(g.timeStart), label: g.label, lieu: plein(g.address) });
const parDate = (a: RendezVous, b: RendezVous) => `${a.date ?? "9999"}${a.heure ?? "99:99"}`.localeCompare(`${b.date ?? "9999"}${b.heure ?? "99:99"}`);

/** Les rendez-vous d'une nature, des postes de la fiche et du groupe, triés. */
function rendezVous(p: PersonneLivret, groupe: readonly PosteGroupeLivret[], kinds: readonly string[]): RendezVous[] {
  return [
    ...services(p).filter((c) => actif(c) && kinds.includes(c.serviceKind ?? "")).map(rdvPoste),
    ...groupeDe(p, groupe).filter((g) => kinds.includes(g.serviceKind)).map(rdvGroupe),
  ].sort(parDate);
}

const ligneRdv = (r: RendezVous): LigneInfo => ({
  cle: r.date ? `${jourAbrege(r.date)}${r.heure ? ` · ${r.heure}` : ""}` : `Date ${A_CONFIRMER}`,
  valeur: r.lieu ? `${r.label} — ${r.lieu}` : r.label,
});

// ───────────────────────────── Le planning ─────────────────────────────

export interface EvenementPlanning { date: string; heure: string | null; ordre: string; texte: string }

/**
 * LE PLANNING, jour par jour : chaque élément daté, trié par date puis heure. Sans heure, un élément se range
 * selon sa nature (l'ouverture de l'événement et la libération de la chambre le matin, l'arrivée à l'hôtel le
 * soir) — l'heure imprimée reste « — » : on ne l'invente pas.
 */
export function planning(items: readonly EvenementPlanning[]): { t: "jour"; numero: string; semaine: string; items: ItemJour[] }[] {
  const tri = [...items].sort((a, b) => `${a.date}${a.heure ?? a.ordre}`.localeCompare(`${b.date}${b.heure ?? b.ordre}`));
  const jours = new Map<string, ItemJour[]>();
  for (const e of tri) {
    const l = jours.get(e.date) ?? [];
    l.push({ heure: e.heure ?? "—", texte: e.texte });
    jours.set(e.date, l);
  }
  return [...jours].map(([d, l]) => ({ t: "jour" as const, numero: String(Number(d.slice(8, 10))), semaine: fr(d, { weekday: "short" }).replace(".", "") + ".", items: l }));
}

const O_MATIN = "00:00", O_MATIN2 = "00:01", O_SOIR = "99:98", O_NUIT = "99:99";

function evenementsDeLEvenement(e: EvenementLivret): EvenementPlanning[] {
  const out: EvenementPlanning[] = [];
  if (valide(e.debut)) out.push({ date: e.debut, heure: null, ordre: O_MATIN, texte: `Ouverture — ${e.nom}` });
  if (valide(e.fin) && e.fin !== e.debut) out.push({ date: e.fin, heure: null, ordre: O_MATIN2, texte: `Clôture — ${e.nom}` });
  return out;
}

const texteVol = (v: VolLu) => `${v.de ?? "?"} – ${v.vers ?? "?"}${v.numero ? `, ${v.mode.toLowerCase()} ${v.numero}` : ""}`;

function planningDe(p: PersonneLivret, entree: EntreeLivret): EvenementPlanning[] {
  const out: EvenementPlanning[] = [...evenementsDeLEvenement(entree.evenement)];
  for (const v of volsDe(p)) {
    if (!v.date) continue;
    out.push({ date: v.date, heure: v.heureDepart, ordre: O_SOIR, texte: `Départ ${texteVol(v)}` });
  }
  for (const h of deNature(p, "HOTEL").filter(actif)) {
    const nom = plein(h.hotelName) ?? "l'hôtel";
    if (valide(h.dateStart)) out.push({ date: h.dateStart, heure: null, ordre: O_NUIT, texte: `Arrivée à ${nom}` });
    if (valide(h.dateEnd)) out.push({ date: h.dateEnd, heure: null, ordre: O_MATIN2, texte: `Libération de la chambre — ${nom}` });
  }
  for (const r of rendezVous(p, entree.groupe, ["TRANSPORT", "CATERING", "REGISTRATION", "OTHER"])) {
    if (!r.date) continue;
    out.push({ date: r.date, heure: r.heure, ordre: O_SOIR, texte: r.lieu ? `${r.label} — ${r.lieu}` : r.label });
  }
  return out;
}

// ───────────────────────────── Contacts ─────────────────────────────

export const STANDARD = "+213 (0)20 339 430";

function contacts(entree: EntreeLivret): { titre: string; lignes: string[] }[] {
  const surPlace: ContactLivret[] = [...entree.equipe];
  if (entree.demandeur && !surPlace.some((m) => m.nom === entree.demandeur!.nom)) surPlace.unshift(entree.demandeur);
  const cartes = surPlace.slice(0, 3).map((c) => ({
    titre: entree.equipe.some((m) => m.nom === c.nom) ? "Sur place" : "Contact Adventum",
    lignes: [c.nom, plein(c.fonction) ?? "Adventum Pharma", ou(c.telephone)],
  }));
  cartes.push({
    titre: "À Alger",
    lignes: [entree.assistante?.nom ? entree.assistante.nom : "Assistante de direction", entree.assistante?.nom ? "Assistante de direction" : "Adventum Pharma", plein(entree.assistante?.telephone) ?? STANDARD],
  });
  return cartes;
}

// ───────────────────────────── Le livret individuel ─────────────────────────────

const SALUTATION: Record<"PR" | "DR" | "X", { salut: string; formule: string }> = {
  PR: { salut: "Professeur,", formule: "Professeur" },
  DR: { salut: "Docteur,", formule: "Docteur" },
  X: { salut: "Madame, Monsieur,", formule: "Madame, Monsieur" },
};

function phraseInvitation(e: EvenementLivret): string {
  const ville = plein(e.ville);
  const dates = valide(e.debut) || valide(e.fin) ? ` ${plageDates(e.debut, e.fin)}` : "";
  const ou_ = ville ? ` à ${ville}` : "";
  return ou_ || dates ? `Nous avons l'honneur de vous inviter au ${e.nom}, qui se tiendra${ou_}${dates}.` : `Nous avons l'honneur de vous inviter au ${e.nom}.`;
}

function sectionVoyage(p: PersonneLivret, entree: EntreeLivret): Section {
  const blocs: Bloc[] = [];
  const billets = deNature(p, "TICKET");
  const sansBillet = billets.length > 0 && billets.every((b) => !actif(b));
  if (billets.length === 0) blocs.push({ t: "lignes", lignes: [{ cle: "Billet", valeur: A_CONFIRMER }] });
  else if (sansBillet) blocs.push({ t: "lignes", lignes: [{ cle: "Billet", valeur: "Sans billet — vous voyagez par vos propres moyens." }] });
  for (const v of volsDe(p)) {
    blocs.push({
      t: "vol",
      etiquette: `${v.libelle} · ${jourLong(v.date)}`,
      de: v.de ?? A_CONFIRMER, vers: v.vers ?? A_CONFIRMER,
      sousDe: `départ ${v.heureDepart ?? A_CONFIRMER}`, sousVers: `arrivée ${v.heureArrivee ?? A_CONFIRMER}`,
      lignes: [
        { cle: v.mode, valeur: v.numero ?? A_CONFIRMER },
        { cle: "Référence", valeur: v.reference ?? A_CONFIRMER, fort: Boolean(v.reference) },
      ],
    });
  }
  const transferts = rendezVous(p, entree.groupe, ["TRANSPORT"]);
  if (transferts.length) {
    blocs.push({ t: "h3", texte: "Transferts" }, { t: "lignes", lignes: transferts.map(ligneRdv) });
  }
  const avion = volsDe(p).every((v) => v.mode === "Vol");
  return { titre: "Votre voyage", sousTitre: avion ? "Vols et transferts" : "Trajets et transferts", blocs };
}

function sectionHebergement(p: PersonneLivret, entree: EntreeLivret): Section {
  const blocs: Bloc[] = [];
  const hotels = deNature(p, "HOTEL");
  const actifs = hotels.filter(actif);
  if (hotels.length === 0) blocs.push({ t: "lignes", lignes: [{ cle: "Hôtel", valeur: A_CONFIRMER }] });
  else if (actifs.length === 0) blocs.push({ t: "lignes", lignes: [{ cle: "Hôtel", valeur: "Sans hôtel." }] });
  actifs.forEach((h, i) => {
    const n = nuits(h.dateStart, h.dateEnd);
    blocs.push({
      t: "lignes",
      etiquette: actifs.length > 1 ? (plein(h.hotelName) ?? `Hôtel ${i + 1}`) : undefined,
      lignes: [
        ...(actifs.length > 1 || !plein(h.hotelName) ? [{ cle: "Hôtel", valeur: ou(h.hotelName) }] : []),
        { cle: "Ville", valeur: ou(h.city ?? entree.evenement.ville) },
        { cle: "Arrivée", valeur: valide(h.dateStart) ? jourLong(h.dateStart) : A_CONFIRMER },
        { cle: "Départ", valeur: valide(h.dateEnd) ? jourLong(h.dateEnd) : A_CONFIRMER },
        { cle: "Séjour", valeur: [n == null ? `nuits ${A_CONFIRMER}` : `${n} nuit${n > 1 ? "s" : ""}`, plein(h.roomType) ? `chambre ${h.roomType!.trim().toLowerCase()}` : null].filter(Boolean).join(" · ") },
        { cle: "Confirmation", valeur: ou(h.bookingRef), fort: Boolean(plein(h.bookingRef)) },
      ],
    });
  });
  const repas = rendezVous(p, entree.groupe, ["CATERING"]);
  if (repas.length) blocs.push({ t: "h3", texte: "Repas" }, { t: "lignes", lignes: repas.map(ligneRdv) });
  const acces = rendezVous(p, entree.groupe, ["REGISTRATION"]);
  if (acces.length) blocs.push({ t: "h3", texte: "Accès à l'événement" }, { t: "lignes", lignes: acces.map(ligneRdv) });
  const autres = rendezVous(p, entree.groupe, ["OTHER"]);
  if (autres.length) blocs.push({ t: "h3", texte: "Autres rendez-vous" }, { t: "lignes", lignes: autres.map(ligneRdv) });
  const principal = actifs[0];
  return { titre: "Votre hébergement", sousTitre: principal ? (plein(principal.hotelName) ?? `Hôtel ${A_CONFIRMER}`) : null, blocs };
}

function sectionProgramme(items: EvenementPlanning[], sous: string): Section {
  const jours = planning(items);
  return {
    titre: sous === "individuel" ? "Votre programme" : "Programme commun",
    sousTitre: sous === "individuel" ? "Le séjour, jour par jour" : "Les rendez-vous du groupe",
    blocs: jours.length ? jours : [{ t: "texte", texte: `Le programme sera complété dès que les dates seront confirmées.` }],
  };
}

function aEmporter(p: PersonneLivret, e: EvenementLivret): string[] {
  const l: string[] = [];
  if (e.international) l.push("Votre passeport en cours de validité, et votre visa s'il est requis");
  else l.push("Votre pièce d'identité");
  if (deNature(p, "TICKET").some((b) => actif(b) && b.emis)) l.push("Votre billet électronique");
  if (deNature(p, "HOTEL").some((h) => actif(h) && h.emis)) l.push("La confirmation de votre hôtel");
  if (deNature(p, "REGISTRATION").some(actif)) l.push("Votre confirmation d'inscription à l'événement");
  l.push("Ce livret, imprimé ou sur votre téléphone");
  return l;
}

export function livretIndividuel(p: PersonneLivret, entree: EntreeLivret): Livret {
  const e = entree.evenement;
  const nom = nomImprime(p);
  const s = SALUTATION[p.civilite ?? "X"];
  const couvre = [
    deNature(p, "TICKET").some(actif) ? "votre voyage" : null,
    deNature(p, "HOTEL").some(actif) ? "votre hébergement" : null,
    deNature(p, "REGISTRATION").some(actif) ? "votre participation" : null,
  ].filter((x): x is string => Boolean(x));
  const prise = couvre.length
    ? `Adventum Pharma prend en charge ${couvre.length > 1 ? `${couvre.slice(0, -1).join(", ")} et ${couvre[couvre.length - 1]}` : couvre[0]}. `
    : "";
  return {
    type: "INDIVIDUEL",
    nomFichier: nomDuLivret(nom, e.nom),
    pied: `${e.nom} · ${nom}`,
    couverture: { surtitre: "Livret de séjour", titre: e.nom, lieu: lieuEvenement(e), pourEtiquette: "Préparé pour", pourNom: nom },
    lettre: {
      date: `Alger, le ${dateLettre(entree.edition)}`,
      destinataire: [nom, plein(p.service) ?? plein(p.fonction), plein(p.etablissement)].filter((x): x is string => Boolean(x)),
      objet: `Objet : invitation au ${e.nom}`,
      salutation: s.salut,
      paragraphes: [
        phraseInvitation(e),
        `${prise}Ce livret réunit le détail de votre séjour : ${couvre.includes("votre voyage") ? "vos trajets, " : ""}${couvre.includes("votre hébergement") ? "votre hôtel, " : ""}le programme jour par jour et les personnes à contacter sur place.`,
      ],
      formule: `Nous vous prions d'agréer, ${s.formule}, l'expression de notre haute considération.`,
    },
    sections: [
      sectionVoyage(p, entree),
      sectionHebergement(p, entree),
      sectionProgramme(planningDe(p, entree), "individuel"),
      {
        titre: "Informations pratiques",
        sousTitre: "Vos contacts pendant le séjour",
        blocs: [{ t: "contacts", cartes: contacts(entree) }, { t: "h3", texte: "À emporter" }, { t: "puces", items: aEmporter(p, e) }],
      },
    ],
    dos: false,
  };
}

// ───────────────────────────── Le livret général ─────────────────────────────

/** Les personnes du livret de la délégation : celles qui sont proposées ou accordées (ni écartées, ni retirées). */
export function delegation(personnes: readonly PersonneLivret[]): PersonneLivret[] {
  return personnes.filter((p) => p.statut === "PROPOSED" || p.statut === "APPROVED");
}

const celluleVol = (v: VolLu | undefined): CelluleTable => (v
  ? { fort: `${jourCourt(v.date)} · ${v.numero ?? A_CONFIRMER}`, texte: `${v.de ?? "?"} ${v.heureDepart ?? "—"} – ${v.vers ?? "?"} ${v.heureArrivee ?? "—"}` }
  : { texte: A_CONFIRMER });

const sousTitrePersonne = (p: PersonneLivret) => [plein(p.service) ?? plein(p.fonction), plein(p.etablissement)].filter(Boolean).join(" · ");

export function livretGeneral(entree: EntreeLivret): Livret {
  const e = entree.evenement;
  const gens = delegation(entree.personnes);
  const n = gens.length;

  // Participants et vols.
  const lignesVols: CelluleTable[][] = gens.map((p) => {
    const qui: CelluleTable = { fort: nomImprime(p), texte: sousTitrePersonne(p) };
    const billets = deNature(p, "TICKET");
    if (billets.length > 0 && billets.every((b) => !actif(b))) return [qui, { texte: "Par ses propres moyens" }, { texte: "" }];
    const vols = volsDe(p);
    return [qui, celluleVol(vols[0]), celluleVol(vols.length > 1 ? vols[vols.length - 1] : undefined)];
  });

  // Hébergement.
  const hotelsActifs = gens.flatMap((p) => deNature(p, "HOTEL").filter(actif));
  const noms = new Set(hotelsActifs.map((h) => plein(h.hotelName) ?? ""));
  const unSeul = noms.size === 1 && !noms.has("");
  const lignesHotel: CelluleTable[][] = gens.map((p) => {
    const hs = deNature(p, "HOTEL");
    const h = hs.filter(actif)[0];
    const qui: CelluleTable = { fort: nomImprime(p), texte: "" };
    if (!h) {
      const quoi = { texte: hs.length ? "Sans hôtel" : A_CONFIRMER };
      return unSeul ? [qui, quoi, { texte: "" }, { texte: "" }] : [qui, quoi, { texte: "" }, { texte: "" }, { texte: "" }];
    }
    return [qui, ...(unSeul ? [] : [{ texte: ou(h.hotelName) }]), { texte: jourCourt(h.dateStart) }, { texte: jourCourt(h.dateEnd) }, { texte: ou(h.roomType) }];
  });
  const repasGroupe = entree.groupe.filter((g) => actif(g) && g.serviceKind === "CATERING").map(rdvGroupe).sort(parDate);

  // Programme commun : l'événement, les postes de groupe, les trajets partagés.
  const items: EvenementPlanning[] = [...evenementsDeLEvenement(e)];
  for (const g of entree.groupe.filter(actif)) {
    const r = rdvGroupe(g);
    if (r.date) items.push({ date: r.date, heure: r.heure, ordre: O_SOIR, texte: r.lieu ? `${r.label} — ${r.lieu}` : r.label });
  }
  const partages = new Map<string, { v: VolLu; n: number }>();
  for (const p of gens) {
    for (const v of volsDe(p)) {
      if (!v.date) continue;
      const k = `${v.date}|${v.numero ?? `${v.de}>${v.vers}`}`;
      const x = partages.get(k);
      if (x) x.n += 1; else partages.set(k, { v, n: 1 });
    }
  }
  for (const { v, n: combien } of partages.values()) {
    if (n > 1 && combien < 2) continue;
    items.push({ date: v.date!, heure: v.heureDepart, ordre: O_SOIR, texte: `Départ ${texteVol(v)}${combien > 1 ? ` (${combien} participants)` : ""}` });
  }

  const sections: Section[] = [
    {
      titre: "La délégation",
      sousTitre: "Participants et vols",
      blocs: n
        ? [{ t: "table", colonnes: [{ titre: "Participant", part: 0.4 }, { titre: "Aller", part: 0.3 }, { titre: "Retour", part: 0.3 }], lignes: lignesVols }]
        : [{ t: "texte", texte: `Les participants sont ${A_CONFIRMER}.` }],
    },
    {
      titre: "Hébergement",
      sousTitre: unSeul ? [...noms][0]! : "Les hôtels de la délégation",
      blocs: [
        ...(unSeul ? [{ t: "lignes" as const, lignes: [{ cle: "Ville", valeur: ou(hotelsActifs[0]?.city ?? e.ville) }] }] : []),
        ...(n
          ? [{
            t: "table" as const,
            colonnes: unSeul
              ? [{ titre: "Participant", part: 0.4 }, { titre: "Arrivée", part: 0.18 }, { titre: "Départ", part: 0.18 }, { titre: "Chambre", part: 0.24 }]
              : [{ titre: "Participant", part: 0.3 }, { titre: "Hôtel", part: 0.28 }, { titre: "Arrivée", part: 0.14 }, { titre: "Départ", part: 0.14 }, { titre: "Chambre", part: 0.14 }],
            lignes: lignesHotel,
          }]
          : []),
        ...(repasGroupe.length ? [{ t: "h3" as const, texte: "Repas du groupe" }, { t: "lignes" as const, lignes: repasGroupe.map(ligneRdv) }] : []),
      ],
    },
    sectionProgramme(items, "general"),
  ];
  if (entree.equipe.length) {
    sections.push({
      titre: "L'équipe Adventum",
      sousTitre: "Accompagnement sur place",
      blocs: [{
        t: "table",
        colonnes: [{ titre: "Membre", part: 0.3 }, { titre: "Sur place", part: 0.17 }, { titre: "Billet", part: 0.31 }, { titre: "Hôtel", part: 0.22 }],
        lignes: entree.equipe.map((m) => [
          { fort: m.nom, texte: [plein(m.fonction), plein(m.telephone)].filter(Boolean).join("\n") },
          { texte: valide(m.du) || valide(m.au) ? `${jourCourt(m.du)}–${jourCourt(m.au)}` : A_CONFIRMER },
          {
            fort: plein(m.billetReference) ? `Réf. ${m.billetReference!.trim()}` : null,
            texte: m.trajets
              .map((d, i) => {
                const heures = plein(d.heureDepart) && plein(d.heureArrivee) ? `${d.heureDepart}–${d.heureArrivee}` : plein(d.heureDepart);
                if (!plein(d.numero) && !heures) return null;
                return [`${i === 0 ? "Aller" : "Retour"} ${plein(d.numero) ?? ""}`.trim(), heures].filter(Boolean).join("\n");
              })
              .filter(Boolean).join("\n") || A_CONFIRMER,
          },
          { texte: plein(m.hotelNom) ? `${m.hotelNom!.trim()}${plein(m.hotelConfirmation) ? `\nConf. ${m.hotelConfirmation!.trim()}` : ""}` : A_CONFIRMER },
        ]),
      }, { t: "h3", texte: "Contacts" }, { t: "contacts", cartes: contacts(entree) }],
    });
  } else {
    sections.push({ titre: "Contacts", sousTitre: "Pendant le séjour", blocs: [{ t: "contacts", cartes: contacts(entree) }] });
  }

  return {
    type: "GENERAL",
    nomFichier: nomDuLivret("Délégation", e.nom),
    pied: `${e.nom} · Délégation Adventum`,
    couverture: {
      surtitre: "Livret de la délégation", titre: e.nom, lieu: lieuEvenement(e),
      pourEtiquette: "Délégation Adventum Pharma", pourNom: n ? `${n} professionnel${n > 1 ? "s" : ""} de santé` : `Participants ${A_CONFIRMER}`,
    },
    lettre: {
      date: `Alger, le ${dateLettre(entree.edition)}`,
      destinataire: null,
      objet: `Objet : invitation au ${e.nom}`,
      salutation: "Mesdames et Messieurs les Professeurs et Docteurs,",
      paragraphes: [
        phraseInvitation(e),
        "Ce livret réunit le programme commun de la délégation, les vols, l'hébergement et les rendez-vous partagés. Chacun d'entre vous reçoit aussi son livret personnel.",
      ],
      formule: "Nous vous prions d'agréer, Mesdames et Messieurs, l'expression de notre haute considération.",
    },
    sections,
    dos: true,
  };
}
