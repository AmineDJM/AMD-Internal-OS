import { Prisma } from "@prisma/client";

/**
 * QUI TIENT UN FICHIER — lu dans le SCHÉMA, jamais dans une liste écrite à la main.
 *
 * Le ramasse-miettes ne connaissait que deux tables (`FileVersion`, `StoredFile`) quand onze
 * autres désignent aussi un `FileBlob` : pièces de messagerie, documents RH, pièces Regulatory,
 * rapports terrain, papier en-tête… (audit du 04/10, constat 2). Une purge lancée ce jour-là
 * aurait détruit leurs octets — et la fiche serait restée, pointant vers un fichier disparu.
 * Une liste tenue à la main est fausse le jour où quelqu'un ajoute une colonne, EN SILENCE
 * (§118.73) : on la DÉRIVE donc du schéma.
 *
 * Deux sortes de détenteurs :
 *   • les COLONNES — tout champ texte dont le nom finit par `blobId` (`blobId`, `audioBlobId`,
 *     `originalZipBlobId`, `letterBlobId`…), sauf les tranches d'un blob (`FileBlobChunk`), qui
 *     ne le tiennent pas : elles en font partie et tombent avec lui ;
 *   • le JSON — un logo de marque garde son `blobId` dans un réglage, une ligne de la corbeille
 *     garde celui de la pièce qu'elle restaurera. Toute colonne JSON est lue, et toute clé qui
 *     finit par `blobId` y compte.
 *
 * Module serveur (il lit le DMMF de Prisma) — ni base, ni réseau : il ne fait que construire.
 */

const EXCLUS = new Set(["FileBlob", "FileBlobChunk"]);
const NOM_DE_REFERENCE = /blobid$/i;

export interface ColonneRef { table: string; colonne: string }

const MODELES = Prisma.dmmf.datamodel.models;

/** Les colonnes scalaires qui désignent un FileBlob, dérivées du schéma. */
export const COLONNES_BLOB: readonly ColonneRef[] = MODELES
  .filter((m) => !EXCLUS.has(m.name))
  .flatMap((m) => m.fields
    .filter((f) => f.kind === "scalar" && f.type === "String" && NOM_DE_REFERENCE.test(f.name))
    .map((f) => ({ table: m.dbName ?? m.name, colonne: f.dbName ?? f.name })));

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/**
 * Une ligne CLOSE ne tient plus rien : une entrée de corbeille détruite (`purgedAt`) a rendu ses octets,
 * une entrée restaurée (`restoredAt`) a rendu la main aux lignes recréées, qui les tiennent par colonne.
 * Sans ce filtre, détruire une entrée ne pouvait plus jamais libérer ce que son propre lot citait.
 */
const CHAMPS_DE_CLOTURE = ["purgedAt", "restoredAt"];

export interface ColonneJson extends ColonneRef {
  /** Fragment SQL (alias `t`) qui écarte les lignes closes ; vide si le modèle n'en a pas. */
  ouverte: string;
}

/** Toutes les colonnes JSON du schéma — un `blobId` peut y vivre (marque, corbeille…). */
export const COLONNES_JSON: readonly ColonneJson[] = MODELES
  .flatMap((m) => {
    const ouverte = m.fields
      .filter((f) => f.kind === "scalar" && f.type === "DateTime" && CHAMPS_DE_CLOTURE.includes(f.name))
      .map((f) => ` AND t.${q(f.dbName ?? f.name)} IS NULL`).join("");
    return m.fields
      .filter((f) => f.kind === "scalar" && f.type === "Json")
      .map((f) => ({ table: m.dbName ?? m.name, colonne: f.dbName ?? f.name, ouverte }));
  });

/**
 * Fragment SQL : « aucune colonne ne désigne ce blob » (`alias` = l'alias de `FileBlob`).
 * Les identifiants viennent du schéma, jamais d'une saisie : ils sont cités, pas paramétrés.
 */
export function sqlAucuneColonneNeLeTient(alias = "b"): Prisma.Sql {
  if (COLONNES_BLOB.length === 0) return Prisma.sql`TRUE`;
  const clauses = COLONNES_BLOB.map(({ table, colonne }) =>
    `NOT EXISTS (SELECT 1 FROM ${q(table)} r WHERE r.${q(colonne)} = ${q(alias)}.id)`);
  return Prisma.raw(`(${clauses.join(" AND ")})`);
}

/**
 * Requête unique qui rend les identifiants de blob cités dans une colonne JSON. Une passe par
 * table : le texte du JSON est lu une fois, et seules les clés qui finissent par `blobId`
 * comptent — un identifiant cité ailleurs (un commentaire, un message) n'en fait pas un détenteur.
 */
export function sqlBlobsCitesEnJson(): Prisma.Sql | null {
  if (COLONNES_JSON.length === 0) return null;
  const parts = COLONNES_JSON.map(({ table, colonne, ouverte }) =>
    `SELECT m[1] AS id FROM ${q(table)} t, regexp_matches(t.${q(colonne)}::text, '"[A-Za-z_]*[bB]lob[iI]d"\\s*:\\s*"([^"]+)"', 'g') m WHERE t.${q(colonne)} IS NOT NULL${ouverte}`);
  return Prisma.raw(`SELECT DISTINCT id FROM (${parts.join(" UNION ALL ")}) x`);
}

/**
 * Fragment SQL : « aucun JSON ouvert ne cite ce blob » (`alias` = l'alias de `FileBlob`) — la même règle
 * que `sqlBlobsCitesEnJson`, bornée à UN blob, pour le DELETE de `releaseBlob` (audit Drive du 24/11, A6).
 * `strpos` écarte d'abord, à peu de frais, les lignes qui ne contiennent pas l'identifiant ; seule une
 * clé qui finit par `blobId` compte ensuite. Les identifiants de blob sont des cuid (ni guillemet ni
 * métacaractère d'expression régulière).
 */
export function sqlAucunJsonNeLeCite(alias = "b"): Prisma.Sql {
  if (COLONNES_JSON.length === 0) return Prisma.sql`TRUE`;
  const id = `${q(alias)}.id`;
  const clauses = COLONNES_JSON.map(({ table, colonne, ouverte }) => {
    const texte = `t.${q(colonne)}::text`;
    return `EXISTS (SELECT 1 FROM ${q(table)} t WHERE t.${q(colonne)} IS NOT NULL${ouverte}`
      + ` AND strpos(${texte}, ${id}) > 0 AND ${texte} ~ ('"[A-Za-z_]*[bB]lob[iI]d"\\s*:\\s*"' || ${id} || '"'))`;
  });
  // Dans une sous-requête SCALAIRE : écrits en `NOT EXISTS` au niveau du WHERE, ces ~250 tests devenaient
  // des anti-jointures, et le planificateur passait près d'une demi-seconde à les ordonner (mesuré) à chaque
  // libération. Ici chacun reste un sous-plan, évalué dans l'ordre, et le premier qui trouve arrête tout.
  return Prisma.raw(`(SELECT NOT (${clauses.join(" OR ")}))`);
}
