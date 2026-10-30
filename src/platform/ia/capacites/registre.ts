import { z } from "zod";
import { ACTIONS_GESTE } from "@/platform/ia/artifact/atelier/gestes";
import { annulationDe, CHAMP_BINAIRE, CHAMP_BINAIRE_PRINCIPAL, contenuTiersDe, famillesDeLAction, natureDeLAction, risqueDe, simulableDe } from "./classement";
import { libelleDeFonction, MOTS, motsDuFichier, synonymesDe, VERBES } from "./lexique";
import { porteDeLAction, refusSurface } from "./portes";
import type { Capacite, ChampLu, ContratLu, OutilDecrit, PortsRegistre, Risque } from "./types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE REGISTRE DES CAPACITÉS (lot J6, décision 0020) — le « système d'exploitation » de l'assistant.
 *
 * UN registre, DÉRIVÉ, jamais déclaré à la main : chaque action serveur du contrat (`lib/actions/contrat.genere.json`,
 * lu sur la source de l'action par `npm run actions:contrat`), chaque outil existant de l'Assistant IA (décrit par son
 * module) et chaque commande de l'Atelier (`artifact/atelier/gestes.ts`) devient une FICHE : identifiant, source,
 * schéma d'entrée, famille de la console, libellé et description en français, niveau de risque R0 → R4, simulable,
 * annulation, contenu tiers. Une action ajoutée à l'ERP devient une capacité sans une ligne de plus — avec ses gardes
 * d'origine, puisque l'appel passe par l'action elle-même (`lib/actions/executer.ts`).
 *
 * Pur : le socle ne lit pas l'ERP (son plafond d'imports ne se relève pas) ; le module qui l'emploie lui passe les
 * contrats et trois ports (le refus générique, la table d'annulation, les modules RBAC).
 *
 * ── CE QUI N'EST JAMAIS APPELABLE ────────────────────────────────────────────────────────
 *
 * Une action `illisible` (ses champs ne se lisent pas à coup sûr) ; une action refusée au chemin générique (droits,
 * garde-fous, attestations — `generique.ts`) ; un fichier hors de l'assistant (`portes.ts`) ; une action qui exige un
 * FICHIER binaire (le modèle n'a pas d'octets à donner). Elles restent des fiches — la recherche les trouve et le refus
 * nomme l'écran — mais aucun outil n'en sort.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le nom d'outil d'une action : `task-actions:createTask` → `task__createTask` (≤ 64, `[a-zA-Z0-9_-]`). */
export const nomOutilDe = (id: string): string => {
  const [fichier, fonction] = id.split(":");
  return `${(fichier ?? "").replace(/-actions$/, "")}__${fonction ?? ""}`.slice(0, 64);
};

const PHRASE_RISQUE: Readonly<Record<Risque, string>> = {
  R0: "Lecture.",
  R1: "Écriture : une carte à confirmer est affichée, rien n'est fait avant.",
  R2: "Écriture qui prévient quelqu'un : une carte à confirmer est affichée.",
  R3: "Effet EXTERNE : une carte renforcée (ressaisie) est affichée.",
  R4: "Geste engageant (argent, décision, signature ou suppression) : carte renforcée, ressaisie exigée.",
};

/** Le libellé français d'un nom de champ (`assignedToId` → « attribuer à id ») — la carte et la recherche le lisent. */
export const libelleChamp = (nom: string): string => {
  const morceaux = nom.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? [nom];
  // `Id` / `Ids` et les mots-outils (`to`, `of`) ne disent rien à une personne : la carte montre « attribué à », pas « assigned to id ».
  const utiles = morceaux.map((m) => m.toLowerCase()).filter((m) => !["id", "ids", "to", "of", "by", "for", "the"].includes(m));
  return (utiles.length ? utiles : [nom.toLowerCase()]).map((m) => MOTS[m] ?? VERBES[m] ?? m).join(" ");
};

/** La description d'un champ pour le modèle — seulement quand elle aide (une référence, des valeurs admises). */
function descriptionChamp(ch: ChampLu): string | undefined {
  if (ch.type === "reference" && ch.modele) return `${libelleChamp(ch.nom)} : un nom ou l'identifiant (${ch.modele})`;
  if (ch.type === "reference") return `${libelleChamp(ch.nom)} : identifiant`;
  if (ch.type === "date") return "AAAA-MM-JJ";
  return undefined;
}

type SchemaJson = { type: string; description?: string; enum?: string[]; items?: SchemaJson; properties?: Record<string, SchemaJson>; required?: string[] };

/** LE SCHÉMA D'ENTRÉE (JSON, celui que lit le modèle) — tiré des champs du contrat, rien d'inventé. */
export function schemaDe(cap: Pick<Capacite, "champs">): SchemaJson {
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
export function zodDe(cap: Pick<Capacite, "champs">): z.ZodTypeAny {
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

/**
 * UNE PERSONNE DÉSIGNÉE PAR SON NOM, même quand le schéma ne le dit pas : `task-actions:createTask` porte `assignedToId`
 * sans modèle lu. Un champ de référence SANS modèle dont le nom désigne une personne (assigné, responsable, validateur…)
 * est un champ `User` : la fiche le dit au modèle (« un nom ou l'identifiant »), et la préparation le résout par
 * l'annuaire. Mesuré à l'essai réel (J6) : décrit « identifiant », le modèle demandait l'identifiant de Karim.
 */
const NOM_DE_PERSONNE = /^(user|assigned|assignee|responsible|manager|validator|owner|recipient|participant|reader|member|decideur|collaborator|standIn|person|personne|productManager|assistant)/i;
export function avecPersonnes<C extends ContratLu>(c: C): C {
  return {
    ...c,
    champs: c.champs.map((ch) => (!ch.modele && (ch.type === "reference" || ch.type === "liste") && NOM_DE_PERSONNE.test(ch.nom) && /Ids?$/.test(ch.nom)
      ? { ...ch, modele: "User" } : ch)),
  };
}

/** LA FICHE D'UNE ACTION DU CONTRAT. */
export function ficheDeLAction<C extends ContratLu>(c: C, ports: PortsRegistre<C>): Capacite {
  const { risque, raison } = risqueDe(c);
  const ecriture = risque !== "R0";
  const porte = porteDeLAction(c, ports.modules);
  const binaires = c.champs.filter((ch) => CHAMP_BINAIRE_PRINCIPAL.test(ch.nom) || (ch.obligatoire && CHAMP_BINAIRE.test(ch.nom)));
  const refus = c.illisible ? `Cette action ne s'appelle pas génériquement : ${c.illisible}.`
    : refusSurface(c) ?? ports.interdiction(c)
      ?? (binaires.length ? `Cette action attend un FICHIER (${binaires.map((b) => b.nom).join(", ")}) : elle se fait à l'écran, où l'on choisit le fichier.` : null);
  const { simulable } = simulableDe(c, risque);
  const nature = natureDeLAction(c, risque, raison);
  const { annulation, raison: raisonAnnulation } = annulationDe(nature, ports.classerGeste);
  const libelle = libelleDeFonction(c.fonction);
  const module = c.porte.moduleFr ?? (porte.modules[0] ? ports.modules[porte.modules[0]] ?? null : null);
  const description = `${libelle}${module ? ` — ${module}` : ""}. ${PHRASE_RISQUE[risque]}`;
  const champs = avecPersonnes(c).champs.filter((ch) => !CHAMP_BINAIRE.test(ch.nom));
  return {
    id: c.id, source: "action", outil: nomOutilDe(c.id), libelle, description, risque, raisonRisque: raison,
    familles: famillesDeLAction(c, ecriture), simulable, annulation, raisonAnnulation,
    contenuTiers: contenuTiersDe(c, risque), appelable: refus === null, refus,
    modules: porte.modules, verbe: porte.verbe, superAdminSeul: porte.superAdminSeul || porte.modules.length === 0,
    champs,
    mots: [libelle, module ?? "", synonymesDe(libelle, module ?? "")].join(" "),
    contexte: [motsDuFichier(c.fichier), champs.map((ch) => libelleChamp(ch.nom)).join(" ")].join(" "),
    executeePar: null,
  };
}

/** LA FICHE D'UN OUTIL EXISTANT DE L'ASSISTANT IA — il garde son nom, ses gardes et son exécution. */
export function ficheDeLOutil(o: OutilDecrit): Capacite {
  const risque: Risque = !o.ecriture ? "R0" : /relance|reponse_message|rendez_vous|send_|message/.test(o.nom) ? "R2" : "R1";
  const familles = [...o.familles];
  if (o.ecriture && !familles.includes("ECRITURES")) familles.push("ECRITURES");
  return {
    id: `outil:${o.nom}`, source: "outil", outil: o.nom, libelle: o.libelle, description: o.description, risque,
    raisonRisque: o.ecriture ? "outil de l'Assistant IA qui prépare une carte" : "outil de lecture de l'Assistant IA",
    familles, simulable: o.ecriture ? "inconnu" : "oui", annulation: o.ecriture ? "compensation" : "aucune",
    raisonAnnulation: o.ecriture ? "le geste confirmé s'exécute par l'action métier de l'écran : on le compense comme lui" : "lecture : rien à défaire",
    contenuTiers: !o.ecriture && /(document|lire|piece|devis|web|mail|formulaire|connaissance|chercher|ouvrir)/.test(o.nom),
    appelable: true, refus: null, modules: [], verbe: null, superAdminSeul: false, champs: [],
    mots: [o.libelle, o.nom.replace(/_/g, " "), synonymesDe(o.libelle)].join(" "), contexte: "", executeePar: null,
  };
}

/** LES COMMANDES DE L'ATELIER — exécutées par `modifier_document`, dans un brouillon que la personne relit. */
export function fichesDeLAtelier(): Capacite[] {
  return ACTIONS_GESTE.map((g) => {
    const libelle = g.replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase());
    return {
      id: `atelier:${g}`, source: "atelier" as const, outil: "modifier_document", libelle: `${libelle} (Atelier)`,
      description: `${libelle} dans le document ouvert dans l'Atelier — rien n'est enregistré sans la personne.`,
      risque: "R1" as const, raisonRisque: "retouche d'un brouillon de l'Atelier, acceptée ou refusée par la personne",
      familles: ["DRIVE" as const], simulable: "oui" as const, annulation: "delegation" as const,
      raisonAnnulation: "Live Office annule une retouche en rejouant les opérations non annulées (§104.3)",
      contenuTiers: false, appelable: true, refus: null, modules: [], verbe: null, superAdminSeul: false, champs: [],
      mots: `${libelle} atelier document modifier ${g.replace(/_/g, " ")}`, contexte: "", executeePar: "modifier_document",
    };
  });
}

export interface Registre {
  capacites: Capacite[];
  parId: ReadonlyMap<string, Capacite>;
  parOutil: ReadonlyMap<string, Capacite>;
}

/** LE REGISTRE ENTIER — les actions du contrat, les outils de l'Assistant IA, les commandes de l'Atelier. */
export function deriverRegistre<C extends ContratLu>(contrats: readonly C[], ports: PortsRegistre<C>, outils: readonly OutilDecrit[] = []): Registre {
  const capacites = [...contrats.map((c) => ficheDeLAction(c, ports)), ...outils.map(ficheDeLOutil), ...fichesDeLAtelier()];
  return {
    capacites,
    parId: new Map(capacites.map((c) => [c.id, c])),
    parOutil: new Map(capacites.filter((c) => c.source !== "atelier").map((c) => [c.outil, c])),
  };
}
