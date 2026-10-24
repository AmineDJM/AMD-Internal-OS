import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";

const L = 595.28; // Largeur A4
const H = 841.89; // Hauteur A4
const M = 44;     // Marges
const W = L - 2 * M;

const BLEU_NUIT = "#0F172A";
const BLEU_PRIMARY = "#1E40AF";
const BLEU_ACCENT = "#2563EB";
const BLEU_CLAIR = "#EFF6FF";
const GRIS_FOND = "#F8FAFC";
const GRIS_BORDURE = "#E2E8F0";
const GRIS_TEXTE = "#475569";
const GRIS_CLAIR = "#94A3B8";
const VERT_SUCCES = "#059669";
const VERT_FOND = "#ECFDF5";
const NOIR_ENCRE = "#0F172A";

const clean = (s: string) => s.replace(/[  ]/g, " ").replace(/→/g, "->").replace(/−/g, "-");

function dessinerEntete(doc: PDFKit.PDFDocument, pageNum: number, titrePage: string) {
  // Bande supérieure élégante
  doc.rect(0, 0, L, 5).fill(BLEU_PRIMARY);
  
  // Titre en haut
  doc.fillColor(GRIS_CLAIR).font("Helvetica-Bold").fontSize(8)
    .text(clean("ADVENTUM PHARMA · SYSTÈME D'INFORMATION INTERNE"), M, 24, { width: 350 });
  
  doc.fillColor(GRIS_CLAIR).font("Helvetica").fontSize(8)
    .text(clean(titrePage), L - M - 200, 24, { width: 200, align: "right" });

  doc.strokeColor(GRIS_BORDURE).lineWidth(0.8).moveTo(M, 38).lineTo(L - M, 38).stroke();
}

function dessinerPied(doc: PDFKit.PDFDocument, pageNum: number, totalPages: number) {
  doc.strokeColor(GRIS_BORDURE).lineWidth(0.8).moveTo(M, H - 38).lineTo(L - M, H - 38).stroke();
  
  doc.fillColor(GRIS_CLAIR).font("Helvetica").fontSize(8)
    .text(clean("Adventum Brain — Fiche de présentation produit et spécifications"), M, H - 28, { width: 350 });
  
  doc.fillColor(GRIS_CLAIR).font("Helvetica-Bold").fontSize(8)
    .text(`Page ${pageNum} / ${totalPages}`, L - M - 100, H - 28, { width: 100, align: "right" });
}

function card(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  h: number,
  titre: string,
  desc: string,
  badge?: string,
  badgeColor: string = BLEU_PRIMARY
) {
  // Fond carte
  doc.roundedRect(x, y, w, h, 8).fillAndStroke(GRIS_FOND, GRIS_BORDURE);

  // Badge si présent
  if (badge) {
    const badgeW = 90;
    doc.roundedRect(x + w - badgeW - 10, y + 10, badgeW, 14, 4).fill(badgeColor === VERT_SUCCES ? VERT_FOND : BLEU_CLAIR);
    doc.fillColor(badgeColor).font("Helvetica-Bold").fontSize(7.5)
      .text(clean(badge), x + w - badgeW - 10, y + 13, { width: badgeW, align: "center" });
  }

  // Titre
  doc.fillColor(NOIR_ENCRE).font("Helvetica-Bold").fontSize(10.5)
    .text(clean(titre), x + 12, y + 12, { width: w - (badge ? 115 : 24) });

  // Description
  doc.fillColor(GRIS_TEXTE).font("Helvetica").fontSize(8.5).lineGap(2)
    .text(clean(desc), x + 12, y + 28, { width: w - 24 });
}

