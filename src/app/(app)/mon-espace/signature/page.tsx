import { requireUser } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { etatVisuels } from "@/lib/signature-en-ligne/visuels";
import { etatSecondFacteur } from "@/lib/signature-en-ligne/second-facteur";
import { MaSignature } from "./ma-signature";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ma signature — AMD Internal OS" };

/**
 * MA SIGNATURE (Direction, 15/11/2026) — ce que chaque signataire de bons de commande prépare UNE fois : l'image de sa
 * signature, celle de son cachet, et le code de son application d'authentification. Ensuite, signer un BC tient en un
 * geste : relire, mot de passe, code.
 */
export default async function MaSignaturePage() {
  const user = await requireUser();
  const [visuels, facteur] = await Promise.all([etatVisuels(user.id), etatSecondFacteur(user.id)]);
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <BackLink href="/mon-espace">Mon espace</BackLink>
      <PageHeader
        title="Ma signature"
        description="Pour signer et cacheter les bons de commande en ligne. Vous le préparez une fois ; au moment de signer, on vous redemandera votre mot de passe et le code de votre téléphone."
      />
      <MaSignature
        vueExacte={Boolean(user.impersonatedBy)}
        signature={visuels.SIGNATURE?.toISOString() ?? null}
        cachet={visuels.CACHET?.toISOString() ?? null}
        codeActif={facteur.actif}
      />
    </div>
  );
}
