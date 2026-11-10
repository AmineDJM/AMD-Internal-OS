import { Prisma } from "@prisma/client";
import { sansBloquer } from "@/lib/journal";
import { scanForInjection } from "@/lib/comms/untrusted";
import { prisma } from "@/lib/prisma";
import { enSerie } from "@/lib/refs";
import { identiteEmetteurDuTexte, fusionnerIdentite, type IdentiteEmetteur } from "@/lib/pieces-lues/emetteur";
import { listPartyOptions } from "@/lib/queries/company-contacts";
import { BUDGET_CARACTERES, decouperPourLecture } from "@/lib/pch/extraction";
import { CARACTERES_MIN, disponibiliteLecturePieces, phraseCoupeDuTexte, structurerParModele } from "@/lib/lecture-pieces-ia";
import { lireFichierUneFois, type LectureDePiece } from "@/lib/pieces-lues/lecture-fichier";
import { FORMATS_LUS, PAGES_MAX, TAILLE_MAX_OCTETS } from "@/lib/pieces-lues/formats";
import { moteurLuna } from "@/lib/pieces-lues/moteur-luna";
import { moteurParDefaut } from "@/lib/regulatory/intelligence/extract/texte-ou-ocr";
import { repererEntetes, type EntetesReperes } from "@/lib/pieces-lues/entetes";
import { controlerPiece, type ResultatControle } from "@/lib/pieces-lues/controle";
import {
  candidatsFournisseur, identiteLue, type ContactAnnuaire, type IdentifiantsDuGroupe, type ResultatFournisseur,
} from "@/lib/pieces-lues/fournisseur";
import { apparierLignes, type LigneAttendue, type ResultatAppariement } from "@/lib/pieces-lues/appariement";
import {
  noteDeMethode, phraseSansLignes, refusFormatDePiece, refusTailleDePiece, type FaitsDeLecture, type RaisonSansLignes,
} from "@/lib/pieces-lues/phrases";
import type { PieceLue } from "@/lib/pieces-lues/structure";
import { pdfEstUnScan, rangeesDuPdf } from "@/lib/pieces-lues/positions";
import { imagePourVision, pagesPourVision } from "@/lib/pieces-lues/images-vision";
import { lireTableau, reconcilier, type LigneTableau, type Reconciliation } from "@/lib/pieces-lues/tableau";
import { pieceDepuisTableau } from "@/lib/pieces-lues/tableau-piece";
import { lireTableauParVision, type DependancesVision } from "@/lib/pieces-lues/vision-lignes";
import { callLuna, lunaConfigured, lunaModel } from "@/lib/openai-luna";
import { verdictDeLecture, type VerdictLecture } from "@/lib/pieces-lues/verdict";
import { emetteurEtDestinataire, estDuGroupe, ficheDuGroupe, type DestinataireLu, type EmetteurLu } from "@/lib/pieces-lues/emetteur-destinataire";
import {
  phraseAuditConfirmation, refusDeConfirmation, verdictsDeConfirmation,
  type CibleLecture, type LigneProposee, type LigneSoumise, type VerdictDeLigne,
} from "@/lib/pieces-lues/confirmation";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE SERVICE DE LECTURE DES PIÈCES COMMERCIALES — proposer, puis faire confirmer (lot D2-D).
 *
 * Un devis, un bon de commande ou une facture arrive en fichier. Ce service le LIT — une fois par
 * empreinte (`lecture-fichier.ts`) —, en REPÈRE l'en-tête et les totaux imprimés par des règles
 * (`entetes.ts`), en fait proposer les LIGNES par un modèle quand la Direction l'a permis
 * (`lecture-pieces-ia.ts`), recalcule tout en centimes contre le papier (`controle.ts`), cherche
 * l'émetteur dans l'annuaire (`fournisseur.ts`) et, s'il y a des lignes attendues (une facture
 * contre son BC), les apparie (`appariement.ts`). Il rend une PROPOSITION. Il n'écrit dans AUCUNE
 * table métier : la seule écriture est le cache de la lecture (`LecturePiece`).
 *
 * ── CE QUI NE SORT PAS DE L'ERP (décisions 3 et 5) ──────────────────────────────────────────
 *
 *   • Un scan se lit par LUNA (§118.200) quand la pièce peut sortir et que la lecture par l'IA est
 *     ouverte ; sinon par le moteur local (`cloud: false`) — jamais par un OCR externe (Mistral).
 *   • Une pièce CONFIDENTIELLE (`sortieCloudPermise` faux : lecteurs désignés, fichier non INTERNAL)
 *     n'est JAMAIS montrée à un modèle — le service ne l'en approche même pas : il lit les portes
 *     (`disponibiliteLecturePieces`) pour dire la vraie raison, puis s'arrête. Et il ne lui montre
 *     pas non plus les lignes qu'un modèle aurait proposées pour les mêmes octets dans un autre
 *     contexte : « lecture locale seulement » se dit, et se tient.
 *
 * ── UNE FOIS PAR FICHIER (P6) ───────────────────────────────────────────────────────────────
 *
 * Le texte se lit une fois par empreinte (la réservation de `lecture-fichier.ts`). Les LIGNES aussi :
 * l'étage modèle COMPLÈTE la lecture gardée — sur le texte gardé, sans refaire l'OCR — et sa
 * structure se garde sur la même ligne, par une écriture CONDITIONNELLE (`structure IS NULL`) : la
 * première fait foi. Deux propositions simultanées des mêmes octets passent l'une après l'autre
 * dans la file de la lecture (`enSerie`), la seconde trouve la structure gardée et ne rappelle pas
 * le modèle. Entre deux processus, la file ne vaut pas — l'écriture conditionnelle garde alors la
 * première structure, au prix d'un second appel : nommé, pas tu.
 *
 * Une lecture des lignes qui a ÉTÉ faite est un acquis : coupée depuis, la fonction ne la retire pas
 * — la servir ne coûte rien et n'envoie rien. Une lecture qui n'a pas pu se faire (bascule coupée,
 * IA coupée, clé absente) n'est pas un acquis : la raison se recalcule à chaque proposition, et
 * l'activation de la fonction complète la lecture sans refaire l'OCR. C'est pourquoi la raison
 * n'est pas gardée sur la ligne : elle dépend du MOMENT et du CONTEXTE (la même pièce peut être
 * confidentielle ici et pas là), pas de la pièce.
 *
 * ── LA CONFIRMATION (P7) ────────────────────────────────────────────────────────────────────
 *
 * `exigerLectureConfirmee` est la garde que chaque écriture métier appelle AVANT d'écrire : le
 * fichier joint est celui qui a été lu (son empreinte), chaque ligne GARDÉE et venue de la lecture
 * est cochée « vérifiée », le total aussi. `consignerConfirmation` écrit l'attestation DANS la
 * transaction de l'écriture métier : sans elle, un devis existerait sans dire qu'il vient d'une
 * lecture de machine confirmée, ou une attestation désignerait un devis qui n'a jamais été écrit.
 *
 * Serveur seulement, hors carte ; JAMAIS un point d'entrée (pas de « use server ») : l'identité
 * arrive de l'action qui l'a vérifiée, et la porte de la CIBLE reste dans chaque action.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// Formats, taille et pages lus : un module PUR (`formats.ts`), que le sélecteur de fichier d'un écran lit aussi.
