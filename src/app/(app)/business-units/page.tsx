import { redirect } from "next/navigation";
import { requireModule } from "@/lib/session";
import { peutConfigurerBu } from "@/lib/sfe";
import { ETAPES, type Etape } from "./etapes";
import { MontageBu } from "./montage";

export const dynamic = "force-dynamic";

/**
 * BUSINESS UNITS › Business units — une carte par BU, quatre étapes (Direction, 08/10 : le module sort du « ⋯ Réglages »
 * de la Force de vente). `?etape=` ouvre toutes les BU sur une étape (`?bu=` en déplie une) ; l'étape « secteurs » a son
 * propre onglet. Réservé à qui configure : la page le vérifie ici, pas seulement le menu. Un accès en LECTURE seule au
 * module ouvre les Paramètres, qui savent se lire sans s'écrire.
 */
export default async function BusinessUnitsPage(props: { searchParams?: Promise<{ etape?: string; bu?: string }> }) {
 const searchParams = await props.searchParams;
 const user = await requireModule("BUSINESS_UNITS");
 if (!peutConfigurerBu(user)) redirect("/business-units/parametres");
 const bu = searchParams?.bu ?? null;
 if (searchParams?.etape === "secteurs") redirect(bu ? `/business-units/secteurs?bu=${encodeURIComponent(bu)}` : "/business-units/secteurs");
 const etape = (ETAPES as readonly string[]).includes(searchParams?.etape ?? "") ? (searchParams!.etape as Etape) : null;
 return <MontageBu user={user} etape={etape} bu={bu} />;
}
