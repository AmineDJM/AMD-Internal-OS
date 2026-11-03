import type { CurrentUser } from "@/lib/session";
import { MODULE_LABELS } from "@/lib/labels";
import { OPERATIONS_IA } from "./operations";
import { motsDesCapacites, porteOuverte, registreDesCapacites } from "./capacites";
import type { FicheOutil } from "../domaine/selection-outils";
import { gesteReserveFerme, type ProfilDAcces } from "../domaine/profil-acces";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE REFUS NOMMÉ, DEPUIS LA TABLE (lot I2, décision 0064 ; audit AU3 §3.1, point 4).
 *
 * Avant I2, chaque tour d'un employé RÉCITAIT au modèle les 25 gestes qui lui étaient fermés (`consigneGestesFermes`,
 * ~313 jetons), dont un geste réservé au Super Admin (« Mail d'Adam ») — l'accès dit en prose, puis tu par la garde de
 * sortie ; rejeu réel : un mail ordinaire refusé sans appel d'outil. Désormais un geste fermé N'EST PAS OFFERT, n'est pas
 * dit ; quand la personne le demande, `trouver_outil` le retrouve ICI et rend le refus NOMMÉ : quel geste, quel droit
 * (le module de l'écran), qui l'ouvre — jamais « je n'ai pas l'outil » (banc V4-H), jamais un jeu vide muet (constat
 * mesuré : masquer un outil fait mentir l'assistant).
 *
 * Ne figurent ici que les gestes qui EXISTENT pour la personne mais que son rôle n'ouvre pas : une opération de
 * l'assistant (`OPERATIONS_IA`) dont l'écran lui est fermé, une capacité de l'ERP dont aucun module ne lui est ouvert.
 * Un geste réservé par le PROFIL (le canal d'Adam, `GESTES_RESERVES`) ou une capacité « Super Admin seul » n'existe pas
 * pour elle : il n'est jamais nommé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface GesteFerme extends FicheOutil {
  /** Le droit qui manque, dit tel quel (le module de l'écran). */
  droit: string;
}

const libelleModule = (m: string): string => (MODULE_LABELS as Record<string, string>)[m] ?? m;

/** Les gestes fermés à CETTE personne — calculés à la demande (le premier `trouver_outil` du tour), jamais récités. */
export function gestesFermesPour(user: CurrentUser, profil: ProfilDAcces): GesteFerme[] {
  if (profil.vueExacte) return [];
  const operations: GesteFerme[] = OPERATIONS_IA
    .filter((o) => !gesteReserveFerme(o.nom, profil) && !o.ouverte(user))
    .map((o) => ({
      nom: o.nom, libelle: o.libelle.replace(/ préparée?$/, ""), description: o.description,
      droit: `l'écran « ${libelleModule(o.module)} » n'est pas ouvert à son rôle`,
    }));
  const mots = motsDesCapacites();
  const capacites: GesteFerme[] = registreDesCapacites().capacites
    .filter((c) => c.source === "action" && c.appelable && !c.superAdminSeul && c.modules.length > 0 && !porteOuverte(user, c))
    .map((c) => ({
      nom: c.outil, libelle: c.libelle, description: c.description, ...(mots.get(c.outil) ?? {}),
      droit: c.modules.length > 1
        ? `aucun des écrans « ${c.modules.map(libelleModule).join(" », « ")} » n'est ouvert à son rôle`
        : `l'écran « ${libelleModule(c.modules[0]!)} » n'est pas ouvert à son rôle`,
    }));
  return [...operations, ...capacites];
}

/** Qui ouvre un geste fermé : le droit d'écran du rôle, réglé par un administrateur. */
export const QUI_OUVRE_UN_GESTE = "un administrateur, dans Administration › Accès (droits de son rôle)";
