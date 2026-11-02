import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { lireTexteOuOcr, type MoteurOcr } from "../extract/texte-ou-ocr";
import { splitIntoSections } from "./import";
import {
  CORPUS_IMPORT_EXTS, extOf, titleFromFilename, codeFromTitle, libelleFormats,
  type FileIngestResult,
} from "./import-formats";

// Réexport pour les appelants SERVEUR : la définition vit dans le module pur (voir
// `import-formats.ts`), pour qu'un composant client puisse la lire sans embarquer Prisma.
export type { FileIngestResult } from "./import-formats";

/**
 * INGESTION D'UN TEXTE RÉGLEMENTAIRE DEPUIS UN FICHIER.
 *
 * Le corpus ne se remplissait que par TÉLÉCHARGEMENT depuis le catalogue. Or beaucoup de textes
 * ne sont pas en ligne : arrêtés remis en main propre, notes de l'agence, monographies achetées,
 * documents reçus par courrier. Ils n'avaient aucune porte d'entrée.
 *
 * Les deux principes valent pour TOUTES les voies d'ingestion — les faire diverger créerait deux
 * corpus aux règles différentes :
 *
 *   1. **L'import PAR L'ADMINISTRATEUR vaut activation.** Le corpus est réservé au Super Admin :
 *      son geste d'import EST la décision humaine. La version arrive `ACTIVE` et la précédente du
 *      même texte est retirée — déposer un texte suffit pour qu'il serve à toutes les analyses.
 *      (L'ancien circuit exigeait une activation séparée : des dizaines de textes déposés restaient
 *      « sans effet » sans que rien ne le rende actionnable.)
 *   2. **L'empreinte décide.** Même contenu ⇒ rien n'est créé. Réimporter cinquante fichiers dont
 *      quarante sont déjà connus ne coûte rien et ne pollue pas le RAG.
 *
 * Un fichier à la fois, volontairement : c'est ce qui borne la mémoire (un seul document vit à
 * l'instant t) et ce qui permet de dire, pour CHACUN des cinquante fichiers, ce qui lui est
 * arrivé. Un import en masse qui rend « 47 réussis » sans dire lesquels ont échoué est
 * inexploitable — on ne sait pas quoi recommencer.
 */

/** Taille maximale d'un fichier importé (Mo) — un texte réglementaire reste raisonnable. */
const MAX_MB = Number(process.env.REG_CORPUS_MAX_MB ?? 120);

export interface ImportFileInput {
  filename: string;
  buffer: Buffer;
  /** Autorité émettrice (ANPP, ICH, EMA, EDQM…) — sert au filtrage du RAG. */
  authority?: string | null;
  jurisdiction?: string | null;
  /**
   * CATÉGORIE de connaissance — le corpus dépasse la pharma : « Droit du travail »,
   * « Droit fiscal », « ANPP », « MIPH », « Enregistrement », « Marchés publics / PCH »…
   */
  category?: string | null;
  /** Langue du texte (« fr » par défaut, « ar » pour les textes arabes du Journal officiel). */
  language?: string | null;
  /** Titre imposé ; à défaut, déduit du nom de fichier. */
  title?: string | null;
  userId?: string | null;
  /** Moteur OCR injecté — TESTS uniquement : un test n'a ni réseau ni données de langue. */
  ocr?: MoteurOcr;
}

