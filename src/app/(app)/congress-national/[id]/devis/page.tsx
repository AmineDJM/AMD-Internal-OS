import { PageDevisPriseEnCharge } from "@/components/care/page-devis";

// Une page qui dépend de QUI regarde ne se met jamais en cache.
export const dynamic = "force-dynamic";

/** Devis d'une prise en charge nationale, pour l'assistante sollicitée — voir `PageDevisPriseEnCharge`. */
export default function DevisNatPage({ params }: { params: { id: string } }) {
  return <PageDevisPriseEnCharge scope="NATIONAL" id={params.id} />;
}
