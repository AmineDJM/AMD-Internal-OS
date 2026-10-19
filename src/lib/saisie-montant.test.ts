import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN MONTANT RECOPIÉ D'UNE PIÈCE NE S'ARRONDIT PAS AU MILLIER PAR LE NAVIGATEUR.
 *
 * LE DÉFAUT MESURÉ : le montant d'un devis de prise en charge portait `step="1000"`. Un devis
 * fournisseur de 452 300 DZD était REFUSÉ par le navigateur (« veuillez saisir une valeur
 * valide »), et la personne n'avait que deux issues fausses : arrondir le devis — donc engager
 * un montant que personne n'a chiffré —, ou renoncer. Le même pas se tenait sur le montant
 * estimé d'un poste Ad & Pro (ajout ET correction) et sur le montant accordé d'un poste. Les
 * colonnes sont des `Decimal(14, 2)` : la base accepte les centimes, l'écran refusait les
 * dizaines.
 *
 * Un PAS est une contrainte de saisie : il ne guide pas, il REFUSE tout ce qui n'en est pas un
 * multiple. Sur un montant copié depuis un devis, un bon de commande ou une facture, la seule
 * granularité juste est celle de la monnaie (le centime).
 *
 * ── CE QUE LA RÈGLE NE VISE PAS ─────────────────────────────────────────────────────────
 *
 * Les SEUILS (`adProDgThreshold`, `bcValidationThreshold`, le franchissement automatique d'une
 * étape) : ce sont des valeurs de POLITIQUE posées par un administrateur, pas des montants lus
 * sur une pièce — un pas au millier y guide sans rien refuser à personne. Le détecteur ne les
 * reconnaît pas comme montants (leur nom dit « Threshold », et le seuil d'une étape n'a ni nom
 * ni libellé de montant) ; un cas plus bas le vérifie.
 *
 * Ce banc s'arme sur un fait du CODE (§118.17) — une balise `<input>` dont le NOM ou le libellé
 * accessible dit « montant » — et non sur une liste écrite à la main : un montant ajouté demain
 * avec un pas au millier tombe sans que personne ait pensé à lui. Les commentaires sont retirés
 * avant de juger (§118.79d).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const RACINES = ["src/app", "src/components"];

function ecrans(): string[] {
  const out: string[] = [];
  const marche = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) marche(p);
      else if (e.name.endsWith(".tsx") && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  for (const r of RACINES) marche(join(process.cwd(), r));
  return out;
}

/** Retire les commentaires de bloc (JSX compris) et les commentaires de LIGNE (en début de ligne). */
function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
}

/** Chaque balise `<input …>` / `<Input …>` — accolades et guillemets suivis, pour qu'une flèche `=>` ne la coupe pas. */
function balises(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/<(?:input|Input)\b/g)) {
    let profondeur = 0;
    let guillemet: string | null = null;
    let j = (m.index ?? 0) + m[0].length;
    for (; j < src.length; j++) {
      const c = src[j];
      if (guillemet) { if (c === guillemet) guillemet = null; continue; }
      if (c === '"' || c === "'" || c === "`") { guillemet = c; continue; }
      if (c === "{") profondeur++;
      else if (c === "}") profondeur--;
      else if (c === ">" && profondeur === 0) break;
    }
    out.push(src.slice(m.index ?? 0, j + 1));
  }
  return out;
}

/** Valeur d'un attribut : `="…"`, `='…'`, `={"…"}`, `={`…`}` ou `={1000}`. */
function attribut(balise: string, nom: string): string | null {
  const m = balise.match(new RegExp(
    `(?:^|\\s)${nom}=(?:"([^"]*)"|'([^']*)'|\\{\\s*["']([^"']*)["']\\s*\\}|\\{\\s*\`([^\`]*)\`\\s*\\}|\\{\\s*([0-9.]+)\\s*\\})`,
  ));
  return m ? (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? null) : null;
}

/** Un champ de MONTANT : son nom ou son libellé accessible le dit — jamais un seuil. */
function estUnMontant(balise: string): boolean {
  const nom = attribut(balise, "name") ?? "";
  const libelle = attribut(balise, "aria-label") ?? "";
  if (/threshold|seuil/i.test(`${nom} ${libelle}`)) return false;
  return /amount|montant|prix|price/i.test(nom) || /montant|prix/i.test(libelle);
}

/** Un pas qui refuse une saisie au dinar près : un nombre STRICTEMENT supérieur à l'unité. */
function pasGrossier(balise: string): string | null {
  const pas = attribut(balise, "step");
  if (pas === null || !/^[0-9]+(?:\.[0-9]+)?$/.test(pas)) return null;
  return Number(pas) > 1 ? pas : null;
}

