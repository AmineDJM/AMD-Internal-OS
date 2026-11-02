import PDFDocument from "pdfkit";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC DES DEVIS FABRIQUÉS (lot B1, décision 0049) — des devis algériens RÉALISTES, en PDF.
 *
 * Chaque devis porte ce qu'un vrai devis de fournisseur porte : l'en-tête de l'ÉMETTEUR (logo,
 * RC / NIF / NIS / AI), le bloc du CLIENT (une société du groupe, avec SON NIF — le piège qui a
 * fait imprimer « Fournisseur : ADVENTUM PHARMA » sur un BC), un tableau numéroté sur plusieurs
 * pages avec l'en-tête de colonnes RÉPÉTÉ, des titres de section, des reports de page, des
 * désignations sur deux lignes, les totaux (HT, TVA 19 %, taxe publicitaire 2 %, TTC) et le pied
 * de page de l'émetteur répété. Un devis est rendu en IMAGE seule (un scan) : il n'a aucune couche
 * texte et ne se lit que par la vision.
 *
 * Ce module est la VÉRITÉ du banc : `attendu` dit les lignes, les totaux et le fournisseur que la
 * lecture doit retrouver, au centime. Il ne sert qu'aux tests et au banc réel (`scripts/banc-b1-devis.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface LigneFabriquee {
  n: number;
  designation: string;
  unite: string;
  qte: number;
  pu: number;
}

export interface DevisFabrique {
  fichier: string;
  emetteur: { nom: string; activite: string; adresse: string; rc: string; nif: string; nis: string; ai: string; tel: string; email: string };
  client: { nom: string; adresse: string; nif: string; rc: string };
  numero: string;
  date: string;
  objet: string;
  sections: { titre: string | null; lignes: LigneFabriquee[] }[];
  tvaPct: number;
  taxePubPct: number | null;
  /** Lignes du tableau par page (en-tête de colonnes répété à chaque page). */
  lignesParPage: number;
  /** « 1 234,00 » (espace) ou « 1.234,00 » (point). */
  milliers: " " | ".";
  /** Colonnes : `simple` = N° | Désignation | Qté | PU HT | Montant HT ; `reference` ajoute Réf. et Unité. */
  colonnes: "simple" | "reference";
  /** Reports « À reporter / Report » en bas et en haut de page. */
  reports: boolean;
  /** Rendu en image seule (scan). */
  scan: boolean;
}

export interface AttenduDevis {
  fournisseur: string;
  client: string;
  lignes: { n: number; designation: string; qte: number; pu: number; montant: number }[];
  ht: number;
  tva: number;
  taxe: number;
  ttc: number;
}

const c2 = (n: number) => Math.round(n * 100) / 100;

export function attendu(d: DevisFabrique): AttenduDevis {
  const lignes = d.sections.flatMap((s) => s.lignes).map((l) => ({ n: l.n, designation: l.designation, qte: l.qte, pu: l.pu, montant: c2(l.qte * l.pu) }));
  const ht = c2(lignes.reduce((s, l) => s + l.montant, 0));
  const tva = c2((ht * d.tvaPct) / 100);
  const taxe = d.taxePubPct ? c2((ht * d.taxePubPct) / 100) : 0;
  return { fournisseur: d.emetteur.nom, client: d.client.nom, lignes, ht, tva, taxe, ttc: c2(ht + tva + taxe) };
}

export function montantImprime(n: number, milliers: " " | "." = " "): string {
  const [e, f] = n.toFixed(2).split(".");
  return `${e.replace(/\B(?=(\d{3})+(?!\d))/g, milliers)},${f}`;
}

const ADVENTUM = { nom: "ADVENTUM PHARMA", adresse: "Lot 12, Zone d'activité, Chéraga — Alger", nif: "001616098765432", rc: "16/00-1234567 B 16" };
const PHARMAGENE = { nom: "PHARMAGÈNE SPA", adresse: "Route de Blida, Boufarik", nif: "000909012345678", rc: "09/00-7654321 B 09" };
const AMD = { nom: "AMD LIFE SCIENCES", adresse: "Cité des Asphodèles, Ben Aknoun — Alger", nif: "001916055566677", rc: "16/00-5556667 B 19" };

