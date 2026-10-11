import { PageBilletsEmis } from "@/components/care/page-billets-emis";

// Une page qui dépend de QUI regarde ne se met jamais en cache.
export const dynamic = "force-dynamic";

/** Billets émis et confirmations d'hôtel d'une prise en charge internationale — voir `PageBilletsEmis`. */
export default function BilletsIntlPage({ params }: { params: { id: string } }) {
  return <PageBilletsEmis scope="INTERNATIONAL" id={params.id} />;
}
