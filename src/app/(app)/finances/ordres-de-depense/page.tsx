import { redirect } from "next/navigation";

/**
 * L'ANCIENNE ADRESSE DES RÈGLEMENTS. L'écran s'appelle désormais « Banque & paiements » et vit
 * sous `/finances/paiements-a-faire` — il n'a plus qu'une source d'alimentation, le centre de
 * paiement, et son nom le dit.
 *
 * La redirection reste : des notifications déjà parties, des liens copiés dans des messages et
 * des favoris pointent ici. Une page 404 leur ferait croire que le module a disparu.
 */
export default async function OrdresDepenseRedirect(props: { searchParams: Promise<{ focus?: string }> }) {
 const searchParams = await props.searchParams;
 redirect(searchParams.focus ? `/finances/paiements-a-faire?focus=${searchParams.focus}` : "/finances/paiements-a-faire");
}
