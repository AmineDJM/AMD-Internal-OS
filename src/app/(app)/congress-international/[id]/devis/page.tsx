import { PageDevisPriseEnCharge } from "@/components/care/page-devis";

// Une page qui dépend de QUI regarde ne se met jamais en cache.
export const dynamic = "force-dynamic";

/** Devis d'une prise en charge internationale, pour l'assistante sollicitée — voir `PageDevisPriseEnCharge`. */
export default function DevisIntlPage({ params }: { params: { id: string } }) {
  return <PageDevisPriseEnCharge scope="INTERNATIONAL" id={params.id} />;
}
