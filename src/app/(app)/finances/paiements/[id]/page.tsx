import { redirect } from "next/navigation";

/** Ancienne adresse d'un dossier de paiement — conservée pour les liens déjà envoyés. */
export default async function LegacyFinancePaymentPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  redirect(`/validations/paiements/${params.id}`);
}
