import { Prisma } from "@prisma/client";
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
}

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
  const ligne = await prisma.lecturePiece.findUnique({ where: { id }, select: { structure: true } });
  return pieceGardee(ligne?.structure ?? null);
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
  e: { noteMethode: string; nomFichier: string; confidentielle: boolean; userId: string },
): Promise<LignesDeLecture> {
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
    const gardee = await structureGardee(l.id);
    if (gardee) return { piece: gardee, raison: null, sansLignes: null };
    const r = await structurerParModele({
      texte: l.texte, noteMethode: e.noteMethode, nomFichier: e.nomFichier, confidentielle: false, userId: e.userId,
    });
    if (!r.ok) return { piece: null, raison: r.raison, sansLignes: r.error };
    return { piece: await garderStructure(l.id, r.piece, r.modele), raison: null, sansLignes: null };
  });
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
  const lignes = await lignesDeLaLecture(l, { noteMethode, nomFichier, confidentielle: !contexte.sortieCloudPermise, userId: user.id });
  const piece = lignes.piece;
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
      fournisseur: candidatsFournisseur(identiteLue(piece, entetes), contexte.annuaireVisible, contexte.groupe ?? {}),
      appariement: piece && contexte.lignesAttendues
        ? apparierLignes(chiffrees.map((x) => ({ designation: x.designation, quantite: x.quantite, prixUnitaire: x.prixUnitaire })), contexte.lignesAttendues)
        : null,
      suspectes: (piece?.lignes ?? []).filter((x) => x.suspecte.length > 0).map((x) => ({ rang: x.rang, designation: x.designation, motifs: x.suspecte })),
      emetteur: fusionnerIdentite(
        identiteEmetteurDuTexte(l.texte),
        piece?.fournisseur ? { nom: piece.fournisseur.nom, adresse: piece.fournisseur.adresse, nif: piece.fournisseur.nif, rc: piece.fournisseur.rc } : null,
      ),
    },
  };
}

/**
 * L'ANNUAIRE QUE LA PERSONNE VOIT, avec ce qui reconnaît un émetteur (NIF, RC) — par la lecture
 * canonique de l'annuaire (`listPartyOptions`, un seul cloisonnement), pas par une seconde portée
 * écrite ici (§118.5). Et les identifiants du groupe : le client de la pièce, jamais son émetteur.
 */
export async function annuaireDeLecture(userId: string): Promise<{ annuaireVisible: ContactAnnuaire[]; groupe: IdentifiantsDuGroupe }> {
  const [options, identites] = await Promise.all([
    listPartyOptions(userId),
    prisma.companyLegalIdentity.findMany({ select: { nif: true, rcNumber: true } }),
  ]);
  const fiches = options.length > 0
    ? await prisma.companyContact.findMany({ where: { id: { in: options.map((o) => o.id) } }, select: { id: true, nif: true, rc: true } })
    : [];
  const parId = new Map(fiches.map((f) => [f.id, f]));
  return {
    annuaireVisible: options.map((o) => ({ id: o.id, nom: o.name, nif: parId.get(o.id)?.nif ?? null, rc: parId.get(o.id)?.rc ?? null })),
    groupe: { nifs: identites.map((i) => i.nif), rcs: identites.map((i) => i.rcNumber) },
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
