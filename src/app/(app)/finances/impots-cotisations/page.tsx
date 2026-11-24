import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { chargerImpotsCotisations } from "@/modules/finances/api";
import { EcranImpotsCotisations } from "@/modules/finances/ecrans/impots-cotisations/ecran";

export const dynamic = "force-dynamic";
export const metadata = { title: "Impôts & cotisations — AMD Internal OS" };

/**
 * FINANCES › IMPÔTS & COTISATIONS (maquette validée par le Super Admin, 24/11/2026) — la G50, la CNAS, les acomptes et
 * les paiements ponctuels de chaque société, préparés ici, autorisés au centre de paiement, payés par Banque & paiements.
 * La clé est `FINANCES_IMPOTS` ; les sociétés sont celles de la personne (`chargerImpotsCotisations`).
 */
export default async function ImpotsCotisationsPage({ searchParams }: { searchParams: Promise<{ ligne?: string }> }) {
  const user = await requireModule("FINANCES_IMPOTS");
  const [donnees, params] = await Promise.all([chargerImpotsCotisations(user.id), searchParams]);
  return (
    <EcranImpotsCotisations
      donnees={donnees}
      peutModifier={userCan(user, "FINANCES_IMPOTS", "UPDATE")}
      peutCreer={userCan(user, "FINANCES_IMPOTS", "CREATE")}
      moi={user.id}
      ligneInitiale={params.ligne ?? null}
    />
  );
}
