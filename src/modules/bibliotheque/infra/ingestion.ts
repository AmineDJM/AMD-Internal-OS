import { createHash } from "node:crypto";
import { Prisma, type BibliothequeFiche } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getBlob } from "@/lib/drive-storage";
import { lireFichierUneFois } from "@/lib/pieces-lues/lecture-fichier";
import { parsePptx, pptxToText } from "@/lib/knowledge/parsers/pptx";
import { classerPiece, estNatureLocale } from "@/lib/enrichissement/classement";
import { nomAnnonceLeCoffre } from "@/modules/assistant-ia/partage";
import { transcribeAudio } from "@/lib/ai";
import { aiFeatureEnabled, logAiUsage } from "@/lib/ai-settings";
import { decouper } from "../domaine/decoupage";
import { estFormat, extensionPourLecture, type Format } from "../domaine/format";
import { lireCle } from "../domaine/familles";
import {
  issueApresEchec, lectureDe, messageErreur, PAGES_MAX, prochainEssai, raisonDIgnorer, VERROU_PERIME_MS, VERSION_INGESTION,
} from "../domaine/ingestion";
import { vectorisable } from "../domaine/politique";
import { capacites, embedderParDefaut, LOT_EMBEDDINGS, litteralVecteur, type Embedder } from "./capacites";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INGESTION — lire chaque pièce UNE fois, la découper, la vectoriser (J1).
 *
 * La tâche de fond `bibliotheque.ingestion` (`src/lib/scheduled.ts`, sous BAIL `TacheDeFond`) appelle
 * `traiterFile` à chaque passage. Pour chaque fiche prise (`FOR UPDATE SKIP LOCKED` : deux exécutants ne
 * prennent jamais la même) :
 *
 *   1. IGNORER ce qui n'a rien à lire, durablement (archive, format inconnu, > 40 Mo) — c'est dit ;
 *   2. LIRE, par les lecteurs EXISTANTS, aucun d'écrit ici :
 *        PDF, Word, Excel, CSV, texte, images → `lireFichierUneFois` (texte natif, puis OCR LOCAL si scanné
 *          — `cloud: false`, rien ne sort ; lu une fois par empreinte, scellé, partagé avec l'enrichissement) ;
 *        PowerPoint → `parsePptx` (`knowledge/parsers`) ;
 *        audio, vidéo → la transcription déjà faite par l'écran (réunion, rapport terrain) si elle existe,
 *          sinon `transcribeAudio` (Whisper) sous la bascule « voix » — JAMAIS pour une pièce confidentielle ;
 *   3. CLASSER localement (`classerPiece`) : une pièce du coffre (identité, paie, RIB) devient SENSIBLE ;
 *   4. DÉCOUPER (~800 jetons, chevauchement) et remplacer les passages, en une transaction — rejouer
 *      donne les mêmes passages (idempotence par empreinte : une fiche par pièce, une pièce par SHA-256) ;
 *   5. VECTORISER par lots (text-embedding-3-small, 512 d) si la base porte pgvector et si la pièce peut
 *      partir au fournisseur (ni confidentielle, ni sensible). Un échec d'embedding ne défait pas la
 *      lecture : les passages restent cherchables en plein texte, `vectoriserEnRetard` les reprend.
 *
 * Un échec (blob illisible, lecteur qui lève) remet la fiche en file avec un délai croissant ; après six
 * essais elle passe en ÉCHEC, l'erreur écrite (une ligne, jamais un contenu).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface TexteLu {
  texte: string;
  methode: "texte" | "ocr" | "transcription" | "aucune";
}

export interface DependancesIngestion {
  octets: (blobId: string) => Promise<Buffer | null>;
  /** Lire un document (texte natif, OCR local). */
  lire: (a: { octets: Buffer; ext: string; userId: string | null }) => Promise<TexteLu>;
  /** Transcrire un enregistrement — `null` quand la transcription est coupée ou indisponible (raison donnée). */
  transcrire: (a: { octets: Buffer; nom: string; mime: string | null; userId: string | null }) => Promise<TexteLu | { indisponible: string }>;
  /** La transcription que l'écran a déjà faite pour un des endroits de la pièce. */
  transcriptionConnue: (cles: readonly string[]) => Promise<string | null>;
  embed: Embedder;
}

