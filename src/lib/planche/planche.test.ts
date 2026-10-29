import { describe, expect, it } from "vitest";
import {
  compiler, raconter, repli, CONTENANTS, ENFANTS_MAX, NOEUDS_MAX, PROFONDEUR_MAX,
  type Noeud, type Planche,
} from "@/lib/planche/grammaire";
import { anglesUtiles, regarder, ANGLES, type Ligne } from "@/lib/planche/angle";
import { consignerMesure } from "@/lib/evals/registre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PLANCHE ET LES ANGLES (mandat 7).
 *
 * Deux propriétés dominent :
 *   · la COMPOSITION est libre, le RENDU est fermé — aucune chaîne issue d'un modèle ne peut
 *     devenir du balisage, et un bloc inconnu est refusé nommément ;
 *   · un angle ne relit RIEN et dit toujours ce qu'il a écarté : « 28 sur 34, 6 sans date »
 *     se lit, « 28 » ment par omission.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const KINDS = new Set(["table", "viz", "record", "timeline", "progress", "people"]);
const blocs = (...ks: string[]) => ks.map((kind) => ({ kind }));
const feuille = (bloc: number): Noeud => ({ bloc });

describe("la grammaire — libre à composer, fermée à rendre", () => {
  it("un agencement profond et varié compile", () => {
    const p: Planche = {
      intention: "où en sont les 34 factures Hetero",
      blocs: blocs("progress", "table", "viz", "timeline"),
      racine: {
        forme: "LIGNES", titre: "Factures Hetero Labs",
        enfants: [
          { forme: "ACCENT", enfants: [feuille(0)] },
          {
            forme: "COLONNES", poids: [2, 1],
            enfants: [
              { forme: "ONGLETS", etiquettes: ["Par mois", "Par montant"], enfants: [feuille(1), feuille(2)] },
              { forme: "SECTION", titre: "Chronologie", enfants: [feuille(3)] },
            ],
          },
        ],
      },
    };
    const v = compiler(p, KINDS);
    expect(v.ok, JSON.stringify(v.problemes)).toBe(true);
    expect(v.profondeur).toBe(4);
    expect(v.blocsOrphelins).toHaveLength(0);
  });

  it("LE POINT DE SÉCURITÉ : un titre qui contient du balisage est REFUSÉ, pas assaini", () => {
    for (const titre of [
      "<script>alert(1)</script>",
      "Factures <img src=x onerror=alert(1)>",
      "<a href=\"javascript:alert(1)\">cliquer</a>",
    ]) {
      const v = compiler({ blocs: blocs("table"), racine: { forme: "SECTION", titre, enfants: [feuille(0)] } }, KINDS);
      expect(v.ok, titre).toBe(false);
      expect(v.problemes[0]!.motif).toBe("BALISAGE");
      // La raison dit les DEUX origines possibles — un modèle, ou un contenu injecté.
      expect(v.problemes[0]!.explication).toMatch(/contenu injecté/i);
    }
  });

  it("un bloc que l'écran ne sait pas rendre est refusé, en le nommant", () => {
    const v = compiler({ blocs: blocs("licorne"), racine: { forme: "LIGNES", enfants: [feuille(0)] } }, KINDS);
    expect(v.ok).toBe(false);
    expect(v.problemes[0]!.motif).toBe("BLOC_INCONNU");
    expect(v.problemes[0]!.explication).toMatch(/la composition est libre, le rendu ne l'est pas/i);
  });

  it("le refus dit OÙ, par un chemin lisible — pas par un index nu", () => {
    const v = compiler({
      blocs: blocs("table", "licorne"),
      racine: { forme: "COLONNES", enfants: [feuille(0), { forme: "SECTION", titre: "x", enfants: [feuille(1)] }] },
    }, KINDS);
    expect(v.problemes[0]!.ou).toBe("racine > colonnes[1] > section[0]");
  });

  it("un arbre trop gros est refusé — il ne casse pas le rendu, il fige le navigateur", () => {
    let n: Noeud = feuille(0);
    for (let i = 0; i < PROFONDEUR_MAX + 3; i += 1) n = { forme: "SECTION", titre: `n${i}`, enfants: [n] };
    const v = compiler({ blocs: blocs("table"), racine: n }, KINDS);
    expect(v.ok).toBe(false);
    expect(v.problemes.some((x) => x.motif === "PROFONDEUR")).toBe(true);

    const large: Planche = {
      blocs: blocs("table"),
      racine: { forme: "LIGNES", enfants: Array.from({ length: ENFANTS_MAX + 5 }, () => feuille(0)) },
    };
    expect(compiler(large, KINDS).problemes.some((x) => x.motif === "TROP_D_ENFANTS")).toBe(true);

    const enorme: Planche = {
      blocs: blocs("table"),
      racine: {
        forme: "LIGNES",
        enfants: Array.from({ length: 20 }, () => ({
          forme: "LIGNES" as const, enfants: Array.from({ length: 20 }, () => feuille(0)),
        })),
      },
    };
    const ve = compiler(enorme, KINDS);
    expect(ve.problemes.some((x) => x.motif === "TROP_DE_NOEUDS")).toBe(true);
    expect(ve.noeuds).toBeGreaterThan(NOEUDS_MAX);
  });

  it("un contenant vide et une forme inventée sont refusés", () => {
    expect(compiler({ blocs: blocs("table"), racine: { forme: "SECTION", titre: "vide", enfants: [] } }, KINDS)
      .problemes[0]!.motif).toBe("CONTENANT_VIDE");
    expect(compiler({ blocs: blocs("table"), racine: { forme: "CAROUSEL" as never, enfants: [feuille(0)] } }, KINDS)
      .problemes[0]!.motif).toBe("FORME_INCONNUE");
    // Six contenants, et leur nombre ne grandit pas avec les besoins.
    expect(CONTENANTS).toHaveLength(6);
  });

  it("des onglets sans étiquettes sont refusés — un onglet sans nom ne s'ouvre jamais", () => {
    const v = compiler({
      blocs: blocs("table", "viz"),
      racine: { forme: "ONGLETS", etiquettes: ["seulement un"], enfants: [feuille(0), feuille(1)] },
    }, KINDS);
    expect(v.problemes[0]!.motif).toBe("ETIQUETTES_INCOHERENTES");
  });

  it("ACCENT met UNE chose en avant : deux accents n'accentuent plus rien", () => {
    const v = compiler({ blocs: blocs("viz", "viz"), racine: { forme: "ACCENT", enfants: [feuille(0), feuille(1)] } }, KINDS);
    expect(v.problemes[0]!.motif).toBe("TROP_D_ENFANTS");
  });

  it("un bloc orphelin est SIGNALÉ mais n'empêche pas d'afficher", () => {
    const v = compiler({ blocs: blocs("table", "viz"), racine: { forme: "LIGNES", enfants: [feuille(0)] } }, KINDS);
    // Un gaspillage, pas une faute de rendu : punir la personne pour une maladresse du
    // modèle serait pire que le gaspillage lui-même.
    expect(v.ok).toBe(true);
    expect(v.blocsOrphelins).toEqual([1]);
    expect(v.problemes[0]!.explication).toMatch(/n'est placé nulle part/i);
  });

  it("le repli garde le CONTENU quand l'agencement est refusé", () => {
    // Perdre la mise en page est une gêne ; perdre le résultat est une panne.
    const p = repli(blocs("table", "viz", "progress"), "les factures");
    const v = compiler(p, KINDS);
    expect(v.ok).toBe(true);
    expect(v.blocsOrphelins).toHaveLength(0);
    expect(v.profondeur).toBe(2);
  });

  it("la planche sait se dire à voix haute, et ce qu'elle dit vient de l'ARBRE", () => {
    const p: Planche = {
      intention: "l'état des factures",
      blocs: blocs("table", "viz", "viz"),
      racine: { forme: "SECTION", titre: "Hetero", enfants: [feuille(0), feuille(1), feuille(2)] },
    };
    const dit = raconter(p);
    expect(dit).toContain("l'état des factures");
    expect(dit).toContain("« Hetero »");
    expect(dit).toContain("2 viz"); // compté, pas répété
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// LES ANGLES
// ═══════════════════════════════════════════════════════════════════════════════════════════

const factures: Ligne[] = [
  { libelle: "F-001", fournisseur: "Hetero", date: "2026-01-12", montant: 120_000 },
  { libelle: "F-002", fournisseur: "Hetero", date: "2026-01-28", montant: 80_000 },
  { libelle: "F-003", fournisseur: "Cipla", date: "2026-02-03", montant: 250_000 },
  { libelle: "F-004", fournisseur: "Cipla", date: "2026-03-15", montant: 40_000 },
  { libelle: "F-005", fournisseur: "Hetero", date: "2026-03-20", montant: 1_900_000 },
  { libelle: "F-006", fournisseur: "Sun", date: null, montant: 60_000 },
];

describe("les angles — le même jeu de données, vu autrement, sans le relire", () => {
  it("grouper par valeur somme la mesure et trie par poids", () => {
    const v = regarder(factures, { angle: "PAR_VALEUR", champ: "fournisseur", mesure: "montant" });
    expect(v.groupes.map((g) => g.cle)).toEqual(["Hetero", "Cipla", "Sun"]);
    expect(v.groupes[0]!.somme).toBe(2_100_000);
    expect(v.total.lignes).toBe(6);
    expect(v.total.somme).toBe(2_450_000);
    expect(v.ecartees).toBeNull();
  });

  it("LA PROPRIÉTÉ QUI COMPTE : ce qui est écarté est compté ET expliqué", () => {
    const v = regarder(factures, { angle: "PAR_PERIODE", champ: "date", maille: "mois", mesure: "montant" });
    expect(v.ecartees).not.toBeNull();
    expect(v.ecartees!.combien).toBe(1);
    expect(v.ecartees!.pourquoi).toMatch(/sans date exploitable/i);
    // Et le total porte sur les lignes RETENUES, pas sur les lignes de départ.
    expect(v.total.lignes).toBe(5);
    expect(v.total.somme).toBe(2_390_000);
  });

  it("les périodes sortent dans l'ORDRE CHRONOLOGIQUE, pas alphabétique", () => {
    const v = regarder(factures, { angle: "PAR_PERIODE", champ: "date", maille: "mois" });
    // « avril » avant « janvier » serait le défaut classique d'un tri sur la chaîne.
    expect(v.groupes.map((g) => g.cle)).toEqual(["janvier 2026", "février 2026", "mars 2026"]);
  });

  it("une somme PARTIELLE vaut null plutôt qu'un nombre qui aurait l'air complet", () => {
    const trouees = [...factures, { libelle: "F-007", fournisseur: "Hetero", date: "2026-01-30" }];
    const v = regarder(trouees, { angle: "PAR_VALEUR", champ: "fournisseur", mesure: "montant" });
    const hetero = v.groupes.find((g) => g.cle === "Hetero")!;
    expect(hetero.n).toBe(4);
    expect(hetero.somme).toBeNull();
    expect(v.total.somme).toBeNull();
    expect(v.limites.join(" ")).toMatch(/une somme partielle aurait l'air complète/i);
  });

  it("un classement trie sur le nombre, décroissant par défaut", () => {
    const v = regarder(factures, { angle: "CLASSEMENT", champ: "montant", limite: 3 });
    expect(v.groupes.map((g) => g.cle)).toEqual(["F-005", "F-003", "F-001"]);
    // Le total reste celui de TOUS les groupes, pas des trois montrés.
    expect(v.total.lignes).toBe(6);
    expect(v.limites.join(" ")).toMatch(/le total ci-dessous porte sur TOUS les groupes/i);
  });

  it("un croisement demande les deux champs et écarte ce qui manque à l'un OU l'autre", () => {
    const v = regarder(factures, { angle: "CROISEMENT", champ: "fournisseur", champ2: "date" });
    expect(v.ecartees!.combien).toBe(1);
    expect(v.ecartees!.pourquoi).toMatch(/fournisseur.*date|date.*fournisseur/);
  });

  it("les écarts disent combien de lignes ORDINAIRES ils cachent", () => {
    const v = regarder(factures, { angle: "ECARTS", champ: "montant" });
    expect(v.groupes.map((g) => g.cle)).toContain("F-005");
    expect(v.limites.join(" ")).toMatch(/ligne\(s\) ordinaire\(s\) sont masquées/i);
    expect(v.limites.join(" ")).toMatch(/une ligne ordinaire n'est pas une ligne sans intérêt/i);
  });

  it("un angle porte TOUJOURS la limite qui dit qu'il ne relit rien", () => {
    for (const a of ANGLES) {
      const v = regarder(factures, { angle: a, champ: a === "PAR_PERIODE" ? "date" : a === "CROISEMENT" ? "fournisseur" : "montant", champ2: "date" });
      expect(v.limites[0], a).toMatch(/un angle ne relit rien/i);
    }
  });

  it("les angles PROPOSÉS écartent ce qui n'informe pas : un seul groupe, ou autant que de lignes", () => {
    const plates = Array.from({ length: 10 }, (_, i) => ({ pareil: "X", unique: `u${i}`, montant: i * 100, quand: `2026-0${(i % 9) + 1}-01` }));
    const props = anglesUtiles(plates, ["pareil", "unique", "montant", "quand"]);
    const champs = props.map((p) => p.champ);
    // « pareil » : un seul groupe — ce n'est pas un angle.
    expect(champs).not.toContain("pareil");
    // « unique » : autant de groupes que de lignes — pas un angle non plus.
    expect(champs).not.toContain("unique");
    // Le numérique donne un classement (et des écarts au-delà de 8 lignes), la date une période.
    expect(props.some((p) => p.champ === "montant" && p.angle === "CLASSEMENT")).toBe(true);
    expect(props.some((p) => p.champ === "montant" && p.angle === "ECARTS")).toBe(true);
    expect(props.some((p) => p.champ === "quand" && p.angle === "PAR_PERIODE")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// LA FRONTIÈRE AVEC L'ÉCRAN — le test qui empêche la liste de dériver en silence
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("la liste des blocs rendus colle à ce que l'écran sait VRAIMENT rendre", () => {
  it("aucun kind déclaré n'est absent du composant, et réciproquement", async () => {
    // On lit le VRAI composant plutôt qu'une constante partagée : une constante partagée
    // dirait la même chose des deux côtés et ne prouverait rien. Ce que ce test attrape est
    // précisément l'écart — un `composer_planche` qui accepte un bloc que l'écran ne connaît
    // pas affiche un TROU là où le compilateur avait dit oui, et personne ne cherche du côté
    // du compilateur quand un bloc manque.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/platform/ia/ecrans/blocks.tsx", "utf8");
    const bloc = /const RENDERERS[^{]*\{([\s\S]*?)\n\};/.exec(src);
    expect(bloc, "la table RENDERERS a changé de forme — ce test doit être relu, pas supprimé").toBeTruthy();

    const reels = new Set(
      [...bloc![1]!.matchAll(/^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm)].map((m) => m[1]!),
    );
    expect(reels.size, "aucun renderer trouvé : l'expression de lecture est à revoir").toBeGreaterThan(10);

    const { KINDS_RENDUS } = await import("@/lib/assistant/planche-tools");
    const declaresEnTrop = [...KINDS_RENDUS].filter((k) => !reels.has(k));
    const reelsOublies = [...reels].filter((k) => !KINDS_RENDUS.has(k));

    expect(declaresEnTrop, "déclarés rendables mais absents du composant : la planche afficherait un trou").toEqual([]);
    expect(reelsOublies, "rendus par le composant mais refusés à la composition : une capacité perdue pour rien").toEqual([]);
  });
});

describe("mesures consignées — mandat 7", () => {
  const SRC = "lib/planche/planche.test.ts";
  it("composition libre, rendu fermé, repli qui garde le fond, angles honnêtes", async () => {
    const balise = compiler({ blocs: blocs("table"), racine: { forme: "SECTION", titre: "<script>x</script>", enfants: [feuille(0)] } }, KINDS);
    const inconnu = compiler({ blocs: blocs("licorne"), racine: { forme: "LIGNES", enfants: [feuille(0)] } }, KINDS);
    consignerMesure("composition_libre_rendu_ferme", { n: 2, ok: (balise.ok ? 0 : 1) + (inconnu.ok ? 0 : 1) },
      SRC, "un titre balisé et un bloc inconnu sont refusés, nommément");

    const secours = repli(blocs("table", "viz", "progress"), "les factures");
    consignerMesure("agencement_refuse_garde_le_fond", { n: 1, ok: compiler(secours, KINDS).ok && secours.blocs.length === 3 ? 1 : 0 },
      SRC, "3 blocs préservés dans une pile quand l'agencement est refusé");

    const v = regarder(factures, { angle: "PAR_PERIODE", champ: "date", maille: "mois", mesure: "montant" });
    consignerMesure("angle_dit_ce_qu_il_ecarte", { n: 1, ok: v.ecartees?.combien === 1 && v.total.lignes === 5 ? 1 : 0 },
      SRC, `${v.total.lignes} retenues, ${v.ecartees?.combien ?? 0} écartée(s) ${v.ecartees?.pourquoi ?? ""}`);

    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/platform/ia/ecrans/blocks.tsx", "utf8");
    const b = /const RENDERERS[^{]*\{([\s\S]*?)\n\};/.exec(src);
    const reels = new Set([...(b?.[1] ?? "").matchAll(/^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm)].map((m) => m[1]!));
    const { KINDS_RENDUS } = await import("@/lib/assistant/planche-tools");
    const aligne = [...KINDS_RENDUS].every((k) => reels.has(k)) && [...reels].every((k) => KINDS_RENDUS.has(k));
    consignerMesure("blocs_rendus_sans_derive", { n: 1, ok: aligne ? 1 : 0 }, SRC, `${reels.size} blocs rendus, liste alignée`);
  });
});
