import PDFDocument from "pdfkit";
import { pagesDuPlan, resumeDuPlan, type VisitePdf } from "@/lib/sfe/plan-pdf";
import { MODULE_AUDIT_VISITE } from "@/lib/medical/module-visite";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PLAN DE TOURNÉE VALIDÉ, EN PDF (Direction, 07/10 : « exportable une fois confirmé, en PDF très clean »).
 *
 * A4 paysage, une semaine par page : en-tête de la société et de la validation, le tableau (jours en colonnes, une ligne
 * par visite, la lettre de segmentation en liseré de couleur (le potentiel pour un praticien sans lettre), l'état écrit dans la cellule), le résumé, les signatures, la pagination.
 * La mise en pages vient de `sfe/plan-pdf.ts` (pur, testé) ; ce fichier ne fait que dessiner — Helvetica, qui couvre le
 * français sans police à embarquer.
 *
 * Hors des domaines, à dessein (comme `ordre-mission-depot.ts`) : c'est le seul endroit qui appelle pdfkit pour ce plan.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ENCRE = "#18212F";
const GRIS = "#5B6676";
const TRAIT = "#C9D1DC";
const FOND_ENTETE = "#EEF2F7";
const VERT = "#1E8A5A";
const ROUGE = "#C8323C";

const POTENTIEL: Record<string, { libelle: string; couleur: string }> = {
  VERY_HIGH: { libelle: "Très haut", couleur: "#6D4BD8" },
  HIGH: { libelle: "Haut", couleur: "#1E8A5A" },
  MEDIUM: { libelle: "Moyen", couleur: "#1F6FEB" },
  LOW: { libelle: "Bas", couleur: "#C77A0E" },
  VERY_LOW: { libelle: "Très bas", couleur: "#8A94A3" },
};

/** LES LETTRES DE SEGMENTATION (Direction, 07/10) — le liseré de référence ; le potentiel ne sert qu'aux praticiens sans lettre. */
const LETTRE: Record<string, { libelle: string; couleur: string }> = {
  H: { libelle: "H", couleur: "#6D4BD8" },
  A: { libelle: "A", couleur: "#1E8A5A" },
  B: { libelle: "B", couleur: "#1F6FEB" },
  C: { libelle: "C", couleur: "#C77A0E" },
  D: { libelle: "D", couleur: "#C8323C" },
  NA: { libelle: "NA", couleur: "#8A94A3" },
  NC: { libelle: "non ciblé", couleur: "#8A94A3" },
};

const JOUR = (j: string, o: Intl.DateTimeFormatOptions) => new Date(`${j}T09:00:00`).toLocaleDateString("fr-FR", o);
const date = (d: Date) => d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
const capitale = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface DonneesPlanPdf {
  societe: string;
  kam: string;
  /** « novembre 2026 ». */
  periode: string;
  joursOuvres: string[];
  visites: VisitePdf[];
  /** « Validé le 30/09/2026 par Brahim Rahmoune » — `null` sur un plan qui n'a pas de décision écrite. */
  validation: { le: Date; par: string | null } | null;
  /** Le N+1 qui a validé (signature). */
  valideur: string | null;
  genereLe: Date;
}

export async function rendrePlanTourneePdf(d: DonneesPlanPdf): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 0, info: { Title: `Plan de tournée — ${d.kam} — ${d.periode}`, Author: d.societe } });
  const morceaux: Buffer[] = [];
  doc.on("data", (c: Buffer) => morceaux.push(c));
  const fin = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(morceaux))));

  const L = doc.page.width; // 841.89
  const H = doc.page.height; // 595.28
  const M = 36;
  const pages = pagesDuPlan(d.joursOuvres, d.visites);
  const resume = resumeDuPlan(d.visites);

  pages.forEach((page, iPage) => {
    if (iPage > 0) doc.addPage({ size: "A4", layout: "landscape", margin: 0 });
    const jours = page.semaine.jours;

    // ── EN-TÊTE ───────────────────────────────────────────────────────────────────────────
    doc.fillColor(ENCRE).font("Helvetica-Bold").fontSize(14).text(d.societe.toUpperCase(), M, M, { width: 300, characterSpacing: 0.4 });
    doc.fillColor(GRIS).font("Helvetica").fontSize(8.5).text(MODULE_AUDIT_VISITE, M, M + 18);
    doc.fillColor(ENCRE).font("Helvetica-Bold").fontSize(15).text(`Plan de tournée — ${d.periode}`, M, M - 1, { width: L - 2 * M, align: "right" });
    const premier = jours[0];
    const dernier = jours[jours.length - 1];
    doc.fillColor(GRIS).font("Helvetica").fontSize(9).text(
      `${d.kam} · semaine du ${JOUR(premier, { day: "numeric", month: "long" })} au ${JOUR(dernier, { day: "numeric", month: "long" })}${page.suite ? " (suite)" : ""}`,
      M, M + 19, { width: L - 2 * M, align: "right" },
    );
    if (d.validation) {
      const texte = `Validé le ${date(d.validation.le)}${d.validation.par ? ` par ${d.validation.par}` : ""}`;
      doc.font("Helvetica-Bold").fontSize(8.5);
      const w = doc.widthOfString(texte) + 14;
      doc.roundedRect(L - M - w, M + 33, w, 15, 2).lineWidth(0.8).strokeColor(VERT).stroke();
      doc.fillColor(VERT).text(texte, L - M - w, M + 37, { width: w, align: "center" });
    }
    doc.moveTo(M, M + 56).lineTo(L - M, M + 56).lineWidth(1.6).strokeColor(ENCRE).stroke();

    // ── LE TABLEAU ────────────────────────────────────────────────────────────────────────
    const y0 = M + 70;
    const largeurRang = 26;
    const largeurJour = (L - 2 * M - largeurRang) / Math.max(1, jours.length);
    const hEntete = 30;
    const hLigne = 34;
    const xDe = (i: number) => M + largeurRang + i * largeurJour;

    doc.rect(M, y0, L - 2 * M, hEntete).fill(FOND_ENTETE);
    doc.fillColor(GRIS).font("Helvetica").fontSize(8).text("#", M, y0 + 11, { width: largeurRang, align: "center" });
    jours.forEach((j, i) => {
      doc.fillColor(ENCRE).font("Helvetica-Bold").fontSize(9.5).text(capitale(JOUR(j, { weekday: "long" })), xDe(i) + 7, y0 + 6, { width: largeurJour - 14 });
      doc.fillColor(GRIS).font("Helvetica").fontSize(8).text(JOUR(j, { day: "2-digit", month: "2-digit", year: "numeric" }), xDe(i) + 7, y0 + 17, { width: largeurJour - 14 });
    });

    page.lignes.forEach((ligne, r) => {
      const y = y0 + hEntete + r * hLigne;
      doc.fillColor(GRIS).font("Helvetica").fontSize(8).text(String(page.premierRang + r), M, y + 12, { width: largeurRang, align: "center" });
      ligne.forEach((v, i) => {
        if (!v) return;
        const x = xDe(i);
        const p = v.lettre ? LETTRE[v.lettre] : v.potentiel ? POTENTIEL[v.potentiel] : undefined;
        if (p) doc.rect(x + 0.5, y + 4, 2.2, hLigne - 8).fill(p.couleur);
        const non = v.etat === "NON_TENUE";
        doc.fillColor(non ? GRIS : ENCRE).font("Helvetica-Bold").fontSize(8.6)
          .text(v.nom, x + 8, y + 6, { width: largeurJour - 14, height: 11, ellipsis: true, lineBreak: false, strike: non });
        const etat = v.etat === "FAITE" ? "Visité" : non ? "N'a pas eu lieu" : null;
        const detail = [v.detail, p?.libelle].filter(Boolean).join(" · ");
        doc.fillColor(GRIS).font("Helvetica").fontSize(7.4)
          .text(detail, x + 8, y + 18, { width: largeurJour - 14 - (etat ? 52 : 0), height: 10, ellipsis: true, lineBreak: false });
        if (etat) doc.fillColor(non ? ROUGE : VERT).font("Helvetica-Bold").fontSize(7.2).text(etat, x + largeurJour - 60, y + 18, { width: 54, align: "right", lineBreak: false });
      });
    });

    // Les traits de la grille, par-dessus : lignes, puis colonnes.
    const yFin = y0 + hEntete + page.lignes.length * hLigne;
    doc.lineWidth(0.6).strokeColor(TRAIT);
    doc.rect(M, y0, L - 2 * M, yFin - y0).stroke();
    for (let r = 0; r <= page.lignes.length; r++) doc.moveTo(M, y0 + hEntete + r * hLigne).lineTo(L - M, y0 + hEntete + r * hLigne).stroke();
    doc.moveTo(M + largeurRang, y0).lineTo(M + largeurRang, yFin).stroke();
    jours.forEach((_, i) => { if (i > 0) doc.moveTo(xDe(i), y0).lineTo(xDe(i), yFin).stroke(); });

    // ── RÉSUMÉ, SIGNATURES, PAGINATION ────────────────────────────────────────────────────
    const nbSemaine = page.lignes.flat().filter(Boolean).length;
    const lettres = Object.keys(LETTRE).filter((k) => resume.parLettre.get(k))
      .map((k) => `${resume.parLettre.get(k)} ${LETTRE[k].libelle}`).join(" · ");
    const potentiels = Object.keys(POTENTIEL).filter((k) => resume.parPotentiel.get(k))
      .map((k) => `${resume.parPotentiel.get(k)} ${POTENTIEL[k].libelle.toLowerCase()}`).join(" · ");
    const yResume = Math.min(yFin + 14, H - M - 70);
    doc.fillColor(GRIS).font("Helvetica").fontSize(8.5).text(
      `${nbSemaine} visite${nbSemaine > 1 ? "s" : ""} sur cette page   ·   ${resume.total} sur la période${lettres ? `   ·   Lettres : ${lettres}` : ""}${potentiels ? `   ·   ${lettres ? "Hors segmentation — potentiel" : "Potentiel"} : ${potentiels}` : ""}`,
      M, yResume, { width: L - 2 * M },
    );

    const ySig = H - M - 34;
    const largeurSig = (L - 2 * M - 40) / 3;
    const signature = (x: number, titre: string, nom: string) => {
      doc.moveTo(x, ySig).lineTo(x + largeurSig - 20, ySig).lineWidth(0.6).strokeColor("#9AA5B4").stroke();
      doc.fillColor(ENCRE).font("Helvetica-Bold").fontSize(8.5).text(titre, x, ySig + 5, { width: largeurSig - 20 });
      doc.fillColor(GRIS).font("Helvetica").fontSize(8).text(nom, x, ySig + 16, { width: largeurSig - 20 });
    };
    signature(M, "Le KAM", d.kam);
    signature(M + largeurSig + 20, "Le N+1", d.valideur ? `${d.valideur}${d.validation ? ` — validé le ${date(d.validation.le)}` : ""}` : "—");
    doc.fillColor(GRIS).font("Helvetica").fontSize(7.5).text(
      `Généré le ${date(d.genereLe)} · Page ${iPage + 1} / ${pages.length}`,
      M + 2 * (largeurSig + 20), ySig + 16, { width: largeurSig, align: "right" },
    );
  });

  doc.end();
  return fin;
}
