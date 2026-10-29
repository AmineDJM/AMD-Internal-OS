/**
 * Compilateur de mission — LES OUTILS DES PASSES : codes d'erreur, destinataires d'une étape, viser
 * le demandeur, fabrique de refus, spécification d'une étape, forme attendue par type de nœud,
 * assainissement des clés du plan, contexte du réparateur de règles, capacités qui rendent une liste.
 */
import { COMPILE_ERRORS, CompileIssue, MissionPlan, NodeType, PlannedStep } from "@/lib/missions/planner/contract";
import { reecrireClesDansRegles, type ContexteReglesPlan } from "@/lib/missions/goal/rules";
import type { StepSpec } from "@/lib/missions/compiler/compile/types";

const ERREURS = new Set<string>(COMPILE_ERRORS);

/**
 * LES CHAMPS QUI DÉSIGNENT DES DESTINATAIRES.
 *
 * La liste est explicite plutôt que devinée. Une heuristique du genre « tout tableau de chaînes
 * qui ressemble à des e-mails » se tromperait dans les deux sens : elle raterait un champ nommé
 * autrement, et bloquerait une liste de pièces jointes.
 */
const CHAMPS_DESTINATAIRES = ["to", "destinataire", "destinataires", "recipients", "cc", "bcc", "employeeIds", "personIds"];

/** Combien de destinataires ce champ porte-t-il ? `-1` quand ce n'est pas un champ de ce genre. */
export function nbDestinataires(input: Record<string, unknown>): number {
  let max = -1;
  for (const champ of CHAMPS_DESTINATAIRES) {
    const v = input[champ];
    if (Array.isArray(v)) max = Math.max(max, v.length);
    else if (typeof v === "string" && v.trim() !== "") {
      // Une chaîne « a@x.dz, b@x.dz » est une liste déguisée : c'est exactement la forme par
      // laquelle un envoi groupé se glisse sans qu'aucun tableau n'apparaisse.
      max = Math.max(max, v.split(/[;,]/).filter((p) => p.trim() !== "").length);
    }
  }
  return max;
}

const normaliserNom = (t: string): string =>
  t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Les façons de désigner la personne qui a demandé la mission — sans la nommer. */
const MOTS_DEMANDEUR: ReadonlySet<string> = new Set([
  "moi", "le demandeur", "la demandeuse", "le dirigeant", "la dirigeante", "la direction", "pdg", "le pdg",
  "dg", "le dg", "directeur general", "le directeur general", "la directrice generale",
  "proprietaire de la mission", "le proprietaire de la mission", "la proprietaire de la mission",
]);

/** Une attente humaine sans destinataire, ou adressée au demandeur lui-même. */
export function viseLeDemandeur(from: string, label: string): boolean {
  const f = normaliserNom(from);
  if (f === "") return true;
  if (f === normaliserNom(label)) return true;
  return MOTS_DEMANDEUR.has(f);
}

export const issue = (code: string, stepKey: string | null, message: string): CompileIssue => {
  if (!ERREURS.has(code)) throw new Error(`code de refus inconnu : ${code}`);
  return { code: code as CompileIssue["code"], stepKey, message };
};

/**
 * LA SPÉCIFICATION D'UNE ÉTAPE, extraite du plan.
 *
 * Rend `null` quand il n'y a rien à dire : une colonne JSON pleine de `{}` coûte de la place et
 * fait croire, à la relecture, qu'une information a été perdue. `null` dit « rien n'a été
 * demandé », ce qui est vrai et différent.
 */
export function specDe(s: PlannedStep): StepSpec | null {
  const spec: StepSpec = {};
  if (s.expectedOutputSchema) spec.expectedOutputSchema = s.expectedOutputSchema;
  if (s.completionCondition) spec.completionCondition = s.completionCondition;
  if (s.reasoningRequirement) spec.reasoningRequirement = s.reasoningRequirement;
  if (s.approvalRequirement) spec.approvalRequirement = s.approvalRequirement;
  if (s.when) spec.when = s.when;
  return Object.keys(spec).length > 0 ? spec : null;
}

/**
 * LA FORME ATTENDUE PAR TYPE DE NŒUD.
 *
 * Déclarée en table plutôt qu'en cascade de `if` : la table se lit d'un coup d'œil, et le test
 * peut la parcourir exhaustivement au lieu de deviner quelles branches existent.
 */
export const FORMES: Record<NodeType, { capacite: "requise" | "interdite"; attente: "requise" | "interdite" }> = {
  CAPABILITY: { capacite: "requise", attente: "interdite" },
  WORKER: { capacite: "interdite", attente: "interdite" },
  WAIT_EVENT: { capacite: "interdite", attente: "requise" },
  WAIT_INPUT: { capacite: "interdite", attente: "requise" },
  APPROVAL: { capacite: "interdite", attente: "interdite" },
  QA: { capacite: "interdite", attente: "interdite" },
  ARTIFACT: { capacite: "interdite", attente: "interdite" },
  JOIN: { capacite: "interdite", attente: "interdite" },
};

