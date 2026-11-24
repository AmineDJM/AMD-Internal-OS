import { userCan, peutAnnuaire, peutGererSpecialites, type SessionUser } from "@/lib/rbac";
import { featureEnabled } from "@/lib/features";
import { peutVoirArgentCockpit, peutVoirMarcheCockpit } from "@/lib/marketing-cockpit/acces";
import type { NavTab } from "@/lib/labels";
import type { ModuleTab } from "@/components/shared/module-tabs";
import { aiguillerVisite } from "@/lib/queries/aiguillage-visite";

/**
 * Onglets réellement visibles pour une personne : droits RBAC **et** stade de version.
 *
 * Un onglet marqué `feature` appartient à une nouveauté : il n'apparaît qu'aux comptes qui
 * la voient (stade TEST → comptes en mode test ; stade PROD → tout le monde). C'est ce qui
 * permet de livrer un écran sans l'imposer, puis de le valider d'un clic depuis
 * Administration › Versions.
 */
export async function visibleTabs(user: SessionUser, tabs: NavTab[]): Promise<ModuleTab[]> {
  // LES ÉCRANS DU DÉLÉGUÉ (Visite médicale, 24/11/2026) : celui que l'aiguillage mène à « Ma journée ». Lu une fois, et
  // seulement quand un onglet le demande — l'aiguillage coûte deux lectures.
  const estDelegue = tabs.some((t) => t.regle === "delegue")
    ? userCan(user, "MEDICAL", "VIEW") && (await aiguillerVisite(user)).destination === "JOURNEE"
    : false;
  return Promise.all(
    tabs.map(async (t) => ({
      label: t.label,
      href: t.href,
      // Un onglet d'ANNUAIRE suit la règle de l'accès par annuaire (§118.147) : le module de son
      // référentiel OU l'annuaire coché dans la console. Lire le seul `module` cacherait
      // l'onglet à la personne à qui on vient précisément de l'ouvrir.
      show: (t.regle === "specialites" ? peutGererSpecialites(user, "VIEW")
        : t.regle === "delegue" ? estDelegue
        // Marketing cockpit › Marché et › Investissements : le module du cockpit PUIS la règle du marché ou de l'argent
        // (`marketing-cockpit/acces.ts`) — l'onglet ne s'affiche pas à qui la page le refuserait.
        : t.regle === "marche-cockpit" ? userCan(user, t.module, "VIEW") && peutVoirMarcheCockpit(user)
        : t.regle === "argent-cockpit" ? userCan(user, t.module, "VIEW") && peutVoirArgentCockpit(user)
        : t.annuaire ? peutAnnuaire(user, t.annuaire, "VIEW") : userCan(user, t.module, "VIEW"))
        && (t.feature ? await featureEnabled(t.feature, user.id) : true),
    })),
  );
}
