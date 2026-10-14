import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  bornesPeriode, seauxDeLaPeriode, serieComplete, slugDeLAdresse, taux, tauxDeRebond, type Bornes, type ClePeriode,
} from "./audience-calc";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TABLEAU DE BORD DE L'AUDIENCE (Direction, 07/10) — les requêtes. Toutes GROUPÉES en base et
 * bornées à la période : l'écran ne charge jamais les événements un à un. Les calculs (variations,
 * taux, rebond, slugs) sont dans `audience-calc.ts`, PUR et testé.
 *
 * « Visiteurs uniques » compte les empreintes du JOUR (`visitor`) : un visiteur revenu trois jours
 * de suite compte trois fois — c'est le prix de l'absence de cookie, et il est voulu.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const n = (v: unknown): number => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number(v ?? 0) || 0);

export interface Totaux {
  visiteurs: number;
  vues: number;
  visites: number;
  clics: number;
  dureeTotaleMs: number;
  visitesAUnePage: number;
  candidatures: number;
  /** Durée moyenne d'une visite. */
  dureeMoyenneMs: number | null;
  rebond: number | null;
  conversion: number | null;
}

async function totaux(debut: Date, fin: Date): Promise<Totaux> {
  const [[t], [b], candidatures] = await Promise.all([
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT
        count(DISTINCT "visitor") FILTER (WHERE "type" = 'PAGEVIEW') AS visiteurs,
        count(*) FILTER (WHERE "type" = 'PAGEVIEW') AS vues,
        count(DISTINCT coalesce("session", "visitor")) FILTER (WHERE "type" = 'PAGEVIEW') AS visites,
        count(*) FILTER (WHERE "type" = 'CLICK') AS clics,
        coalesce(sum("durationMs") FILTER (WHERE "type" = 'LEAVE'), 0) AS duree
      FROM "SiteAnalyticsEvent" WHERE "at" >= ${debut} AND "at" < ${fin}`,
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT count(*) FILTER (WHERE v.nb = 1) AS une
      FROM (
        SELECT coalesce("session", "visitor") AS s, count(*) AS nb FROM "SiteAnalyticsEvent"
        WHERE "type" = 'PAGEVIEW' AND "at" >= ${debut} AND "at" < ${fin} GROUP BY 1
      ) v`,
    prisma.siteCandidature.count({ where: { soumiseLe: { gte: debut, lt: fin } } }),
  ]);
  const visiteurs = n(t?.visiteurs);
  const visites = n(t?.visites);
  const dureeTotaleMs = n(t?.duree);
  const visitesAUnePage = n(b?.une);
  return {
    visiteurs, vues: n(t?.vues), visites, clics: n(t?.clics), dureeTotaleMs, visitesAUnePage, candidatures,
    dureeMoyenneMs: visites ? dureeTotaleMs / visites : null,
    rebond: tauxDeRebond(visitesAUnePage, visites),
    conversion: taux(candidatures, visiteurs),
  };
}

export interface PointSerie { seau: string; visiteurs: number; vues: number }

async function serie(b: Bornes): Promise<PointSerie[]> {
  const format = b.granularite === "mois" ? "YYYY-MM" : "YYYY-MM-DD";
  const lignes = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT to_char("at" + interval '1 hour', ${format}) AS seau, count(DISTINCT "visitor") AS visiteurs, count(*) AS vues
    FROM "SiteAnalyticsEvent" WHERE "type" = 'PAGEVIEW' AND "at" >= ${b.debut} AND "at" < ${b.fin}
    GROUP BY 1`;
  return serieComplete(
    seauxDeLaPeriode(b),
    lignes.map((l) => ({ seau: String(l.seau), visiteurs: n(l.visiteurs), vues: n(l.vues) })),
    (seau) => ({ seau, visiteurs: 0, vues: 0 }),
  );
}

export interface LignePage { path: string; titre: string | null; vues: number; visiteurs: number; dureeMoyenneMs: number | null }

/** Les pages les plus vues — vues, visiteurs, temps passé. */
async function pages(debut: Date, fin: Date): Promise<LignePage[]> {
  const lignes = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "path",
      max("title") FILTER (WHERE "type" = 'PAGEVIEW') AS titre,
      count(*) FILTER (WHERE "type" = 'PAGEVIEW') AS vues,
      count(DISTINCT "visitor") FILTER (WHERE "type" = 'PAGEVIEW') AS visiteurs,
      coalesce(sum("durationMs") FILTER (WHERE "type" = 'LEAVE'), 0) AS duree
    FROM "SiteAnalyticsEvent"
    WHERE "type" IN ('PAGEVIEW', 'LEAVE') AND "at" >= ${debut} AND "at" < ${fin}
    GROUP BY "path"
    HAVING count(*) FILTER (WHERE "type" = 'PAGEVIEW') > 0
    ORDER BY vues DESC
    LIMIT 15`;
  return lignes.map((l) => {
    const vues = n(l.vues);
    return { path: String(l.path), titre: (l.titre as string | null) ?? null, vues, visiteurs: n(l.visiteurs), dureeMoyenneMs: vues ? n(l.duree) / vues : null };
  });
}

