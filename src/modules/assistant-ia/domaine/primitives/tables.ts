import { plier, type ChampVue, type FiltreNormalise, type Ligne, type Periode, type TypeChamp } from "./vues";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT I4 — « ADAM LIT TOUT » : LA LECTURE GÉNÉRIQUE, sa partie PURE (décision 0067). Aucun import lourd.
 *
 * Une TABLE de l'ERP (n'importe quel modèle du schéma) devient une déclaration de `lire` sans rien écrire à la main :
 * ses colonnes, ses énumérations (avec les libellés d'écran), et les colonnes de ses relations à UN niveau
 * (`institutionRef.name`, `wilayaRef.nom`). Le modèle filtre sur ces champs ; le serveur normalise (`vues.ts`), pousse à la
 * base ce qui s'y calcule exactement (choix, nombres, dates, oui / non) et vérifie le reste en mémoire (« contient »
 * tolérant aux accents et aux racines). Les colonnes qu'on ne rend JAMAIS (coffre, mots de passe, jetons, secrets) ne
 * sont pas déclarées : elles n'existent pas pour la lecture. La portée et les droits vivent dans `infra/primitives/tables.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un champ du schéma, tel que le DMMF de Prisma le décrit (réduit à ce que la lecture lit). */
export interface ChampModele {
  nom: string;
  genre: "scalar" | "enum" | "object" | "unsupported";
  /** Type Prisma (`String`, `DateTime`…), nom de l'énumération, ou du modèle lié. */
  type: string;
  liste: boolean;
  doc?: string | null;
}
export interface ModeleDecrit { nom: string; champs: readonly ChampModele[]; /** La clé primaire (`id`, ou `code` d'une wilaya). */ cle: string }

/** Les colonnes qui ne sortent JAMAIS, quel que soit le compte : authentification, jetons, secrets. */
export const COLONNE_SECRETE = /(password|passwd|hash|token|secret|api_?key|otp|totp|salt|private_?key|cookie|credential|cle_?secrete)/i;

function typeDe(c: ChampModele): TypeChamp | null {
  if (c.genre === "enum") return "choix";
  if (c.genre !== "scalar") return null;
  if (c.type === "Bytes") return null;
  if (c.liste) return "liste";
  if (["Int", "Float", "Decimal", "BigInt"].includes(c.type)) return "nombre";
  if (c.type === "DateTime") return "date";
  if (c.type === "Boolean") return "booleen";
  return "texte";
}

export interface ContexteSchema {
  modele: (nom: string) => ModeleDecrit | null;
  /** Une colonne de ce modèle peut-elle sortir pour cette personne ? */
  lisible: (modele: string, champ: string) => boolean;
  /** Une relation vers ce modèle peut-elle être suivie ? `null` : non ; sinon les seules colonnes permises (`null` = toutes). */
  relation: (modele: string, versPlusieurs: boolean) => { colonnes: readonly string[] | null } | null;
  valeursEnum: (nomEnum: string) => Readonly<Record<string, readonly string[]>> | null;
}

function champ(m: ModeleDecrit, c: ChampModele, ctx: ContexteSchema, chemin?: string): ChampVue | null {
  const type = typeDe(c);
  if (!type || !ctx.lisible(m.nom, c.nom)) return null;
  const valeurs = c.genre === "enum" ? ctx.valeursEnum(c.type) ?? undefined : undefined;
  if (type === "choix" && !valeurs) return null;
  return {
    nom: chemin ?? c.nom, chemin: chemin ?? c.nom, type, source: { modele: m.nom, champ: c.nom },
    description: (c.doc ?? "").replace(/\s+/g, " ").slice(0, 160) || `${m.nom}.${c.nom}`,
    ...(valeurs ? { valeurs } : {}),
  };
}

/** Les champs lisibles d'une table : ses colonnes, puis celles de ses relations à un niveau (`relation.colonne`). */
export function champsDeTable(m: ModeleDecrit, ctx: ContexteSchema): ChampVue[] {
  const out: ChampVue[] = [];
  for (const c of m.champs) {
    const ch = c.genre === "object" ? null : champ(m, c, ctx);
    if (ch) out.push(ch);
  }
  for (const r of m.champs.filter((c) => c.genre === "object")) {
    const lie = ctx.modele(r.type);
    const permis = lie ? ctx.relation(lie.nom, r.liste) : null;
    if (!lie || !permis) continue;
    for (const c of lie.champs) {
      if (c.genre === "object" || (permis.colonnes && !permis.colonnes.includes(c.nom))) continue;
      const ch = champ(lie, c, ctx, `${r.nom}.${c.nom}`);
      if (ch) out.push({ ...ch, description: `${ch.description} (par ${r.nom}${r.liste ? ", plusieurs" : ""})` });
    }
  }
  return out;
}

const NOMS_LIBELLES = ["name", "nom", "title", "titre", "label", "libelle", "reference", "canonicalName"];
const TECHNIQUES = /^(id|custom|createdById|updatedById)$|Id$|Ids$|Code$/;

