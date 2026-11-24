import { PageChiffrerPec } from "@/modules/ad-pro/ecrans/prise-en-charge/page-chiffrer";

// Une page qui dépend de QUI regarde ne se met jamais en cache.
export const dynamic = "force-dynamic";

/** « Chiffrer » — la fiche de la ligne « Chiffrage » du bureau du secrétariat (voir `PageChiffrerPec`). */
export default async function ChiffrerPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return <PageChiffrerPec scope="NATIONAL" id={params.id} />;
}