/**
 * UN CLIC « POSTULER » : celui que le script reconnaît de lui-même (`postuler`) ET celui que le site
 * marque par offre (`data-adventum-track="postuler-<poste>"`). L'envoi du formulaire
 * (`postuler-<poste>-envoyer`) est l'étape suivante de l'entonnoir, pas un second clic « Postuler ».
 */
const CLIC_POSTULER = Prisma.sql`("label" = 'postuler' OR ("label" LIKE 'postuler-%' AND "label" NOT LIKE '%-envoyer'))`;

/**
 * Les pages d'un préfixe REGROUPÉES PAR SLUG en base (`/carrieres/x` et `/carrieres/x/postuler`
 * font une offre) — un visiteur des deux pages n'y compte qu'une fois.
 */
async function parSlug(prefixe: "carrieres" | "blog", debut: Date, fin: Date) {
  const motif = `^/(?:[a-z]{2}/)?${prefixe}/([^/]+)`;
  const lignes = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT lower(substring("path" from ${motif})) AS slug,
      max("title") FILTER (WHERE "type" = 'PAGEVIEW') AS titre,
      count(*) FILTER (WHERE "type" = 'PAGEVIEW') AS vues,
      count(DISTINCT "visitor") FILTER (WHERE "type" = 'PAGEVIEW') AS visiteurs,
      coalesce(sum("durationMs") FILTER (WHERE "type" = 'LEAVE'), 0) AS duree,
      count(*) FILTER (WHERE "type" = 'CLICK' AND ${CLIC_POSTULER}) AS postuler
    FROM "SiteAnalyticsEvent"
    WHERE "at" >= ${debut} AND "at" < ${fin} AND "path" ~ ${motif}
    GROUP BY 1
    LIMIT 500`;
  return new Map(lignes.filter((l) => l.slug).map((l) => [String(l.slug), {
    titre: (l.titre as string | null) ?? null, vues: n(l.vues), visiteurs: n(l.visiteurs), duree: n(l.duree), postuler: n(l.postuler),
  }]));
}

export interface Part { cle: string; visiteurs: number; vues: number }

const COLONNES = { source: "source", device: "device", browser: "browser", os: "os", country: "country", campaign: "campaign" } as const;

/** Une répartition des visiteurs par une colonne LISTÉE (jamais un nom venu de la requête). */
async function repartition(colonne: keyof typeof COLONNES, debut: Date, fin: Date, limite: number, defaut: string | null): Promise<Part[]> {
  const col = Prisma.raw(`"${COLONNES[colonne]}"`);
  const filtre = defaut === null ? Prisma.sql`AND ${col} IS NOT NULL` : Prisma.empty;
  const lignes = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT coalesce(${col}, ${defaut ?? ""}) AS cle, count(DISTINCT "visitor") AS visiteurs, count(*) AS vues
    FROM "SiteAnalyticsEvent" WHERE "type" = 'PAGEVIEW' AND "at" >= ${debut} AND "at" < ${fin} ${filtre}
    GROUP BY 1 ORDER BY visiteurs DESC, vues DESC LIMIT ${limite}`;
  return lignes.map((l) => ({ cle: String(l.cle), visiteurs: n(l.visiteurs), vues: n(l.vues) }));
}

export interface Campagne { cle: string; source: string | null; visiteurs: number; vues: number; postuler: number }