const L = (n: number, designation: string, qte: number, pu: number, unite = "U"): LigneFabriquee => ({ n, designation, unite, qte, pu });

/**
 * LE DEVIS DE LA DIRECTION (02/11) : INSIGNE, 27 lignes numérotées en 3 blocs, 794 500 DZD HT.
 * Les lignes que la conversation avait (mal) lues y sont : 2. Conception ADV 145 000, 3. Impression
 * ADV 15 000, 9. Visuel de campagne 33 000, 10. 500 fiches posologiques à 225, 14. 3 banners.
 */
export const DEVIS_INSIGNE: DevisFabrique = {
  fichier: "Devis matériel promotionnel INSIGNE.pdf",
  emetteur: {
    nom: "INSIGNE", activite: "Agence de communication — Conception & impression", adresse: "14, rue Didouche Mourad, Alger-Centre",
    rc: "16/00-0987654 B 12", nif: "001216098700412", nis: "001216010203040", ai: "16015432101", tel: "+213 21 63 45 78", email: "contact@insigne.dz",
  },
  client: ADVENTUM,
  numero: "DV-2026/318", date: "28/10/2026", objet: "Matériel promotionnel — lancement ADV",
  sections: [
    { titre: "BLOC 1 — CRÉATION", lignes: [
      L(1, "Brief créatif et plan de communication ADV", 1, 40_000, "Forfait"),
      L(2, "Conception ADV", 1, 145_000, "Forfait"),
      L(3, "Impression ADV", 1, 15_000, "Forfait"),
      L(4, "Déclinaison charte graphique produit", 1, 25_000, "Forfait"),
      L(5, "Shooting packaging et retouches", 1, 30_000, "Forfait"),
      L(6, "Adaptation des visuels au format digital", 4, 5_000),
      L(7, "Rédaction des argumentaires produit", 2, 7_500),
      L(8, "Traduction arabe des supports", 3, 4_000),
      L(9, "Visuel de campagne", 1, 33_000, "Forfait"),
    ] },
    { titre: "BLOC 2 — IMPRESSION", lignes: [
      L(10, "Fiche posologique A5 recto-verso, couché 250 g", 500, 225),
      L(11, "Dépliant 3 volets A4, couché 170 g", 500, 60),
      L(12, "Carte de visite délégué, 350 g pelliculé", 1_000, 12),
      L(13, "Bloc-notes A5 50 feuillets logoté", 200, 150),
      L(14, "Banner roll-up 85 × 200 cm avec housse", 3, 11_000),
      L(15, "Affiche A2 pour officine", 100, 120),
      L(16, "Chemise à rabats A4 pelliculée", 300, 85),
      L(17, "Stickers vitrine officine Ø 20 cm", 400, 30),
      L(18, "Kakémono de comptoir A4", 50, 900),
    ] },
    { titre: "BLOC 3 — OBJETS PROMOTIONNELS", lignes: [
      L(19, "Stylo bille métal gravé ADV", 500, 45),
      L(20, "Clé USB 16 Go logotée", 20, 750),
      L(21, "Mug céramique imprimé", 100, 300),
      L(22, "Sac tissu non-tissé imprimé 1 couleur", 200, 90),
      L(23, "Porte-badge et cordon personnalisé", 100, 70),
      L(24, "Calendrier de bureau 2027", 50, 220),
      L(25, "Tapis de souris imprimé", 50, 110),
      L(26, "Présentoir carton de comptoir", 10, 1_500),
      L(27, "Livraison et mise en place Alger", 1, 23_500, "Forfait"),
    ] },
  ],
  tvaPct: 19, taxePubPct: 2, lignesParPage: 11, milliers: " ", colonnes: "simple", reports: false, scan: false,
};

