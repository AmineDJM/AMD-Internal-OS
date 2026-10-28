import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { getBlob } from "@/lib/drive-storage";
import { lireTexteOuOcr } from "@/lib/regulatory/intelligence/extract/texte-ou-ocr";
import { rasterizePdf } from "@/lib/regulatory/intelligence/ocr/ocr-engine";
import { parsePptx, pptxToText } from "@/lib/knowledge/parsers/pptx";
import { classerPiece, estNatureLocale } from "@/lib/enrichissement/classement";
import { NATURES_PIECE, type NaturePiece } from "@/lib/enrichissement/types";
import { ffmpegPresent, imageAlInstant } from "@/platform/in-process/media/transcription";
import { CONSIGNE_CONTENU_NON_FIABLE, encadrerNonFiable } from "@/lib/agent/contenu-non-fiable";
import { natureSensible, REFUS_IDENTITE, REFUS_PAIE } from "@/lib/agent/operations/documents-lus";
import { censurerTexte } from "@/lib/agent/filtre-confidentialite";
import { resoudrePiece, type PieceResolue } from "@/lib/agent/operations/pieces";
import { genererTexte, type ImageJointe } from "@/lib/agent/generer";
import { appelVoix, jetonsAudio, jetonsTexte, type IssueVoix } from "@/lib/agent/consommation";
import { transcrireAvecSegments, type OptionsStt } from "@/lib/media/stt";
import {
  CARACTERES_PAR_MESSAGE, CARACTERES_PAR_PIECE, CONSIGNE_PIECES_LUES, couper, extensionDe, genreDe, IMAGES_CLES_VIDEO,
  IMAGES_PAR_MESSAGE, mimeImage, nomAnnonceLeCoffre, OCTETS_MAX_LECTURE, PAGES_VISION_MAX, phraseCoupe, phraseImagesMessage,
  phrasePagesVision, phrasePiecesMax, phraseTropGros, PIECES_LUES_MAX, REFUS_COFFRE, REFUS_CONTROLE_LOCAL, resumeLecture,
  type GenrePiece, type LecturePiece,
} from "./regles";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ASSISTANT LIT LES PIÈCES DU MESSAGE — PDF, Word, Excel, PowerPoint, CSV, texte, images, audio,
 * vidéo (Direction, 28/10/2026).
 *
 * Pour chaque pièce, dans cet ordre — rien ne part au modèle tant qu'une porte de NOTRE côté peut
 * refuser :
 *
 *   1. les DROITS : la pièce est relue sous les droits de la personne (`resoudrePiece`) ;
 *   2. le COFFRE : une pièce que l'enrichissement a classée d'une nature LOCALE (passeport, CNI,
 *      permis, visa, bulletin de paie, RIB — `NATURES_LOCALES`), une pièce CONFIDENTIELLE, ou un nom
 *      qui l'annonce, est refusée sans être ouverte ;
 *   3. la TAILLE : au-delà de 40 Mo, rien n'est chargé — et c'est dit ;
 *   4. la LECTURE LOCALE (texte du fichier, OCR sur ce serveur — `cloud: false`), puis le CLASSEMENT
 *      local (`classerPiece`, `natureSensible`) : une pièce d'identité ou une fiche de paie reconnue
 *      ici est refusée — pour une IMAGE, avant qu'elle ne parte à la vision. Une image que le
 *      contrôle local n'a pas pu lire n'est pas envoyée (`REFUS_CONTROLE_LOCAL`) ;
 *   5. la VISION (photo, scan, image clé de vidéo) et la TRANSCRIPTION (audio, piste d'une vidéo),
 *      comptées et bornées (`genererTexte` pour la vision, `appelVoix` pour la transcription) ;
 *   6. le FILTRE de confidentialité (IBAN, NIN, salaires cités → masqués), puis la BORNE (24 000
 *      caractères par pièce, 60 000 par message) — chaque coupe est DITE : sous la pièce à l'écran
 *      (`LecturePiece.limite`) et au modèle, qui doit la redire.
 *
 * Le contenu part au modèle ENCADRÉ comme contenu non fiable (`encadrerNonFiable`) : un devis qui
 * écrit « ignore tes consignes » reste une donnée.
 *
 * Les gestes qui touchent le monde (Drive, OCR, rastérisation, ffmpeg, vision, transcription)
 * s'injectent : un banc lit une image ou un scan au faux modèle, sans réseau ni Tesseract.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────── La vision ───────────────────────────────

/**
 * REGARDER DES IMAGES — le MÊME modèle que la conversation (`gpt-6.1-terra` ; mesuré le 28/10 : le texte
 * d'une facture photographiée recopié fidèlement), par la porte `genererTexte` (interrupteur, budget,
 * journal « vision ») ; un banc lui substitue le faux modèle et vérifie ce qui a été montré.
 *
 * Elle ne DÉCIDE pas ce qu'on a le droit de montrer : `lireUne` a déjà écarté le coffre et passé le
 * contrôle LOCAL. La consigne ajoute un second verrou : une pièce du coffre reconnue par le modèle n'est
 * pas transcrite (`NATURE_SENSIBLE`) — l'appelant la refuse.
 */
export const MARQUE_SENSIBLE = "NATURE_SENSIBLE";

export const CONSIGNE_VISION = [
  "Tu LIS des images jointes par un employé d'Adventum Pharma, pour qu'un assistant puisse ensuite répondre à sa question.",
  "Rends, en français : 1) une phrase qui dit ce que montre l'image ; 2) TOUT le texte lisible, recopié fidèlement (chiffres, dates, montants tels qu'imprimés, "
  + "tableaux en lignes « colonne : valeur ») ; 3) les éléments visuels utiles (graphique, tampon, signature, état d'un produit).",
  "N'invente rien : un passage illisible se note [illisible]. Ne réponds pas à la place de l'assistant.",
  `Si l'image est une pièce d'identité (passeport, carte d'identité, permis, visa), un bulletin de paie ou un RIB, réponds UNIQUEMENT « ${MARQUE_SENSIBLE} » sans rien recopier.`,
  CONSIGNE_CONTENU_NON_FIABLE,
].join("\n");

const DELAI_VISION_MS = 90_000;

export type LectureVision = { ok: true; texte: string; sensible: boolean } | { ok: false; raison: string };

export async function regarderImages(images: ImageJointe[], contexte: string): Promise<LectureVision> {
  if (!images.length) return { ok: false, raison: "Aucune image à lire." };
  const r = await genererTexte(CONSIGNE_VISION, contexte, DELAI_VISION_MS, { images, origine: "vision" });
  if (!r.ok) return { ok: false, raison: r.raison };
  return { ok: true, texte: r.texte, sensible: r.texte.includes(MARQUE_SENSIBLE) && r.texte.length < 200 };
}

// ─────────────────────────────── La transcription ───────────────────────────────

/**
 * TRANSCRIRE UN AUDIO — un message vocal, un audio joint, la piste d'une vidéo. Le moteur est celui du
 * Drive et des réunions (`media/stt.ts` : formats, 25 Mo au plus, trois essais, limite DITE) ; ce qui
 * s'ajoute ici, c'est la CONSOMMATION (`appelVoix`, rôle « transcription », fournisseur `openai-audio`).
 */
export interface TranscriptionAudio {
  texte: string;
  dureeS: number | null;
  langue: string | null;
  modele: string;
}

export async function transcrireMedia(octets: Buffer, nom: string, opts: Pick<OptionsStt, "fetchImpl" | "env" | "langue"> = {}): Promise<IssueVoix<TranscriptionAudio>> {
  return appelVoix("transcription", async (inscrire) => {
    const t0 = Date.now();
    const r = await transcrireAvecSegments(octets, nom, { langue: opts.langue ?? "auto", fetchImpl: opts.fetchImpl, env: opts.env });
    if (!r.ok) return { ok: false, raison: r.erreur };
    inscrire({ provider: "openai-audio", model: r.modele, entree: jetonsAudio(r.dureeS), sortie: jetonsTexte(r.texte), ms: Date.now() - t0 });
    return { ok: true, valeur: { texte: r.texte, dureeS: r.dureeS, langue: r.langue, modele: r.modele } };
  });
}

// ─────────────────────────────── La lecture des pièces ───────────────────────────────

export interface PieceChargee {
  piece: PieceResolue;
  mime: string | null;
  taille: number;
  /** La nature posée par l'enrichissement (`Piece.nature`), si la pièce a été classée. */
  nature: string | null;
  confidentialite: string | null;
  /** Chargés seulement si la taille le permet. */
  octets: () => Promise<Buffer | null>;
}

export interface TexteLocal {
  texte: string;
  methode: "texte" | "ocr";
  tronque: boolean;
  /** L'OCR était nécessaire et n'a pas lu (moteur absent, échec) — `null` sinon. */
  raisonOcr: string | null;
}

export interface DependancesLecture {
  charger: (user: CurrentUser, id: string) => Promise<PieceChargee | { erreur: string }>;
  texteLocal: (ext: string, octets: Buffer, maxPages: number) => Promise<TexteLocal>;
  /** Le texte NATIF d'un PDF, sans OCR — pour savoir s'il est scanné. */
  texteNatif: (ext: string, octets: Buffer) => Promise<string>;
  rasteriser: (octets: Buffer, maxPages: number) => Promise<{ pages: Buffer[]; total: number }>;
  presentation: (octets: Buffer) => Promise<string>;
  regarder: typeof regarderImages;
  transcrire: typeof transcrireMedia;
  imagesCles: (octets: Buffer, nom: string, instants: number[]) => Promise<{ images: { octets: Buffer; seconde: number }[] } | { indisponible: string }>;
}

const NATURES = new Set<string>(NATURES_PIECE);

export const DEPENDANCES_REELLES: DependancesLecture = {
  async charger(user, id) {
    const piece = await resoudrePiece(user, id);
    if ("erreur" in piece) return piece;
    const n = await prisma.driveNode.findUnique({
      where: { id: piece.id },
      select: { mimeType: true, size: true, piece: { select: { nature: true, confidentiality: true } } },
    });
    return {
      piece, mime: n?.mimeType ?? null, taille: Number(n?.size ?? 0),
      nature: n?.piece?.nature ?? null, confidentialite: n?.piece?.confidentiality ?? null,
      async octets() {
        const v = await prisma.fileVersion.findFirst({ where: { nodeId: piece.id }, orderBy: { version: "desc" }, select: { blobId: true } });
        return v ? getBlob(v.blobId) : null;
      },
    };
  },
  async texteLocal(ext, octets, maxPages) {
    const l = await lireTexteOuOcr(ext, octets, { cloud: false, maxPages });
    return { texte: l.texte, methode: l.methode, tronque: l.tronque, raisonOcr: l.ocrEchoue || (!l.texte.trim() && l.raisonOcr) ? l.raisonOcr : null };
  },
  async texteNatif(ext, octets) {
    const { extractText } = await import("@/lib/regulatory/intelligence/extract/extract-text");
    return (await extractText(ext, octets)).text ?? "";
  },
  async rasteriser(octets, maxPages) {
    const r = await rasterizePdf(octets, maxPages);
    return { pages: r.pages, total: r.total };
  },
  async presentation(octets) {
    return pptxToText(await parsePptx(octets));
  },
  regarder: regarderImages,
  transcrire: transcrireMedia,
  async imagesCles(octets, nom, instants) {
    if (!(await ffmpegPresent())) return { indisponible: "ffmpeg n'est pas installé sur ce serveur" };
    const images: { octets: Buffer; seconde: number }[] = [];
    for (const s of instants) {
      const png = await imageAlInstant(octets, nom, s);
      if (png) images.push({ octets: png, seconde: s });
    }
    return images.length ? { images } : { indisponible: "aucune image n'a pu être extraite de la vidéo" };
  },
};

/** Ce que la lecture rend au tour : le texte à joindre au message du modèle, et ce que l'écran montre. */
export interface PiecesLues {
  /** Le bloc ajouté au message (pièces nommées + contenus encadrés + limites), vide sans pièce. */
  pourModele: string;
  lectures: LecturePiece[];
}

/** Ce qu'une pièce a donné : son contenu (avant filtre et borne), ou un refus/échec dit. */
type Issue =
  | { statut: "contenu"; texte: string; methode: string; limites: string[] }
  | { statut: "REFUSEE" | "ECHEC"; phrase: string };

const refus = (phrase: string): Issue => ({ statut: "REFUSEE", phrase });
const echec = (phrase: string): Issue => ({ statut: "ECHEC", phrase });

/** La nature locale d'un texte lu sur ce serveur — par les règles du coffre et de l'enrichissement. */
function refusLocal(nom: string, mime: string | null, texte: string): string | null {
  const n = natureSensible(texte);
  if (n === "IDENTITE") return REFUS_IDENTITE;
  if (n === "PAIE") return REFUS_PAIE;
  const c = classerPiece({ nomFichier: nom, mime: mime ?? "", texte });
  return c.nature !== "AUTRE" && estNatureLocale(c.nature) && c.confiance >= 0.55 ? REFUS_COFFRE : null;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** Les instants à regarder dans une vidéo : répartis sur sa durée, jamais la toute première image (souvent noire). */
export function instantsRepartis(dureeS: number | null, n = IMAGES_CLES_VIDEO): number[] {
  const d = dureeS && dureeS > 0 ? dureeS : 8;
  return Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) * d) / n * 10) / 10);
}