export { FORMATS_LUS, TAILLE_MAX_OCTETS, PAGES_MAX } from "@/lib/pieces-lues/formats";
/** Un nom de fichier se montre ; borné, il ne devient pas un second document. */
const NOM_MAX = 200;

export interface ContexteLecture {
  cible: CibleLecture;
  /** Faux : pièce confidentielle — rien ne sort de l'ERP, ni texte ni nom, vers aucun modèle. */
  sortieCloudPermise: boolean;
  /** L'annuaire que la PERSONNE voit (portée déjà appliquée par l'appelant). */
  annuaireVisible: readonly ContactAnnuaire[];
  /** Les identifiants des sociétés du groupe : le client de la pièce, jamais son émetteur. */
  groupe?: IdentifiantsDuGroupe;
  /** Les lignes que la pièce devrait porter (une facture contre son BC) — apparié si fourni. */
  lignesAttendues?: readonly LigneAttendue[];
}

/** Les faits d'une lecture de fichier, tels que la note de méthode les dit. */
export type FaitsDeLaLecture = FaitsDeLecture & { methode: "texte" | "ocr"; confiance: number | null };

export interface PropositionDeLecture {
  lectureId: string;
  empreinte: string;
  nomFichier: string;
  cible: CibleLecture;
  faits: FaitsDeLaLecture;
  /** D'où vient le texte, ce qui n'a pas été lu — notre code, jamais le document (§104.15). */
  noteMethode: string;
  /** Les lignes viennent d'un modèle (à confirmer une à une). */
  lignesParModele: boolean;
  /** Pourquoi il n'y a pas de lignes — `null` quand il y en a, ou quand l'IA a été appelée sans rien rendre d'exploitable. */
  raisonSansLignes: RaisonSansLignes | null;
  /** La phrase de l'absence de lignes, quelle qu'en soit la cause — `null` quand il y en a. */
  sansLignes: string | null;
  /** La coupe du texte montré à l'IA, dite à la personne — `null` sans coupe. */
  coupe: string | null;
  entetes: EntetesReperes;
  piece: PieceLue | null;
  controle: ResultatControle | null;
  fournisseur: ResultatFournisseur;
  appariement: ResultatAppariement | null;
  /** Les désignations qui portent un motif d'injection : signalées, jamais suivies (§104.10). */
  suspectes: { rang: number; designation: string; motifs: string[] }[];
  /** L'IDENTITÉ DE L'ÉMETTEUR recopiée du papier (étiquettes imprimées), complétée par le modèle — jamais devinée. */
  emetteur: IdentiteEmetteur;
  /**
   * D'OÙ VIENNENT LES LIGNES (lot B1) : le tableau lu par ses POSITIONS (PDF à couche texte, sans modèle),
   * le MODÈLE sur le texte, ou la VISION sur l'image des pages (seconde passe). `null` sans lignes.
   */
  methodeLignes: MethodeLignes | null;
  /** La somme des lignes contre le HT imprimé, et les lignes douteuses NOMMÉES — `null` sans lignes. */
  reconciliation: Reconciliation | null;
  /** La société du GROUPE à qui le devis est adressé (le client) — `null` si le papier n'en nomme aucune, ou plusieurs. */
  destinataire: DestinataireLu | null;
  /** NIS, AI et la source du nom de l'émetteur (« pied de page », « en-tête »…). */
  emetteurLu: EmetteurLu;
  /** Le VERDICT par invariants (FIABLE / À VÉRIFIER / ILLISIBLE), gardé avec la lecture (`LecturePiece.verdict`). */
  verdict: VerdictLecture;
}