export async function ingestCorpusFile(input: ImportFileInput): Promise<FileIngestResult> {
  const filename = input.filename.trim();
  const ext = extOf(filename);

  if (!(CORPUS_IMPORT_EXTS as readonly string[]).includes(ext)) {
    return { filename, status: "FAILED", error: `Format « ${ext || "inconnu"} » non pris en charge (${libelleFormats()}).` };
  }
  if (input.buffer.length > MAX_MB * 1024 * 1024) {
    return { filename, status: "FAILED", error: `${Math.round(input.buffer.length / 1048576)} Mo — au-delà de la limite de ${MAX_MB} Mo.` };
  }

  // 1) TEXTE — natif, et OCR quand il n'y en a pas (§118.63).
  //
  // Ce bloc disait : « Document image (scanné) : le corpus attend un texte sélectionnable.
  // Océrisez-le d'abord. » Le moteur OCR vit dans le répertoire voisin, il tourne en production
  // sur les documents de dossier, et l'ingestion d'ENTRAÎNEMENT l'appelait déjà. On renvoyait
  // donc une personne faire à la main ce que le logiciel savait faire, à un mètre de là.
  const lecture = await lireTexteOuOcr(ext, input.buffer, { seuilOcr: 500, ocr: input.ocr });
  const text = lecture.texte;
  if (text.length < 500) {
    return {
      filename, status: "FAILED",
      methode: lecture.methode,
      ...(lecture.confiance !== null ? { confiance: lecture.confiance } : {}),
      error: lecture.methode === "ocr"
        ? `L'OCR n'a lu que ${text.length} caractères sur ${lecture.pages ?? 0} page(s) — le scan est probablement illisible.`
        : lecture.statutNatif === "OCR_REQUIRED"
          ? "Document image sans texte, et l'OCR n'a rien pu en tirer (moteur indisponible ou page vide)."
          : `Texte trop court (${text.length} caractères) — un texte réglementaire en fait davantage.`,
    };
  }

  const title = (input.title ?? "").trim() || titleFromFilename(filename);
  const code = codeFromTitle(title);
  // L'empreinte porte sur le TEXTE, pas sur le fichier : le même arrêté réenregistré en PDF a un
  // octet près différent mais dit exactement la même chose.
  const hash = createHash("sha256").update(text, "utf8").digest("hex");

  try {
    const existing = await prisma.regulatorySource.findFirst({ where: { code }, select: { id: true } });
    const source = existing
      ? await prisma.regulatorySource.update({
          where: { id: existing.id },
          data: {
            title,
            ...(input.authority ? { authority: input.authority } : {}),
            ...(input.jurisdiction ? { jurisdiction: input.jurisdiction } : {}),
            ...(input.category ? { category: input.category } : {}),
            ...(input.language ? { language: input.language } : {}),
          },
          select: { id: true },
        })
      : await prisma.regulatorySource.create({
          data: {
            authority: input.authority || "INTERNE",
            jurisdiction: input.jurisdiction || "DZ",
            code, title, language: input.language || "fr",
            category: input.category || null,
            sourceUrl: null, createdById: input.userId ?? null,
          },
          select: { id: true },
        });

    const latest = await prisma.regulatorySourceVersion.findFirst({
      where: { sourceId: source.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, hash: true },
    });
    if (latest?.hash === hash) {
      return { filename, status: "UNCHANGED", sourceVersionId: latest.id, chars: text.length };
    }

    const version = await prisma.regulatorySourceVersion.create({
      data: {
        sourceId: source.id,
        version: new Date().toISOString().slice(0, 10),
        status: "ACTIVE", // l'import par l'administrateur VAUT activation
        hash,
        originalText: text.slice(0, 5_000_000),
        // D'OÙ VIENT CE TEXTE. Sans ces deux colonnes, une source reconnue par OCR à 63 % est
        // indiscernable d'un arrêté copié depuis le Journal officiel — et Adam la citerait avec
        // la même assurance (§104.15).
        extractionMethod: lecture.methode,
        extractionConfidence: lecture.confiance,
        supersedesId: latest?.id ?? null,
        publishedAt: new Date(),
        approvedById: input.userId ?? null,
        approvedAt: new Date(),
      },
      select: { id: true },
    });
    // Une seule version fait foi par texte : la précédente est retirée.
    await prisma.regulatorySourceVersion.updateMany({
      where: { sourceId: source.id, status: "ACTIVE", id: { not: version.id } },
      data: { status: "RETIRED" },
    });

    const sections = splitIntoSections(text);
    if (sections.length > 0) {
      await prisma.regulatorySourceSection.createMany({
        data: sections.map((s) => ({
          sourceVersionId: version.id, path: s.path, heading: s.heading, text: s.text, ordinal: s.ordinal,
        })),
      });
    }

    return {
      filename, status: "INGESTED", sourceVersionId: version.id, sections: sections.length, chars: text.length,
      methode: lecture.methode,
      ...(lecture.confiance !== null ? { confiance: lecture.confiance } : {}),
      ...(lecture.aRelire ? { aRelire: true } : {}),
    };
  } catch (e) {
    console.error("[corpus] import de fichier impossible", filename, e);
    return { filename, status: "FAILED", error: "Enregistrement en base impossible." };
  }
}
