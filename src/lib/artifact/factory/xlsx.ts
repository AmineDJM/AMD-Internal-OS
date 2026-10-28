import ExcelJS from "exceljs";
import { figerEtVerifierClasseur } from "@/lib/artifact/sheets/build";
import { a1DeCoord } from "@/lib/artifact/sheets/refs";
import { ACCENT_MAISON, LIBELLE_MODE, LIBELLE_TYPE, ajouterJours, arrondirCentimes, calculerTotaux, estPieceFiscale, formaterDateFr, verifierSpecCommerciale, type PartieCommerciale, type SpecDocumentCommercial } from "@/lib/artifact/factory/commercial";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PIÈCE SUR EXCEL — « prévoir l'option générer le BC sur Excel » (Direction, 10/2026).
 *
 * Le même bon de commande (ou devis, facture, avoir) que le Word : l'émetteur, le titre au centre, les parties,
 * la bande des références, les lignes et les totaux — mais en CLASSEUR, avec des FORMULES : on change une
 * quantité, un prix, une remise, le total suit. Ce que le Word ne permet pas.
 *
 * ── CE QUI TIENT LE CHIFFRE ─────────────────────────────────────────────────────────────
 *
 * Deux chemins indépendants, un seul nombre (§118.59) : le classeur est RELU par notre lecteur, ses formules
 * RECALCULÉES par notre moteur, les valeurs ÉCRITES dans le fichier (un aperçu mobile ne montre pas des zéros),
 * puis le total HT, chaque taxe, chaque TVA et le TTC recalculés sont COMPARÉS au centime à `calculerTotaux` —
 * l'arithmétique de la pièce Word. Un écart n'est pas livré : `ok` est faux et l'appelant le dit.
 *
 * L'arithmétique reproduit celle du Word, formule par formule : brut = ROUND(qté × PU), remise = ROUND(brut × %),
 * ligne = brut − remise ; la remise globale porte sur le total HT ; la TVA se calcule PAR TAUX sur la base de
 * ce taux après remise globale ; les taxes additionnelles se calculent sur le HT et restent HORS base de TVA
 * (794 500 → 15 890 de taxe, 150 955 de TVA, 961 345 TTC) ; le droit de timbre ne s'applique qu'aux espèces.
 *
 * Ce que le classeur ne recalcule pas : la somme EN LETTRES — un texte, arrêté à l'émission ; une note le dit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface XlsxCommercialConstruit {
  octets: Buffer;
  verification: { ok: boolean; bloquants: string[]; avertissements: string[]; formules: number };
  /** Un nom de fichier sûr : « 032-DG-2026 — Sarl BIOGALENIC.xlsx » (les barres d'un numéro ne passent pas dans un nom). */
  nom: string;
}

const present = (v: string | null | undefined): v is string => !!v && v.trim() !== "";
const lignesDe = (s: string): string[] => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const argb = (hex: string): string => `FF${hex.replace(/^#/, "").toUpperCase()}`;
const COLONNES = ["A", "B", "C", "D", "E", "F", "G"] as const;
const LARGEURS = [46, 10, 9, 15, 10, 8, 17];
const FORMAT_MONTANT = "#,##0.00";
const FORMAT_DZD = '#,##0.00" DZD"';
const FORMAT_REMISE = '0.##%;-0.##%;"—"';
const FORMAT_TAUX = "0.##%";
const GRIS = "FF595959";
const GRIS_SECTION = "FFE7E6E6";

/** Un nom de fichier sûr, sans les barres du numéro (« 032/DG/2026 » ne se range pas tel quel). */
export function nomFichierExcel(spec: Pick<SpecDocumentCommercial, "numero" | "tiers">): string {
  const sur = (s: string): string => s.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ");
  return `${sur(spec.numero)} — ${sur(spec.tiers.nom).slice(0, 60)}.xlsx`;
}

function identifiants(p: PartieCommerciale): string {
  return [p.rc ? `RC N° : ${p.rc}` : null, p.nif ? `NIF : ${p.nif}` : null, p.ai ? `AI : ${p.ai}` : null, p.nis ? `NIS : ${p.nis}` : null].filter(present).join("  |  ");
}

/** Le nombre de lignes qu'occupera un texte dans une colonne de `largeur` caractères — pour la hauteur de ligne. */
function lignesOccupees(texte: string, largeur: number): number {
  return Math.max(1, texte.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / Math.max(8, largeur))), 0));
}

