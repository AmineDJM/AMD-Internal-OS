import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";

const L = 595.28; // Largeur A4
const H = 841.89; // Hauteur A4
const M = 48;     // Marges
const W = L - 2 * M;

// Palette stricte monochrome + haute visibilité (WCAG AAA)
const C_TITLE = "#0F172A";       // Slate 900 (Noir profond lisible)
const C_BODY = "#334155";        // Slate 700 (Gris foncé net)
const C_MUTED = "#64748B";       // Slate 500 (Gris pour métadonnées)
const C_BORDER = "#CBD5E1";      // Slate 300 (Bordure nette)
const C_SURFACE = "#F8FAFC";     // Slate 50 (Fond de boîte)
const C_LINE = "#E2E8F0";        // Slate 200 (Séparateurs)
const C_TAG_BG = "#F1F5F9";      // Slate 100

const clean = (s: string) =>
  s.replace(/[  ]/g, " ")
   .replace(/→/g, "->")
   .replace(/−/g, "-")
   .replace(/—/g, "--");

function drawHeader(doc: PDFKit.PDFDocument, pageNum: number, pageTitle: string) {
  doc.strokeColor(C_LINE).lineWidth(1).moveTo(M, 34).lineTo(L - M, 34).stroke();

  doc.fillColor(C_MUTED).font("Helvetica-Bold").fontSize(7.5)
    .text(clean("ADVENTUM PHARMA -- SYSTEME D'INFORMATION INTERNE"), M, 22, { width: 320 });

  doc.fillColor(C_MUTED).font("Helvetica").fontSize(7.5)
    .text(clean(pageTitle), L - M - 200, 22, { width: 200, align: "right" });
}

function drawFooter(doc: PDFKit.PDFDocument, pageNum: number, totalPages: number) {
  doc.strokeColor(C_LINE).lineWidth(1).moveTo(M, H - 34).lineTo(L - M, H - 34).stroke();

  doc.fillColor(C_MUTED).font("Helvetica").fontSize(8)
    .text(clean("Adventum Brain -- Dossier de specifications fonctionnelles et techniques"), M, H - 24, { width: 350 });

  doc.fillColor(C_MUTED).font("Helvetica").fontSize(8)
    .text(`Page ${pageNum} sur ${totalPages}`, L - M - 100, H - 24, { width: 100, align: "right" });
}

function sectionTitle(doc: PDFKit.PDFDocument, text: string, y: number): number {
  doc.fillColor(C_TITLE).font("Helvetica-Bold").fontSize(10.5)
    .text(clean(text), M, y);
  doc.strokeColor(C_LINE).lineWidth(0.8).moveTo(M, y + 15).lineTo(L - M, y + 15).stroke();
  return y + 24;
}