async function genererPdf() {
  const outputPath = path.resolve(process.cwd(), "Adventum-Brain-Assistant-IA-Presentation-Client.pdf");
  const doc = new PDFDocument({
    size: "A4",
    margin: 0,
    info: {
      Title: "Adventum Brain — Assistant IA d'Entreprise",
      Author: "Adventum Pharma",
      Subject: "Spécifications et Capacités Métier de l'Assistant IA",
      Keywords: "Adventum, ERP, IA, Réglementaire, Pharma, Algérie",
    },
  });

  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  // ══════════════════════════════════════════════════════════════════════════════
  // PAGE 1 : PRÉSENTATION EXÉCUTIVE & PILIERS FONCTIONNELS
  // ══════════════════════════════════════════════════════════════════════════════
  dessinerEntete(doc, 1, "PRÉSENTATION EXÉCUTIVE");

  // Bannière de titre
  const yHero = 52;
  doc.roundedRect(M, yHero, W, 72, 10).fill(BLEU_NUIT);
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(18)
    .text(clean("ADVENTUM BRAIN"), M + 20, yHero + 14);
  doc.fillColor("#93C5FD").font("Helvetica-Bold").fontSize(10.5)
    .text(clean("Assistant d'Entreprise Intelligent & Pilote Opérationnel ERP"), M + 20, yHero + 36);
  doc.fillColor("#CBD5E1").font("Helvetica").fontSize(8.5)
    .text(clean("Développé pour Adventum Pharma · Connexion en direct PostgreSQL · Déterminisme garanti"), M + 20, yHero + 51);

  // Section 1 : Introduction & Enjeux
  let y = 140;
  doc.fillColor(BLEU_PRIMARY).font("Helvetica-Bold").fontSize(12)
    .text(clean("1. Vision & Architecture Métier"), M, y);
  
  y += 18;
  const texteIntro =
    "Adventum Brain est l'assistant d'intelligence artificielle intégré au cœur du système d'information d'Adventum Pharma. " +
    "Conçu spécifiquement pour le secteur pharmaceutique en Algérie, il connecte l'ensemble des collaborateurs aux données critiques " +
    "de l'entreprise sans jamais inventer d'information, grâce à une boucle agent déterministe avec barrières de confidentialité.";

  doc.fillColor(GRIS_TEXTE).font("Helvetica").fontSize(9).lineGap(3)
    .text(clean(texteIntro), M, y, { width: W, align: "justify" });

  // Section 2 : Les 4 Grands Piliers d'Action
  y += 52;
  doc.fillColor(BLEU_PRIMARY).font("Helvetica-Bold").fontSize(12)
    .text(clean("2. Capacités Opérationnelles & Domaines Clés"), M, y);

  y += 18;
  const colW = (W - 14) / 2;
  const cardH = 76;

  // Carte 1 : Affaires Réglementaires
  card(
    doc,
    M,
    y,
    colW,
    cardH,
    "📁 Affaires Réglementaires & AMM",
    "Consultation immédiate des dossiers d'enregistrement, statuts d'instruction, échéances auprès de l'ANPP et suivi des variations mineures ou majeures.",
    "2 Dossiers Actifs",
    BLEU_PRIMARY
  );

  // Carte 2 : Catalogue Produits
  card(
    doc,
    M + colW + 14,
    y,
    colW,
    cardH,
    "📦 Catalogue Produits & DCI",
    "Exploration des 109 références pharmaceutiques du laboratoire, formes galéniques, dosages et suivi de disponibilité en stock.",
    "98.4% Disponibilité",
    VERT_SUCCES
  );

  y += cardH + 12;

  // Carte 3 : Actions Sécurisées (HITL)
  card(
    doc,
    M,
    y,
    colW,
    cardH,
    "✍️ Actions Human-in-the-Loop",
    "Génération assistée de tâches d'équipe et communications internes. Aucune modification de base n'est appliquée sans validation explicite de l'utilisateur.",
    "Validation Requise",
    BLEU_PRIMARY
  );

  // Carte 4 : Sécurité & Cloisonnement RBAC
  card(
    doc,
    M + colW + 14,
    y,
    colW,
    cardH,
    "🛡️ Sécurité & Confidentialité",
    "Filtrage systématique des données sensibles (salaires masqués) et respect absolu des privilèges (Super Admin, Direction, Réglementaire, Ventes).",
    "Plafond RBAC Actif",
    VERT_SUCCES
  );

  // Section 3 : Tableau des Exemples de Requêtes Réelles
  y += cardH + 20;
  doc.fillColor(BLEU_PRIMARY).font("Helvetica-Bold").fontSize(12)
    .text(clean("3. Exemples d'Interactions Traitées"), M, y);

  y += 18;
  const rowH = 24;
  const tableHeaders = ["Domaine", "Exemple de Demande Utilisateur", "Comportement du Système"];
  const colWidths = [110, 210, 187];

  // Header tableau
  doc.rect(M, y, W, 20).fill(BLEU_CLAIR);
  doc.fillColor(BLEU_PRIMARY).font("Helvetica-Bold").fontSize(8);
  doc.text(clean(tableHeaders[0]), M + 8, y + 6, { width: colWidths[0] });
  doc.text(clean(tableHeaders[1]), M + 8 + colWidths[0], y + 6, { width: colWidths[1] });
  doc.text(clean(tableHeaders[2]), M + 8 + colWidths[0] + colWidths[1], y + 6, { width: colWidths[2] });

  y += 20;

  const rows = [
    ["Réglementaire", "« Quel est le statut du dossier Biocare ? »", "Recherche Postgres, extrait l'étape et résume les pièces."],
    ["Catalogue", "« Résume les formes disponibles au catalogue »", "Agrège les 109 références et liste les dosages exacts."],
    ["Action Sécurisée", "« Crée une tâche urgente pour finaliser le module 3 »", "Prépare la carte d'action HITL avec bouton de confirmation."],
    ["Confidentialité", "« Quel est le salaire de Salim ? »", "Blocage strict RBAC : données financières masquées."],
    ["Télémétrie", "« Check db / statistiques »", "Comptage en direct de la base de données (< 10 ms)."]
  ];

  rows.forEach((r, idx) => {
    const bg = idx % 2 === 0 ? "#FFFFFF" : GRIS_FOND;
    doc.rect(M, y, W, rowH).fillAndStroke(bg, GRIS_BORDURE);
    
    doc.fillColor(NOIR_ENCRE).font("Helvetica-Bold").fontSize(8)
      .text(clean(r[0]), M + 8, y + 7, { width: colWidths[0] - 10 });
    
    doc.fillColor(GRIS_TEXTE).font("Helvetica-Oblique").fontSize(8)
      .text(clean(r[1]), M + 8 + colWidths[0], y + 7, { width: colWidths[1] - 10 });

    doc.fillColor(GRIS_TEXTE).font("Helvetica").fontSize(8)
      .text(clean(r[2]), M + 8 + colWidths[0] + colWidths[1], y + 7, { width: colWidths[2] - 10 });

    y += rowH;
  });

  dessinerPied(doc, 1, 2);

  // ══════════════════════════════════════════════════════════════════════════════
  // PAGE 2 : INTERFACE, DÉPLOIEMENT CLOUD & ENGAGEMENTS DE SÉCURITÉ
  // ══════════════════════════════════════════════════════════════════════════════
  doc.addPage();
  dessinerEntete(doc, 2, "INFRASTRUCTURE & INTERFACE");

  // Section 4 : Interface Utilisateur
  y = 52;
  doc.fillColor(BLEU_PRIMARY).font("Helvetica-Bold").fontSize(12)
    .text(clean("4. Expérience Utilisateur & Design System"), M, y);

  y += 18;
  const descUi =
    "L'interface d'Adventum Brain a été entièrement façonnée selon les Human Interface Guidelines d'Apple (macOS et visionOS). " +
    "Elle allie clarté, sérénité et réactivité maximale :";

  doc.fillColor(GRIS_TEXTE).font("Helvetica").fontSize(9).lineGap(3)
    .text(clean(descUi), M, y, { width: W });

  y += 34;

  const featuresUi = [
    {
      titre: "Apple Glassmorphism",
      detail: "Panneaux en verre dépoli haute définition (backdrop-blur-2xl) préservant la lisibilité des chiffres et indicateurs."
    },
    {
      titre: "Curseur Luminescent Dynamique",
      detail: "Curseur à physique de ressort (spring physics) qui se diffuse en halo d'arrière-plan doux (52px) au survol des cartes."
    },
    {
      titre: "Plein Écran Opérationnel",
      detail: "Disposition sans marges superflues (app-viewport-flush) offrant un confort optimal de travail en session prolongée."
    },
    {
      titre: "Intégration B2B Épurée",
      detail: "Modale d'annonce sobre inspirée des meilleurs outils SaaS (Linear, Stripe) sans artifice superflu ni marketing excessif."
    }
  ];

  featuresUi.forEach(f => {
    doc.roundedRect(M, y, W, 36, 6).fillAndStroke(GRIS_FOND, GRIS_BORDURE);
    doc.fillColor(BLEU_PRIMARY).font("Helvetica-Bold").fontSize(8.5)
      .text(clean(`• ${f.titre}`), M + 12, y + 8, { width: 140 });
    doc.fillColor(GRIS_TEXTE).font("Helvetica").fontSize(8)
      .text(clean(f.detail), M + 155, y + 8, { width: W - 170 });
    y += 42;
  });

  // Section 5 : Moteur Technique & Modèle d'IA
  y += 8;
  doc.fillColor(BLEU_PRIMARY).font("Helvetica-Bold").fontSize(12)
    .text(clean("5. Moteur d'IA & Infrastructure Cloud"), M, y);

  y += 18;
  const techCardsW = (W - 14) / 2;
  const techH = 82;

  card(
    doc,
    M,
    y,
    techCardsW,
    techH,
    "⚡ Modèle Xiaomi MiMo Flash",
    "Propulsé par le cluster haute performance d'Amsterdam. Mode raisonnement lourd désactivé pour des réponses en moins de 3 secondes.",
    "Latence < 3s",
    VERT_SUCCES
  );

  card(
    doc,
    M + techCardsW + 14,
    y,
    techCardsW,
    techH,
    "☁️ Déploiement Cloud Render",
    "Hébergé en conteneur managé sur Render avec base PostgreSQL 4GB dédiée et conteneur documentaire OnlyOffice synchronisé.",
    "Production Active",
    BLEU_PRIMARY
  );

  // Section 6 : Synthèse de Sécurité & Conformité
  y += techH + 20;
  doc.fillColor(BLEU_PRIMARY).font("Helvetica-Bold").fontSize(12)
    .text(clean("6. Synthèse de Conformité & Garanties"), M, y);

  y += 16;
  const securitePoints = [
    "1. Souveraineté des Données : Les requêtes ne stockent aucune donnée confidentielle sur des serveurs tiers d'entraînement.",
    "2. Traçabilité Totale : Chaque proposition d'action (tâche, notification) génère un journal d'audit horodaté avec identité de l'acteur.",
    "3. Résilience Multi-Modèles : Possibilité de bascule transparente entre MiMo Flash, OpenAI, Claude ou Mistral.",
    "4. Alignement Métier : Conçu spécifiquement pour le cadre réglementaire pharmaceutique en vigueur en Algérie."
  ];

  securitePoints.forEach(pt => {
    doc.fillColor(NOIR_ENCRE).font("Helvetica-Bold").fontSize(8)
      .text(clean(pt.split(" : ")[0] + " : "), M + 8, y, { continued: true });
    doc.fillColor(GRIS_TEXTE).font("Helvetica").fontSize(8)
      .text(clean(pt.split(" : ")[1]));
    y += 18;
  });

  // Cadre de signature & validation
  y += 10;
  doc.roundedRect(M, y, W, 48, 6).fillAndStroke(BLEU_CLAIR, BLEU_PRIMARY);
  doc.fillColor(BLEU_PRIMARY).font("Helvetica-Bold").fontSize(8.5)
    .text(clean("VALIDATION TECHNIQUE & DIRECTION"), M + 14, y + 10);
  doc.fillColor(GRIS_TEXTE).font("Helvetica").fontSize(8)
    .text(clean("Système certifié opérationnel · Adventum Pharma · Alger, le 24 Octobre 2026"), M + 14, y + 22);
  doc.fillColor(GRIS_CLAIR).font("Helvetica-Oblique").fontSize(7.5)
    .text(clean("Document officiel généré pour communication client et institutionnelle"), M + 14, y + 33);

  dessinerPied(doc, 2, 2);

  doc.end();

  return new Promise<string>((resolve, reject) => {
    stream.on("finish", () => resolve(outputPath));
    stream.on("error", reject);
  });
}

genererPdf()
  .then(p => {
    console.log("✓ PDF généré avec succès à l'adresse :");
    console.log(p);
  })
  .catch(err => {
    console.error("Erreur génération PDF :", err);
    process.exit(1);
  });