/** L'alphabet d'une clé d'étape — la même contrainte que le refus de forme, mais APPLIQUÉE. */
const CLE_VALIDE = /^[A-Za-z0-9:_\-.]+$/;

const normaliserCle = (brute: string): string =>
  brute
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9:_\-.]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * ── 0. L'ASSAINISSEMENT DES CLÉS — une mission ne meurt pas d'un accent ──────────────────
 *
 * Un run Render a tué une mission AVANT SA NAISSANCE pour la clé « recherche:federée » : la
 * clé est un IDENTIFIANT MACHINE, le modèle écrit du français, et la retouche du planificateur
 * a REPRODUIT la faute — le refus était donc une impasse structurelle, pas un garde-fou. §5 :
 * les modèles décident QUOI (le contenu du plan), le code décide COMMENT (la forme des
 * identifiants). Une clé hors alphabet se NORMALISE — accents décomposés, caractères interdits
 * remplacés — et chaque référence qui la citait (dependsOn, forEach.from, règles d'acceptation)
 * est réécrite avec elle, sinon l'assainissement CRÉERAIT la référence fantôme qu'il évite.
 *
 * Ce qui N'EST PAS assaini, et c'est voulu : deux clés IDENTIQUES restent identiques —
 * DUPLICATE_KEY reste un refus, c'est une vraie faute de plan, pas une faute d'alphabet. Une
 * collision CRÉÉE par la normalisation, elle, se suffixe : les deux étapes existent bel et
 * bien, les fondre serait perdre l'une des deux.
 */
export function assainirPlan(brut: MissionPlan): { plan: MissionPlan; notes: string[] } {
  const renommages = new Map<string, string>();
  const prises = new Set<string>();
  for (const s of brut.steps) {
    if (typeof s.key === "string" && CLE_VALIDE.test(s.key)) prises.add(s.key);
  }
  const notes: string[] = [];
  for (const [i, s] of brut.steps.entries()) {
    const brute = s.key ?? "";
    if (CLE_VALIDE.test(brute) || renommages.has(brute)) continue;
    let candidate = normaliserCle(brute) || `etape-${i + 1}`;
    if (prises.has(candidate)) {
      let n = 2;
      while (prises.has(`${candidate}-${n}`)) n += 1;
      candidate = `${candidate}-${n}`;
    }
    renommages.set(brute, candidate);
    prises.add(candidate);
    notes.push(`clé « ${brute} » assainie en « ${candidate} » — une clé est un identifiant machine `
      + `(lettres, chiffres, :_-.), jamais du français.`);
  }
  if (renommages.size === 0) return { plan: brut, notes };
  const steps = brut.steps.map((s) => ({
    ...s,
    key: renommages.get(s.key ?? "") ?? s.key,
    dependsOn: s.dependsOn?.map((d) => renommages.get(d) ?? d),
    forEach: s.forEach
      ? { ...s.forEach, from: renommages.get(s.forEach.from) ?? s.forEach.from }
      : s.forEach,
  }));
  return {
    plan: { ...brut, steps, acceptance: reecrireClesDansRegles(brut.acceptance, renommages) },
    notes,
  };
}

/** Ce que le réparateur de règles doit savoir du plan — calculé au seul endroit qui a le plan entier. */
export function contexteReglesDuPlan(plan: MissionPlan, acquises: ReadonlySet<string>): ContexteReglesPlan {
  const clesEtapes = new Set<string>([...plan.steps.map((s) => s.key), ...acquises]);
  const clesAvecRequete = new Set<string>();
  const sortiesStructurees: { cle: string; champs: string[] }[] = [];
  for (const s of plan.steps) {
    const q = (s.input ?? {})["query"];
    if (typeof q === "string" && q.trim() !== "" && !q.includes("{{")) clesAvecRequete.add(s.key);
    if (s.expectedOutputSchema && typeof s.expectedOutputSchema === "object") {
      const props = (s.expectedOutputSchema as { properties?: Record<string, unknown> }).properties;
      if (props && typeof props === "object") sortiesStructurees.push({ cle: s.key, champs: Object.keys(props) });
    }
  }
  return { clesEtapes, clesAvecRequete, sortiesStructurees };
}

/** Les capacités qui rendent une LISTE (recherche, annuaire, exploration) — jamais un identifiant sûr en `.0.id`. */
export const CAPACITES_LISTE = /^(search_|find_|list_|directory_list$|explore_|browse_|lookup_)/i;