export type MethodeLignes = "positions" | "modele" | "vision";
// La réconciliation, réexportée : un appelant de la lecture lit l'écart par la porte du service.
export { phraseReconciliation, type Reconciliation } from "@/lib/pieces-lues/tableau";

export type ResultatProposition = { ok: true; proposition: PropositionDeLecture } | { ok: false; error: string };

const PHRASE_VIDE = "Fichier vide : il n'y a rien à lire — joignez le scan de la pièce.";
const PHRASE_LECTURE_INCONNUE = "La lecture désignée n'existe pas (ou plus) : relisez le scan avant d'enregistrer.";
const PHRASE_AUTRE_FICHIER =
  "Le fichier joint n'est pas celui qui a été lu : relisez-le (« Lire le scan ») avant d'enregistrer — une confirmation porte sur la pièce lue, pas sur une autre.";
const PHRASE_PAS_TERMINEE = "La lecture de ce fichier n'est pas terminée : relisez le scan dans un instant.";
/** La lecture a disparu entre la garde et l'écriture (purge) : l'attestation n'aurait plus d'objet. */
export const PHRASE_LECTURE_DISPARUE = "La lecture de ce scan n'existe plus (purgée entre-temps) : relisez le scan avant d'enregistrer.";

/**
 * LE REFUS D'UNE CONFIRMATION QUI N'A PLUS D'OBJET — levé DANS la transaction de l'écriture métier
 * pour l'annuler entière, rattrapé par l'action pour devenir une phrase.
 */
export class RefusLecture extends Error {}

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function extensionDe(nom: string): string {
  const i = nom.lastIndexOf(".");
  return i >= 0 ? nom.slice(i + 1).trim().toLowerCase() : "";
}

function faitsDe(l: LectureDePiece): FaitsDeLaLecture {
  return {
    methode: l.methode, confiance: l.confiance, aRelire: l.aRelire, ocrTente: l.ocrTente, ocrEchoue: l.ocrEchoue,
    raisonOcr: l.raisonOcr, pagesLues: l.pagesLues, pagesTotal: l.pagesTotal, tronque: l.tronque, moteur: l.moteur,
    caracteres: l.caracteres,
  };
}

/** Une structure GARDÉE se relit — c'est la nôtre, écrite par `garderStructure` ; une forme inattendue ne se croit pas. */
function pieceGardee(v: unknown): PieceLue | null {
  if (!estObjet(v) || !Array.isArray(v.lignes) || !Array.isArray(v.taxes) || !Array.isArray(v.illisibles)) return null;
  if (!estObjet(v.fournisseur) || !estObjet(v.totaux)) return null;
  return v as unknown as PieceLue;
}

function entetesGardees(v: unknown): EntetesReperes | null {
  if (!estObjet(v) || !Array.isArray(v.tva) || !Array.isArray(v.taxes) || !Array.isArray(v.conflits) || !Array.isArray(v.nif)) return null;
  return v as unknown as EntetesReperes;
}

async function structureGardee(id: string): Promise<PieceLue | null> {
  return (await structureGardeeEtSource(id)).piece;
}

async function structureGardeeEtSource(id: string): Promise<{ piece: PieceLue | null; par: string | null }> {
  const ligne = await prisma.lecturePiece.findUnique({ where: { id }, select: { structure: true, structureePar: true } });
  return { piece: pieceGardee(ligne?.structure ?? null), par: ligne?.structureePar ?? null };
}

/**
 * UNE LECTURE QUI RÉCONCILIE REMPLACE CELLE QUI NE RÉCONCILIE PAS (lot B1). « La première fait foi » tient
 * entre deux lectures d'égale valeur ; une lecture dont la somme fait le HT imprimé, ligne à ligne
 * recoupée, l'emporte sur une recopie qui ne le fait pas — sinon la mauvaise lecture d'hier resterait servie.
 */
async function remplacerStructure(id: string, piece: PieceLue, par: string): Promise<void> {
  await prisma.lecturePiece.updateMany({
    where: { id, etat: "LUE" },
    data: { structure: piece as unknown as Prisma.InputJsonValue, structureePar: par },
  }).catch((e) => console.error("[pièces lues] structure non remplacée (non bloquant)", id, e));
}

/** Les en-têtes repérés, gardés une fois — la confirmation les relit pour consigner le contrôle de la lecture. */
async function garderEntetes(id: string, entetes: EntetesReperes): Promise<void> {
  await prisma.lecturePiece.updateMany({
    where: { id, etat: "LUE", entetes: { equals: Prisma.DbNull } },
    data: { entetes: entetes as unknown as Prisma.InputJsonValue },
  }).catch((e) => console.error("[pièces lues] en-têtes non gardés (non bloquant)", id, e));
}