/** Les champs rendus quand rien n'est demandé : les colonnes parlantes, et le nom de chaque relation simple. */
export function parDefautDe(m: ModeleDecrit, champs: readonly ChampVue[]): string[] {
  const noms = new Set(champs.map((c) => c.nom));
  // Une colonne texte HÉRITÉE que sa relation remplace (`specialty` ↔ `specialtyRef`) n'est pas montrée par défaut.
  const remplacees = new Set(m.champs.filter((c) => c.genre === "object" && c.nom.endsWith("Ref")).map((c) => c.nom.slice(0, -3)));
  const propres = m.champs.filter((c) => c.genre !== "object" && !c.liste && noms.has(c.nom) && !TECHNIQUES.test(c.nom) && c.type !== "Json" && !remplacees.has(c.nom)).map((c) => c.nom).slice(0, 14);
  const lies = m.champs.filter((c) => c.genre === "object" && !c.liste)
    .map((r) => NOMS_LIBELLES.map((n) => `${r.nom}.${n}`).find((n) => noms.has(n)))
    .filter((x): x is string => !!x).slice(0, 6);
  return [...propres, ...lies];
}

/** Le schéma COURT d'une table (rendu à la première faute) : ses colonnes et ses relations, en noms. */
export function schemaDeTable(m: ModeleDecrit, champs: readonly ChampVue[]): string {
  const racine = champs.filter((c) => !c.nom.includes(".")).map((c) => `${c.nom}${c.valeurs ? `[${Object.keys(c.valeurs).slice(0, 12).join("|")}]` : ""}`);
  const rel = [...new Set(champs.filter((c) => c.nom.includes(".")).map((c) => c.nom.split(".")[0]!))]
    .map((r) => `${r}→${m.champs.find((c) => c.nom === r)?.type ?? "?"}(${champs.filter((c) => c.nom.startsWith(`${r}.`)).map((c) => c.nom.slice(r.length + 1)).slice(0, 10).join(", ")})`);
  return `TABLE ${m.nom} — colonnes : ${racine.join(", ")}${rel.length ? ` ; relations (champ « relation.colonne ») : ${rel.join(" ; ")}` : ""}.`;
}

// ─── La base calcule ce qu'elle sait calculer exactement ───────────────────────────────────

