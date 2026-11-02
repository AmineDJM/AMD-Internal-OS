import { describe, it, expect, beforeEach } from "vitest";
import { adaptateurPour } from "@/lib/artifact/adapters/registry";
import { docxDeParagraphes, pptxDiapos, xlsxVentes, pdfNumerote } from "@/lib/artifact/adapters/fixtures";
import { vueDuModele, type VueContenu } from "@/lib/artifact/render/view";
import { editer, oublierSession, ouvrir, revoir, sauvegarder, vueDeSession, type ContexteMoteur } from "@/lib/artifact/runtime/engine";
import { magasinMemoire, portsMemoire, type DriveFaux } from "@/lib/artifact/runtime/fakes";
import { traduireGeste, zonesModifiees } from "./gestes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ATELIER (J3) — la traduction geste → opération IR, PAR FORMAT, puis appliquée au VRAI fichier par les
 * VRAIS adaptateurs ; la revue (accepter / refuser / à revoir) par rejeu ; l'enregistrement en NOUVELLE version.
 * Seuls les ports (Drive) sont en mémoire.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

async function vueDe(format: "DOCX" | "PPTX" | "XLSX" | "PDF", octets: Buffer): Promise<VueContenu> {
  return vueDuModele((await adaptateurPour(format).ouvrir(octets)).modele());
}

async function appliquer(format: "DOCX" | "PPTX" | "XLSX", octets: Buffer, g: Parameters<typeof traduireGeste>[0]) {
  const doc = await adaptateurPour(format).ouvrir(octets);
  const avant = vueDuModele(doc.modele());
  const t = traduireGeste(g, avant);
  const effets = t.commandes.map((c) => doc.appliquer(c));
  const sortie = await doc.serialiser();
  // Le fichier produit se RELIT : c'est la preuve qu'il n'est pas corrompu (§48).
  const relu = await adaptateurPour(format).ouvrir(sortie);
  return { t, effets, avant, apres: vueDuModele(relu.modele()), sortie };
}