export const DEPENDANCES_REELLES: DependancesIngestion = {
  octets: (blobId) => getBlob(blobId),
  async lire({ octets, ext, userId }) {
    if (ext === "pptx") {
      const texte = pptxToText(await parsePptx(octets));
      return { texte, methode: texte.trim() ? "texte" : "aucune" };
    }
    const r = await lireFichierUneFois({ octets, ext, cloud: false, maxPages: PAGES_MAX, userId });
    if (!r.ok) throw new Error(r.message);
    const texte = r.lecture.texte ?? "";
    return { texte, methode: !texte.trim() ? "aucune" : r.lecture.methode === "ocr" ? "ocr" : "texte" };
  },
  async transcrire({ octets, nom, mime, userId }) {
    if (!(await aiFeatureEnabled("voice"))) return { indisponible: "transcription vocale désactivée (Centre de contrôle IA)" };
    const t0 = Date.now();
    const tr = await transcribeAudio(octets, nom || "audio.webm", mime || "audio/webm");
    await logAiUsage({
      feature: "voice", provider: "openai", model: process.env.STT_MODEL ?? "whisper-1", userId,
      ok: tr.ok, latencyMs: Date.now() - t0, errorCode: tr.ok ? null : tr.error ?? "error",
    });
    if (!tr.ok) {
      if (!tr.configured) return { indisponible: tr.error ?? "transcription non configurée" };
      throw new Error(tr.error ?? "transcription impossible");
    }
    return { texte: tr.text ?? "", methode: (tr.text ?? "").trim() ? "transcription" : "aucune" };
  },
  async transcriptionConnue(cles) {
    for (const cle of cles) {
      const c = lireCle(cle);
      if (c?.famille === "REUNION_AUDIO") {
        const m = await prisma.meeting.findUnique({ where: { id: c.id }, select: { transcript: true } });
        if (m?.transcript?.trim()) return m.transcript;
      }
      if (c?.famille === "TERRAIN_AUDIO") {
        const r = await prisma.fieldReport.findUnique({ where: { id: c.id }, select: { transcript: true } });
        if (r?.transcript?.trim()) return r.transcript;
      }
    }
    return null;
  },
  embed: embedderParDefaut,
};

export interface BilanIngestion {
  prises: number;
  faites: number;
  ignorees: number;
  echecs: number;
  passages: number;
  vectorises: number;
}

/** Prend au plus `max` fiches dues (ou abandonnées par un processus mort), sans jamais doubler un autre exécutant. */
async function prendre(max: number, seulement: readonly string[] | null): Promise<BibliothequeFiche[]> {
  const perime = new Date(Date.now() - VERROU_PERIME_MS);
  const parmi = seulement ? Prisma.sql`AND "pieceId" IN (${Prisma.join(seulement.length ? [...seulement] : [""])})` : Prisma.empty;
  return prisma.$queryRaw<BibliothequeFiche[]>`
    UPDATE "BibliothequeFiche" f
       SET "statut" = 'EN_COURS', "verrouilleLe" = now(), "tentatives" = f."tentatives" + 1, "updatedAt" = now()
     WHERE f."pieceId" IN (
       SELECT "pieceId" FROM "BibliothequeFiche"
        WHERE (("statut" = 'A_FAIRE' AND "prochainEssaiLe" <= now())
           OR ("statut" = 'EN_COURS' AND "verrouilleLe" < ${perime})) ${parmi}
        ORDER BY "prochainEssaiLe" ASC
        LIMIT ${max}
        FOR UPDATE SKIP LOCKED)
    RETURNING f.*`;
}

