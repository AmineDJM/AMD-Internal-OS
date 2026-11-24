import type { SessionUser } from "@/lib/rbac";
import { hasRole } from "@/lib/rbac";
import { getMyCompanies } from "@/lib/company";
import { lienEcheanceChargeFixe } from "@/lib/chemins/finances";
import { formatCurrency } from "@/lib/utils";
import { echeancesChargesFixesAFaire } from "@/modules/finances/api";
import type { ActionItem } from "./action-center";

/**
 * « MON ESPACE › AUJOURD'HUI » DES FINANCES — LES CHARGES FIXES À PAYER (Super Admin, 24/11/2026).
 *
 * Les Finances demandent chaque mois le paiement des charges fixes des locaux (loyer, électricité, eau…). Chaque échéance
 * apparaît QUINZE JOURS avant sa date, et reste tant qu'aucun paiement vivant ne la couvre (refusé ou annulé : elle
 * revient). La ligne ouvre la section « Locaux & charges fixes » d'Informations de la société, l'échéance désignée : on y
 * joint la facture et on demande le paiement. Pas de page « échéancier » : l'échéance vit là où vit la charge.
 *
 * Seulement pour les Finances (comme « Paiements à régler ») et le Super Admin, sur les sociétés de leur périmètre.
 */
const PLAFOND = 40;

export async function lignesChargesFixesAPayer(user: SessionUser): Promise<ActionItem[]> {
  if (!(hasRole(user, "FINANCE_BUDGET_MANAGER") || user.role === "SUPER_ADMIN")) return [];
  const societes = (await getMyCompanies(user.id)).map((c) => c.id);
  const echeances = (await echeancesChargesFixesAFaire(societes)).slice(0, PLAFOND);
  return echeances.map((e) => ({
    key: `chargefixe-${e.cle}`, objet: `FIXED_CHARGE:${e.cle}`,
    title: e.titre,
    subtitle: `${formatCurrency(e.montant)} · dû le ${e.date.toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" })} · ${e.detail}`,
    module: "Finances", href: lienEcheanceChargeFixe(e.companyId, e.cle), kind: "request" as const, priority: null,
    deadline: e.date.toISOString(), depuis: null, owner: "",
    statusLabel: "Facture à joindre", statusTone: "warning" as const,
    montant: e.montant, famille: e.nature,
  }));
}