class Compteur {
  images = 0;
  constructor(readonly max = IMAGES_PAR_MESSAGE) {}
  /** Prend jusqu'à `n` images dans la réserve du message ; rend combien sont accordées. */
  prendre(n: number): number {
    const k = Math.max(0, Math.min(n, this.max - this.images));
    this.images += k;
    return k;
  }
}

async function lireUne(c: PieceChargee, genre: GenrePiece, deps: DependancesLecture, images: Compteur, question: string): Promise<Issue> {
  const { nom } = c.piece;
  const ext = extensionDe(nom);
  const octets = await c.octets();
  if (!octets?.length) return echec(`« ${nom} » : le contenu du fichier est illisible dans le stockage.`);
  const contexte = `Pièce « ${nom} » jointe par l'employé.${question ? ` Sa question : « ${question.slice(0, 300)} ».` : ""}`;

  if (genre === "texte" || genre === "presentation") {
    const texte = genre === "presentation" ? await deps.presentation(octets) : (await deps.texteLocal(ext, octets, 1)).texte;
    if (!texte.trim()) return echec(`« ${nom} » : aucun texte lisible dans ce fichier.`);
    const r = refusLocal(nom, c.mime, texte);
    if (r) return refus(r);
    return { statut: "contenu", texte, methode: genre === "presentation" ? "texte des diapositives" : "texte du fichier", limites: [] };
  }

  if (genre === "pdf") {
    const natif = await deps.texteNatif(ext, octets);
    if (natif.replace(/\s+/g, "").length >= 200) {
      const r = refusLocal(nom, c.mime, natif);
      if (r) return refus(r);
      return { statut: "contenu", texte: natif, methode: "texte du PDF", limites: [] };
    }
    // UN SCAN : le contrôle LOCAL d'abord (OCR sur ce serveur), la vision ensuite.
    const local = await deps.texteLocal(ext, octets, PAGES_VISION_MAX);
    if (local.raisonOcr && !local.texte.trim()) return refus(REFUS_CONTROLE_LOCAL);
    const r = refusLocal(nom, c.mime, local.texte);
    if (r) return refus(r);
    const { pages, total } = await deps.rasteriser(octets, PAGES_VISION_MAX);
    const accordees = images.prendre(pages.length);
    const limites: string[] = [];
    if (total > accordees) limites.push(accordees < pages.length ? phraseImagesMessage(nom) : phrasePagesVision(nom, accordees, total));
    if (accordees > 0) {
      const v = await deps.regarder(pages.slice(0, accordees).map((p, i) => ({ octets: p, mime: "image/png", legende: `page ${i + 1} sur ${total}` })), contexte);
      if (v.ok && v.sensible) return refus(REFUS_COFFRE);
      if (v.ok) return { statut: "contenu", texte: v.texte, methode: `vision (${accordees} page${accordees > 1 ? "s" : ""} scannée${accordees > 1 ? "s" : ""})`, limites };
      limites.push(`La vision n'a pas pu lire « ${nom} » (${v.raison}) : lecture par l'OCR de ce serveur, moins fidèle.`);
    }
    if (!local.texte.trim()) return echec(`« ${nom} » : aucun texte lisible (scan illisible).`);
    return { statut: "contenu", texte: local.texte, methode: "OCR de ce serveur", limites };
  }

  if (genre === "image") {
    const local = await deps.texteLocal(ext, octets, 1);
    if (local.raisonOcr) return refus(REFUS_CONTROLE_LOCAL);
    const r = refusLocal(nom, c.mime, local.texte);
    if (r) return refus(r);
    if (!images.prendre(1)) return echec(phraseImagesMessage(nom));
    const v = await deps.regarder([{ octets, mime: mimeImage(nom, c.mime) }], contexte);
    if (v.ok && v.sensible) return refus(REFUS_COFFRE);
    if (!v.ok) return echec(`« ${nom} » : ${v.raison}`);
    return { statut: "contenu", texte: v.texte, methode: "vision", limites: [] };
  }

  if (genre === "audio" || genre === "video") {
    const t = await deps.transcrire(octets, nom);
    const parties: string[] = [];
    const limites: string[] = [];
    let dureeS: number | null = null;
    if (t.ok) {
      dureeS = t.valeur.dureeS;
      parties.push(t.valeur.texte.trim() ? `Transcription${dureeS ? ` (${fmt(dureeS)})` : ""} :\n${t.valeur.texte.trim()}` : "Transcription : aucune parole reconnue.");
    } else {
      if (genre === "audio" || t.code !== "ECHEC") return echec(`« ${nom} » : ${t.raison}`);
      limites.push(`Piste audio de « ${nom} » non transcrite : ${t.raison}`);
    }
    let methode = "transcription";
    if (genre === "video") {
      const demande = images.prendre(IMAGES_CLES_VIDEO);
      const extraites = demande ? await deps.imagesCles(octets, nom, instantsRepartis(dureeS, demande)) : { indisponible: `${IMAGES_PAR_MESSAGE} images au plus sont regardées par message` };
      if ("indisponible" in extraites) {
        limites.push(`Images de la vidéo « ${nom} » non regardées : ${extraites.indisponible} — seule la piste audio est lue.`);
      } else {
        const ims: ImageJointe[] = extraites.images.map((im) => ({ octets: im.octets, mime: "image/png", legende: `image clé à ${fmt(im.seconde)}` }));
        const v = await deps.regarder(ims, `${contexte} Ce sont des images clés d'une vidéo, dans l'ordre.`);
        if (v.ok && !v.sensible) {
          parties.push(`Images clés (${ims.length}) :\n${v.texte}`);
          methode = `transcription + ${ims.length} image${ims.length > 1 ? "s" : ""} clé${ims.length > 1 ? "s" : ""}`;
        } else {
          limites.push(`Images de la vidéo « ${nom} » non lues : ${v.ok ? "contenu sensible reconnu" : v.raison}.`);
        }
      }
      if (!parties.length) return echec(`« ${nom} » : ni la piste audio ni les images n'ont pu être lues. ${limites.join(" ")}`);
    }
    return { statut: "contenu", texte: parties.join("\n\n"), methode, limites };
  }

  return echec(`« ${nom} » : ce format (.${ext || "?"}) ne se lit pas dans la conversation — PDF, Word, Excel, PowerPoint, CSV, texte, images, audio et vidéo se lisent.`);
}

