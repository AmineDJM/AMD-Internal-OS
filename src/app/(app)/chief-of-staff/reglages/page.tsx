import { redirect } from "next/navigation";
import { versEcranAdam } from "@/platform/in-process/visibilite-adam";

export const dynamic = "force-dynamic";

/**
 * L'ancienne adresse des réglages — l'onglet « Réglages d'Adam » (`/adam/reglages`, 02/11/2026). Le retour de la
 * connexion Google y arrive encore (`?connecte=…`, `?erreur=…`) : les paramètres suivent la redirection.
 */
export default async function AncienneAdresseReglagesAdam(props: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(versEcranAdam("reglages", (await props.searchParams) ?? {}));
}