/**
 * La structure lue par le modèle, gardée SOUS CONDITION : la première fait foi, une seconde ne l'écrase pas.
 * Dans CE processus, la file (`enSerie`, plus bas) suffit déjà : la seconde lecture trouve la structure
 * gardée et n'appelle pas le modèle. La condition tient ENTRE deux processus, qu'aucun banc ne joue :
 * aucun cas ne l'exerce (son sabotage est déclaré « doit passer », §118.140) — elle reste parce qu'elle dit la règle.
 */
async function garderStructure(id: string, piece: PieceLue, modele: string | null): Promise<PieceLue> {
  const r = await prisma.lecturePiece.updateMany({
    where: { id, etat: "LUE", structure: { equals: Prisma.DbNull } },
    data: { structure: piece as unknown as Prisma.InputJsonValue, structureePar: modele ?? "modèle non nommé" },
  });
  if (r.count === 1) return piece;
  return (await structureGardee(id)) ?? piece;
}

interface LignesDeLecture {
  piece: PieceLue | null;
  raison: RaisonSansLignes | null;
  sansLignes: string | null;
  methode?: MethodeLignes | null;
}

const sans = (raison: RaisonSansLignes, cause: string | null = null): LignesDeLecture =>
  ({ piece: null, raison, sansLignes: phraseSansLignes(raison, cause) });

/**
 * LES LIGNES : gardées, proposées par un modèle, ou absentes — et pourquoi. Dans cet ordre : un OCR
 * tombé et un texte vide disent la vérité sur la PIÈCE avant qu'on parle du modèle ; une pièce
 * confidentielle ne s'approche pas du modèle ; sinon, la structure gardée, ou un appel — un seul
 * par lecture, la file le garantit dans ce processus.
 */
async function lignesDeLaLecture(
  l: LectureDePiece,
  e: {
    noteMethode: string; nomFichier: string; confidentielle: boolean; userId: string;
    /** La lecture par les POSITIONS quand elle réconcilie — locale, sans modèle : elle passe avant tout. */
    parPositions: PieceLue | null;
  },
): Promise<LignesDeLecture> {
  if (e.parPositions) {
    const gardee = await structureGardeeEtSource(l.id);
    if (gardee.par !== SOURCE_POSITIONS || JSON.stringify(gardee.piece) !== JSON.stringify(e.parPositions)) {
      if (l.etat === "LUE") await remplacerStructure(l.id, e.parPositions, SOURCE_POSITIONS);
    }
    return { piece: e.parPositions, raison: null, sansLignes: null, methode: "positions" };
  }
  if (l.ocrEchoue) return sans("OCR_ECHOUE", l.raisonOcr);
  if (l.texte.replace(/\s+/g, "").length < CARACTERES_MIN) return sans("TEXTE_ILLISIBLE");
  if (e.confidentielle) {
    // RIEN NE SORT. La disponibilité dit la vraie raison quand une porte est fermée (IA coupée, bascule,
    // clé) ; ouvertes, c'est la confidentialité qui arrête — et le modèle n'a pas été approché.
    const dispo = await disponibiliteLecturePieces();
    if (!dispo.disponible) return { piece: null, raison: dispo.raison, sansLignes: dispo.phrase };
    return sans("CONFIDENTIELLE");
  }
  return enSerie(`lecture-piece-modele:${l.id}`, async () => {
    const gardee = await structureGardeeEtSource(l.id);
    if (gardee.piece) return { piece: gardee.piece, raison: null, sansLignes: null, methode: methodeDeSource(gardee.par) };
    const r = await structurerParModele({
      texte: l.texte, noteMethode: e.noteMethode, nomFichier: e.nomFichier, confidentielle: false, userId: e.userId,
    });
    if (!r.ok) return { piece: null, raison: r.raison, sansLignes: r.error };
    return { piece: await garderStructure(l.id, r.piece, r.modele), raison: null, sansLignes: null, methode: "modele" };
  });
}

/** La passe de vision, branchée sur Luna (mêmes portes que la lecture par le modèle : interrupteur, bascule, clé). */
const VISION: DependancesVision = {
  disponible: async () => lunaConfigured() && (await disponibiliteLecturePieces()).disponible,
  appeler: (input) => callLuna(input),
  // Rendues finement et recadrées sur la pièce (un ticket sur une page A4 n'en occupe qu'un quart).
  pages: (pdf, max) => pagesPourVision(pdf, max),
  preparer: (image, mime) => imagePourVision(image, mime),
  modele: () => lunaModel(),
};

/** Les motifs d'injection d'une désignation lue (§104.10) : signalés, jamais suivis. */
const SUSPECTE = (d: string): string[] => scanForInjection(d).flags;

