import { redirect } from "next/navigation";

/**
 * L'ANCIENNE FICHE DU CATALOGUE — UN seul catalogue (Direction, 07/10 puis 08/10) : la fiche d'un produit est celle
 * de Produits 360, dont l'onglet « Réglementaire & qualité » porte l'identité, le nom, les alias et l'historique.
 * L'adresse reste, pour les liens d'avant ; la fiche 360 applique ses propres droits.
 */
export default async function AncienneFicheCatalogue(props: { params: Promise<{ id: string }> }) {
 const params = await props.params;
 redirect(`/produits/${encodeURIComponent(params.id)}?onglet=reglementaire`);
}