/** Une imprimerie de Blida, une page, sans section — destinataire Pharmagène. */
export const DEVIS_IMPRIMERIE: DevisFabrique = {
  fichier: "devis_IMP-0457.pdf",
  emetteur: {
    nom: "IMPRIMERIE EL WIAM", activite: "Imprimerie offset et numérique", adresse: "Zone industrielle Ben Boulaïd, Blida",
    rc: "09/00-0456123 A 08", nif: "000809045612309", nis: "000809020304050", ai: "09012345678", tel: "025 41 22 33", email: "devis@elwiam-imprimerie.dz",
  },
  client: PHARMAGENE,
  numero: "IMP-0457", date: "15/10/2026", objet: "Impressions trimestrielles",
  sections: [{ titre: null, lignes: [
    L(1, "Flyers A5 quadri recto-verso 135 g", 5_000, 9),
    L(2, "Brochure 8 pages A4 agrafée", 1_000, 180),
    L(3, "Enveloppes C4 logotées", 2_000, 25),
    L(4, "Papier en-tête A4 80 g", 5_000, 6),
    L(5, "Chemises cartonnées A4", 500, 95),
    L(6, "Cartes de correspondance", 1_000, 18),
    L(7, "Étiquettes autocollantes rouleau", 20, 1_250),
    L(8, "Bon de livraison carboné (carnet de 50)", 40, 450),
  ] }],
  tvaPct: 19, taxePubPct: null, lignesParPage: 20, milliers: ".", colonnes: "simple", reports: false, scan: false,
};

/** Une agence événementielle : 34 lignes sur 3 pages, reports en bas et en haut de page — destinataire AMD Life Sciences. */
export const DEVIS_EVENEMENT: DevisFabrique = {
  fichier: "Devis_Congres_SAC_2026.pdf",
  emetteur: {
    nom: "EVENTIA ORGANISATION", activite: "Organisation d'événements et de congrès", adresse: "Les Pins Maritimes, Mohammadia, Alger",
    rc: "16/00-0333444 B 15", nif: "001516033344455", nis: "001516066677788", ai: "16044455566", tel: "023 80 11 22", email: "commercial@eventia.dz",
  },
  client: AMD,
  numero: "EV-26-0912", date: "22/10/2026", objet: "Stand et logistique — Congrès SAC 2026",
  sections: [
    { titre: "Stand", lignes: Array.from({ length: 12 }, (_, i) => L(i + 1, ["Surface nue 18 m²", "Moquette et pose", "Cloisons bois peintes", "Comptoir d'accueil logoté", "Écran 55 pouces (3 jours)", "Éclairage spots LED", "Mobilier lounge", "Réfrigérateur vitré", "Habillage graphique du stand", "Montage", "Démontage", "Électricité 6 kW"][i], [1, 18, 6, 1, 1, 8, 1, 1, 1, 1, 1, 1][i], [180_000, 1_200, 9_500, 45_000, 36_000, 2_500, 60_000, 15_000, 85_000, 40_000, 25_000, 18_000][i])) },
    { titre: "Restauration", lignes: Array.from({ length: 10 }, (_, i) => L(i + 13, ["Pause-café matin", "Pause-café après-midi", "Déjeuner assis", "Eau minérale 50 cl", "Jus frais", "Viennoiseries", "Hôtesse café", "Vaisselle et nappage", "Cocktail dînatoire", "Gâteau traditionnel"][i], [150, 150, 80, 600, 300, 300, 3, 1, 100, 200][i], [450, 450, 2_800, 40, 120, 90, 9_000, 12_000, 3_500, 150][i])) },
    { titre: "Logistique", lignes: Array.from({ length: 12 }, (_, i) => L(i + 23, ["Transport du matériel", "Navette aéroport", "Hôtesses d'accueil", "Badges imprimés", "Tours de cou", "Sacs congressistes", "Impression programme", "Photographe", "Vidéo résumé", "Assurance événement", "Nettoyage du stand", "Frais de coordination"][i], [1, 6, 4, 400, 400, 400, 400, 1, 1, 1, 3, 1][i], [30_000, 8_000, 12_000, 60, 35, 180, 75, 40_000, 65_000, 15_000, 4_000, 50_000][i])) },
  ],
  tvaPct: 19, taxePubPct: null, lignesParPage: 14, milliers: " ", colonnes: "simple", reports: true, scan: false,
};

