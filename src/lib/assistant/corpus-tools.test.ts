import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess } from "@/lib/rbac";
import { executePowerTool } from "./power-tools";
import { splitIntoSections } from "@/lib/regulatory/intelligence/corpus/import";

/**
 * CORPUS DE CONNAISSANCE GÉNÉRALISÉ — les garanties de la mission :
 *   • un texte ARABE se découpe par المادة comme un texte français par Article ;
 *   • la recherche filtre par CATÉGORIE (Droit du travail ≠ ANPP) ;
 *   • corpus vide sur un sujet ⇒ l'outil le DIT, il n'invente pas.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__eaose__${Date.now()}`;
let ceoId = "";

const asUser = (id: string, role: CurrentUser["role"]): CurrentUser => ({
  id, name: "T", email: `${id}@t.dz`, role,
  access: { modules: new Map(), rowGrants: new Map() } as unknown as EffectiveAccess,
  mustChangePassword: false,
});

describe("découpage en sections — français ET arabe", () => {
  it("« المادة 12 » ouvre une section comme « Article 12 »", () => {
    const text = [
      "الباب الأول أحكام عامة",
      "نص تمهيدي للباب الأول يشرح النطاق.",
      "المادة 1 : تحدد هذه المادة موضوع القانون وتطبيقاته على جميع العمال.",
      "المادة 12 : مدة التجربة لا تتجاوز ستة أشهر قابلة للتجديد مرة واحدة.",
      "Article 87 : La période d'essai ne peut excéder six mois.",
    ].join("\n");
    const sections = splitIntoSections(text);
    const paths = sections.map((s) => s.path);
    expect(paths.some((p) => p.includes("المادة 1"))).toBe(true);
    expect(paths.some((p) => p.includes("المادة 12"))).toBe(true);
    expect(paths.some((p) => p.toLowerCase().includes("article 87"))).toBe(true);
    expect(paths.some((p) => p.includes("الباب"))).toBe(true);
  });

  it("« 12.5mg » au début d'une ligne n'est PAS un titre (le \\b latin tient toujours)", () => {
    const sections = splitIntoSections("Article 1 : objet.\n12.5mg de produit par dose, sans autre effet.\nSuite du texte de l'article.");
    // Une seule section (Article 1) — la ligne « 12.5mg » reste du CORPS de texte.
    expect(sections).toHaveLength(1);
    expect(sections[0].text).toContain("12.5mg");
  });
});

suite("outils corpus du Chief of Staff — catégorie, lecture, honnêteté", () => {
  beforeAll(async () => {
    const ceo = await prisma.user.create({ data: { name: `${TAG}ceo`, email: `${TAG}c@t.dz`, passwordHash: "x", role: "DIRECTION" } });
    ceoId = ceo.id;

    // Un texte « Droit du travail » actif, avec ses sections.
    const source = await prisma.regulatorySource.create({
      data: {
        authority: "INTERNE", jurisdiction: "DZ", code: `${TAG}-code-travail`,
        title: `${TAG} Loi 90-11 relative aux relations de travail`, language: "fr", category: "Droit du travail",
      },
    });
    const version = await prisma.regulatorySourceVersion.create({
      data: { sourceId: source.id, version: "1990-04-21", status: "ACTIVE", hash: `${TAG}hash`, originalText: "…" },
    });
    await prisma.regulatorySourceSection.createMany({
      data: [
        { sourceVersionId: version.id, path: "Article 18", heading: "Période d'essai", text: `${TAG} La période d'essai est fixée par convention et ne peut excéder six mois pour les postes de haute qualification.`, ordinal: 1 },
        { sourceVersionId: version.id, path: "Article 87", heading: "Salaire", text: `${TAG} Le salaire national minimum garanti est fixé par voie réglementaire.`, ordinal: 2 },
      ],
    });
  });

  afterAll(async () => {
    const src = await prisma.regulatorySource.findMany({ where: { code: { startsWith: TAG } }, select: { id: true } });
    await prisma.regulatorySource.deleteMany({ where: { id: { in: src.map((s) => s.id) } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("search_knowledge_corpus filtre par catégorie et rend l'article AVEC sa source", async () => {
    const r = await executePowerTool("search_knowledge_corpus", { query: `${TAG} période essai`, category: "Droit du travail" }, asUser(ceoId, "DIRECTION"));
    expect(r).toContain("Article 18");
    expect(r).toContain("Loi 90-11");
    // La même recherche dans une AUTRE catégorie ne trouve rien — et le DIT.
    const other = await executePowerTool("search_knowledge_corpus", { query: `${TAG} période essai`, category: "Droit fiscal" }, asUser(ceoId, "DIRECTION"));
    expect(other).toMatch(/pas encore suffisamment de sources vérifiées/i);
    expect(other).toMatch(/ne vais pas inventer/i);
  });

  it("read_corpus_document : table des matières, puis l'article précis", async () => {
    const toc = await executePowerTool("read_corpus_document", { reference: `${TAG}-code-travail` }, asUser(ceoId, "DIRECTION"));
    expect(toc).toContain("Article 18");
    expect(toc).toContain("Article 87");
    const art = await executePowerTool("read_corpus_document", { reference: `${TAG}-code-travail`, section: "Article 87" }, asUser(ceoId, "DIRECTION"));
    expect(art).toContain("salaire national minimum");
    expect(art).toMatch(/version/i);
  });

  it("list_corpus_sources inventorie par catégorie — et nomme le manque", async () => {
    const inv = await executePowerTool("list_corpus_sources", { category: "Droit du travail" }, asUser(ceoId, "DIRECTION"));
    expect(inv).toContain("Loi 90-11");
    const missing = await executePowerTool("list_corpus_sources", { category: `${TAG}-categorie-inexistante` }, asUser(ceoId, "DIRECTION"));
    expect(missing).toMatch(/AUCUNE source active/i);
  });

  it("le corpus reste fermé aux comptes sans droit Regulatory ni siège exécutif", async () => {
    const bare = asUser(ceoId, "DELEGATE" as CurrentUser["role"]);
    const r = await executePowerTool("search_knowledge_corpus", { query: "essai" }, bare);
    expect(r).toMatch(/ne vous est pas ouvert/i);
  });
});