export async function traiterFile(opts: {
  max?: number;
  deps?: Partial<DependancesIngestion>;
  /** Seulement ces pièces (Super Admin « relire maintenant », bancs) ; sinon les plus anciennes dues. */
  seulement?: readonly string[];
  /**
   * J11 (décision 0030) — VIDER LA FILE dans un budget de temps : tant qu'il reste des fiches dues et du budget, un lot
   * de plus est pris. Sans budget, un seul lot (le comportement d'avant). Un dossier de 300 fichiers se lit ainsi en
   * quelques passages de la tâche de fond, pas en trente.
   */
  budgetMs?: number;
  /** Fiches lues EN MÊME TEMPS (défaut 1) — bornée à 6 : un OCR tient de la mémoire. */
  parallele?: number;
} = {}): Promise<BilanIngestion> {
  const deps: DependancesIngestion = { ...DEPENDANCES_REELLES, ...opts.deps };
  const bilan: BilanIngestion = { prises: 0, faites: 0, ignorees: 0, echecs: 0, passages: 0, vectorises: 0 };
  const debut = Date.now();
  const parallele = Math.max(1, Math.min(6, Math.floor(opts.parallele ?? 1)));
  const lireUne = async (f: BibliothequeFiche) => {
    try {
      const issue = await ingerer(f, deps);
      if (issue.statut === "IGNOREE") bilan.ignorees += 1;
      else {
        bilan.faites += 1;
        bilan.passages += issue.passages;
      }
    } catch (err) {
      bilan.echecs += 1;
      const statut = issueApresEchec(f.tentatives);
      await prisma.bibliothequeFiche.update({
        where: { pieceId: f.pieceId },
        data: { statut, prochainEssaiLe: prochainEssai(f.tentatives), verrouilleLe: null, derniereErreur: messageErreur(err) },
      }).catch((e) => console.error("[bibliotheque] fiche en échec non écrite", e));
    }
  };
  for (;;) {
    const fiches = await prendre(Math.max(1, opts.max ?? 10), opts.seulement ?? null);
    bilan.prises += fiches.length;
    // `parallele` lecteurs se partagent le lot : chacun prend la fiche suivante dès qu'il a fini la sienne.
    let curseur = 0;
    await Promise.all(Array.from({ length: Math.min(parallele, fiches.length) }, async () => {
      while (curseur < fiches.length) await lireUne(fiches[curseur++]!);
    }));
    bilan.vectorises += await vectoriserEnRetard({ max: 200, embed: deps.embed, seulement: opts.seulement });
    if (!opts.budgetMs || !fiches.length || Date.now() - debut >= opts.budgetMs) break;
  }
  return bilan;
}

async function ignorer(pieceId: string, raison: string): Promise<{ statut: "IGNOREE" }> {
  await prisma.bibliothequeFiche.update({
    where: { pieceId },
    data: { statut: "IGNOREE", verrouilleLe: null, derniereErreur: raison, methode: "aucune", versionIngestion: VERSION_INGESTION, ingereLe: new Date() },
  });
  return { statut: "IGNOREE" };
}

async function ingerer(f: BibliothequeFiche, deps: DependancesIngestion): Promise<{ statut: "FAITE"; passages: number } | { statut: "IGNOREE" }> {
  const format: Format = estFormat(f.format) ? f.format : "autre";
  const nom = (await prisma.piece.findUnique({ where: { id: f.pieceId }, select: { nom: true, empreinte: true } })) ?? { nom: f.titre, empreinte: "" };
  const raison = raisonDIgnorer(format, f.taille);
  if (raison) return ignorer(f.pieceId, raison);

  const octets = await deps.octets(f.blobId);
  if (!octets) throw new Error("contenu de la pièce introuvable dans le coffre");
  // Un dépôt direct au bucket entre sans empreinte : on la pose maintenant que les octets sont là.
  if (nom.empreinte.startsWith("direct:")) {
    await prisma.piece.update({ where: { id: f.pieceId }, data: { empreinte: createHash("sha256").update(octets).digest("hex") } });
  }

  let lu: TexteLu;
  if (lectureDe(format) === "transcription") {
    const connue = await deps.transcriptionConnue(f.cles);
    if (connue) lu = { texte: connue, methode: "transcription" };
    else if (f.confidentiality === "CONFIDENTIAL") return ignorer(f.pieceId, "enregistrement confidentiel : il n'est pas envoyé au service de transcription");
    else {
      const t = await deps.transcrire({ octets, nom: nom.nom, mime: f.mime, userId: f.auteurId });
      if ("indisponible" in t) return ignorer(f.pieceId, t.indisponible);
      lu = t;
    }
  } else {
    lu = await deps.lire({ octets, ext: extensionPourLecture(nom.nom, f.mime), userId: f.auteurId });
  }

  // Le classement LOCAL : une pièce d'identité, une fiche de paie, un RIB deviennent sensibles.
  const c = classerPiece({ nomFichier: nom.nom, mime: f.mime ?? "", texte: lu.texte });
  const sensible = f.sensible || estNatureLocale(c.nature) || nomAnnonceLeCoffre(nom.nom);
  const passages = decouper(lu.texte);

  await prisma.$transaction([
    prisma.bibliothequePassage.deleteMany({ where: { pieceId: f.pieceId } }),
    prisma.bibliothequePassage.createMany({
      data: passages.map((p) => ({ pieceId: f.pieceId, rang: p.rang, texte: p.texte, debut: p.debut, jetons: p.jetons })),
    }),
    prisma.bibliothequeFiche.update({
      where: { pieceId: f.pieceId },
      data: {
        statut: "FAITE", verrouilleLe: null, derniereErreur: null, methode: lu.methode, caracteres: lu.texte.length,
        nbPassages: passages.length, nature: c.nature, sensible, versionIngestion: VERSION_INGESTION, ingereLe: new Date(),
      },
    }),
  ]);
  return { statut: "FAITE", passages: passages.length };
}

