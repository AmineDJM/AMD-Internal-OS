import { redirect } from "next/navigation";
import { versEcranAdam } from "@/platform/in-process/visibilite-adam";

export const dynamic = "force-dynamic";

/** L'ancienne adresse de la boîte de décision — l'onglet « Boîte de réception » d'Adam (`/adam/boite`, 02/11/2026). */
export default async function AncienneAdresseBoiteAdam(props: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(versEcranAdam("boite", (await props.searchParams) ?? {}));
}
