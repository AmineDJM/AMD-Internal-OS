/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES AJUSTEMENTS DES BC ET DES FACTURES (Direction, 10/2026) — LEURS POINTS D'APPEL, À L'ENDROIT EXACT.
 *
 * Titre au centre, numérotation à partir de 032, bleu canard, case des taxes, classeur Excel, aperçu avant impression : chaque
 * brique a son banc (corps de la règle, base réelle). Aucun ne dit qu'elle est APPELÉE là où une personne la rencontre — c'est
 * la question de §118.49 : un test qui vérifie le corps d'une fonction sans son appelant ne teste rien. Ces cas lisent la
 * SOURCE sans ses commentaires (la prose qui décrit une forme n'est pas la forme, §118.79d) et exigent chaque appel, dans son
 * ordre quand l'ordre est la garde (la porte avant le rendu, la lecture avant l'écriture).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/** La source SANS ses commentaires : les blocs, puis les lignes (jamais le `//` d'une adresse : il suit un deux-points). */
function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}
const lire = (rel: string): string => sansCommentaires(readFileSync(path.join(process.cwd(), rel), "utf8"));
/** Le corps d'une fonction exportée : de sa signature à la suivante (ou à la fin du fichier). */
function corpsDe(src: string, nom: string): string {
  const debut = src.indexOf(`export async function ${nom}`);
  expect(debut, `${nom} introuvable`).toBeGreaterThan(-1);
  const suite = src.indexOf("\nexport ", debut + 10);
  return src.slice(debut, suite === -1 ? undefined : suite);
}