/**
 * LES VECTEURS EN RETARD : les passages lus mais pas encore vectorisés (fournisseur indisponible, pgvector
 * installé après coup, interrupteur IA rouvert) — par lots, un paquet borné par passage de la tâche.
 */
export async function vectoriserEnRetard(opts: { max?: number; embed?: Embedder; seulement?: readonly string[] } = {}): Promise<number> {
  if (!(await capacites()).vecteur) return 0;
  const embed = opts.embed ?? embedderParDefaut;
  const parmi = opts.seulement ? Prisma.sql`AND p."pieceId" IN (${Prisma.join(opts.seulement.length ? [...opts.seulement] : [""])})` : Prisma.empty;
  const lignes = await prisma.$queryRaw<{ id: string; texte: string; confidentiality: "INTERNAL" | "RESTRICTED" | "CONFIDENTIAL"; sensible: boolean }[]>`
    SELECT p."id", p."texte", f."confidentiality", f."sensible"
      FROM "BibliothequePassage" p JOIN "BibliothequeFiche" f ON f."pieceId" = p."pieceId"
     WHERE p."vectoriseLe" IS NULL AND f."statut" = 'FAITE'
       AND f."confidentiality" <> 'CONFIDENTIAL' AND f."sensible" = false ${parmi}
     ORDER BY p."createdAt" ASC
     LIMIT ${Math.max(1, opts.max ?? 200)}`;
  let faits = 0;
  for (let i = 0; i < lignes.length; i += LOT_EMBEDDINGS) {
    const lot = lignes.slice(i, i + LOT_EMBEDDINGS).filter((l) => vectorisable(l));
    if (!lot.length) continue;
    const vecteurs = await embed(lot.map((l) => l.texte));
    if (!vecteurs) break; // fournisseur indisponible : on reprendra au passage suivant
    for (let j = 0; j < lot.length; j++) {
      const v = vecteurs[j];
      if (!Array.isArray(v)) continue;
      await prisma.$executeRaw`
        UPDATE "BibliothequePassage" SET "vecteur" = ${litteralVecteur(v)}::vector, "vectoriseLe" = now() WHERE "id" = ${lot[j].id}`;
      faits += 1;
    }
  }
  return faits;
}

/** Remet en file une fiche (Super Admin : après correction d'un lecteur, ou une pièce en ÉCHEC). */
export async function relancerFiche(pieceId: string): Promise<boolean> {
  const r = await prisma.bibliothequeFiche.updateMany({
    where: { pieceId, statut: { in: ["ECHEC", "IGNOREE", "FAITE"] } },
    data: { statut: "A_FAIRE", tentatives: 0, prochainEssaiLe: new Date(), derniereErreur: null },
  });
  return r.count === 1;
}

/** Ce que la file contient, par statut (diagnostic, écran de recherche du Super Admin). */
export async function etatDeLaFile(): Promise<Record<string, number>> {
  const r = await prisma.bibliothequeFiche.groupBy({ by: ["statut"], _count: { _all: true } });
  return Object.fromEntries(r.map((x) => [x.statut, x._count._all]));
}
