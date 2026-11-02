import type { PowerTool } from "@/platform/ia/outil";
import { creerMicroSkill, listerSkills, promouvoirSkill, supprimerSkill } from "@/platform/in-process/skills";

/**
 * LES GESTES SUR LES MICRO-OUTILS (mandat 5 §36) — créer, lister, promouvoir, jeter.
 *
 * Créer et lister sont ouverts : un micro-outil est du code dans le bac à sable, aussi inoffensif
 * que `run_code`, et il n'existe que s'il a passé la porte de qualité sur un exemple. Promouvoir
 * et jeter sont des gestes de PERSONNE : le pont vérifie le périmètre et le droit, et
 * `policy/guard.ts` les refuse à l'agent à la compilation — un document lu par une mission ne
 * peut pas « promouvoir » un outil à la place de quelqu'un.
 */
const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string).trim() : "");

export const SKILL_TOOLS: PowerTool[] = [
  {
    def: {
      name: "create_skill",
      description:
        "CRÉE UN MICRO-OUTIL réutilisable à partir de code : nom, description, code (JavaScript par défaut — lit `data`, `return` un résultat JSON ; Python si le serveur l'a), "
        + "un EXEMPLE d'entrée et des attentes closes sur cet exemple. Le serveur inspecte, exécute, teste, valide (porte de qualité) et n'expose l'outil que si tout tient. "
        + "L'outil apparaît aussitôt sous le nom skill_<nom>, pour toi seul, 24 h (TEMPORAIRE) ; la personne peut le promouvoir (promote_skill) pour le garder et le partager. "
        + "À utiliser quand un même calcul ou une même transformation reviendra (règle de calcul métier, contrôle, format), ou pour outiller une mission ; pas pour un calcul unique (run_code). "
        + "Rend le nom de l'outil, l'échéance, le rapport de la porte et le résultat sur l'exemple.",
      input_schema: {
        type: "object",
        properties: {
          nom: { type: "string", description: "Court, parlant : « tva 19 », « delai de paiement »." },
          description: { type: "string", description: "Quand l'appeler, ce qu'il rend — pour le modèle qui le verra dans la liste." },
          langage: { type: "string", enum: ["js", "python"] },
          code: { type: "string" },
          entrees: { type: "object", description: "Schéma JSON des entrées ({ type: 'object', properties: {…}, required: [] })." },
          exemple: { description: "Une entrée d'exemple, passée au code comme `data`." },
          attentes: { type: "array", items: { type: "object" }, description: "Assertions closes sur le résultat de l'exemple : [{ chemin, op: egal|different|superieur|inferieur|entre|contient|longueur|nonVide|type, valeur?, bornes?, libelle? }]." },
          schema: { type: "object", description: "Forme promise du résultat : { forme: objet|liste|nombre|texte|quelconque, cles?, max? } — vérifiée à chaque appel." },
          domaine: { type: "string", description: "DATA (défaut), FINANCE, LEGAL, REGULATORY, HR, GENERAL…" },
        },
        required: ["nom", "description", "code", "exemple"],
      },
    },
    allowed: () => true,
    label: "Création d'un micro-outil",
    run: async (input, user) => JSON.stringify(await creerMicroSkill(user, {
      nom: str(input, "nom"), description: str(input, "description"), langage: str(input, "langage") || null, code: str(input, "code"),
      entrees: input.entrees, exemple: input.exemple, attentes: input.attentes, schema: input.schema, domaine: str(input, "domaine") || null,
    })),
  },
  {
    def: {
      name: "list_skills",
      description: "LISTE les skills ouverts à la personne : connecteurs déclarés (DocuSign, SAP, HubSpot, IQVIA, PCH…) avec leur disponibilité (configurés ou non), ses micro-outils (temporaires ou promus, utilisations, échéance) et les playbooks enseignés. À utiliser pour « quels outils as-tu créés ? », « est-ce que DocuSign est branché ? ».",
      input_schema: { type: "object", properties: {} },
    },
    allowed: () => true,
    label: "Liste des skills",
    run: async (_input, user) => {
      const skills = await listerSkills(user);
      return JSON.stringify({ total: skills.length, connecteurs: skills.filter((s) => s.source === "plugin"), microOutils: skills.filter((s) => s.source === "adam"), playbooks: skills.filter((s) => s.source === "teach") });
    },
  },
  {
    def: {
      name: "promote_skill",
      description:
        "PROMEUT un micro-outil temporaire en outil durable : pour la personne (PERSON), son département (GROUP) ou toute la société (COMPANY — direction). "
        + "C'est un geste de PERSONNE : à n'appeler que sur sa demande explicite (« garde-le », « promeus-le pour l'équipe »), jamais de ta propre initiative ni dans une mission.",
      input_schema: { type: "object", properties: { nom: { type: "string", description: "Le nom de l'outil (skill_…) ou le nom donné à la création." }, scope: { type: "string", enum: ["PERSON", "GROUP", "COMPANY"] } }, required: ["nom"] },
    },
    allowed: () => true,
    label: "Promotion d'un micro-outil",
    run: async (input, user) => JSON.stringify(await promouvoirSkill(user, { nom: str(input, "nom"), scope: str(input, "scope") || null })),
  },
  {
    def: {
      name: "drop_skill",
      description: "JETTE un micro-outil (le sien, ou n'importe lequel avec la vue globale). Sur demande explicite de la personne.",
      input_schema: { type: "object", properties: { nom: { type: "string" } }, required: ["nom"] },
    },
    allowed: () => true,
    label: "Suppression d'un micro-outil",
    run: async (input, user) => JSON.stringify(await supprimerSkill(user, { nom: str(input, "nom") })),
  },
];
