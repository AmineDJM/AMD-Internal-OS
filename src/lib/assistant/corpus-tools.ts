import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import { searchCorpus, activeCorpusSize } from "@/lib/regulatory/intelligence/corpus/rag";

/**
 * LE CORPUS DE CONNAISSANCE, OUVERT AU CHIEF OF STAFF — la base juridique et réglementaire
 * INTERNE, vérifiée : textes ANPP, droit du travail, droit fiscal, marchés publics… importés
 * et activés par l'administrateur (versionnés, une seule version fait foi par texte).
 *
 * La règle d'HONNÊTETÉ est absolue : si le corpus ne contient pas la réponse, on le DIT —
 * « le corpus interne ne contient pas encore suffisamment de sources vérifiées sur ce sujet » —
 * et on n'invente JAMAIS un article de loi, un numéro de décret ou une obligation. Le corpus
 * se remplit par l'ingestion humaine, pas au hasard depuis Internet.
 */

const OPEN = (u: CurrentUser): boolean =>
  u.role === "SUPER_ADMIN" || u.role === "DIRECTION" || userCan(u, "REGULATORY", "VIEW");

const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";

const EMPTY_CORPUS =
  "Le corpus juridique interne ne contient pas encore suffisamment de sources vérifiées sur ce sujet. " +
  "Je ne vais pas inventer un article de loi ou un décret : la réponse fiable passe par l'import du texte " +
  "officiel dans le corpus (Regulatory → Corpus, réservé à l'administrateur), ou par un juriste.";

