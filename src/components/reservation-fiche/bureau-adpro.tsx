import type { SessionUser } from "@/lib/rbac";
import { bureauAdPro } from "@/lib/queries/reservations-fiches";
import { TableauAdPro } from "./tableau-adpro";

/**
 * L'ONGLET « AD & PRO » DU BUREAU DU SECRÉTARIAT — chargé au serveur, montré par `TableauAdPro`. Les fiches
 * de voyage envoyées (billets, hôtels) groupées par opération, et les BC de poste à établir et les devis à
 * retranscrire lus dans leurs files existantes.
 */
export async function BureauAdPro({ user, fiche }: { user: SessionUser; fiche: string | null }) {
  const data = await bureauAdPro(user);
  return <TableauAdPro data={data} ficheInitiale={fiche} />;
}
