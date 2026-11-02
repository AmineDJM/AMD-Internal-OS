import PizZip from "pizzip";
import ExcelJS from "exceljs";
import pptxgen from "pptxgenjs";
import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { depositBufferToDrive } from "@/lib/assistant/exports";
import { referenceLivrable } from "@/lib/assistant/artifact-ref";
import { resultatVide } from "@/platform/ia/lectures/empty-result";

/**
 * LIVRABLES UNIVERSELS — de VRAIS fichiers Word / Excel / PowerPoint, fabriqués depuis UNE
 * SPEC structurée (titre, sections, tableaux, sources) fournie par l'assistant.
 *
 * La règle de COHÉRENCE INTER-FICHIERS est structurelle : les trois formats se génèrent depuis
 * LA MÊME spec dans le même appel — un chiffre du rapport Word est, par construction, celui du
 * classeur Excel et de la présentation. La spec est CONSERVÉE (AssistantArtifact) : re-générer,
 * décliner dans un autre format ou produire une v2 repart toujours d'elle.
 *
 * Qualité « consulting » imposée par la structure : réponse d'abord (executive summary en
 * première section), FAITS sourcés (section Sources obligatoire dans chaque fichier),
 * estimations marquées par l'auteur de la spec. Pas de mur de texte en PPT : les paragraphes
 * deviennent des puces bornées, l'excédent déborde sur une diapo « (suite) ».
 */

const EXEC = (u: CurrentUser): boolean => u.role === "SUPER_ADMIN" || u.role === "DIRECTION";

const DELIVERABLE_FOLDER = "Livrables IA";

// Palette maison (la même que les présentations de marché — cohérence visuelle).
const NAVY = "0B2545";
const TEAL = "1B7F79";
const LIGHT = "F4F6F8";
const GREY = "5B6470";

export interface DeliverableSection {
  heading: string;
  paragraphs: string[];
  bullets: string[];
  table: { columns: string[]; rows: string[][] } | null;
}

export interface DeliverableSpec {
  title: string;
  subtitle: string | null;
  sections: DeliverableSection[];
  sources: string[];
}

export const DELIVERABLE_FORMATS = ["DOCX", "XLSX", "PPTX"] as const;
export type DeliverableFormat = (typeof DELIVERABLE_FORMATS)[number];

// ─────────────────────────── Validation de la spec ───────────────────────────

const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** La spec vient du MODÈLE : on borne tout (sections, lignes, longueurs) avant de rendre. */
export function parseSpec(input: Record<string, unknown>): DeliverableSpec | { error: string } {
  const title = clean(input.title, 200);
  if (!title) return { error: "Donner un `title` au livrable." };
  const rawSections = Array.isArray(input.sections) ? input.sections.slice(0, 30) : [];
  if (rawSections.length === 0) return { error: "Donner au moins une section (`sections`)." };

  const sections: DeliverableSection[] = [];
  for (const raw of rawSections) {
    if (typeof raw !== "object" || raw === null) continue;
    const s = raw as Record<string, unknown>;
    const heading = clean(s.heading, 160);
    if (!heading) continue;
    const paragraphs = (Array.isArray(s.paragraphs) ? s.paragraphs : []).map((p) => clean(p, 2200)).filter(Boolean).slice(0, 20);
    const bullets = (Array.isArray(s.bullets) ? s.bullets : []).map((b) => clean(b, 400)).filter(Boolean).slice(0, 20);
    let table: DeliverableSection["table"] = null;
    if (typeof s.table === "object" && s.table !== null) {
      const t = s.table as Record<string, unknown>;
      const columns = (Array.isArray(t.columns) ? t.columns : []).map((c) => clean(c, 80)).filter(Boolean).slice(0, 12);
      const rows = (Array.isArray(t.rows) ? t.rows : [])
        .filter((r): r is unknown[] => Array.isArray(r))
        .map((r) => r.map((c) => clean(c, 300)).slice(0, columns.length || 12))
        .slice(0, 200);
      if (columns.length && rows.length) table = { columns, rows };
    }
    if (paragraphs.length || bullets.length || table) sections.push({ heading, paragraphs, bullets, table });
  }
  if (sections.length === 0) return { error: "Aucune section exploitable (chaque section : heading + paragraphs/bullets/table)." };

  const sources = (Array.isArray(input.sources) ? input.sources : []).map((x) => clean(x, 300)).filter(Boolean).slice(0, 40);
  return { title, subtitle: clean(input.subtitle, 300) || null, sections, sources };
}