/** Un fournisseur d'objets : colonnes Réf. et Unité, désignations sur deux lignes — destinataire Adventum. */
export const DEVIS_OBJETS: DevisFabrique = {
  fichier: "Proforma GOODIES DZ 2026-77.pdf",
  emetteur: {
    nom: "GOODIES DZ SARL", activite: "Objets publicitaires et textile personnalisé", adresse: "Cité 1200 logements, Bab Ezzouar",
    rc: "16/00-0777888 B 17", nif: "001716077788899", nis: "001716099911122", ai: "16077788899", tel: "0550 12 34 56", email: "ventes@goodies-dz.com",
  },
  client: ADVENTUM,
  numero: "PF-2026-77", date: "30/10/2026", objet: "Objets promotionnels congrès",
  sections: [{ titre: null, lignes: [
    L(1, "Polo piqué 220 g brodé cœur et dos, coloris marine, tailles S à XXL assorties", 120, 1_450, "Pièce"),
    L(2, "Casquette 5 panneaux brodée logo ADVENTUM", 200, 520, "Pièce"),
    L(3, "Gourde isotherme inox 500 ml gravée laser, livrée en boîte individuelle", 150, 1_100, "Pièce"),
    L(4, "Carnet A5 couverture rigide, élastique, marquage à chaud", 300, 380, "Pièce"),
    L(5, "Parapluie golf automatique", 80, 1_900, "Pièce"),
    L(6, "Power bank 10 000 mAh logotée", 60, 2_600, "Pièce"),
    L(7, "Trousse congressiste zippée", 250, 340, "Pièce"),
  ] }],
  tvaPct: 19, taxePubPct: 2, lignesParPage: 20, milliers: " ", colonnes: "reference", reports: false, scan: false,
};

/** Le même genre de devis, mais SCANNÉ : aucune couche texte. Destinataire Pharmagène. */
export const DEVIS_SCAN: DevisFabrique = {
  fichier: "scan_devis_signaletique.pdf",
  emetteur: {
    nom: "SIGNA PLUS", activite: "Signalétique et enseignes", adresse: "Route nationale 5, Rouiba",
    rc: "16/00-0222111 A 10", nif: "001016022211133", nis: "001016044455566", ai: "16022211133", tel: "023 85 66 77", email: "signaplus@gmail.com",
  },
  client: PHARMAGENE,
  numero: "SP-1145", date: "05/10/2026", objet: "Signalétique du siège",
  sections: [{ titre: null, lignes: [
    L(1, "Enseigne lumineuse caisson 3 × 0,8 m", 1, 185_000),
    L(2, "Plaque PVC 30 × 20 cm bureaux", 24, 1_800),
    L(3, "Vitrophanie dépolie salle de réunion", 12, 3_200),
    L(4, "Totem d'accueil aluminium", 1, 68_000),
    L(5, "Pose et fixation", 1, 22_000),
  ] }],
  tvaPct: 19, taxePubPct: null, lignesParPage: 20, milliers: " ", colonnes: "simple", reports: false, scan: true,
};

export const BANC_DEVIS: readonly DevisFabrique[] = [DEVIS_INSIGNE, DEVIS_IMPRIMERIE, DEVIS_EVENEMENT, DEVIS_OBJETS, DEVIS_SCAN];

// ─────────────────────────────── Le rendu PDF ───────────────────────────────

type Rangee = { kind: "titre"; texte: string } | { kind: "ligne"; l: LigneFabriquee };

function rangees(d: DevisFabrique): Rangee[] {
  return d.sections.flatMap((s) => [...(s.titre ? [{ kind: "titre" as const, texte: s.titre }] : []), ...s.lignes.map((l) => ({ kind: "ligne" as const, l }))]);
}

function enOctets(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const morceaux: Buffer[] = [];
    doc.on("data", (b: Buffer) => morceaux.push(b));
    doc.on("end", () => resolve(Buffer.concat(morceaux)));
    doc.on("error", reject);
    doc.end();
  });
}