/**
 * LES ÉCARTS ENTRE LE CLASSEUR RECALCULÉ ET LE CALCUL DE LA PLATEFORME — vide quand chaque total retombe au centime.
 * `lu(ligne)` rend la valeur recalculée de la colonne des montants à cette ligne (`null` quand rien ne se lit : une
 * cellule absente ou en erreur n'est pas un zéro). Pure : c'est ce qui permet de la FAIRE ÉCHOUER dans un banc — un
 * contrôle dont on ne sait pas nommer le cas qui le ferait tomber n'est pas un contrôle (§118.17).
 */
export function ecartsAvecLeCalcul(lu: (ligne: number) => number | null, attendus: { nom: string; ligne: number; attendu: number }[]): string[] {
  const out: string[] = [];
  for (const a of attendus) {
    const v = lu(a.ligne);
    if (v === null || Math.abs(arrondirCentimes(v) - a.attendu) > 0.005) {
      out.push(`${a.nom} : le classeur recalculé donne ${v === null ? "aucune valeur" : v.toFixed(2)}, le calcul de la plateforme ${a.attendu.toFixed(2)}.`);
    }
  }
  return out;
}

/**
 * CONSTRUIT la pièce en classeur — vérifie la spécification, compose, recalcule, compare au calcul du Word.
 * `ok` est faux si une règle bloque, si une formule donne une erreur, si l'audit relève un constat grave ou si
 * l'un des totaux recalculés s'écarte du calcul de la plateforme.
 */
