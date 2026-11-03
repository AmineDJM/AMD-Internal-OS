import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { sansBloquer } from "@/lib/journal";
import { persistActionIntents } from "@/platform/ia/intentions/action-intents";
import { journaliserGeste } from "@/platform/ia/hors-requete";
import {
  ECRITURES_SA, ECRITURES_SENSIBLES, executerEcritureAdam, LECTURES_SA, libelleAdam, OUTIL_BOITE, outilsAdamSuperAdmin, REFUS_HORS_SA,
} from "@/platform/in-process/porte-assistant-ia";
import type { PropositionCarte } from "../operations";
import type { ResultatOperation } from "../../domaine/operations/types";
import { estChargeAdamSA, KIND_ADAM_SA, type ChargeAdamSA } from "../../domaine/adam-sa";
import { catalogueAdamOuvert, profilDAcces } from "../../domaine/profil-acces";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ADAM COMPLET POUR LE SUPER ADMIN (lot A2, décision 0055) — le SEUL fichier du module qui lit Adam.
 *
 * Les fonctions de l'ancien Adam deviennent des outils du moteur de l'Assistant IA, OFFERTS AU SEUL SUPER ADMIN (rôle
 * principal, hors Vue exacte — `peutVoirAdam`). Ils viennent de la porte d'Adam (`platform/in-process/porte-assistant-ia.ts`),
 * qui se garde elle-même : ici, la même règle est relue une seconde fois (défense en profondeur).
 *
 *   • LECTURES (vague 1) : offertes telles quelles ; `outils-v1.ts` les passe au filtre de confidentialité du tour.
 *   • ÉCRITURES (vague 2) : JAMAIS exécutées pendant le tour. L'outil prépare une CARTE (`kind: "adam_sa_op"`) ; à la
 *     confirmation (`confirmation.ts`), l'outil d'Adam s'exécute sous le JOURNAL DES EFFETS (K10, décision 0029) —
 *     chaque écriture garde sa valeur avant, le geste paraît dans « Ce que l'assistant a fait » et s'annule de là.
 *
 * Pour tout autre compte : aucun outil, aucun nom, aucune consigne — et une charge forgée est refusée sans nommer Adam.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Adam est-il ouvert à CE compte dans le moteur ? Lu dans la table des accès (lot I2, `domaine/profil-acces.ts`) : Super
 * Admin en rôle principal, hors Vue exacte — la règle de `peutVoirAdam`, que la porte relit elle-même (défense en profondeur).
 */
export const adamOuvert = (u: CurrentUser): boolean => catalogueAdamOuvert(u);

/** Les noms des fonctions d'Adam branchées (la sélection leur donne une fiche courte et un rang réduit). */
const NOMS_ADAM: ReadonlySet<string> = new Set([...LECTURES_SA, ...ECRITURES_SA, OUTIL_BOITE]);
export const estOutilAdam = (nom: string): boolean => NOMS_ADAM.has(nom);
/** La fiche d'une fonction d'Adam pour la sélection : sa première phrase (les exemples longs faisaient remonter Adam partout). */
export const FICHE_ADAM_CARACTERES = 220;
/** Son rang dans `trouver_outil` : réduit — mesuré sur les 300 demandes du banc J6 (rappel@5 ≥ 95 %). */
export const FACTEUR_ADAM = 0.7;

/** La consigne du Super Admin — jamais lue par un autre compte (`fil/tour.ts` ne la pose que si `adamOuvert`). */
export const CONSIGNE_ADAM_SA =
  "TU ES ADAM, LE CHIEF OF STAFF DU SUPER ADMIN : en plus des outils de l'assistant, tu as TOUTES les fonctions d'Adam — "
  + "le point exécutif (`executive_brief`), la boîte de réception (`boite_de_reception`), l'histoire d'un dossier (`inspect_record`), "
  + "les bilans et vues 360°, ce qui a changé (`what_changed`), les signaux, le Gmail, l'agenda et le Drive Google d'Adam, les rappels, "
  + "les surveillances, Teach Adam, les registres de décisions et d'engagements. Cherche l'outil avec `trouver_outil` s'il n'est pas déjà offert. "
  + "Une écriture d'Adam (rappel, surveillance, règle, livrable…) PRÉPARE UNE CARTE : rien n'est fait avant la confirmation — ne dis jamais « c'est fait ».";

/** Une valeur d'entrée, lisible sur la carte. */
function valeurLisible(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") return v.slice(0, 240);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v).slice(0, 240); } catch { return null; }
}

