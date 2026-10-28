import { PageDevisPriseEnCharge } from "@/modules/ad-pro/ecrans/prise-en-charge/page-devis";

// Une page qui dépend de QUI regarde ne se met jamais en cache.
export const dynamic = "force-dynamic";

/** Devis d'une prise en charge internationale, pour l'assistante sollicitée — voir `PageDevisPriseEnCharge`. */
export default async function DevisIntlPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return <PageDevisPriseEnCharge scope="INTERNATIONAL" id={params.id} />;
}