describe("traduction geste → commande IR, par format", () => {
  it("Word : remplacer un texte garde le style du paragraphe ; un tableau s'insère et se relit", async () => {
    const docx = await docxDeParagraphes(["Contrat de travail", "La période d'essai est de 3 mois.", "Rémunération : selon grille."], { premierEstTitre: true });
    const r = await appliquer("DOCX", docx, { action: "remplacer_texte", chercher: "3 mois", remplacer: "6 mois" });
    expect(r.t.commandes.map((c) => c.op)).toEqual(["docx.remplacer_texte"]);
    expect(r.effets.every((e) => e.ok)).toBe(true);
    if (r.apres.kind !== "DOCX") throw new Error("format");
    expect(r.apres.blocs.find((b) => b.index === 2)?.texte).toBe("La période d'essai est de 6 mois.");
    expect(r.apres.blocs.find((b) => b.index === 1)?.styleName).toBe("Heading1");

    const t = await appliquer("DOCX", r.sortie, { action: "inserer_tableau", contient: "Rémunération", position: "apres", lignes: ["Poste | Salaire", "Délégué | 120 000 DZD"] });
    expect(t.t.commandes.map((c) => c.op)).toEqual(["docx.inserer_tableau"]);
    if (t.apres.kind !== "DOCX") throw new Error("format");
    const tab = t.apres.blocs.find((b) => b.type === "tableau");
    expect(tab?.lignes).toEqual([["Poste", "Salaire"], ["Délégué", "120 000 DZD"]]);

    const titre = traduireGeste({ action: "modifier_titre", titre: "Contrat à durée indéterminée", gras: true }, r.apres);
    expect(titre.commandes.map((c) => [c.op, c.cible?.role])).toEqual([["docx.texte", "titre"], ["docx.format_texte", "titre"]]);
    expect(traduireGeste({ action: "reecrire_paragraphe", index: 2, texte: "x" }, r.apres).commandes[0]).toMatchObject({ op: "docx.texte", cible: { index: 2 } });
  });

  it("PowerPoint : remplacer un texte vise CHAQUE zone qui le porte ; ajouter une diapositive de synthèse", async () => {
    const pptx = await pptxDiapos(3);
    const r = await appliquer("PPTX", pptx, { action: "remplacer_texte", chercher: "Diapositive 2", remplacer: "Résultats 2026" });
    // Le titre ET le corps (« Contenu de la diapositive 2 ») portent le texte : deux zones, deux commandes.
    expect(r.t.commandes).toHaveLength(2);
    expect(r.t.commandes.every((c) => c.op === "pptx.texte" && c.diapo === 2)).toBe(true);
    expect(r.t.commandes[0]!.cible?.id).toBeTruthy();
    if (r.apres.kind !== "PPTX") throw new Error("format");
    expect(r.apres.diapos[1]!.titre).toBe("Résultats 2026");

    const s = await appliquer("PPTX", r.sortie, { action: "ajouter_diapo", titre: "Synthèse", texte: "- Ventes en hausse\n- Deux lancements" });
    expect(s.t.commandes.map((c) => c.op)).toEqual(["pptx.ajouter_diapo"]);
    if (s.apres.kind !== "PPTX") throw new Error("format");
    expect(s.apres.diapos).toHaveLength(4);
    expect(s.apres.diapos[3]!.titre).toBe("Synthèse");

    const titre = traduireGeste({ action: "modifier_titre", diapo: 1, titre: "Bilan" }, s.apres);
    expect(titre.commandes[0]).toMatchObject({ op: "pptx.texte", diapo: 1, cible: { role: "titre" } });
    // Ce qui change se voit : la diapositive ajoutée est surlignée, et l'écran y va.
    const z = zonesModifiees(r.apres, s.apres);
    expect(z.ids).toContain(s.apres.diapos[3]!.id);
    expect(z.diapo).toBe(4);
  });

  it("Excel : une cellule (valeur ou formule), un remplacement hors formules, un tableau posé à partir d'une cellule", async () => {
    const xlsx = await xlsxVentes();
    const v = await vueDe("XLSX", xlsx);
    expect(traduireGeste({ action: "modifier_cellule", plage: "C7", valeur: "=SUM(C2:C5)/4" }, v).commandes[0]).toMatchObject({ op: "xlsx.formule", plage: "C7", formule: "=SUM(C2:C5)/4" });
    const r = await appliquer("XLSX", xlsx, { action: "remplacer_texte", chercher: "Oran", remplacer: "Tlemcen" });
    expect(r.t.commandes).toEqual([expect.objectContaining({ op: "xlsx.valeur", plage: "B3", feuille: "Ventes", texte: "Tlemcen" })]);
    if (r.apres.kind !== "XLSX") throw new Error("format");
    expect(r.apres.feuilles[0]!.cellules.find((c) => c.ref === "B3")?.valeur).toBe("Tlemcen");
    const z = zonesModifiees(r.avant, r.apres);
    expect(z.feuille).toBe("Ventes");
    expect(z.ids).toHaveLength(1);

    const tab = traduireGeste({ action: "inserer_tableau", feuille: "Notes", plage: "B2", lignes: ["Mois | Total", "Janvier | 12"] }, v);
    expect(tab.commandes.map((c) => c.plage)).toEqual(["B2", "C2", "B3", "C3"]);
  });

  it("refuse ce qui ne se traduit pas dans le format — sans deviner", async () => {
    const docx = await vueDe("DOCX", await docxDeParagraphes(["Un"]));
    expect(traduireGeste({ action: "ajouter_diapo", titre: "x" }, docx).refus).toMatch(/document Word/);
    expect(traduireGeste({ action: "reecrire_paragraphe", texte: "x" }, docx).refus).toMatch(/QUEL paragraphe/);
    const pdf = await vueDe("PDF", await pdfNumerote(3));
    expect(traduireGeste({ action: "remplacer_texte", chercher: "a", remplacer: "b" }, pdf).refus).toMatch(/convertissez-le/);
    expect(traduireGeste({ action: "supprimer_pages", pages: [2] }, pdf).commandes[0]).toMatchObject({ op: "pdf.supprimer_pages", pages: [2] });
    expect(traduireGeste({ action: "danser" }, pdf).refus).toMatch(/geste inconnu/);
  });

  it("ce qui a changé se repère par CONTENU : une insertion ne surligne pas tout ce qui suit", async () => {
    const avant = await vueDe("DOCX", await docxDeParagraphes(["A", "B", "C", "D"]));
    const doc = await adaptateurPour("DOCX").ouvrir(await docxDeParagraphes(["A", "B", "C", "D"]));
    doc.appliquer(traduireGeste({ action: "inserer_paragraphe", index: 1, position: "apres", texte: "Nouveau" }, avant).commandes[0]!);
    const apres = vueDuModele(doc.modele());
    const z = zonesModifiees(avant, apres);
    if (apres.kind !== "DOCX") throw new Error("format");
    expect(z.ids).toEqual([apres.blocs.find((b) => b.texte === "Nouveau")!.id]);
  });
});