/** LIRE LES PIÈCES D'UN MESSAGE — `pieces` déjà revérifiées sous les droits de la personne (`piecesDuMessage`). */
export async function lirePieces(
  user: CurrentUser,
  pieces: PieceResolue[],
  question: string,
  deps: DependancesLecture = DEPENDANCES_REELLES,
): Promise<PiecesLues> {
  if (!pieces.length) return { pourModele: "", lectures: [] };
  const lectures: LecturePiece[] = [];
  const contenus: string[] = [];
  const images = new Compteur();
  let reste = CARACTERES_PAR_MESSAGE;

  for (const [i, p] of pieces.entries()) {
    const genre = genreDe(p.nom);
    const base = { id: p.id, nom: p.nom, genre };
    if (i >= PIECES_LUES_MAX) { lectures.push({ ...base, statut: "NOMMEE", limite: phrasePiecesMax(p.nom) }); continue; }
    if (nomAnnonceLeCoffre(p.nom)) { lectures.push({ ...base, statut: "REFUSEE", limite: REFUS_COFFRE }); continue; }

    let issue: Issue;
    try {
      const c = await deps.charger(user, p.id);
      if ("erreur" in c) issue = echec(`« ${p.nom} » : ${c.erreur}`);
      else if (c.nature && NATURES.has(c.nature) && estNatureLocale(c.nature as NaturePiece)) issue = refus(REFUS_COFFRE);
      else if (c.confidentialite === "CONFIDENTIAL") issue = refus("Pièce classée CONFIDENTIELLE : elle ne se lit que sur ce serveur, jamais par le modèle.");
      else if (c.taille > OCTETS_MAX_LECTURE) issue = echec(phraseTropGros(p.nom, c.taille));
      else issue = await lireUne(c, genre, deps, images, question);
    } catch (e) {
      console.error("[assistant-ia] lecture de pièce", p.id, e);
      issue = echec(`« ${p.nom} » n'a pas pu être lue (erreur de lecture).`);
    }

    if (issue.statut !== "contenu") { lectures.push({ ...base, statut: issue.statut, limite: issue.phrase }); continue; }

    // LE FILTRE, PUIS LA BORNE — dans cet ordre : un masque raccourcit, la coupe se dit sur ce qui part.
    const filtre = censurerTexte(issue.texte);
    const total = filtre.texte.length;
    const plafond = Math.min(CARACTERES_PAR_PIECE, reste);
    const limites = [...issue.limites];
    let texte = filtre.texte;
    if (total > plafond) {
      texte = couper(filtre.texte, Math.max(0, plafond));
      limites.push(phraseCoupe(p.nom, texte.length, total, plafond < CARACTERES_PAR_PIECE ? "message" : "piece"));
    }
    reste -= texte.length;
    const lecture: LecturePiece = {
      ...base, statut: limites.length ? "PARTIELLE" : "LUE", methode: issue.methode,
      retenus: texte.length, total, ...(filtre.occurrences ? { masques: filtre.occurrences } : {}),
      ...(limites.length ? { limite: limites.join(" ") } : {}),
    };
    lectures.push(lecture);
    if (texte.trim()) contenus.push(encadrerNonFiable(`pièce jointe « ${p.nom} » (${issue.methode})`, texte));
  }

  const etat = lectures.map((l) => `- « ${l.nom} » (identifiant ${l.id}) : ${resumeLecture(l)}`).join("\n");
  const pourModele = [
    `[Pièces jointes à ce message]\n${etat}`,
    contenus.length ? `${CONSIGNE_PIECES_LUES}\n\n${contenus.join("\n\n")}` : "",
  ].filter(Boolean).join("\n\n");
  return { pourModele, lectures };
}
