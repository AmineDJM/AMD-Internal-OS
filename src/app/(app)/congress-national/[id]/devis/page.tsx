import { PageDevisPriseEnCharge } from "@/modules/ad-pro/ecrans/prise-en-charge/page-devis";

// Une page qui dépend de QUI regarde ne se met jamais en cache.
export const dynamic = "force-dynamic";

/** Devis d'une prise en charge nationale, pour l'assistante sollicitée — voir `PageDevisPriseEnCharge`. */
export default async function DevisNatPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return <PageDevisPriseEnCharge scope="NATIONAL" id={params.id} />;
}
