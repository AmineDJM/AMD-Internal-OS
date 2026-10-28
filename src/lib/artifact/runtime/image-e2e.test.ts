/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « METS LE LOGO ADVENTUM EN HAUT DU CONTRAT » — la chaîne entière.
 *
 * Ce que ce fichier prouve, et qu'aucun test d'adaptateur ne peut prouver :
 *
 *   • la SOURCE se désigne par son NOM, pas par un identifiant que personne ne connaît ;
 *   • deux fichiers du même nom ne font pas choisir la machine — elle rend les candidats ;
 *   • un fichier qu'on n'a pas le droit de lire ne devient PAS une image dans un document ;
 *   • le journal ne porte que la RÉFÉRENCE, jamais les octets — et le REJEU les relit ;
 *   • une image insérée puis annulée disparaît vraiment.
 *
 * Les ports sont faux ; tout le reste est le code de production.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { beforeEach, describe, expect, it } from "vitest";
import PizZip from "pizzip";
import { docxDeParagraphes, pngUni, xlsxAvecTableau } from "@/lib/artifact/adapters/fixtures";
import { cibleIndex, commande } from "@/lib/artifact/commands/ir";
import {
  annuler, editer, oublierSession, ouvrir, sauvegarder, type ContexteMoteur,
} from "@/lib/artifact/runtime/engine";
import { magasinMemoire, portsMemoire, type DriveFaux } from "@/lib/artifact/runtime/fakes";

let drive: DriveFaux;
let ctx: ContexteMoteur;
let sessionId = "";

const LOGO = pngUni(400, 200);

async function contexte(fichiers: { nodeId: string; nom: string; octets: Buffer }[]) {
  drive = { fichiers: new Map(), audit: [], droitEcriture: true };
  for (const f of fichiers) {
    drive.fichiers.set(f.nodeId, { nom: f.nom, versions: [{ version: 1, octets: f.octets, note: "" }] });
  }
  ctx = { ports: portsMemoire(drive), magasin: magasinMemoire(), acteur: { id: "u-pdg", libelle: "Amine" } };
}

async function ouvrirContrat() {
  const r = await ouvrir(ctx, { nodeId: "contrat" });
  if (!r.ok || !r.vue) throw new Error(r.motif ?? "ouverture impossible");
  sessionId = r.vue.sessionId;
}

function imagesDuFichier(octets: Buffer): string[] {
  const zip = new PizZip(octets);
  return Object.keys(zip.files).filter((k) => k.startsWith("word/media/"));
}

beforeEach(() => { if (sessionId) oublierSession(sessionId); });

