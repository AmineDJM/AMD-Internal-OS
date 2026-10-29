import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { ouvrirDocument } from "@/platform/ia/artifact/office";
import { ArtifactBlock } from "@/platform/ia/ecrans/blocks/artifact";
import type { WorkspaceBlock } from "@/platform/ia/workspace/protocol";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * OFFICE FOCUS (§34) — le même document, en plein écran.
 *
 * ── POURQUOI CET ÉCRAN EXISTE, ALORS QUE LE WORKSPACE VIT DANS LE FIL ──────────────────
 *
 * §33 est catégorique : parler à Adam ne doit PAS rediriger vers une page séparée. Cet écran
 * n'est donc pas le chemin normal — c'est le chemin du RETOUR. On relit un contrat de quarante
 * pages plus confortablement en plein écran qu'entre deux messages, et on veut pouvoir y
 * revenir depuis le Drive sans repasser par une phrase.
 *
 * C'est le MÊME composant, la MÊME session et le MÊME journal : ouvrir ici puis dire « centre
 * le titre » à Adam agit sur le même document, parce que `ouvrirDocument` réutilise la session
 * ouverte au lieu d'en créer une seconde (§36).
 *
 * ── ET C'EST AUSSI LA SURFACE D'ESSAI DÉTERMINISTE ──────────────────────────────────────
 *
 * L'E2E interdit tout appel de modèle. Le workspace atteint depuis la conversation en demande
 * un ; atteint d'ici, il n'en demande aucun — l'ouverture est un appel de fonction. Les
 * captures d'écran de `e2e/office-live.spec.ts` passent donc par cette page, et ce qu'elles
 * montrent est exactement ce que la conversation affiche.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export default async function OfficeLivePage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  // Le droit du MODULE ouvre l'écran ; le droit du FICHIER est revérifié par le port, nœud par
  // nœud. Les deux, parce qu'ils ne disent pas la même chose : l'un donne accès à la page,
  // l'autre à ce document-là.
  const user = await requireModule("DRIVE");
  const r = await ouvrirDocument(user, { nodeId: params.id });

  if (!r.ok || !r.vue) {
    // Un document illisible ou interdit ne doit pas rendre une page à moitié : on le dit.
    if (!r.motif) notFound();
    return (
      <div className="p-4 sm:p-6">
        <Link href="/office" className="inline-flex items-center gap-2 py-1 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft size={15} /> Bureautique
        </Link>
        <p className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 [overflow-wrap:anywhere]">{r.motif}</p>
      </div>
    );
  }

  const bloc: WorkspaceBlock = {
    kind: "artifact",
    title: r.vue.nom,
    vue: r.vue,
    blockId: r.vue.blockId,
    version: r.vue.revision,
  };

  return (
    <div className="flex h-full flex-col gap-3 p-3 sm:p-5" data-testid="office-live">
      <Link href="/office" className="inline-flex w-fit items-center gap-2 text-sm text-slate-500 hover:text-slate-700">
        <ArrowLeft size={15} /> Bureautique
      </Link>
      <ArtifactBlock b={bloc} />
    </div>
  );
}