export const CORPUS_TOOLS: PowerTool[] = [
  {
    def: {
      name: "search_knowledge_corpus",
      description:
        "Cherche dans le CORPUS DE CONNAISSANCE INTERNE (textes juridiques et réglementaires importés et VÉRIFIÉS : ANPP, " +
        "droit du travail, droit fiscal, marchés publics/PCH, MIPH…). Renvoie les articles/sections pertinents avec leur " +
        "SOURCE EXACTE (texte, version, article). À utiliser pour toute question juridique ou réglementaire (« que dit le " +
        "droit du travail sur la période d'essai ? », « quelles pièces exige l'ANPP ? »). Si le corpus ne couvre pas le " +
        "sujet, l'outil le DIT — ne JAMAIS compléter par une connaissance générale non sourcée sans le signaler.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "La question ou les termes juridiques recherchés." },
          category: { type: "string", description: "Filtrer une catégorie (« Droit du travail », « ANPP », « MIPH », « Droit fiscal », « Marchés publics / PCH »…). Omettre pour tout le corpus." },
          authority: { type: "string", description: "Filtrer une autorité (ANPP, ICH, EMA, INTERNE…)." },
          jurisdiction: { type: "string", description: "Filtrer une juridiction (DZ, EU, INT…)." },
        },
        required: ["query"],
      },
    },
    allowed: OPEN,
    label: "Corpus de connaissance consulté",
    run: async (input, _user) => {
      const query = str(input, "query");
      if (query.length < 3) return "Donnez la question ou les termes recherchés.";
      const category = str(input, "category") || undefined;
      const citations = await searchCorpus(query, {
        category,
        authority: str(input, "authority") || undefined,
        jurisdiction: str(input, "jurisdiction") || undefined,
        limit: 8,
      });
      if (citations.length === 0) {
        const total = await activeCorpusSize();
        const catCount = category
          ? await prisma.regulatorySource.count({ where: { category } })
          : null;
        return `${EMPTY_CORPUS} (${total} section(s) actives au total${category ? ` ; ${catCount} source(s) dans la catégorie « ${category} »` : ""}.)`;
      }
      return JSON.stringify({
        requete: query,
        extraits: citations.map((c) => ({
          texte: c.title,
          reference: c.code,
          article: c.path,
          intitule: c.heading,
          extrait: c.snippet,
          autorite: c.authority,
          juridiction: c.jurisdiction,
          version: c.version,
        })),
        regle: "CITER le texte et l'article exacts dans la réponse (ex. « Article 87 — Code du travail, version … »). " +
          "Ce qui n'est pas dans ces extraits n'est pas couvert par le corpus : le dire, ne pas l'inventer.",
      });
    },
  },
  {
    def: {
      name: "read_corpus_document",
      description:
        "LIT un texte du corpus de connaissance : la liste de ses articles/sections, puis le contenu. `reference` = code ou " +
        "fragment du titre (via search_knowledge_corpus ou list_corpus_sources). `section` (optionnel) = un article précis " +
        "(« Article 87 », « المادة 12 ») pour ne lire que lui. À utiliser après une recherche, pour citer le texte complet.",
      input_schema: {
        type: "object",
        properties: {
          reference: { type: "string", description: "Code ou fragment du titre du texte." },
          section: { type: "string", description: "Article/section précis à lire (fragment du chemin, ex. « Article 87 »)." },
        },
        required: ["reference"],
      },
    },
    allowed: OPEN,
    label: "Texte du corpus lu",
    run: async (input, _user) => {
      const ref = str(input, "reference");
      if (ref.length < 2) return "Donnez le code ou un fragment du titre du texte.";
      const sources = await prisma.regulatorySource.findMany({
        where: {
          OR: [
            { code: { contains: ref, mode: "insensitive" } },
            { title: { contains: ref, mode: "insensitive" } },
          ],
          versions: { some: { status: "ACTIVE" } },
        },
        select: { id: true, code: true, title: true, category: true, language: true, authority: true },
        take: 5,
      });
      if (sources.length === 0) return `Aucun texte ACTIF du corpus ne correspond à « ${ref} » — vérifier avec list_corpus_sources.`;
      if (sources.length > 1) {
        return JSON.stringify({
          ambigu: "Plusieurs textes correspondent — préciser par le code.",
          candidates: sources.map((s) => ({ code: s.code, titre: s.title, categorie: s.category })),
        });
      }

      const version = await prisma.regulatorySourceVersion.findFirst({
        where: { sourceId: sources[0].id, status: "ACTIVE" },
        select: { id: true, version: true },
      });
      if (!version) return "Ce texte n'a plus de version active.";
      const wantedSection = str(input, "section");
      const sections = await prisma.regulatorySourceSection.findMany({
        where: {
          sourceVersionId: version.id,
          ...(wantedSection
            ? {
                OR: [
                  { path: { contains: wantedSection, mode: "insensitive" } },
                  { heading: { contains: wantedSection, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        orderBy: { ordinal: "asc" },
        take: wantedSection ? 6 : 200,
        select: { path: true, heading: true, text: true },
      });
      if (sections.length === 0) {
        return wantedSection
          ? `Aucune section « ${wantedSection} » dans « ${sources[0].title} » — la liste : ${(await prisma.regulatorySourceSection.findMany({ where: { sourceVersionId: version.id }, orderBy: { ordinal: "asc" }, take: 60, select: { path: true } })).map((s) => s.path).join(" ; ")}.`
          : "Ce texte n'a pas de sections découpées.";
      }

      // Sans section précise : la table des matières + le début. Avec : le texte des sections.
      if (!wantedSection) {
        return JSON.stringify({
          texte: sources[0].title,
          reference: sources[0].code,
          version: version.version,
          categorie: sources[0].category,
          langue: sources[0].language,
          articles: sections.map((s) => s.path + (s.heading ? ` — ${s.heading}` : "")),
          note: "Relancer avec `section` pour lire un article précis.",
        });
      }
      let budget = 9_000;
      const contenu: { article: string; texte: string }[] = [];
      for (const s of sections) {
        if (budget <= 0) break;
        const t = s.text.slice(0, Math.min(4_000, budget));
        budget -= t.length;
        contenu.push({ article: s.path + (s.heading ? ` — ${s.heading}` : ""), texte: t });
      }
      return JSON.stringify({
        texte: sources[0].title, reference: sources[0].code, version: version.version,
        sections: contenu,
        regle: "Citer l'article et la version exacte — jamais de paraphrase présentée comme le texte.",
      });
    },
  },
  {
    def: {
      name: "list_corpus_sources",
      description:
        "L'INVENTAIRE du corpus de connaissance : ce qu'il contient PAR CATÉGORIE (Droit du travail, ANPP, MIPH…), avec " +
        "titres, langues et volumes — et donc ce qui MANQUE. À utiliser pour « que couvre notre base juridique ? », " +
        "« a-t-on le code du travail ? », ou avant de répondre « le corpus ne couvre pas ce sujet ».",
      input_schema: {
        type: "object",
        properties: { category: { type: "string", description: "Détail d'une catégorie. Omettre pour l'inventaire global." } },
      },
    },
    allowed: OPEN,
    label: "Inventaire du corpus",
    run: async (input, _user) => {
      const category = str(input, "category");
      const sources = await prisma.regulatorySource.findMany({
        where: {
          versions: { some: { status: "ACTIVE" } },
          ...(category ? { category: { equals: category, mode: "insensitive" } } : {}),
        },
        select: {
          code: true, title: true, category: true, language: true, authority: true, jurisdiction: true,
          versions: { where: { status: "ACTIVE" }, select: { version: true, _count: { select: { sections: true } } }, take: 1 },
        },
        orderBy: { updatedAt: "desc" },
        take: 200,
      });
      if (sources.length === 0) {
        return category
          ? `Le corpus ne contient AUCUNE source active dans la catégorie « ${category} » — c'est un manque à combler par l'import des textes officiels, pas par une réponse inventée.`
          : "Le corpus de connaissance est VIDE (aucune source active). Toute réponse juridique passera par l'import préalable des textes officiels.";
      }
      const byCat = new Map<string, { titre: string; langue: string; sections: number; version: string }[]>();
      for (const s of sources) {
        const cat = s.category ?? "Sans catégorie";
        const v = s.versions[0];
        byCat.set(cat, [
          ...(byCat.get(cat) ?? []),
          { titre: `${s.title} (${s.code})`, langue: s.language, sections: v?._count.sections ?? 0, version: v?.version ?? "?" },
        ]);
      }
      return JSON.stringify({
        sourcesActives: sources.length,
        parCategorie: [...byCat.entries()].map(([cat, items]) => ({
          categorie: cat,
          sources: items.length,
          textes: items.slice(0, 20),
        })),
        note: "Une catégorie ABSENTE de cette liste n'est pas couverte : le dire plutôt que d'improviser.",
      });
    },
  },
];