const SOURCE_POSITIONS = "lecture du tableau (positions du PDF)";
/** Un scan dont l'image n'a pas été lue : on le dit, plutôt que de lire la couche texte du scanner. */
const PHRASE_SCAN_NON_LU = "Pièce scannée : la lecture de son image n'a pas abouti, et le texte que le scanner y a joint n'est pas fiable (décimales perdues) — saisissez les lignes depuis le papier, ou réessayez dans un instant.";
/** Les formats qui SONT une image : une photo ou un scan déposé tel quel se lit d'abord par la vision. */
const IMAGES_LUES: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "webp", "tif", "tiff"]);
const PREFIXE_VISION = "vision:";
const methodeDeSource = (par: string | null): MethodeLignes =>
  par === SOURCE_POSITIONS ? "positions" : par?.startsWith(PREFIXE_VISION) ? "vision" : "modele";

/** Les lignes d'une pièce lue, en lignes de tableau — pour la réconciliation. */
function lignesPourReconcilier(piece: PieceLue): LigneTableau[] {
  return piece.lignes.filter((x) => !x.section).map((x) => ({
    numero: x.rang, designation: x.designation, reference: x.reference, page: 0,
    quantite: x.quantite, prixUnitaire: x.prixUnitaire,
    montant: x.montantHt ?? (x.quantite !== null && x.prixUnitaire !== null ? Math.round(x.quantite * x.prixUnitaire * (1 - (x.remise ?? 0)) * 100) / 100 : null),
    doutes: x.illisibles.map((i) => i.raison),
  }));
}

/**
 * PROPOSER LA LECTURE D'UNE PIÈCE. Refuse un format qu'aucun lecteur ne lit et une taille hors limite,
 * en le disant ; sinon rend la proposition — même sans lignes, la lecture locale (texte, OCR,
 * en-tête, totaux) est rendue, et l'absence de lignes dit sa raison (§104.15).
 */
