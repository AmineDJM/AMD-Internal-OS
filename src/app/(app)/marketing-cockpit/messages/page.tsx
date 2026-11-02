import { redirect } from "next/navigation";

/** « Messages » est une vue du Marketing cockpit (07/10) : l'ancienne adresse y mène, le produit choisi avec. */
export default async function MarketingMessagesPage(props: { searchParams?: Promise<{ produit?: string; bu?: string }> }) {
  const searchParams = await props.searchParams;
  const q = new URLSearchParams({ vue: "messages" });
  if (searchParams?.produit) q.set("produit", searchParams.produit);
  else if (searchParams?.bu) q.set("bu", searchParams.bu);
  redirect(`/marketing-cockpit?${q.toString()}`);
}
