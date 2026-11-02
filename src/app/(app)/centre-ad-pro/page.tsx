import { notFound } from "next/navigation";
import { requireModule } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { siegeAuCentreAdPro, trierCentre, compteursCentre } from "@/modules/ad-pro/partage";
import { demandesAuCentreAdPro, visasTranchesCentreAdPro } from "@/modules/ad-pro/api";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { CentreAdProBoard } from "./centre-board";

export const dynamic = "force-dynamic";
export const metadata = { title: "Centre de validation Ad & Pro — AMD Internal OS" };

/**
 * LE CENTRE DE VALIDATION AD & PRO — décision de la Direction (09/2026).
 *
 * « Crée un centre de validation Ad&Pro pour le PDG et super admin. On gère depuis là le seuil à
 * partir duquel il faut une validation qui passe par ce centre. Toute demande parmi les demandes
 * Ad&Pro dont le budget total est au-dessus du seuil nécessite de passer par là, comme les autres
 * centres de validations. »
 *
 * Le module s'ouvre par le RBAC, mais le SIÈGE est une règle d'organisation : un administrateur
 * qui s'octroierait le module ne devient pas pour autant l'arbitre des dépenses de promotion.
 * La règle pure a le dernier mot — comme au centre de paiement et au centre de validations.
 *
 * Et depuis la décision de la Direction sur les bons de commande (09/2026, §118.148) — « ils
 * doivent tous passer soit par le centre de validation Ad&Pro si la demande est depuis Ad&Pro,
 * soit par le centre de validation normal » —, le centre valide aussi les BC nés d'Ad & Pro :
 * ceux au-dessus du SEUIL DES BONS DE COMMANDE, réglé sur cet écran (§118.149 — 0 par défaut, donc
 * tous) ; en deçà, un BC va directement à la signature des Finances.
 */
export default async function CentreAdProPage(props: { searchParams: Promise<{ ligne?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("AD_PRO_CENTRE");
  if (!siegeAuCentreAdPro(user)) notFound();

  const [lignes, settings, tranches] = await Promise.all([demandesAuCentreAdPro(), getAppSettings(), visasTranchesCentreAdPro()]);
  const rows = trierCentre(lignes);
  const c = compteursCentre(rows, new Date());

  return (
    <div className="space-y-5">
      <PageHeader
        title="Centre de validation Ad & Pro"
        description="Toute demande de promotion dont le budget total dépasse le seuil s'arrête ici, quelle que soit sa nature — sponsoring, prises en charge, événements, matériel promotionnel, consulting, autres demandes. Et tout bon de commande né d'Ad & Pro au-dessus du seuil des bons de commande y est validé avant de passer à la signature des Finances. La plus ancienne en tête : c'est elle qui bloque quelqu'un. Les deux seuils se règlent sur cet écran."
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <KpiCard
          label="En attente d'arbitrage" value={String(c.enAttente)} icon="Scale" tone={c.enAttente > 0 ? "warning" : "default"}
          hint={c.bonsDeCommande > 0 ? `Dont ${c.bonsDeCommande} bon(s) de commande à valider.` : undefined}
        />
        <KpiCard label="Dormantes (≥ 7 jours)" value={String(c.dormantes)} icon="Clock" tone={c.dormantes > 0 ? "danger" : "default"} hint="Un dossier qui dort bloque quelqu'un." />
        <KpiCard
          label="Engagement en attente"
          value={`${c.montantTotal.toLocaleString("fr-FR")} DZD`}
          icon="Coins"
          /* Le nombre de lignes SANS montant voyage avec le total : sans lui, la somme se lirait
             comme exhaustive alors qu'elle ne porte que les montants connus (§118.60). */
          hint={[
            c.sansMontant > 0 ? `${c.sansMontant} demande(s) sans montant renseigné — non comptée(s) dans ce total.` : null,
            // Les BC n'y entrent pas : celui d'un poste est une part d'une enveloppe déjà accordée,
            // l'ajouter compterait deux fois le même argent (`compteursCentre`).
            c.bonsDeCommande > 0 ? "Les bons de commande n'y sont pas comptés." : null,
          ].filter(Boolean).join(" ") || undefined}
        />
        <KpiCard
          label="Seuil des demandes"
          value={settings.adProDgThreshold > 0 ? `${settings.adProDgThreshold.toLocaleString("fr-FR")} DZD` : "Aucun"}
          icon="SlidersHorizontal"
          hint={settings.adProDgThreshold > 0 ? "Strictement au-dessus de ce montant." : "Aucune demande ne passe par le centre."}
        />
        {/* DEUX SEUILS, DEUX QUESTIONS (§118.149) : celui des DEMANDES dit qui arbitre une
            opération, celui des BONS DE COMMANDE dit quelle pièce doit être validée avant que les
            Finances la signent. Un seul chiffre affiché ferait régler l'un en croyant régler l'autre. */}
        <KpiCard
          label="Seuil des bons de commande"
          value={settings.bcValidationThreshold > 0 ? `${settings.bcValidationThreshold.toLocaleString("fr-FR")} DZD` : "Aucun"}
          icon="FilePen"
          hint={settings.bcValidationThreshold > 0
            ? "Au-dessus : un centre valide. En deçà : directement à la signature des Finances."
            : "Tout bon de commande passe par un centre de validation."}
        />
      </div>

      <CentreAdProBoard rows={rows} seuil={settings.adProDgThreshold} seuilBC={settings.bcValidationThreshold} tranches={tranches} ligneAOuvrir={searchParams.ligne ?? null} />
    </div>
  );
}
