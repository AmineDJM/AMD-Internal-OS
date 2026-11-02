/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DÉRIVE SCHÉMA ↔ BASE, EN ÉCARTS NOMMÉS (refonte P0, docs/architecture/refonte-p0-outillage.md).
 *
 * `prisma migrate diff --from-url <base migrée> --to-schema-datamodel prisma/schema.prisma
 * --script` rend le SQL qu'il faudrait jouer pour que la base ressemble au schéma. Ce SQL n'est
 * pas comparable tel quel d'une exécution à l'autre : l'ordre des tables et le regroupement des
 * clauses d'un même `ALTER TABLE` changent dès qu'un modèle est ajouté ailleurs. On le découpe
 * donc en ÉCARTS ATOMIQUES, chacun sous une clé stable (`index:Nom:DROP`, `defaut:Table.col:DROP`…),
 * et c'est l'ensemble de ces clés qu'on compare à la liste des exceptions connues.
 *
 * Module PUR (aucun import) : il se teste sans base.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type FamilleEcart =
  | "defaut" // ALTER COLUMN … SET/DROP DEFAULT
  | "colonne" // ADD/DROP COLUMN, changement de type, de nullabilité
  | "table" // CREATE/DROP TABLE
  | "index" // CREATE/DROP/RENAME INDEX
  | "fk" // ADD/DROP CONSTRAINT … FOREIGN KEY
  | "contrainte" // autre contrainte (clé primaire, unicité nommée…)
  | "type" // CREATE/ALTER/DROP TYPE (enums)
  | "autre"; // tout ce que l'analyseur ne sait pas nommer — jamais toléré par règle

export type Ecart = {
  /** Clé stable, comparée aux exceptions. */
  cle: string;
  famille: FamilleEcart;
  /** La clause SQL d'origine (pour le message d'échec). */
  sql: string;
};

const ident = String.raw`"([^"]+)"`;

