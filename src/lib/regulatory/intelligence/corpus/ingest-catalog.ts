import { prisma } from "@/lib/prisma";
import { ANPP_WATCH_PAGES, findSource } from "./catalog";
import { fetchSource } from "./fetch-source";

/**
 * INGESTION DU CORPUS et VEILLE DES PUBLICATIONS ANPP.
 *
 * Deux principes non négociables :
 *
 * 1. **L'ingestion par l'administrateur vaut activation.** Le corpus est réservé au Super Admin :
 *    son geste d'ingérer EST la décision humaine, la version arrive `ACTIVE` (opposable dans les
 *    analyses) et la précédente du même texte est retirée. Seules les pages de VEILLE restent en
 *    relevé `DRAFT` sans effet — ce sont des sommaires de site, pas des textes réglementaires.
 *
 * 2. **L'empreinte décide.** Si le contenu téléchargé a la même empreinte que la version déjà
 *    connue, on ne crée RIEN : pas de doublon, pas de re-découpage, pas de bruit dans le RAG.
 *    Si elle diffère, c'est une NOUVELLE version, qui pointe vers celle qu'elle remplace.
 *
 * Ces fonctions ne lèvent jamais : une source injoignable n'empêche pas d'ingérer les autres.
 */

export interface IngestOneResult {
  code: string;
  ok: boolean;
  /** Le contenu est identique à la version déjà connue : rien n'a été créé. */
  unchanged?: boolean;
  sourceVersionId?: string;
  sections?: number;
  bytes?: number;
  error?: string;
}

