import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";

/**
 * LE SOCLE DES OUTILS EXÉCUTIFS — les aides partagées par les morceaux de `executive-tools/` :
 * le siège exécutif (`EXEC`), la lecture des entrées, la date d'Alger, la transcription persistée
 * d'un média, la note de méthode, et la matière de la timeline d'un dossier (validations, audit, pièces).
 */

/** Le pictogramme d'un document, déduit du nom — le protocole n'en connaît que cinq. */
export function docKindFromName(name: string): "pdf" | "image" | "feuille" | "texte" | "autre" {
  const e = (name.split(".").pop() ?? "").toLowerCase();
  if (e === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(e)) return "image";
  if (["xlsx", "xlsm", "xls", "csv"].includes(e)) return "feuille";
  if (["txt", "md"].includes(e)) return "texte";
  return "autre";
}

/** Le siège exécutif : PDG (DIRECTION) et Super Admin — c'est LE module My Chief of Staff. */
/**
 * LA TRANSCRIPTION D'UN MÉDIA DU DRIVE, PAR LE CHEMIN QUI LA PERSISTE.
 *
 * Rend `null` — et non une erreur — sur tout ce qui ne se transcrit pas à coup sûr : l'appelant
 * retombe alors sur la lecture d'octets. Une garde qui casse la lecture d'un fichier parce que
 * la parole n'a pas pu être reconnue serait pire que le défaut qu'elle corrige (§118.27).
 */
export async function transcriptionPersistee(
  user: CurrentUser,
  nodeId: string,
  nom: string,
): Promise<{ name: string; text: string; note: string | null; truncated: boolean } | null> {
  try {
    const { transcrireMediaDrive } = await import("@/platform/in-process/media/transcription");
    const { texteHorodate, formatHorodatage } = await import("@/platform/in-process/media");
    const r = await transcrireMediaDrive(user, { nodeId });
    if (!r.ok) return null;
    const texte = texteHorodate(r.vue.segments, { locuteurs: false });
    if (!texte.trim()) return null;
    const duree = r.vue.dureeS ? ` — ${formatHorodatage(r.vue.dureeS)}` : "";
    return {
      name: nom,
      text: texte,
      // La réserve vient de la LIGNE persistée, pas d'une note qu'on réécrit à chaque lecture.
      note: `Transcription ${r.vue.modele}${duree}, ${r.vue.segments.length} segment(s)`
        + `${r.vue.horodate ? " horodatés" : " (sans horodatage)"}${r.vue.depuisCache ? ", relue (déjà transcrite)" : ""}`
        + `${r.vue.limites.length ? ` — limites : ${r.vue.limites.join(" ; ")}` : ""}`
        + ` — ce n'est pas un fait vérifié : à citer comme PROBABLE, avec l'instant.`
        + ` Recherche fine de l'instant : media_transcript action=chercher.`,
      truncated: false,
    };
  } catch {
    return null;
  }
}

/**
 * LA NOTE DE MÉTHODE VOYAGE AVEC LE TEXTE — §104.15 appliqué à la porte de lecture.
 *
 * Mesuré sur la campagne live (`defi-media-reunion`) : `lireMedia` écrit une réserve
 * exemplaire — « Transcription <modèle>, N segment(s) horodatés — ce n'est pas un fait vérifié :
 * à citer comme PROBABLE, avec l'instant » — et `read_document` la passait à l'INDEX puis la
 * JETAIT. Adam a donc cité une reconnaissance vocale sous l'étiquette « FAIT VÉRIFIÉ », en toute
 * bonne foi : la seule phrase qui disait le contraire n'a jamais franchi la porte.
 *
 * Même chose pour un scan océrisé, une image lue par un modèle de vision, une présentation sans
 * texte : la méthode et sa confiance sont ce qui distingue une lecture d'une citation. Livrer la
 * sortie sans la note la fait citer comme une certitude (§29).
 *
 * Rend un objet VIDE quand il n'y a rien à dire — une réserve permanente devient du bruit, et on
 * cesse de lire les réserves (§118.32).
 */
export function noteDeMethode(note: string | null | undefined): { methode?: string } {
  const t = (note ?? "").trim();
  return t ? { methode: t } : {};
}

export const EXEC = (u: CurrentUser): boolean => u.role === "SUPER_ADMIN" || u.role === "DIRECTION";

export const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";

export const DOC_TEXT_CAP = 9_000;

/** Un instant, en heure d'Alger, lisible. */
export function fr(d: Date | null | undefined): string {
  if (!d) return "—";
  const alg = new Date(d.getTime() + 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(alg.getUTCDate())}/${p(alg.getUTCMonth() + 1)}/${alg.getUTCFullYear()} ${p(alg.getUTCHours())}:${p(alg.getUTCMinutes())}`;
}

// ───────────────────────── L'HISTOIRE COMPLÈTE D'UN DOSSIER ─────────────────────────

export interface TimelineEntry { at: Date; label: string; who?: string | null }

/** Les validations qui visent une entité : validateurs nommés, décisions, dates. */
export async function validationsOf(entityType: string, entityId: string) {
  const rows = await prisma.validationRequest.findMany({
    where: { entityType: entityType as never, entityId },
    select: {
      reference: true, status: true,
      steps: { select: { status: true, decidedAt: true, validator: { select: { name: true } } }, orderBy: { order: "asc" } },
    },
  });
  return rows.flatMap((v) =>
    v.steps.map((s) => ({
      validateur: s.validator.name,
      decision: s.status,
      date: s.decidedAt ? fr(s.decidedAt) : "en attente",
      demande: v.reference,
    })),
  );
}

/** Le journal d'audit d'une entité — la matière première de la timeline. */
export async function auditOf(entityType: string, entityId: string): Promise<TimelineEntry[]> {
  const rows = await prisma.auditLog.findMany({
    where: { entityType: entityType as never, entityId },
    include: { actor: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
    take: 60,
  });
  return rows.map((h) => ({ at: h.createdAt, label: h.summary ?? h.action, who: h.actor?.name }));
}

/** Les pièces jointes d'une entité, avec leurs liens. */
export async function documentsOf(entityType: string, entityId: string) {
  const docs = await prisma.document.findMany({
    where: { entityType: entityType as never, entityId },
    select: { id: true, name: true, category: true, createdAt: true, uploadedBy: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
    take: 40,
  });
  return docs.map((d) => ({
    documentId: d.id, nom: d.name, categorie: d.category,
    deposePar: d.uploadedBy?.name ?? null, le: fr(d.createdAt),
  }));
}

export function renderTimeline(entries: TimelineEntry[]): { date: string; evenement: string; par?: string | null }[] {
  return [...entries]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((e) => ({ date: fr(e.at), evenement: e.label, ...(e.who ? { par: e.who } : {}) }));
}
