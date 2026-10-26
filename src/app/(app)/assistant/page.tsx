import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { peutVoirAdam } from "@/platform/in-process/visibilite-adam";

export const dynamic = "force-dynamic";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « ASSISTANT IA » OUVRE LE VRAI MOTEUR (audit 2026-10-24, R3).
 *
 * Cette adresse montait l'interface bêta, branchée sur un appel direct à un fournisseur, sans
 * outils, sans la garde Super Admin (§118.153), avec des réponses rapides inventées. Le moteur de
 * production — outils de l'ERP gardés par les droits, édition Office, recherche web, voix, blocs
 * de l'espace de travail, cartes de confirmation — vit sur `/chief-of-staff`, derrière sa garde.
 * Une seule interface, un seul moteur (§118.5) : l'entrée du menu y mène, la question en cours
 * (`?q=`, `?ref=`, `?call=`) suit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export default async function AssistantPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const user = await requireUser();
  if (!peutVoirAdam(user)) notFound();
  const params = new URLSearchParams();
  for (const cle of ["q", "ref", "call"] as const) {
    const v = searchParams?.[cle];
    if (typeof v === "string" && v) params.set(cle, v.slice(0, 500));
  }
  const suite = params.toString();
  redirect(suite ? `/chief-of-staff?${suite}` : "/chief-of-staff");
}
