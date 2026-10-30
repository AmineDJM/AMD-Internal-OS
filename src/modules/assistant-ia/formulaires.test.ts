import { describe, expect, it } from "vitest";
import { registreDesCapacites } from "./infra/capacites";
import { schemaDe, zodDe } from "@/platform/ia/capacites/registre";
import {
  champsCorriges, champsDuFormulaire, entreeDepuisSaisies, formulaireDe, saisiesInitiales, verifierFormulaire,
  type ChampFormulaire, type Saisie,
} from "@/platform/ia/capacites/formulaire";

/**
 * LE CRITÈRE DU LOT J11 (décision 0030) : la carte de TOUTE capacité R1–R4 est un formulaire généré depuis son contrat,
 * et ce formulaire a 0 écart avec le schéma du registre J6. Le banc génère le formulaire de chacune, le remplit comme
 * une personne le ferait, et valide le résultat avec `zodDe` — la règle que l'adaptateur applique au modèle.
 */

const capacites = registreDesCapacites().capacites.filter((c) => c.source === "action" && c.risque !== "R0");

const ID = "ckzzzzzzzzzzzzzzzzzzzzzz1";

/** Ce qu'une personne saisirait dans ce champ — une valeur admise par son type. */
function saisieValide(c: ChampFormulaire): Saisie {
  switch (c.widget) {
    case "case": return true;
    case "nombre": return "12 500,5";
    case "date": return "2026-11-06";
    case "choix": return c.valeurs![0]!;
    case "choix-multiple": return [c.valeurs![0]!];
    case "etiquettes": return ["premier", "second"];
    case "reference": case "identifiant": return ID;
    case "references": return [ID];
    default: return "Préparer le stand du congrès";
  }
}

/** La valeur que l'assistant aurait proposée — dans la forme de l'entrée de l'action. */
function valeurProposee(c: { type: string; valeurs: readonly string[] | null }): unknown {
  if (c.type === "booleen") return true;
  if (c.type === "nombre") return 42;
  if (c.type === "date") return "2026-11-06";
  if (c.type === "liste") return c.valeurs?.length ? [c.valeurs[0]] : [ID];
  if (c.valeurs?.length) return c.valeurs[0];
  return c.type === "reference" ? ID : "texte proposé";
}

describe("J11 — formulaires générés depuis le contrat", () => {
  it("il y a bien des capacités R1–R4 à couvrir", () => {
    expect(capacites.length).toBeGreaterThan(1000);
  });

  it("chaque formulaire porte EXACTEMENT les champs du contrat (nom, type, obligation, valeurs, modèle) — 0 écart de schéma", () => {
    const ecarts: string[] = [];
    for (const cap of capacites) {
      const f = formulaireDe(cap.id, cap.champs);
      if (JSON.stringify(champsDuFormulaire(f)) !== JSON.stringify(cap.champs.map((c) => ({ nom: c.nom, type: c.type, obligatoire: c.obligatoire, valeurs: c.valeurs ? [...c.valeurs] : null, modele: c.modele })))) ecarts.push(`${cap.id} : champs`);
      if (JSON.stringify(schemaDe({ champs: champsDuFormulaire(f) })) !== JSON.stringify(schemaDe(cap))) ecarts.push(`${cap.id} : schéma JSON`);
      for (const c of f.champs) {
        if (c.valeurs?.length && c.widget !== "choix" && c.widget !== "choix-multiple" && c.type !== "booleen" && c.type !== "nombre") ecarts.push(`${cap.id}.${c.nom} : valeurs admises sans liste de choix`);
        if (c.modele && c.type === "reference" && c.widget !== "reference") ecarts.push(`${cap.id}.${c.nom} : référence sans sélecteur`);
      }
    }
    expect(ecarts).toEqual([]);
  });

  it("rempli comme une personne le ferait, chaque formulaire passe la validation zod du registre", () => {
    const refus: string[] = [];
    for (const cap of capacites) {
      const f = formulaireDe(cap.id, cap.champs);
      const saisies = Object.fromEntries(f.champs.map((c) => [c.nom, saisieValide(c)]));
      const v = verifierFormulaire(f, saisies);
      const z = zodDe(cap).safeParse(entreeDepuisSaisies(f, saisies));
      if (Object.keys(v.erreurs).length || !z.success) refus.push(`${cap.id} : ${JSON.stringify(v.erreurs)}`);
    }
    expect(refus).toEqual([]);
  });

  it("la proposition de l'assistant, pré-remplie puis signée sans correction, redonne l'entrée à l'identique", () => {
    const ecarts: string[] = [];
    for (const cap of capacites) {
      const propose = Object.fromEntries(cap.champs.map((c) => [c.nom, valeurProposee(c)]));
      const f = formulaireDe(cap.id, cap.champs, propose);
      const entree = entreeDepuisSaisies(f, saisiesInitiales(f));
      if (JSON.stringify(entree) !== JSON.stringify(propose)) ecarts.push(cap.id);
      else if (champsCorriges(f, entree).length) ecarts.push(`${cap.id} : marqué corrigé sans correction`);
      else if (!zodDe(cap).safeParse(entree).success) ecarts.push(`${cap.id} : la proposition elle-même est refusée`);
    }
    expect(ecarts).toEqual([]);
  });

  it("vide, chaque formulaire nomme exactement ses champs obligatoires", () => {
    const ecarts: string[] = [];
    for (const cap of capacites) {
      const f = formulaireDe(cap.id, cap.champs);
      const vides = Object.fromEntries(f.champs.map((c) => [c.nom, c.widget === "case" ? false : Array.isArray(saisieValide(c)) ? [] : ""]));
      const { erreurs } = verifierFormulaire(f, vides);
      const attendus = cap.champs.filter((c) => c.obligatoire && c.type !== "booleen").map((c) => c.nom).sort();
      if (JSON.stringify(Object.keys(erreurs).sort()) !== JSON.stringify(attendus)) ecarts.push(`${cap.id} : ${Object.keys(erreurs).join(",")} ≠ ${attendus.join(",")}`);
    }
    expect(ecarts).toEqual([]);
  });

  it("une correction est vue, nommée, et un mauvais type est refusé en français", () => {
    const cap = capacites.find((c) => c.id === "task-actions:createTask")!;
    const f = formulaireDe(cap.id, cap.champs, { title: "Stand", assignedToId: ID }, { [ID]: "Karim B." });
    expect(f.champs.find((c) => c.nom === "assignedToId")).toMatchObject({ widget: "reference", modele: "User", etiquettes: { [ID]: "Karim B." } });
    const saisies = { ...saisiesInitiales(f), title: "Stand du congrès d'Oran" };
    const v = verifierFormulaire(f, saisies);
    expect(v.erreurs).toEqual({});
    expect(champsCorriges(f, v.entree)).toEqual(["title"]);
    const nombre = capacites.find((c) => c.champs.some((x) => x.type === "nombre" && x.obligatoire))!;
    const fn = formulaireDe(nombre.id, nombre.champs);
    const champ = fn.champs.find((c) => c.type === "nombre" && c.obligatoire)!;
    expect(verifierFormulaire(fn, { [champ.nom]: "douze" }).erreurs[champ.nom]).toBe("Un nombre est attendu.");
  });
});