export async function proposerLecture(args: {
  user: { id: string };
  octets: Buffer;
  nomFichier: string;
  contexte: ContexteLecture;
}): Promise<ResultatProposition> {
  const { user, octets, contexte } = args;
  const nomFichier = (args.nomFichier ?? "").trim().slice(0, NOM_MAX);
  const ext = extensionDe(nomFichier);
  if (!(FORMATS_LUS as readonly string[]).includes(ext)) return { ok: false, error: refusFormatDePiece(ext, FORMATS_LUS) };
  if (octets.length === 0) return { ok: false, error: PHRASE_VIDE };
  if (octets.length > TAILLE_MAX_OCTETS) return { ok: false, error: refusTailleDePiece(octets.length, TAILLE_MAX_OCTETS) };

  // UN SCAN SE LIT PAR LUNA, PAS PAR UN OCR (§118.200, décision du dirigeant) — quand la pièce peut
  // sortir de l'ERP et que la lecture par l'IA est ouverte. Sinon (confidentielle, IA coupée, bascule
  // fermée), le moteur LOCAL, jamais un OCR externe (`cloud: false`).
  const parLuna = contexte.sortieCloudPermise && (await disponibiliteLecturePieces()).disponible;
  const lu = await lireFichierUneFois({ octets, ext, cloud: false, maxPages: PAGES_MAX, userId: user.id },
    parLuna ? { ocr: moteurLuna(moteurParDefaut) } : {});
  if (!lu.ok) return { ok: false, error: lu.message };
  const l = lu.lecture;
  const faits = faitsDe(l);
  const entetes = repererEntetes(l.texte);
  if (l.etat === "LUE") await garderEntetes(l.id, entetes);

  const noteMethode = noteDeMethode(faits);
  const societes = contexte.groupe?.societes ?? [];

  // ── LE TABLEAU PAR SES POSITIONS (lot B1) : local, sans modèle — confidentielle comprise. S'il réconcilie
  // (chaque ligne recoupée, numérotation suivie, somme = HT imprimé), c'est LUI qui fait les lignes.
  // UN SCAN SE LIT SUR SON IMAGE (Moyens généraux, 09/11/2026). Une photo, ou un PDF qu'une image couvre : sa couche
  // texte est l'OCR du scanner, qui perd les décimales et colle les colonnes — sans que rien la dénonce, puisqu'elle reste
  // cohérente avec elle-même. Ni ses positions ni le modèle de texte n'y lisent juste : la vision passe la PREMIÈRE.
  const scan = IMAGES_LUES.has(ext) || (ext === "pdf" && (await pdfEstUnScan(octets).catch(sansBloquer("pieces-lues.scan", false))));
  const rangees = ext === "pdf" && !scan ? await rangeesDuPdf(octets).catch(sansBloquer("pieces-lues.positions", null)) : null;
  const tableau = rangees ? lireTableau(rangees) : null;
  const htImprime = entetes.totalHt?.valeur ?? tableau?.totalHt ?? null;
  const etiquete = identiteEmetteurDuTexte(l.texte);
  const ed0 = emetteurEtDestinataire({ texte: l.texte, nomFichier, groupe: societes, nomEtiquete: etiquete.nom });
  const recPositions = tableau && tableau.lignes.length ? reconcilier(tableau, htImprime) : null;
  const parPositions = tableau && recPositions?.juste ? pieceDepuisTableau(tableau.lignes, entetes, ed0.emetteur, SUSPECTE) : null;

  // LA VISION, D'ABORD POUR UN SCAN — sauf si ses lignes sont déjà gardées pour cette lecture (pas deux appels).
  const passeVision = () => lireTableauParVision(octets, ext, VISION).catch(sansBloquer("pieces-lues.vision", null));
  let vision: Awaited<ReturnType<typeof passeVision>> = null;
  let visionTentee = false;
  let lignes: LignesDeLecture | null = null;
  if (scan && contexte.sortieCloudPermise) {
    const gardee = await structureGardeeEtSource(l.id);
    if (gardee.piece && methodeDeSource(gardee.par) === "vision") {
      lignes = { piece: gardee.piece, raison: null, sansLignes: null, methode: "vision" };
    } else {
      visionTentee = true;
      vision = await passeVision();
    }
  }
  // Le total d'un scan se prend sur l'image : celui de sa couche texte a pu perdre ses décimales.
  const htDeLaVision = (v: NonNullable<typeof vision>) => (scan ? v.totalHt ?? htImprime : htImprime ?? v.totalHt);
  if (!lignes && !(vision && vision.lignes.length)) {
    // UN PDF SCANNÉ DONT L'IMAGE N'A PAS PU ÊTRE LUE ne se lit PAS par sa couche texte : c'est celle du scanner, aux
    // décimales perdues — elle donnerait des montants centuplés, plus coûteux qu'aucune ligne (09/11/2026).
    lignes = scan && ext === "pdf" && l.methode === "texte" && visionTentee
      ? { piece: null, raison: null, sansLignes: PHRASE_SCAN_NON_LU }
      : await lignesDeLaLecture(l, { noteMethode, nomFichier, confidentielle: !contexte.sortieCloudPermise, userId: user.id, parPositions });
  }
  let reconciliation: Reconciliation | null = lignes?.piece
    ? (lignes.methode === "positions" ? recPositions : reconcilier({ lignes: lignesPourReconcilier(lignes.piece), trous: [] }, htImprime))
    : null;

  // ── LA SECONDE PASSE : LA VISION. La lecture ne réconcilie pas (ou il n'y en a pas) — on relit l'image des pages.
  // Jamais pour une pièce confidentielle ; jamais deux fois pour la même lecture.
  if (!vision && !visionTentee && !reconciliation?.juste && contexte.sortieCloudPermise
    && lignes?.methode !== "vision" && lignes?.methode !== "positions") {
    vision = await passeVision();
  }
  if (vision && vision.lignes.length) {
    const recV = reconcilier(vision, htDeLaVision(vision));
    const nomV = vision.emetteur.nom && !estDuGroupe(vision.emetteur.nom, societes) ? vision.emetteur.nom : null;
    // Un scan : l'image fait foi dès qu'elle a des lignes. Sinon, elle remplace la lecture du texte si elle réconcilie mieux.
    const meilleure = scan || !lignes?.piece || recV.juste || !reconciliation || scoreReconciliation(recV) < scoreReconciliation(reconciliation);
    if (meilleure) {
      // L'émetteur d'un scan se lit sur l'image : la couche texte du scanner l'a souvent rendu illisible.
      const emV = { ...ed0.emetteur, nom: scan ? nomV ?? ed0.emetteur.nom : ed0.emetteur.nom ?? nomV };
      const pieceV = pieceDepuisTableau(vision.lignes, entetes, emV, SUSPECTE);
      if (l.etat === "LUE") await remplacerStructure(l.id, pieceV, `${PREFIXE_VISION}${vision.modele}`);
      lignes = { piece: pieceV, raison: null, sansLignes: null, methode: "vision" };
      reconciliation = recV;
    }
  }
  // La vision tentée d'abord n'a rien donné : la lecture du texte, comme pour toute pièce.
  if (!lignes) {
    lignes = await lignesDeLaLecture(l, { noteMethode, nomFichier, confidentielle: !contexte.sortieCloudPermise, userId: user.id, parPositions });
    reconciliation = lignes.piece ? reconcilier({ lignes: lignesPourReconcilier(lignes.piece), trous: [] }, htImprime) : null;
  }
  // Une lecture positionnelle qui ne réconcilie pas, et rien de mieux : elle vaut mieux que rien (un PDF confidentiel, IA coupée).
  if (!lignes.piece && tableau && tableau.lignes.length) {
    lignes = { piece: pieceDepuisTableau(tableau.lignes, entetes, ed0.emetteur, SUSPECTE), raison: null, sansLignes: null, methode: "positions" };
    reconciliation = recPositions;
  }
  const piece = lignes.piece;
  // L'ÉMETTEUR, relu avec ce que le modèle a dit — jamais une société du groupe.
  const ed = emetteurEtDestinataire({ texte: l.texte, nomFichier, groupe: societes, nomEtiquete: etiquete.nom, nomModele: piece?.fournisseur.nom ?? null });
  const verdict = verdictDeLecture({
    methode: lignes.methode ?? null, nbLignes: piece ? piece.lignes.filter((x) => !x.section).length : 0, reconciliation,
    emetteurNom: ed.emetteur.nom, emetteurDuGroupe: Boolean(ed.emetteur.nom && estDuGroupe(ed.emetteur.nom, societes)),
  });
  if (l.etat === "LUE") await garderVerdict(l.id, verdict);
  const decoupe = decouperPourLecture(l.texte, BUDGET_CARACTERES);
  const chiffrees = piece ? piece.lignes.filter((x) => !x.section) : [];

  return {
    ok: true,
    proposition: {
      lectureId: l.id,
      empreinte: l.empreinte,
      nomFichier,
      cible: contexte.cible,
      faits,
      noteMethode,
      lignesParModele: piece !== null,
      raisonSansLignes: lignes.raison,
      sansLignes: lignes.sansLignes,
      coupe: piece ? phraseCoupeDuTexte(decoupe.total, decoupe.lu.length) : null,
      entetes,
      piece,
      controle: piece ? controlerPiece(piece, entetes) : null,
      fournisseur: candidatsFournisseur(
        societes.length ? identiteDeLEmetteur(ed.emetteur, piece, societes) : identiteLue(piece, entetes),
        societes.length ? contexte.annuaireVisible.filter((c) => !ficheDuGroupe(c, societes)) : contexte.annuaireVisible,
        contexte.groupe ?? {},
      ),
      appariement: piece && contexte.lignesAttendues
        ? apparierLignes(chiffrees.map((x) => ({ designation: x.designation, quantite: x.quantite, prixUnitaire: x.prixUnitaire })), contexte.lignesAttendues)
        : null,
      suspectes: (piece?.lignes ?? []).filter((x) => x.suspecte.length > 0).map((x) => ({ rang: x.rang, designation: x.designation, motifs: x.suspecte })),
      emetteur: societes.length
        ? { ...fusionnerIdentite(etiquete, null), nom: ed.emetteur.nom, nif: ed.emetteur.nif ?? etiquete.nif, rc: ed.emetteur.rc ?? etiquete.rc }
        : fusionnerIdentite(
          etiquete,
          piece?.fournisseur ? { nom: piece.fournisseur.nom, adresse: piece.fournisseur.adresse, nif: piece.fournisseur.nif, rc: piece.fournisseur.rc } : null,
        ),
      methodeLignes: lignes.methode ?? null,
      reconciliation,
      destinataire: ed.destinataire,
      emetteurLu: ed.emetteur,
      verdict,
    },
  };
}