const debut = (p: Periode): Date => new Date(`${"jour" in p ? p.jour : `${p.mois}-01`}T00:00:00Z`);
function finExclue(p: Periode): Date {
  const d = debut(p);
  if ("jour" in p) return new Date(d.getTime() + 86_400_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

function feuille(f: FiltreNormalise): Record<string, unknown> | null {
  const { champ: c, op, valeur: v } = f;
  if (c.type === "choix" && c.valeurs) {
    if (op === "=") return { equals: v };
    if (op === "!=") return { not: v };
    if (op === "parmi") return { in: v };
    return null;
  }
  if (c.type === "booleen") return op === "=" ? { equals: v } : op === "!=" ? { not: v } : null;
  if (c.type === "nombre") {
    const k: Record<string, string> = { "=": "equals", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" };
    if (op in k) return { [k[op]!]: v };
    if (op === "entre") return { gte: (v as number[])[0], lte: (v as number[])[1] };
    return null;
  }
  if (c.type === "date") {
    const p = v as Periode;
    if (op === "=") return { gte: debut(p), lt: finExclue(p) };
    if (op === ">") return { gte: finExclue(p) };
    if (op === ">=") return { gte: debut(p) };
    if (op === "<") return { lt: debut(p) };
    if (op === "<=") return { lt: finExclue(p) };
    if (op === "entre") return { gte: debut((v as Periode[])[0]!), lt: finExclue((v as Periode[])[1]!) };
    return null;
  }
  return null;
}

/**
 * La clause Prisma d'un filtre — `null` : il se vérifie en mémoire seulement (texte, listes, vide). La mémoire revérifie
 * TOUJOURS : la base ne sert qu'à ne pas ramener ce qui ne peut pas convenir.
 */
export function clauseDeFiltre(f: FiltreNormalise, versPlusieurs: (relation: string) => boolean): Record<string, unknown> | null {
  const l = feuille(f);
  if (!l) return null;
  const [a, b] = (f.champ.chemin ?? f.champ.nom).split(".");
  if (!b) return { [a!]: l };
  if (versPlusieurs(a!)) return f.op === "!=" ? null : { [a!]: { some: { [b]: l } } };
  return { [a!]: { [b]: l } };
}

// ─── Les lignes lues, rendues lisibles ───────────────────────────────────────────────────────

function valeurLue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(valeurLue);
  if (typeof v === "object" && typeof (v as { toFixed?: unknown }).toFixed === "function") return Number(String(v));
  return JSON.stringify(v).slice(0, 300);
}

/** UNE ligne de la base → une ligne plate, clé = nom du champ (les codes d'énumération restent des codes). */
export function aplatir(brut: Record<string, unknown>, champs: readonly ChampVue[]): Ligne {
  const l: Ligne = {};
  for (const c of champs) {
    if (c.type === "lien" || !c.chemin) continue;
    const [a, b] = c.chemin.split(".");
    const v = brut[a!];
    l[c.nom] = !b ? valeurLue(v) : Array.isArray(v) ? v.map((x) => valeurLue((x as Record<string, unknown>)?.[b])).filter((x) => x !== null) : v && typeof v === "object" ? valeurLue((v as Record<string, unknown>)[b]) : null;
  }
  return l;
}

/** Les codes d'énumération → leurs libellés d'écran (« CHEF_DE_SERVICE » → « Chef de service »). */
export function libelliser(lignes: readonly Ligne[], champs: readonly ChampVue[]): Ligne[] {
  const choix = champs.filter((c) => c.type === "choix" && c.valeurs);
  if (!choix.length) return [...lignes];
  const lib = (c: ChampVue, v: unknown) => (typeof v === "string" ? c.valeurs![v]?.[0] ?? v : v);
  return lignes.map((l) => {
    const r = { ...l };
    for (const c of choix) if (c.nom in r) r[c.nom] = Array.isArray(r[c.nom]) ? (r[c.nom] as unknown[]).map((v) => lib(c, v)) : lib(c, r[c.nom]);
    return r;
  });
}

// ─── Ce que le livrable dit de ses propres données (calculé, jamais écrit par le modèle) ───

const vide = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
const ANCIENNE_JOURS = 365;
const jourDe = (v: unknown): string | null => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/** La VÉRIFICATION d'une ligne : à jour, ancienne (mise à jour il y a plus d'un an), incomplète (colonnes vides nommées). */
export function verificationDe(l: Ligne, colonnes: readonly string[], maj: string | null, maintenant: Date): string {
  const manquent = colonnes.filter((c) => c !== maj && vide(l[c]));
  const j = maj ? jourDe(l[maj]) : null;
  const ancienne = j !== null && maintenant.getTime() - Date.parse(`${j}T00:00:00Z`) > ANCIENNE_JOURS * 86_400_000;
  const dit = [ancienne ? `ancienne (mise à jour le ${j})` : null, manquent.length ? `incomplète (sans ${manquent.join(", ")})` : null].filter(Boolean);
  return dit.length ? dit.join(" ; ") : "à jour";
}

/** LES LIMITES d'un jeu, calculées : fiches sans telle colonne, fiches anciennes, période des mises à jour. */
export function limitesDuJeu(lignes: readonly Ligne[], colonnes: readonly string[], maj: string | null, maintenant: Date): string[] {
  if (!lignes.length) return ["Aucune ligne lue."];
  const out = colonnes.filter((c) => c !== maj).map((c) => [c, lignes.filter((l) => vide(l[c])).length] as const)
    .filter(([, n]) => n > 0).map(([c, n]) => `${n} ligne(s) sur ${lignes.length} sans « ${c} »`);
  if (maj) {
    const jours = lignes.map((l) => jourDe(l[maj])).filter((x): x is string => !!x).sort();
    const vieilles = jours.filter((j) => maintenant.getTime() - Date.parse(`${j}T00:00:00Z`) > ANCIENNE_JOURS * 86_400_000).length;
    if (jours.length) out.push(`Fiches mises à jour entre le ${jours[0]} et le ${jours[jours.length - 1]}${vieilles ? ` ; ${vieilles} de plus d'un an` : ""}.`);
  }
  return out.length ? out : ["Toutes les colonnes sont renseignées."];
}

/** L'ESSAI À BLANC dit en une phrase (la carte du plan) : « Médecin : 9 ligne(s) ; wilaya : 6 valeurs (Alger 3, Oran 2…) ». */
export function phraseDEssai(r: { libelle: string; total: number; tronque?: boolean; repartitions?: Record<string, Record<string, number>>; sansFiltre?: Record<string, number> }): string {
  const parts = [`${r.libelle} : ${r.total}${r.tronque ? "+" : ""} ligne(s)`];
  for (const [c, comptes] of Object.entries(r.repartitions ?? {})) {
    const e = Object.entries(comptes);
    parts.push(`${c} : ${e.length} valeur(s) (${e.slice(0, 3).map(([k, n]) => `${k} ${n}`).join(", ")}${e.length > 3 ? "…" : ""})`);
  }
  if (r.total === 0 && r.sansFiltre && Object.keys(r.sansFiltre).length) {
    parts.push(`élargir : ${Object.entries(r.sansFiltre).map(([f, n]) => `sans « ${f} » → ${n}`).join(" ; ")}`);
  }
  return parts.join(" ; ");
}

/** Le texte plié — pour les noms de tables dits naturellement (« praticiens », « medical doctor »). */
export const plierNom = (t: unknown): string => plier(t).replace(/[\s_.-]+/g, "");
