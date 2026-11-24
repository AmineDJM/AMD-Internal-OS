import { PageAcheterPec } from "@/modules/ad-pro/ecrans/prise-en-charge/page-acheter";

// Une page qui dépend de QUI regarde ne se met jamais en cache.
export const dynamic = "force-dynamic";

/** « Acheter — BC n°k » — la fiche de la ligne « Achat » du bureau du secrétariat (voir `PageAcheterPec`). */
export default async function AcheterPage(props: { params: Promise<{ id: string; numero: string }> }) {
  const params = await props.params;
  return <PageAcheterPec scope="INTERNATIONAL" id={params.id} numero={params.numero} />;
}
