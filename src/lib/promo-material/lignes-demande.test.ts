import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { lireLignesDemande, ligneVide, LIGNES_MAX, REFUS_SANS_LIGNE, type LigneDemandeSaisie } from "./lignes-demande";
import { CONTRAT_PAR_ID } from "@/lib/actions/contrat.genere";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LIGNES D'UNE DEMANDE DE MATÉRIEL PROMOTIONNEL, SAISIES À LA CRÉATION (§118.171).
 *
 * La règle d'une ligne est celle de la fiche (`validerArticleDemande`, éprouvée ailleurs) : ce banc
 * ne tient que la LECTURE du champ `lignes` — ce qui ne se lit pas à coup sûr est refusé, jamais
 * deviné — et ce que la demande ne porte PLUS, lu sur deux faits : le contrat dérivé de la source
 * de l'action (ce qu'elle LIT), et la source du formulaire (ce qu'il ENVOIE).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const vide: LigneDemandeSaisie = { catalogueId: "", quantite: "", actions: [], produitIds: [], autre: "", commentaire: "" };

describe("lireLignesDemande — lire, jamais deviner", () => {
  it("un champ absent ou blanc ne porte aucune ligne (c'est l'action qui dira qu'il en faut une)", () => {
    expect(lireLignesDemande(null)).toEqual({ ok: true, lignes: [] });
    expect(lireLignesDemande(undefined)).toEqual({ ok: true, lignes: [] });
    expect(lireLignesDemande("   ")).toEqual({ ok: true, lignes: [] });
  });

  it("ce qui n'est pas une LISTE lisible est refusé, et le refus dit le geste", () => {
    for (const brut of ["{pas du json", '{"catalogueId":"x"}', '"une chaîne"', "42", "null"]) {
      const r = lireLignesDemande(brut);
      expect(r.ok, brut).toBe(false);
      expect(r.ok ? "" : r.error, brut).toMatch(/illisibles : rechargez le formulaire/);
    }
  });

  it("au-delà de la limite opérationnelle, la demande se SCINDE — et le refus compte ce qui a été saisi", () => {
    const trop = JSON.stringify(Array.from({ length: LIGNES_MAX + 1 }, () => ({ catalogueId: "c" })));
    const r = lireLignesDemande(trop);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toBe(`Une demande compte au plus ${LIGNES_MAX} lignes (${LIGNES_MAX + 1} saisies) : scindez-la en plusieurs demandes.`);
    // La limite elle-même passe : une borne qui refuse son propre chiffre serait un refus à tort.
    expect(lireLignesDemande(JSON.stringify(Array.from({ length: LIGNES_MAX }, () => ({ catalogueId: "c" })))).ok).toBe(true);
  });

  it("chaque ligne est NORMALISÉE champ par champ : rogné, nombre lu en texte, listes nettoyées, ordre gardé", () => {
    const r = lireLignesDemande(JSON.stringify([
      { catalogueId: "  cat-1 ", quantite: 500, actions: [" IMPRESSION ", "", 7, null, "CONCEPTION"], produitIds: ["p1", " ", "p2"], commentaire: "  A5, recto-verso  " },
      { catalogueId: "cat-2", quantite: " 1 000 ", actions: "ACHAT", produitIds: null },
    ]));
    expect(r).toEqual({
      ok: true,
      lignes: [
        // Le commentaire n'est PAS rogné : c'est une phrase de la personne, telle qu'elle l'a écrite.
        { catalogueId: "cat-1", quantite: "500", actions: ["IMPRESSION", "CONCEPTION"], produitIds: ["p1", "p2"], autre: "", commentaire: "  A5, recto-verso  " },
        // Une liste qui n'en est pas une ne devient pas une liste d'un élément : elle est VIDE, et la
        // règle de la ligne dira qu'il manque une action — au lieu de la deviner.
        { catalogueId: "cat-2", quantite: "1 000", actions: [], produitIds: [], autre: "", commentaire: "" },
      ],
    });
  });

  it("une quantité NON FINIE n'est pas lue comme un nombre", () => {
    const r = lireLignesDemande('[{"catalogueId":"c","quantite":1e999}]');
    expect(r.ok && r.lignes[0]!.quantite).toBe("");
  });

  it("un élément qui n'est pas un objet devient une ligne VIDE — que l'action écartera, jamais une ligne inventée", () => {
    const r = lireLignesDemande(JSON.stringify(["cat-1", 3, null, ["cat-2"]]));
    expect(r.ok && r.lignes).toEqual([vide, vide, vide, vide]);
    expect(r.ok && r.lignes.every(ligneVide)).toBe(true);
  });
});

describe("ligneVide — un reste de formulaire s'écarte, une ligne incomplète se juge", () => {
  it("TOUT vide (commentaire blanc compris) : écartée", () => {
    expect(ligneVide(vide)).toBe(true);
    expect(ligneVide({ ...vide, commentaire: "   " })).toBe(true);
  });

  it("le MOINDRE champ rempli en fait une vraie ligne, que la règle jugera", () => {
    expect(ligneVide({ ...vide, catalogueId: "c" })).toBe(false);
    expect(ligneVide({ ...vide, quantite: "5" })).toBe(false);
    expect(ligneVide({ ...vide, actions: ["IMPRESSION"] })).toBe(false);
    expect(ligneVide({ ...vide, produitIds: ["p"] })).toBe(false);
    expect(ligneVide({ ...vide, commentaire: "A5" })).toBe(false);
  });

  it("le refus « aucune ligne » dit à quoi sert une ligne, pas seulement qu'il en manque", () => {
    expect(REFUS_SANS_LIGNE).toMatch(/article du catalogue.*quantité.*conception, impression/);
  });
});

/** La source sans ses commentaires — un cliquet ne s'accroche pas à la prose qui le décrit (§118.79d, §118.88). */
const sansCommentaires = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
// Le « type de matériel » s'ajoute à la liste au §118.173 : le catalogue EST la liste des supports,
// et chaque ligne en désigne un — un type choisi à côté redisait la même chose, et pouvait la contredire.
// Les « précisions pour le secrétariat » quittent la demande (§118.204, Direction 04/10) : la demande de
// devis part d'elle-même, et ce qu'on attend se dit ligne par ligne (« Précision » de chaque article).
const RETIRES = ["businessUnitId", "amount", "assistantId", "companyId", "materialType", "precisionsDevis"] as const;

describe("ce que la demande ne porte PLUS (décision du 01/10) — lu sur les faits, pas sur une liste", () => {
  it("l'ACTION ne lit ni gamme, ni budget, ni assistante, ni entité — et lit `lignes` (contrat dérivé de sa source)", () => {
    const contrat = CONTRAT_PAR_ID.get("promo-material-actions:createPromoMaterial");
    expect(contrat, "prémisse : l'action est décrite").toBeDefined();
    const champs = (contrat!.champs ?? []).map((c) => c.nom).sort();
    // + la DATE DE BESOIN (Direction, 10/2026) : « besoin pour le … », facultative.
    expect(champs).toEqual(["description", "lignes", "neededBy", "title"]);
    for (const r of RETIRES) expect(champs, r).not.toContain(r);
  });

  it("le FORMULAIRE n'envoie que le titre, le brief, la date de besoin et les lignes", () => {
    const src = sansCommentaires(readFileSync(path.join(process.cwd(), "src/modules/ad-pro/ecrans/demande-materiel-form.tsx"), "utf8"));
    // PRÉMISSE : la lecture voit bien les clés qu'il envoie — sans cela, l'absence ci-dessous ne
    // prouverait rien (un fichier vide ne contiendrait aucune clé retirée non plus).
    expect(src).toMatch(/\["title", "description", "neededBy"\]/);
    expect(src).toMatch(/fd\.set\("lignes", JSON\.stringify\(envoi\)\)/);
    for (const r of RETIRES) expect(src, `le formulaire envoie encore « ${r} »`).not.toMatch(new RegExp(`["'\`]${r}["'\`]`));
  });
});