async function campagnes(debut: Date, fin: Date): Promise<Campagne[]> {
  const lignes = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "campaign" AS cle, max("source") AS source,
      count(DISTINCT "visitor") FILTER (WHERE "type" = 'PAGEVIEW') AS visiteurs,
      count(*) FILTER (WHERE "type" = 'PAGEVIEW') AS vues,
      count(*) FILTER (WHERE "type" = 'CLICK' AND ${CLIC_POSTULER}) AS postuler
    FROM "SiteAnalyticsEvent" WHERE "campaign" IS NOT NULL AND "at" >= ${debut} AND "at" < ${fin}
    GROUP BY 1 ORDER BY visiteurs DESC LIMIT 15`;
  return lignes.map((l) => ({
    cle: String(l.cle), source: (l.source as string | null) ?? null, visiteurs: n(l.visiteurs), vues: n(l.vues), postuler: n(l.postuler),
  }));
}

export interface Clic { label: string; cible: string | null; clics: number; visiteurs: number }

async function clics(debut: Date, fin: Date) {
  const [parType, elements] = await Promise.all([
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce("label", 'cta') AS label, count(*) AS clics, count(DISTINCT "visitor") AS visiteurs
      FROM "SiteAnalyticsEvent" WHERE "type" = 'CLICK' AND "at" >= ${debut} AND "at" < ${fin}
      GROUP BY 1 ORDER BY clics DESC`,
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce("label", 'cta') AS label, "target" AS cible, count(*) AS clics, count(DISTINCT "visitor") AS visiteurs
      FROM "SiteAnalyticsEvent" WHERE "type" = 'CLICK' AND "at" >= ${debut} AND "at" < ${fin}
      GROUP BY 1, 2 ORDER BY clics DESC LIMIT 15`,
  ]);
  const lire = (l: Record<string, unknown>): Clic => ({
    label: String(l.label), cible: (l.cible as string | null) ?? null, clics: n(l.clics), visiteurs: n(l.visiteurs),
  });
  return { parType: parType.map(lire), elements: elements.map(lire) };
}

export interface LigneOffre {
  cle: string;
  titre: string;
  /** La fiche de l'offre dans l'ERP, si elle en vient. */
  lien: string | null;
  vues: number;
  visiteurs: number;
  postuler: number;
  candidatures: number;
  conversion: number | null;
}

/** LES OFFRES : vues de `/carrieres/<slug>`, clics « Postuler », candidatures reçues — reliées par l'adresse que le site a rendue. */
async function offres(debut: Date, fin: Date): Promise<LigneOffre[]> {
  const [mesures, publications, parOffre] = await Promise.all([
    parSlug("carrieres", debut, fin),
    prisma.sitePublication.findMany({
      where: { kind: "JOB", operation: "PUT" },
      select: { externalId: true, label: true, siteUrl: true, siteSlug: true, confirmedPublished: true },
    }),
    prisma.siteCandidature.groupBy({ by: ["jobPostingId"], where: { soumiseLe: { gte: debut, lt: fin }, jobPostingId: { not: null } }, _count: { _all: true } }),
  ]);
  const titres = new Map(
    (await prisma.jobPosting.findMany({ where: { id: { in: publications.map((p) => p.externalId) } }, select: { id: true, title: true } }))
      .map((j) => [j.id, j.title]),
  );
  const candidaturesDe = new Map(parOffre.map((c) => [c.jobPostingId!, c._count._all]));

  const out: LigneOffre[] = [];
  const vus = new Set<string>();
  for (const p of publications) {
    const slug = (p.siteSlug ?? slugDeLAdresse(p.siteUrl, "carrieres"))?.toLowerCase() ?? null;
    const m = slug ? mesures.get(slug) : undefined;
    const candidatures = candidaturesDe.get(p.externalId) ?? 0;
    if (!m && !candidatures && p.confirmedPublished !== true) continue;
    if (slug) vus.add(slug);
    const visiteurs = m?.visiteurs ?? 0;
    out.push({
      cle: p.externalId, titre: titres.get(p.externalId) ?? p.label, lien: `/site-web/offres/${p.externalId}`,
      vues: m?.vues ?? 0, visiteurs, postuler: m?.postuler ?? 0, candidatures, conversion: taux(candidatures, visiteurs),
    });
  }
  // Les pages d'offres que l'ERP ne connaît pas (saisies dans l'administration du site) restent comptées.
  for (const [slug, m] of mesures) {
    if (vus.has(slug)) continue;
    out.push({
      cle: `site:${slug}`, titre: m.titre ?? `/carrieres/${slug}`, lien: null,
      vues: m.vues, visiteurs: m.visiteurs, postuler: m.postuler, candidatures: 0, conversion: null,
    });
  }
  return out.sort((a, b) => b.vues - a.vues || b.candidatures - a.candidatures).slice(0, 30);
}

export interface LigneArticle { cle: string; titre: string; lien: string | null; vues: number; visiteurs: number; dureeMoyenneMs: number | null }

async function articles(debut: Date, fin: Date): Promise<LigneArticle[]> {
  const [mesures, publications] = await Promise.all([
    parSlug("blog", debut, fin),
    prisma.sitePublication.findMany({ where: { kind: "POST", operation: "PUT" }, select: { externalId: true, label: true, siteUrl: true, siteSlug: true } }),
  ]);
  const articlesErp = await prisma.blogArticle.findMany({
    where: { id: { in: publications.map((p) => p.externalId) } }, select: { id: true, title: true, slug: true },
  });
  const parId = new Map(articlesErp.map((a) => [a.id, a]));
  const erpParSlug = new Map<string, { id: string; titre: string }>();
  for (const p of publications) {
    const a = parId.get(p.externalId);
    const slug = (p.siteSlug ?? a?.slug ?? slugDeLAdresse(p.siteUrl, "blog"))?.toLowerCase();
    if (slug) erpParSlug.set(slug, { id: p.externalId, titre: a?.title ?? p.label });
  }
  return [...mesures.entries()]
    .filter(([, m]) => m.vues > 0)
    .map(([slug, m]) => {
      const erp = erpParSlug.get(slug);
      return {
        cle: slug, titre: erp?.titre ?? m.titre ?? `/blog/${slug}`, lien: erp ? `/site-web/articles/${erp.id}` : null,
        vues: m.vues, visiteurs: m.visiteurs, dureeMoyenneMs: m.vues ? m.duree / m.vues : null,
      };
    })
    .sort((a, b) => b.vues - a.vues)
    .slice(0, 30);
}

export interface TableauAudience {
  periode: ClePeriode;
  bornes: Bornes;
  /** Le site a-t-il JAMAIS envoyé un événement ? */
  dernierEvenement: Date | null;
  courant: Totaux;
  precedent: Totaux;
  serie: PointSerie[];
  pages: LignePage[];
  sources: Part[];
  appareils: Part[];
  navigateurs: Part[];
  systemes: Part[];
  pays: Part[];
  clics: { parType: Clic[]; elements: Clic[] };
  offres: LigneOffre[];
  articles: LigneArticle[];
  campagnes: Campagne[];
}

export async function tableauAudience(periode: ClePeriode, maintenant: Date = new Date()): Promise<TableauAudience> {
  const bornes = bornesPeriode(periode, maintenant);
  const dernier = await prisma.siteAnalyticsEvent.findFirst({ orderBy: { at: "desc" }, select: { at: true } });
  const { debut, fin } = bornes;
  const [courant, precedent, s, p, sources, appareils, navigateurs, systemes, pays, c, o, a, camp] = await Promise.all([
    totaux(debut, fin),
    totaux(bornes.debutPrecedent, bornes.finPrecedent),
    serie(bornes),
    pages(debut, fin),
    repartition("source", debut, fin, 12, "Direct"),
    repartition("device", debut, fin, 6, "Inconnu"),
    repartition("browser", debut, fin, 8, "Autre"),
    repartition("os", debut, fin, 8, "Autre"),
    repartition("country", debut, fin, 10, "Inconnu"),
    clics(debut, fin),
    offres(debut, fin),
    articles(debut, fin),
    campagnes(debut, fin),
  ]);
  return {
    periode, bornes, dernierEvenement: dernier?.at ?? null, courant, precedent, serie: s, pages: p,
    sources, appareils, navigateurs, systemes, pays, clics: c, offres: o, articles: a, campagnes: camp,
  };
}