describe("un montant recopié d'une pièce se saisit au centime, pas au millier", () => {
  const fichiers = ecrans().map((f) => ({ f: relative(process.cwd(), f).replace(/\\/g, "/"), src: sansCommentaires(readFileSync(f, "utf8")) }));
  const toutes = fichiers.flatMap(({ f, src }) => balises(src).map((b) => ({ f, b })));
  const montants = toutes.filter(({ b }) => estUnMontant(b));

  it("la prémisse : les écrans sont lus et leurs champs de montant reconnus", () => {
    // Sans elle, un balayage cassé — ou un détecteur qui ne reconnaît plus rien — rendrait le cas
    // suivant vert sur du vide (§118.17). Mesuré à l'écriture : 1 016 balises, 42 montants.
    expect(fichiers.length).toBeGreaterThan(200);
    expect(toutes.length).toBeGreaterThan(800);
    expect(montants.length).toBeGreaterThan(30);
  });

  it("AUCUN champ de montant ne porte un pas au-delà de l'unité", () => {
    const fautifs = montants
      .filter(({ b }) => pasGrossier(b) !== null)
      .map(({ f, b }) => `${f} — ${(attribut(b, "name") ?? attribut(b, "aria-label") ?? "?")} step=${pasGrossier(b)}`);
    expect(
      fautifs,
      `ces montants refusent tout ce qui n'est pas un multiple de leur pas — un devis de 452 300 DZD ne passerait pas ; écrire step="0.01" :\n${fautifs.join("\n")}`,
    ).toEqual([]);
  });

  it("les quatre montants réparés se saisissent au centime — et restent des montants pour le détecteur", () => {
    // Le cas qui le ferait tomber : un champ réparé qui perd son nom ou son libellé et sort du
    // détecteur générique — il pourrait alors reprendre un pas au millier sans que rien ne le voie.
    const attendus: { fichier: string; designe: (b: string) => boolean; quoi: string }[] = [
      { fichier: "src/components/care/care-panel.tsx", designe: (b) => attribut(b, "name") === "amountDzd", quoi: "montant d'un devis de prise en charge" },
      { fichier: "src/components/ad-pro/items-panel.tsx", designe: (b) => attribut(b, "name") === "amountEstimated", quoi: "montant estimé d'un poste (ajout et correction)" },
      { fichier: "src/components/ad-pro/items-panel.tsx", designe: (b) => (attribut(b, "aria-label") ?? "").startsWith("Montant affecté au poste"), quoi: "montant accordé d'un poste" },
    ];
    for (const a of attendus) {
      const trouves = toutes.filter(({ f, b }) => f === a.fichier && a.designe(b));
      expect(trouves.length, `${a.quoi} : introuvable dans ${a.fichier}`).toBeGreaterThan(0);
      for (const { b } of trouves) {
        expect(estUnMontant(b), `${a.quoi} : le détecteur ne le reconnaît plus comme montant`).toBe(true);
        expect(attribut(b, "step"), `${a.quoi} : pas attendu au centime`).toBe("0.01");
      }
    }
    // Ajout ET correction d'un poste : DEUX champs `amountEstimated`, pas un.
    expect(toutes.filter(({ f, b }) => f === "src/components/ad-pro/items-panel.tsx" && attribut(b, "name") === "amountEstimated").length).toBe(2);
  });

  it("le détecteur dit NON quand il le faut, dans les deux sens", () => {
    // Un montant au millier tombe ; le même au centime, ou sans pas, passe ; un SEUIL au millier
    // n'est pas un montant. Sans ces témoins, un détecteur qui rendrait « faux » partout
    // passerait pour armé.
    expect(pasGrossier(`<input name="amountDzd" type="number" step="1000" />`)).toBe("1000");
    expect(pasGrossier(`<input name="amountDzd" type="number" step={1000} />`)).toBe("1000");
    expect(pasGrossier(`<input name="amountDzd" type="number" step="0.01" />`)).toBeNull();
    expect(pasGrossier(`<input name="amountDzd" type="number" step="any" />`)).toBeNull();
    expect(pasGrossier(`<input name="amountDzd" type="number" />`)).toBeNull();
    expect(estUnMontant(`<input name="amountEstimated" type="number" />`)).toBe(true);
    expect(estUnMontant(`<input aria-label={\`Montant affecté au poste \${id}\`} type="number" />`)).toBe(true);
    expect(estUnMontant(`<Input name="adProDgThreshold" type="number" step="1000" />`)).toBe(false);
    // Un seuil exprimé en DZD reste une POLITIQUE, même quand son nom dit « montant ».
    expect(estUnMontant(`<Input name="seuilMontant" type="number" step="1000" />`)).toBe(false);
    expect(estUnMontant(`<input name="quantity" type="number" step="1" />`)).toBe(false);
    // Une flèche dans un attribut ne coupe pas la balise : le pas qui la suit est bien lu.
    expect(balises(`<input onChange={(e) => go(e)} name="amountDzd" step="1000" />`)).toHaveLength(1);
    expect(pasGrossier(balises(`<input onChange={(e) => go(e)} name="amountDzd" step="1000" />`)[0])).toBe("1000");
  });
});
