import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PIECE_AMONT_INTROUVABLE } from "@/lib/legal/piece-emise";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PIÈCE AMONT D'UNE PIÈCE COMPOSÉE — les POINTS D'APPEL (audit 360°, lot D1c — F1).
 *
 * Le compositeur n'envoyait jamais `chainFromId` : un BC composé depuis un devis ne lui était jamais
 * chaîné, et partait au mauvais centre de validation. La règle est éprouvée ailleurs ; ici, on exige
 * qu'elle soit APPELÉE, là où elle doit l'être (§118.49) — source lue sans ses commentaires (§118.79d).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const RACINE = path.resolve(__dirname, "../../..");
const sansCommentaires = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const lire = (rel: string) => sansCommentaires(readFileSync(path.join(RACINE, rel), "utf8"));

/** Le corps d'une fonction nommée (déclarée par `function` ou `const NOM = …`), jusqu'à la déclaration suivante. */
function corps(src: string, nom: string): string {
  const i = src.search(new RegExp(`(?:(?:async\\s+)?function\\s+${nom}\\s*[(<]|const\\s+${nom}\\s*=)`));
  expect(i, `${nom} introuvable`).toBeGreaterThanOrEqual(0);
  const suite = src.slice(i + 1).search(/\n(?:export\s+)?(?:async\s+)?function\s+[A-Za-z0-9_]+\s*[(<]|\n {2}const\s+[A-Za-z0-9_]+\s*=\s*(?:React\.)?use/);
  return suite === -1 ? src.slice(i) : src.slice(i, i + 1 + suite);
}

describe("le compositeur envoie la pièce amont qu'il propose — et seulement celle-là", () => {
  const ecran = lire("src/components/pieces/composer-piece.tsx");

  it("`construireFormData` envoie `chainFromId` depuis la pièce RETENUE, et l'aperçu se recalcule quand elle change", () => {
    // Une RÉVISION (pièce rouverte) ne change pas sa chaîne : le rattachement se fait depuis la fiche.
    expect(corps(ecran, "construireFormData")).toMatch(/if \(amontRetenu && !rev\) fd\.set\("chainFromId", amontRetenu\)/);
    expect(ecran).toMatch(/const empreinte = JSON\.stringify\(\{[^}]*amontRetenu[^}]*\}\)/);
  });

  it("le menu filtre par la table de la fabrique (`NATURES_AMONT[type]`) ET par la société émettrice, et abandonne une pièce qu'il ne propose plus", () => {
    expect(ecran).toMatch(/import \{ NATURES_AMONT(, type ValeursComposables)? \} from "@\/lib\/legal\/piece-emise"/);
    expect(ecran).toMatch(/NATURES_AMONT\[type\]/);
    expect(ecran).toMatch(/naturesAmont\.includes\(o\.kind\) && \(!o\.companyId \|\| o\.companyId === societe\)/);
    expect(ecran).toMatch(/amontsProposes\.some\(\(o\) => o\.value === amont\) \? amont : ""/);
  });

  it("chaque montage du compositeur lui passe les pièces amont", () => {
    for (const page of ["src/app/(app)/legal/page.tsx", "src/app/(app)/bons-de-commande/page.tsx"]) {
      const src = lire(page);
      const montages = src.match(/<ComposerPieceButton\b/g)?.length ?? 0;
      expect(montages, page).toBeGreaterThan(0);
      expect(src.match(/amont=\{composition\.amont\}/g)?.length ?? 0, page).toBe(montages);
    }
  });

  it("le chargeur du compositeur passe par la porte de la liste Legal, natures de la fabrique comprises", () => {
    const comp = lire("src/lib/queries/composition-pieces.ts");
    expect(corps(comp, "compositionDesPieces")).toMatch(/piecesAmontComposables\(user, naturesAmont\)/);
    expect(comp).toMatch(/NATURES_AMONT\[t\]/);
    const chaine = lire("src/lib/queries/legal-chain.ts");
    const c = corps(chaine, "piecesAmontComposables");
    expect(c).toMatch(/perimetreLegal\(user\)/);
    expect(c).toMatch(/legalKindVisible\(portee, k\)/);
    expect(c).toMatch(/status: \{ not: "CANCELLED" \}/);
  });
});

describe("la fabrique juge la pièce amont, à l'émission comme à l'aperçu", () => {
  const fabrique = lire("src/platform/in-process/artifact/factory.ts");

  it("`jugerPieceAmont` est appelée par l'émission ET par l'aperçu, et lit le droit de lire la pièce", () => {
    expect(corps(fabrique, "emettreDocumentDrive")).toMatch(/jugerPieceAmont\(user, type, chainFromId, profil\.societe\.id\)/);
    expect(corps(fabrique, "previsualiserDocument")).toMatch(/jugerPieceAmont\(user, type, amontId, profil\.societe\.id\)/);
    const j = corps(fabrique, "jugerPieceAmont");
    expect(j).toMatch(/canAccessEntity\(user, "LEGAL_DOCUMENT", amont\.id, "VIEW"\)/);
    expect(j).toMatch(/refusPieceAmont\(/);
  });

  it("l'avoir relit le droit de lire la facture qu'il crédite", () => {
    expect(corps(fabrique, "factureDeLAvoir")).toMatch(/canAccessEntity\(user, "LEGAL_DOCUMENT", doc\.id, "VIEW"\)/);
  });

  it("la pièce identique rendue dit la pièce amont qu'elle ne porte pas — dans les deux retours du doublon", () => {
    const e = corps(fabrique, "emettreDocumentDrive");
    expect(e).toMatch(/phrasePieceAmontNonRattachee\(f\.numero, existant\.chainFromId, demande\.chainFromId \?\? null\)/);
    expect(e.match(/avertissementAmont \? \[avertissementAmont\] : \[\]/g)?.length ?? 0).toBe(2);
  });
});

describe("une seule phrase pour la pièce amont absente, et la fiche Legal suit la porte de la liste", () => {
  it("la phrase de l'absence n'est écrite qu'une fois, dans `piece-emise.ts`", () => {
    const fichiers: string[] = [];
    const parcourir = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = path.join(dir, e);
        if (statSync(p).isDirectory()) parcourir(p);
        else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) fichiers.push(p);
      }
    };
    parcourir(path.join(RACINE, "src"));
    const porteurs = fichiers.filter((f) => readFileSync(f, "utf8").includes(PIECE_AMONT_INTROUVABLE)).map((f) => path.relative(RACINE, f));
    expect(porteurs).toEqual(["src/lib/legal/piece-emise.ts"]);
  });

  it("le menu « Fait suite à » de la fiche passe par `perimetreLegal` — les Finances n'y lisent pas le titre d'un devis", () => {
    const fiche = lire("src/app/(app)/legal/[id]/page.tsx");
    expect(fiche).toMatch(/perimetreLegal\(user\)\.then\(\(perimetre\) => piecesAmontProposees\(\{/);
    expect(fiche).toMatch(/readerScope: perimetre\.where \?\? \{ id: \{ in: \[\] \} \}/);
  });
});