// ─────────────────────────── Rendu DOCX ───────────────────────────

const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function docxP(text: string, o: { bold?: boolean; italic?: boolean; size?: number; color?: string; before?: number } = {}): string {
  const rpr = [
    o.bold ? "<w:b/>" : "", o.italic ? "<w:i/>" : "",
    o.size ? `<w:sz w:val="${o.size}"/>` : "",
    o.color ? `<w:color w:val="${o.color}"/>` : "",
  ].join("");
  return `<w:p><w:pPr><w:spacing w:before="${o.before ?? 0}" w:after="120"/></w:pPr><w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${escXml(text)}</w:t></w:r></w:p>`;
}

function docxTable(table: NonNullable<DeliverableSection["table"]>): string {
  const cell = (text: string, header: boolean) =>
    `<w:tc><w:tcPr>${header ? `<w:shd w:val="clear" w:fill="${LIGHT}"/>` : ""}</w:tcPr><w:p><w:r><w:rPr>${header ? "<w:b/>" : ""}<w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${escXml(text)}</w:t></w:r></w:p></w:tc>`;
  const row = (cells: string[], header: boolean) => `<w:tr>${cells.map((c) => cell(c, header)).join("")}</w:tr>`;
  const borders = `<w:tblBorders><w:top w:val="single" w:sz="4" w:color="D5DAE0"/><w:bottom w:val="single" w:sz="4" w:color="D5DAE0"/><w:left w:val="single" w:sz="4" w:color="D5DAE0"/><w:right w:val="single" w:sz="4" w:color="D5DAE0"/><w:insideH w:val="single" w:sz="4" w:color="D5DAE0"/><w:insideV w:val="single" w:sz="4" w:color="D5DAE0"/></w:tblBorders>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>${row(table.columns, true)}${table.rows.map((r) => row(r, false)).join("")}</w:tbl><w:p/>`;
}

