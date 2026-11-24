import { notFound } from "next/navigation";
import { requireModule } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { siegeAuCentreAdPro, trierCentre } from "@/modules/ad-pro/partage";
import { decisionsRecentesCentreAdPro, demandesAuCentreAdPro } from "@/modules/ad-pro/api";
import { contexteDuCentreAdPro } from "@/lib/queries/centre-ad-pro-contexte";
import { CentreAdProBoard } from "./centre-board";
import { MenuCentreAdPro } from "./menu-centre";

export const dynamic = "force-dynamic";
export const metadata = { title: "Centre de validation Ad & Pro — AMD Internal OS" };

/**
 * LE CENTRE DE VALIDATION AD & PRO — le Directeur Général et le Super Admin (ou qui la console y fait siéger).
 *
 * Y passent les demandes Ad & Pro dont le total dépasse le SEUIL DES DEMANDES, et les bons de commande nés d'Ad & Pro
 * au-dessus du SEUIL DES BONS DE COMMANDE (§118.148, §118.149) ; les deux se règlent ici, dans le menu ⋯. Le module
 * s'ouvre par le RBAC, mais le SIÈGE est la règle pure `siegeAuCentreAdPro` : elle a le dernier mot.
 *
 * LA DISPOSITION (maquette validée le 24/11/2026, `CentreAdPro.dc.html`) : le titre, les pastilles des sociétés et le
 * menu ⋯ (« Déjà décidés », « Réglage des seuils ») ; la file « À décider » à gauche, la fiche de décision à droite.
 * Plus de compteurs, plus de description d'en-tête, plus de seuil répété sur chaque ligne : la file est le compte,
 * la fiche est le dossier. Les décisions sont celles d'hier, par les mêmes actions serveur.
 */
export default async function CentreAdProPage(props: { searchParams: Promise<{ ligne?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("AD_PRO_CENTRE");
  if (!siegeAuCentreAdPro(user)) notFound();

  const [lignes, settings, decides] = await Promise.all([demandesAuCentreAdPro(), getAppSettings(), decisionsRecentesCentreAdPro()]);
  const charge = await contexteDuCentreAdPro(trierCentre(lignes), user);

  return (
    <CentreAdProBoard
      rows={charge.lignes} contextes={charge.contextes} societes={charge.societes}
      seuil={settings.adProDgThreshold} seuilBC={settings.bcValidationThreshold}
      ligneAOuvrir={searchParams.ligne ?? null}
      menu={<MenuCentreAdPro decides={decides} seuil={settings.adProDgThreshold} seuilBC={settings.bcValidationThreshold} />}
    />
  );
}