/** Le PDF du devis, avec sa couche texte (le scan est obtenu ensuite par `scanner`). */
export async function pdfDuDevis(d: DevisFabrique): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 0, info: { Title: `Devis ${d.numero}`, Author: d.emetteur.nom } });
  const M = 40;
  const W = 595 - 2 * M;
  const fmt = (n: number) => montantImprime(n, d.milliers);
  const a = attendu(d);
  const ref = d.colonnes === "reference";
  // Colonnes : x de départ et largeur.
  const cols = ref
    ? { n: [M, 24], ref: [M + 24, 50], des: [M + 74, 190], u: [M + 264, 40], q: [M + 304, 45], pu: [M + 349, 75], mt: [M + 424, 91] }
    : { n: [M, 28], des: [M + 28, 250], q: [M + 278, 55], pu: [M + 333, 85], mt: [M + 418, 97] };
  const toutes = rangees(d);
  const pages: Rangee[][] = [];
  for (let i = 0; i < toutes.length; i += d.lignesParPage) pages.push(toutes.slice(i, i + d.lignesParPage));
  const nbPages = pages.length;
  let cumul = 0;

  const enTete = (page: number) => {
    doc.save().rect(M, M, 70, 42).fill("#1d3557").restore();
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(11).text(d.emetteur.nom.split(" ")[0], M + 4, M + 15, { width: 62, align: "center" });
    doc.fillColor("#000000").font("Helvetica-Bold").fontSize(13).text(d.emetteur.nom, M + 80, M);
    doc.font("Helvetica").fontSize(8).text(d.emetteur.activite, M + 80, M + 16).text(d.emetteur.adresse, M + 80, M + 26).text(`Tél. : ${d.emetteur.tel} — ${d.emetteur.email}`, M + 80, M + 36);
    doc.font("Helvetica-Bold").fontSize(16).text(`DEVIS N° ${d.numero}`, M + 320, M, { width: W - 320, align: "right" });
    doc.font("Helvetica").fontSize(9).text(`Date : ${d.date}`, M + 320, M + 22, { width: W - 320, align: "right" });
    doc.text(`Page ${page}/${nbPages}`, M + 320, M + 34, { width: W - 320, align: "right" });
    if (page === 1) {
      doc.rect(M + 300, M + 56, W - 300, 62).stroke();
      doc.font("Helvetica-Bold").fontSize(9).text("Client :", M + 306, M + 60);
      doc.text(d.client.nom, M + 306, M + 72);
      doc.font("Helvetica").fontSize(8).text(d.client.adresse, M + 306, M + 84, { width: W - 312 });
      doc.text(`NIF : ${d.client.nif}`, M + 306, M + 96).text(`RC : ${d.client.rc}`, M + 306, M + 106);
      doc.font("Helvetica").fontSize(9).text(`Objet : ${d.objet}`, M, M + 64, { width: 290 });
      return M + 130;
    }
    return M + 60;
  };

  const enTeteColonnes = (y: number) => {
    doc.save().rect(M, y, W, 16).fill("#e9ecef").restore();
    doc.fillColor("#000000").font("Helvetica-Bold").fontSize(8);
    const t = (s: string, c: number[], align: "left" | "right" | "center" = "left") => doc.text(s, c[0] + 3, y + 4, { width: c[1] - 6, align });
    t("N°", cols.n, "center");
    if (ref) t("Réf.", (cols as { ref: number[] }).ref);
    t("Désignation", cols.des);
    if (ref) t("Unité", (cols as { u: number[] }).u, "center");
    t("Qté", cols.q, "right"); t("P.U. HT", cols.pu, "right"); t("Montant HT", cols.mt, "right");
    return y + 18;
  };

  const pied = () => {
    doc.font("Helvetica").fontSize(7).fillColor("#444444")
      .text(`${d.emetteur.nom} — RC ${d.emetteur.rc} — NIF ${d.emetteur.nif} — NIS ${d.emetteur.nis} — AI ${d.emetteur.ai}`, M, 800, { width: W, align: "center" })
      .text(`${d.emetteur.adresse} — ${d.emetteur.tel}`, M, 810, { width: W, align: "center" });
    doc.fillColor("#000000");
  };

  pages.forEach((rs, i) => {
    if (i > 0) doc.addPage({ size: "A4", margin: 0 });
    let y = enTeteColonnes(enTete(i + 1));
    if (d.reports && i > 0) {
      doc.font("Helvetica-Oblique").fontSize(8).text("Report", cols.des[0] + 3, y + 2, { width: cols.des[1] - 6 });
      doc.text(fmt(cumul), cols.mt[0] + 3, y + 2, { width: cols.mt[1] - 6, align: "right" });
      y += 14;
    }
    for (const r of rs) {
      if (r.kind === "titre") {
        doc.font("Helvetica-Bold").fontSize(8.5).text(r.texte, cols.des[0] + 3, y + 3, { width: cols.des[1] - 6 });
        y += 16;
        continue;
      }
      const l = r.l;
      const mt = c2(l.qte * l.pu);
      cumul = c2(cumul + mt);
      doc.font("Helvetica").fontSize(8);
      const h = Math.max(14, doc.heightOfString(l.designation, { width: cols.des[1] - 6 }) + 5);
      doc.text(String(l.n), cols.n[0] + 3, y + 3, { width: cols.n[1] - 6, align: "center" });
      if (ref) doc.text(`ART-${String(100 + l.n)}`, (cols as { ref: number[] }).ref[0] + 3, y + 3, { width: 44 });
      doc.text(l.designation, cols.des[0] + 3, y + 3, { width: cols.des[1] - 6 });
      if (ref) doc.text(l.unite, (cols as { u: number[] }).u[0] + 3, y + 3, { width: 34, align: "center" });
      doc.text(fmt(l.qte).replace(/,00$/, ""), cols.q[0] + 3, y + 3, { width: cols.q[1] - 6, align: "right" });
      doc.text(fmt(l.pu), cols.pu[0] + 3, y + 3, { width: cols.pu[1] - 6, align: "right" });
      doc.text(fmt(mt), cols.mt[0] + 3, y + 3, { width: cols.mt[1] - 6, align: "right" });
      doc.moveTo(M, y + h).lineTo(M + W, y + h).lineWidth(0.3).strokeColor("#bbbbbb").stroke().strokeColor("#000000");
      y += h;
    }
    if (d.reports && i < pages.length - 1) {
      doc.font("Helvetica-Oblique").fontSize(8).text("À reporter", cols.des[0] + 3, y + 3, { width: cols.des[1] - 6 });
      doc.text(fmt(cumul), cols.mt[0] + 3, y + 3, { width: cols.mt[1] - 6, align: "right" });
    }
    if (i === pages.length - 1) {
      y += 14;
      const x = M + 300;
      const tot = (lib: string, v: number, gras = false) => {
        doc.font(gras ? "Helvetica-Bold" : "Helvetica").fontSize(9).text(lib, x, y, { width: 120 });
        doc.text(fmt(v), x + 120, y, { width: W - 420, align: "right" });
        y += 14;
      };
      tot("Total HT", a.ht, true);
      tot(`TVA ${d.tvaPct} %`, a.tva);
      if (d.taxePubPct) tot(`Taxe publicitaire ${d.taxePubPct} %`, a.taxe);
      tot("Total TTC", a.ttc, true);
      doc.font("Helvetica").fontSize(8).text(`Arrêté le présent devis à la somme TTC indiquée ci-dessus. Validité de l'offre : 30 jours. Paiement : 50 % à la commande, solde à la livraison.`, M, y + 10, { width: W });
      doc.text("Cachet et signature", M + 360, y + 40);
    }
    pied();
  });
  return enOctets(doc);
}

/** Le SCAN : chaque page rendue en image, remise dans un PDF sans couche texte. */
export async function scanner(pdf: Buffer, dpi = 130): Promise<Buffer> {
  const mupdf = await import("mupdf");
  const src = mupdf.Document.openDocument(new Uint8Array(pdf), "application/pdf");
  const images: Buffer[] = [];
  try {
    for (let i = 0; i < src.countPages(); i++) {
      const page = src.loadPage(i);
      const pix = page.toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceGray, false);
      images.push(Buffer.from(pix.asPNG()));
      pix.destroy?.();
      page.destroy?.();
    }
  } finally {
    src.destroy?.();
  }
  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false });
  for (const img of images) {
    doc.addPage({ size: "A4", margin: 0 });
    doc.image(img, 0, 0, { width: 595, height: 842 });
  }
  return enOctets(doc);
}

/** Le fichier tel qu'il arrive dans la conversation : texte natif, ou scan. */
export async function fichierDuDevis(d: DevisFabrique): Promise<Buffer> {
  const pdf = await pdfDuDevis(d);
  return d.scan ? scanner(pdf) : pdf;
}