export async function construireXlsxCommercial(spec: SpecDocumentCommercial, opts: { maintenant?: Date } = {}): Promise<XlsxCommercialConstruit> {
  const nom = nomFichierExcel(spec);
  const regles = verifierSpecCommerciale(spec);
  if (regles.bloquants.length > 0) {
    return { octets: Buffer.alloc(0), nom, verification: { ok: false, bloquants: regles.bloquants, avertissements: regles.avertissements, formules: 0 } };
  }
  const t = calculerTotaux(spec);
  const accent = (spec.couleur ?? ACCENT_MAISON).replace(/^#/, "").toUpperCase();
  const type = spec.type;
  const estDevis = type === "DEVIS";
  const fiscale = estPieceFiscale(type);
  const avoir = type === "AVOIR";
  const feuille = LIBELLE_TYPE[type];
  const e = spec.emetteur;
  const c = spec.tiers;

  const wb = new ExcelJS.Workbook();
  wb.creator = e.nom;
  wb.title = `${feuille} ${spec.numero}`;
  wb.calcProperties.fullCalcOnLoad = true;
  const ws = wb.addWorksheet(feuille, { views: [{ showGridLines: false }] });
  ws.columns = LARGEURS.map((width) => ({ width }));
  const bande = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: argb(accent) } };
  let nbFormules = 0;
  let r = 1;

  const ligneTexte = (texte: string, o: { fin?: string; gras?: boolean; taille?: number; couleur?: string; align?: "left" | "center" | "right"; italique?: boolean; fond?: ExcelJS.FillPattern; hauteur?: number } = {}): number => {
    const ligne = r++;
    const debut = "A";
    const fin = o.fin ?? "G";
    const cell = ws.getCell(`${debut}${ligne}`);
    cell.value = texte;
    cell.font = { bold: !!o.gras, italic: !!o.italique, size: o.taille ?? 10, color: { argb: o.couleur ?? "FF000000" } };
    cell.alignment = { horizontal: o.align ?? "left", vertical: "top", wrapText: true };
    if (fin !== debut) ws.mergeCells(`${debut}${ligne}:${fin}${ligne}`);
    if (o.fond) cell.fill = o.fond;
    const largeur = LARGEURS.slice(0, COLONNES.indexOf(fin as typeof COLONNES[number]) + 1).reduce((a, b) => a + b, 0);
    ws.getRow(ligne).height = o.hauteur ?? Math.max(15, lignesOccupees(texte, largeur) * ((o.taille ?? 10) + 4));
    return ligne;
  };

  // 1 — L'émetteur, en grand, à gauche (le papier en-tête n'existe pas sur un classeur).
  ligneTexte(e.nom.trim(), { fin: "D", gras: true, taille: 14, couleur: argb(accent) });
  if (present(e.adresse)) ligneTexte(`Siège Social : ${e.adresse.trim()}`, { fin: "D" });
  const coordonnees = [e.telephone ? `Tél. ${e.telephone}` : null, e.email].filter(present).join(" — ");
  if (coordonnees) ligneTexte(coordonnees, { fin: "D", couleur: GRIS });
  const idsEmetteur = identifiants(e);
  if (idsEmetteur) ligneTexte(idsEmetteur, { fin: "D", couleur: GRIS, taille: 8.5 });
  r++;

  // 2 — LE TITRE, AU CENTRE, sous l'en-tête ; puis le numéro et la date.
  ligneTexte(feuille.toUpperCase(), { gras: true, taille: 16, couleur: argb(accent), align: "center", hauteur: 24 });
  ligneTexte(`N° ${spec.numero} — du ${formaterDateFr(spec.date)}`, { align: "center", gras: true });
  r++;

  // 3 — Les parties : à gauche le tiers, à droite la livraison (bon de commande), l'émetteur (devis) ou la référence (facture, avoir).
  const gauche: string[] = [estDevis || fiscale ? (avoir ? "Avoir au bénéfice de :" : fiscale ? "Facturer à :" : "Client :") : "A :", `Société : ${c.nom.trim()}`];
  if (present(c.adresse)) { const [premiere, ...suite] = lignesDe(c.adresse); gauche.push(`Adresse : ${premiere}`, ...suite); }
  if (present(c.telephone)) gauche.push(`Tél/Fax : ${c.telephone.trim()}`);
  if (present(c.email)) gauche.push(c.email.trim());
  const idsTiers = identifiants(c);
  if (idsTiers) gauche.push(idsTiers);
  const droite: string[] = [];
  if (estDevis) {
    droite.push("Émetteur :", e.nom.trim());
    if (present(e.adresse)) droite.push(`Siège Social : ${e.adresse.trim()}`);
    if (present(e.telephone)) droite.push(`TEL : ${e.telephone.trim()}`);
    if (present(e.email)) droite.push(e.email.trim());
  } else if (type === "BON_DE_COMMANDE") {
    const adresseLivraison = present(spec.livraison?.adresse) ? spec.livraison!.adresse!.trim() : (present(e.adresse) ? e.adresse.trim() : "");
    droite.push("Adresse de livraison :");
    if (adresseLivraison) droite.push(`Siège Social : ${adresseLivraison}`);
    droite.push(e.nom.trim());
    if (present(e.telephone)) droite.push(`TEL : ${e.telephone.trim()}`);
    if (present(spec.livraison?.date)) droite.push(`Date de livraison : ${formaterDateFr(spec.livraison!.date!.trim())}`);
    if (present(spec.livraison?.delai)) droite.push(`Délai : ${spec.livraison!.delai!.trim()}`);
  } else {
    droite.push(`Numéro de client : ${present(spec.numeroClient) ? spec.numeroClient.trim() : "—"}`);
    if (avoir && present(spec.referenceAmont)) droite.push(`Facture d'origine : ${spec.referenceAmont.trim()}${spec.referenceAmontDate ? ` du ${formaterDateFr(spec.referenceAmontDate)}` : ""}`);
    if (spec.echeance) droite.push(`Échéance : ${formaterDateFr(spec.echeance)}`);
    const motif = [spec.objet, !avoir && spec.referenceAmont ? `${spec.referenceAmont}${spec.referenceAmontDate ? ` du ${formaterDateFr(spec.referenceAmontDate)}` : ""}` : null].filter(present).join(" — ");
    if (motif) droite.push(`${avoir ? "Motif" : "Document Ref"} : ${motif}`);
  }
  {
    const ligne = r++;
    const g = ws.getCell(`A${ligne}`); g.value = gauche.join("\n"); g.alignment = { vertical: "top", wrapText: true }; g.font = { size: 10 };
    ws.mergeCells(`A${ligne}:C${ligne}`);
    const d = ws.getCell(`D${ligne}`); d.value = droite.join("\n"); d.alignment = { vertical: "top", wrapText: true }; d.font = { size: 10 };
    ws.mergeCells(`D${ligne}:G${ligne}`);
    ws.getRow(ligne).height = Math.max(lignesOccupees(gauche.join("\n"), 65), lignesOccupees(droite.join("\n"), 50)) * 14 + 4;
  }
  r++;

  // 4 — La bande des références : Date · Contact · Devis N° (ou Validité, Échéance) · Modalités de paiement.
  const contact = [present(spec.contact?.nom) ? spec.contact!.nom!.trim() : null, present(spec.contact?.telephone) ? `Tel ${spec.contact!.telephone!.trim()}` : null].filter(present).join("\n") || "—";
  const jours = spec.validiteJours ?? 30;
  const troisieme: [string, string] = estDevis
    ? ["Validité", `${jours} jours\njusqu'au ${formaterDateFr(ajouterJours(spec.date, jours))}`]
    : fiscale
      ? ["Échéance", spec.echeance ? formaterDateFr(spec.echeance) : "—"]
      : present(spec.referenceAmont)
        ? ["Devis N°", `${spec.referenceAmont.trim()}${spec.referenceAmontDate ? `\nDu ${formaterDateFr(spec.referenceAmontDate)}` : ""}`]
        : ["Référence", present(spec.objet) ? spec.objet.trim() : "—"];
  const modalites = [spec.modePaiement ? LIBELLE_MODE[spec.modePaiement] : null, present(spec.conditionsPaiement) ? spec.conditionsPaiement.trim() : null].filter(present).join("\n") || "—";
  const blocsReference: { de: string; a: string; titre: string; valeur: string }[] = [
    { de: "A", a: "A", titre: "Date", valeur: formaterDateFr(spec.date) },
    { de: "B", a: "C", titre: "Contact", valeur: contact },
    { de: "D", a: "E", titre: troisieme[0], valeur: troisieme[1] },
    { de: "F", a: "G", titre: "Modalités de paiement", valeur: modalites },
  ];
  const ligneTitre = r++;
  const ligneValeur = r++;
  for (const b of blocsReference) {
    const h = ws.getCell(`${b.de}${ligneTitre}`);
    h.value = b.titre; h.fill = bande; h.font = { bold: true, size: 9.5, color: { argb: "FFFFFFFF" } }; h.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    const v = ws.getCell(`${b.de}${ligneValeur}`);
    v.value = b.valeur; v.font = { size: 9.5 }; v.alignment = { horizontal: "center", vertical: "top", wrapText: true };
    if (b.de !== b.a) { ws.mergeCells(`${b.de}${ligneTitre}:${b.a}${ligneTitre}`); ws.mergeCells(`${b.de}${ligneValeur}:${b.a}${ligneValeur}`); }
  }
  ws.getRow(ligneValeur).height = Math.max(...blocsReference.map((b) => lignesOccupees(b.valeur, 14))) * 14 + 2;
  r++;

  // 5 — Les lignes, avec leurs formules.
  const entete = ["Désignation", "Unité", "Qté", "PU HT", "Remise", "TVA", "Total HT"];
  entete.forEach((titre, i) => {
    const cell = ws.getCell(`${COLONNES[i]}${r}`);
    cell.value = titre; cell.fill = bande; cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
    cell.alignment = { horizontal: i === 0 ? "left" : "center", vertical: "middle" };
  });
  ws.getRow(r).height = 20;
  r++;
  const premiereLigne = r;
  for (const l of t.lignes) {
    if (l.section) {
      const cell = ws.getCell(`A${r}`);
      cell.value = l.designation.trim(); cell.font = { bold: true, size: 10 }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GRIS_SECTION } };
      ws.mergeCells(`A${r}:G${r}`);
      r++;
      continue;
    }
    const detail = [l.designation.trim(), ...(l.details ?? []).filter(present).map((d) => d.trim()), present(l.reference) ? `Réf. ${l.reference.trim()}` : null].filter(present).join("\n");
    const a = ws.getCell(`A${r}`); a.value = detail; a.font = { size: 10, bold: false }; a.alignment = { vertical: "top", wrapText: true };
    ws.getCell(`B${r}`).value = l.unite ?? "";
    ws.getCell(`C${r}`).value = l.quantite;
    ws.getCell(`D${r}`).value = l.prixUnitaire; ws.getCell(`D${r}`).numFmt = FORMAT_MONTANT;
    ws.getCell(`E${r}`).value = l.remise ?? 0; ws.getCell(`E${r}`).numFmt = FORMAT_REMISE;
    ws.getCell(`F${r}`).value = l.taux; ws.getCell(`F${r}`).numFmt = FORMAT_TAUX;
    // brut = ROUND(qté × PU) ; remise = ROUND(brut × %) ; ligne = brut − remise — l'arithmétique du Word, au centime.
    const g = ws.getCell(`G${r}`);
    g.value = { formula: `ROUND(ROUND(C${r}*D${r},2)-ROUND(ROUND(C${r}*D${r},2)*E${r},2),2)` } as ExcelJS.CellFormulaValue;
    g.numFmt = FORMAT_MONTANT;
    nbFormules++;
    for (const col of ["B", "C", "D", "E", "F", "G"]) { const cell = ws.getCell(`${col}${r}`); cell.font = { size: 10 }; cell.alignment = { horizontal: col === "B" || col === "C" || col === "E" || col === "F" ? "center" : "right", vertical: "top" }; }
    ws.getRow(r).height = Math.max(15, lignesOccupees(detail, LARGEURS[0]) * 14);
    r++;
  }
  const derniereLigne = r - 1;
  const plageG = `G${premiereLigne}:G${derniereLigne}`;
  const plageF = `F${premiereLigne}:F${derniereLigne}`;

  // 6 — Les totaux : libellé à gauche (A:E), taux en F, montant en G — chaque montant est une FORMULE.
  const ligneTotal = (libelle: string, o: { taux?: number; formule: string; format?: string; gras?: boolean; couleur?: string }): number => {
    const ligne = r++;
    const lib = ws.getCell(`A${ligne}`);
    lib.value = libelle; lib.font = { bold: true, size: 10, color: { argb: o.couleur ?? argb(accent) } }; lib.alignment = { horizontal: "right" };
    ws.mergeCells(`A${ligne}:E${ligne}`);
    if (o.taux !== undefined) { const f = ws.getCell(`F${ligne}`); f.value = o.taux; f.numFmt = FORMAT_TAUX; f.font = { size: 10 }; f.alignment = { horizontal: "center" }; }
    const m = ws.getCell(`G${ligne}`);
    m.value = { formula: o.formule } as ExcelJS.CellFormulaValue;
    m.numFmt = o.format ?? FORMAT_DZD; m.font = { bold: !!o.gras, size: 10, color: o.gras ? { argb: argb(accent) } : undefined };
    nbFormules++;
    return ligne;
  };
  const rSous = ligneTotal(t.remiseGlobale > 0 || t.remisesLignes > 0 ? "Total HT (après remises de ligne)" : "Total HT", { formule: `ROUND(SUM(${plageG}),2)` });
  let rHt = rSous;
  let rRem: number | null = null;
  if (t.remiseGlobale > 0) {
    rRem = ligneTotal("Remise globale", { taux: spec.remiseGlobale ?? 0, formule: `ROUND(G${rSous}*F${r},2)`, format: '"- "#,##0.00" DZD"' });
    rHt = ligneTotal("Total HT net", { formule: `ROUND(G${rSous}-G${rRem},2)` });
  }
  const rTaxes: number[] = [];
  for (const x of t.taxes) rTaxes.push(ligneTotal(x.libelle || "Taxe additionnelle", { taux: x.taux, formule: `ROUND(G${rHt}*F${r},2)` }));
  const rTva: number[] = [];
  for (const x of t.tva) {
    const base = rRem !== null ? `*(1-F${rRem})` : "";
    rTva.push(ligneTotal("TVA", { taux: x.taux, formule: `ROUND(ROUND(SUMIF(${plageF},F${r},${plageG})${base},2)*F${r},2)` }));
  }
  const avantTimbre = `ROUND(G${rHt}${rTaxes.map((x) => `+G${x}`).join("")}${rTva.map((x) => `+G${x}`).join("")},2)`;
  let rTimbre: number | null = null;
  if (spec.modePaiement === "ESPECES") {
    rTimbre = ligneTotal("Droit de timbre", { formule: `IF(${avantTimbre}>0,MIN(2500,MAX(5,ROUND(${avantTimbre}*0.01,2))),0)` });
  }
  const rTtc = ligneTotal(fiscale ? (avoir ? "Montant crédité" : "Somme à payer") : "Montant TTC", { formule: rTimbre !== null ? `ROUND(${avantTimbre}+G${rTimbre},2)` : avantTimbre, gras: true });
  r++;

  // 7 — La somme arrêtée, en lettres (un texte : arrêté à l'émission), les notes, le signataire, le pied.
  const phrase = estDevis ? "devis" : avoir ? "avoir" : fiscale ? "facture" : "bon de commande";
  ligneTexte(`Arrêté le présent ${phrase} à la somme de :`, { gras: true });
  ligneTexte(`${t.enLettres.charAt(0).toUpperCase()}${t.enLettres.slice(1)}.`);
  ligneTexte("Somme en lettres arrêtée à l'émission : elle ne se met pas à jour si vous modifiez les quantités ou les prix de ce classeur.", { italique: true, taille: 8, couleur: GRIS });
  r++;
  if (estDevis) ligneTexte(`Ce devis est valable ${jours} jours à compter de sa date d'émission. Les prix s'entendent hors taxes, TVA en sus au taux en vigueur.`, { taille: 9, couleur: GRIS });
  if (present(spec.notes)) ligneTexte(spec.notes.trim(), { taille: 9.5 });
  if (spec.signataire || estDevis) {
    const gaucheSignature = estDevis ? "Bon pour accord\n(date, signature et cachet du client)" : "";
    const droiteSignature = spec.signataire ? [`Pour ${e.nom.trim()}`, spec.signataire.nom, spec.signataire.qualite, "", "", "Signature et cachet"].filter((x): x is string => typeof x === "string").join("\n") : "";
    const ligne = r++;
    const g = ws.getCell(`A${ligne}`); g.value = gaucheSignature; g.font = { size: 9.5, color: { argb: GRIS } }; g.alignment = { vertical: "top", wrapText: true };
    ws.mergeCells(`A${ligne}:C${ligne}`);
    const d = ws.getCell(`D${ligne}`); d.value = droiteSignature; d.font = { size: 9.5 }; d.alignment = { horizontal: "center", vertical: "top", wrapText: true };
    ws.mergeCells(`D${ligne}:G${ligne}`);
    ws.getRow(ligne).height = 78;
  }
  const pied: string[] = [];
  if (fiscale && (present(e.banque) || present(e.rib))) pied.push([e.banque ? `Banque : ${e.banque}` : null, e.rib ? `RIB ${e.rib}` : null].filter(present).join(" — "));
  for (const m of spec.piedDePage ?? []) if (present(m)) pied.push(m.trim());
  if (pied.length) { r++; ligneTexte(pied.join("\n"), { taille: 7.5, couleur: GRIS, align: "center" }); }

  ws.pageSetup = { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } };
  ws.pageSetup.printArea = `A1:G${r}`;

  // ── RELIRE, RECALCULER, COMPARER AU CALCUL DU WORD ────────────────────────────────────
  const fige = await figerEtVerifierClasseur(wb, nbFormules, { maintenant: opts.maintenant });
  const bloquants = [...regles.bloquants];
  if (!fige.verification.ok) {
    for (const x of fige.verification.erreurs) bloquants.push(`Formule en erreur (${x.ref}) : ${x.erreur}.`);
    for (const x of fige.verification.constats) bloquants.push(`Contrôle du classeur : ${x.message ?? JSON.stringify(x)}`);
    if (fige.verification.ecarts > 0) bloquants.push(`${fige.verification.ecarts} cellule(s) dont la valeur enregistrée diffère du recalcul.`);
  }
  const lu = (ligne: number): number | null => {
    const v = fige.valeurs.get(`${feuille}!${a1DeCoord(ligne, 7)}`);
    return typeof v === "number" ? v : null;
  };
  const attendus: { nom: string; ligne: number; attendu: number }[] = [
    { nom: "Total HT", ligne: rHt, attendu: t.totalHt },
    ...t.taxes.map((x, i) => ({ nom: `Taxe « ${x.libelle} »`, ligne: rTaxes[i], attendu: x.montant })),
    ...t.tva.map((x, i) => ({ nom: `TVA ${Math.round(x.taux * 100)} %`, ligne: rTva[i], attendu: x.montant })),
    ...(rTimbre !== null ? [{ nom: "Droit de timbre", ligne: rTimbre, attendu: t.timbre }] : []),
    { nom: "Total TTC", ligne: rTtc, attendu: t.totalTtc },
  ];
  bloquants.push(...ecartsAvecLeCalcul(lu, attendus));
  return {
    octets: fige.octets, nom,
    verification: { ok: bloquants.length === 0, bloquants, avertissements: regles.avertissements, formules: nbFormules },
  };
}
