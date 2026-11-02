import { redirect } from "next/navigation";
import { lienStockPromo, vueStockPromo } from "@/lib/chemins/stock-promo";

/**
 * L'ANCIENNE ADRESSE DU STOCK PROMOTIONNEL — une escale, plus un écran (§118.173).
 *
 * Le stock est devenu un sous-module À PART du pôle Sales & Marketing (`/stock-promotionnel`).
 * Cette adresse est pourtant citée par des notifications déjà parties (« Comptage demandé »,
 * « Entrée au magasin »), en base, et par les favoris de ceux qui y passaient : une adresse qui
 * meurt fait chercher un écran supprimé et conclure que le module a disparu. Elle conduit donc là
 * où le travail se fait, la vue demandée comprise — et seulement une vue que l'écran connaît.
 */
export default async function AncienStockPromo(props: { searchParams?: Promise<{ vue?: string }> }) {
 const searchParams = await props.searchParams;
 redirect(lienStockPromo(vueStockPromo(searchParams?.vue)));
}