/** Le verdict, gardé avec la lecture — réécrit à chaque proposition : une seconde passe a pu le rendre FIABLE. */
async function garderVerdict(id: string, v: VerdictLecture): Promise<void> {
  await prisma.lecturePiece.updateMany({
    where: { id, etat: "LUE" },
    data: { verdict: v.statut, verdictDetail: v as unknown as Prisma.InputJsonValue },
  }).catch((e) => console.error("[pièces lues] verdict non gardé (non bloquant)", id, e));
}

/** Plus petit = meilleure lecture : un trou ou une ligne douteuse pèse, l'écart aussi. */
function scoreReconciliation(r: Reconciliation): number {
  return (r.juste ? 0 : 1_000_000) + r.manquantes.length * 10_000 + r.douteuses.length * 1_000 + Math.min(Math.abs(r.ecart ?? 1e6), 999);
}

/** L'émetteur tel que l'annuaire le cherche : son nom et SES identifiants — jamais ceux du bloc client. */
function identiteDeLEmetteur(e: EmetteurLu, piece: PieceLue | null, societes: NonNullable<IdentifiantsDuGroupe["societes"]>) {
  const modeleHorsGroupe = piece?.fournisseur.nom && !estDuGroupe(piece.fournisseur.nom, societes);
  return {
    nom: e.nom,
    nifs: [e.nif, modeleHorsGroupe ? piece?.fournisseur.nif ?? null : null],
    rcs: [e.rc, modeleHorsGroupe ? piece?.fournisseur.rc ?? null : null],
  };
}

/**
 * L'ANNUAIRE QUE LA PERSONNE VOIT, avec ce qui reconnaît un émetteur (NIF, RC) — par la lecture
 * canonique de l'annuaire (`listPartyOptions`, un seul cloisonnement), pas par une seconde portée
 * écrite ici (§118.5). Et les identifiants du groupe : le client de la pièce, jamais son émetteur.
 */
export async function annuaireDeLecture(userId: string): Promise<{ annuaireVisible: ContactAnnuaire[]; groupe: IdentifiantsDuGroupe }> {
  const [options, identites, societes] = await Promise.all([
    listPartyOptions(userId),
    prisma.companyLegalIdentity.findMany({ select: { nif: true, rcNumber: true } }),
    prisma.company.findMany({ select: { id: true, name: true, shortName: true, legalIdentity: { select: { legalName: true, nif: true, rcNumber: true } } } }),
  ]);
  const fiches = options.length > 0
    ? await prisma.companyContact.findMany({ where: { id: { in: options.map((o) => o.id) } }, select: { id: true, nif: true, rc: true } })
    : [];
  const parId = new Map(fiches.map((f) => [f.id, f]));
  return {
    annuaireVisible: options.map((o) => ({ id: o.id, nom: o.name, nif: parId.get(o.id)?.nif ?? null, rc: parId.get(o.id)?.rc ?? null })),
    groupe: {
      nifs: identites.map((i) => i.nif), rcs: identites.map((i) => i.rcNumber),
      // Les sociétés du groupe, par leurs NOMS aussi : le client d'un devis, jamais son fournisseur (lot B1).
      societes: societes.map((s) => ({
        id: s.id, noms: [s.name, s.shortName, s.legalIdentity?.legalName], nifs: [s.legalIdentity?.nif], rcs: [s.legalIdentity?.rcNumber],
      })),
    },
  };
}