/** Retire les commentaires `-- …` et découpe en instructions terminées par `;`. */
export function instructions(script: string): string[] {
  const sansCommentaires = script
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
  return sansCommentaires
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Découpe les clauses d'un `ALTER TABLE "T" a, b, c` (virgules hors parenthèses et guillemets). */
function clauses(corps: string): string[] {
  const out: string[] = [];
  let prof = 0;
  let guillemet = false;
  let apostrophe = false;
  let courant = "";
  for (const c of corps) {
    if (c === '"' && !apostrophe) guillemet = !guillemet;
    else if (c === "'" && !guillemet) apostrophe = !apostrophe;
    else if (!guillemet && !apostrophe) {
      if (c === "(") prof++;
      else if (c === ")") prof--;
      else if (c === "," && prof === 0) {
        out.push(courant.trim());
        courant = "";
        continue;
      }
    }
    courant += c;
  }
  if (courant.trim()) out.push(courant.trim());
  return out;
}

function ecartAlterTable(table: string, clause: string): Ecart {
  let m: RegExpMatchArray | null;
  if ((m = clause.match(new RegExp(`^ALTER COLUMN ${ident} DROP DEFAULT$`))))
    return { cle: `defaut:${table}.${m[1]}:DROP`, famille: "defaut", sql: clause };
  if ((m = clause.match(new RegExp(`^ALTER COLUMN ${ident} SET DEFAULT (.+)$`))))
    return { cle: `defaut:${table}.${m[1]}:SET ${m[2]}`, famille: "defaut", sql: clause };
  if ((m = clause.match(new RegExp(`^DROP COLUMN ${ident}$`))))
    return { cle: `colonne:${table}.${m[1]}:DROP`, famille: "colonne", sql: clause };
  if ((m = clause.match(new RegExp(`^ADD COLUMN ${ident}`))))
    return { cle: `colonne:${table}.${m[1]}:ADD`, famille: "colonne", sql: clause };
  if ((m = clause.match(new RegExp(`^ALTER COLUMN ${ident} (.+)$`))))
    return { cle: `colonne:${table}.${m[1]}:${m[2]}`, famille: "colonne", sql: clause };
  if ((m = clause.match(new RegExp(`^DROP CONSTRAINT ${ident}$`))))
    return { cle: `contrainte:${m[1]}:DROP`, famille: "contrainte", sql: clause };
  if ((m = clause.match(new RegExp(`^ADD CONSTRAINT ${ident} FOREIGN KEY`))))
    return { cle: `fk:${m[1]}:ADD`, famille: "fk", sql: clause };
  if ((m = clause.match(new RegExp(`^ADD CONSTRAINT ${ident}`))))
    return { cle: `contrainte:${m[1]}:ADD`, famille: "contrainte", sql: clause };
  return { cle: `autre:ALTER TABLE "${table}" ${clause}`, famille: "autre", sql: clause };
}

/**
 * Les écarts atomiques d'un script `migrate diff`. Une contrainte supprimée dont le nom finit par
 * `_fkey` est rangée en `fk` (Prisma écrit `DROP CONSTRAINT` sans dire de quel genre elle est).
 */
export function ecarts(script: string): Ecart[] {
  const out: Ecart[] = [];
  for (const ins of instructions(script)) {
    let m: RegExpMatchArray | null;
    if ((m = ins.match(new RegExp(`^ALTER TABLE ${ident} (.+)$`)))) {
      for (const c of clauses(m[2])) {
        const e = ecartAlterTable(m[1], c);
        if (e.cle.startsWith("contrainte:") && e.cle.includes("_fkey:"))
          out.push({ ...e, cle: e.cle.replace(/^contrainte:/, "fk:"), famille: "fk" });
        else out.push(e);
      }
    } else if ((m = ins.match(new RegExp(`^DROP INDEX ${ident}$`)))) {
      out.push({ cle: `index:${m[1]}:DROP`, famille: "index", sql: ins });
    } else if ((m = ins.match(new RegExp(`^CREATE (UNIQUE )?INDEX ${ident}`)))) {
      out.push({ cle: `index:${m[2]}:CREATE${m[1] ? " UNIQUE" : ""}`, famille: "index", sql: ins });
    } else if ((m = ins.match(new RegExp(`^ALTER INDEX ${ident} RENAME TO ${ident}$`)))) {
      out.push({ cle: `index:${m[1]}->${m[2]}:RENAME`, famille: "index", sql: ins });
    } else if ((m = ins.match(new RegExp(`^DROP TABLE ${ident}$`)))) {
      out.push({ cle: `table:${m[1]}:DROP`, famille: "table", sql: ins });
    } else if ((m = ins.match(new RegExp(`^CREATE TABLE ${ident}`)))) {
      out.push({ cle: `table:${m[1]}:CREATE`, famille: "table", sql: ins });
    } else if ((m = ins.match(new RegExp(`^(CREATE|DROP|ALTER) TYPE ${ident}`)))) {
      out.push({ cle: `type:${m[2]}:${m[1]}`, famille: "type", sql: ins });
    } else {
      out.push({ cle: `autre:${ins}`, famille: "autre", sql: ins });
    }
  }
  return out;
}

export type Exception = {
  /** La clé exacte de l'écart toléré. */
  cle: string;
  /** Pourquoi il est toléré — obligatoire, vérifié par le test. */
  raison: string;
};

/** Une règle tolère une FAMILLE d'écarts sans les énumérer (ex. `updatedAt` sans défaut). */
export type Regle = {
  nom: string;
  accepte: (e: Ecart) => boolean;
  raison: string;
};

export type Verdict = {
  /** Écarts observés qu'aucune exception ni règle ne couvre : la dérive NOUVELLE. */
  nouveaux: Ecart[];
  /** Exceptions qui ne correspondent plus à rien : la dette a été soldée, retirer la ligne. */
  perimees: Exception[];
  /** Combien d'écarts chaque règle a absorbés (pour le rapport). */
  parRegle: Record<string, number>;
};

export function juger(observes: Ecart[], exceptions: Exception[], regles: Regle[]): Verdict {
  const connues = new Map(exceptions.map((e) => [e.cle, e]));
  const vues = new Set<string>();
  const parRegle: Record<string, number> = Object.fromEntries(regles.map((r) => [r.nom, 0]));
  const nouveaux: Ecart[] = [];
  for (const e of observes) {
    if (connues.has(e.cle)) {
      vues.add(e.cle);
      continue;
    }
    // Une règle ne couvre jamais l'inconnu : un écart « autre » est toujours nouveau.
    const r = e.famille === "autre" ? undefined : regles.find((x) => x.accepte(e));
    if (r) parRegle[r.nom]++;
    else nouveaux.push(e);
  }
  const perimees = exceptions.filter((e) => !vues.has(e.cle));
  return { nouveaux, perimees, parRegle };
}
