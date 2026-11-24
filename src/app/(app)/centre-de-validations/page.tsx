import { notFound, redirect } from "next/navigation";
import { requireModule } from "@/lib/session";
import { ouvreLeCentreDeValidations } from "@/lib/validations/centre";
import { CHEMIN_VALIDATIONS } from "@/lib/chemins/validations";

export const dynamic = "force-dynamic";

/**
 * L'ANCIENNE ADRESSE DU CENTRE DE VALIDATIONS — le centre n'a plus qu'UN écran (maquette validée le 24/11/2026), servi à
 * `/validations` : la file qu'il montrait était déjà la même (`getPendingValidations`). L'entrée de menu et la porte
 * restent (la clé `VALIDATION_CENTRE` et `ouvreLeCentreDeValidations`, réglées dans la console, inchangées) : qui l'ouvre
 * arrive sur l'écran unique, son paramètre `?focus=` conservé.
 */
export default async function CentreDeValidationsPage(props: { searchParams?: Promise<{ focus?: string; demande?: string; vue?: string }> }) {
  const user = await requireModule("VALIDATION_CENTRE");
  if (!ouvreLeCentreDeValidations(user)) notFound();
  const sp = (await props.searchParams) ?? {};
  const params = new URLSearchParams();
  for (const k of ["focus", "demande", "vue"] as const) if (sp[k]) params.set(k, sp[k]!);
  const q = params.toString();
  redirect(q ? `${CHEMIN_VALIDATIONS}?${q}` : CHEMIN_VALIDATIONS);
}
