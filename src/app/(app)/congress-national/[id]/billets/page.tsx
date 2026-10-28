import { PageBilletsEmis } from "@/components/care/page-billets-emis";

// Une page qui dépend de QUI regarde ne se met jamais en cache.
export const dynamic = "force-dynamic";

/** Billets émis et confirmations d'hôtel d'une prise en charge nationale — voir `PageBilletsEmis`. */
export default async function BilletsNatPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return <PageBilletsEmis scope="NATIONAL" id={params.id} />;
}