/** Les lectures d'Adam, pour CE compte (vides hors Super Admin). */
export function lecturesAdam(user: CurrentUser): PowerTool[] {
  if (!adamOuvert(user)) return [];
  return outilsAdamSuperAdmin(user).lectures.map((o) => ({ ...o, allowed: (u: CurrentUser) => u.id === user.id && adamOuvert(u) && o.allowed(u) }));
}

/** Les écritures d'Adam, en CARTES — l'outil d'Adam n'est appelé qu'à la confirmation. */
export function ecrituresAdam(user: CurrentUser, propositions: PropositionCarte[], refusSecondeCarte: string): PowerTool[] {
  if (!adamOuvert(user)) return [];
  return outilsAdamSuperAdmin(user).ecritures.map((o): PowerTool => ({
    def: o.def,
    label: `${o.label} (carte)`,
    refus: REFUS_HORS_SA,
    allowed: (u) => u.id === user.id && adamOuvert(u) && o.allowed(u),
    run: async (entree, u) => {
      if (!(u.id === user.id && adamOuvert(u) && o.allowed(u))) return JSON.stringify({ statut: "REFUS", raison: REFUS_HORS_SA });
      if (propositions.length > 0) return refusSecondeCarte;
      const sensible = ECRITURES_SENSIBLES.has(o.def.name);
      const fields = Object.entries(entree ?? {}).map(([k, v]) => ({ label: k, value: valeurLisible(v) })).filter((f): f is { label: string; value: string } => f.value !== null).slice(0, 12);
      const title = `Adam — ${libelleAdam(o.def.name)}`;
      const charge: ChargeAdamSA = { kind: KIND_ADAM_SA, outil: o.def.name, entree: JSON.stringify(entree ?? {}).slice(0, 20_000) };
      const [intentId] = await persistActionIntents(u.id, [{ kind: KIND_ADAM_SA, module: "ADMIN", title, fields, ...(sensible ? { level: "SENSITIVE" as const } : {}), payload: charge }], "text");
      if (!intentId) return JSON.stringify({ statut: "ECHEC", raison: "La proposition n'a pas pu être enregistrée." });
      const warnings = ["Rien n'est fait avant votre confirmation ; le geste sera journalisé et annulable depuis « Ce que l'assistant a fait »."];
      propositions.push({ intentId, proposition: { kind: KIND_ADAM_SA, title, fields, warnings, ...(sensible ? { level: "SENSITIVE" as const } : {}), payload: charge } });
      return JSON.stringify({
        statut: "EN_ATTENTE_DE_CONFIRMATION", titre: title,
        consigne: "Rien n'est fait : une carte est affichée. Résume-la en une phrase ; ne dis jamais que c'est fait.",
      });
    },
  }));
}

/** Le refus d'une charge d'Adam hors Super Admin — sans nommer Adam ni la fonction. */
export const REFUS_CHARGE_HORS_SA = REFUS_HORS_SA;

/** L'arrêt d'urgence (réglé par le Super Admin) vaut pour toute action confirmée de l'IA, celles d'Adam comprises. */
const REFUS_ARRET = "Les actions de l'assistant sont DÉSACTIVÉES (arrêt d'urgence, réglé par le Super Admin) : rien n'a été exécuté. Les lectures et analyses restent disponibles.";

/** EXÉCUTER une carte d'Adam confirmée — sous le journal des effets (K10) : annulable depuis « Ce que l'assistant a fait ». */
export async function executerCarteAdam(user: CurrentUser, charge: unknown, cle: string): Promise<ResultatOperation> {
  if (!estChargeAdamSA(charge)) return { ok: false, error: "Action inconnue." };
  if (!adamOuvert(user)) return { ok: false, error: REFUS_CHARGE_HORS_SA };
  const reglages = await getAppSettings().catch(sansBloquer("assistant-ia.adam.getAppSettings", null));
  if (profilDAcces(user, { arretUrgence: reglages?.aiExternalActionsDisabled === true }).arretUrgence) return { ok: false, error: REFUS_ARRET };
  let entree: Record<string, unknown> = {};
  try { entree = JSON.parse(charge.entree) as Record<string, unknown>; } catch { return { ok: false, error: "Carte illisible : rien n'a été exécuté." }; }
  const { resultat } = await journaliserGeste(user, {
    origine: "carte", capaciteId: `adam:${charge.outil}`, libelle: `Adam — ${libelleAdam(charge.outil)}`, cleIdempotence: cle,
  }, async (): Promise<ResultatOperation> => {
    const r = await executerEcritureAdam(charge.outil, entree, user);
    return r.ok ? { ok: true, message: r.message.slice(0, 1_500) } : { ok: false, error: r.message };
  });
  return resultat;
}
