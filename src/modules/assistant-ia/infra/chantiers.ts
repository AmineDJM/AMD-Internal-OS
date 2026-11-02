import type { CurrentUser } from "@/lib/session";
import type { OutilTravail } from "@/platform/ia/travaux/outil";
import { etatMimo, lireReglagesChantiers, lireReglagesConsole, OUTILS_CHANTIER, validerGesteChantier } from "@/lib/missions/chantiers/outils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CHANTIERS DANS LA CONVERSATION (lot C1, décision 0042) — « je parle à Adventum IA ; il organise et supervise
 * Claude Code ». Quatre outils, offerts au SUPER ADMIN seul (rôle relu par le service à chaque geste) :
 *
 *   lancer_un_chantier      Terra formule la consigne technique (objectif, dépôt, branche, périmètre, critères) ;
 *                           la demande de la Direction VAUT approbation du plan (autonomie contrôlée) — les gestes
 *                           critiques (production, fusion sur main, rollback de production) restent sous validation ;
 *   ou_en_est_chantier      l'état réel lu de GitHub et Render par le moteur, coût compris ;
 *   valider_chantier        « valide » / « refuse » / « déploie » — SEULEMENT sur les mots explicites de la Direction,
 *                           à l'écrit comme à l'oral ; seule une validation ATTENDUE peut être donnée ;
 *   annuler_chantier        arrêter (annuler) ou suspendre.
 *
 * Le RAPPORT final (SHA, checks verts, statut live, santé, coût) revient par notification et par `ou_en_est_chantier` ;
 * le transmettre par WhatsApp passe par l'outil des canaux (K6) sur demande — ce module n'envoie rien lui-même.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const json = (o: unknown) => JSON.stringify(o);

/** Les outils du Super Admin, liés à CETTE personne (un outil préparé pour une autre refuse). */
export function outilsChantierPour(user: CurrentUser, lances?: string[]): OutilTravail[] {
  if (user.role !== "SUPER_ADMIN") return [];
  const pourLui = (u: { id: string }) => u.id === user.id;
  return OUTILS_CHANTIER.map((o) => ({
    def: o.def, label: o.label, allowed: pourLui,
    run: async (entree, u) => {
      if (!pourLui(u)) return json({ statut: "REFUS", raison: "Cet outil a été préparé pour une autre personne." });
      const sortie = await o.run(entree, user.id);
      // LE RETOUR DANS LA CONVERSATION (K3) : le chantier lancé ici s'inscrit au tour — sa fin y écrit la synthèse (rapport au Drive).
      if (lances && o.def.name === "lancer_un_chantier") noterLance(sortie, lances);
      return sortie;
    },
  }));
}

function noterLance(sortie: string, lances: string[]): void {
  let lu: { statut?: unknown; chantierId?: unknown } = {};
  try { lu = JSON.parse(sortie) as typeof lu; } catch { return; /* une sortie illisible : rien à inscrire */ }
  if (lu.statut === "DEMARRE" && typeof lu.chantierId === "string" && !lances.includes(lu.chantierId)) lances.push(lu.chantierId);
}

/** Le geste de l'écran « Missions » : valider ou refuser la carte d'un chantier (Super Admin, session). */
export const validerDepuisLeTableau = (chantierId: string, userId: string, accorde: boolean) =>
  validerGesteChantier(chantierId, userId, { decision: accorde ? "ACCORDEE" : "REFUSEE", canal: "ecrit" });

/** Administration › IA › Chantiers : les plafonds en vigueur, et MiMo tel que configuré (jamais la clé). */
export async function etatChantiersPourAdministration() {
  return { reglages: await lireReglagesConsole(), mimo: etatMimo() };
}

/** Les réglages saisis à la console, ramenés dans leurs bornes (l'absent prend le défaut). */
export const normaliserReglagesChantiers = (brut: unknown) => lireReglagesChantiers(brut);