describe("la route du classeur Excel — la porte avant le rendu, le motif avant le fichier", () => {
  const route = lire("src/app/api/legal/[id]/fichier/route.ts");
  const branche = route.slice(route.indexOf('if (format === "xlsx")'), route.indexOf("const fichier = await fichierEmisDeLaPiece"));

  it("identité, puis porte de la PIÈCE, puis rendu : `getCurrentUser` → `specDeLaPieceEmise` → `construireXlsxCommercial`", () => {
    const iUser = route.indexOf("getCurrentUser()");
    const iSpec = route.indexOf("specDeLaPieceEmise(user");
    const iBuild = route.indexOf("construireXlsxCommercial(spec");
    expect(iUser).toBeGreaterThan(-1);
    expect(iSpec).toBeGreaterThan(iUser);
    expect(iBuild).toBeGreaterThan(iSpec);
    expect(route).toMatch(/if \(!user\) return new NextResponse\(null, \{ status: 401 \}\)/);
  });

  it("un refus de la porte et une absence rendent la MÊME réponse (404) ; un classeur qui ne retombe pas sur les totaux n'est pas livré (422)", () => {
    expect(branche).toMatch(/if \(!spec\) return new NextResponse\(null, \{ status: 404 \}\)/);
    expect(branche).toMatch(/!classeur\.verification\.ok[\s\S]{0,320}status: 422/);
    // Le classeur n'est jamais servi avant son contrôle : la réponse 200 vient APRÈS le 422.
    expect(branche.indexOf("status: 422")).toBeLessThan(branche.indexOf("new Uint8Array(classeur.octets)"));
  });

  it("le téléchargement est tracé (EXPORT, au nom de la personne) et le seul `dl=1` le déclenche", () => {
    const iDl = branche.indexOf('get("dl") === "1"');
    const iAudit = branche.indexOf("recordAudit(");
    expect(iDl).toBeGreaterThan(-1);
    expect(iAudit).toBeGreaterThan(iDl);
    expect(branche).toMatch(/action: "EXPORT"[\s\S]*Export Excel de la pièce/);
    expect(branche).toContain("spreadsheetml.sheet");
    expect(branche).toMatch(/Cache-Control": "private, no-store"/);
  });
});

describe("la case « taxe supplémentaire » du matériel promotionnel — lue par la génération ET par la modification", () => {
  const promo = lire("src/lib/actions/promo-execution-actions.ts");

  it("un seul lecteur, local (un fichier « use server » n'exporte que des fonctions asynchrones)", () => {
    expect(promo).toMatch(/\nfunction lireTaxeSupplementaire\(/);
    expect(promo).not.toMatch(/export (async )?function lireTaxeSupplementaire/);
  });

  it("la génération lit la case et la préfère à celle du devis QUAND elle est renseignée — vide, le devis garde la sienne", () => {
    const corps = corpsDe(promo, "genererBonsDeCommandePromo");
    expect(corps).toContain("lireTaxeSupplementaire(formData)");
    // La préférence vit chez l'écrivain unique des BC (manuel ET automatique) : l'action lui passe la case.
    expect(corps).toMatch(/taxe: taxeSaisie\.taxe/);
    const auto = lire("src/lib/promo-automatismes.ts");
    expect(auto).toMatch(/o\.taxe !== undefined\s*\?\s*\(o\.taxe \? \[o\.taxe\] : null\)/);
  });

  it("la modification lit la même case : « 0 » la retire, vide la garde, le libellé stocké survit à un changement de taux seul", () => {
    const corps = corpsDe(promo, "modifierBonDeCommandePromo");
    expect(corps).toContain("lireTaxeSupplementaire(formData)");
    expect(corps).toMatch(/taxeSaisie\.taxe === null\) taxes = \[\]/);
    expect(corps).toContain("taxeSaisie.libelleSaisi === undefined");
  });

  it("l'écran la montre aux DEUX endroits : le formulaire de génération (toujours visible) et celui de modification du BC", () => {
    const carte = lire("src/app/(app)/promo-material/[id]/execution-card.tsx");
    expect(carte.match(/name="extraTaxLabel"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(carte.match(/name="extraTaxRate"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // Le lien « Excel » de la ligne du BC passe par le MÊME constructeur d'adresse que Word et PDF (`lienFichierEmis`).
    expect(carte).toContain('lienFichierEmis(bc.id, "xlsx", true)');
  });
});

describe("le composeur de pièces — taxes, numérotation, aperçu avant impression, classeur", () => {
  const composeur = lire("src/components/pieces/composer-piece.tsx");

  it("une ligne de taxe est TOUJOURS là au départ : la case ne se cherche pas derrière un bouton « Ajouter »", () => {
    // Hors révision (une pièce rouverte reprend SES taxes), le composeur part d'une ligne de taxe vide.
    expect(composeur).toMatch(/useState<Taxe\[\]>\(\(\) => \([^\n]*: \[\{ id: 0, libelle: "", taux: "" \}\]\)\)/);
    expect(composeur).toContain("Taxes supplémentaires");
    expect(composeur).toContain("Taxe Pub 2 %");
  });

  it("l'aperçu avant impression APPELLE l'action et rend un PDF dans la page ; il se ferme dès que le formulaire change", () => {
    expect(composeur).toMatch(/await apercuAvantImpressionPiece\(undefined, fd\)/);
    expect(composeur).toMatch(/<object data=\{impression\.url\} type="application\/pdf"/);
    expect(composeur).toContain("Aperçu avant impression");
    expect(composeur).toMatch(/URL\.revokeObjectURL/);
  });

  it("le premier numéro de l'année se règle depuis le panneau de numérotation, et ne part QUE quand il est rempli", () => {
    expect(composeur).toContain("Premier numéro de ${champs.date.slice(0, 4)}");
    expect(composeur).toMatch(/depart/);
    expect(composeur).toMatch(/reglerNumerotationPieces/);
  });

  it("la pièce émise offre « Générer sur Excel » — la route du classeur, en téléchargement", () => {
    expect(composeur).toMatch(/\/fichier\?format=xlsx&dl=1`\}>Générer sur Excel</);
  });

  it("la fiche Legal offre le même lien, à côté du PDF et du Word", () => {
    const fiche = lire("src/app/(app)/legal/[id]/page.tsx");
    expect(fiche).toContain('lienFichierEmis(doc.id, "xlsx", true)');
    expect(fiche).toMatch(/Générer \$\{emise\.numero\} sur Excel/);
  });
});

describe("la fabrique — le titre, le plancher de numérotation, la couleur de la révision", () => {
  const build = lire("src/lib/artifact/factory/build.ts");
  const fabrique = lire("src/platform/in-process/artifact/factory.ts");

  it("le titre vient AVANT « B.C : N° … », au centre, en gras, à l'accent — et dit DEVIS pour un devis", () => {
    const iTitre = build.indexOf('paragraphe(estDevis ? "DEVIS" : "BON DE COMMANDE", { alignement: "center", gras: true');
    const iRef = build.indexOf('{ texte: estDevis ? "DEVIS" : "B.C"');
    expect(iTitre).toBeGreaterThan(-1);
    expect(iRef).toBeGreaterThan(iTitre);
    expect(build.slice(iTitre, iTitre + 200)).toContain("couleur: accent");
  });

  it("l'aperçu et l'émission lisent le MÊME plancher (`departDe`), et le compteur ne recule jamais (`GREATEST`)", () => {
    expect(fabrique).toMatch(/prochaineSequence\(seq\?\.last \?\? 0, departDe\(profil\.reglages\.numerotationDepart, type, anneeSure\)\)/);
    expect(fabrique).toMatch(/attribuerNumero\(tx, profil\.societe\.id, kind, annee, departDe\(profil\.reglages\.numerotationDepart, type, annee\)\)/);
    expect(fabrique).toMatch(/GREATEST\("DocumentSequence"\."last" \+ 1, \$\{depart\}::int\)/);
  });

  it("une révision repeint l'accent d'après la charte d'AUJOURD'HUI — jamais celui, périmé, de la pièce", () => {
    const revision = fabrique.slice(fabrique.indexOf("export async function reviserDocumentDrive"));
    // La révision et son aperçu composent par la MÊME fonction (`specRevisee`) : c'est elle qui repeint.
    // Depuis le numéro modifiable (88fc0715, 5d6adbf6), elle compose d'abord SANS numéro, puis pose le numéro jugé. Seule
    // exception, décidée par la Direction (14/10) : « seul le numéro change » régénère la pièce TELLE QU'ENREGISTRÉE.
    const avantRegles = revision.slice(0, revision.indexOf("const regles = verifierSpecCommerciale"));
    expect(avantRegles).toContain("const specSansNumero = specRevisee(f, m, p.profil)");
    expect(avantRegles).toContain("const spec: SpecDocumentCommercial = numeroSeul ? { ...f.spec, numero } : { ...specSansNumero, numero }");
    const compose = fabrique.slice(fabrique.indexOf("function specRevisee("), fabrique.indexOf("type ProfilCharge"));
    expect(compose).toContain("couleur: p.societe.couleur");
  });

  it("la pastille de la société ne colore plus rien : la charte ne lit que la marque, puis le bleu canard", () => {
    const modele = lire("src/lib/brand/model.ts");
    expect(modele).toMatch(/const accentMarque = marque\.couleurs\.accent;\s*const accent = accentMarque \?\? ACCENT_DEFAUT;/);
    expect(modele).toMatch(/export function charteDe\(marque: Marque\): Charte/);
    expect(modele).not.toMatch(/pastille|couleurSociete|Company\.color/);
  });
});