async function genererPdf() {
  const targetFileName = "Adventum-Brain-Specifications.pdf";
  const outputPath = path.resolve(process.cwd(), targetFileName);
  const publicPath = path.resolve(process.cwd(), "public/docs", targetFileName);

  const doc = new PDFDocument({
    size: "A4",
    margin: 0,
    info: {
      Title: "Adventum Brain -- Specifications Techniques et Fonctionnelles",
      Author: "Adventum Pharma",
      Subject: "Module Assistant ERP Interne",
      Keywords: "Adventum, ERP, Pharma, Algerie, Specifications, RBAC",
    },
  });

  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  // ══════════════════════════════════════════════════════════════════════════════
  // PAGE 1 : CADRAGE FONCTIONNEL & PÉRIMÈTRE MÉTIER
  // ══════════════════════════════════════════════════════════════════════════════
  drawHeader(doc, 1, "SPECIFICATIONS FONCTIONNELLES");

  // En-tête de document
  let y = 50;
  doc.fillColor(C_MUTED).font("Helvetica-Bold").fontSize(7.5)
    .text(clean("DOCUMENTATION TECHNIQUE · MODULE ASSISTANT ERP INTERNE"), M, y);

  y += 13;
  doc.fillColor(C_TITLE).font("Helvetica-Bold").fontSize(16).text(clean("Adventum Brain : Spécifications et Architecture"), M, y);

  y += 22;
  doc.fillColor(C_BODY).font("Helvetica").fontSize(8.5).lineGap(2.5)
    .text(
      clean(
        "Ce document détaille l'architecture, les garanties d'intégrité et le périmètre d'action du module d'assistance interne " +
        "intégré à l'ERP d'Adventum Pharma. Déployé pour l'ensemble des collaborateurs habilités, il permet d'interroger " +
        "les données métier en direct et de préparer des actions sans manipulation SQL ni accès direct aux couches de persistance."
      ),
      M,
      y,
      { width: W, align: "justify" }
    );

  y += 38;
  y = sectionTitle(doc, "1. Périmètre opérationnel et sources de données", y);

  // Grille 2x2 couvrant les 4 modules métier
  const col2W = (W - 10) / 2;
  const col2H = 58;

  const modulesMetier = [
    {
      titre: "Affaires Réglementaires",
      stat: "2 dossiers actifs sous instruction",
      desc: "Suivi des demandes d'AMM, statuts auprès de l'ANPP, calendrier des renouvellements quinquennaux et traçabilité des variations.",
    },
    {
      titre: "Catalogue Médicaments & DCI",
      stat: "109 références actives référencées",
      desc: "Consultation des dénominations communes, formes galéniques, dosages et indicateurs de disponibilité commerciale (98,4 %).",
    },
    {
      titre: "Gestion Opérationnelle & Tâches",
      stat: "Préparation assistée sous validation",
      desc: "Création de tâches de revue réglementaire, assignation par collaborateur, gestion des priorités et suivi d'avancement.",
    },
    {
      titre: "Annuaire Collaborateurs",
      stat: "20 comptes actifs enregistrés",
      desc: "Coordonnées professionnelles, affectations par pôle (Réglementaire, Commercial, Direction) et structure hiérarchique.",
    },
  ];

  modulesMetier.forEach((m, idx) => {
    const colIndex = idx % 2;
    const rowIndex = Math.floor(idx / 2);
    const cx = M + colIndex * (col2W + 10);
    const cy = y + rowIndex * (col2H + 8);

    doc.roundedRect(cx, cy, col2W, col2H, 6).fillAndStroke(C_SURFACE, C_BORDER);

    doc.fillColor(C_TITLE).font("Helvetica-Bold").fontSize(8.5)
      .text(clean(m.titre), cx + 10, cy + 8, { width: col2W - 20 });

    doc.fillColor(C_MUTED).font("Helvetica-Bold").fontSize(7.5)
      .text(clean(m.stat), cx + 10, cy + 20, { width: col2W - 20 });

    doc.fillColor(C_BODY).font("Helvetica").fontSize(7.5).lineGap(1.5)
      .text(clean(m.desc), cx + 10, cy + 32, { width: col2W - 20 });
  });

  y += 2 * (col2H + 8) + 10;
  y = sectionTitle(doc, "2. Protocole d'action déterministe (Human-in-the-Loop)", y);

  doc.fillColor(C_BODY).font("Helvetica").fontSize(8.5).lineGap(2)
    .text(
      clean(
        "Pour prévenir tout risque de corruption de données, le modèle d'inférence n'a aucun droit direct d'écriture en base PostgreSQL. " +
        "Toute modification suit un cycle strict en quatre étapes avec approbation explicite obligatoire :"
      ),
      M,
      y,
      { width: W, align: "justify" }
    );

  y += 28;

  const etapes = [
    { num: "01", titre: "Formulation", desc: "Instruction saisie en langage naturel par l'utilisateur connecté." },
    { num: "02", titre: "Extraction Intent", desc: "Typage strict des paramètres et création d'une intention PROPOSED." },
    { num: "03", titre: "Carte visuelle", desc: "Présentation des champs détaillés dans l'interface pour contrôle." },
    { num: "04", titre: "Validation", desc: "Écriture déclenchée uniquement après validation explicite par clic." },
  ];

  const stepW = (W - 18) / 4;
  etapes.forEach((s, idx) => {
    const sx = M + idx * (stepW + 6);
    doc.roundedRect(sx, y, stepW, 64, 6).fillAndStroke(C_SURFACE, C_BORDER);

    doc.fillColor(C_MUTED).font("Helvetica-Bold").fontSize(8)
      .text(clean(s.num), sx + 8, y + 8);

    doc.fillColor(C_TITLE).font("Helvetica-Bold").fontSize(8)
      .text(clean(s.titre), sx + 8, y + 19, { width: stepW - 16 });

    doc.fillColor(C_BODY).font("Helvetica").fontSize(7.5).lineGap(1.5)
      .text(clean(s.desc), sx + 8, y + 31, { width: stepW - 16 });
  });

  y += 74;
  y = sectionTitle(doc, "3. Matrice d'exemples d'interactions et comportements certifiés", y);

  const tableHeaders = ["Domaine", "Requête type", "Traitement déterministe", "Garantie d'intégrité"];
  const colWidths = [85, 155, 170, 89];
  const rowHeight = 24;

  // Header tableau
  doc.rect(M, y, W, 18).fill(C_TAG_BG);
  doc.fillColor(C_TITLE).font("Helvetica-Bold").fontSize(7.5);
  doc.text(clean(tableHeaders[0]), M + 6, y + 5, { width: colWidths[0] });
  doc.text(clean(tableHeaders[1]), M + 6 + colWidths[0], y + 5, { width: colWidths[1] });
  doc.text(clean(tableHeaders[2]), M + 6 + colWidths[0] + colWidths[1], y + 5, { width: colWidths[2] });
  doc.text(clean(tableHeaders[3]), M + 6 + colWidths[0] + colWidths[1] + colWidths[2], y + 5, { width: colWidths[3] });

  y += 18;

  const rows = [
    ["Réglementaire", "Statut du dossier Biocare", "Extraction de l'étape et pièces jointes réelles", "Zéro hallucination"],
    ["Produits", "Formes galéniques au catalogue", "Agrégation exacte des 109 références actives", "Données synchrones"],
    ["Tâche", "Créer tâche urgente clôture M3", "Génération de la carte d'action sous validation", "Validation requise"],
    ["Annuaire", "Coordonnées pharmacien responsable", "Lookup ciblé dans l'annuaire d'entreprise", "Données certifiées"],
    ["Confidentialité", "Demande de salaire d'un tiers", "Filtrage et rejet strict avant appel modèle", "Conformité RH"],
    ["Télémétrie", "Vérification base de données", "Comptage direct des tables actives PostgreSQL", "Réponse < 10 ms"],
  ];

  rows.forEach((r, idx) => {
    const bg = idx % 2 === 0 ? "#FFFFFF" : C_SURFACE;
    doc.rect(M, y, W, rowHeight).fillAndStroke(bg, C_LINE);

    doc.fillColor(C_TITLE).font("Helvetica-Bold").fontSize(7.5)
      .text(clean(r[0]), M + 6, y + 6, { width: colWidths[0] - 8 });

    doc.fillColor(C_BODY).font("Helvetica").fontSize(7.5)
      .text(clean(r[1]), M + 6 + colWidths[0], y + 6, { width: colWidths[1] - 8 });

    doc.fillColor(C_BODY).font("Helvetica").fontSize(7.5)
      .text(clean(r[2]), M + 6 + colWidths[0] + colWidths[1], y + 6, { width: colWidths[2] - 8 });

    doc.fillColor(C_MUTED).font("Helvetica-Bold").fontSize(7.5)
      .text(clean(r[3]), M + 6 + colWidths[0] + colWidths[1] + colWidths[2], y + 6, { width: colWidths[3] - 8 });

    y += rowHeight;
  });

  // Bloc complémentaire sur la non-invention
  y += 14;
  doc.roundedRect(M, y, W, 46, 6).fillAndStroke(C_SURFACE, C_BORDER);
  doc.fillColor(C_TITLE).font("Helvetica-Bold").fontSize(8)
    .text(clean("ENGAGEMENT TECHNIQUE DE NON-INVENTION (ZERO-HALLUCINATION)"), M + 12, y + 8);
  doc.fillColor(C_BODY).font("Helvetica").fontSize(7.5).lineGap(2)
    .text(
      clean(
        "Toutes les réponses de l'assistant sont ancrées sur les enregistrements réels extraits de l'ERP. En l'absence d'information " +
        "dans la base, le système retourne un état explicite d'indisponibilité de la donnée et s'interdit toute extrapolation."
      ),
      M + 12,
      y + 20,
      { width: W - 24 }
    );

  drawFooter(doc, 1, 2);

  // ══════════════════════════════════════════════════════════════════════════════
  // PAGE 2 : SÉCURITÉ, INFRASTRUCTURE ET VALIDATION
  // ══════════════════════════════════════════════════════════════════════════════
  doc.addPage();
  drawHeader(doc, 2, "INFRASTRUCTURE & SECURITE");

  y = 50;
  y = sectionTitle(doc, "4. Contrôle d'accès basé sur les rôles (RBAC) et confidentialité", y);

  doc.fillColor(C_BODY).font("Helvetica").fontSize(8.5).lineGap(2)
    .text(
      clean(
        "L'assistant applique un plafond strict de privilèges déterminé par le rôle de session de l'utilisateur connecté. " +
        "Le modèle d'IA ne reçoit aucune donnée sortant du périmètre autorisé de l'utilisateur."
      ),
      M,
      y,
      { width: W, align: "justify" }
    );

  y += 26;

  const rbacItems = [
    {
      titre: "Isolation des données RH et financières",
      desc: "Un filtre d'analyse lexicale intercepte en amont toute question relative aux salaires, primes ou coordonnées bancaires. Ces données ne sont jamais transmises au modèle d'inférence.",
    },
    {
      titre: "Plafond d'habilitation par profil",
      desc: "Un délégué médical n'a pas accès aux dossiers d'enregistrement AMM. De même, les fonctions sans droit d'écriture ne peuvent pas déclencher de proposition d'action.",
    },
    {
      titre: "Traçabilité et audit systématique",
      desc: "Chaque action confirmée et exécutée est enregistrée dans la table AuditLog avec horodatage certifié, identifiant de l'auteur et état antérieur/postérieur.",
    },
  ];

  rbacItems.forEach(item => {
    doc.roundedRect(M, y, W, 36, 6).fillAndStroke(C_SURFACE, C_BORDER);

    doc.fillColor(C_TITLE).font("Helvetica-Bold").fontSize(8)
      .text(clean(item.titre), M + 12, y + 7, { width: W - 24 });

    doc.fillColor(C_BODY).font("Helvetica").fontSize(7.5).lineGap(1.5)
      .text(clean(item.desc), M + 12, y + 18, { width: W - 24 });

    y += 42;
  });

  y += 6;
  y = sectionTitle(doc, "5. Matrice des habilitations par rôle utilisateur", y);

  const rbacTableHeaders = ["Rôle utilisateur", "Périmètre autorisé", "Restrictions strictes", "Statut"];
  const rbacColW = [110, 175, 145, 69];
  const rbacRowH = 22;

  doc.rect(M, y, W, 17).fill(C_TAG_BG);
  doc.fillColor(C_TITLE).font("Helvetica-Bold").fontSize(7.5);
  doc.text(clean(rbacTableHeaders[0]), M + 6, y + 5, { width: rbacColW[0] });
  doc.text(clean(rbacTableHeaders[1]), M + 6 + rbacColW[0], y + 5, { width: rbacColW[1] });
  doc.text(clean(rbacTableHeaders[2]), M + 6 + rbacColW[0] + rbacColW[1], y + 5, { width: rbacColW[2] });
  doc.text(clean(rbacTableHeaders[3]), M + 6 + rbacColW[0] + rbacColW[1] + rbacColW[2], y + 5, { width: rbacColW[3] });

  y += 17;

  const rbacRows = [
    ["Super Admin / Direction", "Accès complet, validation globale, télémétrie ERP", "Aucune (sous réserve filtre salaires)", "Certifié"],
    ["Pharmacien Réglementaire", "Dossiers AMM, variations, catalogue DCI, tâches", "Isolation stricte des données RH/salaires", "Certifié"],
    ["Délégué Commercial", "Catalogue produits & DCI, annuaire collaborateurs", "Rejet automatique sur les dossiers AMM", "Certifié"],
  ];

  rbacRows.forEach((r, idx) => {
    const bg = idx % 2 === 0 ? "#FFFFFF" : C_SURFACE;
    doc.rect(M, y, W, rbacRowH).fillAndStroke(bg, C_LINE);

    doc.fillColor(C_TITLE).font("Helvetica-Bold").fontSize(7.5)
      .text(clean(r[0]), M + 6, y + 6, { width: rbacColW[0] - 8 });

    doc.fillColor(C_BODY).font("Helvetica").fontSize(7.5)
      .text(clean(r[1]), M + 6 + rbacColW[0], y + 6, { width: rbacColW[1] - 8 });

    doc.fillColor(C_BODY).font("Helvetica").fontSize(7.5)
      .text(clean(r[2]), M + 6 + rbacColW[0] + rbacColW[1], y + 6, { width: rbacColW[2] - 8 });

    doc.fillColor(C_MUTED).font("Helvetica-Bold").fontSize(7.5)
      .text(clean(r[3]), M + 6 + rbacColW[0] + rbacColW[1] + rbacColW[2], y + 6, { width: rbacColW[3] - 8 });

    y += rbacRowH;
  });

  y += 14;
  y = sectionTitle(doc, "6. Architecture technique et infrastructure d'hébergement", y);

  const colTechW = (W - 12) / 2;
  const colTechH = 108;

  // Box 1 : Moteur Inférence
  doc.roundedRect(M, y, colTechW, colTechH, 6).fillAndStroke(C_SURFACE, C_BORDER);
  doc.fillColor(C_TITLE).font("Helvetica-Bold").fontSize(8.5)
    .text(clean("Moteur d'inférence sécurisé (LLM)"), M + 12, y + 9);
  doc.fillColor(C_BODY).font("Helvetica").fontSize(7.5).lineGap(2)
    .text(
      clean(
        "• Modèle : Moteur d'entreprise dédié haute performance\n" +
        "• Hébergement : Cluster souverain sécurisé aux Pays-Bas (UE)\n" +
        "• Mode d'inférence : Traitement optimisé à faible latence (< 3,5 s)\n" +
        "• Confidentialité : Zéro rétention, aucune donnée réutilisée"
      ),
      M + 12,
      y + 24,
      { width: colTechW - 24 }
    );

  // Box 2 : Infrastructure ERP
  doc.roundedRect(M + colTechW + 12, y, colTechW, colTechH, 6).fillAndStroke(C_SURFACE, C_BORDER);
  doc.fillColor(C_TITLE).font("Helvetica-Bold").fontSize(8.5)
    .text(clean("Infrastructure ERP et base de données"), M + colTechW + 24, y + 9);
  doc.fillColor(C_BODY).font("Helvetica").fontSize(7.5).lineGap(2)
    .text(
      clean(
        "• Serveur applicatif : Node.js 22 LTS sur Render (Francfort)\n" +
        "• Base de données : PostgreSQL 18 managée (amd-postgres-k3uc)\n" +
        "• Serveur documentaire : Conteneur OnlyOffice Document Server\n" +
        "• Déploiement : CI/CD automatisé sous contrôle strict des types"
      ),
      M + colTechW + 24,
      y + 24,
      { width: colTechW - 24 }
    );

  y += colTechH + 14;
  y = sectionTitle(doc, "7. Synthèse des caractéristiques opérationnelles", y);

  const resumeSpecs = [
    ["Disponibilité applicative", "En ligne sur l'ERP (amd-internal-os-k3uc.onrender.com/assistant)"],
    ["Temps moyen de réponse", "Moins de 3,5 s en génération complexe, moins de 10 ms sur requêtes directes"],
    ["Mécanisme d'écriture", "Human-in-the-Loop strict (approbation obligatoire de l'utilisateur)"],
    ["Conformité réglementaire", "Aligné sur les exigences de traçabilité pharmaceutique en Algérie"],
    ["Intégrité des données", "37 tests automatisés validés, 20 scénarios d'évaluation certifiés conformes"],
  ];

  const specColW = [160, W - 160];
  const specH = 18;

  resumeSpecs.forEach((spec, idx) => {
    const bg = idx % 2 === 0 ? "#FFFFFF" : C_SURFACE;
    doc.rect(M, y, W, specH).fillAndStroke(bg, C_LINE);

    doc.fillColor(C_TITLE).font("Helvetica-Bold").fontSize(7.5)
      .text(clean(spec[0]), M + 8, y + 5, { width: specColW[0] - 12 });

    doc.fillColor(C_BODY).font("Helvetica").fontSize(7.5)
      .text(clean(spec[1]), M + 8 + specColW[0], y + 5, { width: specColW[1] - 12 });

    y += specH;
  });

  // Bloc de validation / Signatures formelles
  y += 14;
  doc.roundedRect(M, y, W, 48, 6).fillAndStroke(C_SURFACE, C_BORDER);
  doc.fillColor(C_TITLE).font("Helvetica-Bold").fontSize(8)
    .text(clean("VALIDATION TECHNIQUE ET DIRECTION GENERALE"), M + 12, y + 8);
  doc.fillColor(C_BODY).font("Helvetica").fontSize(7.5)
    .text(clean("Document établi pour communication client et audit interne -- Adventum Pharma, Alger, Octobre 2026."), M + 12, y + 20);
  doc.fillColor(C_MUTED).font("Helvetica").fontSize(7)
    .text(clean("Version 2.4 · Référence interne AMD-SPEC-BRAIN-2026-10 · Tous droits réservés."), M + 12, y + 32);

  drawFooter(doc, 2, 2);

  doc.end();

  return new Promise<string>((resolve, reject) => {
    stream.on("finish", () => {
      try {
        fs.mkdirSync(path.dirname(publicPath), { recursive: true });
        fs.copyFileSync(outputPath, publicPath);
      } catch (e) {}
      resolve(outputPath);
    });
    stream.on("error", reject);
  });
}

genererPdf()
  .then(p => {
    console.log("PDF regenere sans slop et avec contraste maximal :");
    console.log(p);
  })
  .catch(err => {
    console.error("Erreur generation PDF :", err);
    process.exit(1);
  });
