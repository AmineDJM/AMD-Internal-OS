import { redirect } from "next/navigation";
import { versEcranAdam } from "@/platform/in-process/visibilite-adam";

export const dynamic = "force-dynamic";

/**
 * « MY CHIEF OF STAFF » N'EST PLUS UN ÉCRAN À PART (Direction, 02/11/2026 : « un seul assistant : Adam »).
 *
 * L'adresse reste servie — notifications, rappels, liens « Demander à Adam » d'une fiche — et mène le Super Admin à
 * l'écran d'Adam : la conversation (`/assistant`), ou le BUREAU d'Adam (onglet `/adam/bureau`, l'ancien écran, intact)
 * quand le lien porte une question, une référence ou un appel. Le gabarit du segment (`layout.tsx`, `exigerAdamVisible`)
 * passe AVANT : un non-Super-Admin reçoit toujours la même page qu'une adresse inconnue — le refus ne change pas.
 * L'ancien corps de cette page vit dans `app/(app)/adam/bureau/page.tsx` (déplacé, rien supprimé).
 */
export default async function AncienneAdresseChiefOfStaff(props: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(versEcranAdam("bureau", (await props.searchParams) ?? {}));
}