// ─────────────────────────────── La confirmation ───────────────────────────────

export interface DemandeConfirmation {
  lectureId: string;
  /** L'empreinte du fichier que l'écriture joint (ou a déjà joint) : celle de la lecture, ou rien ne se confirme. */
  empreinte: string;
  soumises: readonly LigneSoumise[];
  totalVerifie: boolean;
  /** Les lignes que l'écran a proposées, traduites de la pièce lue — la MÊME traduction que le préremplissage. */
  proposees: (piece: PieceLue | null) => LigneProposee[];
  /** L'écran atteste d'UNE case (son libellé) au lieu d'une case par ligne et d'une pour le total — le refus la nomme. */
  caseGlobale?: string;
}

/** Ce que l'écriture métier consigne, dans sa transaction. */
export interface ConfirmationPrete {
  lectureId: string;
  verdicts: VerdictDeLigne[];
  /** « lignes lues par OCR (71 %), confirmées une à une : … » — pour l'audit. */
  resumeAudit: string;
  /** Le contrôle de la LECTURE au moment de la confirmation : confirmée malgré un écart, ça se garde. */
  controle: { totalVerifie: true; conforme: boolean | null; ecarts: string[]; manques: string[]; desaccords: string[] };
}

/**
 * LA GARDE DE CONFIRMATION — appelée par l'action AVANT toute écriture (le scan compris). L'état
 * d'abord (la lecture existe, le fichier est le sien, elle est terminée), les cases ensuite (§118.18).
 */
export async function exigerLectureConfirmee(d: DemandeConfirmation): Promise<{ ok: true; confirmation: ConfirmationPrete } | { ok: false; error: string }> {
  const ligne = await prisma.lecturePiece.findUnique({
    where: { id: d.lectureId },
    select: { id: true, empreinte: true, etat: true, methode: true, confiance: true, structure: true, entetes: true },
  });
  if (!ligne) return { ok: false, error: PHRASE_LECTURE_INCONNUE };
  if (ligne.empreinte !== d.empreinte) return { ok: false, error: PHRASE_AUTRE_FICHIER };
  if (ligne.etat !== "LUE" && ligne.etat !== "ECHOUEE") return { ok: false, error: PHRASE_PAS_TERMINEE };

  const piece = pieceGardee(ligne.structure);
  const proposees = d.proposees(piece);
  const refus = refusDeConfirmation(proposees, d.soumises, d.totalVerifie, { caseGlobale: d.caseGlobale });
  if (refus) return { ok: false, error: refus };

  const verdicts = verdictsDeConfirmation(proposees, d.soumises);
  const entetes = entetesGardees(ligne.entetes);
  const controle = piece && entetes ? controlerPiece(piece, entetes) : null;
  return {
    ok: true,
    confirmation: {
      lectureId: ligne.id,
      verdicts,
      resumeAudit: phraseAuditConfirmation({ methode: ligne.methode === "ocr" ? "ocr" : "texte", confiance: ligne.confiance }, verdicts, Boolean(d.caseGlobale)),
      controle: {
        totalVerifie: true,
        conforme: controle ? controle.conforme : null,
        ecarts: controle?.ecarts.map((x) => x.phrase) ?? [],
        manques: controle?.manques.map((x) => x.phrase) ?? [],
        desaccords: controle?.desaccords.map((x) => x.phrase) ?? [],
      },
    },
  };
}

/**
 * CONSIGNER L'ATTESTATION — DANS la transaction de l'écriture métier, jamais à côté. La lecture est
 * tenue (`FOR KEY SHARE`) le temps de l'écrire : purgée entre la garde et l'écriture, l'attestation
 * n'aurait plus d'objet, et le refus annule l'écriture métier avec elle.
 */
export async function consignerConfirmation(
  tx: Prisma.TransactionClient,
  c: { confirmation: ConfirmationPrete; cibleType: CibleLecture; cibleId: string; confirmeeParId: string },
): Promise<void> {
  const tenue = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "LecturePiece" WHERE id = ${c.confirmation.lectureId} FOR KEY SHARE`;
  if (tenue.length === 0) throw new RefusLecture(PHRASE_LECTURE_DISPARUE);
  await tx.lecturePieceConfirmation.create({
    data: {
      lectureId: c.confirmation.lectureId,
      cibleType: c.cibleType,
      cibleId: c.cibleId,
      confirmeeParId: c.confirmeeParId,
      lignes: c.confirmation.verdicts as unknown as Prisma.InputJsonValue,
      controle: c.confirmation.controle as unknown as Prisma.InputJsonValue,
    },
  });
}
