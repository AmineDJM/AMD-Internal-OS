import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prisma } from "@/lib/prisma";
import { htmlToText } from "./fetch-source";
import { splitIntoSections } from "./import";
import { searchCorpus } from "./rag";
import { ExtraitCitation } from "@/app/(app)/admin/regulatory-corpus/extrait-citation";

/**
 * FLUX (audit sécurité, XSS stockée) : une page de régulateur piégée est ingérée comme le fait la
 * veille (`htmlToText` → `splitIntoSections` → sections en base), activée, puis cherchée depuis
 * l'écran d'administration du corpus. Rien de ce qui est rendu ne doit être du HTML actif.
 * Le second cas couvre les données d'AVANT le correctif : une section stockée avec une vraie balise.
 */
const TAG = `test-xss-corpus-${Date.now()}`;
let sourceId = "";

const PAGE_PIEGEE = `
  <html><body>
  <p>Article 12 : Les études de pharmacovigilancexss doivent être transmises.
  &lt;img src=x onerror=alert(document.cookie)&gt; La pharmacovigilancexss couvre la durée de vie du produit.</p>
  <script>alert("script de page")</script>
  <p>&lt;script&gt;alert(1)&lt;/script&gt; Suite du texte sur la pharmacovigilancexss et ses obligations déclaratives.
  ${"Texte réglementaire de remplissage pour atteindre une longueur réaliste. ".repeat(10)}</p>
  </body></html>`;

function rendu(snippet: string, segments?: { texte: string; fort: boolean }[]): string {
  return renderToStaticMarkup(React.createElement(ExtraitCitation, { c: { snippet, segments } }));
}

describe("corpus réglementaire — une page piégée ingérée puis cherchée ne rend aucun HTML actif", () => {
  beforeAll(async () => {
    const src = await prisma.regulatorySource.create({ data: { authority: "ANPP", jurisdiction: "DZ", code: `${TAG}-code`, title: "Test XSS" }, select: { id: true } });
    sourceId = src.id;
    const v = await prisma.regulatorySourceVersion.create({ data: { sourceId, version: "1.0", status: "ACTIVE" }, select: { id: true } });
    const sections = splitIntoSections(htmlToText(PAGE_PIEGEE));
    await prisma.regulatorySourceSection.createMany({ data: sections.map((s) => ({ sourceVersionId: v.id, path: s.path, heading: s.heading, text: s.text, ordinal: s.ordinal })) });
    // Donnée d'avant le correctif : balise réelle déjà en base.
    await prisma.regulatorySourceSection.create({
      data: { sourceVersionId: v.id, path: "art. 99", heading: null, ordinal: 99, text: `Ancienne ingestion <img src=x onerror=alert(2)> de la pharmacovigilancexss <script>alert(3)</script> en base.` },
    });
  });

  afterAll(async () => {
    await prisma.regulatorySource.deleteMany({ where: { id: sourceId } }).catch(() => undefined);
  });

  it("le texte stocké à l'ingestion ne contient aucune balise", async () => {
    const rows = await prisma.regulatorySourceSection.findMany({ where: { sourceVersion: { sourceId }, ordinal: { lt: 99 } }, select: { text: true } });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.text).not.toMatch(/<[a-zA-Z!/?]/);
  });

  it("la recherche surligne par segments ; le rendu n'a ni <img>, ni <script>, ni attribut on…", async () => {
    const hits = (await searchCorpus("pharmacovigilancexss")).filter((h) => h.sourceId === sourceId);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    for (const h of hits) {
      expect(h.snippet).not.toMatch(/[\u0002\u0003]/);
      expect(h.segments?.some((s) => s.fort)).toBe(true);
      const html = rendu(h.snippet, h.segments);
      expect(html).not.toMatch(/<(img|script|svg|iframe|b)[\s>]/i);
      expect(html).not.toMatch(/<[^>]*\son\w+=/i);
      expect(html).toContain("<mark");
    }
    // La section d'avant le correctif garde sa balise en TEXTE : affichée échappée, jamais active.
    const ancienne = hits.find((h) => h.path === "art. 99");
    expect(ancienne).toBeTruthy();
  });

  it("repli trigramme (sans surlignage) : l'extrait brut reste du texte échappé", () => {
    const html = rendu("Ancienne ingestion <img src=x onerror=alert(2)>");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    expect(html).not.toMatch(/<img/i);
  });
});