export function renderDocx(spec: DeliverableSpec, meta: { version: number; generatedAt: Date }): Buffer {
  const date = meta.generatedAt.toISOString().slice(0, 10);
  const parts: string[] = [
    docxP(spec.title, { bold: true, size: 40, color: NAVY }),
    ...(spec.subtitle ? [docxP(spec.subtitle, { italic: true, size: 24, color: GREY })] : []),
    docxP(`Adventum Pharma — ${date} — version ${meta.version}`, { size: 18, color: GREY }),
  ];
  for (const s of spec.sections) {
    parts.push(docxP(s.heading, { bold: true, size: 28, color: TEAL, before: 240 }));
    for (const p of s.paragraphs) parts.push(docxP(p, { size: 22 }));
    for (const b of s.bullets) parts.push(docxP(`• ${b}`, { size: 22 }));
    if (s.table) parts.push(docxTable(s.table));
  }
  parts.push(docxP("Sources", { bold: true, size: 28, color: TEAL, before: 240 }));
  if (spec.sources.length) for (const src of spec.sources) parts.push(docxP(`— ${src}`, { size: 20, color: GREY }));
  else parts.push(docxP("Aucune source citée dans la spec — à compléter avant diffusion.", { italic: true, size: 20, color: GREY }));

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${parts.join("")}<w:sectPr/></w:body></w:document>`;
  const zip = new PizZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.folder("_rels")!.file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.folder("word")!.file("document.xml", xml);
  return zip.generate({ type: "nodebuffer" }) as Buffer;
}

// ─────────────────────────── Rendu XLSX ───────────────────────────

/** Nom d'onglet Excel : ≤ 31 caractères, sans caractères interdits, unique. */
function sheetName(heading: string, used: Set<string>): string {
  let base = heading.replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 28) || "Section";
  let name = base;
  let i = 2;
  while (used.has(name.toLowerCase())) { name = `${base.slice(0, 25)} ${i}`; i += 1; }
  used.add(name.toLowerCase());
  return name;
}

export async function renderXlsx(spec: DeliverableSpec, meta: { version: number; generatedAt: Date }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const used = new Set<string>();

  const synth = wb.addWorksheet(sheetName("Synthèse", used));
  synth.getColumn(1).width = 110;
  synth.addRow([spec.title]).font = { bold: true, size: 16, color: { argb: `FF${NAVY}` } };
  if (spec.subtitle) synth.addRow([spec.subtitle]).font = { italic: true, color: { argb: `FF${GREY}` } };
  synth.addRow([`Adventum Pharma — ${meta.generatedAt.toISOString().slice(0, 10)} — version ${meta.version}`]).font = { size: 9, color: { argb: `FF${GREY}` } };
  synth.addRow([]);
  for (const s of spec.sections) {
    synth.addRow([s.heading]).font = { bold: true, color: { argb: `FF${TEAL}` } };
    for (const p of s.paragraphs) { const r = synth.addRow([p]); r.alignment = { wrapText: true, vertical: "top" }; }
    for (const b of s.bullets) { const r = synth.addRow([`• ${b}`]); r.alignment = { wrapText: true, vertical: "top" }; }
    if (s.table) synth.addRow([`→ chiffres : onglet « ${s.heading.slice(0, 28)} »`]).font = { italic: true, size: 9, color: { argb: `FF${GREY}` } };
    synth.addRow([]);
  }

  for (const s of spec.sections) {
    if (!s.table) continue;
    const ws = wb.addWorksheet(sheetName(s.heading, used), { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = s.table.columns.map((header) => ({ header, width: Math.min(Math.max(header.length + 6, 14), 40) }));
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: "FFFFFFFF" } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${TEAL}` } };
    for (const r of s.table.rows) {
      // Une cellule purement numérique devient un NOMBRE, une date AAAA-MM-JJ une VRAIE date
      // Excel — pour que formules, tris et filtres du lecteur marchent sans retraitement.
      const row = ws.addRow(r.map((c) => {
        const compact = c.replace(/\s/g, "");
        if (/^-?\d+(?:[.,]\d+)?$/.test(compact)) return Number(compact.replace(",", "."));
        if (/^\d{4}-\d{2}-\d{2}$/.test(c.trim())) return new Date(`${c.trim()}T00:00:00Z`);
        return c;
      }));
      row.eachCell((cell) => { if (cell.value instanceof Date) cell.numFmt = "yyyy-mm-dd"; });
    }
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: s.table.columns.length } };
  }

  const src = wb.addWorksheet(sheetName("Sources", used));
  src.getColumn(1).width = 110;
  src.addRow(["Sources"]).font = { bold: true, color: { argb: `FF${TEAL}` } };
  if (spec.sources.length) for (const x of spec.sources) src.addRow([`— ${x}`]);
  else src.addRow(["Aucune source citée dans la spec — à compléter avant diffusion."]).font = { italic: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ─────────────────────────── Rendu PPTX ───────────────────────────

export async function renderPptx(spec: DeliverableSpec, meta: { version: number; generatedAt: Date }): Promise<Buffer> {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Adventum Pharma";
  pptx.company = "Adventum Pharma";
  pptx.title = spec.title;

  const dateStr = meta.generatedAt.toISOString().slice(0, 10);
  const header = (slide: pptxgen.Slide, title: string): void => {
    slide.addShape("rect", { x: 0, y: 0, w: "100%", h: 0.9, fill: { color: NAVY } });
    slide.addShape("rect", { x: 0, y: 0.9, w: "100%", h: 0.06, fill: { color: TEAL } });
    slide.addText(title, { x: 0.5, y: 0.12, w: 12.3, h: 0.66, fontSize: 22, bold: true, color: "FFFFFF", valign: "middle" });
  };

  const t = pptx.addSlide();
  t.background = { color: NAVY };
  t.addText(spec.title, { x: 0.7, y: 2.6, w: 12, h: 1.2, fontSize: 34, bold: true, color: "FFFFFF" });
  if (spec.subtitle) t.addText(spec.subtitle, { x: 0.7, y: 3.8, w: 12, h: 0.7, fontSize: 16, color: "D8DEE6" });
  t.addText(`Adventum Pharma — ${dateStr} — version ${meta.version}`, { x: 0.7, y: 6.7, w: 12, h: 0.4, fontSize: 12, color: "9FB0C0" });

  // PAS DE MUR DE TEXTE : chaque section devient des PUCES bornées (≤ 6 par diapo),
  // l'excédent déborde sur une diapo « (suite) ». Les paragraphes trop longs sont tronqués
  // à la phrase — le détail vit dans le rapport Word, pas sur la diapo.
  const MAX_PER_SLIDE = 6;
  for (const s of spec.sections) {
    const points = [
      ...s.paragraphs.map((p) => (p.length > 260 ? `${p.slice(0, p.lastIndexOf(" ", 250) > 60 ? p.lastIndexOf(" ", 250) : 250)}…` : p)),
      ...s.bullets,
    ];
    const chunks: string[][] = [];
    for (let i = 0; i < points.length; i += MAX_PER_SLIDE) chunks.push(points.slice(i, i + MAX_PER_SLIDE));
    if (chunks.length === 0 && s.table) chunks.push([]);

    chunks.forEach((chunk, idx) => {
      const slide = pptx.addSlide();
      header(slide, idx === 0 ? s.heading : `${s.heading} (suite)`);
      if (chunk.length) {
        slide.addText(
          chunk.map((text) => ({ text, options: { bullet: { indent: 12 }, fontSize: 15, color: "222222", breakLine: true } })),
          { x: 0.6, y: 1.3, w: 12.1, h: 5.6, valign: "top", lineSpacingMultiple: 1.25 },
        );
      }
      // Le tableau accompagne la DERNIÈRE diapo de la section (autoPage gère le débordement).
      if (s.table && idx === chunks.length - 1) {
        const head = s.table.columns.map((h) => ({ text: h, options: { bold: true, color: "FFFFFF", fill: { color: TEAL }, fontSize: 11, valign: "middle" as const } }));
        const body = s.table.rows.slice(0, 40).map((r, i) => r.map((c) => ({ text: c, options: { fill: { color: i % 2 === 0 ? "FFFFFF" : LIGHT }, fontSize: 10, color: "222222" } })));
        slide.addTable([head, ...body], {
          x: 0.5, y: chunk.length ? 3.6 : 1.3, w: 12.3,
          border: { type: "solid", color: "D5DAE0", pt: 0.5 }, autoPage: true, autoPageRepeatHeader: true, newSlideStartY: 1.2,
        });
      }
    });
  }

  const src = pptx.addSlide();
  header(src, "Sources");
  src.addText(
    (spec.sources.length ? spec.sources : ["Aucune source citée dans la spec — à compléter avant diffusion."])
      .map((text) => ({ text, options: { bullet: { indent: 12 }, fontSize: 12, color: GREY, breakLine: true } })),
    { x: 0.6, y: 1.3, w: 12.1, h: 5.6, valign: "top", lineSpacingMultiple: 1.2 },
  );

  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}

// ─────────────────────────── Les outils ───────────────────────────

const MIME: Record<DeliverableFormat, string> = {
  DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  PPTX: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const slug = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "livrable";

const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";

export const DELIVERABLE_TOOLS: PowerTool[] = [
  {
    def: {
      name: "draft_deliverable",
      description:
        "FABRIQUE un VRAI livrable — rapport Word (.docx), classeur Excel (.xlsx) et/ou présentation PowerPoint (.pptx) — depuis " +
        "une spec structurée, et le dépose dans le Drive (« Livrables IA »). `format` : DOCX, XLSX, PPTX ou ALL (les trois, MÊMES " +
        "chiffres garantis : une seule spec). Structure exigée : première section = synthèse « réponse d'abord » ; les CHIFFRES " +
        "vont dans `table` (ils deviennent des nombres dans Excel) ; TOUTE estimation est marquée « ESTIMATION — méthode : … » " +
        "dans le texte ; `sources` liste la provenance de chaque fait (obligatoire avant diffusion). " +
        "Pour METTRE À JOUR un livrable existant (v2, v3…), passer `artifact_id` (via list_artifacts) : la version s'incrémente. " +
        "NE PAS générer sans les données : d'abord lire (search_everything, read_*, corpus), ensuite écrire la spec.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Titre du livrable." },
          subtitle: { type: "string", description: "Sous-titre (contexte, période)." },
          format: { type: "string", enum: ["DOCX", "XLSX", "PPTX", "ALL"], description: "Format(s) à produire. Défaut DOCX." },
          sections: {
            type: "array",
            description: "Les sections, dans l'ordre. Première = synthèse exécutive (la réponse, pas l'historique de la réflexion).",
            items: {
              type: "object",
              properties: {
                heading: { type: "string", description: "Titre de la section." },
                paragraphs: { type: "array", items: { type: "string" }, description: "Prose (Word/Excel ; en PPT, devient des puces bornées)." },
                bullets: { type: "array", items: { type: "string" }, description: "Points courts." },
                table: {
                  type: "object",
                  description: "Les chiffres de la section — colonnes + lignes (cellules texte ; les nombres purs deviennent des nombres dans Excel).",
                  properties: {
                    columns: { type: "array", items: { type: "string" } },
                    rows: { type: "array", items: { type: "array", items: { type: "string" } } },
                  },
                },
              },
              required: ["heading"],
            },
          },
          sources: { type: "array", items: { type: "string" }, description: "Provenance des faits (« ERP — paie de juillet », « corpus — décret n°… », « ESTIMATION — méthode : … »)." },
          artifact_id: { type: "string", description: "Pour une NOUVELLE VERSION d'un livrable existant (via list_artifacts)." },
        },
        required: ["title", "sections"],
      },
    },
    allowed: EXEC,
    label: "Livrable généré (Drive)",
    run: async (input, user) => {
      const parsed = parseSpec(input);
      if ("error" in parsed) return parsed.error;
      const fmtRaw = str(input, "format") || "DOCX";
      const formats: DeliverableFormat[] = fmtRaw === "ALL" ? [...DELIVERABLE_FORMATS] : (DELIVERABLE_FORMATS as readonly string[]).includes(fmtRaw) ? [fmtRaw as DeliverableFormat] : ["DOCX"];

      // Nouvelle version d'un livrable existant — TOUJOURS le sien.
      let version = 1;
      const artifactId = str(input, "artifact_id");
      if (artifactId) {
        const prev = await prisma.assistantArtifact.findFirst({ where: { id: artifactId, ownerId: user.id }, select: { version: true } });
        if (!prev) return "Livrable introuvable dans VOTRE registre (list_artifacts pour retrouver l'identifiant).";
        version = prev.version + 1;
      }

      const generatedAt = new Date();
      const base = slug(parsed.title);
      const files: { format: DeliverableFormat; filename: string; nodeId: string }[] = [];
      for (const format of formats) {
        const data =
          format === "DOCX" ? renderDocx(parsed, { version, generatedAt })
          : format === "XLSX" ? await renderXlsx(parsed, { version, generatedAt })
          : await renderPptx(parsed, { version, generatedAt });
        const filename = `${base}-v${version}.${format.toLowerCase()}`;
        const { nodeId } = await depositBufferToDrive(user.id, {
          folder: DELIVERABLE_FOLDER, filename, data, mime: MIME[format], category: "Livrable IA",
        });
        files.push({ format, filename, nodeId });
      }

      const formatsLabel = formats.join("+");
      const enregistre = artifactId
        ? await prisma.assistantArtifact.update({
          where: { id: artifactId },
          data: { title: parsed.title, formats: formatsLabel, spec: parsed as never, version, files: files as never },
          select: { id: true, title: true, version: true, formats: true, files: true },
        })
        : await prisma.assistantArtifact.create({
          data: { ownerId: user.id, title: parsed.title, formats: formatsLabel, spec: parsed as never, version, files: files as never },
          select: { id: true, title: true, version: true, formats: true, files: true },
        });
      await recordAudit({ actorId: user.id, action: "CREATE", module: "Assistant IA", summary: `Livrable « ${parsed.title} » v${version} (${formatsLabel}) généré dans le Drive` });

      /**
       * ── L'IDENTITÉ EST PUBLIÉE PAR CELUI QUI LA CRÉE ────────────────────────────────
       *
       * Cette réponse ne portait NI `artifact_id`, NI les `driveNodeId` en clair : l'étape qui
       * venait de fabriquer le document ne pouvait pas dire lequel, et la suivante devait
       * découper une URL pour le relire. `referenceLivrable` est la même construction que celle
       * de `list_artifacts` — les deux publient littéralement le même objet.
       *
       * TÉLÉCHARGEABLE ICI : `telechargement` est le lien DIRECT du fichier (mêmes ACL que le
       * Drive) — le donner quand le fichier est demandé « ici », en plus du lien Drive. Ne
       * JAMAIS répondre « disponible dans le Drive » seul.
       */
      return JSON.stringify({
        livrable: parsed.title,
        ...referenceLivrable(enregistre),
        coherence: formats.length > 1 ? "Les formats sortent de LA MÊME spec : chiffres identiques par construction." : undefined,
        sources: parsed.sources.length,
        note: parsed.sources.length === 0 ? "⚠️ Aucune source dans la spec — le fichier le signale ; compléter avant diffusion." : undefined,
        relecture: "Pour relire ce livrable : read_document avec `artifactId` (l'identité stable) "
          + "ou `driveNodeId` (le fichier exact de cette version).",
      });
    },
  },
  {
    def: {
      name: "list_artifacts",
      description:
        "Liste VOS livrables générés (rapports, classeurs, présentations) : titre, version, formats, fichiers et liens Drive. " +
        "À utiliser pour retrouver un livrable (« remets-moi l'étude insuline ») ou obtenir l'`artifact_id` d'une mise à jour.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "Mots du titre (omettre pour les plus récents)." } },
      },
    },
    allowed: EXEC,
    label: "Registre des livrables consulté",
    run: async (input, user) => {
      const q = str(input, "query");
      const rows = await prisma.assistantArtifact.findMany({
        where: { ownerId: user.id, ...(q ? { title: { contains: q, mode: "insensitive" } } : {}) },
        orderBy: { updatedAt: "desc" },
        take: 15,
        select: { id: true, title: true, formats: true, version: true, files: true, updatedAt: true },
      });
      // ZÉRO EST UN COMPTE, PAS UNE PHRASE (`empty-result.ts`) : sans `items`/`count`, une
      // recherche infructueuse ne peut pas servir de preuve d'absence au juge d'objectif.
      if (rows.length === 0) {
        return resultatVide(q ? `Aucun livrable ne mentionne « ${q} ».` : "Aucun livrable généré pour l'instant.");
      }
      const livrables = rows.map((r) => ({ ...referenceLivrable(r), maj: r.updatedAt.toISOString().slice(0, 10) }));
      return JSON.stringify({
        // `items` et `count` sont le contrat machine que `result-contract.ts` vérifie et que
        // `receipt.ts` compte ; `livrables` reste le nom lisible, et pointe sur le même tableau.
        items: livrables,
        count: livrables.length,
        total: rows.length,
        livrables,
        relecture: "Pour relire un livrable : read_document avec son `artifact_id` (identité "
          + "stable, toutes versions) ou le `driveNodeId` d'un fichier précis.",
      });
    },
  },
];