/** Version lisible à partir de la date du jour — l'ANPP ne numérote pas toujours ses textes. */
function versionLabel(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Ingère UNE source du catalogue : télécharge, découpe, et crée une version au statut DRAFT.
 * Refuse les sources sous licence — la vérification est faite ici ET dans `fetchSource`,
 * volontairement deux fois : c'est une limite juridique, pas une préférence.
 */
export async function ingestCatalogSource(code: string, userId?: string | null): Promise<IngestOneResult> {
  const cat = findSource(code);
  if (!cat) return { code, ok: false, error: "Source inconnue du catalogue." };
  if (!cat.ingestible) return { code, ok: false, error: "Source sous licence ou page d'index : référencée, jamais ingérée." };

  const fetched = await fetchSource(cat);
  if (!fetched.ok || !fetched.text || !fetched.sha256) {
    return { code, ok: false, error: fetched.error ?? "Téléchargement impossible." };
  }

  try {
    // La source (le « texte », indépendamment de ses versions). `code` n'est pas unique en
    // base (héritage) : on cherche puis on crée, plutôt qu'un upsert sur une clé qui n'existe pas.
    const existing = await prisma.regulatorySource.findFirst({ where: { code }, select: { id: true } });
    const source = existing
      ? await prisma.regulatorySource.update({
          where: { id: existing.id },
          data: { title: cat.title, authority: cat.authority, jurisdiction: cat.jurisdiction, sourceUrl: fetched.finalUrl ?? cat.url },
          select: { id: true },
        })
      : await prisma.regulatorySource.create({
          data: {
            authority: cat.authority, jurisdiction: cat.jurisdiction, code, title: cat.title,
            language: cat.authority === "ANPP" ? "fr" : "en",
            sourceUrl: fetched.finalUrl ?? cat.url, createdById: userId ?? null,
          },
          select: { id: true },
        });

    // Même empreinte que la dernière version connue → rien à faire.
    const latest = await prisma.regulatorySourceVersion.findFirst({
      where: { sourceId: source.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, hash: true },
    });
    if (latest?.hash === fetched.sha256) {
      return { code, ok: true, unchanged: true, sourceVersionId: latest.id, bytes: fetched.bytes };
    }

    // Nouvelle version — ACTIVE d'emblée : l'ingestion est déclenchée par l'administrateur, son
    // geste vaut décision. La version précédente du même texte est retirée juste après.
    const version = await prisma.regulatorySourceVersion.create({
      data: {
        sourceId: source.id,
        version: versionLabel(),
        status: "ACTIVE",
        hash: fetched.sha256,
        originalText: fetched.text.slice(0, 5_000_000),
        supersedesId: latest?.id ?? null,
        publishedAt: new Date(),
        approvedById: userId ?? null,
        approvedAt: new Date(),
      },
      select: { id: true },
    });
    await prisma.regulatorySourceVersion.updateMany({
      where: { sourceId: source.id, status: "ACTIVE", id: { not: version.id } },
      data: { status: "RETIRED" },
    });

    const sections = fetched.sections ?? [];
    if (sections.length > 0) {
      await prisma.regulatorySourceSection.createMany({
        data: sections.map((s) => ({
          sourceVersionId: version.id,
          path: s.path,
          heading: s.heading,
          text: s.text,
          ordinal: s.ordinal,
        })),
      });
    }

    return { code, ok: true, sourceVersionId: version.id, sections: sections.length, bytes: fetched.bytes };
  } catch (e) {
    console.error("[corpus] enregistrement impossible", code, e);
    return { code, ok: false, error: "Enregistrement impossible." };
  }
}

export interface IngestBatchResult {
  results: IngestOneResult[];
  ingested: number;
  unchanged: number;
  failed: number;
}

/**
 * Ingère un ensemble de sources, **une par une et sans se presser** : ces sites sont des
 * services publics, on ne les martèle pas. Une source injoignable n'interrompt jamais les autres.
 */
export async function ingestSources(codes: string[], userId?: string | null, delayMs = 1500): Promise<IngestBatchResult> {
  const results: IngestOneResult[] = [];
  for (const code of codes) {
    results.push(await ingestCatalogSource(code, userId));
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return {
    results,
    ingested: results.filter((r) => r.ok && !r.unchanged).length,
    unchanged: results.filter((r) => r.unchanged).length,
    failed: results.filter((r) => !r.ok).length,
  };
}

// ───────────────────────────── Veille ANPP ─────────────────────────────

export interface WatchFinding {
  code: string;
  title: string;
  url: string;
  ok: boolean;
  /** La page a changé depuis le dernier relevé. */
  changed?: boolean;
  /** Liens de documents repérés sur la page (nouveautés potentielles). */
  documentLinks?: string[];
  error?: string;
}

/**
 * Relève l'état des pages d'index ANPP.
 *
 * Pourquoi cette veille existe : l'ANPP publie et met à jour **sans préavis**. Une ligne
 * directrice qui change sans qu'on le sache, c'est une analyse qui devient fausse en silence —
 * et des réserves qu'on n'aura pas vues venir. On compare donc l'empreinte de la page à celle
 * du dernier relevé, et on SIGNALE. On ne réingère rien automatiquement : c'est à l'équipe de
 * décider ce qui doit entrer dans le corpus.
 */
export async function watchAnppPages(userId?: string | null): Promise<WatchFinding[]> {
  const out: WatchFinding[] = [];

  for (const page of ANPP_WATCH_PAGES) {
    const fetched = await fetchSource({ code: page.code, url: page.url, ingestible: true });
    if (!fetched.ok || !fetched.sha256) {
      out.push({ code: page.code, title: page.title, url: page.url, ok: false, error: fetched.error });
      continue;
    }

    try {
      const source = await prisma.regulatorySource.findFirst({ where: { code: page.code }, select: { id: true } });
      const previous = source
        ? await prisma.regulatorySourceVersion.findFirst({
            where: { sourceId: source.id }, orderBy: { createdAt: "desc" }, select: { hash: true },
          })
        : null;

      const changed = Boolean(previous && previous.hash !== fetched.sha256);

      // On conserve le relevé pour pouvoir comparer la prochaine fois. Statut DRAFT : une page
      // d'index n'est pas un texte opposable, elle ne doit jamais devenir ACTIVE.
      const src = source ?? await prisma.regulatorySource.create({
        data: {
          authority: "ANPP", jurisdiction: "DZ", code: page.code, title: page.title,
          language: "fr", sourceUrl: page.url, createdById: userId ?? null,
        },
        select: { id: true },
      });
      if (!previous || changed) {
        await prisma.regulatorySourceVersion.create({
          data: {
            sourceId: src.id, version: versionLabel(), status: "DRAFT",
            hash: fetched.sha256, originalText: (fetched.text ?? "").slice(0, 1_000_000),
            publishedAt: new Date(),
          },
        });
      }

      out.push({
        code: page.code, title: page.title, url: page.url, ok: true,
        changed: previous ? changed : undefined, // premier relevé : rien à comparer
        documentLinks: extractDocumentLinks(fetched.text ?? ""),
      });
    } catch (e) {
      console.error("[corpus] veille impossible", page.code, e);
      out.push({ code: page.code, title: page.title, url: page.url, ok: false, error: "Relevé impossible." });
    }
  }

  return out;
}

/**
 * Repère, dans le texte d'une page d'index, les intitulés qui ressemblent à des documents
 * réglementaires. Approximatif par nature — c'est une aide à la lecture humaine, pas un
 * inventaire automatique. Fonction PURE, testée.
 */
export function extractDocumentLinks(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.length < 25 || t.length > 220) continue;
    if (/ligne\s+directrice|guide\s|note\s+n|formulaire|arr[êe]t[ée]|d[ée]cision/i.test(t)) out.add(t);
  }
  return [...out].slice(0, 60);
}