describe("la revue — accepter, refuser, remettre à revoir — et l'enregistrement en nouvelle version", () => {
  let drive: DriveFaux;
  let ctx: ContexteMoteur;
  beforeEach(async () => {
    for (const id of ["s1", "s2"]) oublierSession(id);
    drive = { fichiers: new Map(), audit: [], droitEcriture: true };
    drive.fichiers.set("n1", { nom: "Contrat.docx", versions: [{ version: 1, octets: await docxDeParagraphes(["Contrat", "Essai : 3 mois.", "Préavis : 1 mois."], { premierEstTitre: true }), note: "" }] });
    ctx = { ports: portsMemoire(drive), magasin: magasinMemoire(), acteur: { id: "u1", libelle: "Assistant IA" } };
  });

  it("refuser une modification qui n'est PAS la dernière la retire exactement ; à revoir la rétablit ; enregistrer crée la v2 sans toucher la v1", async () => {
    const o = await ouvrir(ctx, { nodeId: "n1", blockId: "atelier-x" });
    const sid = o.vue!.sessionId;
    const v0 = o.vue!.contenu;
    for (const g of [{ action: "remplacer_texte", chercher: "3 mois", remplacer: "6 mois" }, { action: "remplacer_texte", chercher: "1 mois", remplacer: "2 mois" }]) {
      const vue = (await vueDeSession(ctx, sid))!;
      await editer(ctx, sid, traduireGeste(g, vue.contenu).commandes);
    }
    let vue = (await vueDeSession(ctx, sid))!;
    expect(vue.historique.map((h) => [h.seq, h.revue ?? null, h.annulee])).toEqual([[1, null, false], [2, null, false]]);

    const refus = await revoir(ctx, sid, 1, "REFUSER");
    expect(refus.ok).toBe(true);
    const textes = () => (vue.contenu.kind === "DOCX" ? vue.contenu.blocs.map((b) => b.texte) : []);
    vue = refus.vue!;
    expect(textes()).toEqual(["Contrat", "Essai : 3 mois.", "Préavis : 2 mois."]);
    expect(vue.historique.find((h) => h.seq === 1)).toMatchObject({ revue: "REFUSEE", annulee: true });

    vue = (await revoir(ctx, sid, 2, "ACCEPTER")).vue!;
    expect(vue.historique.find((h) => h.seq === 2)).toMatchObject({ revue: "ACCEPTEE", annulee: false });
    expect(textes()).toEqual(["Contrat", "Essai : 3 mois.", "Préavis : 2 mois."]);

    vue = (await revoir(ctx, sid, 1, "A_REVOIR")).vue!;
    expect(textes()).toEqual(["Contrat", "Essai : 6 mois.", "Préavis : 2 mois."]);
    expect(vue.historique.find((h) => h.seq === 1)).toMatchObject({ revue: null, annulee: false });
    expect(zonesModifiees(v0, vue.contenu).ids).toHaveLength(2);

    const v1 = drive.fichiers.get("n1")!.versions[0]!.octets;
    const copie = Buffer.from(v1);
    const s = await sauvegarder(ctx, sid);
    expect(s.ok).toBe(true);
    expect(s.version).toBe(2);
    const versions = drive.fichiers.get("n1")!.versions;
    expect(versions.map((x) => x.version)).toEqual([1, 2]);
    expect(Buffer.compare(versions[0]!.octets, copie)).toBe(0);
    const relu = await vueDe("DOCX", versions[1]!.octets);
    if (relu.kind !== "DOCX") throw new Error("format");
    expect(relu.blocs.map((b) => b.texte)).toEqual(["Contrat", "Essai : 6 mois.", "Préavis : 2 mois."]);
    expect(relu.blocs[0]!.styleName).toBe("Heading1");
  });
});