describe("poser une image, par son nom", () => {
  it("« le logo Adventum » suffit : le code cherche, trouve, et pose", async () => {
    await contexte([
      { nodeId: "contrat", nom: "Contrat Consulting.docx", octets: await docxDeParagraphes(["Contrat", "Article 1"]) },
      { nodeId: "logo", nom: "logo Adventum.png", octets: LOGO },
    ]);
    await ouvrirContrat();

    const r = await editer(ctx, sessionId, [
      commande("docx.inserer_image", { imageSource: "logo Adventum", largeurCm: 5 }),
    ]);
    expect(r.ok, r.motif ?? "").toBe(true);
    expect(r.effets[0].resume).toContain("logo Adventum.png");

    const vue = r.vue;
    expect(vue?.format).toBe("DOCX");
    const s = await sauvegarder(ctx, sessionId, {});
    expect(s.ok).toBe(true);
    const enregistre = drive.fichiers.get("contrat")!.versions.at(-1)!.octets;
    expect(imagesDuFichier(enregistre)).toHaveLength(1);
  });

  it("deux fichiers pour un même nom : la machine NE CHOISIT PAS", async () => {
    /**
     * CE QUI FERAIT TOMBER CE TEST : prendre le premier résultat. On collerait le logo 2019
     * dans un contrat de 2027, et le résumé dirait « logo inséré ». La personne signerait.
     */
    await contexte([
      { nodeId: "contrat", nom: "Contrat.docx", octets: await docxDeParagraphes(["Contrat"]) },
      { nodeId: "l1", nom: "logo Adventum 2019.png", octets: LOGO },
      { nodeId: "l2", nom: "logo Adventum 2027.png", octets: pngUni(200, 200) },
    ]);
    await ouvrirContrat();

    const r = await editer(ctx, sessionId, [
      commande("docx.inserer_image", { imageSource: "logo Adventum", largeurCm: 5 }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.effets[0].motif).toContain("2 fichiers");
    expect(r.effets[0].candidats.map((c) => c.libelle).sort()).toEqual([
      "logo Adventum 2019.png", "logo Adventum 2027.png",
    ]);
    /**
     * ET RIEN N'A ÉTÉ POSÉ. On le vérifie sur les OCTETS, pas sur le statut de la sauvegarde :
     * une session propre s'enregistre très bien — ce qu'on veut exclure, c'est le média
     * fantôme, ces octets rangés dans le zip par une commande qui a ensuite échoué et qui
     * feraient grossir le fichier sans que rien ne les affiche.
     */
    await sauvegarder(ctx, sessionId, {});
    expect(imagesDuFichier(drive.fichiers.get("contrat")!.versions.at(-1)!.octets)).toHaveLength(0);
  });

  it("un fichier ILLISIBLE ne devient pas une image — la porte de droits est le port", async () => {
    /**
     * Le port rend `null` quand la personne n'a pas le droit de lire. Il n'y a pas d'autre
     * chemin vers les octets : l'adaptateur n'en connaît aucun (§104.9). Ici on simule le
     * refus en retirant les versions du fichier — ce que fait un Drive qui dit non.
     */
    await contexte([
      { nodeId: "contrat", nom: "Contrat.docx", octets: await docxDeParagraphes(["Contrat"]) },
      { nodeId: "secret", nom: "logo interdit.png", octets: LOGO },
    ]);
    drive.fichiers.get("secret")!.versions = [];
    await ouvrirContrat();

    const r = await editer(ctx, sessionId, [
      commande("docx.inserer_image", { imageSource: "secret", largeurCm: 5 }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.effets[0].motif).toMatch(/n'a pas pu être lu|introuvable/);
  });
});

describe("le journal, le rejeu et l'annulation", () => {
  it("le journal porte la RÉFÉRENCE, pas les octets — et le rejeu les relit", async () => {
    /**
     * CE QUI FERAIT TOMBER CE TEST : mettre le Buffer dans la commande. Le journal d'un
     * document illustré pèserait des mégaoctets, rejoués à CHAQUE ouverture (§104.3). Ici on
     * vérifie la taille de ce qui est persisté : une commande d'insertion doit rester de
     * l'ordre de la ligne de texte, quel que soit le poids de l'image.
     */
    await contexte([
      { nodeId: "contrat", nom: "Contrat.docx", octets: await docxDeParagraphes(["Contrat", "Article 1"]) },
      { nodeId: "logo", nom: "grand logo.png", octets: pngUni(1200, 600) },
    ]);
    await ouvrirContrat();
    await editer(ctx, sessionId, [commande("docx.inserer_image", { imageSource: "logo", largeurCm: 5 })]);

    const ops = await ctx.magasin.operations(sessionId);
    expect(ops).toHaveLength(1);
    const poidsCommande = JSON.stringify(ops[0].command).length;
    expect(poidsCommande).toBeLessThan(1_000);
    expect(JSON.stringify(ops[0].command)).toContain("logo");

    // LE REJEU : on jette l'état en mémoire, le moteur reconstruit depuis le journal — et
    // l'image est là, parce que les octets ont été RELUS à travers le port.
    oublierSession(sessionId);
    const r2 = await editer(ctx, sessionId, [commande("docx.texte", { cible: cibleIndex(1), texte: "Contrat modifié" })]);
    expect(r2.ok).toBe(true);
    const s = await sauvegarder(ctx, sessionId, {});
    expect(s.ok).toBe(true);
    expect(imagesDuFichier(drive.fichiers.get("contrat")!.versions.at(-1)!.octets)).toHaveLength(1);
  });

  it("annuler une insertion la fait VRAIMENT disparaître", async () => {
    await contexte([
      { nodeId: "contrat", nom: "Contrat.docx", octets: await docxDeParagraphes(["Contrat"]) },
      { nodeId: "logo", nom: "logo.png", octets: LOGO },
    ]);
    await ouvrirContrat();
    await editer(ctx, sessionId, [commande("docx.inserer_image", { imageSource: "logo", largeurCm: 5 })]);
    const r = await annuler(ctx, sessionId);
    expect(r.ok).toBe(true);

    const s = await sauvegarder(ctx, sessionId, {});
    expect(s.ok).toBe(true);
    const enregistre = drive.fichiers.get("contrat")!.versions.at(-1)!.octets;
    /**
     * L'annulation est un REJEU sans l'opération annulée (§104.3) : le document reconstruit
     * n'a jamais posé l'image, donc ni dessin, ni relation, ni média. Un « annuler » qui se
     * contenterait de retirer la balise laisserait le média orphelin dans le zip — le fichier
     * grossirait à chaque essai, sans que rien ne l'explique.
     */
    expect(imagesDuFichier(enregistre)).toHaveLength(0);
    const zip = new PizZip(enregistre);
    expect(zip.file("word/document.xml")!.asText()).not.toContain("<w:drawing>");
  });
});

describe("le même chemin, sur un CLASSEUR", () => {
  /**
   * CE QUE CE BLOC AJOUTE À `xlsx/image.test.ts` : celui-là part d'un adaptateur et de
   * ressources posées à la main. Ici on part du VRAI point d'entrée — `ouvrir`, `editer`,
   * `sauvegarder` — donc la source se cherche dans le Drive, la commande est journalisée, et
   * le rejeu doit relire les octets. Un format branché à moitié se voit ici et nulle part
   * ailleurs (§118.14 : une capacité sans appelant réel n'existe pas).
   */
  async function contexteClasseur() {
    await contexte([
      { nodeId: "contrat", nom: "Suivi dossiers.xlsx", octets: await xlsxAvecTableau() },
      { nodeId: "logo", nom: "logo Adventum.png", octets: LOGO },
    ]);
    await ouvrirContrat();
  }

  function imagesDuClasseur(octets: Buffer): string[] {
    const zip = new PizZip(octets);
    return Object.keys(zip.files).filter((k) => k.startsWith("xl/media/"));
  }

  it("« mets le logo en B2 » : la source se cherche par son NOM, et la pièce est posée", async () => {
    await contexteClasseur();
    const r = await editer(ctx, sessionId, [
      commande("xlsx.inserer_image", { feuille: "Suivi", plage: "B2", imageSource: "logo Adventum", largeurCm: 4 }),
    ]);
    expect(r.ok, r.motif ?? "").toBe(true);
    expect(r.vue?.format).toBe("XLSX");
    expect(r.effets[0].resume).toContain("logo Adventum.png");
    expect(r.effets[0].resume).toContain("B2");

    const s = await sauvegarder(ctx, sessionId, {});
    expect(s.ok).toBe(true);
    const enregistre = drive.fichiers.get("contrat")!.versions.at(-1)!.octets;
    expect(imagesDuClasseur(enregistre)).toHaveLength(1);
    // Le tableau structuré a survécu : c'est LUI que la mauvaise place de `<drawing>` détruit.
    const feuille = new PizZip(enregistre).file("xl/worksheets/sheet1.xml")!.asText();
    expect(feuille).toContain("<tableParts");
    expect(feuille.indexOf("<drawing")).toBeLessThan(feuille.indexOf("<tableParts"));
    // Et l'ancrage est bien B2 — colonne 1, ligne 1, 0-indexées dans le fichier.
    const dessin = new PizZip(enregistre).file("xl/drawings/drawing1.xml")!.asText();
    expect(dessin).toMatch(/<xdr:col>1<\/xdr:col>/);
    expect(dessin).toMatch(/<xdr:row>1<\/xdr:row>/);
  });

  it("le journal ne porte que la référence, et le REJEU relit les octets", async () => {
    await contexteClasseur();
    await editer(ctx, sessionId, [
      commande("xlsx.inserer_image", { feuille: "Suivi", plage: "B2", imageSource: "logo", largeurCm: 4 }),
    ]);
    const ops = await ctx.magasin.operations(sessionId);
    expect(JSON.stringify(ops[0].command).length).toBeLessThan(1_000);

    oublierSession(sessionId);
    const r2 = await editer(ctx, sessionId, [
      commande("xlsx.valeur", { feuille: "Suivi", plage: "D1", texte: "Vérifié" }),
    ]);
    expect(r2.ok, r2.motif ?? "").toBe(true);
    await sauvegarder(ctx, sessionId, {});
    expect(imagesDuClasseur(drive.fichiers.get("contrat")!.versions.at(-1)!.octets)).toHaveLength(1);
  });

  it("annuler l'insertion la fait VRAIMENT disparaître du classeur", async () => {
    await contexteClasseur();
    await editer(ctx, sessionId, [
      commande("xlsx.inserer_image", { feuille: "Suivi", plage: "B2", imageSource: "logo", largeurCm: 4 }),
    ]);
    expect((await annuler(ctx, sessionId)).ok).toBe(true);
    await sauvegarder(ctx, sessionId, {});
    const enregistre = drive.fichiers.get("contrat")!.versions.at(-1)!.octets;
    expect(imagesDuClasseur(enregistre)).toHaveLength(0);
    const zip = new PizZip(enregistre);
    expect(zip.file("xl/worksheets/sheet1.xml")!.asText()).not.toContain("<drawing");
    expect(zip.file("xl/drawings/drawing1.xml")).toBeNull();
  });

  it("deux fichiers pour un même nom : la machine NE CHOISIT PAS non plus dans un classeur", async () => {
    await contexte([
      { nodeId: "contrat", nom: "Suivi.xlsx", octets: await xlsxAvecTableau() },
      { nodeId: "l1", nom: "logo Adventum 2019.png", octets: LOGO },
      { nodeId: "l2", nom: "logo Adventum 2027.png", octets: pngUni(200, 200) },
    ]);
    await ouvrirContrat();
    const r = await editer(ctx, sessionId, [
      commande("xlsx.inserer_image", { feuille: "Suivi", plage: "B2", imageSource: "logo Adventum", largeurCm: 4 }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.effets[0].motif).toContain("2 fichiers");
    await sauvegarder(ctx, sessionId, {});
    expect(imagesDuClasseur(drive.fichiers.get("contrat")!.versions.at(-1)!.octets)).toHaveLength(0);
  });
});
