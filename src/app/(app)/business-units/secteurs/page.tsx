import { redirect } from "next/navigation";
import { requireModule } from "@/lib/session";
import { peutConfigurerBu } from "@/lib/sfe";
import { MontageBu } from "../montage";

export const dynamic = "force-dynamic";

/**
 * BUSINESS UNITS › Secteurs — toutes les BU ouvertes sur leur étape « Secteurs » (le territoire de chaque KAM, son nom,
 * ses établissements) ; `?bu=` en déplie une seule. Réservé à qui configure, vérifié ici.
 */
export default async function SecteursPage(props: { searchParams?: Promise<{ bu?: string }> }) {
 const searchParams = await props.searchParams;
 const user = await requireModule("BUSINESS_UNITS");
 if (!peutConfigurerBu(user)) redirect("/business-units/parametres");
 return <MontageBu user={user} etape="secteurs" bu={searchParams?.bu ?? null} />;
}
