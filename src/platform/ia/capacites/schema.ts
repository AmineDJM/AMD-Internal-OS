import { z } from "zod";
import { MOTS, VERBES } from "./lexique";
import type { ChampLu } from "./types";

/**
 * LE SCHÉMA D'ENTRÉE D'UNE CAPACITÉ — tiré des champs du contrat, rien d'inventé (lot J6 ; sorti du registre au lot J11).
 *
 * PUR et LÉGER (zod, le lexique, les types) : le modèle le lit (`schemaDe`), l'adaptateur valide avec lui (`zodDe`), et
 * le FORMULAIRE de la carte de confirmation (`formulaire.ts`, J11) le rejoue dans l'onglet — une seule validation, du
 * modèle à la signature. Le registre (`registre.ts`) le réexporte.
 */

/** Le libellé français d'un nom de champ (`assignedToId` → « attribuer à id ») — la carte et la recherche le lisent. */
export const libelleChamp = (nom: string): string => {
  const morceaux = nom.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? [nom];
  // `Id` / `Ids` et les mots-outils (`to`, `of`) ne disent rien à une personne : la carte montre « attribué à », pas « assigned to id ».
  const utiles = morceaux.map((m) => m.toLowerCase()).filter((m) => !["id", "ids", "to", "of", "by", "for", "the"].includes(m));
  return (utiles.length ? utiles : [nom.toLowerCase()]).map((m) => MOTS[m] ?? VERBES[m] ?? m).join(" ");
};

/** La description d'un champ pour le modèle — seulement quand elle aide (une référence, des valeurs admises). */
export function descriptionChamp(ch: ChampLu): string | undefined {
  if (ch.type === "reference" && ch.modele) return `${libelleChamp(ch.nom)} : un nom ou l'identifiant (${ch.modele})`;
  if (ch.type === "reference") return `${libelleChamp(ch.nom)} : identifiant`;
  if (ch.type === "date") return "AAAA-MM-JJ";
  return undefined;
}

type SchemaJson = { type: string; description?: string; enum?: string[]; items?: SchemaJson; properties?: Record<string, SchemaJson>; required?: string[] };

/** LE SCHÉMA D'ENTRÉE (JSON, celui que lit le modèle) — tiré des champs du contrat, rien d'inventé. */
export function schemaDe(cap: { champs: readonly ChampLu[] }): SchemaJson {
  const properties: Record<string, SchemaJson> = {};
  for (const ch of cap.champs) {
    const description = descriptionChamp(ch);
    const base: SchemaJson = ch.type === "nombre" ? { type: "number" } : ch.type === "booleen" ? { type: "boolean" }
      : ch.type === "liste" ? { type: "array", items: { type: "string" } } : { type: "string" };
    if (ch.valeurs?.length && ch.type !== "liste" && ch.type !== "booleen" && ch.type !== "nombre") base.enum = [...ch.valeurs];
    properties[ch.nom] = description ? { ...base, description } : base;
  }
  const required = cap.champs.filter((c) => c.obligatoire).map((c) => c.nom);
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/** LE SCHÉMA ZOD de la même entrée — ce que valide l'adaptateur avant `run`. */
export function zodDe(cap: { champs: readonly ChampLu[] }): z.ZodTypeAny {
  const forme: Record<string, z.ZodTypeAny> = {};
  for (const ch of cap.champs) {
    let t: z.ZodTypeAny = ch.type === "nombre" ? z.number() : ch.type === "booleen" ? z.boolean()
      : ch.type === "liste" ? z.array(z.string()) : ch.valeurs?.length ? z.enum(ch.valeurs as [string, ...string[]]) : z.string();
    const d = descriptionChamp(ch);
    if (d) t = t.describe(d);
    forme[ch.nom] = ch.obligatoire ? t : t.optional();
  }
  return z.object(forme).strict();
}

